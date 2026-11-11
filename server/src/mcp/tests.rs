use super::{Question, QuestionToken};
use crate::testutil::{app, deck, power_user, send, user};
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use serde_json::{Value, json};
use tower::ServiceExt;

pub(super) async fn key(app: &Router, session: &str, scope: Option<&str>) -> String {
    let mut body = json!({"name": "Claude Code on the Mac"});
    if let Some(s) = scope {
        body["scope"] = json!(s);
    }
    let (status, made) = send(app, Method::POST, "/api/me/tokens", Some(session), Some(body)).await;
    assert_eq!(status, StatusCode::OK, "{made}");
    made["token"].as_str().unwrap().to_string()
}

pub(super) fn rpc(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
}

pub(super) async fn call(app: &Router, token: &str, tool: &str, args: Value) -> (bool, String) {
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
    let (id, session) = user(&pool, "friend@example.com").await;
    // A run of their own from when they could start one: still theirs to read and cancel.
    sqlx::query(
        "INSERT INTO lab_experiments (id, owner_id, name, status, spec, games_total, games_done, engine, card_data, runner, difficulty, created_at, updated_at)
         VALUES ('run-old', ?, 'An old run', 'done', '{}', 100, 100, 'phase', 'x', 'x', 'Easy', '2026-11-01T00:00:00Z', 't')",
    )
    .bind(&id)
    .execute(&pool)
    .await
    .unwrap();
    let mcp = key(&app, &session, Some("mcp")).await;
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    // By their names and by the names they had before the renames.
    for n in ["start_lab_run", "add_lab_games", "rerun_lab_run", "more_lab_games", "run_lab_again"] {
        assert!(!names.contains(&n), "{n} offered to an account that isn't a power user");
        let (status, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/call", json!({"name": n, "arguments": {}})))).await;
        assert_eq!(status, StatusCode::OK, "{r}");
        assert!(r["error"]["message"].as_str().unwrap().contains("unknown tool"), "{r}");
    }
    // Their own data and runs stay readable.
    for n in ["get_overview", "list_lab_runs", "get_lab_run", "cancel_lab_run", "get_precon"] {
        assert!(names.contains(&n), "{n} missing from {names:?}");
    }
}

#[tokio::test]
async fn the_protocol_basics() {
    let (app, pool) = app().await;
    let (id, session) = power_user(&pool, "bryan@example.com").await;
    // The store tools are listed for an account that has a store.
    sqlx::query("INSERT INTO plan_stores (id, owner_id, key, name, kind, origin, created_at, updated_at) VALUES ('s1', ?, 'pats', 'Pat''s Games', 'local', 'yama', 't', 't')").bind(&id).execute(&pool).await.unwrap();
    let mcp = key(&app, &session, Some("mcp")).await;

    let (status, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    assert_eq!(status, StatusCode::OK);
    let names: Vec<&str> = r["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for n in ["get_overview", "get_deck", "get_plan", "get_review_queue", "get_shopping_trip", "get_shopping_settings", "search_cards", "get_cards", "check_deck_list", "list_lab_runs", "get_lab_run", "list_lab_games", "get_precon", "start_lab_run", "add_lab_games", "rerun_lab_run", "cancel_lab_run", "set_condition"] {
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
    assert!(r["result"]["resources"].as_array().unwrap().iter().any(|v| v["uri"] == "yama://shopping/workflow"));
    let (status, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("resources/read", json!({"uri":"yama://shopping/workflow"})))).await;
    assert_eq!(status, StatusCode::OK);
    let content = &r["result"]["contents"][0];
    assert_eq!(content["mimeType"], "text/markdown");
    assert_eq!(content["text"], include_str!("../../../docs/local-shopping-workflow.md"));
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

#[tokio::test]
async fn game_history_reads_only_the_callers_games() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (_, b_session) = user(&pool, "someone@example.com").await;
    sqlx::query("INSERT INTO games(id,mode,created_by,status,started_at,turns,winner_seat) VALUES ('g-1','in_person',?,'finished','2026-11-01',9,0)")
        .bind(&a).execute(&pool).await.unwrap();
    let (friend, _) = user(&pool, "friend@example.com").await;
    sqlx::query("INSERT INTO game_seats(game_id,seat,guest_name,commander_name,user_id) VALUES ('g-1',0,'Kelly','Atraxa, Praetors'' Voice',NULL),('g-1',1,NULL,'Krenko, Mob Boss',?)")
        .bind(&friend).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO game_events(game_id,seq,actor_seat,kind,payload,created_at) VALUES ('g-1',1,0,'life','{\"seat\":1,\"delta\":-7}','2026-11-01T20:00:00Z')")
        .execute(&pool).await.unwrap();
    let a_key = key(&app, &a_session, Some("mcp")).await;
    let b_key = key(&app, &b_session, Some("mcp")).await;

    let (err, text) = call(&app, &a_key, "games", json!({"search": "krenko"})).await;
    assert!(!err, "{text}");
    let page: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(page["games"][0]["id"], "g-1", "{text}");
    assert_eq!(page["games"][0]["seats"].as_array().unwrap().len(), 2);
    assert!(!text.contains(&friend) && !text.contains(&a), "no account ids: {text}");
    let (err, text) = call(&app, &a_key, "games", json!({"filter": "sideways"})).await;
    assert!(err, "{text}");

    let (err, text) = call(&app, &a_key, "game", json!({"id": "g-1"})).await;
    assert!(!err, "{text}");
    let game: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(game["event_count"], 1);
    assert!(!text.contains(&friend), "no account ids: {text}");
    assert!(game.get("events").is_none(), "events only when asked");
    let (_, text) = call(&app, &a_key, "game", json!({"id": "g-1", "events": true})).await;
    let game: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(game["events"][0]["kind"], "life");

    let (_, text) = call(&app, &b_key, "games", json!({})).await;
    assert!(!text.contains("g-1"), "{text}");
    let (err, text) = call(&app, &b_key, "game", json!({"id": "g-1"})).await;
    assert!(err);
    assert_eq!(text, "game not found");
}

#[tokio::test]
async fn collection_summary_counts_only_the_callers_containers() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (b, b_session) = user(&pool, "someone@example.com").await;
    for (id, owner, name) in [("c-a", &a, "Trade binder"), ("c-b", &b, "Secret box")] {
        sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?,?,'binder',?,'t')")
            .bind(id).bind(owner).bind(name).execute(&pool).await.unwrap();
    }
    let a_key = key(&app, &a_session, Some("mcp")).await;
    let b_key = key(&app, &b_session, Some("mcp")).await;
    let (err, text) = call(&app, &a_key, "collection_summary", json!({})).await;
    assert!(!err, "{text}");
    let out: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(out["totals"]["copies"], 0);
    assert_eq!(out["containers"][0]["name"], "Trade binder");
    assert!(out["containers"][0].get("art").is_none());
    assert!(!text.contains("Secret box"), "{text}");
    let (_, text) = call(&app, &b_key, "collection_summary", json!({})).await;
    assert!(text.contains("Secret box") && !text.contains("Trade binder"), "{text}");
}

