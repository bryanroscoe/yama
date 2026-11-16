//! Mythic Tools re-imports: the same file, a newer export, copies moved in Yama, a file that
//! shrank, and removals kept to the containers a file names.

use super::*;
use crate::collection::nonfoil;

async fn seed(pool: &SqlitePool) -> String {
    sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','A','now')").execute(pool).await.unwrap();
    for (sid, oid, name, tl) in [
        ("p-sol", "o-sol", "Sol Ring", "Artifact"),
        ("p-bolt", "o-bolt", "Lightning Bolt", "Instant"),
        ("p-forest", "o-forest", "Forest", "Basic Land — Forest"),
        ("p-omo", "o-omo", "Omo, Queen of Vesuva", "Legendary Creature — Shapeshifter"),
        ("p-tatyova", "o-tatyova", "Tatyova, Benthic Druid", "Legendary Creature — Merfolk Druid"),
    ] {
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES (?,?,?,'now')").bind(oid).bind(name).bind(tl).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, updated_at) VALUES (?,?,?,'x','X','1','en','[\"nonfoil\",\"foil\"]','now')")
            .bind(sid)
            .bind(oid)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
    }
    "u1".into()
}

/// A Mythic Tools export: (name, scryfall id, qty, finish, condition, container type, container name).
fn csv(rows: &[(&str, &str, i64, &str, &str, &str, &str)]) -> String {
    let mut s = String::from(
        "\u{feff}Card Name,English Name,Set Code,Set Name,Collector Number,Rarity,Language,Quantity,Condition,Finish,Altered,Signed,Misprint,Proxy,Price (USD),Price (EUR),Price (USD Foil),Price (EUR Foil),Price (USD Etched),Price (EUR Etched),Scryfall ID,Container Type,Container Name,Purchase Price (USD),Purchase Price (EUR)\n",
    );
    for (name, sid, qty, finish, cond, ctype, cname) in rows {
        s.push_str(&format!("\"{name}\",\"{name}\",\"x\",\"X\",\"1\",\"common\",\"en\",{qty},\"{cond}\",\"{finish}\",false,false,false,false,1,1,0,0,0,0,\"{sid}\",\"{ctype}\",\"{cname}\",0,0\n"));
    }
    s
}

const IMPORT: ImportOptions = ImportOptions { dry_run: false, remove_missing: false };
const PREVIEW: ImportOptions = ImportOptions { dry_run: true, remove_missing: false };

