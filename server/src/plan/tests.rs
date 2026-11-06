//! Planner slice 1: import, storage and bundle, through the real router on an in-memory database.
//! The fixture is synthetic; Bryan's plan data stays out of this repo.

use super::import;
use crate::error::AppError;
use crate::testutil::{app, send, user};
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;

// ── fixture ────────────────────────────────────────────────────────────────

/// Cards Yama knows. "Unknown Future Card" is deliberately missing (like the Star Trek decks).
async fn seed_cards(pool: &SqlitePool) {
    let cards = [
        ("o-cmd", "Test Commander", "Legendary Creature — Elf", "G"),
        ("o-cmd2", "Second Commander", "Legendary Creature — Merfolk", "U"),
        ("o-sol", "Sol Ring", "Artifact", ""),
        ("o-old", "Old Card", "Creature — Elf", "G"),
        ("o-cut", "Cut Card", "Instant", "G"),
        ("o-bought", "Bought Card", "Sorcery", "G"),
        ("o-stand", "Stand Card", "Creature — Elf", "G"),
        ("o-print", "Print Card", "Enchantment", "G"),
        ("o-prop", "Proposal Card", "Artifact", ""),
        ("o-spare", "Spare Card", "Artifact", ""),
        ("o-forest", "Forest", "Basic Land — Forest", "G"),
        ("o-island", "Island", "Basic Land — Island", "U"),
        ("o-red", "Red Card", "Instant", "R"),
    ];
    for (id, name, type_line, ci) in cards {
        sqlx::query(
            "INSERT INTO cards (oracle_id, name, type_line, color_identity, legalities, updated_at)
             VALUES (?, ?, ?, ?, '{\"commander\":\"legal\"}', 'now')",
        )
        .bind(id)
        .bind(name)
        .bind(type_line)
        .bind(ci)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(id).execute(pool).await.unwrap();
    }
    // Printings: Bought Card has no price at all; Proposal Card has a current printing and a
    // cheaper one whose last price is months old.
    for (sid, oid, name, set, num) in [
        ("p-cmd", "o-cmd", "Test Commander", "tst", "1"),
        ("p-bought", "o-bought", "Bought Card", "tst", "2"),
        ("p-prop", "o-prop", "Proposal Card", "tst", "3"),
        ("p-prop-old", "o-prop", "Proposal Card", "old", "1"),
        ("p-print", "o-print", "Print Card", "tst", "4"),
    ] {
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'en', 'now')",
        )
        .bind(sid)
        .bind(oid)
        .bind(name)
        .bind(set)
        .bind(if set == "tst" { "Test Set" } else { "Old Set" })
        .bind(num)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd, usd_foil) VALUES ('p-prop', '2026-10-18', 0.6, NULL), ('p-prop-old', '2026-06-01', 0.1, NULL)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO import_runs (id, kind, started_at, finished_at, rows) VALUES ('run-1', 'default_cards', '2026-10-18T20:00:00Z', '2026-10-18T20:09:10Z', 4)")
        .execute(pool)
        .await
        .unwrap();
}

fn forest(n: i64) -> Value {
    json!({"name": "Forest", "qty": n, "board": "main", "kind": "stock"})
}

fn slot(name: &str, kind: &str) -> Value {
    json!({"name": name, "qty": 1, "board": "main", "kind": kind})
}

fn alpha_list(third: &str, fourth: &str) -> Value {
    json!([
        {"name": "Test Commander", "qty": 1, "board": "commander", "kind": "stock", "set": "tst", "num": "1"},
        slot("Sol Ring", "stock"), slot(third, "stock"), slot(fourth, "stock"), forest(96)
    ])
}

fn beta_list() -> Value {
    json!([
        {"name": "Second Commander", "qty": 1, "board": "commander"},
        {"name": "Unknown Future Card", "qty": 1, "board": "main"},
        {"name": "Island", "qty": 98, "board": "main"}
    ])
}

/// A two-deck plan: Alpha with a print swap held by a stand-in, a bought swap and two proposals;
/// Beta, proposals only, with a card Yama doesn't know yet.
fn doc() -> Value {
    json!({
        "format": "yama-plan/1",
        "meta": {"app": "commander-decks", "guide_version": 6, "guide_date": "2026-10-18", "git_sha": "abc1234",
                 "dirty": false, "generated_at": "2026-10-18T21:30:00Z"},
        "plan": {
            "settings": [
                {"effective_from": "2026-10-08", "note": "First rules", "rules": {"currency": "USD", "max_over_market_pct": 25}},
                {"effective_from": "2026-10-10", "note": "Later rules", "rules": {"currency": "USD", "ceiling_other_usd": 3.0}}
            ],
            "stores": [
                {"key": "shop", "name": "Example Games", "short": "Example", "kind": "local",
                 "cart_url_template": "https://example.com/cart/{items}", "homepage": "https://example.com", "sort": 1},
                {"key": "printer", "name": "Example Printer", "kind": "printer", "print_tiers": [18, 36], "sort": 2}
            ],
            "decks": [
                {"key": "alpha", "name": "Alpha Deck", "sort": 1, "product": "Alpha (TST)", "commander": ["Test Commander"],
                 "color_identity": "G", "owner_changes": [], "notes": [{"kind": "open_question", "text": "Where did this come from?"}],
                 "bracket": {"target": 3, "bags": {"2": [{"out": "Sol Ring", "in": "Cut Card", "from": "Came in this precon",
                                                          "got": {"how": "deck", "deck": "alpha", "deck_name": "Alpha Deck", "origin": "precon"}}]}},
                 "states": {
                     "stock": {"cards": alpha_list("Old Card", "Cut Card")},
                     "now": {"cards": alpha_list("Stand Card", "Bought Card"),
                             "log": [{"swap": "plan|Alpha Deck|Bought Card|Cut Card", "status": "done"},
                                     {"swap": "plan|Alpha Deck|Print Card|Old Card", "status": "standin"}]},
                     "after": {"cards": alpha_list("Print Card", "Bought Card"),
                               "log": [{"swap": "plan|Alpha Deck|Print Card|Old Card", "status": "print"}]}
                 }},
                {"key": "beta", "name": "Beta Deck", "sort": 2, "status": "proposals_only", "commander": ["Second Commander"],
                 "color_identity": "U",
                 "states": {"stock": {"cards": beta_list()}, "now": {"cards": beta_list()}, "after": {"cards": beta_list()}}}
            ],
            "swaps": [
                {"key": "plan|Alpha Deck|Print Card|Old Card", "deck": "alpha", "stage": "planned", "role": "swap",
                 "src": "print", "out": "Old Card", "in": "Print Card", "plan_card": "Print Card", "tier": "T1", "sort": 1,
                 "print_order": "proxy-1", "order_item": {"order": "proxy-1", "line": 1}, "why": "Better", "why_out": "Worse"},
                {"key": "standin|Alpha Deck|Stand Card", "deck": "alpha", "stage": "planned", "role": "standin",
                 "parent": "plan|Alpha Deck|Print Card|Old Card", "src": "buy", "store_label": "Example",
                 "out": "Old Card", "in": "Stand Card", "later_out": "Sol Ring", "order_item": {"order": "shop-1", "line": 2}},
                {"key": "plan|Alpha Deck|Bought Card|Cut Card", "deck": "alpha", "stage": "planned", "role": "swap",
                 "src": "buy", "store_label": "Example", "out": "Cut Card", "in": "Bought Card", "tier": "T1", "sort": 2,
                 "order_item": {"order": "shop-1", "line": 1}, "upgrade": {"id": "upgrade-001", "status": "ordered"}},
                {"key": "alpha-idea", "deck": "alpha", "stage": "proposed", "role": "swap", "src": "buy",
                 "out": "Sol Ring", "in": "Proposal Card", "group": "Core", "when": "Now", "why": "A test"},
                {"key": "alpha-owned", "deck": "alpha", "stage": "proposed", "role": "swap", "src": "owned",
                 "out": null, "in": "Spare Card",
                 "got": {"how": "deck", "deck": "beta", "deck_name": "Beta Deck", "origin": "precon"}}
            ],
            "orders": [
                {"key": "shop-1", "kind": "real", "status": "received", "vendor": "Example Games", "store": "shop",
                 "date_ordered": "2026-10-08", "subtotal": 1.5, "shipping": 0.0, "tax": null, "total": null,
                 "subtotal_note": "Sum of cart prices", "issues": [],
                 "items": [
                     {"line": 1, "card": "Bought Card", "qty": 1, "set": "TST", "num": "2", "unit_price": 0.5,
                      "deck": "alpha", "replaces": "Cut Card", "role": "plan card", "arrived": true},
                     {"line": 2, "card": "Stand Card", "qty": 1, "set": "zzz", "num": "999", "unit_price": null,
                      "deck": "alpha", "role": "temporary stand-in for Print Card", "arrived": true}
                 ]},
                {"key": "proxy-1", "kind": "proxy", "status": "placed", "vendor": "Example Printer", "store": "printer",
                 "placed_by": "2026-10-15", "items": [{"line": 1, "card": "Print Card", "qty": 1}]}
            ],
            "quotes": [
                {"swap": "alpha-idea", "card": "Proposal Card", "kind": "stock_check", "store": "shop", "store_label": "Example Games",
                 "checked": "2026-10-18", "result": "In stock: TST #3 $0.75", "in_stock": true, "price": 0.75,
                 "price_from_text": true, "set": "tst", "num": "3", "printing_from_text": true, "variant": 42427719221416u64,
                 "source": "Store website"},
                {"swap": "alpha-idea", "card": "Proposal Card", "kind": "stock_check", "store": "shop",
                 "checked": "2026-10-18", "result": "Out of stock", "in_stock": false, "price": null, "source": "Store website"},
                {"swap": "alpha-idea", "card": "Proposal Card", "kind": "market_benchmark", "checked": "2026-10-18",
                 "price": 0.51, "printing": "Test Set (TST) #3", "source": "TCGplayer market via Scryfall, cheapest non-foil"}
            ],
            "reviews": {},
            "warnings": [{"deck": "alpha", "swap": null, "text": "A warning from the writer"}],
            "notes": [{"kind": "open_question", "text": "A plan-wide question"}],
            "game_changers": {"checked_on": "2026-10-09", "source": "Test list", "names": ["Sol Ring"]}
        }
    })
}

fn swap_mut<'a>(d: &'a mut Value, key: &str) -> &'a mut Value {
    d["plan"]["swaps"].as_array_mut().unwrap().iter_mut().find(|s| s["key"] == key).unwrap()
}

fn remove_swap(d: &mut Value, key: &str) {
    d["plan"]["swaps"].as_array_mut().unwrap().retain(|s| s["key"] != key);
}

fn plan_hash(d: &Value) -> String {
    // The tests send `d.to_string()`, whose "plan" value serializes the same way on its own.
    crate::util::sha256_hex(&d["plan"].to_string())
}

async fn setup() -> (Router, SqlitePool, String, String) {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (id, token) = user(&pool, "bryan@example.com").await;
    (app, pool, id, token)
}

