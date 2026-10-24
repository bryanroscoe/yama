//! Swapping in the prints: the deck's list, its box, where the cut cards go (spares, the swap bag,
//! the deck that takes a card next), the installed ticks, a second run, and other users.

use crate::decks::{Board, DeckCard};
use crate::testutil::{app, send, user};
use axum::Router;
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::SqlitePool;

const CARDS: &[(&str, &str, &str)] = &[
    ("o-acmd", "Alpha Commander", "Legendary Creature — Elf"),
    ("o-bcmd", "Beta Commander", "Legendary Creature — Elf"),
    ("o-print", "Print Card", "Artifact"),
    ("o-print2", "Second Print", "Artifact"),
    ("o-print3", "Third Print", "Artifact"),
    ("o-print4", "Fourth Print", "Artifact"),
    ("o-stand", "Stand In", "Artifact"),
    ("o-cut", "Cut Card", "Artifact"),
    ("o-bag", "Bag Card", "Artifact"),
    ("o-gift", "Gift Card", "Artifact"),
    ("o-bcut", "Beta Cut", "Artifact"),
    ("o-forest", "Forest", "Basic Land — Forest"),
];

async fn seed(pool: &SqlitePool) {
    // Another card's back face named like one in the deck (Grave Researcher // Reanimate): the
    // deck's card is the one with that whole name. Its id sorts first, so a lookup that doesn't
    // prefer the whole name would find it.
    sqlx::query("INSERT INTO cards (oracle_id, name, type_line, layout, updated_at) VALUES ('o-aface', 'Grave Thing // Bag Card', 'Creature // Sorcery', 'prepare', 'now')")
        .execute(pool)
        .await
        .unwrap();
    for n in ["Grave Thing // Bag Card", "Grave Thing", "Bag Card"] {
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, 'o-aface')").bind(n).execute(pool).await.unwrap();
    }
    for (oid, name, tl) in CARDS {
        let pid = format!("p{}", &oid[1..]);
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, color_identity, legalities, default_printing, updated_at) VALUES (?,?,?,'G','{\"commander\":\"legal\"}',?,'now')")
            .bind(oid)
            .bind(name)
            .bind(tl)
            .bind(&pid)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(oid).execute(pool).await.unwrap();
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, released_at, digital, set_type, updated_at)
             VALUES (?,?,?,'tst','Test Set','1','en','[\"nonfoil\"]','2024-01-01',0,'core','now')",
        )
        .bind(&pid)
        .bind(oid)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    }
}

fn slot(name: &str, extra: Value) -> Value {
    let mut s = json!({"name": name, "qty": 1, "board": "main"});
    s.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    s
}

/// Alpha: a stand-in and three plan cuts leave for four prints; Bag Card goes back in at Bracket 3;
/// Gift Card moves to Beta, which cuts Beta Cut for it.
fn doc() -> Value {
    let forests = json!({"name": "Forest", "qty": 5, "board": "main"});
    let alpha_now = json!([
        {"name": "Alpha Commander", "qty": 1, "board": "commander"},
        slot("Stand In", json!({"kind": "standin", "replaces": "Old Card", "swap": "standin|Alpha Deck|Stand In"})),
        slot("Cut Card", json!({"kind": "stock"})),
        slot("Bag Card", json!({"kind": "stock"})),
        slot("Gift Card", json!({"kind": "stock"})),
        forests,
    ]);
    let p = |name: &str, out: &str| slot(name, json!({"kind": "print", "replaces": out, "swap": format!("plan|Alpha Deck|{name}|{out}")}));
    let alpha_after = json!([
        {"name": "Alpha Commander", "qty": 1, "board": "commander"},
        p("Print Card", "Old Card"),
        p("Second Print", "Cut Card"),
        p("Third Print", "Bag Card"),
        p("Fourth Print", "Gift Card"),
        forests,
    ]);
    let beta_now = json!([{"name": "Beta Commander", "qty": 1, "board": "commander"}, slot("Beta Cut", json!({})), {"name": "Forest", "qty": 3, "board": "main"}]);
    let beta_after = json!([
        {"name": "Beta Commander", "qty": 1, "board": "commander"},
        slot("Gift Card", json!({"kind": "moved", "from_deck": "alpha", "replaces": "Beta Cut", "swap": "plan|Beta Deck|Gift Card|Beta Cut"})),
        {"name": "Forest", "qty": 3, "board": "main"}
    ]);
    let swap = |deck: &str, key: &str, src: &str, out: &str, inn: &str| {
        let mut s = json!({"key": key, "deck": deck, "stage": "planned", "role": "swap", "src": src, "out": out, "in": inn});
        if src == "owned" {
            s["got"] = json!({"how": "deck", "deck": "alpha", "deck_name": "Alpha Deck", "origin": "precon"});
        }
        s
    };
    json!({
        "format": "yama-plan/1",
        "meta": {"app": "commander-decks", "guide_version": 9},
        "plan": {
            "decks": [
                {"key": "alpha", "name": "Alpha Deck", "commander": ["Alpha Commander"], "color_identity": "G",
                 "bracket": {"bags": {"3": [{"out": "Third Print", "in": "Bag Card"}]}},
                 "states": {"stock": {"cards": alpha_now}, "now": {"cards": alpha_now}, "after": {"cards": alpha_after}}},
                {"key": "beta", "name": "Beta Deck", "commander": ["Beta Commander"], "color_identity": "G",
                 "states": {"stock": {"cards": beta_now}, "now": {"cards": beta_now}, "after": {"cards": beta_after}}}
            ],
            "swaps": [
                swap("alpha", "plan|Alpha Deck|Print Card|Old Card", "print", "Old Card", "Print Card"),
                swap("alpha", "plan|Alpha Deck|Second Print|Cut Card", "print", "Cut Card", "Second Print"),
                swap("alpha", "plan|Alpha Deck|Third Print|Bag Card", "print", "Bag Card", "Third Print"),
                swap("alpha", "plan|Alpha Deck|Fourth Print|Gift Card", "print", "Gift Card", "Fourth Print"),
                swap("beta", "plan|Beta Deck|Gift Card|Beta Cut", "owned", "Beta Cut", "Gift Card")
            ]
        }
    })
}

