//! Scanning a deck into a new version, through the real router on an in-memory database.

use super::compare;
use crate::decks::{Board, DeckCard};
use crate::testutil::{app, send, user};
use axum::Router;
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::SqlitePool;

async fn seed(pool: &SqlitePool) {
    for (id, name, type_line, ci, legal) in [
        ("o-cmd", "Test Commander", "Legendary Creature — Elf", "G", "legal"),
        ("o-sol", "Sol Ring", "Artifact", "", "legal"),
        ("o-old", "Old Card", "Creature — Elf", "G", "legal"),
        ("o-new", "New Card", "Instant", "G", "legal"),
        ("o-red", "Red Card", "Instant", "R", "legal"),
        ("o-banned", "Banned Card", "Artifact", "", "banned"),
        ("o-side", "Side Card", "Instant", "G", "legal"),
        ("o-forest", "Forest", "Basic Land — Forest", "G", "legal"),
    ] {
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, color_identity, legalities, updated_at) VALUES (?, ?, ?, ?, ?, 'now')")
            .bind(id)
            .bind(name)
            .bind(type_line)
            .bind(ci)
            .bind(format!("{{\"commander\":\"{legal}\"}}"))
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(id).execute(pool).await.unwrap();
    }
}

fn card(oracle_id: &str, name: &str, qty: i64, board: Board) -> DeckCard {
    DeckCard { oracle_id: oracle_id.into(), name: name.into(), qty, board }
}

/// Commander, Sol Ring, Old Card, 97 Forests, and a sideboard card.
fn deck_list() -> Vec<DeckCard> {
    vec![
        card("o-cmd", "Test Commander", 1, Board::Commander),
        card("o-sol", "Sol Ring", 1, Board::Main),
        card("o-old", "Old Card", 1, Board::Main),
        card("o-forest", "Forest", 97, Board::Main),
        card("o-side", "Side Card", 1, Board::Side),
    ]
}

/// The scan of that deck with Old Card swapped for New Card, as the web sends it.
fn scanned(swap_in: &str) -> Value {
    json!([
        {"name": "Test Commander", "qty": 1, "commander": true},
        {"name": "sol ring", "qty": 1},
        {"name": swap_in, "qty": 1},
        {"name": "Forest", "qty": 97},
    ])
}

async fn setup() -> (Router, SqlitePool, String, String, String) {
    let (app, pool) = app().await;
    seed(&pool).await;
    let (owner, token) = user(&pool, "bryan@example.com").await;
    let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Alpha Deck", None, deck_list()).await.unwrap();
    (app, pool, owner, token, deck)
}

async fn current(pool: &SqlitePool, deck: &str) -> String {
    sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(deck).fetch_one(pool).await.unwrap()
}

async fn versions(pool: &SqlitePool, deck: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM deck_versions WHERE deck_id = ?").bind(deck).fetch_one(pool).await.unwrap()
}

fn names(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(|c| format!("{} {}>{}", c["name"].as_str().unwrap(), c["before"], c["after"])).collect()
}

#[test]
fn compare_counts_copies_in_out_and_unchanged() {
    let before = deck_list();
    let after = vec![
        card("o-cmd", "Test Commander", 1, Board::Commander),
        card("o-sol", "Sol Ring", 1, Board::Main),
        card("o-new", "New Card", 1, Board::Main),
        card("o-forest", "Forest", 95, Board::Main),
    ];
    let c = compare(&before, &after);
    let show = |l: &[super::Change]| l.iter().map(|c| format!("{} {}>{}", c.name, c.before, c.after)).collect::<Vec<_>>();
    assert_eq!(show(&c.added), ["New Card 0>1"]);
    assert_eq!(show(&c.removed), ["Forest 97>95", "Old Card 1>0"]);
    // Forest stays in part; the sideboard isn't part of the scan.
    assert_eq!(show(&c.unchanged), ["Forest 97>95", "Sol Ring 1>1", "Test Commander 1>1"]);
    assert!(!c.same());
    assert!(compare(&before, &before).same());
    // The commander is compared by card: an old version's spelling of its name doesn't count.
    let mut renamed = before.clone();
    renamed[0].name = "Test Commander (old spelling)".into();
    assert!(compare(&renamed, &before).same());
    // A different commander is a change even with the same cards.
    let mut swapped = before.clone();
    swapped[0].board = Board::Main;
    swapped[1].board = Board::Commander;
    assert!(!compare(&before, &swapped).same());
}

