//! Mythic Tools re-imports: the same file, a newer export, copies moved in Yama, a file that
//! shrank, and removals kept to the containers a file names.

use super::*;

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
    let r = import_mythic_csv(&pool, "u1", &first, IMPORT).await.unwrap();
    assert_eq!(r.decks_created, vec!["Tricky Terrain".to_string()]);
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