/// Copies by (scryfall id, finish, place), where place is "kind: name" or "unfiled".
async fn holdings(pool: &SqlitePool) -> Vec<(String, String, String, i64)> {
    sqlx::query_as(
        "SELECT i.scryfall_id, i.finish, IFNULL(ct.kind || ': ' || ct.name, 'unfiled'), SUM(i.qty) FROM collection_items i
         LEFT JOIN containers ct ON ct.id = i.container_id GROUP BY 1, 2, 3 ORDER BY 1, 2, 3",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

fn h(sid: &str, finish: &str, place: &str, qty: i64) -> (String, String, String, i64) {
    (sid.into(), finish.into(), place.into(), qty)
}

async fn container(pool: &SqlitePool, kind: &str, name: &str) -> String {
    crate::collection::ensure_container(pool, "u1", kind, name).await.unwrap()
}

async fn add(pool: &SqlitePool, op_id: &str, sid: &str, qty: i64, container: Option<&str>) {
    let mut tx = pool.begin().await.unwrap();
    let op = Op {
        op_id: op_id.into(),
        device_id: None,
        op: OpKind::Add { scryfall_id: sid.into(), qty, copy: CopyKind { condition: nm(), finish: nonfoil(), lang: en(), ..Default::default() }, container_id: container.map(str::to_string), purchase_price: None, purchase_currency: None },
    };
    apply_op(&mut tx, "u1", &op).await.unwrap();
    tx.commit().await.unwrap();
}

/// Move `qty` nonfoil copies of a printing from one place to another, as the app would.
async fn move_copies(pool: &SqlitePool, op_id: &str, sid: &str, from: &str, to: &str, qty: i64) {
    let item: String = sqlx::query_scalar("SELECT id FROM collection_items WHERE scryfall_id = ? AND container_id = ? AND finish = 'nonfoil'")
        .bind(sid)
        .bind(from)
        .fetch_one(pool)
        .await
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    apply_op(&mut tx, "u1", &Op { op_id: format!("{op_id}-a"), device_id: None, op: OpKind::Adjust { item_id: item, delta: -qty } }).await.unwrap();
    tx.commit().await.unwrap();
    add(pool, &format!("{op_id}-b"), sid, qty, Some(to)).await;
}

const A: &[(&str, &str, i64, &str, &str, &str, &str)] = &[
    ("Sol Ring", "p-sol", 2, "nonfoil", "NM", "box", "bulk"),
    ("Sol Ring", "p-sol", 1, "foil", "NM", "box", "bulk"),
    ("Lightning Bolt", "p-bolt", 1, "nonfoil", "NM", "box", "bulk"),
];

#[tokio::test]
async fn the_same_file_again_changes_nothing() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let r = import_mythic_csv(&pool, "u1", &csv(A), IMPORT).await.unwrap();
    assert_eq!((r.rows, r.copies, r.added, r.already_imported.is_some()), (3, 4, 4, false));
    let first = holdings(&pool).await;
    assert_eq!(first, vec![h("p-bolt", "nonfoil", "box: bulk", 1), h("p-sol", "foil", "box: bulk", 1), h("p-sol", "nonfoil", "box: bulk", 2)]);

    // Even after a card leaves in Yama, the same file doesn't bring it back.
    let bolt: String = sqlx::query_scalar("SELECT id FROM collection_items WHERE scryfall_id = 'p-bolt'").fetch_one(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    apply_op(&mut tx, "u1", &Op { op_id: "traded".into(), device_id: None, op: OpKind::Remove { item_id: bolt } }).await.unwrap();
    tx.commit().await.unwrap();
    let again = import_mythic_csv(&pool, "u1", &csv(A), IMPORT).await.unwrap();
    assert!(again.already_imported.is_some());
    assert_eq!(again.added, 0);
    assert_eq!(holdings(&pool).await.len(), 2);
}

#[tokio::test]
async fn files_imported_before_this_change_are_recognised() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let text = csv(A);
    let hash = sha256_hex(text.trim_start_matches('\u{feff}'));
    // The old import's op ids were mythic:<first 16 of the hash>:<row>.
    sqlx::query("INSERT INTO applied_ops (owner_id, op_id, kind, payload, applied_at) VALUES ('u1', ?, 'add', '{}', '2026-10-18T20:00:00Z')")
        .bind(format!("mythic:{}:0", &hash[..16]))
        .execute(&pool)
        .await
        .unwrap();
    let r = import_mythic_csv(&pool, "u1", &text, IMPORT).await.unwrap();
    assert_eq!(r.already_imported.as_deref(), Some("2026-10-18T20:00:00Z"));
    assert_eq!(r.added, 0);
}

#[tokio::test]
async fn a_newer_export_adds_only_what_is_new() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    import_mythic_csv(&pool, "u1", &csv(A), IMPORT).await.unwrap();
    // The next export repeats everything, with one more Sol Ring, a Forest in a new box, and the
    // Bolt now scanned as lightly played (condition doesn't count).
    let b = csv(&[
        ("Sol Ring", "p-sol", 3, "nonfoil", "NM", "box", "bulk"),
        ("Sol Ring", "p-sol", 1, "foil", "NM", "box", "bulk"),
        ("Lightning Bolt", "p-bolt", 1, "nonfoil", "LP", "box", "bulk"),
        ("Forest", "p-forest", 2, "nonfoil", "NM", "box", "Bulk Basic"),
    ]);
    let preview = import_mythic_csv(&pool, "u1", &b, PREVIEW).await.unwrap();
    assert_eq!((preview.added, preview.already_in_yama), (3, 4));
    assert_eq!(preview.new_containers, vec!["Bulk Basic (box)".to_string()]);
    // A preview writes nothing, not even the new box.
    let boxes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers").fetch_one(&pool).await.unwrap();
    assert_eq!(boxes, 1);

    let r = import_mythic_csv(&pool, "u1", &b, IMPORT).await.unwrap();
    assert_eq!(r.added, 3);
    assert_eq!(
        holdings(&pool).await,
        vec![
            h("p-bolt", "nonfoil", "box: bulk", 1),
            h("p-forest", "nonfoil", "box: Bulk Basic", 2),
            h("p-sol", "foil", "box: bulk", 1),
            h("p-sol", "nonfoil", "box: bulk", 3),
        ]
    );
}

