//! Admin "View as": who may start it, read only for every write (routes known and unknown),
//! secrets hidden, expiry and stopping, sign-out, and the audit log.

use crate::testutil::{app, deck, send, user};
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use tower::ServiceExt;

async fn admin(pool: &SqlitePool, email: &str) -> (String, String) {
    let (id, token) = user(pool, email).await;
    sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&id).execute(pool).await.unwrap();
    (id, token)
}

/// One request with a bearer token and cookies; returns status, JSON body and headers.
async fn call(
    app: &Router,
    method: Method,
    path: &str,
    bearer: Option<&str>,
    cookies: &[(&str, &str)],
    body: Option<Value>,
    websocket: bool,
) -> (StatusCode, Value, HeaderMap) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(t) = bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    if !cookies.is_empty() {
        let c: Vec<String> = cookies.iter().map(|(k, v)| format!("{k}={v}")).collect();
        req = req.header(header::COOKIE, c.join("; "));
    }
    if websocket {
        req = req
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==");
    }
    let req = match body {
        Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
        None => req.body(Body::empty()),
    }
    .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), headers)
}

fn set_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get_all(header::SET_COOKIE).iter().filter_map(|v| v.to_str().ok()).find_map(|v| {
        let first = v.split(';').next()?;
        let (k, val) = first.split_once('=')?;
        (k.trim() == name).then(|| val.to_string())
    })
}

/// Start viewing `target` as `admin_token`; returns the view cookie's value.
async fn start(app: &Router, admin_token: &str, target: &str) -> String {
    let (status, body, headers) = call(app, Method::POST, &format!("/api/admin/users/{target}/view"), Some(admin_token), &[], None, false).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    set_cookie(&headers, "yama_view").expect("a view cookie")
}

struct World {
    app: Router,
    pool: SqlitePool,
    admin_id: String,
    admin: String,
    pat_id: String,
    pat: String,
}

async fn world() -> World {
    let (app, pool) = app().await;
    let (admin_id, admin) = admin(&pool, "bryan@example.com").await;
    let (pat_id, pat) = user(&pool, "pat@example.com").await;
    deck(&pool, &pat_id, "Pat's deck").await;
    deck(&pool, &admin_id, "Bryan's deck").await;
    World { app, pool, admin_id, admin, pat_id, pat }
}

async fn count(pool: &SqlitePool, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string())).fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn only_admins_can_view_and_never_another_admin_or_themselves() {
    let w = world().await;
    // A non-admin gets the same 404 as an unknown route, and no cookie.
    let (status, body, headers) = call(&w.app, Method::POST, &format!("/api/admin/users/{}/view", w.admin_id), Some(&w.pat), &[], None, false).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["error"], "API route not found");
    assert!(set_cookie(&headers, "yama_view").is_none());
    // An admin can't view another admin, nor themselves; an unknown account is a 404.
    let (other_admin, _) = admin(&w.pool, "sam@example.com").await;
    let (status, body, _) = call(&w.app, Method::POST, &format!("/api/admin/users/{other_admin}/view"), Some(&w.admin), &[], None, false).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, _, _) = call(&w.app, Method::POST, &format!("/api/admin/users/{}/view", w.admin_id), Some(&w.admin), &[], None, false).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = call(&w.app, Method::POST, "/api/admin/users/nobody/view", Some(&w.admin), &[], None, false).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(count(&w.pool, "SELECT COUNT(*) FROM view_sessions").await, 0);
}