#[tokio::test]
async fn playgroups_show_only_groups_the_caller_is_in() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (_, b_session) = user(&pool, "someone@example.com").await;
    sqlx::query("INSERT INTO playgroups(id,name,owner_id,join_code,created_at) VALUES ('pg-1','Friday night',?,'SECRET','t')")
        .bind(&a).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO playgroup_members(id,playgroup_id,user_id,guest_name,created_at) VALUES ('m-1','pg-1',?,NULL,'t'),('m-2','pg-1',NULL,'Kelly','t')")
        .bind(&a).execute(&pool).await.unwrap();
    let a_key = key(&app, &a_session, Some("mcp")).await;
    let b_key = key(&app, &b_session, Some("mcp")).await;

    let (err, text) = call(&app, &a_key, "playgroups", json!({})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Friday night") && text.contains("Kelly"), "{text}");
    assert!(!text.contains("SECRET") && !text.contains(&a) && !text.contains("m-1"), "no join code, account or member ids: {text}");
    sqlx::query("INSERT INTO games(id,mode,playgroup_id,created_by,status,started_at,ended_at,turns,winner_seat) VALUES ('g-pg','in_person','pg-1',?,'finished','2026-11-01T19:00:00Z','2026-11-01T20:00:00Z',8,0)")
        .bind(&a).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO game_seats(game_id,seat,user_id,member_id,guest_name,commander_name) VALUES ('g-pg',0,?,'m-1',NULL,'Atraxa'),('g-pg',1,NULL,'m-2','Kelly','Krenko')")
        .bind(&a).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &a_key, "playgroups", json!({"id": "pg-1"})).await;
    assert!(!err, "{text}");
    assert!(text.contains("\"games\":1") && text.contains("Kelly"), "{text}");
    assert!(!text.contains(&a) && !text.contains("m-2"), "no account or member ids in stats: {text}");

    let (_, text) = call(&app, &b_key, "playgroups", json!({})).await;
    assert!(!text.contains("Friday night"), "{text}");
    let (err, text) = call(&app, &b_key, "playgroups", json!({"id": "pg-1"})).await;
    assert!(err);
    assert_eq!(text, "playgroup not found");
}

// ── staged changes (slice 2) ────────────────────────────────────────────────

pub(super) async fn seed_cards(pool: &sqlx::SqlitePool) {
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
    assert!(names.contains(&"edit_deck") && names.contains(&"list_changes"), "{names:?}");
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
        "listings": [{"card": "Sol Ring", "title": "Sol Ring [C21 - 263]", "condition": "Near Mint", "finish": "nonfoil", "price": 1.0, "available": true, "qty": 2, "url": "https://patsgames.com/products/sol-ring", "variant": "123456"}],
    });
    let (s, v) = send(&app, Method::POST, "/api/plan/stock/import", Some(&a_session), Some(file)).await;
    assert!(s.is_success(), "{v}");
    let (err, text) = call(&app, &mcp, "store_stock", json!({"store": "Pat's Games", "cards": ["Sol Ring", "Mana Vault"]})).await;
    assert!(!err, "{text}");
    assert!(text.contains("- Sol Ring: $1.00, Sol Ring [C21 - 263] (Near Mint, non-foil, 2 in stock)"), "{text}");
    assert!(text.contains("- Mana Vault: Not found in stock"), "{text}");
    assert!(text.contains("Listing: https://patsgames.com/products/sol-ring"), "{text}");
    assert!(text.contains("Cart variant: 123456"), "{text}");
    // A listing that didn't say whether it's available is said to be unknown, with its price.
    let quiet = json!({
        "format": "yama-store-snapshot/1", "store": "pats", "fetched_at": "2026-11-01T17:00:00Z", "cards": ["Sol Ring"],
        "listings": [{"card": "Sol Ring", "title": "Sol Ring [C21 - 263]", "price": 0.9}],
    });
    assert!(send(&app, Method::POST, "/api/plan/stock/import", Some(&a_session), Some(quiet)).await.0.is_success());
    let (_, text) = call(&app, &mcp, "store_stock", json!({"store": "pats", "cards": ["Sol Ring"]})).await;
    assert!(text.contains("- Sol Ring: $0.90, Sol Ring [C21 - 263]; the listing didn't say whether it's in stock, so ask the store"), "{text}");

    // A store Yama can't read is refused at once; a readable one is only staged.
    // With no stores named, one they'll go to must be readable: Pat's is, unless they won't go.
    sqlx::query("INSERT INTO plan_store_prefs (owner_id, store_key, preference, updated_at) VALUES (?, 'pats', 'never', 'now')").bind(&a).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &mcp, "check_stores", json!({"cards": ["Sol Ring"]})).await;
    assert!(err && text.contains("can't read any of their stores"), "{text}");
    sqlx::query("DELETE FROM plan_store_prefs WHERE owner_id = ?").bind(&a).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &mcp, "check_stores", json!({"stores": ["card gurus"], "cards": ["Sol Ring"]})).await;
    assert!(err && text.contains("can't read Card Gurus's stock") && text.contains("Nothing was staged"), "{text}");
    // With no cards named and none on the trip, a card search reads nothing: refused.
    let (err, text) = call(&app, &mcp, "check_stores", json!({"stores": ["pats"]})).await;
    assert!(err && text.contains("Nothing to read"), "{text}");
    // Up to 300 cards, as the tool says.
    let many: Vec<String> = (0..250).map(|i| format!("Card {i}")).collect();
    let (err, text) = call(&app, &mcp, "check_stores", json!({"stores": ["pats"], "cards": many})).await;
    assert!(!err, "{text}");
    sqlx::query("DELETE FROM assistant_changes WHERE owner_id = ? AND kind = 'check_stores'").bind(&a).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &mcp, "check_stores", json!({"stores": ["pats"], "cards": ["Sol Ring"]})).await;
    assert!(!err, "{text}");
    assert!(text.contains("Staged for their review") && text.contains("Check stock: Pat's Games"), "{text}");
    let running: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM store_snapshots WHERE owner_id = ? AND source != 'import'").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(running, 0, "nothing is fetched until they apply it");
    let payload: String = sqlx::query_scalar("SELECT payload FROM assistant_changes WHERE owner_id = ? AND kind = 'check_stores'").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&payload).unwrap(), json!({"stores": ["pats"], "cards": ["Sol Ring"], "yestcg": false, "refresh_catalog":false}));
}