#[tokio::test]
async fn a_card_moved_into_a_deck_box_stays_there() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    import_mythic_csv(&pool, "u1", &csv(A), IMPORT).await.unwrap();
    let bulk = container(&pool, "box", "bulk").await;
    let deck = container(&pool, "deck", "Tricky Terrain").await;
    move_copies(&pool, "m1", "p-sol", &bulk, &deck, 1).await;

    // A newer export still has both Sol Rings in bulk (Mythic doesn't know about the move), and a
    // Forest.
    let b = csv(&[
        ("Sol Ring", "p-sol", 2, "nonfoil", "NM", "box", "bulk"),
        ("Sol Ring", "p-sol", 1, "foil", "NM", "box", "bulk"),
        ("Lightning Bolt", "p-bolt", 1, "nonfoil", "NM", "box", "bulk"),
        ("Forest", "p-forest", 1, "nonfoil", "NM", "box", "bulk"),
    ]);
    let r = import_mythic_csv(&pool, "u1", &b, IMPORT).await.unwrap();
    assert_eq!((r.added, r.kept_where_moved), (1, 1));
    assert_eq!(r.kept_cards[0].now_in, vec!["deck: Tricky Terrain".to_string()]);
    assert_eq!(
        holdings(&pool).await,
        vec![
            h("p-bolt", "nonfoil", "box: bulk", 1),
            h("p-forest", "nonfoil", "box: bulk", 1),
            h("p-sol", "foil", "box: bulk", 1),
            h("p-sol", "nonfoil", "box: bulk", 1),
            h("p-sol", "nonfoil", "deck: Tricky Terrain", 1)
        ]
    );

    // A third Sol Ring scanned into bulk is added there, once.
    let c = csv(&[
        ("Sol Ring", "p-sol", 3, "nonfoil", "NM", "box", "bulk"),
        ("Sol Ring", "p-sol", 1, "foil", "NM", "box", "bulk"),
        ("Lightning Bolt", "p-bolt", 1, "nonfoil", "NM", "box", "bulk"),
        ("Forest", "p-forest", 1, "nonfoil", "NM", "box", "bulk"),
    ]);
    let r = import_mythic_csv(&pool, "u1", &c, IMPORT).await.unwrap();
    assert_eq!(r.added, 1);
    let sol: i64 = sqlx::query_scalar("SELECT SUM(qty) FROM collection_items WHERE scryfall_id = 'p-sol' AND finish = 'nonfoil'").fetch_one(&pool).await.unwrap();
    assert_eq!(sol, 3);
}

#[tokio::test]
async fn a_shrinking_file_shows_what_is_missing_and_removes_only_when_asked() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    import_mythic_csv(&pool, "u1", &csv(A), IMPORT).await.unwrap();
    // Copies the file can't speak for: a Bolt in a binder it doesn't name, and one unfiled.
    let binder = container(&pool, "binder", "Trade").await;
    add(&pool, "b1", "p-bolt", 1, Some(&binder)).await;
    add(&pool, "b2", "p-bolt", 1, None).await;
    let before = holdings(&pool).await;

    // The next export no longer has the Bolt, and one nonfoil Sol Ring fewer.
    let smaller = csv(&[("Sol Ring", "p-sol", 1, "nonfoil", "NM", "box", "bulk"), ("Sol Ring", "p-sol", 1, "foil", "NM", "box", "bulk")]);
    let preview = import_mythic_csv(&pool, "u1", &smaller, ImportOptions { dry_run: true, remove_missing: true }).await.unwrap();
    assert_eq!((preview.added, preview.missing, preview.removed), (0, 2, 2));
    let mut missing: Vec<(String, String, i64)> = preview.missing_cards.iter().map(|c| (c.name.clone(), c.place.clone(), c.qty)).collect();
    missing.sort();
    assert_eq!(missing, vec![("Lightning Bolt".into(), "box: bulk".into(), 1), ("Sol Ring".into(), "box: bulk".into(), 1)]);
    assert_eq!(holdings(&pool).await, before, "a preview changes nothing");

    // Without --remove-missing they stay.
    let kept = import_mythic_csv(&pool, "u1", &smaller, IMPORT).await.unwrap();
    assert_eq!((kept.missing, kept.removed), (2, 0));
    assert_eq!(holdings(&pool).await, before);

    // With it, only the named box loses them; the binder's and the unfiled Bolt stay.
    let removed = import_mythic_csv(&pool, "u1", &smaller, ImportOptions { dry_run: false, remove_missing: true }).await.unwrap();
    assert_eq!((removed.added, removed.removed), (0, 2));
    assert_eq!(
        holdings(&pool).await,
        vec![h("p-bolt", "nonfoil", "binder: Trade", 1), h("p-bolt", "nonfoil", "unfiled", 1), h("p-sol", "foil", "box: bulk", 1), h("p-sol", "nonfoil", "box: bulk", 1)]
    );
}

