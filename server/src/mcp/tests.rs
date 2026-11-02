use super::{Question, QuestionToken};
use crate::testutil::{app, deck, power_user, send, user};
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn key(app: &Router, session: &str, scope: Option<&str>) -> String {
    let mut body = json!({"name": "Claude Code on the Mac"});
    if let Some(s) = scope {
        body["scope"] = json!(s);
    }
    let (status, made) = send(app, Method::POST, "/api/me/tokens", Some(session), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    made["token"].as_str().unwrap().to_string()
}

fn rpc(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
}

async fn call(app: &Router, token: &str, tool: &str, args: Value) -> (bool, String) {
    let (status, r) = send(app, Method::POST, "/mcp", Some(token), Some(rpc("tools/call", json!({"name": tool, "arguments": args})))).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    (r["result"]["isError"].as_bool().unwrap(), r["result"]["content"][0]["text"].as_str().unwrap().to_string())
}

#[tokio::test]
async fn only_an_mcp_key_or_a_question_token_gets_in() {
    let (app, pool) = app().await;
    let (id, session) = user(&pool, "bryan@example.com").await;
    let init = rpc("initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}));

    let (status, _) = send(&app, Method::POST, "/mcp", None, Some(init.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = send(&app, Method::POST, "/mcp", Some(&session), Some(init.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a session isn't a credential for the tools");
    let sync = key(&app, &session, None).await;
    let (status, _) = send(&app, Method::POST, "/mcp", Some(&sync), Some(init.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "a plan:sync key can't use the tools");
    let (status, _) = send(&app, Method::GET, "/api/plan/head", Some(&key(&app, &session, Some("mcp")).await), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "and an mcp key can't sync plans");

    let mcp = key(&app, &session, Some("mcp")).await;
    let (status, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(init.clone())).await;
    assert_eq!(status, StatusCode::OK, "{r}");
    assert_eq!(r["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(r["result"]["serverInfo"]["name"], "yama");
    assert!(r["result"]["capabilities"]["tools"].is_object());

    let (status, _) = send(&app, Method::POST, "/api/me/tokens", Some(&session), Some(json!({"name": "x", "scope": "admin"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // A question token works while its answer lasts, and not after.
    let q = QuestionToken::mint(&id, Question::default());
    let (status, _) = send(&app, Method::POST, "/mcp", Some(&q.token), Some(init.clone())).await;
    assert_eq!(status, StatusCode::OK);
    let t = q.token.clone();
    drop(q);
    let (status, _) = send(&app, Method::POST, "/mcp", Some(&t), Some(init)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn only_power_users_get_the_tools_that_start_simulations() {
    let (app, pool) = app().await;
    let (_, session) = user(&pool, "friend@example.com").await;
    let mcp = key(&app, &session, Some("mcp")).await;
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for n in ["start_lab_run", "more_lab_games", "run_lab_again"] {
        assert!(!names.contains(&n), "{n} offered to an account that isn't a power user");
        let (status, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/call", json!({"name": n, "arguments": {}})))).await;
        assert_eq!(status, StatusCode::OK, "{r}");
        assert!(r["error"]["message"].as_str().unwrap().contains("unknown tool"), "{r}");
    }
    // Their own data and runs stay readable.
    for n in ["overview", "lab_runs", "lab_run", "cancel_lab_run", "precon"] {
        assert!(names.contains(&n), "{n} missing from {names:?}");
    }
}

#[tokio::test]
async fn the_protocol_basics() {
    let (app, pool) = app().await;
    let (_, session) = power_user(&pool, "bryan@example.com").await;
    let mcp = key(&app, &session, Some("mcp")).await;

    let (status, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for n in ["overview", "deck", "plan_deck", "review_queue", "shopping_trip", "shopping_settings", "find_cards", "card", "check_list", "lab_runs", "lab_run", "lab_games", "precon", "start_lab_run", "more_lab_games", "run_lab_again", "cancel_lab_run", "set_condition"] {
        assert!(names.contains(&n), "{n} missing from {names:?}");
    }
    let start = r["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "start_lab_run").unwrap();
    assert!(start["inputSchema"]["properties"]["mode"]["enum"].as_array().unwrap().contains(&json!("tournament")));
    assert_eq!(start["inputSchema"]["properties"]["entrants"]["maxItems"], 256);
    for t in r["result"]["tools"].as_array().unwrap() {
        assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
    }

    let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
    let (status, _) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(note)).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("ping", json!({})))).await;
    assert_eq!(r["result"], json!({}));
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("resources/list", json!({})))).await;
    assert!(r["result"]["resources"].as_array().is_some());
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("unknown/method", json!({})))).await;
    assert_eq!(r["error"]["code"], -32601);
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/call", json!({"name": "rm_rf"})))).await;
    assert_eq!(r["error"]["code"], -32602);
    let (status, _) = send(&app, Method::GET, "/mcp", Some(&mcp), None).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);

    // A page on another site can't call the tools, even with a key.
    let req = Request::builder()
        .method(Method::POST)
        .uri("/mcp")
        .header(header::AUTHORIZATION, format!("Bearer {mcp}"))
        .header(header::ORIGIN, "https://evil.example")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(rpc("ping", json!({})).to_string()))
        .unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn tools_read_only_the_callers_own_data() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (_, b_session) = user(&pool, "someone@example.com").await;
    let (deck_id, _) = deck(&pool, &a, "Lorehold Spirit").await;
    let a_key = key(&app, &a_session, Some("mcp")).await;
    let b_key = key(&app, &b_session, Some("mcp")).await;

    let (err, text) = call(&app, &a_key, "overview", json!({})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Lorehold Spirit"), "{text}");
    let (err, text) = call(&app, &a_key, "deck", json!({"deck": "lorehold"})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Lorehold Spirit") && text.contains(&deck_id), "{text}");

    let (_, text) = call(&app, &b_key, "overview", json!({})).await;
    assert!(!text.contains("Lorehold"), "{text}");
    for wanted in [deck_id.as_str(), "Lorehold Spirit"] {
        let (err, text) = call(&app, &b_key, "deck", json!({"deck": wanted})).await;
        assert!(err);
        assert_eq!(text, "deck not found");
    }
    let (err, text) = call(&app, &b_key, "deck", json!({})).await;
    assert!(err);
    assert!(text.contains("deck is missing"), "{text}");
}

// ── staged changes (slice 2) ────────────────────────────────────────────────

async fn seed_cards(pool: &sqlx::SqlitePool) {
    for (id, name, type_line, ci) in [
        ("o-cmd", "Test Commander", "Legendary Creature — Elf", "G"),
        ("o-sol", "Sol Ring", "Artifact", ""),
        ("o-sig", "Arcane Signet", "Artifact", ""),
        ("o-forest", "Forest", "Basic Land — Forest", "G"),
    ] {
        sqlx::query(
            "INSERT INTO cards (oracle_id, name, type_line, color_identity, legalities, default_printing, updated_at)
             VALUES (?, ?, ?, ?, '{\"commander\":\"legal\"}', ?, 'now')",
        )
        .bind(id)
        .bind(name)
        .bind(type_line)
        .bind(ci)
        .bind(format!("p-{id}"))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(id).execute(pool).await.unwrap();
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at)
             VALUES (?, ?, ?, 'tst', 'Test Set', '1', 'en', 'now')",
        )
        .bind(format!("p-{id}"))
        .bind(id)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
    }
}

async fn my_deck(pool: &sqlx::SqlitePool, owner: &str) -> String {
    use crate::decks::{Board, DeckCard};
    let card = |id: &str, name: &str, board| DeckCard { oracle_id: id.into(), name: name.into(), qty: 1, board };
    let cards = vec![card("o-cmd", "Test Commander", Board::Commander), card("o-sol", "Sol Ring", Board::Main), card("o-forest", "Forest", Board::Main)];
    crate::decks::create_deck_with_cards(pool, owner, "Elf Ball", None, cards).await.unwrap()
}

async fn current_cards(pool: &sqlx::SqlitePool, deck: &str) -> (Vec<String>, Option<String>) {
    let (v, note): (String, Option<String>) = sqlx::query_as("SELECT v.id, v.note FROM decks d JOIN deck_versions v ON v.id = d.current_version_id WHERE d.id = ?")
        .bind(deck)
        .fetch_one(pool)
        .await
        .unwrap();
    let mut names: Vec<String> = crate::decks::load_version_cards(pool, &v).await.unwrap().into_iter().map(|c| c.name).collect();
    names.sort();
    (names, note)
}

fn change_id(text: &str) -> String {
    text.lines().find_map(|l| l.strip_prefix("Change id: ")).expect("a change id").trim().to_string()
}

#[tokio::test]
async fn ask_claude_stages_but_cannot_apply() {
    let (app, pool) = app().await;
    let (id, _) = user(&pool, "bryan@example.com").await;
    let q = QuestionToken::mint(&id, Question { conversation_id: "conv-1".into(), message_id: "msg-1".into() });
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&q.token), Some(rpc("tools/list", json!({})))).await;
    let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"edit_deck") && names.contains(&"changes"), "{names:?}");
    assert!(!names.contains(&"apply_change") && !names.contains(&"discard_change"), "{names:?}");
    let edit = r["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "edit_deck").unwrap();
    assert_eq!(edit["annotations"]["readOnlyHint"], false);
    assert_eq!(edit["annotations"]["destructiveHint"], false);
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&q.token), Some(rpc("tools/call", json!({"name": "apply_change", "arguments": {"id": "x"}})))).await;
    assert_eq!(r["error"]["code"], -32602);
}

#[tokio::test]
async fn a_deck_edit_waits_for_review_then_applies_once() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (_, b_session) = user(&pool, "someone@example.com").await;
    let deck_id = my_deck(&pool, &a).await;
    let before = current_cards(&pool, &deck_id).await.0;

    // Through Ask Claude: staged under the answer, nothing changes.
    let q = QuestionToken::mint(&a, Question { conversation_id: "conv-1".into(), message_id: "msg-1".into() });
    let (err, text) = call(&app, &q.token, "edit_deck", json!({"deck": "elf", "add": ["arcane signet"], "remove": ["Sol Ring"], "note": "Cheaper ramp test"})).await;
    assert!(!err, "{text}");
    assert!(text.contains("nothing has changed") && text.contains("Elf Ball: +Arcane Signet, \u{2212}Sol Ring"), "{text}");
    assert!(text.contains("never say it's done"), "{text}");
    let first = change_id(&text);
    assert_eq!(current_cards(&pool, &deck_id).await.0, before, "staging changes nothing");

    let (status, list) = send(&app, Method::GET, "/api/assistant/changes?conversation=conv-1", Some(&a_session), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list[0]["id"], first.as_str());
    assert_eq!(list[0]["message_id"], "msg-1");
    assert_eq!(list[0]["via"], "question");
    assert_eq!(list[0]["status"], "pending");
    assert_eq!(list[0]["preview"]["kind"], "deck_edit");
    assert_eq!(list[0]["preview"]["target"], "Elf Ball");
    assert_eq!(list[0]["preview"]["add"][0]["name"], "Arcane Signet");
    assert_eq!(list[0]["preview"]["add"][0]["qty"], 1);
    assert_eq!(list[0]["preview"]["add"][0]["type_line"], "Artifact");
    assert_eq!(list[0]["preview"]["remove"][0]["name"], "Sol Ring");
    assert_eq!(list[0]["preview"]["explanation"], "Cheaper ramp test");
    assert!(list[0].get("payload").is_none(), "execution payload stays private");

    // Someone else can neither see nor apply it.
    let (_, theirs) = send(&app, Method::GET, "/api/assistant/changes", Some(&b_session), None).await;
    assert_eq!(theirs, json!([]));
    let (status, _) = send(&app, Method::POST, &format!("/api/assistant/changes/{first}/apply"), Some(&b_session), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Mistakes are refused before anything is staged.
    let (err, text) = call(&app, &q.token, "edit_deck", json!({"deck": "Elf Ball", "add": ["Ring"]})).await;
    assert!(err && text.contains("doesn't know") && text.contains("Sol Ring"), "{text}");
    let (err, text) = call(&app, &q.token, "edit_deck", json!({"deck": "Elf Ball", "remove": ["Test Commander"]})).await;
    assert!(err && text.contains("is the commander"), "{text}");
    let (err, text) = call(&app, &q.token, "edit_deck", json!({"deck": "Elf Ball", "remove": ["Arcane Signet"]})).await;
    assert!(err && text.contains("isn't in Elf Ball"), "{text}");
    let (err, text) = call(&app, &q.token, "edit_deck", json!({"deck": "Elf Ball", "add": ["Sol Ring"]})).await;
    assert!(err && text.contains("would break the deck") && text.contains("singleton"), "{text}");

    // The owner applies it: a new version with Claude's note. A second apply is refused.
    let (status, applied) = send(&app, Method::POST, &format!("/api/assistant/changes/{first}/apply"), Some(&a_session), None).await;
    assert_eq!(status, StatusCode::OK, "{applied}");
    assert_eq!(applied["status"], "applied", "{applied}");
    assert_eq!(applied["result"]["link"], format!("/decks/{deck_id}"));
    let (cards, note) = current_cards(&pool, &deck_id).await;
    assert_eq!(cards, ["Arcane Signet", "Forest", "Test Commander"]);
    assert_eq!(note.as_deref(), Some("Suggested change: Cheaper ramp test"));
    let (status, _) = send(&app, Method::POST, &format!("/api/assistant/changes/{first}/apply"), Some(&a_session), None).await;
    assert_eq!(status, StatusCode::CONFLICT);

    // A change made against an older list fails with the reason and stays pending.
    let mcp = key(&app, &a_session, Some("mcp")).await;
    let (_, text) = call(&app, &mcp, "edit_deck", json!({"deck": "Elf Ball", "add": ["Sol Ring"]})).await;
    assert!(text.contains("apply_change"), "an outside client hears it may apply after a yes: {text}");
    let stale = change_id(&text);
    let (status, _) = send(&app, Method::PUT, &format!("/api/decks/{deck_id}"), Some(&a_session), Some(json!({"cards": [{"oracle_id": "o-cmd", "name": "Test Commander", "qty": 1, "board": "commander"}]}))).await;
    assert_eq!(status, StatusCode::OK);
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": stale})).await;
    assert!(err && text.contains("changed after this was suggested"), "{text}");
    let (_, waiting) = call(&app, &mcp, "changes", json!({})).await;
    assert!(waiting.contains(&stale) && waiting.contains("failed"), "{waiting}");
    let (err, text) = call(&app, &mcp, "discard_change", json!({"id": stale})).await;
    assert!(!err, "{text}");
    let (_, waiting) = call(&app, &mcp, "changes", json!({})).await;
    assert_eq!(waiting, "No changes are waiting for their review.");
    let (status, all) = send(&app, Method::GET, "/api/assistant/changes?status=all", Some(&a_session), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(all.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn plan_and_collection_changes_apply_through_their_own_ops() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    sqlx::query(
        "INSERT INTO plan_decks (id, owner_id, key, name, source, commander, created_at, updated_at) VALUES ('pd1', ?, 'elf-ball', 'Elf Ball', 'import', '[\"Test Commander\"]', 'now', 'now')",
    )
    .bind(&a)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO plan_swaps (id, owner_id, plan_deck_id, ext_key, stage, role, src, in_name, out_name, created_at, updated_at)
         VALUES ('s1', ?, 'pd1', 'plan|Elf Ball|Arcane Signet|Sol Ring', 'proposed', 'swap', 'buy', 'Arcane Signet', 'Sol Ring', 'now', 'now')",
    )
    .bind(&a)
    .execute(&pool)
    .await
    .unwrap();
    let mcp = key(&app, &a_session, Some("mcp")).await;

    let (err, text) = call(&app, &mcp, "propose_swap", json!({"plan": "Elf Ball", "card_in": "Forest", "card_out": "Sol Ring", "why": "More lands"})).await;
    assert!(!err, "{text}");
    let idea = change_id(&text);
    let (err, text) = call(&app, &mcp, "answer_review", json!({"plan": "elf-ball", "card_in": "arcane signet", "decision": "want", "note": "Yes"})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Review, Elf Ball: Want for Arcane Signet for Sol Ring"), "{text}");
    let review = change_id(&text);
    let (err, text) = call(&app, &mcp, "mark_bought", json!({"plan": "elf-ball", "card_in": "Arcane Signet", "on": "2026-10-20", "price_paid": 1.5, "store": "Pat's"})).await;
    assert!(!err, "{text}");
    let bought = change_id(&text);
    let (err, text) = call(&app, &mcp, "answer_review", json!({"plan": "elf-ball", "card_in": "Forest", "decision": "want"})).await;
    assert!(err && text.contains("no swap putting in Forest"), "{text}");
    let inputs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_inputs").fetch_one(&pool).await.unwrap();
    assert_eq!(inputs, 0, "nothing reaches the planner before it's applied");

    for id in [&idea, &review, &bought] {
        let (err, text) = call(&app, &mcp, "apply_change", json!({"id": id})).await;
        assert!(!err, "{text}");
    }
    let ops: Vec<(String, String, String)> = sqlx::query_as("SELECT kind, op_id, status FROM plan_inputs ORDER BY seq").fetch_all(&pool).await.unwrap();
    assert_eq!(ops.len(), 3);
    assert!(ops.iter().all(|(_, op, status)| op.starts_with("claude-") && status == "applied"), "{ops:?}");
    let decision: String = sqlx::query_scalar("SELECT decision FROM plan_reviews WHERE swap_key = 'plan|Elf Ball|Arcane Signet|Sol Ring'").fetch_one(&pool).await.unwrap();
    assert_eq!(decision, "want");
    let mark: String = sqlx::query_scalar("SELECT payload FROM plan_marks WHERE kind = 'bought'").fetch_one(&pool).await.unwrap();
    assert!(mark.contains("2026-10-20") && mark.contains("Pat's"), "{mark}");

    // Collection: add three to a binder, then move two to a deck box.
    for (kind, name) in [("binder", "Trade Binder"), ("deck", "Elf Ball Box")] {
        sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?, ?, ?, ?, 'now')").bind(name).bind(&a).bind(kind).bind(name).execute(&pool).await.unwrap();
    }
    let (err, text) = call(&app, &mcp, "add_to_collection", json!({"card": "Sol Ring", "qty": 3, "container": "trade binder"})).await;
    assert!(!err, "{text}");
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
    assert!(!err, "{text}");
    let (err, text) = call(&app, &mcp, "move_cards", json!({"card": "Sol Ring", "qty": 5, "from": "Trade Binder", "to": "Elf Ball Box"})).await;
    assert!(err && text.contains("holds 3"), "{text}");
    let (err, text) = call(&app, &mcp, "move_cards", json!({"card": "Sol Ring", "qty": 2, "from": "Trade Binder", "to": "Elf Ball Box"})).await;
    assert!(!err, "{text}");
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
    assert!(!err, "{text}");
    let held: Vec<(Option<String>, i64)> =
        sqlx::query_as("SELECT container_id, qty FROM collection_items WHERE owner_id = ? ORDER BY container_id").bind(&a).fetch_all(&pool).await.unwrap();
    assert_eq!(held, [(Some("Elf Ball Box".to_string()), 2), (Some("Trade Binder".to_string()), 1)]);

    // Condition: grade everything in the binder, leaving the deck box near mint.
    let (err, text) = call(&app, &mcp, "set_condition", json!({"container": "Trade Binder", "condition": "XX"})).await;
    assert!(err && text.contains("NM, LP"), "{text}");
    let (err, text) = call(&app, &mcp, "set_condition", json!({"container": "Trade Binder", "condition": "lp"})).await;
    assert!(!err && text.contains("Mark 1 cards in Trade Binder lightly played"), "{text}");
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
    assert!(!err, "{text}");
    let graded: Vec<(Option<String>, String)> =
        sqlx::query_as("SELECT container_id, condition FROM collection_items WHERE owner_id = ? ORDER BY container_id").bind(&a).fetch_all(&pool).await.unwrap();
    assert_eq!(graded, [(Some("Elf Ball Box".to_string()), "NM".to_string()), (Some("Trade Binder".to_string()), "LP".to_string())]);
    let (err, text) = call(&app, &mcp, "set_condition", json!({"container": "Trade Binder", "card": "Sol Ring", "condition": "LP"})).await;
    assert!(err && text.contains("already lightly played"), "{text}");
}

#[tokio::test]
async fn tournament_pasted_lists_are_frozen_without_creating_decks_or_starting_games() {
    let (app, pool) = app().await;
    let (owner, session) = power_user(&pool, "commander-test@example.com").await;
    let token = key(&app, &session, Some("mcp")).await;
    let a = "Commander\n1 Commander A\nDeck\n99 Island\n";
    let b = "Commander\n1 Commander B\nDeck\n99 Island\n";
    let (error, text) = call(&app, &token, "start_lab_run", json!({"mode":"tournament","games":100,"entrant_lists":[{"label":"A","list":a},{"label":"B","list":b}]})).await;
    assert!(!error, "{text}");
    let payload: String = sqlx::query_scalar("SELECT payload FROM assistant_changes WHERE owner_id=? AND kind='start_lab_run'").bind(&owner).fetch_one(&pool).await.unwrap();
    let p: Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(p["entrants"][0]["text"], a.trim());
    assert_eq!(p["entrants"][1]["text"], b.trim());
    assert!(p.get("field").is_none());
    let runs: i64 = sqlx::query_scalar("SELECT count(*) FROM lab_experiments").fetch_one(&pool).await.unwrap();
    let decks: i64 = sqlx::query_scalar("SELECT count(*) FROM decks WHERE owner_id=?").bind(&owner).fetch_one(&pool).await.unwrap();
    assert_eq!((runs, decks), (0, 0));
    for bad in [json!([{"label":"A"}]),json!([{"label":"","list":a}]),json!([{"label":"A","list":""}])] {
        assert!(call(&app, &token, "start_lab_run", json!({"mode":"tournament","entrant_lists":bad})).await.0);
    }
}

#[tokio::test]
async fn shopping_rules_and_store_preferences_are_staged_then_applied() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    for (id, key, name, sort) in [("st1", "black-castle", "Black Castle Gamez", 1), ("st2", "pats", "Pat's Games", 2)] {
        sqlx::query(
            "INSERT INTO plan_stores (id, owner_id, key, name, kind, sort, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'local', ?, 'import', 'now', 'now')",
        )
        .bind(id)
        .bind(&a)
        .bind(key)
        .bind(name)
        .bind(sort)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO plan_settings (owner_id, effective_from, rules, note, origin, created_at) VALUES (?, '2026-10-28', ?, 'Imported', 'import', 'now')")
        .bind(&a)
        .bind(json!({"currency": "USD", "ceiling_other_usd": 2.0, "max_over_market_pct": 100, "proxy_cost_usd": 0.3}).to_string())
        .execute(&pool)
        .await
        .unwrap();
    let mcp = key(&app, &a_session, Some("mcp")).await;

    let (err, text) = call(&app, &mcp, "shopping_settings", json!({})).await;
    assert!(!err, "{text}");
    assert!(text.contains("the set from 2026-10-28 (from their plan import)"), "{text}");
    assert!(text.contains("Sealed precons: no limit set."), "{text}");
    assert!(text.contains("- Black Castle Gamez (key black-castle): fine to go, not placed in their order"), "{text}");

    // Bryan's rule, with the sealed cap; parts left out would keep the rule in force.
    let (err, text) = call(
        &app,
        &mcp,
        "set_shopping_rules",
        json!({"max_usd": 2, "always_ok_usd": 0.5, "tiers": [{"market_under": 1, "max_multiple": 2}, {"market_under": null, "max_multiple": 1.5}], "sealed_max_usd": 51}),
    )
    .await;
    assert!(!err, "{text}");
    assert!(text.contains("at most 1.5× market when market is $1.00 or more") && text.contains("at most $51.00 a deck"), "{text}");
    let rules = change_id(&text);
    let (err, text) = call(&app, &mcp, "set_shopping_rules", json!({"always_ok_usd": 5})).await;
    assert!(err && text.contains("can't be above the most a card may cost"), "{text}");

    let (err, text) = call(&app, &mcp, "set_store_preference", json!({"store": "black castle gamez", "preference": "favorite", "hassle": 1, "premium_usd": 0.25})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Black Castle Gamez: their favourite, to support"), "{text}");
    let pref = change_id(&text);
    let (err, text) = call(&app, &mcp, "set_store_preference", json!({"store": "Nowhere"})).await;
    assert!(err && text.contains("Their stores: Black Castle Gamez (black-castle), Pat's Games (pats)"), "{text}");
    let (err, _) = call(&app, &mcp, "set_store_preference", json!({"store": "pats", "hassle": 0})).await;
    assert!(err);

    let sets: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_settings WHERE owner_id = ?").bind(&a).fetch_one(&pool).await.unwrap();
    let prefs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plan_store_prefs").fetch_one(&pool).await.unwrap();
    assert_eq!((sets, prefs), (1, 0), "nothing changes before it's applied");

    for id in [&rules, &pref] {
        let (err, text) = call(&app, &mcp, "apply_change", json!({"id": id})).await;
        assert!(!err, "{text}");
    }
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let (origin, rules): (String, String) = sqlx::query_as("SELECT origin, rules FROM plan_settings WHERE owner_id = ? AND effective_from = ?")
        .bind(&a)
        .bind(&today)
        .fetch_one(&pool)
        .await
        .unwrap();
    let rules: Value = serde_json::from_str(&rules).unwrap();
    assert_eq!(origin, "yama");
    assert_eq!(rules["proxy_cost_usd"], 0.3, "a copy of the set in force");
    assert_eq!(rules["sealed_max_usd"], 51.0);
    assert_eq!(rules["local_buy"]["tiers"][1], json!({"market_under": null, "max_multiple": 1.5}));
    let row: (String, Option<i64>, Option<f64>) = sqlx::query_as("SELECT preference, hassle, premium_usd FROM plan_store_prefs WHERE owner_id = ? AND store_key = 'black-castle'")
        .bind(&a)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row, ("favorite".into(), Some(1), Some(0.25)));

    // Another store to first place: the others move down, no two share a place.
    let (err, text) = call(&app, &mcp, "set_store_preference", json!({"store": "pats", "hassle": 1})).await;
    assert!(!err, "{text}");
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
    assert!(!err, "{text}");
    let places: Vec<(String, Option<i64>)> = sqlx::query_as("SELECT store_key, hassle FROM plan_store_prefs WHERE owner_id = ? ORDER BY store_key")
        .bind(&a)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(places, [("black-castle".to_string(), Some(2)), ("pats".to_string(), Some(1))]);

    // A staged change applies only what it names, over edits made since it was staged.
    let (err, text) = call(&app, &mcp, "set_store_preference", json!({"store": "pats", "premium_usd": 0.1})).await;
    assert!(!err, "{text}");
    let staged = change_id(&text);
    let (status, _) = send(&app, Method::PUT, "/api/plan/stores/pats/preference", Some(&a_session), Some(json!({"preference": "maybe", "note": "Far", "hassle": 1}))).await;
    assert_eq!(status, StatusCode::OK);
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": staged})).await;
    assert!(!err, "{text}");
    let pats: (String, Option<String>, Option<f64>) = sqlx::query_as("SELECT preference, note, premium_usd FROM plan_store_prefs WHERE owner_id = ? AND store_key = 'pats'")
        .bind(&a)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(pats, ("maybe".into(), Some("Far".into()), Some(0.1)));
    // An order naming one store renumbers the rest after it.
    let (status, _) = send(&app, Method::PUT, "/api/plan/store-order", Some(&a_session), Some(json!({"keys": ["black-castle"]}))).await;
    assert_eq!(status, StatusCode::OK);
    let places: Vec<(String, Option<i64>)> = sqlx::query_as("SELECT store_key, hassle FROM plan_store_prefs WHERE owner_id = ? ORDER BY store_key")
        .bind(&a)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(places, [("black-castle".to_string(), Some(1)), ("pats".to_string(), Some(2))]);
    let (err, text) = call(&app, &mcp, "shopping_trip", json!({"stores": ["black-castle", "nowhere"]})).await;
    assert!(err && text.contains("No store with key \"nowhere\". Their store keys: black-castle, pats."), "{text}");

    let (_, text) = call(&app, &mcp, "shopping_settings", json!({})).await;
    assert!(text.contains(&format!("the set from {today} (made in Yama)")), "{text}");
    assert!(text.contains("- Black Castle Gamez (key black-castle): their favourite, to support, up to $0.25 more a card here\n"), "{text}");

}

#[tokio::test]
async fn store_stock_reads_snapshots_and_check_stores_only_stages() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    for (id, key, name, homepage, sort) in [("st1", "pats", "Pat's Games", Some("https://patsgames.com"), 1), ("st2", "card-gurus", "Card Gurus", None, 2)] {
        sqlx::query("INSERT INTO plan_stores (id, owner_id, key, name, kind, homepage, sort, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'local', ?, ?, 'import', 'now', 'now')")
            .bind(id)
            .bind(&a)
            .bind(key)
            .bind(name)
            .bind(homepage)
            .bind(sort)
            .execute(&pool)
            .await
            .unwrap();
    }
    let mcp = key(&app, &a_session, Some("mcp")).await;
    let (err, text) = call(&app, &mcp, "store_stock", json!({"store": "pats", "cards": ["Sol Ring"]})).await;
    assert!(!err, "{text}");
    assert!(text.contains("No stock snapshot of Pat's Games yet") && text.contains("- Sol Ring: no answer"), "{text}");

    let file = json!({
        "format": "yama-store-snapshot/1", "store": "pats", "fetched_at": "2026-11-01T16:24:00Z", "cards": ["Sol Ring", "Mana Vault"],
        "listings": [{"card": "Sol Ring", "title": "Sol Ring [C21 - 263]", "condition": "Near Mint", "finish": "nonfoil", "price": 1.0, "available": true, "qty": 2}],
    });
    let (s, v) = send(&app, Method::POST, "/api/plan/stock/import", Some(&a_session), Some(file)).await;
    assert!(s.is_success(), "{v}");
    let (err, text) = call(&app, &mcp, "store_stock", json!({"store": "Pat's Games", "cards": ["Sol Ring", "Mana Vault"]})).await;
    assert!(!err, "{text}");
    assert!(text.contains("- Sol Ring: $1.00, Sol Ring [C21 - 263] (Near Mint, non-foil, 2 in stock)"), "{text}");
    assert!(text.contains("- Mana Vault: Not found in stock"), "{text}");

    // A store Yama can't read is refused at once; a readable one is only staged.
    let (err, text) = call(&app, &mcp, "check_stores", json!({"stores": ["card gurus"], "cards": ["Sol Ring"]})).await;
    assert!(err && text.contains("can't read Card Gurus's stock") && text.contains("Nothing was staged"), "{text}");
    let (err, text) = call(&app, &mcp, "check_stores", json!({"stores": ["pats"], "cards": ["Sol Ring"]})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Staged for their review") && text.contains("Check stock: Pat's Games"), "{text}");
    let running: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM store_snapshots WHERE owner_id = ? AND source != 'import'").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(running, 0, "nothing is fetched until they apply it");
    let payload: String = sqlx::query_scalar("SELECT payload FROM assistant_changes WHERE owner_id = ? AND kind = 'check_stores'").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&payload).unwrap(), json!({"stores": ["pats"], "cards": ["Sol Ring"], "yestcg": false}));
}

#[tokio::test]
async fn add_wish_is_staged_then_on_the_shopping_list() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES ('o-sol', 'Sol Ring', 'Artifact', 'now')").execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('Sol Ring', 'o-sol')").execute(&pool).await.unwrap();
    let mcp = key(&app, &a_session, Some("mcp")).await;
    let (err, text) = call(&app, &mcp, "add_wish", json!({"name": "sol ring", "deck": "Kraum & Tymna (cEDH)", "why": "One of the four local buys"})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Add Sol Ring to their shopping list") && text.contains("not a Yama deck; kept as a label"), "{text}");
    let (err, text) = call(&app, &mcp, "add_wish", json!({"name": "Not A Card"})).await;
    assert!(err && text.contains("doesn't know a card"), "{text}");
    let (_, text) = call(&app, &mcp, "shopping_list", json!({})).await;
    assert!(text.contains("To buy (these decide the stores): 0"), "staged, not applied: {text}");

    let id: String = sqlx::query_scalar("SELECT id FROM assistant_changes WHERE owner_id = ? AND kind = 'add_wish'").bind(&a).fetch_one(&pool).await.unwrap();
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": id})).await;
    assert!(!err, "{text}");
    let (_, text) = call(&app, &mcp, "shopping_list", json!({})).await;
    assert!(text.contains("- Sol Ring (added to their list, for Kraum & Tymna (cEDH)): not on the trip: no store check recorded"), "{text}");
    let source: String = sqlx::query_scalar("SELECT source FROM shopping_wants WHERE owner_id = ?").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(source, "assistant");
}