async fn post_bytes(app: &Router, token: &str, path: &str, body: Vec<u8>) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn import(app: &Router, token: &str, d: &Value) -> Value {
    let (status, body) = post_bytes(app, token, "/api/plan/import", d.to_string().into_bytes()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn bundle(app: &Router, token: &str) -> Value {
    let (status, body) = send(app, Method::GET, "/api/plan/bundle", Some(token), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn count(pool: &SqlitePool, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(pool).await.unwrap()
}

const PLAN_TABLES: [&str; 13] = [
    "plan_meta", "plan_imports", "plan_settings", "plan_stores", "plan_decks", "plan_states", "plan_orders",
    "plan_order_items", "plan_swaps", "plan_key_aliases", "plan_quotes", "plan_reviews", "plan_marks",
];

/// Every planner row, as text, so "nothing was written" can be checked exactly.
async fn snapshot(pool: &SqlitePool) -> Vec<String> {
    let mut out = Vec::new();
    for t in PLAN_TABLES {
        let cols: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info(?)").bind(t).fetch_all(pool).await.unwrap();
        let row = cols.iter().map(|c| format!("quote({c})")).collect::<Vec<_>>().join(" || ',' || ");
        let rows: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT {row} FROM {t} ORDER BY rowid")))
            .fetch_all(pool)
            .await
            .unwrap_or_else(|e| panic!("{t}: {e}"));
        out.push(format!("{t}: {}", rows.join("\n")));
    }
    out
}

async fn swap_row(pool: &SqlitePool, owner: &str, key: &str) -> (String, Option<String>, String) {
    sqlx::query_as("SELECT id, retired_at, content_hash FROM plan_swaps WHERE owner_id = ? AND ext_key = ?")
        .bind(owner)
        .bind(key)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn revision(pool: &SqlitePool, owner: &str) -> i64 {
    sqlx::query_scalar("SELECT revision FROM plan_meta WHERE owner_id = ?").bind(owner).fetch_optional(pool).await.unwrap().unwrap_or(0)
}

fn find<'a>(list: &'a Value, field: &str, value: &str) -> &'a Value {
    list.as_array().unwrap().iter().find(|x| x[field] == value).unwrap_or_else(|| panic!("no {field} = {value}"))
}

// ── import ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn an_import_creates_rows_under_the_owner() {
    let (app, pool, owner, token) = setup().await;
    let r = import(&app, &token, &doc()).await;
    assert_eq!(r["unchanged"], false);
    assert_eq!(r["dry_run"], false);
    assert_eq!(r["content_hash"], plan_hash(&doc()));
    assert_eq!(r["guide_version"], 6);
    assert_eq!(r["counts"]["decks"]["added"], 2);
    assert_eq!(r["counts"]["swaps"]["added"], 5);
    assert_eq!(r["counts"]["orders"]["added"], 2);
    assert_eq!(r["counts"]["stores"]["added"], 2);
    assert_eq!(r["counts"]["settings"], 2);
    assert_eq!(r["counts"]["quotes"], 3);
    assert_eq!(r["counts"]["states_new"], 6);
    assert_eq!(r["export_warnings"][0]["text"], "A warning from the writer");
    assert!(r["import_id"].is_string());

    for t in PLAN_TABLES.iter().filter(|t| !matches!(**t, "plan_reviews" | "plan_marks" | "plan_key_aliases")) {
        let foreign: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {t} WHERE owner_id != ?")))
            .bind(&owner)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(foreign, 0, "{t}");
        assert!(count(&pool, t).await > 0, "{t} is empty");
    }
    assert_eq!(revision(&pool, &owner).await, 1);

    // Links are stored by id and come back as keys.
    let b = bundle(&app, &token).await;
    let standin = find(&b["swaps"], "key", "standin|Alpha Deck|Stand Card");
    assert_eq!(standin["parent"], "plan|Alpha Deck|Print Card|Old Card");
    assert_eq!(standin["order_item"], json!({"order": "shop-1", "line": 2}));
    assert_eq!(standin["later_out"], "Sol Ring");
    assert_eq!(find(&b["swaps"], "key", "plan|Alpha Deck|Print Card|Old Card")["print_order"], "proxy-1");
    assert_eq!(find(&b["swaps"], "key", "plan|Alpha Deck|Bought Card|Cut Card")["upgrade"], json!({"id": "upgrade-001", "status": "ordered"}));
    let owned = find(&b["swaps"], "key", "alpha-owned");
    assert_eq!(owned["out"], Value::Null);
    assert_eq!(owned["got"]["how"], "deck");
    // Variant numbers become strings; set codes are stored in lower case.
    assert_eq!(find(&b["quotes"], "result", "In stock: TST #3 $0.75")["variant"], "42427719221416");
    let shop = find(&b["orders"], "key", "shop-1");
    assert_eq!(shop["items"][0]["set"], "tst");
    assert_eq!(shop["store"], "shop");
    assert_eq!(b["head"]["guide_version"], 6);
    assert_eq!(b["head"]["content_hash"], plan_hash(&doc()));
    assert_eq!(b["notes"][0]["text"], "A plan-wide question");
    assert_eq!(b["game_changers"]["checked_on"], "2026-10-09");
    let alpha = find(&b["decks"], "key", "alpha");
    assert_eq!(alpha["states"]["now"]["log"][0]["status"], "done");
    assert_eq!(alpha["states"]["stock"]["computed_by"], "commander-decks, guide v6");
    assert_eq!(alpha["notes"][0]["kind"], "open_question");
    assert_eq!(alpha["bracket"]["bags"]["2"][0]["in"], "Cut Card");
    assert_eq!(alpha["bracket"]["bags"]["2"][0]["got"]["origin"], "precon", "a bag's structured source reaches the pages");
    assert_eq!(b["settings"][1]["effective_from"], "2026-10-10");
    assert_eq!(find(&b["stores"], "key", "shop")["cart_url_template"], "https://example.com/cart/{items}");
}

#[tokio::test]
async fn the_same_content_is_unchanged_and_writes_nothing() {
    let (app, pool, owner, token) = setup().await;
    let first = import(&app, &token, &doc()).await;
    let before = snapshot(&pool).await;
    let again = import(&app, &token, &doc()).await;
    assert_eq!(again["unchanged"], true);
    assert_eq!(again["import_id"], first["import_id"], "the head's own report");
    assert_eq!(again["head_before"]["revision"], 1);
    assert_eq!(snapshot(&pool).await, before);
    assert_eq!(revision(&pool, &owner).await, 1);

    // A changed meta alone (new build time, new commit) is the same content.
    let mut d = doc();
    d["meta"]["generated_at"] = json!("2026-10-19T08:00:00Z");
    d["meta"]["git_sha"] = json!("def5678");
    d["meta"]["guide_version"] = json!(7);
    let r = import(&app, &token, &d).await;
    assert_eq!(r["unchanged"], true);
    assert_eq!(snapshot(&pool).await, before);

    // force=1 applies it anyway: a new import record and revision, no row changes.
    let (status, r) = post_bytes(&app, &token, "/api/plan/import?force=1", doc().to_string().into_bytes()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(r["unchanged"], false);
    assert_eq!(r["forced"], true);
    assert_eq!(r["counts"]["swaps"]["unchanged"], 5);
    assert_eq!(r["counts"]["states_new"], 0);
    assert_eq!(revision(&pool, &owner).await, 2);
}

#[tokio::test]
async fn a_changed_document_updates_rows_in_place() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let deck_id: String = sqlx::query_scalar("SELECT id FROM plan_decks WHERE key = 'alpha'").fetch_one(&pool).await.unwrap();
    let order_id: String = sqlx::query_scalar("SELECT id FROM plan_orders WHERE ext_key = 'shop-1'").fetch_one(&pool).await.unwrap();
    let item_id: String = sqlx::query_scalar("SELECT id FROM plan_order_items WHERE card_name = 'Bought Card'").fetch_one(&pool).await.unwrap();
    let (bought_id, _, bought_hash) = swap_row(&pool, &owner, "plan|Alpha Deck|Bought Card|Cut Card").await;
    let (print_id, _, print_hash) = swap_row(&pool, &owner, "plan|Alpha Deck|Print Card|Old Card").await;

    let mut d = doc();
    swap_mut(&mut d, "plan|Alpha Deck|Bought Card|Cut Card")["why"] = json!("A clearer reason");
    d["plan"]["orders"][0]["subtotal"] = json!(1.75);
    d["plan"]["orders"][0]["items"][0]["unit_price"] = json!(0.75);
    let r = import(&app, &token, &d).await;
    assert_eq!(r["unchanged"], false);
    assert_eq!(r["counts"]["swaps"], json!({"added": 0, "changed": 1, "unchanged": 4, "retired": 0, "restored": 0}));
    assert_eq!(r["counts"]["orders"]["changed"], 1);
    assert_eq!(r["counts"]["orders"]["unchanged"], 1);
    assert_eq!(r["counts"]["decks"]["unchanged"], 2);
    assert_eq!(r["counts"]["states_new"], 0);

    let still: String = sqlx::query_scalar("SELECT id FROM plan_decks WHERE key = 'alpha'").fetch_one(&pool).await.unwrap();
    assert_eq!(still, deck_id);
    let still: String = sqlx::query_scalar("SELECT id FROM plan_orders WHERE ext_key = 'shop-1'").fetch_one(&pool).await.unwrap();
    assert_eq!(still, order_id);
    let (still_item, price): (String, Option<f64>) =
        sqlx::query_as("SELECT id, unit_price FROM plan_order_items WHERE card_name = 'Bought Card'").fetch_one(&pool).await.unwrap();
    assert_eq!((still_item, price), (item_id.clone(), Some(0.75)));
    let (still_bought, _, new_hash) = swap_row(&pool, &owner, "plan|Alpha Deck|Bought Card|Cut Card").await;
    assert_eq!(still_bought, bought_id);
    assert_ne!(new_hash, bought_hash);
    assert_eq!(swap_row(&pool, &owner, "plan|Alpha Deck|Print Card|Old Card").await, (print_id, None, print_hash));
    // The swap still points at the same order item.
    let linked: Option<String> = sqlx::query_scalar("SELECT order_item_id FROM plan_swaps WHERE id = ?").bind(&bought_id).fetch_one(&pool).await.unwrap();
    assert_eq!(linked, Some(item_id));
    assert_eq!(revision(&pool, &owner).await, 2);

    // An order line that leaves the document goes, and the swap that pointed at it is unlinked.
    let mut d2 = d.clone();
    d2["plan"]["orders"][0]["items"].as_array_mut().unwrap().truncate(1);
    swap_mut(&mut d2, "standin|Alpha Deck|Stand Card")["order_item"] = Value::Null;
    import(&app, &token, &d2).await;
    let lines: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_order_items WHERE order_id = ?").bind(&order_id).fetch_one(&pool).await.unwrap();
    assert_eq!(lines, 1);
    let unlinked: Option<String> = sqlx::query_scalar("SELECT order_item_id FROM plan_swaps WHERE ext_key = 'standin|Alpha Deck|Stand Card'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(unlinked, None);
}

#[tokio::test]
async fn an_older_document_after_a_newer_one_applies() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let mut newer = doc();
    swap_mut(&mut newer, "alpha-idea")["why"] = json!("Changed");
    newer["meta"]["guide_version"] = json!(7);
    import(&app, &token, &newer).await;

    let r = import(&app, &token, &doc()).await;
    assert_eq!(r["unchanged"], false, "an old file is never silently skipped");
    assert_eq!(r["counts"]["swaps"]["changed"], 1);
    assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("guide v6; the plan already in Yama is guide v7")));
    assert_eq!(r["head_before"]["guide_version"], 7);
    assert_eq!(revision(&pool, &owner).await, 3);
    let head: String = sqlx::query_scalar("SELECT head_hash FROM plan_meta WHERE owner_id = ?").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!(head, plan_hash(&doc()));
    let why: String = sqlx::query_scalar("SELECT why FROM plan_swaps WHERE ext_key = 'alpha-idea'").fetch_one(&pool).await.unwrap();
    assert_eq!(why, "A test");
}

#[tokio::test]
async fn a_removed_swap_is_retired_and_restored_when_it_returns() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let (id, _, _) = swap_row(&pool, &owner, "alpha-owned").await;

    let mut d = doc();
    remove_swap(&mut d, "alpha-owned");
    let r = import(&app, &token, &d).await;
    assert_eq!(r["counts"]["swaps"]["retired"], 1);
    let (same, retired, _) = swap_row(&pool, &owner, "alpha-owned").await;
    assert_eq!(same, id);
    assert!(retired.is_some());
    let b = bundle(&app, &token).await;
    assert_eq!(find(&b["swaps"], "key", "alpha-owned")["retired"], true);

    let r = import(&app, &token, &doc()).await;
    assert_eq!(r["counts"]["swaps"]["restored"], 1);
    let (same, retired, _) = swap_row(&pool, &owner, "alpha-owned").await;
    assert_eq!((same, retired), (id, None));

    // Stores and orders retire the same way.
    let mut d = doc();
    d["plan"]["quotes"] = json!([]);
    d["plan"]["stores"].as_array_mut().unwrap().retain(|s| s["key"] != "shop");
    d["plan"]["orders"][0]["store"] = Value::Null;
    let r = import(&app, &token, &d).await;
    assert_eq!(r["counts"]["stores"]["retired"], 1);
    let r = import(&app, &token, &doc()).await;
    assert_eq!(r["counts"]["stores"]["restored"], 1);
}

