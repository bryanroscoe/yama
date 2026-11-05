//! Plans made from a note's build (`notes.rs`), through the real router on an in-memory database.
//! The note is synthetic; nobody's real research is in this repo.

use crate::testutil::{app, deck, send, user};
use axum::Router;
use axum::http::{Method, StatusCode};
use serde_json::{Value, json};
use sqlx::SqlitePool;

/// A note with one deck and two builds. b3: an owned swap, a buy with a dated store offer, and a
/// print the build's acquisition lists account for. b4: one owned swap.
fn note() -> Value {
    json!({
        "schema": "yama-research/1", "id": "audit", "title": "Energy upgrades", "generated_at": "2026-11-04T00:00:00Z",
        "decks": [{
            "key": "energy", "name": "Energy", "commander": "Saheeli",
            "builds": [
                {"id": "b3", "label": "Bracket 3", "bracket": 3,
                 "list": "Commander\n1 Saheeli\nDeck\n1 Thought Monitor\n1 Arcane Signet\n1 Sol Ring\n96 Island",
                 "swaps": [
                    {"id": "monitor", "card_in": "Thought Monitor", "card_out": "Glimmer of Genius", "why": "Cheap draw",
                     "acquisition": {"kind": "owned", "card": "Thought Monitor", "detail": "In the blue binder"}},
                    {"id": "signet", "card_in": "Arcane Signet", "card_out": "Mind Stone", "why": "Fixing",
                     "acquisition": {"kind": "buy", "card": "Arcane Signet", "store": "Example Games", "price": 0.5,
                                     "checked": "2026-11-01", "url": "https://example.com/signet"}},
                    {"id": "ring", "card_in": "Sol Ring", "card_out": "Commander's Sphere", "why": "Speed"}
                 ],
                 "acquisition": {"prints": [{"card": "Sol Ring"}]}},
                {"id": "b4", "label": "Bracket 4", "bracket": 4,
                 "list": "Commander\n1 Saheeli\nDeck\n1 Rhystic Study\n98 Island",
                 "swaps": [{"id": "rhystic", "card_in": "Rhystic Study", "card_out": "Island", "acquisition": {"kind": "owned"}}]}
            ]
        }]
    })
}

async fn save_note(app: &Router, session: &str, doc: &Value) {
    let (status, r) = send(app, Method::POST, "/api/research", Some(session), Some(doc.clone())).await;
    assert_eq!(status, StatusCode::OK, "{r}");
}

async fn track(app: &Router, session: &str, build: &str, op: &str) -> (StatusCode, Value) {
    send(app, Method::POST, "/api/plan/from-note", Some(session), Some(json!({"note_id": "audit", "deck_key": "energy", "build_id": build, "op_id": op}))).await
}

async fn bundle(app: &Router, session: &str) -> Value {
    let (status, b) = send(app, Method::GET, "/api/plan/bundle", Some(session), None).await;
    assert_eq!(status, StatusCode::OK, "{b}");
    b
}

fn names(state: &Value) -> Vec<String> {
    state["cards"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap().to_string()).collect()
}