#[tokio::test]
async fn catalog_refresh_keeps_empty_card_scope_instead_of_expanding_the_trip() {
    let (app,pool)=app().await;
    let (owner,session)=user(&pool,"reader@example.com").await;
    let mcp=key(&app,&session,Some("mcp")).await;
    let (err,text)=call(&app,&mcp,"check_stores",json!({"stores":["pats"],"refresh_catalog":true})).await;
    assert!(!err,"{text}");
    let payload:String=sqlx::query_scalar("SELECT payload FROM assistant_changes WHERE owner_id=? AND kind='check_stores'").bind(&owner).fetch_one(&pool).await.unwrap();
    let payload:Value=serde_json::from_str(&payload).unwrap();
    assert_eq!(payload["cards"],json!([]));
    assert_eq!(payload["refresh_catalog"],true);
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
    // Two decks with one name: refused, so the wish can't land on the wrong one.
    deck(&pool, &a, "Twins").await;
    deck(&pool, &a, "Twins").await;
    let (err, text) = call(&app, &mcp, "add_wish", json!({"name": "Sol Ring", "deck": "twins"})).await;
    assert!(err && text.contains("2 decks are called") && text.contains("Nothing was staged"), "{text}");
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
    // Applying it again (a crash between the want and the change's status) adds nothing.
    let w = crate::plan::wants::NewWant { name: "Sol Ring".into(), ..Default::default() };
    crate::plan::wants::add(&pool, &a, &w, "assistant", Some(&id)).await.unwrap();
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shopping_wants WHERE owner_id = ?").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn deleting_a_deck_or_a_configuration_waits_for_review() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (a, session) = user(&pool, "bryan@example.com").await;
    let main = my_deck(&pool, &a).await;
    let mut configs = Vec::new();
    for (label, op) in [("Stock", "cfg-1"), ("Budget", "cfg-2")] {
        let (s, made) = send(&app, Method::POST, &format!("/api/decks/{main}/configurations"), Some(&session), Some(json!({"configuration": label, "op_id": op}))).await;
        assert_eq!(s, StatusCode::OK, "{made}");
        configs.push(made["id"].as_str().unwrap().to_string());
    }
    let archived = |id: String| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, bool>("SELECT archived FROM decks WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap() }
    };
    let mcp = key(&app, &session, Some("mcp")).await;
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    assert!(r["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "delete_deck"), "{r}");

    // One configuration: staged, then applied; the main deck and the other configuration stay.
    let (err, text) = call(&app, &mcp, "delete_deck", json!({"deck": configs[1]})).await;
    assert!(!err && text.contains("Delete the Budget configuration of Elf Ball"), "{text}");
    assert!(!archived(configs[1].clone()).await, "staging deletes nothing");
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
    assert!(!err && text.contains("Deleted"), "{text}");
    assert!(archived(configs[1].clone()).await && !archived(main.clone()).await && !archived(configs[0].clone()).await);

    // The main deck with its configurations, pinned to the ones named when it was staged.
    let (err, text) = call(&app, &mcp, "delete_deck", json!({"deck": "Elf Ball", "configurations": true})).await;
    assert!(!err && text.contains("Delete Elf Ball and its 1 configuration") && text.contains("Stock"), "{text}");
    let pinned = change_id(&text);
    let (s, _) = send(&app, Method::POST, &format!("/api/decks/{main}/configurations"), Some(&session), Some(json!({"configuration": "Late", "op_id": "cfg-3"}))).await;
    assert_eq!(s, StatusCode::OK);
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": pinned})).await;
    assert!(err && text.contains("configurations changed"), "{text}");
    assert!(!archived(main.clone()).await);
    call(&app, &mcp, "discard_change", json!({"id": pinned})).await;

    // Without configurations: the main deck goes and its configurations become decks of their own.
    let (_, text) = call(&app, &mcp, "delete_deck", json!({"deck": main})).await;
    assert!(text.contains("stay as decks of their own"), "{text}");
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
    assert!(!err && text.contains("its 2 configurations are now decks of their own"), "{text}");
    assert!(archived(main.clone()).await && !archived(configs[0].clone()).await);
    let parent: Option<String> = sqlx::query_scalar("SELECT parent_id FROM decks WHERE id = ?").bind(&configs[0]).fetch_one(&pool).await.unwrap();
    assert_eq!(parent, None);

    // A deck that's gone can't be deleted again, and someone else's is never found.
    let (err, _) = call(&app, &mcp, "delete_deck", json!({"deck": main})).await;
    assert!(err);
    let (_, other) = user(&pool, "sam@example.com").await;
    let theirs = key(&app, &other, Some("mcp")).await;
    let (err, _) = call(&app, &theirs, "delete_deck", json!({"deck": configs[0]})).await;
    assert!(err, "another account's deck isn't found");
}

// ── safety (2026-11-11) ─────────────────────────────────────────────────────

#[tokio::test]
async fn a_staging_call_repeated_with_its_op_id_stages_once() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (_, b_session) = user(&pool, "someone@example.com").await;
    my_deck(&pool, &a).await;
    let mcp = key(&app, &a_session, Some("mcp")).await;
    let other = key(&app, &b_session, Some("mcp")).await;
    let staged = || async { sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM assistant_changes WHERE owner_id = ?").bind(&a).fetch_one(&pool).await.unwrap() };
    let op = "0f8fad5b-d9cb-469f-a165-70867728950e";
    let edit = json!({"deck": "Elf Ball", "add": ["Arcane Signet"], "remove": ["Sol Ring"], "op_id": op});

    let (err, first) = call(&app, &mcp, "edit_deck", edit.clone()).await;
    assert!(!err && first.starts_with("Staged for their review"), "{first}");
    let (err, again) = call(&app, &mcp, "edit_deck", edit.clone()).await;
    assert!(!err && again.starts_with("Already staged with this op_id"), "{again}");
    assert_eq!(change_id(&again), change_id(&first));
    assert!(again.contains("apply_change"), "a pending change still says what happens next: {again}");
    assert_eq!(staged().await, 1, "the retry staged nothing");

    // Without an op id, a repeat is a second change, as before.
    let (err, text) = call(&app, &mcp, "edit_deck", json!({"deck": "Elf Ball", "add": ["Arcane Signet"], "remove": ["Sol Ring"]})).await;
    assert!(!err && text.starts_with("Staged for their review"), "{text}");
    assert_eq!(staged().await, 2);

    // The id names one request of one account. Reused for another tool, or for the same tool
    // with other arguments, it is refused: answering with the first change would tell the caller
    // its new change was staged, and a yes to it would apply the wrong one.
    let (err, text) = call(&app, &mcp, "add_to_collection", json!({"card": "Sol Ring", "op_id": op})).await;
    assert!(err && text.contains("was already used for a different request") && text.contains(&change_id(&first)), "{text}");
    let (err, text) = call(&app, &mcp, "edit_deck", json!({"deck": "Elf Ball", "remove": ["Forest"], "op_id": op})).await;
    assert!(err && text.contains("was already used for a different request"), "{text}");
    // save_deck stores the same kind of change as edit_deck; it is still another request.
    let (err, text) = call(&app, &mcp, "save_deck", json!({"deck": "Elf Ball", "list": "Commander\n1 Test Commander\nDeck\n1 Sol Ring\n98 Forest", "op_id": op})).await;
    assert!(err && text.contains("was already used for a different request"), "{text}");
    let (err, text) = call(&app, &other, "add_to_collection", json!({"card": "Sol Ring", "op_id": op})).await;
    assert!(!err && text.starts_with("Staged for their review"), "{text}");
    let (err, text) = call(&app, &mcp, "edit_deck", json!({"deck": "Elf Ball", "add": ["Arcane Signet"], "op_id": "short"})).await;
    assert!(err && text.contains("op_id must be"), "{text}");
    assert_eq!(staged().await, 2);

    // Once applied, the retry still answers with that change instead of failing on the new list.
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&first)})).await;
    assert!(!err, "{text}");
    let (err, again) = call(&app, &mcp, "edit_deck", edit).await;
    assert!(!err && again.contains("It was applied since. To stage the same change again, use a new op_id."), "{again}");
    assert_eq!(change_id(&again), change_id(&first));
    assert_eq!(staged().await, 2);

    // Two calls at once with one op id (a client that sends twice): one change, the same answer.
    let twice = json!({"deck": "Elf Ball", "add": ["Forest"], "op_id": "sent-twice-at-once"});
    let ((err_a, a_text), (err_b, b_text)) = tokio::join!(call(&app, &mcp, "edit_deck", twice.clone()), call(&app, &mcp, "edit_deck", twice.clone()));
    assert!(!err_a && !err_b, "{a_text}\n{b_text}");
    assert_eq!(change_id(&a_text), change_id(&b_text));
    assert_eq!(staged().await, 3);

    // Every staging tool takes op_id, and says so in its schema. An account that isn't a power
    // user and has no stores or lab runs is listed no tool that starts a simulation, none for
    // stores and no cancel_lab_run.
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    let plain = [
        "add_wish", "edit_deck", "delete_deck", "track_build", "approve_plan", "propose_swap", "answer_review", "mark_bought", "swap_in_prints",
        "mark_installed", "add_to_collection", "move_cards", "set_condition", "update_deck", "remove_wish", "create_container", "remove_from_collection",
        "edit_copies", "save_deck",
    ];
    assert_eq!(staging_names(&r), plain, "staging tools listed for an account that can't start simulations and has no stores or runs");
    // A power user is listed the lab's four as well, with op_id like the rest: it may start a
    // run, so it is offered the lab tools before it has one (`Has::load`). Still none for stores.
    let (_, power_session) = power_user(&pool, "power@example.com").await;
    let power = key(&app, &power_session, Some("mcp")).await;
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&power), Some(rpc("tools/list", json!({})))).await;
    let with_lab = [
        "add_wish", "edit_deck", "delete_deck", "track_build", "approve_plan", "propose_swap", "answer_review", "mark_bought", "swap_in_prints",
        "mark_installed", "start_lab_run", "add_lab_games", "rerun_lab_run", "cancel_lab_run", "add_to_collection", "move_cards", "set_condition",
        "update_deck", "remove_wish", "create_container", "remove_from_collection", "edit_copies", "save_deck",
    ];
    assert_eq!(staging_names(&r), with_lab, "staging tools listed for a power user with no stores");
}