#[tokio::test]
async fn removing_missing_copies_follows_a_move_between_named_containers() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    import_mythic_csv(&pool, "u1", &csv(A), IMPORT).await.unwrap();
    // In Mythic Tools the Bolt went from bulk to the trade binder.
    let b = csv(&[
        ("Sol Ring", "p-sol", 2, "nonfoil", "NM", "box", "bulk"),
        ("Sol Ring", "p-sol", 1, "foil", "NM", "box", "bulk"),
        ("Lightning Bolt", "p-bolt", 1, "nonfoil", "NM", "binder", "Trade"),
    ]);
    let without = import_mythic_csv(&pool, "u1", &b, PREVIEW).await.unwrap();
    assert_eq!((without.added, without.missing, without.kept_where_moved), (0, 1, 1));
    import_mythic_csv(&pool, "u1", &b, ImportOptions { dry_run: false, remove_missing: true }).await.unwrap();
    let bolts: Vec<(String, String, String, i64)> = holdings(&pool).await.into_iter().filter(|x| x.0 == "p-bolt").collect();
    assert_eq!(bolts, vec![h("p-bolt", "nonfoil", "binder: Trade", 1)]);
}

#[tokio::test]
async fn purchase_prices_of_zero_are_unknown_and_users_count_apart() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u2','b@b.c','B','now')").execute(&pool).await.unwrap();
    let text = csv(A).replacen(",0,0\n", ",1.25,0\n", 1);
    let r1 = import_mythic_csv(&pool, "u1", &text, IMPORT).await.unwrap();
    let r2 = import_mythic_csv(&pool, "u2", &text, IMPORT).await.unwrap();
    assert_eq!((r1.added, r2.added), (4, 4));
    let rows: Vec<(String, i64, Option<f64>)> =
        sqlx::query_as("SELECT finish, qty, purchase_price FROM collection_items WHERE owner_id = 'u1' ORDER BY scryfall_id, finish").fetch_all(&pool).await.unwrap();
    // A purchase price of 0 means "not entered" in Mythic Tools.
    assert_eq!(rows, vec![("nonfoil".into(), 1, None), ("foil".into(), 1, None), ("nonfoil".into(), 2, Some(1.25))]);
}

