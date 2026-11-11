//! The general collection import: pasted lists and other apps' CSV files, what matches and what
//! doesn't, where the copies go, and that the same list twice adds nothing.

use super::*;
use crate::collection::ensure_container;

async fn seed(pool: &SqlitePool) {
    for (id, email) in [("u1", "a@b.c"), ("u2", "d@e.f")] {
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,'A','now')").bind(id).bind(email).execute(pool).await.unwrap();
    }
    for (oid, name) in [("o-sol", "Sol Ring"), ("o-bolt", "Lightning Bolt"), ("o-vault", "Lim-Dûl's Vault")] {
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES (?,?,'Artifact','now')").bind(oid).bind(name).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(oid).execute(pool).await.unwrap();
    }
    // (Scryfall id, oracle id, name, set, set name, number, language, released)
    for (sid, oid, name, set, set_name, number, lang, released) in [
        ("p-sol-c21", "o-sol", "Sol Ring", "c21", "Commander 2021", "263", "en", "2021-04-23"),
        ("p-sol-cmm", "o-sol", "Sol Ring", "cmm", "Commander Masters", "410", "en", "2023-08-04"),
        ("p-sol-cmm-ja", "o-sol", "Sol Ring", "cmm", "Commander Masters", "410", "ja", "2023-08-04"),
        ("p-bolt", "o-bolt", "Lightning Bolt", "lea", "Limited Edition Alpha", "161", "en", "1993-08-05"),
        ("p-vault", "o-vault", "Lim-Dûl's Vault", "all", "Alliances", "107", "en", "1996-06-10"),
    ] {
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, released_at, updated_at)
             VALUES (?,?,?,?,?,?,?,'[\"nonfoil\",\"foil\"]',?,'now')",
        )
        .bind(sid)
        .bind(oid)
        .bind(name)
        .bind(set)
        .bind(set_name)
        .bind(number)
        .bind(lang)
        .bind(released)
        .execute(pool)
        .await
        .unwrap();
    }
}

fn opts(dry_run: bool, top_up: bool) -> ImportOptions {
    ImportOptions { dry_run, top_up, container_id: None }
}