/// The staging tools in a `tools/list` answer, by name and in its order, each checked to take
/// `op_id`. By name, so a failure says which tool came or went.
fn staging_names(listed: &Value) -> Vec<String> {
    let mut names = Vec::new();
    for t in listed["result"]["tools"].as_array().unwrap() {
        if t["annotations"]["readOnlyHint"] == false && t["annotations"]["idempotentHint"] == false {
            assert_eq!(t["inputSchema"]["properties"]["op_id"]["type"], "string", "{} has no op_id", t["name"]);
            names.push(t["name"].as_str().unwrap().to_string());
        }
    }
    names
}

#[test]
fn tool_calls_are_counted_per_account() {
    use crate::auth::User;
    use crate::limits::{Limits, MCP_CALLS_PER_DAY, MCP_CALLS_PER_MINUTE, RateLimiter};
    let who = |id: &str, limited: bool, admin: bool| User { id: id.into(), email: format!("{id}@example.com"), display_name: id.into(), is_admin: admin, limited, power: admin };
    let limits = Limits::default();
    let invited = who("invited", false, false);
    for _ in 0..MCP_CALLS_PER_MINUTE {
        super::count_call(&limits, &invited).unwrap();
    }
    let refused = super::count_call(&limits, &invited).unwrap_err().to_string();
    assert!(refused.contains("Too many tool calls. Try again in"), "{refused}");
    super::count_call(&limits, &who("someone-else", false, false)).expect("each account has its own count");
    for _ in 0..MCP_CALLS_PER_MINUTE * 3 {
        super::count_call(&limits, &who("admin", false, true)).expect("admins aren't counted");
    }

    // The day's count is only for accounts that joined through open sign-up.
    let roomy = Limits { mcp_calls: RateLimiter::new("tool calls", 100_000, std::time::Duration::from_secs(60)), ..Limits::default() };
    let open = who("open", true, false);
    for _ in 0..MCP_CALLS_PER_DAY {
        super::count_call(&roomy, &open).unwrap();
    }
    let refused = super::count_call(&roomy, &open).unwrap_err().to_string();
    assert!(refused.contains("Too many tool calls today") && refused.ends_with("Try again in 24 hours."), "{refused}");
    for _ in 0..MCP_CALLS_PER_DAY + 50 {
        super::count_call(&roomy, &invited).expect("an invited account has no daily count");
    }

    // A call the minute's limit refuses doesn't use up the day's.
    let tight = Limits { mcp_calls: RateLimiter::new("tool calls", 1, std::time::Duration::from_secs(60)), ..Limits::default() };
    super::count_call(&tight, &open).unwrap();
    for _ in 0..MCP_CALLS_PER_DAY * 2 {
        assert!(super::count_call(&tight, &open).is_err());
    }
    assert!(tight.mcp_calls_daily.allows(&open.id).is_ok(), "refused calls weren't counted toward the day");
}