#[tokio::test]
async fn a_new_list_makes_a_new_row_and_moves_current() {
    let (app, pool, _owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let current_now = || {
        sqlx::query_scalar::<_, String>(
            "SELECT s.id FROM plan_states s JOIN plan_decks d ON d.id = s.plan_deck_id WHERE d.key = 'alpha' AND s.state = 'now' AND s.current = 1",
        )
        .fetch_one(&pool)
    };
    let old_now = current_now().await.unwrap();

    let mut d = doc();
    d["plan"]["decks"][0]["states"]["now"]["cards"] = alpha_list("Old Card", "Bought Card");
    let r = import(&app, &token, &d).await;
    assert_eq!(r["counts"]["states_new"], 1);
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT s.id, s.current FROM plan_states s JOIN plan_decks d ON d.id = s.plan_deck_id
         WHERE d.key = 'alpha' AND s.state = 'now' ORDER BY s.current",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2, "the old list survives");
    assert_eq!(rows[0], (old_now.clone(), 0));
    assert_eq!(rows[1].1, 1);

    // Going back to the first list makes it current again; no third row.
    import(&app, &token, &doc()).await;
    assert_eq!(current_now().await.unwrap(), old_now);

    // Same cards with a new printing: the same list, its details refreshed in place.
    let mut d = doc();
    d["plan"]["decks"][0]["states"]["now"]["cards"][1]["set"] = json!("cmm");
    d["plan"]["decks"][0]["states"]["now"]["cards"][1]["num"] = json!(410);
    let r = import(&app, &token, &d).await;
    assert_eq!(r["counts"]["states_new"], 0);
    assert_eq!(r["counts"]["states_refreshed"], 1);
    let b = bundle(&app, &token).await;
    let alpha = find(&b["decks"], "key", "alpha");
    assert_eq!(alpha["states"]["now"]["id"], json!(old_now));
    assert_eq!(alpha["states"]["now"]["cards"][1]["num"], "410");

    // A state the document leaves out has no current list; its rows stay.
    let mut d = doc();
    d["plan"]["decks"][0]["states"].as_object_mut().unwrap().remove("after");
    import(&app, &token, &d).await;
    let b = bundle(&app, &token).await;
    assert_eq!(find(&b["decks"], "key", "alpha")["states"].get("after"), None);
    let afters: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_states WHERE state = 'after'").fetch_one(&pool).await.unwrap();
    assert_eq!(afters, 2);
}

#[tokio::test]
async fn a_missing_deck_is_archived_with_its_lists_kept() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let mut d = doc();
    d["plan"]["decks"].as_array_mut().unwrap().retain(|x| x["key"] != "beta");
    // alpha-owned's got names beta, which may be a deck outside the file: a warning, not an error.
    let r = import(&app, &token, &d).await;
    assert_eq!(r["counts"]["decks"]["retired"], 1);
    assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("got names deck \"beta\"")));
    let status: String = sqlx::query_scalar("SELECT status FROM plan_decks WHERE owner_id = ? AND key = 'beta'").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "archived");
    let lists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_states s JOIN plan_decks d ON d.id = s.plan_deck_id WHERE d.key = 'beta'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(lists, 3);
    let b = bundle(&app, &token).await;
    assert_eq!(find(&b["decks"], "key", "beta")["status"], "archived");

    let r = import(&app, &token, &doc()).await;
    assert_eq!(r["counts"]["decks"]["restored"], 1);
    let status: String = sqlx::query_scalar("SELECT status FROM plan_decks WHERE owner_id = ? AND key = 'beta'").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "proposals_only");
}

async fn yama_answer(pool: &SqlitePool, owner: &str, key: &str, decision: Option<&str>, at: &str) {
    sqlx::query(
        "INSERT INTO plan_reviews (owner_id, swap_key, decision, note, cut, deck_name, card, at, origin, op_id)
         VALUES (?, ?, ?, NULL, NULL, 'Alpha Deck', 'Some card', ?, 'yama', 'op-1')",
    )
    .bind(owner)
    .bind(key)
    .bind(decision)
    .bind(at)
    .execute(pool)
    .await
    .unwrap();
}

async fn answer(pool: &SqlitePool, owner: &str, key: &str) -> (Option<String>, String, String) {
    sqlx::query_as("SELECT decision, at, origin FROM plan_reviews WHERE owner_id = ? AND swap_key = ?")
        .bind(owner)
        .bind(key)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn reviews_merge_newest_wins_and_aliases_carry_answers() {
    let (app, pool, owner, token) = setup().await;
    yama_answer(&pool, &owner, "alpha-idea", Some("no"), "2026-10-19T02:00:00Z").await;
    yama_answer(&pool, &owner, "plan|Alpha Deck|Bought Card|Cut Card", None, "2026-10-19T03:00:00Z").await; // a clear
    yama_answer(&pool, &owner, "alpha-owned", Some("unsure"), "2026-10-19T01:00:00Z").await;
    yama_answer(&pool, &owner, "plan|Alpha Deck|Print Card|Old Card", Some("want"), "2026-10-19T01:00:00Z").await;
    yama_answer(&pool, &owner, "plan|Alpha Deck|Stand Card|Old Name", Some("want"), "2026-10-19T01:00:00Z").await;

    let mut d = doc();
    d["plan"]["reviews"] = json!({
        // Older than the Yama answer: Yama's stays.
        "alpha-idea": {"decision": "want", "note": "", "cut": null, "deck": "Alpha Deck", "card": "Proposal Card", "at": "2026-10-19T01:00:00Z"},
        // Older than Yama's clear: the clear stays, so a stale file can't bring the answer back.
        "plan|Alpha Deck|Bought Card|Cut Card": {"decision": "want", "at": "2026-10-19T02:30:00Z"},
        // Newer, written with an offset: the document's wins, stored in UTC.
        "alpha-owned": {"decision": "want", "cut": "Sol Ring", "at": "2026-10-18T22:00:00-05:00"},
        // A tie goes to the answer made in Yama.
        "plan|Alpha Deck|Print Card|Old Card": {"decision": "no", "at": "2026-10-19T01:00:00Z"},
        // A key Yama has never seen.
        "plan|Beta Deck|Gone|Card": {"decision": "unsure", "deck": "Beta Deck", "card": "Gone", "at": "2026-10-19T01:00:00Z"}
    });
    // The stand-in used to be keyed by an old in/out; its row says so.
    swap_mut(&mut d, "standin|Alpha Deck|Stand Card")["was"] = json!(["plan|Alpha Deck|Stand Card|Old Name"]);
    let r = import(&app, &token, &d).await;
    assert_eq!(r["reviews"], json!({"from_document_applied": 2, "yama_newer_kept": 3}));

    assert_eq!(answer(&pool, &owner, "alpha-idea").await, (Some("no".into()), "2026-10-19T02:00:00Z".into(), "yama".into()));
    assert_eq!(answer(&pool, &owner, "plan|Alpha Deck|Bought Card|Cut Card").await.0, None);
    assert_eq!(answer(&pool, &owner, "alpha-owned").await, (Some("want".into()), "2026-10-19T03:00:00Z".into(), "import".into()));
    assert_eq!(answer(&pool, &owner, "plan|Alpha Deck|Print Card|Old Card").await.0, Some("want".into()));

    // The alias carries the old key's answer to the stand-in; only the unknown key is an orphan.
    let orphans: Vec<&str> = r["orphan_answers"].as_array().unwrap().iter().map(|o| o["swap_key"].as_str().unwrap()).collect();
    assert_eq!(orphans, vec!["plan|Beta Deck|Gone|Card"]);
    let b = bundle(&app, &token).await;
    assert_eq!(b["aliases"]["plan|Alpha Deck|Stand Card|Old Name"], "standin|Alpha Deck|Stand Card");
    assert_eq!(b["reviews"]["alpha-owned"]["cut"], "Sol Ring");

    // A promoted proposal: from_candidate carries the "want" on the candidate id to the new row.
    let mut d = doc();
    remove_swap(&mut d, "alpha-owned");
    let promoted = json!({"key": "plan|Alpha Deck|Spare Card|Sol Ring", "deck": "alpha", "stage": "planned", "src": "owned",
                          "out": "Sol Ring", "in": "Spare Card", "from_candidate": "alpha-owned",
                          "got": {"how": "pulled", "product": "A booster", "date": null}});
    d["plan"]["swaps"].as_array_mut().unwrap().push(promoted);
    let r = import(&app, &token, &d).await;
    assert!(!r["orphan_answers"].as_array().unwrap().iter().any(|o| o["swap_key"] == "alpha-owned"), "{}", r["orphan_answers"]);

    // A deck rename: its old name turns every key that contains it into an alias.
    let mut d = doc();
    d["plan"]["decks"][0]["name"] = json!("Alpha Renamed");
    d["plan"]["decks"][0]["was"] = json!(["Alpha Deck"]);
    for s in d["plan"]["swaps"].as_array_mut().unwrap() {
        let k = s["key"].as_str().unwrap().replace("|Alpha Deck|", "|Alpha Renamed|");
        s["key"] = json!(k);
        if let Some(p) = s["parent"].as_str().map(|p| p.replace("|Alpha Deck|", "|Alpha Renamed|")) {
            s["parent"] = json!(p);
        }
    }
    let r = import(&app, &token, &d).await;
    let orphans: Vec<&str> = r["orphan_answers"].as_array().unwrap().iter().map(|o| o["swap_key"].as_str().unwrap()).collect();
    assert_eq!(orphans, vec!["plan|Beta Deck|Gone|Card"]);
    let b = bundle(&app, &token).await;
    assert_eq!(b["aliases"]["plan|Alpha Deck|Print Card|Old Card"], "plan|Alpha Renamed|Print Card|Old Card");
}

/// An answer cleared on commander-decks' review site arrives as a tombstone, which replaces the older
/// imported "want". A later file without the key, or with the old "want", doesn't bring it back.
#[tokio::test]
async fn an_imported_tombstone_replaces_an_older_imported_answer() {
    let (app, pool, owner, token) = setup().await;
    let key = "plan|Alpha Deck|Bought Card|Cut Card";
    let want = json!({"decision": "want", "note": "", "cut": null, "deck": "Alpha Deck", "card": "Bought Card", "at": "2026-10-19T01:00:00Z"});
    let mut d = doc();
    d["plan"]["reviews"] = json!({key: want});
    import(&app, &token, &d).await;
    assert_eq!(answer(&pool, &owner, key).await, (Some("want".into()), "2026-10-19T01:00:00Z".into(), "import".into()));

    d["plan"]["reviews"] = json!({key: {"decision": null, "note": null, "cut": null, "deck": "Alpha Deck", "card": "Bought Card",
                                        "at": "2026-10-19T02:00:00Z"}});
    let r = import(&app, &token, &d).await;
    assert_eq!(r["reviews"], json!({"from_document_applied": 1, "yama_newer_kept": 0}));
    assert_eq!(answer(&pool, &owner, key).await, (None, "2026-10-19T02:00:00Z".into(), "import".into()));
    let (note, cut): (Option<String>, Option<String>) =
        sqlx::query_as("SELECT note, cut FROM plan_reviews WHERE owner_id = ? AND swap_key = ?").bind(&owner).bind(key).fetch_one(&pool).await.unwrap();
    assert_eq!((note, cut), (None, None));
    let b = bundle(&app, &token).await;
    assert_eq!(b["reviews"][key]["decision"], Value::Null);
    assert!(r["orphan_answers"].as_array().unwrap().is_empty(), "a tombstone isn't an answer: {}", r["orphan_answers"]);

    // A file without the key leaves the tombstone; a stale file with the old "want" can't undo it.
    d["plan"]["reviews"] = json!({});
    import(&app, &token, &d).await;
    d["plan"]["reviews"] = json!({key: want});
    let r = import(&app, &token, &d).await;
    assert_eq!(r["reviews"]["from_document_applied"], 0);
    assert_eq!(answer(&pool, &owner, key).await.0, None);
}

#[tokio::test]
async fn a_renamed_swap_without_an_alias_is_an_orphan_and_is_kept() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    yama_answer(&pool, &owner, "plan|Alpha Deck|Bought Card|Cut Card", Some("want"), "2026-10-19T01:00:00Z").await;
    sqlx::query("INSERT INTO plan_marks (owner_id, swap_key, kind, value, at, op_id) VALUES (?, ?, 'installed', 1, '2026-10-19T01:00:00Z', 'op-2')")
        .bind(&owner)
        .bind("plan|Alpha Deck|Bought Card|Cut Card")
        .execute(&pool)
        .await
        .unwrap();

    let mut d = doc();
    swap_mut(&mut d, "plan|Alpha Deck|Bought Card|Cut Card")["key"] = json!("plan|Alpha Deck|Bought Card|Other Cut");
    let r = import(&app, &token, &d).await;
    assert_eq!(r["counts"]["swaps"]["added"], 1);
    assert_eq!(r["counts"]["swaps"]["retired"], 1);
    let o = &r["orphan_answers"][0];
    assert_eq!(o["swap_key"], "plan|Alpha Deck|Bought Card|Cut Card");
    assert_eq!(o["decision"], "want");
    assert_eq!(o["marks"], json!(["installed"]));
    assert_eq!(answer(&pool, &owner, "plan|Alpha Deck|Bought Card|Cut Card").await.0, Some("want".into()));
}