#[tokio::test]
async fn deck_containers_become_decks_and_keep_their_commander() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let first = csv(&[
        ("Omo, Queen of Vesuva", "p-omo", 1, "nonfoil", "NM", "deck", "Tricky Terrain"),
        ("Tatyova, Benthic Druid", "p-tatyova", 1, "nonfoil", "NM", "deck", "Tricky Terrain"),
        ("Sol Ring", "p-sol", 1, "nonfoil", "NM", "deck", "Tricky Terrain"),
    ]);
    // An account whose new decks start public: a deck made from a collection box is private
    // all the same, because its list is the box's contents and the collection is opt-in.
    sqlx::query("UPDATE users SET new_deck_visibility = 'public' WHERE id = 'u1'").execute(&pool).await.unwrap();
    let r = import_mythic_csv(&pool, "u1", &first, IMPORT).await.unwrap();
    assert_eq!(r.decks_created, vec!["Tricky Terrain".to_string()]);
    let seen: String = sqlx::query_scalar("SELECT visibility FROM decks WHERE owner_id = 'u1'").fetch_one(&pool).await.unwrap();
    assert_eq!(seen, "private");
    let current = || async {
        let v: String = sqlx::query_scalar("SELECT v.cards FROM decks d JOIN deck_versions v ON v.id = d.current_version_id").fetch_one(&pool).await.unwrap();
        serde_json::from_str::<Vec<crate::decks::DeckCard>>(&v).unwrap()
    };
    // Two legends: Yama can't tell which leads, so none does yet.
    assert!(current().await.iter().all(|c| c.board == crate::decks::Board::Main));
    let again = import_mythic_csv(&pool, "u1", &first, IMPORT).await.unwrap();
    assert!(again.decks_created.is_empty() && again.decks_updated.is_empty());

    // The owner picks Omo.
    let deck: String = sqlx::query_scalar("SELECT id FROM decks").fetch_one(&pool).await.unwrap();
    let mut cards = current().await;
    for c in &mut cards {
        if c.oracle_id == "o-omo" {
            c.board = crate::decks::Board::Commander;
        }
    }
    crate::decks::insert_version(&pool, &deck, &cards, Some("picked the commander")).await.unwrap();

    // A newer export adds a card: the deck gets a version, and Omo still leads it.
    let newer = csv(&[
        ("Omo, Queen of Vesuva", "p-omo", 1, "nonfoil", "NM", "deck", "Tricky Terrain"),
        ("Tatyova, Benthic Druid", "p-tatyova", 1, "nonfoil", "NM", "deck", "Tricky Terrain"),
        ("Sol Ring", "p-sol", 1, "nonfoil", "NM", "deck", "Tricky Terrain"),
        ("Lightning Bolt", "p-bolt", 1, "nonfoil", "NM", "deck", "Tricky Terrain"),
    ]);
    let r = import_mythic_csv(&pool, "u1", &newer, IMPORT).await.unwrap();
    assert_eq!((r.added, r.decks_updated.clone()), (1, vec!["Tricky Terrain".to_string()]));
    let cards = current().await;
    let commanders: Vec<&str> = cards.iter().filter(|c| c.board == crate::decks::Board::Commander).map(|c| c.name.as_str()).collect();
    assert_eq!(commanders, vec!["Omo, Queen of Vesuva"]);
    assert_eq!(cards.len(), 4);
}

#[tokio::test]
async fn a_container_that_changed_type_in_mythic_is_the_same_place() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let as_list: Vec<_> = A.iter().map(|&(n, s, q, f, c, _, b)| (n, s, q, f, c, "list", b)).collect();
    import_mythic_csv(&pool, "u1", &csv(&as_list), IMPORT).await.unwrap();
    // The next export calls "bulk" a box, and has one Forest more.
    let mut as_box = A.to_vec();
    as_box.push(("Forest", "p-forest", 1, "nonfoil", "NM", "box", "bulk"));
    let preview = import_mythic_csv(&pool, "u1", &csv(&as_box), PREVIEW).await.unwrap();
    assert_eq!(preview.retyped_containers, vec!["bulk (list to box)".to_string()]);
    assert!(preview.new_containers.is_empty());
    assert_eq!((preview.added, preview.kept_where_moved), (1, 0));
    import_mythic_csv(&pool, "u1", &csv(&as_box), IMPORT).await.unwrap();
    let places: Vec<String> = holdings(&pool).await.into_iter().map(|x| x.2).collect();
    assert!(places.iter().all(|p| p == "box: bulk"), "{places:?}");
    let containers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers").fetch_one(&pool).await.unwrap();
    assert_eq!(containers, 1);
}

#[tokio::test]
async fn a_deck_made_in_yama_keeps_its_list_when_a_file_names_its_box() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    // A deck imported on the web, whose cards went into its box ("Add to my collection").
    let cards = vec![crate::decks::DeckCard { oracle_id: "o-omo".into(), name: "Omo, Queen of Vesuva".into(), qty: 1, board: crate::decks::Board::Commander }];
    let deck = crate::decks::create_deck_with_cards(&pool, "u1", "Tricky Terrain", None, cards).await.unwrap();
    let deck_box = container(&pool, "deck", "Tricky Terrain").await;
    sqlx::query("UPDATE decks SET container_id = ? WHERE id = ?").bind(&deck_box).bind(&deck).execute(&pool).await.unwrap();
    add(&pool, "a1", "p-omo", 1, Some(&deck_box)).await;

    // A Mythic file with a deck container of the same name and other cards.
    let file = csv(&[("Omo, Queen of Vesuva", "p-omo", 1, "nonfoil", "NM", "deck", "Tricky Terrain"), ("Sol Ring", "p-sol", 1, "nonfoil", "NM", "deck", "Tricky Terrain")]);
    let r = import_mythic_csv(&pool, "u1", &file, IMPORT).await.unwrap();
    assert_eq!((r.added, r.decks_kept.clone(), r.decks_created.len()), (1, vec!["Tricky Terrain".to_string()], 0));
    let versions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deck_versions WHERE deck_id = ?").bind(&deck).fetch_one(&pool).await.unwrap();
    assert_eq!(versions, 1);
}