#[tokio::test]
async fn a_flood_of_tool_calls_is_refused_as_a_tool_error() {
    let (app, pool) = app().await;
    let (_, a_session) = user(&pool, "bryan@example.com").await;
    let (_, b_session) = user(&pool, "someone@example.com").await;
    let mcp = key(&app, &a_session, Some("mcp")).await;
    let other = key(&app, &b_session, Some("mcp")).await;
    for n in 0..crate::limits::MCP_CALLS_PER_MINUTE {
        let (err, text) = call(&app, &mcp, "changes", json!({})).await;
        assert!(!err, "call {n}: {text}");
    }
    // The answer is a tool result the assistant can read, not an HTTP error its client retries.
    let (err, text) = call(&app, &mcp, "changes", json!({})).await;
    assert!(err && text.starts_with("Too many tool calls"), "{text}");
    // Reading a resource runs a tool, so it is counted too.
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("resources/read", json!({"uri": "yama://research/sources"})))).await;
    assert!(r["error"]["message"].as_str().is_some_and(|m| m.starts_with("Too many tool calls")), "{r}");
    // Listing tools and other accounts go on.
    let (status, _) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("tools/list", json!({})))).await;
    assert_eq!(status, StatusCode::OK);
    let (err, text) = call(&app, &other, "changes", json!({})).await;
    assert!(!err, "{text}");
}

#[tokio::test]
async fn a_retired_store_is_not_one_of_their_stores_for_any_tool() {
    let (app, pool) = app().await;
    let (a, session) = user(&pool, "bryan@example.com").await;
    for (id, store, name, retired) in [("s1", "pats", "Pat's Games", None), ("s2", "gone", "Gone Games", Some("2026-11-01T00:00:00Z"))] {
        sqlx::query("INSERT INTO plan_stores (id, owner_id, key, name, kind, origin, retired_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'local', 'yama', ?, 't', 't')")
            .bind(id)
            .bind(&a)
            .bind(store)
            .bind(name)
            .bind(retired)
            .execute(&pool)
            .await
            .unwrap();
    }
    let mcp = key(&app, &session, Some("mcp")).await;
    let (err, text) = call(&app, &mcp, "store_stock", json!({"store": "pats", "cards": ["Sol Ring"]})).await;
    assert!(!err && text.contains("Pat's Games"), "{text}");
    // store_stock had its own copy of the store lookup, without the retired check: it still found
    // a store their plan no longer has. Every store tool now uses the one lookup.
    for (tool, args) in [("store_stock", json!({"store": "gone", "cards": ["Sol Ring"]})), ("set_store_preference", json!({"store": "gone", "preference": "never"}))] {
        let (err, text) = call(&app, &mcp, tool, args).await;
        assert!(err && text.contains("No store \"gone\"") && !text.contains("Gone Games"), "{tool}: {text}");
    }
}

#[tokio::test]
async fn an_online_games_log_is_read_as_each_player_saw_it() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (b, b_session) = user(&pool, "friend@example.com").await;
    let (_, c_session) = user(&pool, "stranger@example.com").await;
    sqlx::query("INSERT INTO games (id, mode, created_by, status, started_at, turns, winner_seat) VALUES ('online-1', 'online', ?, 'finished', '2026-11-01T20:00:00Z', 7, 0)").bind(&a).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO game_seats (game_id, seat, user_id, commander_name) VALUES ('online-1', 0, ?, 'Atraxa'), ('online-1', 1, ?, 'Krenko')").bind(&a).bind(&b).execute(&pool).await.unwrap();
    let seats = json!([{"seat": 0, "kind": "human", "user_id": a, "name": "Bryan"}, {"seat": 1, "kind": "human", "user_id": b, "name": "Friend"}]);
    let log = json!([
        {"turn": 1, "text": "Bryan plays Forest."},
        {"turn": 1, "text": "Yama passed priority for you.", "seat": 0, "auto": "pass"},
        {"turn": 2, "text": "Friend keeps a card only they saw.", "seat": 1},
        {"turn": 7, "text": "Bryan wins."}
    ]);
    sqlx::query("INSERT INTO online_games (game_id, code, host_id, stage, seats, log, created_at, updated_at) VALUES ('online-1', 'ABCDEF', ?, 'over', ?, ?, 't', 't')")
        .bind(&a)
        .bind(seats.to_string())
        .bind(log.to_string())
        .execute(&pool)
        .await
        .unwrap();
    let a_key = key(&app, &a_session, Some("mcp")).await;
    let b_key = key(&app, &b_session, Some("mcp")).await;
    let c_key = key(&app, &c_session, Some("mcp")).await;

    // Without events: only how long the log is. The game had no life-counter events at all.
    let (err, text) = call(&app, &a_key, "game", json!({"id": "online-1"})).await;
    assert!(!err, "{text}");
    let game: Value = serde_json::from_str(&text).unwrap();
    assert_eq!((game["event_count"].as_u64(), game["log_lines"].as_u64()), (Some(0), Some(3)), "{text}");
    assert!(game.get("log").is_none(), "{text}");

    // With events: the lines everyone saw, and the caller's own.
    let (_, text) = call(&app, &a_key, "game", json!({"id": "online-1", "events": true})).await;
    let game: Value = serde_json::from_str(&text).unwrap();
    let lines: Vec<&str> = game["log"].as_array().unwrap().iter().map(|l| l["text"].as_str().unwrap()).collect();
    assert_eq!(lines, ["Bryan plays Forest.", "Yama passed priority for you.", "Bryan wins."]);
    assert_eq!(game["log"][0]["turn"], 1);
    assert!(!text.contains("only they saw") && !text.contains("auto"), "{text}");
    let (_, text) = call(&app, &b_key, "game", json!({"id": "online-1", "events": true})).await;
    assert!(text.contains("only they saw") && !text.contains("passed priority for you"), "the other player's own lines: {text}");
    assert!(!text.contains(&a) && !text.contains(&b), "no account ids: {text}");

    // Someone who wasn't in the game sees none of it.
    let (err, text) = call(&app, &c_key, "game", json!({"id": "online-1", "events": true})).await;
    assert!(err && text == "game not found", "{text}");
}