#[tokio::test]
async fn an_admin_sees_their_data_and_their_last_seen_stays_put() {
    let w = world().await;
    sqlx::query("UPDATE users SET last_seen_at = '2026-01-01T00:00:00Z' WHERE id = ?").bind(&w.pat_id).execute(&w.pool).await.unwrap();
    let view = start(&w.app, &w.admin, &w.pat_id).await;
    let (status, me, _) = call(&w.app, Method::GET, "/api/me", Some(&w.admin), &[("yama_view", &view)], None, false).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["email"], "pat@example.com");
    assert_eq!(me["is_admin"], false);
    assert_eq!(me["viewing"]["admin_email"], "bryan@example.com");
    assert!(me["viewing"]["expires_at"].is_string());
    let (_, decks, _) = call(&w.app, Method::GET, "/api/decks", Some(&w.admin), &[("yama_view", &view)], None, false).await;
    let names: Vec<&str> = decks.as_array().unwrap().iter().filter_map(|d| d["name"].as_str()).collect();
    assert_eq!(names, vec!["Pat's deck"]);
    // Admin routes answer as Pat would: not found.
    let (status, _, _) = call(&w.app, Method::GET, "/api/admin/usage", Some(&w.admin), &[("yama_view", &view)], None, false).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Pat's last-seen time isn't Bryan's doing.
    let seen: Option<String> = sqlx::query_scalar("SELECT last_seen_at FROM users WHERE id = ?").bind(&w.pat_id).fetch_one(&w.pool).await.unwrap();
    assert_eq!(seen.as_deref(), Some("2026-01-01T00:00:00Z"));
    // Without the view cookie Bryan is himself.
    let (_, me) = send(&w.app, Method::GET, "/api/me", Some(&w.admin), None).await;
    assert_eq!(me["email"], "bryan@example.com");
    assert!(me.get("viewing").is_none());
}

#[tokio::test]
async fn every_write_is_refused_while_viewing_known_routes_or_not() {
    let w = world().await;
    let view = start(&w.app, &w.admin, &w.pat_id).await;
    let cookies = [("yama_view", view.as_str())];
    let decks_before = count(&w.pool, "SELECT COUNT(*) FROM decks").await;
    // Real routes, and paths no route has (yet): the refusal comes before routing, so a mutating
    // route added later is refused without being listed anywhere.
    let writes = [
        (Method::POST, "/api/decks", Some(json!({"name": "Sneaky", "list": "1 Sol Ring"}))),
        (Method::POST, "/api/collection/import", Some(json!({}))),
        (Method::POST, "/api/plan/inputs", Some(json!({"ops": []}))),
        (Method::POST, "/api/me/tokens", Some(json!({"name": "x"}))),
        (Method::POST, "/api/advisor/ask", Some(json!({"question": "hi"}))),
        (Method::PUT, "/api/advisor/key", Some(json!({"api_key": "sk-ant-x"}))),
        (Method::POST, "/api/games", Some(json!({}))),
        (Method::POST, "/api/play", Some(json!({}))),
        (Method::POST, "/api/watch", Some(json!({}))),
        (Method::POST, "/api/lab/experiments", Some(json!({}))),
        (Method::POST, &format!("/api/admin/users/{}/view", w.pat_id), None),
        (Method::POST, "/mcp", Some(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))),
        (Method::POST, "/a-page-path-nobody-has-yet", Some(json!({}))),
        (Method::POST, "/api/a-route-nobody-has-written-yet", Some(json!({}))),
        (Method::PUT, "/api/another/new/thing", Some(json!({}))),
        (Method::PATCH, "/api/decks/anything", Some(json!({"name": "x"}))),
        (Method::DELETE, "/api/decks/anything", None),
        (Method::DELETE, "/api/advisor/conversations", None),
    ];
    for (method, path, body) in writes {
        let (status, answer, _) = call(&w.app, method.clone(), path, Some(&w.admin), &cookies, body, false).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {answer}");
        assert!(answer["error"].as_str().unwrap().contains("Viewing as pat: read only"), "{method} {path}: {answer}");
    }
    // WebSockets (online games, watched games, shared tables) don't open.
    for path in ["/api/play/some-game/ws", "/api/watch/some-game/ws", "/api/table/rooms/x/ws"] {
        let (status, answer, _) = call(&w.app, Method::GET, path, Some(&w.admin), &cookies, None, true).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {answer}");
    }
    assert_eq!(count(&w.pool, "SELECT COUNT(*) FROM decks").await, decks_before);
    assert_eq!(count(&w.pool, "SELECT COUNT(*) FROM api_tokens").await, 0);
}

