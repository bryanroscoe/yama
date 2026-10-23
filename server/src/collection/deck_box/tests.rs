//! "Add to my collection": a new box, a second run, moving the same printing (never out of
//! another deck's box), the printing chosen, proxies, and the routes.

use super::*;
use crate::collection::{CopyKind, Op, OpKind, apply_op};
use crate::decks::{Board, DeckCard};
use crate::testutil::{app, send, user};
use axum::http::{Method, StatusCode};

/// Cards and printings: Sol Ring has a promo default, a gold-bordered one and two regular ones.
async fn cards(pool: &SqlitePool) {
    let printings: &[(&str, &str, &str, &str, &str, &str, &str)] = &[
        // (scryfall id, oracle id, set, number, set type, finishes, released)
        ("p-omo", "o-omo", "m3c", "2", "commander", r#"["nonfoil","foil"]"#, "2024-06-14"),
        ("p-sol-promo", "o-sol", "psol", "1", "promo", r#"["nonfoil"]"#, "2025-01-01"),
        ("p-sol-wc", "o-sol", "wc97", "1", "memorabilia", r#"["nonfoil"]"#, "1997-08-13"),
        ("p-sol-cmm", "o-sol", "cmm", "410", "masters", r#"["nonfoil","foil"]"#, "2023-08-04"),
        ("p-sol-c21", "o-sol", "c21", "263", "commander", r#"["nonfoil"]"#, "2021-04-23"),
        ("p-sig", "o-sig", "c21", "236", "commander", r#"["nonfoil","foil"]"#, "2021-04-23"),
        ("p-crypt", "o-crypt", "cmm", "395", "masters", r#"["nonfoil","foil"]"#, "2023-08-04"),
        ("p-forest-a", "o-forest", "fdn", "1", "core", r#"["nonfoil"]"#, "2024-11-15"),
        ("p-forest-b", "o-forest", "m21", "2", "core", r#"["nonfoil"]"#, "2020-07-03"),
        ("p-bolt", "o-bolt", "2x2", "117", "masters", r#"["nonfoil"]"#, "2022-07-08"),
    ];
    for (oid, name, tl, default) in [
        ("o-omo", "Omo, Queen of Vesuva", "Legendary Creature — Shapeshifter", "p-omo"),
        ("o-sol", "Sol Ring", "Artifact", "p-sol-promo"),
        ("o-sig", "Arcane Signet", "Artifact", "p-sig"),
        ("o-crypt", "Mana Crypt", "Artifact", "p-crypt"),
        ("o-forest", "Forest", "Basic Land — Forest", "p-forest-a"),
        ("o-bolt", "Lightning Bolt", "Instant", "p-bolt"),
    ] {
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, default_printing, updated_at) VALUES (?,?,?,?,'now')")
            .bind(oid)
            .bind(name)
            .bind(tl)
            .bind(default)
            .execute(pool)
            .await
            .unwrap();
    }
    for (sid, oid, set, num, set_type, finishes, released) in printings {
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, released_at, digital, set_type, updated_at)
             VALUES (?,?,(SELECT name FROM cards WHERE oracle_id = ?),?,?,?,'en',?,?,0,?,'now')",
        )
        .bind(sid)
        .bind(oid)
        .bind(oid)
        .bind(set)
        .bind(set.to_uppercase())
        .bind(num)
        .bind(finishes)
        .bind(released)
        .bind(set_type)
        .execute(pool)
        .await
        .unwrap();
    }
}

fn dc(oid: &str, name: &str, qty: i64, board: Board) -> DeckCard {
    DeckCard { oracle_id: oid.into(), name: name.into(), qty, board }
}

/// Tricky Terrain: Omo, Sol Ring, Arcane Signet (the deck names C21 236 foil), Mana Crypt (a
/// proxy, no printing named), two Forests, and a Bolt in the sideboard.
async fn deck(pool: &SqlitePool, owner: &str, name: &str) -> String {
    let cards = vec![
        dc("o-omo", "Omo, Queen of Vesuva", 1, Board::Commander),
        dc("o-sol", "Sol Ring", 1, Board::Main),
        dc("o-sig", "Arcane Signet", 1, Board::Main),
        dc("o-crypt", "Mana Crypt", 1, Board::Main),
        dc("o-forest", "Forest", 2, Board::Main),
        dc("o-bolt", "Lightning Bolt", 1, Board::Side),
    ];
    let id = crate::decks::create_deck_with_cards(pool, owner, name, None, cards).await.unwrap();
    let print = |oid: &str, set: &str, num: Option<&str>, finish: &str, proxy| crate::deck_import::DeckPrint {
        oracle_id: oid.into(),
        set_code: set.into(),
        collector_number: num.map(str::to_string),
        finish: finish.into(),
        proxy,
    };
    crate::deck_import::save_prints(pool, &id, &[print("o-sig", "c21", Some("236"), "foil", false), print("o-crypt", "", None, "nonfoil", true)]).await.unwrap();
    id
}

async fn setup() -> (SqlitePool, String) {
    let pool = crate::db::test_pool().await;
    cards(&pool).await;
    sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','A','now')").execute(&pool).await.unwrap();
    (pool, "u1".into())
}

async fn give(pool: &SqlitePool, owner: &str, op_id: &str, sid: &str, qty: i64, finish: &str, container: Option<&str>) {
    let mut tx = pool.begin().await.unwrap();
    let op = Op {
        op_id: op_id.into(),
        device_id: None,
        op: OpKind::Add {
            scryfall_id: sid.into(),
            qty,
            copy: CopyKind { condition: "LP".into(), finish: finish.into(), lang: "en".into(), ..Default::default() },
            container_id: container.map(str::to_string),
            purchase_price: Some(2.5),
            purchase_currency: Some("USD".into()),
        },
    };
    apply_op(&mut tx, owner, &op).await.unwrap();
    tx.commit().await.unwrap();
}

/// What's in a container: (scryfall id, finish, proxy, qty), sorted.
async fn inside(pool: &SqlitePool, container: &str) -> Vec<(String, String, bool, i64)> {
    sqlx::query_as("SELECT scryfall_id, finish, proxy, SUM(qty) FROM collection_items WHERE container_id = ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3")
        .bind(container)
        .fetch_all(pool)
        .await
        .unwrap()
}

fn row(sid: &str, finish: &str, proxy: bool, qty: i64) -> (String, String, bool, i64) {
    (sid.into(), finish.into(), proxy, qty)
}

#[tokio::test]
async fn a_new_box_gets_the_list_once() {
    let (pool, owner) = setup().await;
    let id = deck(&pool, &owner, "Tricky Terrain").await;
    let version: String = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();

    let p = add_deck(&pool, &owner, &id, SamePrinting::Move, true).await.unwrap();
    assert_eq!((p.box_exists, p.box_name.as_str(), p.box_kind.as_str()), (false, "Tricky Terrain", "deck"));
    // The sideboard's Bolt isn't part of it.
    assert_eq!((p.cards, p.in_box, p.missing, p.outcome.added, p.proxies), (6, 0, 6, 6, 1));
    let line = |name: &str| p.lines.iter().find(|l| l.name == name).unwrap();
    // Sol Ring: not the promo default or the gold-bordered copy; the newest regular printing.
    let sol = line("Sol Ring").printing.as_ref().unwrap();
    assert_eq!((sol.set_code.as_str(), sol.collector_number.as_str(), sol.finish.as_str(), sol.from), ("cmm", "410", "nonfoil", "default"));
    let sig = line("Arcane Signet").printing.as_ref().unwrap();
    assert_eq!((sig.set_code.as_str(), sig.finish.as_str(), sig.from), ("c21", "foil", "deck"));
    assert!(line("Mana Crypt").proxy);
    // A preview makes no box.
    let boxes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers").fetch_one(&pool).await.unwrap();
    assert_eq!(boxes, 0);

    let done = add_deck(&pool, &owner, &id, SamePrinting::Move, false).await.unwrap();
    assert!(done.applied);
    let box_id = done.box_id.clone().unwrap();
    let linked: Option<String> = sqlx::query_scalar("SELECT container_id FROM decks WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!(linked.as_deref(), Some(box_id.as_str()));
    assert_eq!(
        inside(&pool, &box_id).await,
        vec![row("p-crypt", "nonfoil", true, 1), row("p-forest-a", "nonfoil", false, 2), row("p-omo", "nonfoil", false, 1), row("p-sig", "foil", false, 1), row("p-sol-cmm", "nonfoil", false, 1)]
    );
    // The deck's list is untouched.
    let (now, versions): (String, i64) =
        sqlx::query_as("SELECT current_version_id, (SELECT COUNT(*) FROM deck_versions WHERE deck_id = ?1) FROM decks WHERE id = ?1").bind(&id).fetch_one(&pool).await.unwrap();
    assert_eq!((now, versions), (version, 1));

    // Again: nothing to do.
    let again = add_deck(&pool, &owner, &id, SamePrinting::Move, false).await.unwrap();
    assert_eq!((again.missing, again.applied, again.box_exists), (0, false, true));
    assert_eq!(inside(&pool, &box_id).await.len(), 5);

    // Take the Sol Ring out and run it again: it goes back (fresh op ids, though the box is as it was).
    let sol_item: String = sqlx::query_scalar("SELECT id FROM collection_items WHERE scryfall_id = 'p-sol-cmm'").fetch_one(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    apply_op(&mut tx, &owner, &Op { op_id: "out".into(), device_id: None, op: OpKind::Remove { item_id: sol_item } }).await.unwrap();
    tx.commit().await.unwrap();
    let back = add_deck(&pool, &owner, &id, SamePrinting::Move, false).await.unwrap();
    assert_eq!(back.outcome.added, 1);
    assert_eq!(inside(&pool, &box_id).await.len(), 5);

    // A new version without the Signet: the box keeps it, and says so.
    let cards = vec![dc("o-omo", "Omo, Queen of Vesuva", 1, Board::Commander), dc("o-sol", "Sol Ring", 1, Board::Main)];
    crate::decks::insert_version(&pool, &id, &cards, None).await.unwrap();
    let cut = add_deck(&pool, &owner, &id, SamePrinting::Move, true).await.unwrap();
    assert_eq!((cut.missing, cut.not_in_list), (0, 4));
}

#[tokio::test]
async fn the_same_printing_moves_in_but_never_out_of_another_deck() {
    let (pool, owner) = setup().await;
    let id = deck(&pool, &owner, "Tricky Terrain").await;
    let trade = crate::collection::ensure_container(&pool, &owner, "binder", "Trade").await.unwrap();
    let basics = crate::collection::ensure_container(&pool, &owner, "box", "Bulk Basic").await.unwrap();
    // Three of the Sol Ring printing it would add, in a binder; a Forest of that printing in a
    // box and one of another printing unfiled.
    give(&pool, &owner, "g1", "p-sol-cmm", 3, "nonfoil", Some(&trade)).await;
    give(&pool, &owner, "g2", "p-forest-a", 1, "nonfoil", Some(&basics)).await;
    give(&pool, &owner, "g3", "p-forest-b", 1, "nonfoil", None).await;
    // Foil Signets of the deck's printing, in another deck's box and in a deck container: off limits.
    let other = crate::decks::create_deck_with_cards(&pool, &owner, "Other Deck", None, vec![]).await.unwrap();
    let other_box = crate::collection::ensure_container(&pool, &owner, "list", "Other Deck sleeves").await.unwrap();
    sqlx::query("UPDATE decks SET container_id = ? WHERE id = ?").bind(&other_box).bind(&other).execute(&pool).await.unwrap();
    let loose_deck_box = crate::collection::ensure_container(&pool, &owner, "deck", "Old deck").await.unwrap();
    give(&pool, &owner, "g4", "p-sig", 1, "foil", Some(&other_box)).await;
    give(&pool, &owner, "g5", "p-sig", 1, "foil", Some(&loose_deck_box)).await;

    let p = add_deck(&pool, &owner, &id, SamePrinting::Move, true).await.unwrap();
    assert_eq!(p.same_elsewhere, 2);
    assert_eq!((p.options.move_.moved, p.options.move_.added), (2, 4));
    assert_eq!((p.options.add.moved, p.options.add.added), (0, 6));
    assert_eq!((p.options.skip.added, p.options.skip.left_out), (4, 2));
    let sig = p.lines.iter().find(|l| l.name == "Arcane Signet").unwrap();
    assert!(sig.elsewhere.is_empty(), "never from another deck's box: {:?}", sig.elsewhere);
    let forest = p.lines.iter().find(|l| l.name == "Forest").unwrap();
    assert_eq!(forest.elsewhere.iter().map(|e| e.place.as_str()).collect::<Vec<_>>(), vec!["box: Bulk Basic"]);

    // Leaving them out adds the rest.
    let skipped = add_deck(&pool, &owner, &id, SamePrinting::Skip, true).await.unwrap();
    assert_eq!((skipped.outcome.added, skipped.outcome.left_out), (4, 2));

    let forest_row: String = sqlx::query_scalar("SELECT id FROM collection_items WHERE scryfall_id = 'p-forest-a'").fetch_one(&pool).await.unwrap();
    let done = add_deck(&pool, &owner, &id, SamePrinting::Move, false).await.unwrap();
    assert_eq!((done.outcome.moved, done.outcome.added), (2, 4));
    let box_id = done.box_id.unwrap();
    // One Sol Ring left the binder (LP and its price came along); the Forest's whole row moved,
    // keeping its id.
    assert_eq!(inside(&pool, &trade).await, vec![row("p-sol-cmm", "nonfoil", false, 2)]);
    let moved: (String, Option<f64>) =
        sqlx::query_as("SELECT condition, purchase_price FROM collection_items WHERE container_id = ? AND scryfall_id = 'p-sol-cmm'").bind(&box_id).fetch_one(&pool).await.unwrap();
    assert_eq!(moved, ("LP".to_string(), Some(2.5)));
    let forest_now: Option<String> = sqlx::query_scalar("SELECT container_id FROM collection_items WHERE id = ?").bind(&forest_row).fetch_one(&pool).await.unwrap();
    assert_eq!(forest_now.as_deref(), Some(box_id.as_str()));
    assert!(inside(&pool, &basics).await.is_empty());
    // The other decks' Signets stayed; the box got a new one; the other Forest printing stayed unfiled.
    assert_eq!(inside(&pool, &other_box).await, vec![row("p-sig", "foil", false, 1)]);
    assert_eq!(inside(&pool, &loose_deck_box).await, vec![row("p-sig", "foil", false, 1)]);
    let unfiled: i64 = sqlx::query_scalar("SELECT SUM(qty) FROM collection_items WHERE container_id IS NULL").fetch_one(&pool).await.unwrap();
    assert_eq!(unfiled, 1);
    assert_eq!(
        inside(&pool, &box_id).await,
        vec![row("p-crypt", "nonfoil", true, 1), row("p-forest-a", "nonfoil", false, 2), row("p-omo", "nonfoil", false, 1), row("p-sig", "foil", false, 1), row("p-sol-cmm", "nonfoil", false, 1)]
    );
}

#[tokio::test]
async fn boxes_are_reused_or_named_around_other_decks() {
    let (pool, owner) = setup().await;
    // A deck already linked to a binder uses it.
    let linked = deck(&pool, &owner, "Linked").await;
    let binder = crate::collection::ensure_container(&pool, &owner, "binder", "My binder").await.unwrap();
    sqlx::query("UPDATE decks SET container_id = ? WHERE id = ?").bind(&binder).bind(&linked).execute(&pool).await.unwrap();
    give(&pool, &owner, "g1", "p-omo", 1, "nonfoil", Some(&binder)).await;
    let p = add_deck(&pool, &owner, &linked, SamePrinting::Move, true).await.unwrap();
    assert_eq!((p.box_id.as_deref(), p.box_kind.as_str(), p.in_box, p.missing), (Some(binder.as_str()), "binder", 1, 5));

    // Two decks with one name: the second gets "Name (2)".
    let first = deck(&pool, &owner, "Twins").await;
    let second = deck(&pool, &owner, "Twins").await;
    let a = add_deck(&pool, &owner, &first, SamePrinting::Move, false).await.unwrap();
    let b = add_deck(&pool, &owner, &second, SamePrinting::Move, false).await.unwrap();
    assert_eq!((a.box_name.as_str(), b.box_name.as_str()), ("Twins", "Twins (2)"));
    assert_ne!(a.box_id, b.box_id);

    // A free deck container with the deck's name (from Mythic Tools, say) is taken over.
    let free = crate::collection::ensure_container(&pool, &owner, "deck", "Free").await.unwrap();
    let d = deck(&pool, &owner, "Free").await;
    let p = add_deck(&pool, &owner, &d, SamePrinting::Move, true).await.unwrap();
    assert_eq!((p.box_id.as_deref(), p.box_exists), (Some(free.as_str()), true));
}

#[tokio::test]
async fn the_routes_preview_apply_and_keep_decks_private() {
    let (app, pool) = app().await;
    cards(&pool).await;
    let (ann, ann_token) = user(&pool, "ann@example.com").await;
    let (_, bob_token) = user(&pool, "bob@example.com").await;
    let id = deck(&pool, &ann, "Tricky Terrain").await;

    let (status, body) = send(&app, Method::GET, &format!("/api/decks/{id}/collect?same=add"), Some(&ann_token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!((body["missing"].as_i64(), body["same_printing"].as_str(), body["applied"].as_bool()), (Some(6), Some("add"), Some(false)));
    assert_eq!(body["options"]["move"]["added"], 6);

    let (status, _) = send(&app, Method::GET, &format!("/api/decks/{id}/collect"), Some(&bob_token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&app, Method::POST, &format!("/api/decks/{id}/collect"), Some(&bob_token), Some(serde_json::json!({}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = send(&app, Method::POST, &format!("/api/decks/{id}/collect"), Some(&ann_token), Some(serde_json::json!({ "same": "move" }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!((body["added"].as_i64(), body["applied"].as_bool()), (Some(6), Some(true)));
    // The deck list now counts them as owned (the proxy doesn't).
    let (_, decks) = send(&app, Method::GET, "/api/decks", Some(&ann_token), None).await;
    assert_eq!((decks[0]["owned"].as_i64(), decks[0]["card_count"].as_i64()), (Some(5), Some(6)));
}