fn dc(oid: &str, name: &str, qty: i64, board: Board) -> DeckCard {
    DeckCard { oracle_id: oid.into(), name: name.into(), qty, board }
}

/// A Yama deck holding the plan's now list, its box filled, linked to the plan deck.
async fn yama_deck(app: &Router, pool: &SqlitePool, owner: &str, token: &str, key: &str, name: &str, cards: Vec<DeckCard>) -> String {
    let id = crate::decks::create_deck_with_cards(pool, owner, name, None, cards).await.unwrap();
    let (status, r) = send(app, Method::POST, &format!("/api/decks/{id}/collect"), Some(token), Some(json!({"same": "add"}))).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    let (status, r) = send(app, Method::PATCH, &format!("/api/plan/decks/{key}"), Some(token), Some(json!({"deck_id": id}))).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    id
}

/// Copies of a card in a box: (real, proxy).
async fn in_box(pool: &SqlitePool, owner: &str, box_name: &str, card: &str) -> (i64, i64) {
    sqlx::query_as(
        "SELECT IFNULL(SUM(CASE WHEN i.proxy = 0 THEN i.qty END), 0), IFNULL(SUM(CASE WHEN i.proxy = 1 THEN i.qty END), 0)
         FROM collection_items i JOIN containers c ON c.id = i.container_id JOIN printings p ON p.scryfall_id = i.scryfall_id
         WHERE i.owner_id = ? AND c.name = ? AND p.name = ?",
    )
    .bind(owner)
    .bind(box_name)
    .bind(card)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn swapping_in_the_prints_matches_the_deck_and_the_collection() {
    let (app, pool) = app().await;
    seed(&pool).await;
    let (a_id, a) = user(&pool, "a@example.com").await;
    let (_, b) = user(&pool, "b@example.com").await;
    let (status, report) = send(&app, Method::POST, "/api/plan/import", Some(&a), Some(doc())).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    let alpha = yama_deck(
        &app,
        &pool,
        &a_id,
        &a,
        "alpha",
        "Alpha Deck",
        vec![
            dc("o-acmd", "Alpha Commander", 1, Board::Commander),
            dc("o-stand", "Stand In", 1, Board::Main),
            dc("o-cut", "Cut Card", 1, Board::Main),
            dc("o-bag", "Bag Card", 1, Board::Main),
            dc("o-gift", "Gift Card", 1, Board::Main),
            dc("o-forest", "Forest", 5, Board::Main),
        ],
    )
    .await;
    let beta = yama_deck(
        &app,
        &pool,
        &a_id,
        &a,
        "beta",
        "Beta Deck",
        vec![dc("o-bcmd", "Beta Commander", 1, Board::Commander), dc("o-bcut", "Beta Cut", 1, Board::Main), dc("o-forest", "Forest", 3, Board::Main)],
    )
    .await;

    // Nobody else can see or run it.
    let (status, _) = send(&app, Method::GET, "/api/plan/decks/alpha/swap-in", Some(&b), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&app, Method::POST, "/api/plan/decks/alpha/swap-in", Some(&b), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The preview changes nothing.
    let (status, p) = send(&app, Method::GET, "/api/plan/decks/alpha/swap-in", Some(&a), None).await;
    assert_eq!(status, StatusCode::OK, "{p}");
    assert_eq!(p["proxies_added"], 4, "{p}");
    assert_eq!(p["moved"], 4, "{p}");
    assert_eq!(p["done"], false);
    assert_eq!(p["ticks"].as_array().unwrap().len(), 4);
    let to: Vec<(String, String)> = p["takes_out"].as_array().unwrap().iter().map(|t| (t["name"].as_str().unwrap().into(), t["to_name"].as_str().unwrap().into())).collect();
    assert!(to.contains(&("Stand In".into(), "Spares".into())), "{to:?}");
    assert!(to.contains(&("Cut Card".into(), "Spares".into())), "{to:?}");
    assert!(to.contains(&("Bag Card".into(), "Alpha Deck swap bag".into())), "{to:?}");
    assert!(to.contains(&("Gift Card".into(), "Beta Deck".into())), "{to:?}");
    assert_eq!(in_box(&pool, &a_id, "Alpha Deck", "Print Card").await, (0, 0));
    let spares: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers WHERE name = 'Spares'").fetch_one(&pool).await.unwrap();
    assert_eq!(spares, 0, "a preview makes no boxes");

    let (status, done) = send(&app, Method::POST, "/api/plan/decks/alpha/swap-in", Some(&a), None).await;
    assert_eq!(status, StatusCode::OK, "{done}");
    assert_eq!(done["applied"], true, "{done}");
    for card in ["Print Card", "Second Print", "Third Print", "Fourth Print"] {
        assert_eq!(in_box(&pool, &a_id, "Alpha Deck", card).await, (0, 1), "{card} is a proxy in the box");
    }
    assert_eq!(in_box(&pool, &a_id, "Spares", "Stand In").await, (1, 0));
    assert_eq!(in_box(&pool, &a_id, "Spares", "Cut Card").await, (1, 0));
    assert_eq!(in_box(&pool, &a_id, "Alpha Deck swap bag", "Bag Card").await, (1, 0));
    assert_eq!(in_box(&pool, &a_id, "Beta Deck", "Gift Card").await, (1, 0), "a card another deck takes goes straight to its box");
    assert_eq!(in_box(&pool, &a_id, "Alpha Deck", "Forest").await, (5, 0), "cards that stay, stay");

    // The deck's list is the after list, its prints marked as proxies, and it counts as complete.
    let (_, deck) = send(&app, Method::GET, &format!("/api/decks/{alpha}"), Some(&a), None).await;
    let names: Vec<&str> = deck["cards"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"Print Card") && !names.contains(&"Cut Card") && !names.contains(&"Stand In"), "{names:?}");
    assert_eq!(deck["ownership"]["proxies"], 4, "{}", deck["ownership"]);
    assert_eq!(deck["ownership"]["needed"], 0, "a proxied card isn't needed");
    let proxy_prints: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deck_prints WHERE deck_id = ? AND proxy = 1").bind(&alpha).fetch_one(&pool).await.unwrap();
    assert_eq!(proxy_prints, 4);
    let (_, list) = send(&app, Method::GET, "/api/decks", Some(&a), None).await;
    let summary = list.as_array().unwrap().iter().find(|d| d["id"] == alpha.as_str()).unwrap();
    assert_eq!((summary["owned"].as_i64(), summary["proxies"].as_i64()), (Some(6), Some(4)), "{summary}");

    // Installed ticks, the same as taps, for pull.py.
    let ticks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_marks WHERE kind = 'installed' AND value = 1 AND swap_key LIKE 'plan|Alpha Deck|%'").fetch_one(&pool).await.unwrap();
    assert_eq!(ticks, 4);
    let inbox: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_inputs WHERE kind = 'installed'").fetch_one(&pool).await.unwrap();
    assert_eq!(inbox, 4);

    // A second run finds nothing to do.
    let (_, again) = send(&app, Method::POST, "/api/plan/decks/alpha/swap-in", Some(&a), None).await;
    assert_eq!(again["done"], true, "{again}");
    let versions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deck_versions WHERE deck_id = ?").bind(&alpha).fetch_one(&pool).await.unwrap();
    assert_eq!(versions, 2);

    // Beta: Gift Card is already in its box; Beta Cut goes to spares.
    let (_, p) = send(&app, Method::POST, "/api/plan/decks/beta/swap-in", Some(&a), None).await;
    assert_eq!(p["applied"], true, "{p}");
    assert_eq!(p["puts_in"][0]["action"], "in_box", "{p}");
    assert_eq!(in_box(&pool, &a_id, "Spares", "Beta Cut").await, (1, 0));
    let (_, deck) = send(&app, Method::GET, &format!("/api/decks/{beta}"), Some(&a), None).await;
    assert_eq!(deck["ownership"]["needed"], 0, "{}", deck["ownership"]);
    let spares: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers WHERE name = 'Spares'").fetch_one(&pool).await.unwrap();
    assert_eq!(spares, 1, "one Spares box, reused");

    // The collection's value leaves proxies out, and the list can show only them.
    let (_, s) = send(&app, Method::GET, "/api/collection/summary", Some(&a), None).await;
    assert_eq!(s["proxies"], 4, "{s}");
    let (_, only) = send(&app, Method::GET, "/api/collection?proxy=only", Some(&a), None).await;
    assert_eq!(only.as_array().unwrap().len(), 4);
    assert!(only.as_array().unwrap().iter().all(|i| i["proxy"] == true));
}

#[tokio::test]
async fn an_unlinked_plan_deck_is_refused() {
    let (app, pool) = app().await;
    seed(&pool).await;
    let (_, a) = user(&pool, "a@example.com").await;
    let (status, _) = send(&app, Method::POST, "/api/plan/import", Some(&a), Some(doc())).await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = send(&app, Method::GET, "/api/plan/decks/alpha/swap-in", Some(&a), None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"].as_str().unwrap().contains("isn't linked"), "{body}");
}