// ── what the app does that had no tool ──────────────────────────────────────

#[tokio::test]
async fn a_deck_is_renamed_and_its_bracket_declared_only_when_applied() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (_, b_session) = user(&pool, "someone@example.com").await;
    let (deck_id, _) = deck(&pool, &a, "Elf Ball").await;
    let mcp = key(&app, &a_session, Some("mcp")).await;
    let other = key(&app, &b_session, Some("mcp")).await;
    let saved = || async { sqlx::query_as::<_, (String, Option<i64>)>("SELECT name, bracket FROM decks WHERE id = ?").bind(&deck_id).fetch_one(&pool).await.unwrap() };

    let (err, text) = call(&app, &mcp, "update_deck", json!({"deck": "Elf Ball"})).await;
    assert!(err && text.contains("Nothing was staged"), "{text}");
    let (err, text) = call(&app, &mcp, "update_deck", json!({"deck": "Elf Ball", "bracket": 6})).await;
    assert!(err && text.contains("1 to 5"), "{text}");
    let (err, text) = call(&app, &mcp, "update_deck", json!({"deck": "Elf Ball", "name": "two\nlines"})).await;
    assert!(err && text.contains("line breaks"), "{text}");
    // Someone else's deck isn't found, by name or by id.
    for wanted in ["Elf Ball", deck_id.as_str()] {
        let (err, text) = call(&app, &other, "update_deck", json!({"deck": wanted, "name": "Mine now"})).await;
        assert!(err && text.contains("not found"), "{text}");
    }

    let (err, text) = call(&app, &mcp, "update_deck", json!({"deck": "Elf Ball", "name": "Elf Ball Deluxe", "bracket": 3})).await;
    assert!(!err && text.contains("Rename Elf Ball to Elf Ball Deluxe and declare it Bracket 3"), "{text}");
    assert_eq!(saved().await, ("Elf Ball".to_string(), None), "staged, not applied");
    let id = change_id(&text);
    let (err, text) = call(&app, &other, "apply_change", json!({"id": id})).await;
    assert!(err, "another account applied it: {text}");
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": id})).await;
    assert!(!err, "{text}");
    assert_eq!(saved().await, ("Elf Ball Deluxe".to_string(), Some(3)));

    // Clearing the bracket leaves the name alone.
    let (err, text) = call(&app, &mcp, "update_deck", json!({"deck": deck_id, "bracket": null})).await;
    assert!(!err && text.contains("Clear Elf Ball Deluxe's declared bracket"), "{text}");
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
    assert!(!err, "{text}");
    assert_eq!(saved().await, ("Elf Ball Deluxe".to_string(), None));
}