/// One account's copies by (Scryfall id, finish, condition, language, place, copies), where place
/// is "kind: name" or "unfiled".
async fn holdings(pool: &SqlitePool, owner: &str) -> Vec<(String, String, String, String, String, i64)> {
    sqlx::query_as(
        "SELECT i.scryfall_id, i.finish, i.condition, i.lang, IFNULL(ct.kind || ': ' || ct.name, 'unfiled'), SUM(i.qty) FROM collection_items i
         LEFT JOIN containers ct ON ct.id = i.container_id WHERE i.owner_id = ? GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5",
    )
    .bind(owner)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn h(sid: &str, finish: &str, condition: &str, lang: &str, place: &str, qty: i64) -> (String, String, String, String, String, i64) {
    (sid.into(), finish.into(), condition.into(), lang.into(), place.into(), qty)
}

/// Copies someone has already, added the way the app adds them.
async fn add(pool: &SqlitePool, owner: &str, op_id: &str, sid: &str, qty: i64) {
    let mut tx = pool.begin().await.unwrap();
    let op = Op {
        op_id: op_id.into(),
        device_id: None,
        op: OpKind::Add { scryfall_id: sid.into(), qty, copy: CopyKind { condition: "NM".into(), finish: "nonfoil".into(), lang: "en".into(), ..Default::default() }, container_id: None, purchase_price: None, purchase_currency: None },
    };
    apply_op(&mut tx, owner, &op).await.unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn a_pasted_list_previews_then_adds_and_keeps_what_did_not_match() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let list = "2 Sol Ring\n1 Lightning Bolt (LEA) 161 *F*\n1 Lim-Dul's Vault\n3 Blak Lotus\n";
    let p = import_collection(&pool, "u1", list, None, opts(true, false)).await.unwrap();
    assert_eq!((p.lines, p.copies, p.added, p.unmatched_copies), (4, 4, 4, 3));
    assert_eq!(p.place, "unfiled");
    // The line that matched nothing is listed as written, not dropped.
    assert_eq!(p.unmatched.len(), 1);
    assert_eq!((p.unmatched[0].text.as_str(), p.unmatched[0].qty), ("3 Blak Lotus", 3));
    assert!(holdings(&pool, "u1").await.is_empty(), "a preview writes nothing");
    // No printing named: a regular printing of the card (the newest here). A named one: that one.
    let printings: Vec<(&str, &str, &str)> = p.added_cards.iter().map(|l| (l.name.as_str(), l.set_code.as_str(), l.printing)).collect();
    assert_eq!(printings, vec![("Sol Ring", "cmm", "default"), ("Lightning Bolt", "lea", "exact"), ("Lim-Dûl's Vault", "all", "default")]);
    assert_eq!(p.added_cards[1].finish, "foil");
    assert_eq!(p.added_cards[2].written_as.as_deref(), Some("Lim-Dul's Vault"));
    assert!(p.notes.iter().any(|n| n.starts_with("2 lines named no printing")), "{:?}", p.notes);

    let r = import_collection(&pool, "u1", list, None, opts(false, false)).await.unwrap();
    assert_eq!((r.added, r.unmatched.len(), r.dry_run), (4, 1, false));
    assert_eq!(
        holdings(&pool, "u1").await,
        vec![h("p-bolt", "foil", "NM", "en", "unfiled", 1), h("p-sol-cmm", "nonfoil", "NM", "en", "unfiled", 2), h("p-vault", "nonfoil", "NM", "en", "unfiled", 1)]
    );
    // Nothing of it reached anyone else.
    assert!(holdings(&pool, "u2").await.is_empty());
}

#[tokio::test]
async fn the_same_list_again_adds_nothing() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let first = import_collection(&pool, "u1", "2 Sol Ring\n1 Lightning Bolt\n", None, opts(false, false)).await.unwrap();
    assert_eq!((first.added, first.already_imported.is_some()), (3, false));
    // The same cards with other line endings and a blank line at the end are the same list, in
    // a preview and for real, with or without topping up.
    for (dry_run, top_up) in [(true, false), (false, false), (false, true)] {
        let again = import_collection(&pool, "u1", "2 Sol Ring\r\n1 Lightning Bolt\r\n\r\n", None, opts(dry_run, top_up)).await.unwrap();
        assert!(again.already_imported.is_some());
        assert_eq!((again.added, again.added_cards.len(), again.copies), (0, 0, 3));
    }
    assert_eq!(holdings(&pool, "u1").await, vec![h("p-bolt", "nonfoil", "NM", "en", "unfiled", 1), h("p-sol-cmm", "nonfoil", "NM", "en", "unfiled", 2)]);
    // Someone else importing the same list gets their own copies.
    let theirs = import_collection(&pool, "u2", "2 Sol Ring\n1 Lightning Bolt\n", None, opts(false, false)).await.unwrap();
    assert_eq!((theirs.added, theirs.already_imported.is_some()), (3, false));
    // A list with one more card is another list: all of it is added.
    let more = import_collection(&pool, "u1", "2 Sol Ring\n1 Lightning Bolt\n1 Lim-Dûl's Vault\n", None, opts(false, false)).await.unwrap();
    assert_eq!(more.added, 4);
    assert_eq!(
        holdings(&pool, "u1").await,
        vec![h("p-bolt", "nonfoil", "NM", "en", "unfiled", 2), h("p-sol-cmm", "nonfoil", "NM", "en", "unfiled", 4), h("p-vault", "nonfoil", "NM", "en", "unfiled", 1)]
    );
}