#[tokio::test]
async fn unknown_names_and_printings_are_kept_and_reported() {
    let (app, pool, _owner, token) = setup().await;
    let r = import(&app, &token, &doc()).await;
    let unknown = r["unknown_cards"].as_array().unwrap();
    assert_eq!(unknown.len(), 1, "{unknown:?}");
    assert_eq!(unknown[0]["name"], "Unknown Future Card");
    assert!(unknown[0]["where"].as_array().unwrap().iter().any(|w| w == "Beta Deck: stock list"));
    let printings = r["unknown_printings"].as_array().unwrap();
    assert_eq!(printings.len(), 1, "{printings:?}");
    assert_eq!(
        (printings[0]["card"].as_str(), printings[0]["set"].as_str(), printings[0]["num"].as_str()),
        (Some("Stand Card"), Some("zzz"), Some("999"))
    );

    // Kept: the list still has the card by name, and the order item its printing.
    let cards: String = sqlx::query_scalar(
        "SELECT s.cards FROM plan_states s JOIN plan_decks d ON d.id = s.plan_deck_id WHERE d.key = 'beta' AND s.state = 'now'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(cards.contains("Unknown Future Card"));
    let set: String = sqlx::query_scalar("SELECT set_code FROM plan_order_items WHERE card_name = 'Stand Card'").fetch_one(&pool).await.unwrap();
    assert_eq!(set, "zzz");

    let b = bundle(&app, &token).await;
    assert_eq!(find(&b["decks"], "key", "beta")["states"]["now"]["unresolved"], json!(["Unknown Future Card"]));
    assert_eq!(b["unresolved"], json!(["Unknown Future Card"]));
    assert_eq!(b["names"]["Sol Ring"], "o-sol");
    assert_eq!(b["cards"]["o-sol"]["name"], "Sol Ring");
}

#[tokio::test]
async fn a_bracket_box_and_extras_reach_the_pages_and_are_optional() {
    let (app, _pool, _owner, token) = setup().await;
    // Without them (the fixture has neither), the bracket comes back as it was sent.
    import(&app, &token, &doc()).await;
    let b = bundle(&app, &token).await;
    let alpha = find(&b["decks"], "key", "alpha");
    assert_eq!(alpha["bracket"]["target"], 3);
    assert!(alpha["bracket"].get("box").is_none() && alpha["bracket"].get("extras").is_none());

    let mut d = doc();
    d["plan"]["decks"][0]["bracket"]["box"] = json!(2);
    d["plan"]["decks"][0]["bracket"]["extras"] = json!(["Sol Ring", "Extra Future Card"]);
    let r = import(&app, &token, &d).await;
    let unknown = r["unknown_cards"].as_array().unwrap();
    let extra = unknown.iter().find(|u| u["name"] == "Extra Future Card").expect("an unknown extra is reported");
    assert!(extra["where"].as_array().unwrap().iter().any(|w| w == "Alpha Deck: Bracket 4 extras"), "{extra}");
    let b = bundle(&app, &token).await;
    let alpha = find(&b["decks"], "key", "alpha");
    assert_eq!(alpha["bracket"]["box"], 2);
    assert_eq!(alpha["bracket"]["extras"], json!(["Sol Ring", "Extra Future Card"]));
    assert_eq!(b["names"]["Sol Ring"], "o-sol");
    assert!(b["unresolved"].as_array().unwrap().iter().any(|n| n == "Extra Future Card"), "extras are resolved like other plan names");
}

#[tokio::test]
async fn a_card_added_later_resolves_without_a_new_import() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let first = bundle(&app, &token).await;
    let rev = first["rev"].as_str().unwrap().to_string();
    assert_eq!(first["unresolved"], json!(["Unknown Future Card"]));

    // Scryfall adds the card; the daily import brings it in.
    sqlx::query("INSERT INTO cards (oracle_id, name, type_line, color_identity, legalities, updated_at) VALUES ('o-future', 'Unknown Future Card', 'Creature', 'U', '{}', 'now')")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('Unknown Future Card', 'o-future')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO import_runs (id, kind, started_at, finished_at, rows) VALUES ('run-2', 'oracle_cards', '2026-11-13T20:00:00Z', '2026-11-13T20:05:00Z', 1)")
        .execute(&pool)
        .await
        .unwrap();

    let (status, b) = send(&app, Method::GET, &format!("/api/plan/bundle?rev={rev}"), Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_ne!(b["unchanged"], true, "the card import changes the cache key");
    assert_eq!(b["names"]["Unknown Future Card"], "o-future");
    assert_eq!(b["unresolved"], json!([]));
    assert_eq!(find(&b["decks"], "key", "beta")["states"]["stock"]["unresolved"], json!([]));
    assert_eq!(b["cards"]["o-future"]["name"], "Unknown Future Card");
    assert_eq!(count(&pool, "plan_imports").await, 1, "no new import");
    assert_eq!(revision(&pool, &owner).await, 1);
}

#[tokio::test]
async fn deck_checks_are_warnings() {
    let (app, _pool, _owner, token) = setup().await;
    let mut d = doc();
    // 99 cards; two copies of a non-basic and an off-color card in the after list.
    d["plan"]["decks"][0]["states"]["now"]["cards"][4] = forest(95);
    d["plan"]["decks"][0]["states"]["after"]["cards"] = json!([
        {"name": "Test Commander", "qty": 1, "board": "commander"},
        {"name": "Sol Ring", "qty": 2, "board": "main"}, slot("Red Card", "print"), forest(96)
    ]);
    // Two planned rows naming the same cut.
    swap_mut(&mut d, "plan|Alpha Deck|Bought Card|Cut Card")["later_out"] = json!("Sol Ring");
    // An unbought buy the writer turned into a print.
    swap_mut(&mut d, "plan|Alpha Deck|Print Card|Old Card")["src_declared"] = json!("buy");
    let r = import(&app, &token, &d).await;
    let warnings: Vec<&str> = r["warnings"].as_array().unwrap().iter().map(|w| w.as_str().unwrap()).collect();
    let has = |s: &str| warnings.iter().any(|w| w.contains(s));
    assert!(has("Alpha Deck: the now list has 99 cards, not 100"), "{warnings:?}");
    assert!(has("Alpha Deck: the after list has 2 copies of Sol Ring"), "{warnings:?}");
    assert!(has("Alpha Deck (after list): Red Card is outside the commander's color identity (R)"), "{warnings:?}");
    assert!(has("Alpha Deck: Sol Ring is claimed 2 times"), "{warnings:?}");
    assert!(has("the source data says buy; the export made it print"), "{warnings:?}");
    assert!(!warnings.iter().any(|w| w.starts_with("Beta Deck")), "a clean deck gets no deck warnings: {warnings:?}");
}

// ── refusals ───────────────────────────────────────────────────────────────

async fn refused(app: &Router, token: &str, d: &Value) -> (StatusCode, String) {
    let (status, body) = post_bytes(app, token, "/api/plan/import", d.to_string().into_bytes()).await;
    (status, body["error"].as_str().unwrap_or_default().to_string())
}

type Change = Box<dyn Fn(&mut Value)>;

#[tokio::test]
async fn bad_documents_get_400_naming_the_json_path() {
    let (app, pool, _owner, token) = setup().await;
    let empty = snapshot(&pool).await;
    let cases: Vec<(&str, Change)> = vec![
        ("format: expected \"yama-plan/1\"", Box::new(|d| d["format"] = json!("yama-plan/2"))),
        ("format: missing", Box::new(|d| drop(d.as_object_mut().unwrap().remove("format")))),
        ("plan: missing", Box::new(|d| drop(d.as_object_mut().unwrap().remove("plan")))),
        ("plan.swaps[0].deck: no deck \"gamma\"", Box::new(|d| d["plan"]["swaps"][0]["deck"] = json!("gamma"))),
        ("plan.swaps[1].parent: \"plan|Alpha Deck|Bought Card|Cut Card\" must be a print swap", Box::new(|d| d["plan"]["swaps"][1]["parent"] = json!("plan|Alpha Deck|Bought Card|Cut Card"))),
        ("plan.swaps[1].parent: a stand-in needs", Box::new(|d| d["plan"]["swaps"][1]["parent"] = Value::Null)),
        ("plan.swaps[1].parent:", Box::new(|d| d["plan"]["swaps"][1]["out"] = json!("Sol Ring"))),
        ("plan.swaps[4].got.how: unknown how \"found\"", Box::new(|d| d["plan"]["swaps"][4]["got"] = json!({"how": "found"}))),
        ("plan.swaps[4].got: an owned card needs got", Box::new(|d| d["plan"]["swaps"][4]["got"] = Value::Null)),
        ("plan.swaps[4].got: got needs how", Box::new(|d| d["plan"]["swaps"][4]["got"] = json!("Lorehold Spirit"))),
        ("plan.swaps[4].got.origin:", Box::new(|d| d["plan"]["swaps"][4]["got"] = json!({"how": "deck", "deck": "beta"}))),
        ("plan.swaps[4].got.order: no order", Box::new(|d| d["plan"]["swaps"][4]["got"] = json!({"how": "bought", "order": "nope"}))),
        ("plan.swaps[4].got.product:", Box::new(|d| d["plan"]["swaps"][4]["got"] = json!({"how": "pulled"}))),
        ("plan.decks[0].bracket.bags.2[0].got.how: unknown how", Box::new(|d| d["plan"]["decks"][0]["bracket"]["bags"]["2"][0]["got"] = json!({"how": "found"}))),
        ("plan.decks[0].bracket.bags.2[0].got.order: no order", Box::new(|d| d["plan"]["decks"][0]["bracket"]["bags"]["2"][0]["got"] = json!({"how": "bought", "order": "nope"}))),
        ("plan.swaps[2].order_item.line:", Box::new(|d| d["plan"]["swaps"][2]["order_item"]["line"] = json!(9))),
        ("plan.swaps[0].print_order: no order", Box::new(|d| d["plan"]["swaps"][0]["print_order"] = json!("proxy-9"))),
        ("plan.swaps[4].key: \"alpha-idea\" appears twice", Box::new(|d| d["plan"]["swaps"][4]["key"] = json!("alpha-idea"))),
        ("plan.swaps[3].stage:", Box::new(|d| d["plan"]["swaps"][3]["stage"] = json!("maybe"))),
        ("plan.stores[0].cart_url_template:", Box::new(|d| d["plan"]["stores"][0]["cart_url_template"] = json!("http://example.com/cart/{items}"))),
        ("plan.stores[0].cart_url_template:", Box::new(|d| d["plan"]["stores"][0]["cart_url_template"] = json!("https://example.com/cart"))),
        ("plan.orders[0].items[0].unit_price:", Box::new(|d| d["plan"]["orders"][0]["items"][0]["unit_price"] = json!(-0.5))),
        ("plan.orders[0].tax:", Box::new(|d| d["plan"]["orders"][0]["tax"] = json!(-1))),
        ("plan.orders[0].subtotal: invalid type", Box::new(|d| d["plan"]["orders"][0]["subtotal"] = json!("1.50"))),
        ("plan.orders[0].date_ordered:", Box::new(|d| d["plan"]["orders"][0]["date_ordered"] = json!("10/08/2026"))),
        ("plan.orders[0].store: no store", Box::new(|d| d["plan"]["orders"][0]["store"] = json!("elsewhere"))),
        ("plan.quotes[2].checked:", Box::new(|d| d["plan"]["quotes"][2]["checked"] = Value::Null)),
        ("plan.quotes[2].source:", Box::new(|d| d["plan"]["quotes"][2]["source"] = Value::Null)),
        ("plan.quotes[0].price:", Box::new(|d| d["plan"]["quotes"][0]["price"] = json!(-2))),
        ("plan.quotes[0].swap: no swap", Box::new(|d| d["plan"]["quotes"][0]["swap"] = json!("gone"))),
        ("plan.settings[1].effective_from: 2026-10-08 appears twice", Box::new(|d| d["plan"]["settings"][1]["effective_from"] = json!("2026-10-08"))),
        ("plan.aliases[0].old: \"alpha-idea\" is a live key", Box::new(|d| d["plan"]["aliases"] = json!([{"old": "alpha-idea", "new": "alpha-owned"}]))),
        ("plan.swaps[4].from_candidate: \"alpha-idea\" is a live key", Box::new(|d| d["plan"]["swaps"][4]["from_candidate"] = json!("alpha-idea"))),
        ("plan.aliases: aliases form a cycle", Box::new(|d| d["plan"]["aliases"] = json!([{"old": "a", "new": "b"}, {"old": "b", "new": "a"}]))),
        ("plan.decks[0].states.now.cards[0].board:", Box::new(|d| d["plan"]["decks"][0]["states"]["now"]["cards"][0]["board"] = json!("side"))),
        ("plan.decks[0].states.later:", Box::new(|d| d["plan"]["decks"][0]["states"]["later"] = json!({"cards": []}))),
        ("plan.decks[0].states.now.cards[2].qty: invalid type", Box::new(|d| d["plan"]["decks"][0]["states"]["now"]["cards"][2]["qty"] = json!("one"))),
        ("plan.decks[1].key: \"alpha\" appears twice", Box::new(|d| d["plan"]["decks"][1]["key"] = json!("alpha"))),
        ("plan.decks[0].bracket.box: must be a bracket", Box::new(|d| d["plan"]["decks"][0]["bracket"]["box"] = json!(6))),
        ("plan.decks[0].bracket.box: must be a bracket", Box::new(|d| d["plan"]["decks"][0]["bracket"]["box"] = json!("2"))),
        ("plan.decks[0].bracket.extras: must be a list", Box::new(|d| d["plan"]["decks"][0]["bracket"]["extras"] = json!("Sol Ring"))),
        ("plan.decks[0].bracket.extras[1]: must be a card name", Box::new(|d| d["plan"]["decks"][0]["bracket"]["extras"] = json!(["Sol Ring", " "]))),
        ("plan.reviews[\"alpha-idea\"].at:", Box::new(|d| d["plan"]["reviews"] = json!({"alpha-idea": {"decision": "want", "at": "2026-10-19 01:00"}}))),
        ("plan.reviews[\"alpha-idea\"].decision:", Box::new(|d| d["plan"]["reviews"] = json!({"alpha-idea": {"decision": "maybe", "at": "2026-10-19T01:00:00Z"}}))),
    ];
    for (expected, change) in &cases {
        let mut d = doc();
        change(&mut d);
        let (status, error) = refused(&app, &token, &d).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{expected}: {error}");
        assert!(error.starts_with(expected), "expected {expected:?}, got {error:?}");
    }
    let (status, body) = post_bytes(&app, &token, "/api/plan/import", b"{not json".to_vec()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().starts_with("body: not a plan file"));
    assert_eq!(snapshot(&pool).await, empty, "nothing written");
}

#[tokio::test]
async fn an_oversized_body_gets_413_and_a_yama_deck_key_clash_gets_409() {
    let (app, pool, owner, token) = setup().await;
    let mut big = doc().to_string().into_bytes();
    big.extend(std::iter::repeat_n(b' ', super::IMPORT_LIMIT));
    let (status, _) = post_bytes(&app, &token, "/api/plan/import", big).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    sqlx::query(
        "INSERT INTO plan_decks (id, owner_id, key, name, source, commander, created_at, updated_at)
         VALUES ('mine', ?, 'alpha', 'My own Alpha', 'yama', '[\"Test Commander\"]', 'now', 'now')",
    )
    .bind(&owner)
    .execute(&pool)
    .await
    .unwrap();
    let (status, error) = refused(&app, &token, &doc()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(error.starts_with("plan.decks[0].key: \"alpha\" is a plan you made in Yama"), "{error}");
    assert_eq!(count(&pool, "plan_imports").await, 0);
    assert_eq!(count(&pool, "plan_swaps").await, 0);
}

#[tokio::test]
async fn a_dry_run_commits_nothing() {
    let (app, pool, owner, token) = setup().await;
    let before = snapshot(&pool).await;
    let (status, r) = post_bytes(&app, &token, "/api/plan/import?dry_run=1", doc().to_string().into_bytes()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(r["dry_run"], true);
    assert_eq!(r["import_id"], Value::Null);
    assert_eq!(r["counts"]["swaps"]["added"], 5);
    assert_eq!(r["unknown_cards"][0]["name"], "Unknown Future Card");
    assert_eq!(snapshot(&pool).await, before);
    assert_eq!(revision(&pool, &owner).await, 0);

    import(&app, &token, &doc()).await;
    let (_, r) = post_bytes(&app, &token, "/api/plan/import?dry_run=1", doc().to_string().into_bytes()).await;
    assert_eq!((r["dry_run"].clone(), r["unchanged"].clone()), (json!(true), json!(true)));
    let mut d = doc();
    remove_swap(&mut d, "alpha-owned");
    let after_import = snapshot(&pool).await;
    let (_, r) = post_bytes(&app, &token, "/api/plan/import?dry_run=1", d.to_string().into_bytes()).await;
    assert_eq!(r["counts"]["swaps"]["retired"], 1);
    assert_eq!(snapshot(&pool).await, after_import);
}

// ── isolation and prices ───────────────────────────────────────────────────

#[tokio::test]
async fn plans_are_per_user() {
    let (app, pool, a, token_a) = setup().await;
    let (b, token_b) = user(&pool, "friend@example.com").await;
    import(&app, &token_a, &doc()).await;

    // B sees nothing of A's plan.
    let bb = bundle(&app, &token_b).await;
    assert_eq!(bb["revision"], 0);
    assert_eq!(bb["head"], Value::Null);
    for section in ["decks", "swaps", "orders", "quotes", "settings", "stores"] {
        assert_eq!(bb[section], json!([]), "{section}");
    }
    assert_eq!(bb["reviews"], json!({}));
    assert!(matches!(super::plan_deck(&pool, &b, "alpha").await, Err(AppError::NotFound("plan deck"))));
    assert!(super::plan_deck(&pool, &a, "alpha").await.is_ok());
    let (status, head) = send(&app, Method::GET, "/api/plan/head", Some(&token_b), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(head["head_hash"], Value::Null);
    let (_, imports) = send(&app, Method::GET, "/api/plan/imports", Some(&token_b), None).await;
    assert_eq!(imports, json!([]));

    // B imports the same document: the same keys, B's own rows.
    let r = import(&app, &token_b, &doc()).await;
    assert_eq!(r["counts"]["decks"]["added"], 2, "keys are per owner");
    let ids: Vec<(String, String)> = sqlx::query_as("SELECT owner_id, id FROM plan_decks WHERE key = 'alpha' ORDER BY owner_id").fetch_all(&pool).await.unwrap();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0].1, ids[1].1);
    assert_eq!(revision(&pool, &a).await, 1);
    let ba = bundle(&app, &token_a).await;
    let bb = bundle(&app, &token_b).await;
    assert_ne!(ba["decks"][0]["states"]["now"]["id"], bb["decks"][0]["states"]["now"]["id"]);

    // Both are at revision 1 with the same card data, but A's cache key is never current for B,
    // so a phone still holding A's bundle after a sign-out gets B's.
    assert_eq!(bb["revision"], 1);
    assert_ne!(ba["rev"], bb["rev"]);
    let (_, with_a_rev) = send(&app, Method::GET, &format!("/api/plan/bundle?rev={}", ba["rev"].as_str().unwrap()), Some(&token_b), None).await;
    assert_eq!(with_a_rev["rev"], bb["rev"]);
    assert_eq!(with_a_rev["decks"][0]["states"]["now"]["id"], bb["decks"][0]["states"]["now"]["id"]);

    // The database itself refuses a link from B's row to A's deck.
    let a_deck: String = sqlx::query_scalar("SELECT id FROM plan_decks WHERE owner_id = ? AND key = 'alpha'").bind(&a).fetch_one(&pool).await.unwrap();
    let cross = sqlx::query(
        "INSERT INTO plan_states (id, owner_id, plan_deck_id, state, content_hash, cards, computed_by, created_at, updated_at)
         VALUES ('x', ?, ?, 'stock', 'h', '[]', 'test', 'now', 'now')",
    )
    .bind(&b)
    .bind(&a_deck)
    .execute(&pool)
    .await;
    assert!(cross.is_err(), "the composite foreign key refuses a cross-owner link");

    // Signed out, every planner route is a 401.
    for (method, path) in [(Method::GET, "/api/plan/bundle"), (Method::GET, "/api/plan/head"), (Method::GET, "/api/plan/imports"), (Method::POST, "/api/plan/import")] {
        let (status, _) = send(&app, method.clone(), path, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
}

/// The fields commander-decks' exporter writes beyond the format (checked against the real file on
/// 2026-10-19): accepted, ignored where Yama has no use for them, and the format's own fields kept.
#[tokio::test]
async fn the_commander_decks_exporters_extra_fields_import_cleanly() {
    let (app, _pool, _owner, token) = setup().await;
    let mut d = doc();
    let p = &mut d["plan"];
    p["upgrades"] = json!([{"id": "upgrade-001", "deck": "alpha", "deck_name": "Alpha Deck", "add": "Bought Card",
                            "cut": "Cut Card", "status": "ordered", "acquisition": null, "swap": "plan|Alpha Deck|Bought Card|Cut Card"}]);
    p["library"] = json!({"bought": [{"order": "shop-1", "line": 1, "card": "Bought Card", "deck": "alpha", "replaces": "Cut Card",
                                      "set": "tst", "num": "2", "scan": "ok", "scanned": {"set": "tst", "num": "2"}, "arrived": true}],
                          "scan": {"file": "data/collection/mythic-tools-export-2026-10-18.csv", "date": "2026-10-18",
                                   "to_check": [], "missing": [], "fine": []},
                          "extra": [{"card": "Forest", "set": "tst", "num": "9", "finish": "nonfoil", "container": "bulk", "qty": 2}],
                          "precon_lists_fetched": "2026-10-18"});
    p["settings"][0]["source"] = json!("notes/decisions.md");
    p["stores"][0]["aliases"] = json!(["Example Games (Austin)"]);
    p["decks"][0]["stock_source"] = json!("https://example.com/list");
    p["decks"][0]["groups"] = json!([{"label": "Core", "bracket": null, "note": null}]);
    p["decks"][0]["bracket"]["game_changers"] = json!({"4": ["Sol Ring"], "3": [], "2": []});
    p["decks"][0]["bracket"]["game_changers_checked"] = json!("2026-10-09");
    p["decks"][0]["states"]["now"]["cards"][3] = json!({
        "name": "Bought Card", "qty": 1, "board": "main", "kind": "bought", "set": "tst", "num": "2", "scryfall_id": null,
        "replaces": "Cut Card", "swap": "plan|Alpha Deck|Bought Card|Cut Card", "got": null, "from_deck": null,
        "order_item": {"order": "shop-1", "line": 1}, "print_order": null, "note": null, "source": "Bought at Example Games"});
    let s = swap_mut(&mut d, "alpha-owned");
    s["got_text"] = json!("From Beta Deck (came in that precon).");
    s["standin"] = Value::Null;
    let o = &mut d["plan"]["orders"][0];
    o["item_count"] = json!(2);
    o["items"][0]["scan"] = json!([{"set": "tst", "num": "2", "finish": "nonfoil", "scryfall_id": "p-bought", "box": "bulk",
                                    "matches_listing": true, "difference": null}]);
    o["items"][1]["scan"] = json!([]);

    let r = import(&app, &token, &d).await;
    assert_eq!(r["counts"]["swaps"]["added"], 5);
    assert_eq!(r["unknown_cards"].as_array().unwrap().len(), 1, "only Beta's future card: {r}");
    let b = bundle(&app, &token).await;
    let alpha = find(&b["decks"], "key", "alpha");
    assert_eq!(alpha["groups"], json!([{"label": "Core", "bracket": null, "note": null}]));
    let bought = find(&alpha["states"]["now"]["cards"], "name", "Bought Card");
    assert_eq!(bought["swap"], "plan|Alpha Deck|Bought Card|Cut Card");
    assert_eq!(bought["order_item"], json!({"order": "shop-1", "line": 1}));
    assert_eq!(b["library"]["scan"]["date"], "2026-10-18");
    assert_eq!(b["library"]["bought"][0]["scan"], "ok");
    assert_eq!(find(&b["swaps"], "key", "alpha-owned")["got"]["deck"], "beta");
    assert_eq!(b["game_changers"]["checked_on"], "2026-10-09");
}

#[tokio::test]
async fn missing_prices_stay_null_and_nothing_writes_price_snapshots() {
    let (app, pool, _owner, token) = setup().await;
    let snapshots = count(&pool, "price_snapshots").await;
    import(&app, &token, &doc()).await;
    let b = bundle(&app, &token).await;
    assert_eq!(count(&pool, "price_snapshots").await, snapshots);

    let shop = find(&b["orders"], "key", "shop-1");
    assert_eq!(shop["tax"], Value::Null);
    assert_eq!(shop["total"], Value::Null);
    assert_eq!(shop["shipping"], json!(0.0));
    assert_eq!(shop["items"][1]["unit_price"], Value::Null);
    assert_eq!(find(&b["orders"], "key", "proxy-1")["subtotal"], Value::Null);
    let out_of_stock = find(&b["quotes"], "result", "Out of stock");
    assert_eq!(out_of_stock["price"], Value::Null);
    assert_eq!(out_of_stock["checked"], "2026-10-18");

    // No snapshot at all: no market price and no date.
    assert_eq!(b["market"]["o-bought"], Value::Null);
    assert_eq!(
        b["market_by_printing"]["p-bought"],
        json!({"usd": null, "usd_foil": null, "date": null, "set": "tst", "num": "2", "source": "TCGplayer market via Scryfall"})
    );
    assert_eq!(b["printing_ids"]["tst/2"], "p-bought");
    // The cheapest current non-foil price, not the cheaper one last priced in June.
    let m = &b["market"]["o-prop"];
    assert_eq!((m["usd"].clone(), m["date"].clone(), m["scryfall_id"].clone()), (json!(0.6), json!("2026-10-18"), json!("p-prop")));
    assert_eq!(m["printing"], "Test Set (TST) #3");
    assert_eq!(m["source"], "TCGplayer market via Scryfall, cheapest non-foil");
    assert_eq!(b["prices_as_of"], "2026-10-18");
}

/// "Cheapest non-foil" is a real card's price, as in commander-decks' benchmarks: Counterspell is
/// $2.15 for Foundations Commander #61 on 2026-10-18, not a cheaper gold-bordered, square-cornered,
/// 30th Anniversary or oversized copy. A card priced only in such printings has no market price.
#[tokio::test]
async fn the_market_price_counts_only_real_paper_cards() {
    let (app, pool, _owner, token) = setup().await;
    for (oid, name) in [("o-cs", "Counterspell"), ("o-gold", "Gold Only")] {
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, color_identity, updated_at) VALUES (?, ?, 'Instant', 'U', 'now')")
            .bind(oid)
            .bind(name)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(oid).execute(&pool).await.unwrap();
    }
    for (sid, oid, set, set_name, num, usd) in [
        ("p-cs-fdc", "o-cs", "fdc", "Foundations Commander", "61", 2.15),
        ("p-cs-wc", "o-cs", "wc00", "World Championship Decks 2000", "tvdl61b", 1.34),
        ("p-cs-ptc", "o-cs", "ptc", "Pro Tour Collector Set", "bl61", 1.2),
        ("p-cs-ced", "o-cs", "ced", "Collectors' Edition", "55", 1.0),
        ("p-cs-cei", "o-cs", "cei", "Intl. Collectors' Edition", "55", 0.95),
        ("p-cs-30a", "o-cs", "30a", "30th Anniversary Edition", "55", 0.9),
        ("p-cs-big", "o-cs", "oc13", "Commander 2013 Oversized", "5", 0.5),
        ("p-cs-disp", "o-cs", "oc21", "Commander 2021 Display Commanders", "2", 0.4),
        ("p-cs-vnt", "o-cs", "ovnt", "Vintage Championship", "2003", 0.3),
        ("p-gold", "o-gold", "wc99", "World Championship Decks 1999", "kb1", 3.0),
    ] {
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at)
             VALUES (?, ?, 'x', ?, ?, ?, 'en', 'now')",
        )
        .bind(sid)
        .bind(oid)
        .bind(set)
        .bind(set_name)
        .bind(num)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES (?, '2026-10-18', ?)").bind(sid).bind(usd).execute(&pool).await.unwrap();
    }

    let mut d = doc();
    swap_mut(&mut d, "alpha-idea")["in"] = json!("Counterspell");
    import(&app, &token, &d).await;
    let b = bundle(&app, &token).await;
    let m = &b["market"]["o-cs"];
    assert_eq!((m["usd"].clone(), m["set"].clone(), m["date"].clone()), (json!(2.15), json!("fdc"), json!("2026-10-18")), "{m}");
    assert_eq!(m["printing"], "Foundations Commander (FDC) #61");

    swap_mut(&mut d, "alpha-idea")["in"] = json!("Gold Only");
    import(&app, &token, &d).await;
    let b = bundle(&app, &token).await;
    assert_eq!(b["market"]["o-gold"], Value::Null, "{}", b["market"]["o-gold"]);
}

#[tokio::test]
async fn the_bundle_cache_key_follows_price_imports() {
    let (app, pool, _owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let b = bundle(&app, &token).await;
    let rev = b["rev"].as_str().unwrap().to_string();
    assert!(rev.starts_with("1-20261018200910-"), "{rev}");
    let (_, same) = send(&app, Method::GET, &format!("/api/plan/bundle?rev={rev}"), Some(&token), None).await;
    assert_eq!(same, json!({"unchanged": true, "rev": rev}));

    // The next day's price import.
    sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES ('p-prop', '2026-10-19', 0.7)").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO import_runs (id, kind, started_at, finished_at, rows) VALUES ('run-3', 'default_cards', '2026-10-19T20:00:00Z', '2026-10-19T20:09:00Z', 1)")
        .execute(&pool)
        .await
        .unwrap();
    let (_, fresh) = send(&app, Method::GET, &format!("/api/plan/bundle?rev={rev}"), Some(&token), None).await;
    assert_ne!(fresh["rev"], json!(rev));
    assert_eq!(fresh["market"]["o-prop"]["usd"], 0.7);
    assert_eq!(fresh["market"]["o-prop"]["date"], "2026-10-19");
    assert_eq!(fresh["prices_as_of"], "2026-10-19");

    // An import moves it too.
    let mut d = doc();
    swap_mut(&mut d, "alpha-idea")["why"] = json!("Changed");
    import(&app, &token, &d).await;
    let again = bundle(&app, &token).await;
    assert!(again["rev"].as_str().unwrap().starts_with("2-"));
}

// ── routes and the CLI ─────────────────────────────────────────────────────

#[tokio::test]
async fn head_and_imports_report_what_was_imported() {
    let (app, _pool, _owner, token) = setup().await;
    let (_, head) = send(&app, Method::GET, "/api/plan/head", Some(&token), None).await;
    assert_eq!(head, json!({"head_hash": null, "git_sha": null, "guide_version": null, "imported_at": null, "revision": 0}));
    let r = import(&app, &token, &doc()).await;
    let (_, head) = send(&app, Method::GET, "/api/plan/head", Some(&token), None).await;
    assert_eq!(head["head_hash"], plan_hash(&doc()));
    assert_eq!(head["git_sha"], "abc1234");
    assert_eq!(head["guide_version"], 6);
    assert_eq!(head["revision"], 1);
    let (_, imports) = send(&app, Method::GET, "/api/plan/imports", Some(&token), None).await;
    assert_eq!(imports.as_array().unwrap().len(), 1);
    assert_eq!(imports[0]["id"], r["import_id"]);
    assert_eq!(imports[0]["via"], "web");
    assert_eq!(imports[0]["meta"]["generated_at"], "2026-10-18T21:30:00Z");
    assert_eq!(imports[0]["report"]["counts"]["swaps"]["added"], 5);
}

#[tokio::test]
async fn only_the_newest_ten_uploads_keep_their_document() {
    let (app, pool, _owner, token) = setup().await;
    for i in 0..12 {
        let mut d = doc();
        swap_mut(&mut d, "alpha-idea")["why"] = json!(format!("Version {i}"));
        import(&app, &token, &d).await;
    }
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_imports WHERE document_gz IS NOT NULL").fetch_one(&pool).await.unwrap();
    assert_eq!((count(&pool, "plan_imports").await, kept), (12, 10));
    // The kept document is the upload, byte for byte.
    let gz: Vec<u8> = sqlx::query_scalar("SELECT document_gz FROM plan_imports ORDER BY imported_at DESC, rowid DESC LIMIT 1").fetch_one(&pool).await.unwrap();
    let mut text = String::new();
    std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(gz.as_slice()), &mut text).unwrap();
    let mut last = doc();
    swap_mut(&mut last, "alpha-idea")["why"] = json!("Version 11");
    assert_eq!(text, last.to_string());
}