#[tokio::test]
async fn check_shows_the_changes_and_commander_checks_without_saving() {
    let (app, pool, _, token, deck) = setup().await;
    let before = current(&pool, &deck).await;
    let (status, r) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan/check"), Some(&token), Some(json!({"cards": scanned("New Card")}))).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!(names(&r["added"]), ["New Card 0>1"]);
    assert_eq!(names(&r["removed"]), ["Old Card 1>0"]);
    assert_eq!(r["unchanged"].as_array().unwrap().len(), 3);
    assert_eq!(r["based_on"], before.as_str());
    assert_eq!(r["kept_sideboard"], 1);
    assert_eq!(r["same"], false);
    assert_eq!(r["validation"]["total"], 100);
    assert_eq!(r["validation"]["ok"], true, "{r}");
    // Names are read the way imports read them, with canonical spelling, commander first.
    assert_eq!(r["cards"][0]["name"], "Test Commander");
    assert_eq!(r["cards"][0]["board"], "commander");
    assert!(r["cards"].as_array().unwrap().iter().any(|c| c["name"] == "Sol Ring"));
    assert_eq!(versions(&pool, &deck).await, 1);

    // Count, singleton, color identity, legality and unknown names all show.
    let (_, r) = send(
        &app,
        Method::POST,
        &format!("/api/decks/{deck}/scan/check"),
        Some(&token),
        Some(json!({"cards": [
            {"name": "Test Commander", "qty": 1, "commander": true},
            {"name": "Sol Ring", "qty": 2},
            {"name": "Red Card", "qty": 1},
            {"name": "Banned Card", "qty": 1},
            {"name": "Not A Card", "qty": 1},
        ]})),
    )
    .await;
    let errors = r["validation"]["errors"].to_string();
    for want in ["5 cards", "2 × Sol Ring", "Red Card is outside", "Banned Card is banned"] {
        assert!(errors.contains(want), "{want}: {errors}");
    }
    assert_eq!(r["unknown"], json!(["Not A Card"]));
    assert_eq!(r["same"], false);

    // A second copy of the commander is an ordinary card, not a second commander.
    let (_, r) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan/check"), Some(&token), Some(json!({"cards": [{"name": "Test Commander", "qty": 2, "commander": true}]}))).await;
    assert_eq!(r["commanders_after"], json!(["Test Commander"]));
    assert!(r["validation"]["errors"].to_string().contains("2 × Test Commander"), "{r}");

    // The same list as the deck's: nothing to save.
    let same = json!([
        {"name": "Test Commander", "qty": 1, "commander": true},
        {"name": "Sol Ring", "qty": 1}, {"name": "Old Card", "qty": 1}, {"name": "Forest", "qty": 97},
    ]);
    let (_, r) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan/check"), Some(&token), Some(json!({"cards": same}))).await;
    assert_eq!(r["same"], true, "{r}");
}