#[tokio::test]
async fn secrets_stay_hidden_while_viewing() {
    let w = world().await;
    // Pat has a script key.
    let (status, _) = send(&w.app, Method::POST, "/api/me/tokens", Some(&w.pat), Some(json!({"name": "Mac"}))).await;
    assert!(status.is_success(), "{status}");
    let view = start(&w.app, &w.admin, &w.pat_id).await;
    let cookies = [("yama_view", view.as_str())];
    for path in ["/api/me/tokens", "/api/advisor/status", "/api/advisor/conversations", "/api/advisor/conversations/x"] {
        let (status, answer, _) = call(&w.app, Method::GET, path, Some(&w.admin), &cookies, None, false).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {answer}");
        assert!(answer.to_string().contains("stay private"), "{path}: {answer}");
    }
    // Pat's own view is unaffected.
    let (status, tokens) = send(&w.app, Method::GET, "/api/me/tokens", Some(&w.pat), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(tokens.as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn the_view_cookie_only_works_with_the_session_that_started_it() {
    let w = world().await;
    let view = start(&w.app, &w.admin, &w.pat_id).await;
    // Pat (or anyone) holding Bryan's view cookie is just themselves.
    let (_, me, _) = call(&w.app, Method::GET, "/api/me", Some(&w.pat), &[("yama_view", &view)], None, false).await;
    assert_eq!(me["email"], "pat@example.com");
    assert!(me.get("viewing").is_none());
    // A different session of Bryan's doesn't carry the view either.
    let other = crate::util::random_token();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, '9999-12-31T00:00:00Z')")
        .bind(crate::util::sha256_hex(&other))
        .bind(&w.admin_id)
        .bind(crate::util::now())
        .execute(&w.pool)
        .await
        .unwrap();
    let (_, me, _) = call(&w.app, Method::GET, "/api/me", Some(&other), &[("yama_view", &view)], None, false).await;
    assert_eq!(me["email"], "bryan@example.com");
    // And without any session the cookie is nothing.
    let (status, _, _) = call(&w.app, Method::GET, "/api/me", None, &[("yama_view", &view)], None, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_view_expires_and_then_writes_are_refused_not_run_as_the_admin() {
    let w = world().await;
    let view = start(&w.app, &w.admin, &w.pat_id).await;
    sqlx::query("UPDATE view_sessions SET expires_at = '2020-01-01T00:00:00Z'").execute(&w.pool).await.unwrap();
    // Reads carry on as Bryan, and the cookie is cleared.
    let (_, me, headers) = call(&w.app, Method::GET, "/api/me", Some(&w.admin), &[("yama_view", &view)], None, false).await;
    assert_eq!(me["email"], "bryan@example.com");
    assert_eq!(set_cookie(&headers, "yama_view").as_deref(), Some(""));
    let reason: Option<String> = sqlx::query_scalar("SELECT end_reason FROM view_sessions").fetch_one(&w.pool).await.unwrap();
    assert_eq!(reason.as_deref(), Some("expired"));
    // A write sent from the page that still thinks it's viewing is refused, not done as Bryan.
    let before = count(&w.pool, "SELECT COUNT(*) FROM decks").await;
    let (status, answer, _) =
        call(&w.app, Method::POST, "/api/decks", Some(&w.admin), &[("yama_view", &view)], Some(json!({"name": "x", "list": "1 Sol Ring"})), false).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("ended"));
    assert_eq!(count(&w.pool, "SELECT COUNT(*) FROM decks").await, before);
}

#[tokio::test]
async fn a_view_ends_when_the_admin_stops_loses_admin_or_signs_out() {
    let w = world().await;
    // Stop.
    let view = start(&w.app, &w.admin, &w.pat_id).await;
    let (status, _, headers) = call(&w.app, Method::POST, "/api/view/stop", Some(&w.admin), &[("yama_view", &view)], None, false).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(set_cookie(&headers, "yama_view").as_deref(), Some(""));
    let (_, me, _) = call(&w.app, Method::GET, "/api/me", Some(&w.admin), &[("yama_view", &view)], None, false).await;
    assert_eq!(me["email"], "bryan@example.com");
    // Losing admin ends it at once.
    let view = start(&w.app, &w.admin, &w.pat_id).await;
    sqlx::query("UPDATE users SET is_admin = 0 WHERE id = ?").bind(&w.admin_id).execute(&w.pool).await.unwrap();
    let (_, me, _) = call(&w.app, Method::GET, "/api/me", Some(&w.admin), &[("yama_view", &view)], None, false).await;
    assert_eq!(me["email"], "bryan@example.com");
    sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&w.admin_id).execute(&w.pool).await.unwrap();
    // A new view replaces an open one from the same session.
    let first = start(&w.app, &w.admin, &w.pat_id).await;
    let (sam, _) = user(&w.pool, "sam@example.com").await;
    let second = start(&w.app, &w.admin, &sam).await;
    let (_, me, _) = call(&w.app, Method::GET, "/api/me", Some(&w.admin), &[("yama_view", &first)], None, false).await;
    assert_eq!(me["email"], "bryan@example.com");
    // Signing out (with the session cookie, as the web app does) ends the view and the session.
    let (status, _, headers) =
        call(&w.app, Method::POST, "/api/auth/logout", None, &[("yama_session", &w.admin), ("yama_view", &second)], None, false).await;
    assert!(status.is_success(), "{status}");
    assert_eq!(set_cookie(&headers, "yama_view").as_deref(), Some(""));
    let open = count(&w.pool, "SELECT COUNT(*) FROM view_sessions WHERE ended_at IS NULL").await;
    assert_eq!(open, 0);
    let (status, _, _) = call(&w.app, Method::GET, "/api/me", Some(&w.admin), &[], None, false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let reasons: Vec<String> =
        sqlx::query_scalar("SELECT end_reason FROM view_sessions ORDER BY started_at, rowid").fetch_all(&w.pool).await.unwrap();
    assert_eq!(reasons, vec!["stopped", "ended", "replaced", "signed out"]);
}

#[tokio::test]
async fn disabled_accounts_can_be_viewed() {
    let w = world().await;
    sqlx::query("UPDATE users SET disabled_at = '2026-10-22T00:00:00Z' WHERE id = ?").bind(&w.pat_id).execute(&w.pool).await.unwrap();
    let view = start(&w.app, &w.admin, &w.pat_id).await;
    let (_, me, _) = call(&w.app, Method::GET, "/api/me", Some(&w.admin), &[("yama_view", &view)], None, false).await;
    assert_eq!(me["email"], "pat@example.com");
    assert_eq!(me["viewing"]["target_disabled"], true);
}

#[tokio::test]
async fn views_are_logged_for_admins_and_shown_to_the_person_viewed() {
    let w = world().await;
    let view = start(&w.app, &w.admin, &w.pat_id).await;
    call(&w.app, Method::POST, "/api/view/stop", Some(&w.admin), &[("yama_view", &view)], None, false).await;
    let (status, log) = send(&w.app, Method::GET, "/api/admin/views", Some(&w.admin), None).await;
    assert_eq!(status, StatusCode::OK);
    let row = &log.as_array().unwrap()[0];
    assert_eq!(row["admin_email"], "bryan@example.com");
    assert_eq!(row["target_email"], "pat@example.com");
    assert_eq!(row["end_reason"], "stopped");
    // Pat sees that an admin looked, and who; nobody else sees Pat's.
    let (_, mine) = send(&w.app, Method::GET, "/api/me/viewed", Some(&w.pat), None).await;
    assert_eq!(mine.as_array().unwrap().len(), 1);
    assert_eq!(mine[0]["admin_name"], "bryan");
    let (_, bryans) = send(&w.app, Method::GET, "/api/me/viewed", Some(&w.admin), None).await;
    assert_eq!(bryans.as_array().unwrap().len(), 0);
    // The log is admin-only.
    let (status, _) = send(&w.app, Method::GET, "/api/admin/views", Some(&w.pat), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