async fn live_swaps(pool: &SqlitePool, owner: &str) -> Vec<(String, String)> {
    sqlx::query_as("SELECT ext_key, src FROM plan_swaps WHERE owner_id = ? AND retired_at IS NULL ORDER BY sort")
        .bind(owner)
        .fetch_all(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn tracking_a_build_makes_a_plan_the_planner_pages_read() {
    let (app, pool) = app().await;
    let (a, session) = user(&pool, "a@example.com").await;
    let (yama_deck, _) = deck(&pool, &a, "Energy").await;
    save_note(&app, &session, &note()).await;

    let (status, t) = track(&app, &session, "b3", "op-1").await;
    assert_eq!(status, StatusCode::OK, "{t}");
    assert_eq!(t["plan_deck_key"], "energy");
    assert_eq!(t["swaps"], 3);
    assert_eq!(t["deck_id"], yama_deck, "linked to their only deck with the note deck's name");
    assert_eq!(t["warnings"], json!([]), "{t}");

    let b = bundle(&app, &session).await;
    let d = &b["decks"][0];
    assert_eq!(d["source"], "yama");
    assert_eq!(d["note"], json!({"id": "audit", "deck": "energy", "build": "b3"}));
    assert_eq!(d["commander"], json!(["Saheeli"]));
    let (stock, now, after) = (names(&d["states"]["stock"]), names(&d["states"]["now"]), names(&d["states"]["after"]));
    for out in ["Glimmer of Genius", "Mind Stone", "Commander's Sphere"] {
        assert!(stock.contains(&out.to_string()), "stock undoes every swap: {stock:?}");
    }
    assert!(!stock.contains(&"Thought Monitor".to_string()));
    assert!(now.contains(&"Thought Monitor".to_string()) && now.contains(&"Mind Stone".to_string()), "now applies only the owned swap: {now:?}");
    assert!(after.contains(&"Arcane Signet".to_string()) && after.contains(&"Sol Ring".to_string()));
    assert_eq!(d["states"]["after"]["computed_by"], super::COMPUTED_BY);

    let swaps = live_swaps(&pool, &a).await;
    assert_eq!(
        swaps,
        vec![
            ("n|audit|energy|b3|monitor".to_string(), "owned".to_string()),
            ("n|audit|energy|b3|signet".to_string(), "buy".to_string()),
            ("n|audit|energy|b3|ring".to_string(), "print".to_string()),
        ]
    );
    let monitor = b["swaps"].as_array().unwrap().iter().find(|s| s["key"] == "n|audit|energy|b3|monitor").unwrap();
    assert_eq!(monitor["got"], json!({"how": "owned", "detail": "In the blue binder"}));
    assert_eq!(monitor["why"], "Cheap draw");
    let quote: (String, String, Option<f64>, String) =
        sqlx::query_as("SELECT store_label, checked_on, price, origin FROM plan_quotes WHERE owner_id = ?").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(quote, ("Example Games".into(), "2026-11-01".into(), Some(0.5), "yama".into()), "the note's dated offer, never a 0 price");
}

#[tokio::test]
async fn a_retry_answers_once_and_nobody_else_can_track_or_stop_it() {
    let (app, pool) = app().await;
    let (a, session) = user(&pool, "a@example.com").await;
    let (_, other) = user(&pool, "b@example.com").await;
    save_note(&app, &session, &note()).await;
    let (_, first) = track(&app, &session, "b3", "op-1").await;
    let (status, again) = track(&app, &session, "b3", "op-1").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first, again);
    let (status, _) = track(&app, &session, "b4", "op-1").await;
    assert_eq!(status, StatusCode::CONFLICT, "one op id, one request");
    let decks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_decks WHERE owner_id = ?").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(decks, 1);
    let (yama_deck, _) = deck(&pool, &a, "Another deck").await;
    let (status, _) = send(&app, Method::POST, "/api/plan/from-note", Some(&session),
        Some(json!({"note_id": "audit", "deck_key": "energy", "build_id": "b3", "deck_id": yama_deck, "op_id": "op-1"}))).await;
    assert_eq!(status, StatusCode::CONFLICT, "another deck is another request, even with the same note, deck and build");
    let (status, _) = send(&app, Method::POST, "/api/plan/from-note", Some(&session),
        Some(json!({"note_id": "audit", "deck_key": "energy", "build_id": "b4", "expected_note_hash": "not-the-hash"}))).await;
    assert_eq!(status, StatusCode::CONFLICT, "a note that changed since it was reviewed isn't tracked");

    let (status, _) = track(&app, &other, "b3", "op-2").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "someone else's note is a 404");
    let (status, _) = send(&app, Method::DELETE, "/api/plan/from-note/energy", Some(&other), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(&app, Method::POST, "/api/plan/from-note", None, Some(json!({"note_id": "audit", "deck_key": "energy", "build_id": "b3"}))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(&app, Method::POST, "/api/plan/from-note", Some(&session), Some(json!({"note_id": "audit", "deck_key": "energy", "build_id": "b9"}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "a build the note doesn't have");
}

#[tokio::test]
async fn switching_saving_and_stopping_keep_one_plan_that_follows_the_note() {
    let (app, pool) = app().await;
    let (a, session) = user(&pool, "a@example.com").await;
    save_note(&app, &session, &note()).await;
    track(&app, &session, "b3", "op-1").await;

    // Switch: same plan key, the earlier build's swaps retired (and kept).
    let (status, t) = track(&app, &session, "b4", "op-2").await;
    assert_eq!(status, StatusCode::OK, "{t}");
    assert_eq!(t["plan_deck_key"], "energy");
    assert_eq!(live_swaps(&pool, &a).await, vec![("n|audit|energy|b4|rhystic".to_string(), "owned".to_string())]);
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_swaps WHERE owner_id = ? AND retired_at IS NOT NULL").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(kept, 3);

    // Saving the note again re-derives the tracked build.
    let mut doc = note();
    doc["decks"][0]["builds"][1]["swaps"][0]["why"] = json!("The best draw engine");
    save_note(&app, &session, &doc).await;
    let why: String = sqlx::query_scalar("SELECT why FROM plan_swaps WHERE owner_id = ? AND ext_key = 'n|audit|energy|b4|rhystic'").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(why, "The best draw engine");

    // A build the note drops stops being tracked.
    doc["decks"][0]["builds"].as_array_mut().unwrap().pop();
    save_note(&app, &session, &doc).await;
    let status: String = sqlx::query_scalar("SELECT status FROM plan_decks WHERE owner_id = ?").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(status, "archived");
    assert!(live_swaps(&pool, &a).await.is_empty());

    // Tracking again brings it back; stopping archives it.
    let (status, _) = track(&app, &session, "b3", "op-3").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(live_swaps(&pool, &a).await.len(), 3, "the b3 swaps are restored");
    let (status, r) = send(&app, Method::DELETE, "/api/plan/from-note/energy", Some(&session), None).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!(bundle(&app, &session).await["decks"][0]["status"], "archived");
}

#[tokio::test]
async fn a_plan_file_with_the_same_key_moves_the_tracked_note_aside() {
    let (app, pool) = app().await;
    let (a, session) = user(&pool, "a@example.com").await;
    save_note(&app, &session, &note()).await;
    track(&app, &session, "b3", "op-1").await;
    let list = json!([{"name": "Saheeli", "qty": 1, "board": "commander"}, {"name": "Island", "qty": 99, "board": "main"}]);
    let file = json!({
        "format": "yama-plan/1", "meta": {"app": "commander-decks", "guide_version": 6},
        "plan": {"decks": [{"key": "energy", "name": "Energy", "commander": ["Saheeli"],
                            "states": {"stock": {"cards": list}, "now": {"cards": list}, "after": {"cards": list}}}]}
    });
    let (status, r) = send(&app, Method::POST, "/api/plan/import", Some(&session), Some(file)).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    let keys: Vec<(String, String)> =
        sqlx::query_as("SELECT key, source FROM plan_decks WHERE owner_id = ? ORDER BY key").bind(&a).fetch_all(&pool).await.unwrap();
    assert_eq!(keys, vec![("energy".to_string(), "import".to_string()), ("energy-note".to_string(), "yama".to_string())]);
    assert_eq!(live_swaps(&pool, &a).await.len(), 3, "the tracked plan keeps its swaps");
}

fn rpc(tool: &str, args: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool, "arguments": args}})
}

async fn call(app: &Router, key: &str, tool: &str, args: Value) -> (bool, String) {
    let (status, r) = send(app, Method::POST, "/mcp", Some(key), Some(rpc(tool, args))).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    (r["result"]["isError"].as_bool().unwrap(), r["result"]["content"][0]["text"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn claude_sees_notes_as_deck_plans_and_stages_tracking() {
    let (app, pool) = app().await;
    let (a, session) = user(&pool, "a@example.com").await;
    save_note(&app, &session, &note()).await;
    let (status, made) = send(&app, Method::POST, "/api/me/tokens", Some(&session), Some(json!({"name": "Claude", "scope": "mcp"}))).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    let key = made["token"].as_str().unwrap();

    let (err, text) = call(&app, key, "overview", json!({})).await;
    assert!(!err, "{text}");
    assert!(text.contains("note id audit") && text.contains("deck key energy): no build tracked") && text.contains("b3 (Bracket 3, bracket 3)"), "{text}");
    let (err, text) = call(&app, key, "plan_deck", json!({"key": "energy"})).await;
    assert!(!err && text.starts_with("Not tracked yet"), "{text}");

    let (err, text) = call(&app, key, "track_build", json!({"note": "audit", "deck": "energy", "build": "b3"})).await;
    assert!(!err && text.contains("Track Bracket 3 as Energy's plan"), "{text}");
    let plans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_decks WHERE owner_id = ?").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(plans, 0, "staging changes nothing");
    let change: String = sqlx::query_scalar("SELECT id FROM assistant_changes WHERE owner_id = ? AND kind = 'track_build'").bind(&a).fetch_one(&pool).await.unwrap();
    let (status, applied) = send(&app, Method::POST, &format!("/api/assistant/changes/{change}/apply"), Some(&session), None).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["status"], "applied", "{applied}");

    let (_, text) = call(&app, key, "overview", json!({})).await;
    assert!(text.contains("tracking build b3 as plan key energy") && text.contains("Energy (plan key energy, active; build b3 of note audit)"), "{text}");
    let (err, text) = call(&app, key, "plan_deck", json!({"key": "energy"})).await;
    assert!(!err && text.contains("Made from build b3 of deck energy in note audit"), "{text}");
    let (err, text) = call(&app, key, "track_build", json!({"note": "audit", "deck": "energy", "build": "b3"})).await;
    assert!(!err && text.contains("already"), "{text}");
    let (err, text) = call(&app, key, "track_build", json!({"note": "audit", "deck": "energy", "build": null})).await;
    assert!(!err && text.contains("Stop tracking Energy's plan"), "{text}");
}

#[tokio::test]
async fn a_staged_build_is_not_applied_after_the_note_changes() {
    let (app, pool) = app().await;
    let (a, session) = user(&pool, "a@example.com").await;
    save_note(&app, &session, &note()).await;
    let (_, made) = send(&app, Method::POST, "/api/me/tokens", Some(&session), Some(json!({"name": "Claude", "scope": "mcp"}))).await;
    let key = made["token"].as_str().unwrap();
    let (err, text) = call(&app, key, "track_build", json!({"note": "audit", "deck": "energy", "build": "b3"})).await;
    assert!(!err, "{text}");
    let change: String = sqlx::query_scalar("SELECT id FROM assistant_changes WHERE owner_id = ? AND kind = 'track_build'").bind(&a).fetch_one(&pool).await.unwrap();

    let mut doc = note();
    doc["decks"][0]["builds"][0]["swaps"][0]["card_in"] = json!("Mystic Remora");
    save_note(&app, &session, &doc).await;
    let (status, view) = send(&app, Method::POST, &format!("/api/assistant/changes/{change}/apply"), Some(&session), None).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["status"], "pending", "{view}");
    assert!(view["error"].as_str().unwrap().contains("has changed since"), "{view}");
    let plans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_decks WHERE owner_id = ?").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(plans, 0, "what they reviewed isn't what would be applied");
}