#[tokio::test]
async fn wishes_containers_and_copies_change_only_when_applied() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (b, b_session) = user(&pool, "someone@example.com").await;
    let mcp = key(&app, &a_session, Some("mcp")).await;
    let other = key(&app, &b_session, Some("mcp")).await;
    let apply = |text: String| {
        let (app, mcp) = (app.clone(), mcp.clone());
        async move {
            let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
            assert!(!err, "{text}");
        }
    };

    // A binder, made when they apply it.
    let (err, text) = call(&app, &mcp, "create_container", json!({"name": "Trade Binder", "kind": "shelf"})).await;
    assert!(err && text.contains("binder, deck, box or list"), "{text}");
    let (err, text) = call(&app, &mcp, "create_container", json!({"name": "Trade Binder", "kind": "binder"})).await;
    assert!(!err && text.contains("Make a binder called Trade Binder"), "{text}");
    let containers = |owner: String| {
        let pool = pool.clone();
        async move { sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM containers WHERE owner_id = ?").bind(owner).fetch_one(&pool).await.unwrap() }
    };
    assert_eq!(containers(a.clone()).await, 0, "staged, not applied");
    apply(text).await;
    assert_eq!((containers(a.clone()).await, containers(b.clone()).await), (1, 0));
    let (err, text) = call(&app, &mcp, "create_container", json!({"name": "Trade Binder", "kind": "binder"})).await;
    assert!(err && text.contains("already have a binder called Trade Binder"), "{text}");

    // Three copies in it; one is marked a proxy with a note and a price, the others stay.
    let (err, text) = call(&app, &mcp, "add_to_collection", json!({"card": "Sol Ring", "qty": 3, "container": "Trade Binder"})).await;
    assert!(!err, "{text}");
    apply(text).await;
    let (err, text) = call(&app, &mcp, "edit_copies", json!({"card": "Sol Ring", "container": "Trade Binder"})).await;
    assert!(err && text.contains("Give what to change"), "{text}");
    let (err, text) = call(&app, &mcp, "edit_copies", json!({"card": "Sol Ring", "container": "Trade Binder", "finish": "shiny"})).await;
    assert!(err && text.contains("nonfoil, foil or etched"), "{text}");
    let (err, text) = call(&app, &other, "edit_copies", json!({"card": "Sol Ring", "container": "Trade Binder", "proxy": true})).await;
    assert!(err && text.contains("no binder, deck box or list called"), "{text}");
    // A note or a price is for all the copies; a finish or proxy mark may be for some.
    let (err, text) = call(&app, &mcp, "edit_copies", json!({"card": "Sol Ring", "container": "Trade Binder", "qty": 1, "note": "playtest"})).await;
    assert!(err && text.contains("can't be set on only some") && text.contains("all 3 Sol Ring"), "{text}");
    let (err, text) = call(&app, &mcp, "edit_copies", json!({"card": "Sol Ring", "container": "Trade Binder", "qty": 1, "proxy": true})).await;
    assert!(!err && text.contains("Mark 1 Sol Ring in Trade Binder: a proxy") && text.contains("the other 2 stay"), "{text}");
    apply(text).await;
    let copies = || async {
        sqlx::query_as::<_, (i64, bool, Option<String>, Option<f64>)>("SELECT qty, proxy, note, purchase_price FROM collection_items WHERE owner_id = ? ORDER BY proxy").bind(&a).fetch_all(&pool).await.unwrap()
    };
    assert_eq!(copies().await, [(2, false, None, None), (1, true, None, None)]);
    // Only the copies an edit would change count: one proxy can become a real card, not three.
    let (err, text) = call(&app, &mcp, "edit_copies", json!({"card": "Sol Ring", "container": "Trade Binder", "qty": 3, "proxy": false})).await;
    assert!(err && text.contains("holds 1 Sol Ring that this would change, not 3"), "{text}");
    let (err, text) = call(&app, &mcp, "edit_copies", json!({"card": "Sol Ring", "container": "Trade Binder", "finish": "nonfoil"})).await;
    assert!(err && text.contains("is already nonfoil"), "{text}");
    let (err, text) = call(&app, &mcp, "edit_copies", json!({"card": "Sol Ring", "container": "Trade Binder", "note": "playtest", "price_paid": 0.25})).await;
    assert!(!err && text.contains("Mark 3 Sol Ring in Trade Binder: note \"playtest\", paid 0.25 each"), "{text}");
    apply(text).await;
    let noted = (Some("playtest".to_string()), Some(0.25));
    assert_eq!(copies().await, [(2, false, noted.0.clone(), noted.1), (1, true, noted.0.clone(), noted.1)]);

    // A copy leaves for good.
    let (err, text) = call(&app, &mcp, "remove_from_collection", json!({"card": "Sol Ring", "qty": 5, "from": "Trade Binder"})).await;
    assert!(err && text.contains("holds 3"), "{text}");
    let (err, text) = call(&app, &other, "remove_from_collection", json!({"card": "Sol Ring", "from": "Trade Binder"})).await;
    assert!(err && text.contains("no binder, deck box or list called"), "{text}");
    // A real copy and a proxy are there: which one goes has to be said, and the change names it.
    let (err, text) = call(&app, &mcp, "remove_from_collection", json!({"card": "Sol Ring", "qty": 1, "from": "Trade Binder"})).await;
    assert!(err && text.contains("are not all alike: 2 × TST #1, nonfoil, NM; 1 × TST #1, nonfoil, NM, proxy") && text.contains("Nothing was staged"), "{text}");
    let (err, text) = call(&app, &mcp, "remove_from_collection", json!({"card": "Sol Ring", "qty": 2, "from": "Trade Binder", "proxy": true})).await;
    assert!(err && text.contains("holds 1 Sol Ring like that, not 2"), "{text}");
    let (err, text) = call(&app, &mcp, "remove_from_collection", json!({"card": "Sol Ring", "qty": 1, "from": "Trade Binder", "proxy": false})).await;
    assert!(!err && text.contains("Remove 1 Sol Ring from Trade Binder") && text.contains("1 × TST #1, nonfoil, NM. 2 of the 3 Sol Ring there stay"), "{text}");
    assert_eq!(copies().await.len(), 2, "staged, not applied");
    let removal = change_id(&text);
    apply(text).await;
    assert_eq!(copies().await, [(1, false, noted.0.clone(), noted.1), (1, true, noted.0.clone(), noted.1)]);
    // Applied again after a crash between the collection's commit and the change's own status:
    // nothing more leaves, though another copy is there to take.
    sqlx::query("UPDATE assistant_changes SET status = 'pending', decided_at = NULL WHERE id = ?").bind(&removal).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": removal})).await;
    assert!(!err, "{text}");
    assert_eq!(copies().await.iter().map(|c| c.0).sum::<i64>(), 2, "the retry removed nothing");
    // The rows a removal names are the ones it takes from: once they have changed it is refused.
    let (err, text) = call(&app, &mcp, "remove_from_collection", json!({"card": "Sol Ring", "from": "Trade Binder", "proxy": true})).await;
    assert!(!err, "{text}");
    sqlx::query("UPDATE collection_items SET qty = 0 WHERE owner_id = ? AND proxy = 1").bind(&a).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &mcp, "apply_change", json!({"id": change_id(&text)})).await;
    assert!(err && text.contains("changed after this was suggested, so nothing was removed"), "{text}");
    sqlx::query("UPDATE collection_items SET qty = 1 WHERE owner_id = ? AND proxy = 1").bind(&a).execute(&pool).await.unwrap();

    // Two wishes with one name: the name alone is refused, the id takes one off.
    let wish = crate::plan::wants::NewWant { name: "Sol Ring".into(), ..Default::default() };
    let first = crate::plan::wants::add(&pool, &a, &wish, "page", None).await.unwrap();
    crate::plan::wants::add(&pool, &a, &wish, "page", None).await.unwrap();
    let (err, text) = call(&app, &mcp, "remove_wish", json!({"wish": "sol ring"})).await;
    assert!(err && text.contains("2 wishes are called") && text.contains("Nothing was staged"), "{text}");
    let (err, text) = call(&app, &other, "remove_wish", json!({"wish": first["id"]})).await;
    assert!(err && text.contains("Nothing they added"), "{text}");
    let (err, text) = call(&app, &mcp, "remove_wish", json!({"wish": first["id"]})).await;
    assert!(!err && text.contains("Take Sol Ring off their shopping list"), "{text}");
    let wishes = || async { sqlx::query_scalar::<_, String>("SELECT id FROM shopping_wants WHERE owner_id = ? AND retired_at IS NULL").bind(&a).fetch_all(&pool).await.unwrap() };
    assert_eq!(wishes().await.len(), 2, "staged, not applied");
    apply(text).await;
    let left = wishes().await;
    assert!(left.len() == 1 && Some(left[0].as_str()) != first["id"].as_str(), "{left:?}");
    // The one left is found by its name now.
    let (err, text) = call(&app, &mcp, "remove_wish", json!({"wish": "Sol Ring"})).await;
    assert!(!err, "{text}");
}

