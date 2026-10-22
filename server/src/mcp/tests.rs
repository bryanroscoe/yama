use super::QuestionToken;
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
    let q = QuestionToken::mint(&id);
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
    for n in ["overview", "deck", "plan_deck", "review_queue", "find_cards", "card", "check_list", "lab_runs", "lab_run", "precon"] {
        assert!(names.contains(&n), "{n} missing from {names:?}");
    }
    for t in r["result"]["tools"].as_array().unwrap() {
        assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
    }

    let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
    let (status, _) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(note)).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("ping", json!({})))).await;
    assert_eq!(r["result"], json!({}));
    let (_, r) = send(&app, Method::POST, "/mcp", Some(&mcp), Some(rpc("resources/list", json!({})))).await;
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
