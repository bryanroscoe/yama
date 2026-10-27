use super::{Question, QuestionToken};
use crate::testutil::{app, deck, send, user};
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
async fn the_protocol_basics() {
    let (app, pool) = app().await;
    let (_, session) = user(&pool, "bryan@example.com").await;
    let mcp = key(&app, &session, Some("mcp")).await;

    let (status, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for n in ["overview", "deck", "plan_deck", "review_queue", "find_cards", "card", "check_list", "lab_runs", "lab_run", "lab_games", "precon", "start_lab_run", "more_lab_games", "run_lab_again", "cancel_lab_run", "set_condition"] {
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