#[tokio::test]
async fn a_playgroups_games_are_listed_for_its_members_only() {
    let (app, pool) = app().await;
    let (a, a_session) = user(&pool, "bryan@example.com").await;
    let (_, b_session) = user(&pool, "someone@example.com").await;
    let (friend, _) = user(&pool, "friend@example.com").await;
    sqlx::query("INSERT INTO playgroups (id, name, owner_id, join_code, created_at) VALUES ('pg-1', 'Friday night', ?, 'JOIN1', 't')").bind(&friend).execute(&pool).await.unwrap();
    for (id, member) in [("m-a", &a), ("m-f", &friend)] {
        sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, user_id, guest_name, created_at) VALUES (?, 'pg-1', ?, NULL, 't')").bind(id).bind(member).execute(&pool).await.unwrap();
    }
    // One game the friend recorded in the playgroup (the caller wasn't in it), one of the caller's own outside it.
    sqlx::query("INSERT INTO games (id, mode, created_by, status, started_at, turns, winner_seat, playgroup_id) VALUES ('g-group', 'in_person', ?, 'finished', '2026-11-02', 7, 0, 'pg-1')").bind(&friend).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO games (id, mode, created_by, status, started_at, turns, winner_seat) VALUES ('g-own', 'in_person', ?, 'finished', '2026-11-01', 9, 0)").bind(&a).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO game_seats (game_id, seat, guest_name, commander_name) VALUES ('g-group', 0, 'Kelly', 'Atraxa'), ('g-own', 0, 'Sam', 'Krenko')").execute(&pool).await.unwrap();
    let a_key = key(&app, &a_session, Some("mcp")).await;
    let b_key = key(&app, &b_session, Some("mcp")).await;

    let (err, text) = call(&app, &a_key, "list_games", json!({})).await;
    assert!(!err && text.contains("g-own") && !text.contains("g-group"), "their own history has only their games: {text}");
    for args in [json!({"playgroup": "friday night"}), json!({"playgroup": "pg-1"}), json!({"playgroup": "pg-1", "query": "kelly"})] {
        let (err, text) = call(&app, &a_key, "list_games", args.clone()).await;
        assert!(!err && text.contains("g-group") && !text.contains("g-own"), "{args}: {text}");
    }
    let (err, text) = call(&app, &a_key, "list_games", json!({"playgroup": "Nope"})).await;
    assert!(err && text.contains("Friday night"), "{text}");
    let (err, text) = call(&app, &a_key, "list_games", json!({"playgroup": "pg-1", "query": "nobody"})).await;
    assert!(!err && !text.contains("g-group"), "the search still narrows a playgroup's games: {text}");
    // Someone who isn't in the playgroup gets nothing from it, by name or by id.
    for wanted in ["Friday night", "pg-1"] {
        let (err, text) = call(&app, &b_key, "list_games", json!({"playgroup": wanted})).await;
        assert!(err && text.contains("no playgroup called") && !text.contains("g-group"), "{text}");
    }
    // The route under the tool takes a playgroup's id from anyone: the rule is in its query.
    let history = |session: String| {
        let app = app.clone();
        async move { send(&app, Method::GET, "/api/games/history?playgroup=pg-1", Some(&session), None).await.1["games"].to_string() }
    };
    assert!(history(a_session.clone()).await.contains("g-group"), "a member");
    assert!(!history(b_session.clone()).await.contains("g-group"), "someone who isn't in it");
    // An owner from before owners had member rows is in it too, as everywhere else in the app.
    sqlx::query("INSERT INTO playgroups (id, name, owner_id, join_code, created_at) VALUES ('pg-2', 'Old group', ?, 'JOIN2', 't')").bind(&a).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO games (id, mode, created_by, status, started_at, turns, winner_seat, playgroup_id) VALUES ('g-old', 'in_person', ?, 'finished', '2026-10-01', 5, 0, 'pg-2')").bind(&friend).execute(&pool).await.unwrap();
    let (err, text) = call(&app, &a_key, "list_games", json!({"playgroup": "Old group"})).await;
    assert!(!err && text.contains("g-old"), "{text}");
    // Someone who has left sees none of the games they weren't in.
    sqlx::query("DELETE FROM playgroup_members WHERE id = 'm-a'").execute(&pool).await.unwrap();
    assert!(!history(a_session.clone()).await.contains("g-group"), "after leaving");
    let (err, text) = call(&app, &a_key, "list_games", json!({"playgroup": "pg-1"})).await;
    assert!(err && !text.contains("g-group"), "{text}");
}

/// A stored change is applied for the account it belongs to, whatever its payload names: every
/// applier binds the owner again, so ids of someone else's rows find nothing.
#[tokio::test]
async fn a_change_naming_another_accounts_rows_changes_nothing_when_applied() {
    let (app, pool) = app().await;
    seed_cards(&pool).await;
    let (a, _) = user(&pool, "bryan@example.com").await;
    let (b, b_session) = user(&pool, "someone@example.com").await;
    let (deck_id, _) = deck(&pool, &a, "Elf Ball").await;
    sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES ('box-a', ?, 'binder', 'Box A', 't')").bind(&a).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, container_id, created_at, updated_at) VALUES ('item-a', ?, 'p-o-sol', 3, 'box-a', 't', 't')").bind(&a).execute(&pool).await.unwrap();
    let wish = crate::plan::wants::add(&pool, &a, &crate::plan::wants::NewWant { name: "Sol Ring".into(), ..Default::default() }, "page", None).await.unwrap();
    let other = key(&app, &b_session, Some("mcp")).await;
    let forged = [
        ("update_deck", json!({"deck_id": deck_id, "deck": "Elf Ball", "name": "Taken", "set_bracket": true, "bracket": 5})),
        ("remove_wish", json!({"want_id": wish["id"], "name": "Sol Ring"})),
        ("remove_from_collection", json!({"name": "Sol Ring", "qty": 1, "from_id": "box-a", "from": "Box A", "rows": [{"id": "item-a", "qty": 1}]})),
        ("edit_copies", json!({"oracle_id": "o-sol", "name": "Sol Ring", "qty": 3, "container_id": "box-a", "container": "Box A", "proxy": true, "set_note": false, "set_price": false})),
        ("move_cards", json!({"oracle_id": "o-sol", "name": "Sol Ring", "qty": 1, "from_id": "box-a", "from": "Box A", "to_id": "box-a", "to": "Box A"})),
    ];
    for (n, (kind, payload)) in forged.iter().enumerate() {
        let id = format!("forged-{n}");
        sqlx::query("INSERT INTO assistant_changes (id, owner_id, kind, summary, payload, via, created_at) VALUES (?, ?, ?, 'forged', ?, 'key', 'now')")
            .bind(&id)
            .bind(&b)
            .bind(*kind)
            .bind(payload.to_string())
            .execute(&pool)
            .await
            .unwrap();
        let (err, text) = call(&app, &other, "apply_change", json!({"id": id})).await;
        assert!(err && text.contains("Not applied"), "{kind} was applied to another account's rows: {text}");
    }
    let deck_now: (String, Option<i64>) = sqlx::query_as("SELECT name, bracket FROM decks WHERE id = ?").bind(&deck_id).fetch_one(&pool).await.unwrap();
    assert_eq!(deck_now, ("Elf Ball".to_string(), None));
    let copies: Vec<(i64, bool, Option<String>)> = sqlx::query_as("SELECT qty, proxy, container_id FROM collection_items WHERE owner_id = ?").bind(&a).fetch_all(&pool).await.unwrap();
    assert_eq!(copies, [(3, false, Some("box-a".to_string()))]);
    let wishes: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shopping_wants WHERE owner_id = ? AND retired_at IS NULL").bind(&a).fetch_one(&pool).await.unwrap();
    assert_eq!(wishes, 1);
}