#[tokio::test]
async fn special_foils_and_etched_keep_their_finish() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    // West Coast Expansion, MSC 40, comes regular and in surge foil (Bryan's store order).
    sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES ('o-wce','West Coast Expansion','Land','now')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, promo_types, updated_at) VALUES ('p-wce','o-wce','West Coast Expansion','msc','Marvel Super Heroes Commander','40','en','[\"nonfoil\",\"foil\"]','[\"surgefoil\"]','now')")
        .execute(&pool)
        .await
        .unwrap();
    // A file whose Finish names the special foil, or etched, keeps them; never dropped to regular.
    let file = csv(&[("West Coast Expansion", "p-wce", 1, "Surge Foil", "NM", "box", "bulk"), ("Sol Ring", "p-sol", 1, "Etched", "NM", "box", "bulk")]);
    import_mythic_csv(&pool, "u1", &file, IMPORT).await.unwrap();
    assert_eq!(holdings(&pool).await, vec![h("p-sol", "etched", "box: bulk", 1), h("p-wce", "foil", "box: bulk", 1)]);
}

/// Codex review of #146: the importer before 15 Nov 2026 filed "Surge Foil" as regular. The same
/// file imported again, with removals asked for, must never take that copy out without its foil
/// replacement (the receipt holds back the add): the copy is the row, so its finish is corrected.
#[tokio::test]
async fn a_file_imported_before_the_finish_fix_corrects_the_copy_and_never_loses_it() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let bulk = container(&pool, "box", "bulk").await;
    let text = csv(&[("Sol Ring", "p-sol", 2, "Surge Foil", "NM", "box", "bulk"), ("Lightning Bolt", "p-bolt", 1, "foil", "NM", "box", "bulk")]);
    // As the old importer left it: the surge foils as regular copies, the foil as foil, and its receipt.
    add(&pool, "old-sol", "p-sol", 2, Some(&bulk)).await;
    let mut tx = pool.begin().await.unwrap();
    let foil = Op {
        op_id: "old-bolt".into(),
        device_id: None,
        op: OpKind::Add { scryfall_id: "p-bolt".into(), qty: 1, copy: CopyKind { condition: nm(), finish: "foil".into(), lang: en(), ..Default::default() }, container_id: Some(bulk.clone()), purchase_price: None, purchase_currency: None },
    };
    apply_op(&mut tx, "u1", &foil).await.unwrap();
    tx.commit().await.unwrap();
    sqlx::query("INSERT INTO mythic_imports (owner_id, file_hash, imported_at, report) VALUES ('u1', ?, '2026-11-01T00:00:00Z', '{}')")
        .bind(sha256_hex(text.trim_start_matches('\u{feff}')))
        .execute(&pool)
        .await
        .unwrap();

    let remove = ImportOptions { dry_run: false, remove_missing: true };
    let preview = import_mythic_csv(&pool, "u1", &text, ImportOptions { dry_run: true, remove_missing: true }).await.unwrap();
    assert_eq!((preview.refinished, preview.missing, preview.removed), (2, 0, 0));
    let r = import_mythic_csv(&pool, "u1", &text, remove).await.unwrap();
    assert!(r.already_imported.is_some());
    assert_eq!((r.refinished, r.added, r.removed, r.missing), (2, 0, 0, 0));
    // Same number of copies, now foil as the file says.
    assert_eq!(holdings(&pool).await, vec![h("p-bolt", "foil", "box: bulk", 1), h("p-sol", "foil", "box: bulk", 2)]);
    // The receipt now says this importer read it, keeping its first date.
    let (version, at): (i64, String) = sqlx::query_as("SELECT parser_version, imported_at FROM mythic_imports").fetch_one(&pool).await.unwrap();
    assert_eq!((version, at.as_str()), (PARSER_VERSION, "2026-11-01T00:00:00Z"));
    // A third time changes nothing.
    let again = import_mythic_csv(&pool, "u1", &text, remove).await.unwrap();
    assert_eq!((again.refinished, again.added, again.removed), (0, 0, 0));
    assert_eq!(holdings(&pool).await, vec![h("p-bolt", "foil", "box: bulk", 1), h("p-sol", "foil", "box: bulk", 2)]);
    // Corrected once only: a copy changed to regular by hand since stays regular when the same
    // file comes back (Codex round-3 review of #146).
    set_finish(&pool, "p-sol", "nonfoil").await;
    for opts in [IMPORT, remove] {
        let r = import_mythic_csv(&pool, "u1", &text, opts).await.unwrap();
        assert_eq!((r.refinished, r.added, r.removed), (0, 0, 0));
    }
    assert_eq!(holdings(&pool).await, vec![h("p-bolt", "foil", "box: bulk", 1), h("p-sol", "nonfoil", "box: bulk", 2)]);
}