#[tokio::test]
async fn topping_up_adds_only_the_copies_the_account_lacks() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    add(&pool, "u1", "have", "p-sol-cmm", 1).await;
    // Someone else's copies never count.
    add(&pool, "u2", "theirs", "p-sol-cmm", 9).await;
    let list = "3 Sol Ring (CMM) 410\n1 Lightning Bolt\n";
    let p = import_collection(&pool, "u1", list, None, opts(true, true)).await.unwrap();
    assert_eq!((p.copies, p.added, p.already_owned), (4, 3, 1));
    assert_eq!(p.added_cards.iter().map(|l| l.qty).collect::<Vec<_>>(), vec![2, 1]);
    import_collection(&pool, "u1", list, None, opts(false, true)).await.unwrap();
    assert_eq!(holdings(&pool, "u1").await, vec![h("p-bolt", "nonfoil", "NM", "en", "unfiled", 1), h("p-sol-cmm", "nonfoil", "NM", "en", "unfiled", 3)]);
    // A newer export with one more Sol Ring adds that one.
    let newer = import_collection(&pool, "u1", "4 Sol Ring (CMM) 410\n1 Lightning Bolt\n", None, opts(false, true)).await.unwrap();
    assert_eq!((newer.added, newer.already_owned), (1, 4));
    // A foil is another kind of copy: owning the nonfoil doesn't stand for it.
    let foil = import_collection(&pool, "u1", "1 Sol Ring (CMM) 410 *F*\n", None, opts(false, true)).await.unwrap();
    assert_eq!((foil.added, foil.already_owned), (1, 0));
    // Without topping up, everything a list names is added.
    let all = import_collection(&pool, "u1", "4 Sol Ring (CMM) 410\n", None, opts(false, false)).await.unwrap();
    assert_eq!((all.added, all.already_owned), (4, 0));
    assert_eq!(
        holdings(&pool, "u1").await,
        vec![h("p-bolt", "nonfoil", "NM", "en", "unfiled", 1), h("p-sol-cmm", "foil", "NM", "en", "unfiled", 1), h("p-sol-cmm", "nonfoil", "NM", "en", "unfiled", 8)]
    );
    assert_eq!(holdings(&pool, "u2").await, vec![h("p-sol-cmm", "nonfoil", "NM", "en", "unfiled", 9)]);
}

#[tokio::test]
async fn a_manabox_file_keeps_condition_language_finish_and_price() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let file = "Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency\n\
        Sol Ring,C21,Commander 2021,263,normal,uncommon,2,1,P-SOL-C21,1.50,false,false,near_mint,en,USD\n\
        Sol Ring,CMM,Commander Masters,410,foil,uncommon,1,2,,0,false,true,light_played,ja,USD\n\
        Lightning Bolt,LEA,Limited Edition Alpha,161,normal,common,1,3,not-in-yama,12,false,false,Fair,English,EUR\n";
    let r = import_collection(&pool, "u1", file, Some("ManaBox_Collection.csv"), opts(false, false)).await.unwrap();
    assert_eq!(r.source, "a ManaBox export");
    assert_eq!((r.lines, r.added, r.unmatched.len()), (3, 4, 0));
    assert_eq!(r.added_cards.iter().map(|l| l.printing).collect::<Vec<_>>(), vec!["id", "exact", "exact"]);
    // A condition Yama doesn't know is said, and filed as near mint.
    assert!(r.notes.iter().any(|n| n.contains("\"Fair\"")), "{:?}", r.notes);
    type Stored = (String, String, String, String, bool, Option<f64>, Option<String>);
    let rows: Vec<Stored> =
        sqlx::query_as("SELECT scryfall_id, finish, condition, lang, altered, purchase_price, purchase_currency FROM collection_items WHERE owner_id = 'u1' ORDER BY scryfall_id")
            .fetch_all(&pool)
            .await
            .unwrap();
    let expected: Vec<Stored> = vec![
            ("p-bolt".into(), "nonfoil".into(), "NM".into(), "en".into(), false, Some(12.0), Some("EUR".into())),
            ("p-sol-c21".into(), "nonfoil".into(), "NM".into(), "en".into(), false, Some(1.5), Some("USD".into())),
            // The Japanese printing of that set and number; a price of 0 is "not entered".
            ("p-sol-cmm-ja".into(), "foil".into(), "MP".into(), "ja".into(), true, None, None),
        ];
    assert_eq!(rows, expected);
}