#[tokio::test]
async fn the_cli_uses_the_same_import() {
    let pool = crate::db::test_pool().await;
    seed_cards(&pool).await;
    let (owner, _) = user(&pool, "bryan@example.com").await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("yama-plan.json");
    std::fs::write(&path, doc().to_string()).unwrap();

    let r = import::import_file(&pool, &path, "bryan@example.com", true, false).await.unwrap();
    assert!(r.dry_run);
    assert_eq!(count(&pool, "plan_swaps").await, 0);

    let r = import::import_file(&pool, &path, "BRYAN@example.com", false, false).await.unwrap();
    assert_eq!(r.counts.swaps.added, 5);
    let via: String = sqlx::query_scalar("SELECT via FROM plan_imports WHERE owner_id = ?").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!(via, "cli");
    let r = import::import_file(&pool, &path, "bryan@example.com", false, false).await.unwrap();
    assert!(r.unchanged);

    assert!(import::import_file(&pool, &path, "nobody@example.com", false, false).await.is_err());
    std::fs::write(&path, "{\"format\": \"other\"}").unwrap();
    let err = import::import_file(&pool, &path, "bryan@example.com", false, false).await.unwrap_err();
    assert!(err.to_string().starts_with("format:"), "{err}");
}

// ── installed state from the deck, and Review order (2026-10-28) ───────────