/// A file this importer read leaves a finish changed by hand alone: the Surge Foil it filed as
/// foil, made regular since, stays regular when the same file is imported again (as on main).
#[tokio::test]
async fn a_finish_changed_by_hand_after_import_survives_the_same_file_again() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let text = csv(&[("Sol Ring", "p-sol", 1, "Surge Foil", "NM", "box", "bulk")]);
    let first = import_mythic_csv(&pool, "u1", &text, IMPORT).await.unwrap();
    assert_eq!((first.added, first.refinished), (1, 0));
    assert_eq!(holdings(&pool).await, vec![h("p-sol", "foil", "box: bulk", 1)]);
    set_finish(&pool, "p-sol", "nonfoil").await;
    for opts in [IMPORT, ImportOptions { dry_run: false, remove_missing: true }] {
        let r = import_mythic_csv(&pool, "u1", &text, opts).await.unwrap();
        assert!(r.already_imported.is_some());
        assert_eq!((r.refinished, r.added, r.removed), (0, 0, 0));
    }
    assert_eq!(holdings(&pool).await, vec![h("p-sol", "nonfoil", "box: bulk", 1)]);
}

/// Change every copy of a printing to `finish`, as an edit on the Collection page does.
async fn set_finish(pool: &SqlitePool, sid: &str, finish: &str) {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM collection_items WHERE scryfall_id = ?").bind(sid).fetch_all(pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    for (n, id) in ids.into_iter().enumerate() {
        let op = Op {
            op_id: format!("hand-{sid}-{finish}-{n}"),
            device_id: None,
            op: OpKind::Update { item_id: id, condition: None, finish: Some(finish.into()), lang: None, container_id: None, purchase_price: None, note: None, proxy: None, altered: None, signed: None, scryfall_id: None, split: None },
        };
        apply_op(&mut tx, "u1", &op).await.unwrap();
    }
    tx.commit().await.unwrap();
}

/// Only as many copies as the file lists are corrected; a regular copy the file doesn't list stays
/// regular (and is the one removals may take). The corrected copy keeps the date it was added.
#[tokio::test]
async fn only_the_copies_the_file_lists_change_finish_and_keep_their_date() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let bulk = container(&pool, "box", "bulk").await;
    add(&pool, "old-sol", "p-sol", 3, Some(&bulk)).await;
    sqlx::query("UPDATE collection_items SET created_at = '2026-10-18T20:00:00Z'").execute(&pool).await.unwrap();
    let text = csv(&[("Sol Ring", "p-sol", 1, "Surge Foil", "NM", "box", "bulk")]);
    receipt(&pool, &text).await;
    let r = import_mythic_csv(&pool, "u1", &text, ImportOptions { dry_run: false, remove_missing: true }).await.unwrap();
    assert_eq!((r.refinished, r.added, r.removed), (1, 0, 2));
    assert_eq!(holdings(&pool).await, vec![h("p-sol", "foil", "box: bulk", 1)]);
    let added: Vec<String> = sqlx::query_scalar("SELECT created_at FROM collection_items").fetch_all(&pool).await.unwrap();
    assert_eq!(added, vec!["2026-10-18T20:00:00Z".to_string()]);
}