#[tokio::test]
async fn a_dragon_shield_file_matches_by_number_and_lists_the_row_it_could_not_place() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let bulk = ensure_container(&pool, "u1", "box", "Bulk").await.unwrap();
    let file = "\"sep=,\"\n\
        Folder Name,Quantity,Trade Quantity,Card Name,Set Code,Set Name,Card Number,Condition,Printing,Language,Price Bought,Date Bought\n\
        Binder,2,0,Sol Ring,C21,Commander 2021,263,NearMint,Foil,English,2.00,2026-01-01\n\
        Binder,1,0,Sol Rnig,CMM,Commander Masters,410,Excellent,Normal,Japanese,0.00,2026-01-01\n\
        Binder,1,0,Storm Crow,XYZ,Nowhere,1,Good,Normal,English,0.00,2026-01-01\n";
    // No file name: the header row says it's a CSV.
    let r = import_collection(&pool, "u1", file, None, ImportOptions { dry_run: false, top_up: false, container_id: Some(bulk) }).await.unwrap();
    assert_eq!(r.source, "a Dragon Shield export");
    assert_eq!((r.place.as_str(), r.lines, r.added), ("box: Bulk", 3, 3));
    // A misspelled name with a set and number that say which card it is.
    assert_eq!((r.added_cards[1].name.as_str(), r.added_cards[1].printing, r.added_cards[1].written_as.as_deref()), ("Sol Ring", "number", Some("Sol Rnig")));
    assert_eq!(r.unmatched, vec![Unmatched { text: "1 Storm Crow (XYZ) 1".into(), row: Some(5), qty: 1, reason: "No card has this name.".into(), suggestions: vec![] }]);
    assert_eq!(holdings(&pool, "u1").await, vec![h("p-sol-c21", "foil", "NM", "en", "box: Bulk", 2), h("p-sol-cmm-ja", "nonfoil", "LP", "ja", "box: Bulk", 1)]);
}

#[tokio::test]
async fn copies_go_only_into_a_container_of_ones_own() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    let theirs = ensure_container(&pool, "u2", "box", "Theirs").await.unwrap();
    for dry_run in [true, false] {
        let refused = import_collection(&pool, "u1", "1 Lightning Bolt\n", None, ImportOptions { dry_run, top_up: false, container_id: Some(theirs.clone()) }).await;
        assert!(matches!(refused, Err(AppError::NotFound(_))));
    }
    assert!(holdings(&pool, "u1").await.is_empty());
    assert!(holdings(&pool, "u2").await.is_empty());
}

#[tokio::test]
async fn a_printing_yama_lacks_falls_back_and_says_so() {
    let pool = crate::db::test_pool().await;
    seed(&pool).await;
    // A set Yama doesn't have the card in, a number that set doesn't have, and more copies than
    // one line may add.
    let r = import_collection(&pool, "u1", "1 Sol Ring (ZZZ) 9\n1 Sol Ring (C21) 999\n10001 Lightning Bolt\n", None, opts(true, false)).await.unwrap();
    let printings: Vec<(&str, &str)> = r.added_cards.iter().map(|l| (l.set_code.as_str(), l.printing)).collect();
    assert_eq!(printings, vec![("cmm", "default"), ("c21", "set")]);
    assert!(r.notes.iter().any(|n| n.starts_with("2 lines named a set or number Yama doesn't have")), "{:?}", r.notes);
    assert_eq!((r.unmatched.len(), r.unmatched[0].text.as_str(), r.unmatched_copies), (1, "10001 Lightning Bolt", 10001));
}