#[tokio::test]
async fn saving_makes_a_new_version_and_keeps_the_old_one() {
    let (app, pool, _, token, deck) = setup().await;
    let first = current(&pool, &deck).await;
    let body = json!({"op_id": "scan-1", "cards": scanned("New Card"), "make_current": true, "based_on": first});
    let (status, saved) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan"), Some(&token), Some(body.clone())).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["changed"], true);
    assert_eq!(saved["current"], true);
    let now = current(&pool, &deck).await;
    assert_eq!(saved["version_id"], now.as_str());
    assert_ne!(now, first);
    assert_eq!(versions(&pool, &deck).await, 2);
    let cards = crate::decks::load_version_cards(&pool, &now).await.unwrap();
    assert!(cards.iter().any(|c| c.name == "New Card") && !cards.iter().any(|c| c.name == "Old Card"));
    // The sideboard the scan didn't cover is kept.
    assert!(cards.iter().any(|c| c.name == "Side Card" && c.board == Board::Side));
    let note: Option<String> = sqlx::query_scalar("SELECT note FROM deck_versions WHERE id = ?").bind(&now).fetch_one(&pool).await.unwrap();
    assert_eq!(note.as_deref(), Some("Scanned from the deck (100 cards)"));

    // A retry gets the same answer and saves nothing; the same op_id for another list is refused.
    let (_, again) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan"), Some(&token), Some(body)).await;
    assert_eq!(again, saved);
    assert_eq!(versions(&pool, &deck).await, 2);
    let (status, _) = send(
        &app,
        Method::POST,
        &format!("/api/decks/{deck}/scan"),
        Some(&token),
        Some(json!({"op_id": "scan-1", "cards": scanned("Old Card"), "make_current": true, "based_on": now})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Checked against the first list, which isn't current any more: refused, never overwritten.
    let (status, r) = send(
        &app,
        Method::POST,
        &format!("/api/decks/{deck}/scan"),
        Some(&token),
        Some(json!({"op_id": "scan-2", "cards": scanned("Old Card"), "make_current": true, "based_on": first})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{r}");
    assert_eq!(current(&pool, &deck).await, now);

    // The old list is still there to switch back to.
    let (status, restored) = send(&app, Method::POST, &format!("/api/decks/{deck}/use"), Some(&token), Some(json!({"version": first, "op_id": "use-1"}))).await;
    assert_eq!(status, StatusCode::OK, "{restored}");
    assert_eq!(restored["changed"], true);
}

#[tokio::test]
async fn saving_without_making_it_current_leaves_the_deck_alone() {
    let (app, pool, _, token, deck) = setup().await;
    let first = current(&pool, &deck).await;
    let (status, saved) = send(
        &app,
        Method::POST,
        &format!("/api/decks/{deck}/scan"),
        Some(&token),
        Some(json!({"op_id": "scan-1", "cards": scanned("New Card"), "make_current": false, "based_on": first})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["changed"], true);
    assert_eq!(saved["current"], false);
    assert_eq!(current(&pool, &deck).await, first);
    assert_eq!(versions(&pool, &deck).await, 2);
    // It's in History, and nothing is queued for an outside check of a list not in use.
    let (_, history) = send(&app, Method::GET, &format!("/api/decks/{deck}/versions"), Some(&token), None).await;
    assert_eq!(history.as_array().unwrap().len(), 2);
    let scan = saved["version_id"].as_str().unwrap();
    // Marked as never the deck's list, so logging a game doesn't credit it (web versionOn).
    for v in history.as_array().unwrap() {
        assert_eq!(v["history_only"], v["id"] == scan, "{v}");
    }
    let queued: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM deck_version_checks WHERE version_id = ?").bind(scan).fetch_one(&pool).await.unwrap();
    assert_eq!(queued, 0);
    // Restoring it later makes it the list.
    let (status, _) = send(&app, Method::POST, &format!("/api/decks/{deck}/use"), Some(&token), Some(json!({"version": scan, "op_id": "use-1"}))).await;
    assert_eq!(status, StatusCode::OK);
    let now = crate::decks::load_version_cards(&pool, &current(&pool, &deck).await).await.unwrap();
    assert!(now.iter().any(|c| c.name == "New Card"));
}

#[tokio::test]
async fn a_scan_matching_the_list_saves_nothing() {
    let (app, pool, _, token, deck) = setup().await;
    let first = current(&pool, &deck).await;
    let (status, saved) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan"), Some(&token), Some(json!({"op_id": "scan-1", "cards": scanned("Old Card"), "make_current": true, "based_on": first}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["changed"], false);
    assert_eq!(saved["version_id"], first.as_str());
    assert_eq!(versions(&pool, &deck).await, 1);
}

#[tokio::test]
async fn scans_are_refused_for_unknown_cards_and_other_peoples_decks() {
    let (app, pool, _, token, deck) = setup().await;
    let first = current(&pool, &deck).await;
    let (status, r) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan"), Some(&token), Some(json!({"op_id": "s", "cards": scanned("Not A Card"), "make_current": true, "based_on": first}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(r.to_string().contains("Not A Card"), "{r}");
    let (status, _) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan"), Some(&token), Some(json!({"op_id": "s", "cards": [], "make_current": true, "based_on": first}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan"), Some(&token), Some(json!({"op_id": "s", "cards": [{"name": "Forest", "qty": 0}], "make_current": true}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // Quantities too large to add up are refused, not wrapped past the limit.
    for cards in [json!([{"name": "Forest", "qty": i64::MAX}, {"name": "Sol Ring", "qty": 1}]), json!([{"name": "Forest", "qty": 200}, {"name": "Sol Ring", "qty": 101}])] {
        let (status, r) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan"), Some(&token), Some(json!({"op_id": "big", "cards": cards, "make_current": true, "based_on": first}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{r}");
    }
    let (status, _) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan"), Some(&token), Some(json!({"op_id": "", "cards": scanned("New Card"), "make_current": true}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (_, stranger) = user(&pool, "someone@example.com").await;
    for path in [format!("/api/decks/{deck}/scan/check"), format!("/api/decks/{deck}/scan")] {
        let (status, _) = send(&app, Method::POST, &path, Some(&stranger), Some(json!({"op_id": "x", "cards": scanned("New Card"), "make_current": true, "based_on": first}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    let (status, _) = send(&app, Method::POST, &format!("/api/decks/{deck}/scan/check"), None, Some(json!({"cards": scanned("New Card")}))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(versions(&pool, &deck).await, 1);
}