/// A file never imported is no evidence an earlier import misread it: a regular copy someone owns
/// stays regular, and the file's surge foil is added beside it (Codex re-review of #146).
#[tokio::test]
async fn a_file_never_imported_adds_its_foil_beside_a_regular_copy() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let bulk = container(&pool, "box", "bulk").await;
    add(&pool, "mine", "p-sol", 1, Some(&bulk)).await;
    let text = csv(&[("Sol Ring", "p-sol", 1, "Surge Foil", "NM", "box", "bulk")]);
    let r = import_mythic_csv(&pool, "u1", &text, IMPORT).await.unwrap();
    assert_eq!((r.refinished, r.added, r.removed), (0, 1, 0));
    assert_eq!(holdings(&pool).await, vec![h("p-sol", "foil", "box: bulk", 1), h("p-sol", "nonfoil", "box: bulk", 1)]);
}

/// This file's import receipt, as an earlier import of it left one.
async fn receipt(pool: &SqlitePool, text: &str) {
    sqlx::query("INSERT INTO mythic_imports (owner_id, file_hash, imported_at, report) VALUES ('u1', ?, '2026-11-01T00:00:00Z', '{}')")
        .bind(sha256_hex(text.trim_start_matches('\u{feff}')))
        .execute(pool)
        .await
        .unwrap();
}

/// With a receipt, the adds are held back; so are removals from a card the file still lists more
/// of in that place than Yama has, in any finish: removals and adds go together or not at all.
#[tokio::test]
async fn a_file_imported_before_never_removes_what_it_would_have_added_back() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let bulk = container(&pool, "box", "bulk").await;
    // Yama has a regular Sol Ring in bulk; the file (imported before) lists a foil one there.
    add(&pool, "a1", "p-sol", 1, Some(&bulk)).await;
    let text = csv(&[("Sol Ring", "p-sol", 1, "foil", "NM", "box", "bulk")]);
    sqlx::query("INSERT INTO mythic_imports (owner_id, file_hash, imported_at, report) VALUES ('u1', ?, '2026-11-01T00:00:00Z', '{}')")
        .bind(sha256_hex(text.trim_start_matches('\u{feff}')))
        .execute(&pool)
        .await
        .unwrap();
    let r = import_mythic_csv(&pool, "u1", &text, ImportOptions { dry_run: false, remove_missing: true }).await.unwrap();
    assert_eq!((r.added, r.missing, r.removed, r.refinished), (0, 1, 0, 0));
    assert_eq!(holdings(&pool).await, vec![h("p-sol", "nonfoil", "box: bulk", 1)]);
}

/// Two imports of the same old file at once (Codex round-4 review of #146): B corrects the
/// finish and moves the receipt to this importer's version, and the copy is changed back to
/// regular by hand, all while A waits for the write lock. A must decide on the receipt as it is
/// once it holds the lock, never on what it read before, so it doesn't correct the copy again.
/// A real database file (several connections, WAL, busy timeout), as the server runs.
#[tokio::test]
async fn an_import_waiting_for_the_lock_decides_on_the_receipt_as_it_is_then() {
    let dir = tempfile::tempdir().unwrap();
    let pool = crate::db::connect(&format!("sqlite://{}", dir.path().join("t.db").display()), std::time::Duration::from_secs(5)).await.unwrap();
    seed(&pool).await;
    let bulk = container(&pool, "box", "bulk").await;
    add(&pool, "old-sol", "p-sol", 2, Some(&bulk)).await;
    let text = csv(&[("Sol Ring", "p-sol", 2, "Surge Foil", "NM", "box", "bulk")]);
    receipt(&pool, &text).await;
    // B holds the write lock: its correction is done, the receipt moved on, and the copies were
    // changed back to regular by hand (they're regular again, so only the receipt shows it).
    let mut b = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
    sqlx::query("UPDATE mythic_imports SET parser_version = ?").bind(PARSER_VERSION).execute(&mut *b).await.unwrap();
    // A starts now and gets as far as the lock.
    let a = tokio::spawn({
        let (pool, text) = (pool.clone(), text.clone());
        async move { import_mythic_csv(&pool, "u1", &text, ImportOptions { dry_run: false, remove_missing: true }).await.unwrap() }
    });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    b.commit().await.unwrap();
    let r = a.await.unwrap();
    assert_eq!((r.refinished, r.added, r.removed), (0, 0, 0));
    assert_eq!(holdings(&pool).await, vec![h("p-sol", "nonfoil", "box: bulk", 2)]);
}