fn card(oracle_id: &str, name: &str, qty: i64, board: crate::decks::Board) -> crate::decks::DeckCard {
    crate::decks::DeckCard { oracle_id: oracle_id.into(), name: name.into(), qty, board }
}

/// Alpha Deck's list with `third` and `fourth` in its two swap slots.
fn alpha_deck(third: (&str, &str), fourth: (&str, &str)) -> Vec<crate::decks::DeckCard> {
    use crate::decks::Board::{Commander, Main};
    vec![
        card("o-cmd", "Test Commander", 1, Commander),
        card("o-sol", "Sol Ring", 1, Main),
        card(third.0, third.1, 1, Main),
        card(fourth.0, fourth.1, 1, Main),
        card("o-forest", "Forest", 96, Main),
    ]
}

fn swap_of<'a>(b: &'a Value, key: &str) -> &'a Value {
    find(&b["swaps"], "key", key)
}

#[tokio::test]
async fn installed_is_read_from_the_decks_current_list() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let print = "plan|Alpha Deck|Print Card|Old Card";
    let bought = "plan|Alpha Deck|Bought Card|Cut Card";
    let stand = "standin|Alpha Deck|Stand Card";

    // No Yama deck yet: nothing is derived, so the ticks and the plan's record still decide.
    let b = bundle(&app, &token).await;
    assert!(swap_of(&b, bought)["deck_installed"].is_null());
    assert!(find(&b["decks"], "key", "alpha")["yama_deck"].is_null());

    // A main deck with the plan deck's name holding the "now" list: the bought swap and the
    // stand-in are in, the print isn't. Proposals are never judged.
    let main = crate::decks::create_deck_with_cards(&pool, &owner, "Alpha Deck", None, alpha_deck(("o-stand", "Stand Card"), ("o-bought", "Bought Card"))).await.unwrap();
    let b = bundle(&app, &token).await;
    assert_eq!(swap_of(&b, bought)["deck_installed"], true);
    assert_eq!(swap_of(&b, stand)["deck_installed"], true);
    assert_eq!(swap_of(&b, print)["deck_installed"], false);
    assert!(swap_of(&b, "alpha-idea")["deck_installed"].is_null());
    let yd = &find(&b["decks"], "key", "alpha")["yama_deck"];
    assert_eq!(yd["id"], main.as_str());
    assert_eq!(yd["linked"], false);

    // A stock configuration, linked to the plan: the plan still reads the main deck, the list in the box.
    let (status, made) = send(&app, Method::POST, &format!("/api/decks/{main}/configurations"), Some(&token), Some(json!({"configuration": "stock", "op_id": "cfg-1"}))).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let stock = made["id"].as_str().unwrap().to_string();
    crate::decks::insert_version(&pool, &stock, &alpha_deck(("o-old", "Old Card"), ("o-cut", "Cut Card")), Some("stock")).await.unwrap();
    let (status, _) = send(&app, Method::PATCH, "/api/plan/decks/alpha", Some(&token), Some(json!({"deck_id": stock}))).await;
    assert_eq!(status, StatusCode::OK);
    let b = bundle(&app, &token).await;
    let yd = &find(&b["decks"], "key", "alpha")["yama_deck"];
    assert_eq!(yd["id"], main.as_str());
    assert_eq!(yd["linked"], true);
    assert_eq!(swap_of(&b, bought)["deck_installed"], true);

    // Putting the stock list in the main deck takes every swap out, and the bundle key moves.
    let rev_before = b["rev"].clone();
    let (status, used) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&token), Some(json!({"from": stock, "op_id": "use-1"}))).await;
    assert_eq!(status, StatusCode::OK, "{used}");
    assert_eq!(used["changed"], true);
    let b = bundle(&app, &token).await;
    assert_ne!(b["rev"], rev_before);
    for k in [print, bought, stand] {
        assert_eq!(swap_of(&b, k)["deck_installed"], false, "{k}");
    }
    let note: Option<String> = sqlx::query_scalar("SELECT v.note FROM decks d JOIN deck_versions v ON v.id = d.current_version_id WHERE d.id = ?")
        .bind(&main)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(note.as_deref(), Some("Switched to stock"));

    // A retry saves nothing new; the same list again saves nothing either.
    let n = count_versions(&pool, &main).await;
    let (_, again) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&token), Some(json!({"from": stock, "op_id": "use-1"}))).await;
    assert_eq!(again, used);
    // The same op_id for another list is refused rather than replayed.
    let (status, _) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&token), Some(json!({"version": "whatever", "op_id": "use-1"}))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, same) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&token), Some(json!({"from": stock, "op_id": "use-2"}))).await;
    assert_eq!(same["changed"], false);
    assert_eq!(count_versions(&pool, &main).await, n);

    // Restoring the first version (the "now" list) puts the swaps back.
    let first: String = sqlx::query_scalar("SELECT id FROM deck_versions WHERE deck_id = ? ORDER BY created_at, rowid LIMIT 1").bind(&main).fetch_one(&pool).await.unwrap();
    let (status, restored) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&token), Some(json!({"version": first, "op_id": "use-3"}))).await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    let b = bundle(&app, &token).await;
    assert_eq!(swap_of(&b, bought)["deck_installed"], true);

    // MCP plan_deck says where installed state comes from, and reads it from the deck.
    let text = crate::advisor::context::plan_deck(&pool, &owner, "alpha").await.unwrap();
    assert!(text.contains("Installed state is read from their Yama deck \"Alpha Deck\""), "{text}");
    assert!(text.contains("Bought Card replacing Cut Card [buy, T1, installed (in the deck's list)]"), "{text}");
    assert!(text.contains("Print Card replacing Old Card [print, T1, not installed (not in the deck's list)]"), "{text}");

    assert_eq!(swap_of(&b, stand)["deck_superseded"], false);

    // The print goes in where the stand-in was: the stand-in is out, but done, not waiting.
    crate::decks::insert_version(&pool, &main, &alpha_deck(("o-print", "Print Card"), ("o-bought", "Bought Card")), Some("prints")).await.unwrap();
    let b = bundle(&app, &token).await;
    assert_eq!(swap_of(&b, print)["deck_installed"], true);
    assert_eq!(swap_of(&b, stand)["deck_installed"], false);
    assert_eq!(swap_of(&b, stand)["deck_superseded"], true);
}