#[test]
fn reads_each_apps_columns() {
    // TCGplayer: the plain name, the set's code, and a finish written into the condition.
    let src = read(
        "Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language\n1,Sol Ring (Extended Art),Sol Ring,Commander Masters,0410,CMM,Normal,Near Mint Foil,English\n",
        None,
    );
    assert_eq!(src.label, "a TCGplayer export");
    let r = &src.rows[0];
    assert_eq!(
        (r.name.as_str(), r.set_code.as_deref(), r.set_name.as_deref(), r.collector_number.as_deref(), r.finish, r.condition, r.lang),
        ("Sol Ring", Some("cmm"), Some("Commander Masters"), Some("0410"), "foil", "NM", Some("en"))
    );

    // Moxfield: "Edition" is the set code; a count of 0 is a tradelist row, not a card owned.
    let src = read(
        "Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,Last Modified,Collector Number,Alter,Proxy,Purchase Price\n\
         2,0,Sol Ring,cmm,Lightly Played,English,etched,,2026-01-01,410,True,True,$3.25\n\
         0,1,Lightning Bolt,lea,Near Mint,English,,,2026-01-01,161,False,False,\n",
        Some("moxfield.csv"),
    );
    assert_eq!((src.label.as_str(), src.rows.len()), ("a Moxfield export", 1));
    let r = &src.rows[0];
    assert_eq!((r.qty, r.set_code.as_deref(), r.finish, r.condition, r.altered, r.proxy), (2, Some("cmm"), "etched", "LP", true, true));
    assert_eq!((r.purchase_price, r.purchase_currency.as_deref()), (Some(3.25), Some("USD")));

    // Deckbox: the set by name, and flags written as their own word.
    let src = read(
        "Count,Tradelist Count,Name,Edition,Card Number,Condition,Language,Foil,Signed,Artist Proof,Altered Art,Misprint,Promo,Textless,My Price\n\
         1,0,Sol Ring,Commander 2021,263,Good (Lightly Played),English,foil,signed,,,,,,$1.00\n",
        None,
    );
    assert_eq!(src.label, "a Deckbox export");
    let r = &src.rows[0];
    assert_eq!((r.set_code.as_deref(), r.set_name.as_deref(), r.condition, r.finish, r.signed, r.altered), (None, Some("Commander 2021"), "LP", "foil", true, false));

    // Archidekt: codes in capitals, and the Scryfall id.
    let src = read(
        "Quantity,Name,Finish,Condition,Date Added,Language,Purchase Price,Tags,Edition Name,Edition Code,Multiverse Id,Scryfall ID,Collector Number\n\
         1,Sol Ring,Normal,NM,2026-01-01,EN,,,Commander 2021,c21,1,P-SOL-C21,263\n",
        None,
    );
    assert_eq!(src.label, "an Archidekt export");
    let r = &src.rows[0];
    assert_eq!((r.scryfall_id.as_deref(), r.lang, r.finish, r.purchase_price), (Some("p-sol-c21"), Some("en"), "nonfoil", None));

    // A list with a comma in a name is a list, not a CSV.
    let src = read("1 Jace, the Mind Sculptor\n2 Sol Ring\n", None);
    assert_eq!((src.label.as_str(), src.rows.len(), src.rows[0].name.as_str()), ("a plain list", 2, "Jace, the Mind Sculptor"));

    // A CSV with no card column says so rather than reading nothing quietly.
    let src = read("Quantity,Price\n1,2\n", Some("prices.csv"));
    assert!(src.rows.is_empty());
    assert!(src.skipped[0].contains("no card name column"), "{:?}", src.skipped);
    // A quantity that isn't a number is listed, not guessed.
    let src = read("Quantity,Name\nlots,Sol Ring\n", None);
    assert!(src.rows.is_empty());
    assert!(src.skipped[0].contains("isn't a number of copies"), "{:?}", src.skipped);
}

#[test]
fn conditions_languages_prices_and_numbers() {
    for (raw, code) in [
        ("NM", "NM"),
        ("Near Mint", "NM"),
        ("near_mint", "NM"),
        ("Mint", "NM"),
        ("Lightly Played", "LP"),
        ("Excellent", "LP"),
        ("SP", "LP"),
        ("Moderately Played", "MP"),
        ("good", "MP"),
        ("light_played", "MP"),
        ("Heavily Played", "HP"),
        ("played", "HP"),
        ("Damaged", "DMG"),
        ("poor", "DMG"),
        ("Lightly Played Foil", "LP"),
    ] {
        assert_eq!(condition_code(raw), Some(code), "{raw}");
    }
    assert_eq!(condition_code("Fair"), None);
    assert_eq!(condition_code(""), None);
    for (raw, code) in [("en", "en"), ("EN", "en"), ("English", "en"), ("Japanese", "ja"), ("jp", "ja"), ("Chinese Simplified", "zhs"), ("Portuguese", "pt")] {
        assert_eq!(lang_code(raw), Some(code), "{raw}");
    }
    assert_eq!(lang_code("Klingon"), None);
    assert_eq!((price("$1,234.50"), price("0"), price("-3"), price(""), price("free")), (Some(1234.5), None, None, None, None));
    assert_eq!((plain_number("0263"), plain_number("263/350"), plain_number("12a"), plain_number("0")), ("263".to_string(), "263".to_string(), "12a".to_string(), "0".to_string()));
    assert_eq!((finish_of(Some("Foil")), finish_of(Some("etched")), finish_of(Some("Normal")), finish_of(Some("nonfoil")), finish_of(None)), ("foil", "etched", "nonfoil", "nonfoil", "nonfoil"));
}