/// A scan of the physical deck saved as a new version (deck_scan.rs) moves installs only when it
/// becomes the deck's list.
#[tokio::test]
async fn a_scanned_list_marks_installs_only_once_it_is_current() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    let bought = "plan|Alpha Deck|Bought Card|Cut Card";
    let main = crate::decks::create_deck_with_cards(&pool, &owner, "Alpha Deck", None, alpha_deck(("o-old", "Old Card"), ("o-cut", "Cut Card"))).await.unwrap();
    assert_eq!(swap_of(&bundle(&app, &token).await, bought)["deck_installed"], false);
    let scan = json!([
        {"name": "Test Commander", "qty": 1, "commander": true}, {"name": "Sol Ring", "qty": 1},
        {"name": "Old Card", "qty": 1}, {"name": "Bought Card", "qty": 1}, {"name": "Forest", "qty": 96},
    ]);
    let based_on: String = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(&main).fetch_one(&pool).await.unwrap();
    let (status, saved) = send(&app, Method::POST, &format!("/api/decks/{main}/scan"), Some(&token), Some(json!({"op_id": "scan-a", "cards": scan, "make_current": false, "based_on": based_on}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(swap_of(&bundle(&app, &token).await, bought)["deck_installed"], false);
    let (status, saved) = send(&app, Method::POST, &format!("/api/decks/{main}/scan"), Some(&token), Some(json!({"op_id": "scan-b", "cards": scan, "make_current": true, "based_on": based_on}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(swap_of(&bundle(&app, &token).await, bought)["deck_installed"], true);
}

async fn count_versions(pool: &SqlitePool, deck: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM deck_versions WHERE deck_id = ?").bind(deck).fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn using_a_list_stays_inside_the_owners_configuration_group() {
    let (app, pool, owner, token) = setup().await;
    let main = crate::decks::create_deck_with_cards(&pool, &owner, "Alpha Deck", None, alpha_deck(("o-old", "Old Card"), ("o-cut", "Cut Card"))).await.unwrap();
    let other = crate::decks::create_deck_with_cards(&pool, &owner, "Other Deck", None, alpha_deck(("o-stand", "Stand Card"), ("o-cut", "Cut Card"))).await.unwrap();
    let (stranger, stranger_token) = user(&pool, "someone@example.com").await;
    let theirs = crate::decks::create_deck_with_cards(&pool, &stranger, "Theirs", None, alpha_deck(("o-stand", "Stand Card"), ("o-cut", "Cut Card"))).await.unwrap();
    // A deck outside the group, someone else's deck, and someone else using mine: all refused.
    let (s, _) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&token), Some(json!({"from": other, "op_id": "a"}))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&token), Some(json!({"from": theirs, "op_id": "b"}))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&stranger_token), Some(json!({"from": theirs, "op_id": "c"}))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let their_version: String = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(&theirs).fetch_one(&pool).await.unwrap();
    let (s, _) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&token), Some(json!({"version": their_version, "op_id": "d"}))).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = send(&app, Method::POST, &format!("/api/decks/{main}/use"), Some(&token), Some(json!({"op_id": "e"}))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(count_versions(&pool, &main).await, 1);
}

#[tokio::test]
async fn review_lists_unanswered_proposals_first_and_leaves_planned_swaps_out() {
    let (app, pool, owner, token) = setup().await;
    import(&app, &token, &doc()).await;
    // "alpha-idea" (Proposal Card) comes before "alpha-owned" (Spare Card) in plan order; answer it.
    yama_answer(&pool, &owner, "alpha-idea", Some("want"), "2026-10-28T10:00:00Z").await;
    let text = crate::advisor::context::review(&pool, &owner).await.unwrap();
    assert!(text.contains("Want means an agent moves the swap into the plan"), "{text}");
    assert!(text.contains("Alpha Deck: 1 waiting for an answer, 1 answered"), "{text}");
    let open = text.find("- Spare Card").expect("unanswered proposal listed");
    let answered = text.find("- Proposal Card").expect("answered proposal listed");
    let heading = text.find("Already answered:").unwrap();
    assert!(open < heading && heading < answered, "{text}");
    // Planned swaps are in the plan already, so they aren't on the review list.
    assert!(!text.contains("Bought Card"), "{text}");
    // A note alone doesn't answer a proposal.
    sqlx::query("UPDATE plan_reviews SET decision = NULL, note = 'thinking' WHERE owner_id = ? AND swap_key = 'alpha-idea'").bind(&owner).execute(&pool).await.unwrap();
    let text = crate::advisor::context::review(&pool, &owner).await.unwrap();
    assert!(text.contains("Alpha Deck: 2 waiting for an answer, 0 answered"), "{text}");
    let deck = crate::advisor::context::plan_deck(&pool, &owner, "alpha").await.unwrap();
    assert!(deck.contains("Proposed swaps waiting for their answer (2)"), "{deck}");
}

#[tokio::test]
async fn old_lab_links_redirect_to_the_lab_section() {
    let (app, _pool, _owner, _token) = setup().await;
    for (from, to) in [
        ("/decks/lab", "/lab"),
        ("/decks/lab/runs/abc", "/lab/runs/abc"),
        ("/decks/lab/try?deck=x%20y", "/lab/try?deck=x%20y"),
        ("/decks/datasets", "/lab/datasets"),
        ("/decks/datasets/playgroup-history?revision=3", "/lab/datasets/playgroup-history?revision=3"),
    ] {
        let res = app.clone().oneshot(Request::builder().uri(from).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::PERMANENT_REDIRECT, "{from}");
        assert_eq!(res.headers()[header::LOCATION], to, "{from}");
    }
}

// ── store preferences, the wishlist and the trip (docs/shopping-design.md) ──

async fn set_pref(app: &Router, token: &str, store: &str, body: Value) -> (StatusCode, Value) {
    send(app, Method::PUT, &format!("/api/plan/stores/{store}/preference"), Some(token), Some(body)).await
}

#[tokio::test]
async fn store_preferences_and_the_wishlist_reach_the_bundle_and_the_trip() {
    let (app, pool, id, token) = setup().await;
    import(&app, &token, &doc()).await;
    // Answered after the import, so the want approves the proposal as it stands.
    yama_answer(&pool, &id, "alpha-idea", Some("want"), &crate::util::now()).await;
    let before = bundle(&app, &token).await;
    assert_eq!(before["store_prefs"], json!({}));
    assert_eq!(before["wishlist"], json!([]));

    // Only your own stores, and only the four preferences and sensible settings.
    let (friend, friend_token) = user(&pool, "friend@example.com").await;
    assert_eq!(set_pref(&app, &token, "nowhere", json!({"preference": "never"})).await.0, StatusCode::NOT_FOUND);
    assert_eq!(set_pref(&app, &friend_token, "shop", json!({"preference": "never"})).await.0, StatusCode::NOT_FOUND);
    assert_eq!(set_pref(&app, &token, "shop", json!({"preference": "sometimes"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(set_pref(&app, &token, "shop", json!({"preference": "ok", "hassle": 0})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(set_pref(&app, &token, "shop", json!({"preference": "favorite", "premium_usd": 11})).await.0, StatusCode::BAD_REQUEST);
    // The name before migration 0051 still means a favourite.
    let (status, r) = set_pref(&app, &token, "shop", json!({"preference": "default", "hassle": 2, "premium_usd": 0.25})).await;
    assert_eq!((status, r["preference"].as_str()), (StatusCode::OK, Some("favorite")), "{r}");
    assert_eq!(bundle(&app, &token).await["store_prefs"]["shop"]["premium_usd"], 0.25);
    // The whole order at once: only your current stores (not a printer), each once.
    let order = |keys: Value| {
        let (app, token) = (app.clone(), token.clone());
        async move { send(&app, Method::PUT, "/api/plan/store-order", Some(&token), Some(json!({"keys": keys}))).await }
    };
    assert_eq!(order(json!(["shop", "shop"])).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(order(json!(["printer"])).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&app, Method::PUT, "/api/plan/store-order", Some(&friend_token), Some(json!({"keys": ["shop"]}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(order(json!(["shop"])).await.0, StatusCode::OK);
    let b = bundle(&app, &token).await;
    assert_eq!((b["store_prefs"]["shop"]["hassle"].as_i64(), b["store_prefs"]["shop"]["preference"].as_str()), (Some(1), Some("favorite")), "other settings stay");
    let (status, r) = set_pref(&app, &token, "shop", json!({"preference": "never", "note": "  Too far  "})).await;
    assert_eq!(status, StatusCode::OK, "{r}");

    // A wishlist scenario in research; another kind of scenario isn't one.
    let document = json!({"id": "audit", "scenarios": [
        {"id": "wish", "purpose": "permanent_real_wishlist", "buys": [{"card": "Sol Ring", "reason": "Printed"}, {"card": "Unknown Future Card"}, {"card": "sol ring"}]},
        {"id": "default", "buys": [{"card": "Red Card"}]}]});
    for (owner, rid) in [(&id, "audit"), (&friend, "theirs")] {
        sqlx::query("INSERT INTO research_reports (owner_id, id, title, content_hash, document, updated_at) VALUES (?, ?, 'Audit', 'h', ?, '2026-11-01T00:00:00Z')")
            .bind(owner)
            .bind(rid)
            .bind(document.to_string())
            .execute(&pool)
            .await
            .unwrap();
    }

    let b = bundle(&app, &token).await;
    assert_ne!(b["rev"], before["rev"], "a preference or research change refetches the bundle");
    assert_eq!(b["store_prefs"]["shop"]["preference"], "never");
    assert_eq!(b["store_prefs"]["shop"]["note"], "Too far");
    let wish: Vec<&str> = b["wishlist"].as_array().unwrap().iter().map(|w| w["card"].as_str().unwrap()).collect();
    assert_eq!(wish, ["Sol Ring", "Unknown Future Card"]);
    assert_eq!(b["names"]["Sol Ring"], "o-sol");
    assert!(b["unresolved"].as_array().unwrap().contains(&json!("Unknown Future Card")));
    assert_eq!(bundle(&app, &friend_token).await["store_prefs"], json!({}), "preferences are per user");

    // You won't go there, so the wanted card is left to print, and the store is named.
    let t = super::trip::plan(&b, "2026-11-01", None);
    assert!(t.stops.is_empty());
    assert_eq!(t.print.len(), 1);
    assert_eq!((t.print[0].want.card.as_str(), t.print[0].reason), ("Proposal Card", "never-store"));
    assert_eq!(t.skipped.len(), 1);

    // Cleared: fine to go again, and the trip goes there.
    assert_eq!(set_pref(&app, &token, "shop", json!({"preference": null})).await.0, StatusCode::OK);
    let b = bundle(&app, &token).await;
    assert_eq!(b["store_prefs"], json!({}));
    let t = super::trip::plan(&b, "2026-11-01", None);
    assert_eq!(t.stops.len(), 1);
    assert_eq!(t.stops[0].rows[0].want.card, "Proposal Card");
    assert_eq!(t.total, Some(0.75));
    assert!(super::trip::text(&t).contains("1. Example Games (fine to go): 1 card, $0.75"));
}

#[tokio::test]
async fn a_rule_set_made_in_yama_is_dated_and_an_import_never_replaces_it() {
    let (app, pool, id, token) = setup().await;
    import(&app, &token, &doc()).await;
    let (friend, friend_token) = user(&pool, "friend@example.com").await;
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let tomorrow = (chrono::Utc::now() + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let rule = json!({"max_usd": 2.0, "always_ok_usd": 0.5, "tiers": [{"market_under": 1.0, "max_multiple": 2.0}, {"market_under": null, "max_multiple": 1.5}]});
    let post = |token: String, body: Value| {
        let app = app.clone();
        async move { send(&app, Method::POST, "/api/plan/settings", Some(&token), Some(body)).await }
    };

    // Only today (a day either side for time zones), and only a rule that makes sense.
    let (status, _) = post(token.clone(), json!({"effective_from": "2026-10-01", "local_buy": rule})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let mut odd = rule.clone();
    odd["always_ok_usd"] = json!(3.0);
    let (status, r) = post(token.clone(), json!({"effective_from": today, "local_buy": odd})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(r["error"].as_str().unwrap().contains("can't be above"), "{r}");

    let before = revision(&pool, &id).await;
    let (status, r) = post(token.clone(), json!({"effective_from": today, "local_buy": rule, "sealed_max_usd": 51, "note": "New rule"})).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert!(revision(&pool, &id).await > before, "the bundle is fetched again");
    let b = bundle(&app, &token).await;
    let sets = b["settings"].as_array().unwrap();
    assert_eq!(sets.len(), 3);
    let made = sets.iter().find(|s| s["effective_from"] == today.as_str()).unwrap();
    assert_eq!(made["origin"], "yama");
    assert_eq!(made["note"], "New rule");
    assert_eq!(made["rules"]["ceiling_other_usd"], 3.0, "a copy of the set in force, older checks keep theirs");
    assert_eq!(made["rules"]["sealed_max_usd"], 51.0);
    assert_eq!(made["rules"]["local_buy"]["max_usd"], 2.0);
    assert_eq!(bundle(&app, &friend_token).await["settings"], json!([]), "rules are per user");
    let _ = friend;

    // A later import keeps it: the same date isn't applied, and a later imported set warns.
    let mut d = doc();
    d["plan"]["settings"].as_array_mut().unwrap().push(json!({"effective_from": today, "note": "Imported today", "rules": {"currency": "USD"}}));
    d["plan"]["settings"].as_array_mut().unwrap().push(json!({"effective_from": tomorrow, "note": "Imported tomorrow", "rules": {"currency": "USD"}}));
    let r = import(&app, &token, &d).await;
    let warnings: Vec<&str> = r["warnings"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(warnings.iter().any(|w| w.starts_with(&format!("Kept the rule set from {today} made in Yama"))), "{warnings:?}");
    assert!(warnings.iter().any(|w| w.starts_with(&format!("The imported rule set from {tomorrow} applies from that date"))), "{warnings:?}");
    assert_eq!(r["counts"]["settings"], 3);
    let b = bundle(&app, &token).await;
    let made = b["settings"].as_array().unwrap().iter().find(|s| s["effective_from"] == today.as_str()).unwrap();
    assert_eq!((made["origin"].as_str(), made["note"].as_str()), (Some("yama"), Some("New rule")));
    // The same import again: nothing new to warn about after the Yama set.
    let mut again = d.clone();
    again["meta"]["generated_at"] = json!("2026-10-19T21:30:00Z");
    again["plan"]["stores"][0]["note"] = json!("Changed");
    let r = import(&app, &token, &again).await;
    let warnings: Vec<&str> = r["warnings"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(!warnings.iter().any(|w| w.contains("applies from that date")), "{warnings:?}");

    // Undo: only the newest set, and only one made in Yama.
    let del = |date: &str| {
        let (app, token, path) = (app.clone(), token.clone(), format!("/api/plan/settings/{date}"));
        async move { send(&app, Method::DELETE, &path, Some(&token), None).await }
    };
    assert_eq!(del(&tomorrow).await.0, StatusCode::CONFLICT, "imported");
    assert_eq!(del(&today).await.0, StatusCode::CONFLICT, "not the newest");
    assert_eq!(del("2026-01-01").await.0, StatusCode::NOT_FOUND);
    import(&app, &token, &doc()).await;
    let (status, r) = del(&today).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!(bundle(&app, &token).await["settings"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn restoring_a_yama_backup_never_deletes_a_rule_set() {
    let (app, _pool, _id, token) = setup().await;
    // A plan made in Yama (a backup restored), then a rule set made since.
    let mut backup = doc();
    backup["meta"]["app"] = json!("yama");
    import(&app, &token, &backup).await;
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let rule = json!({"max_usd": 2.0, "always_ok_usd": 0.5, "tiers": []});
    let (status, r) = send(&app, Method::POST, "/api/plan/settings", Some(&token), Some(json!({"effective_from": today, "local_buy": rule}))).await;
    assert_eq!(status, StatusCode::OK, "{r}");

    // A backup with no rule sets keeps them all.
    backup["meta"]["generated_at"] = json!("2026-10-19T20:30:00Z");
    backup["plan"]["settings"] = json!([]);
    import(&app, &token, &backup).await;
    let dates: Vec<String> = bundle(&app, &token).await["settings"].as_array().unwrap().iter().map(|s| s["effective_from"].as_str().unwrap().to_string()).collect();
    assert_eq!(dates, ["2026-10-08", "2026-10-10", today.as_str()]);

    // One with today's date replaces it, and says so.
    backup["meta"]["generated_at"] = json!("2026-10-19T21:30:00Z");
    backup["plan"]["settings"] = json!([{"effective_from": today, "note": "Restored", "rules": {"currency": "USD"}}]);
    let r = import(&app, &token, &backup).await;
    assert!(r["warnings"].as_array().unwrap().iter().any(|w| w.as_str().unwrap().contains("was replaced by the restored one")), "{r}");
    let b = bundle(&app, &token).await;
    assert_eq!(b["settings"].as_array().unwrap().len(), 3);
    assert_eq!(b["settings"][2]["note"], "Restored");
}

#[path = "tests_versions.rs"]
mod versions;
