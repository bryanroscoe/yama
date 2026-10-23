//! The advisor through the real router: who gets the subscription, key handling, privacy, limits,
//! and a question answered end to end by a fake sidecar on a local port.

use super::*;
use crate::config::{AdvisorConfig, Config};
use crate::testutil::{config, send, state_with, user};
use axum::Router;
use axum::http::{HeaderMap, Method, Request};
use std::sync::Arc;
use tower::ServiceExt;

const SECRET: &str = "advisor-shared-secret-0123456789abcdef";
const KEY_SECRET: &str = "advisor-key-secret-0123456789abcdefgh";
const KEY: &str = "sk-ant-api03-userkey-abcdefghijklmnopqrstuvwxyz0123";

fn u(email: &str, admin: bool, limited: bool) -> User {
    User { id: "id".into(), email: email.into(), display_name: "x".into(), is_admin: admin, limited }
}

fn cfg(url: Option<&str>, emails: &[&str], key_secret: bool) -> AdvisorConfig {
    AdvisorConfig {
        url: url.map(str::to_string),
        secret: Some(SECRET.into()),
        subscription_emails: emails.iter().map(|e| e.to_string()).collect(),
        key_secret: key_secret.then(|| KEY_SECRET.to_string()),
        ..AdvisorConfig::default()
    }
}

const NO: SharedGrant = SharedGrant::NotGranted;
const GRANTED: SharedGrant = SharedGrant::Granted { key_on_sidecar: true };
const GRANTED_NO_KEY: SharedGrant = SharedGrant::Granted { key_on_sidecar: false };

#[test]
fn only_a_listed_account_ever_gets_the_subscription() {
    let c = cfg(Some("http://advisor"), &["owner@example.com"], true);
    assert_eq!(access(&c, &u("owner@example.com", false, false), false, NO), Access::Ready(Mode::Subscription));
    assert_eq!(access(&c, &u("  Owner@Example.com ", false, false), false, NO), Access::Ready(Mode::Subscription), "emails compare as Yama stores them");
    // Admin, invited or not, granted the shared key or not: none of it gives anyone the subscription.
    assert_eq!(access(&c, &u("admin@example.com", true, false), false, NO), Access::NeedsKey);
    assert_eq!(access(&c, &u("admin@example.com", true, false), false, GRANTED), Access::Ready(Mode::Shared));
    assert_eq!(access(&c, &u("friend@example.com", false, true), false, NO), Access::NeedsKey);
    assert_eq!(access(&c, &u("friend@example.com", false, true), true, NO), Access::Ready(Mode::OwnKey));
    assert_eq!(access(&c, &u("owner@example.com.evil.test", false, false), false, GRANTED), Access::Ready(Mode::Shared));
    assert_eq!(access(&c, &u("owner@example.com.evil.test", false, false), false, NO), Access::NeedsKey);
    assert_eq!(access(&c, &u("", false, false), false, NO), Access::NeedsKey);
    // Without a key secret a saved key can't be used, and nobody else can ask.
    let no_keys = cfg(Some("http://advisor"), &["owner@example.com"], false);
    assert_eq!(access(&no_keys, &u("friend@example.com", false, false), true, NO), Access::KeysOff);
    assert_eq!(access(&no_keys, &u("owner@example.com", false, false), false, NO), Access::Ready(Mode::Subscription));
    // No sidecar address: off for everyone.
    assert_eq!(access(&cfg(None, &["owner@example.com"], true), &u("owner@example.com", true, false), true, GRANTED), Access::Off);
}

#[test]
fn the_shared_key_comes_after_the_subscription_and_the_accounts_own_key() {
    let c = cfg(Some("http://advisor"), &["owner@example.com"], true);
    let owner = u("owner@example.com", true, false);
    let friend = u("matt@example.com", false, true);
    // 1. The subscription for a listed email, whatever else it has.
    for (has_key, shared) in [(false, GRANTED), (true, GRANTED), (true, NO), (false, GRANTED_NO_KEY)] {
        assert_eq!(access(&c, &owner, has_key, shared), Access::Ready(Mode::Subscription), "{has_key} {shared:?}");
    }
    // 2. The account's own key beats the grant.
    assert_eq!(access(&c, &friend, true, GRANTED), Access::Ready(Mode::OwnKey));
    // 3. The shared key, only when granted and the sidecar holds one.
    assert_eq!(access(&c, &friend, false, GRANTED), Access::Ready(Mode::Shared));
    assert_eq!(access(&c, &friend, false, GRANTED_NO_KEY), Access::NeedsKey, "the usual \"add your own key\"");
    // 4. Nothing else.
    assert_eq!(access(&c, &friend, false, NO), Access::NeedsKey);
    // A server that stores no keys: a saved key can't be read, so the grant applies.
    let no_keys = cfg(Some("http://advisor"), &["owner@example.com"], false);
    assert_eq!(access(&no_keys, &friend, true, GRANTED), Access::Ready(Mode::Shared));
    assert_eq!(access(&no_keys, &friend, false, GRANTED_NO_KEY), Access::KeysOff);
    assert_eq!(access(&no_keys, &owner, false, GRANTED), Access::Ready(Mode::Subscription));
}

// ── the fake sidecar ────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct Fake {
    seen: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    /// NDJSON lines to answer with, and the pause between them.
    lines: Arc<Mutex<Vec<String>>>,
    pause_ms: u64,
    status: u16,
    /// What `/health` says about the shared key.
    shared: bool,
}

async fn fake_sidecar(fake: Fake) -> String {
    let shared = fake.shared;
    let app = Router::new().route("/health", get(move || async move { Json(json!({"ok": true, "subscription": true, "shared": shared})) })).route(
        "/advise",
        post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let fake = fake.clone();
            async move {
                fake.seen.lock().unwrap().push((headers, body));
                if fake.status != 200 {
                    return (StatusCode::from_u16(fake.status).unwrap(), Json(json!({"error": "busy now"}))).into_response();
                }
                let lines = fake.lines.lock().unwrap().clone();
                let pause = fake.pause_ms;
                let stream = futures_util::stream::iter(lines).then(move |l| async move {
                    tokio::time::sleep(Duration::from_millis(pause)).await;
                    Ok::<_, std::convert::Infallible>(Bytes::from(format!("{l}\n")))
                });
                Response::builder().header(header::CONTENT_TYPE, "application/x-ndjson").body(Body::from_stream(stream)).unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn answer_lines() -> Vec<String> {
    vec![
        json!({"type": "text", "text": "Play "}).to_string(),
        json!({"type": "text", "text": "more ramp."}).to_string(),
        json!({"type": "done", "usage": {"input_tokens": 100, "output_tokens": 4}, "cost_usd": null}).to_string(),
    ]
}

async fn app_with(advisor: AdvisorConfig) -> (Router, SqlitePool) {
    // Open sign-up, so accounts that joined without an invite can be tested too.
    let cfg = Config { advisor, open_signup: true, ..config() };
    let st = state_with(cfg, crate::db::test_pool().await).await;
    let pool = st.pool.clone();
    (crate::routes::app(st), pool)
}

/// Send a request and read the whole body as text (the ask route streams).
async fn send_text(app: &Router, method: Method, path: &str, token: &str, body: Value) -> (StatusCode, String) {
    let req = Request::builder()
        .method(method)
        .uri(path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// The events of an SSE body, as (event, data).
fn events(body: &str) -> Vec<(String, Value)> {
    body.split("\n\n")
        .filter(|f| !f.trim().is_empty())
        .map(|f| {
            let mut ev = String::new();
            let mut data = Value::Null;
            for line in f.lines() {
                if let Some(e) = line.strip_prefix("event: ") {
                    ev = e.to_string();
                } else if let Some(d) = line.strip_prefix("data: ") {
                    data = serde_json::from_str(d).unwrap();
                }
            }
            (ev, data)
        })
        .collect()
}

async fn plan_deck(pool: &SqlitePool, owner: &str, key: &str, name: &str) {
    let id = new_id();
    sqlx::query(
        "INSERT INTO plan_decks (id, owner_id, key, name, source, commander, color_identity, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'import', '[\"Omo, Queen of Vesuva\"]', 'GU', 'now', 'now')",
    )
    .bind(&id)
    .bind(owner)
    .bind(key)
    .bind(name)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO plan_swaps (id, owner_id, plan_deck_id, ext_key, stage, role, src, in_name, out_name, why, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'proposed', 'swap', 'buy', 'Dryad of the Ilysian Grove', 'Explore', 'Lands matter payoff', 'now', 'now')",
    )
    .bind(new_id())
    .bind(owner)
    .bind(&id)
    .bind(format!("{key}-dryad"))
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO plan_reviews (owner_id, swap_key, decision, note, at, origin) VALUES (?, ?, 'unsure', 'Too slow?', 'now', 'yama')")
        .bind(owner)
        .bind(format!("{key}-dryad"))
        .execute(pool)
        .await
        .unwrap();
}

// ── routes ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn status_says_why_it_is_unavailable_and_never_shows_a_key() {
    let (app, pool) = app_with(AdvisorConfig::default()).await;
    let (_, token) = user(&pool, "friend@example.com").await;
    let (status, body) = send(&app, Method::GET, "/api/advisor/status", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((body["available"].as_bool(), body["reason"].as_str()), (Some(false), Some("off")));
    let (status, _) = send(&app, Method::PUT, "/api/advisor/key", Some(&token), Some(json!({"api_key": KEY}))).await;
    assert_eq!(status, StatusCode::CONFLICT, "a server without the advisor stores no keys");

    let (app, pool) = app_with(cfg(Some("http://127.0.0.1:9"), &["owner@example.com"], true)).await;
    let (friend_id, friend) = user(&pool, "friend@example.com").await;
    let (_, owner) = user(&pool, "owner@example.com").await;
    let (_, body) = send(&app, Method::GET, "/api/advisor/status", Some(&owner), None).await;
    assert_eq!((body["available"].as_bool(), body["mode"].as_str()), (Some(true), Some("subscription")));
    let (_, body) = send(&app, Method::GET, "/api/advisor/status", Some(&friend), None).await;
    assert_eq!((body["available"].as_bool(), body["reason"].as_str(), body["can_save_key"].as_bool()), (Some(false), Some("needs_key"), Some(true)));

    // A bad key is refused; a good one is stored encrypted and only its hint comes back.
    let (status, _) = send(&app, Method::PUT, "/api/advisor/key", Some(&friend), Some(json!({"api_key": "my password"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, body) = send(&app, Method::PUT, "/api/advisor/key", Some(&friend), Some(json!({"api_key": format!("  {KEY} ")}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((body["mode"].as_str(), body["key_hint"].as_str()), (Some("own_key"), Some("0123")));
    assert!(!body.to_string().contains(KEY));
    let (_, body) = send(&app, Method::GET, "/api/advisor/status", Some(&friend), None).await;
    assert!(!body.to_string().contains(KEY), "status never carries the key");
    let (ct,): (Vec<u8>,) = sqlx::query_as("SELECT ciphertext FROM advisor_keys WHERE user_id = ?").bind(&friend_id).fetch_one(&pool).await.unwrap();
    assert!(!ct.windows(KEY.len()).any(|w| w == KEY.as_bytes()), "the key isn't stored in the clear");
    let (status, body) = send(&app, Method::DELETE, "/api/advisor/key", Some(&friend), None).await;
    assert_eq!((status, body["has_key"].as_bool()), (StatusCode::OK, Some(false)));

    // Models are a fixed list.
    let (status, _) = send(&app, Method::PUT, "/api/advisor/settings", Some(&friend), Some(json!({"model": "gpt-5"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, body) = send(&app, Method::PUT, "/api/advisor/settings", Some(&friend), Some(json!({"model": "claude-haiku-5-5"}))).await;
    assert_eq!(body["model"], "claude-haiku-5-5");
}

#[tokio::test]
async fn the_owner_asks_on_the_subscription_and_the_answer_is_saved() {
    let fake = Fake { lines: Arc::new(Mutex::new(answer_lines())), status: 200, ..Default::default() };
    let url = fake_sidecar(fake.clone()).await;
    let (app, pool) = app_with(cfg(Some(&url), &["owner@example.com"], true)).await;
    let (owner_id, owner) = user(&pool, "owner@example.com").await;
    plan_deck(&pool, &owner_id, "tricky-terrain", "Tricky Terrain").await;

    let (status, body) = send_text(
        &app,
        Method::POST,
        "/api/advisor/ask",
        &owner,
        json!({"context": {"kind": "plan_deck", "ref": "tricky-terrain"}, "question": "Should I add the Dryad?"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ev = events(&body);
    assert_eq!(ev.iter().map(|(e, _)| e.as_str()).collect::<Vec<_>>(), ["start", "text", "text", "done"]);
    let conversation = ev[0].1["conversation_id"].as_str().unwrap().to_string();
    assert_eq!(ev[0].1["mode"], "subscription");
    let (_, st) = send(&app, Method::GET, "/api/advisor/status", Some(&owner), None).await;
    assert_eq!(st["subscription_connected"], true, "the sidecar says it holds the token");

    // What the sidecar was sent: the secret, subscription mode, no key, and the deck in the prompt.
    let (headers, req) = fake.seen.lock().unwrap()[0].clone();
    assert_eq!(headers["x-advisor-secret"], SECRET);
    assert_eq!(req["mode"], "subscription");
    assert!(req["api_key"].is_null());
    assert_eq!(req["model"], DEFAULT_MODEL);
    let system = req["system"].as_str().unwrap();
    assert!(system.contains("Tricky Terrain") && system.contains("Dryad of the Ilysian Grove") && system.contains("Too slow?"), "{system}");
    assert!(system.contains("<yama_data>"));
    assert_eq!(req["messages"], json!([{"role": "user", "content": "Should I add the Dryad?"}]));

    // Saved: the question and the answer, and one use counted.
    let (status, detail) = send(&app, Method::GET, &format!("/api/advisor/conversations/{conversation}"), Some(&owner), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["context_kind"], "plan_deck");
    assert_eq!(detail["items"][1]["content"], "Play more ramp.");
    assert_eq!(detail["items"][1]["status"], "done");
    assert_eq!(detail["items"][1]["usage"]["output_tokens"], 4);

    // A follow-up carries the earlier turns.
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &owner, json!({"conversation_id": conversation, "question": "And Azusa?"})).await;
    assert_eq!(status, StatusCode::OK);
    let req = fake.seen.lock().unwrap()[1].1.clone();
    assert_eq!(req["messages"].as_array().unwrap().len(), 3);
    assert_eq!(req["messages"][1]["content"], "Play more ramp.");
    let (_, list) = send(&app, Method::GET, "/api/advisor/conversations?kind=plan_deck&ref=tricky-terrain", Some(&owner), None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["messages"], 4);
}

#[tokio::test]
async fn other_accounts_use_their_own_key_or_nothing() {
    let fake = Fake { lines: Arc::new(Mutex::new(answer_lines())), status: 200, ..Default::default() };
    let url = fake_sidecar(fake.clone()).await;
    let (app, pool) = app_with(cfg(Some(&url), &["owner@example.com"], true)).await;
    let (_, friend) = user(&pool, "friend@example.com").await;
    let (admin_id, admin) = user(&pool, "admin@example.com").await;
    sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&admin_id).execute(&pool).await.unwrap();

    for token in [&friend, &admin] {
        let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", token, json!({"question": "Hi"})).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "no key, not listed: no Claude, admins included");
    }
    assert!(fake.seen.lock().unwrap().is_empty(), "the sidecar heard nothing");

    send(&app, Method::PUT, "/api/advisor/key", Some(&friend), Some(json!({"api_key": KEY}))).await;
    let (status, body) = send_text(&app, Method::POST, "/api/advisor/ask", &friend, json!({"question": "Hi", "model": "claude-haiku-5-5"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let req = fake.seen.lock().unwrap()[0].1.clone();
    assert_eq!((req["mode"].as_str(), req["api_key"].as_str(), req["model"].as_str()), (Some("api_key"), Some(KEY), Some("claude-haiku-5-5")));
}

#[tokio::test]
async fn conversations_and_contexts_are_private() {
    let fake = Fake { lines: Arc::new(Mutex::new(answer_lines())), status: 200, ..Default::default() };
    let url = fake_sidecar(fake.clone()).await;
    let (app, pool) = app_with(cfg(Some(&url), &["owner@example.com"], true)).await;
    let (owner_id, owner) = user(&pool, "owner@example.com").await;
    let (_, other) = user(&pool, "other@example.com").await;
    plan_deck(&pool, &owner_id, "tricky-terrain", "Tricky Terrain").await;
    let (deck_id, _) = crate::testutil::deck(&pool, &owner_id, "Owner's deck").await;
    send(&app, Method::PUT, "/api/advisor/key", Some(&other), Some(json!({"api_key": KEY}))).await;

    let (_, body) = send_text(&app, Method::POST, "/api/advisor/ask", &owner, json!({"context": {"kind": "deck", "ref": deck_id}, "question": "Hi"})).await;
    let conversation = events(&body)[0].1["conversation_id"].as_str().unwrap().to_string();

    let path = format!("/api/advisor/conversations/{conversation}");
    assert_eq!(send(&app, Method::GET, &path, Some(&other), None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(send(&app, Method::DELETE, &path, Some(&other), None).await.0, StatusCode::NOT_FOUND);
    let (_, list) = send(&app, Method::GET, "/api/advisor/conversations", Some(&other), None).await;
    assert_eq!(list, json!([]));
    let asks = fake.seen.lock().unwrap().len();
    for body in [
        json!({"conversation_id": conversation, "question": "Mine now?"}),
        json!({"context": {"kind": "plan_deck", "ref": "tricky-terrain"}, "question": "Peek"}),
        json!({"context": {"kind": "deck", "ref": deck_id}, "question": "Peek"}),
    ] {
        let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &other, body).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    assert_eq!(fake.seen.lock().unwrap().len(), asks, "nothing of the owner's went anywhere");
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &other, json!({"context": {"kind": "secrets"}, "question": "x"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The owner deletes it, and it's gone.
    assert_eq!(send(&app, Method::DELETE, &path, Some(&owner), None).await.0, StatusCode::NO_CONTENT);
    assert_eq!(send(&app, Method::GET, &path, Some(&owner), None).await.0, StatusCode::NOT_FOUND);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM advisor_messages").fetch_one(&pool).await.unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn a_daily_allowance_survives_deleting_and_a_refused_sidecar_leaves_no_trace() {
    let fake = Fake { lines: Arc::new(Mutex::new(answer_lines())), status: 200, ..Default::default() };
    let url = fake_sidecar(fake.clone()).await;
    let (app, pool) = app_with(cfg(Some(&url), &["owner@example.com"], true)).await;
    let (stranger_id, stranger) = user(&pool, "stranger@example.com").await;
    sqlx::query("UPDATE users SET google_sub = 'g-1' WHERE id = ?").bind(&stranger_id).execute(&pool).await.unwrap();
    send(&app, Method::PUT, "/api/advisor/key", Some(&stranger), Some(json!({"api_key": KEY}))).await;
    for _ in 0..DAILY_LIMITED {
        sqlx::query("INSERT INTO advisor_usage (id, owner_id, mode, model, created_at) VALUES (?, ?, 'own_key', ?, ?)")
            .bind(new_id())
            .bind(&stranger_id)
            .bind(DEFAULT_MODEL)
            .bind(now())
            .execute(&pool)
            .await
            .unwrap();
    }
    let (status, body) = send_text(&app, Method::POST, "/api/advisor/ask", &stranger, json!({"question": "One more"})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    let (_, s) = send(&app, Method::GET, "/api/advisor/status", Some(&stranger), None).await;
    assert_eq!((s["per_day"].as_i64(), s["used_today"].as_i64()), (Some(DAILY_LIMITED), Some(DAILY_LIMITED)));

    // A sidecar that refuses: a 503 for the browser and nothing saved.
    let busy = Fake { status: 503, ..Default::default() };
    let url = fake_sidecar(busy).await;
    let (app, pool) = app_with(cfg(Some(&url), &["owner@example.com"], true)).await;
    let (_, owner) = user(&pool, "owner@example.com").await;
    let (status, body) = send_text(&app, Method::POST, "/api/advisor/ask", &owner, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("busy now"));
    let rows: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM advisor_conversations) + (SELECT COUNT(*) FROM advisor_usage)").fetch_one(&pool).await.unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn leaving_early_saves_what_arrived_as_stopped() {
    let lines: Vec<String> = (0..40).map(|i| json!({"type": "text", "text": format!("w{i} ")}).to_string()).collect();
    let fake = Fake { lines: Arc::new(Mutex::new(lines)), pause_ms: 20, status: 200, ..Default::default() };
    let url = fake_sidecar(fake).await;
    let (app, pool) = app_with(cfg(Some(&url), &["owner@example.com"], true)).await;
    let (_, owner) = user(&pool, "owner@example.com").await;
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/advisor/ask")
        .header(header::AUTHORIZATION, format!("Bearer {owner}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({"question": "Long answer please"}).to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let mut body = res.into_body().into_data_stream();
    let mut got = String::new();
    while !got.contains("w2 ") {
        got.push_str(&String::from_utf8_lossy(&body.next().await.unwrap().unwrap()));
    }
    drop(body);
    let mut status = String::new();
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        if let Some(s) = sqlx::query_scalar::<_, String>("SELECT status FROM advisor_messages WHERE role = 'assistant'").fetch_optional(&pool).await.unwrap() {
            status = s;
            break;
        }
    }
    assert_eq!(status, "stopped");
    let text: String = sqlx::query_scalar("SELECT content FROM advisor_messages WHERE role = 'assistant'").fetch_one(&pool).await.unwrap();
    assert!(text.starts_with("w0 w1 w2"), "{text}");
    assert!(!text.contains("w39"), "the rest wasn't read");
}

// ── the shared key ──────────────────────────────────────────────────────────

fn shared_answer(cost: f64) -> Vec<String> {
    vec![
        json!({"type": "text", "text": "Lead with ramp."}).to_string(),
        json!({"type": "done", "usage": {"input_tokens": 50, "output_tokens": 3}, "cost_usd": cost}).to_string(),
    ]
}

/// An account that joined through open sign-up (Google, no invite): the smaller allowance.
async fn google_user(pool: &SqlitePool, email: &str) -> (String, String) {
    let (id, token) = user(pool, email).await;
    sqlx::query("UPDATE users SET google_sub = ? WHERE id = ?").bind(format!("g-{email}")).bind(&id).execute(pool).await.unwrap();
    (id, token)
}

/// An admin named Bryan.
async fn bryan(pool: &SqlitePool, email: &str) -> (String, String) {
    let (id, token) = user(pool, email).await;
    sqlx::query("UPDATE users SET is_admin = 1, display_name = 'Bryan' WHERE id = ?").bind(&id).execute(pool).await.unwrap();
    (id, token)
}

fn grant_path(id: &str) -> String {
    format!("/api/admin/users/{id}/advisor-shared")
}

async fn usage_rows(pool: &SqlitePool, owner: &str) -> Vec<(String, Option<f64>)> {
    sqlx::query_as("SELECT mode, cost_usd FROM advisor_usage WHERE owner_id = ? ORDER BY created_at, rowid").bind(owner).fetch_all(pool).await.unwrap()
}

#[tokio::test]
async fn a_granted_friend_asks_on_the_shared_key_and_never_on_the_subscription() {
    let fake = Fake { lines: Arc::new(Mutex::new(shared_answer(0.0042))), status: 200, shared: true, ..Default::default() };
    let url = fake_sidecar(fake.clone()).await;
    let mut c = cfg(Some(&url), &["owner@example.com"], true);
    c.tools_url = Some("http://yama:8787/mcp".into());
    let (app, pool) = app_with(c).await;
    let (owner_id, owner) = bryan(&pool, "owner@example.com").await;
    let (matt_id, matt) = google_user(&pool, "matt@example.com").await;

    // Not granted: the usual "add your own key", and the sidecar hears nothing.
    let (_, st) = send(&app, Method::GET, "/api/advisor/status", Some(&matt), None).await;
    assert_eq!((st["reason"].as_str(), st["shared_granted"].as_bool()), (Some("needs_key"), Some(false)));
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &matt, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Bryan turns it on in Admin, People.
    let (status, ov) = send(&app, Method::PUT, &grant_path(&matt_id), Some(&owner), Some(json!({"daily_limit": null}))).await;
    assert_eq!(status, StatusCode::OK, "{ov}");
    assert_eq!(ov["key_on_sidecar"], true);
    assert_eq!((ov["grants"][0]["email"].as_str(), ov["grants"][0]["mode"].as_str()), (Some("matt@example.com"), Some("shared")));
    assert_eq!((ov["grants"][0]["granted_by_name"].as_str(), ov["grants"][0]["per_day"].as_i64()), (Some("Bryan"), Some(DAILY_LIMITED)));
    assert!(!ov.to_string().contains("sk-ant"));

    let (_, st) = send(&app, Method::GET, "/api/advisor/status", Some(&matt), None).await;
    assert_eq!((st["mode"].as_str(), st["shared_owner"].as_str(), st["per_day"].as_i64()), (Some("shared"), Some("Bryan"), Some(DAILY_LIMITED)));
    assert_eq!(st["models"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect::<Vec<_>>(), [DEFAULT_MODEL], "Haiku only by default");
    assert_eq!(st["model"], DEFAULT_MODEL);
    assert!(st["shared_paused_until"].is_null());

    // Asking: shared mode, no credential from Yama at all.
    let (status, body) = send_text(&app, Method::POST, "/api/advisor/ask", &matt, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ev = events(&body);
    assert_eq!(ev[0].1["mode"], "shared");
    assert_eq!(ev.last().unwrap().0, "done");
    let req = fake.seen.lock().unwrap()[0].1.clone();
    assert_eq!((req["mode"].as_str(), req["model"].as_str()), (Some("shared"), Some(DEFAULT_MODEL)));
    assert!(req["api_key"].is_null());
    assert!(!req.to_string().contains("sk-ant"), "Yama never sends a key in shared mode");
    // Yama's tools work as on any other question: a one-question token for Matt.
    assert!(req["tools"]["token"].as_str().is_some_and(|t| t.starts_with("yama_ask_")), "{}", req["tools"]);

    // Recorded: the mode and cost on the usage row (kept after deleting), the mode on the answer.
    assert_eq!(usage_rows(&pool, &matt_id).await, [("shared".to_string(), Some(0.0042))]);
    let mode: String = sqlx::query_scalar("SELECT mode FROM advisor_messages WHERE owner_id = ? AND role = 'assistant'").bind(&matt_id).fetch_one(&pool).await.unwrap();
    assert_eq!(mode, "shared");

    // Only the shared models, asked for or saved.
    let (status, body) = send_text(&app, Method::POST, "/api/advisor/ask", &matt, json!({"question": "Hi", "model": "claude-opus-5-5"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("Claude Haiku 5.5 only"), "{body}");
    let (status, _) = send(&app, Method::PUT, "/api/advisor/settings", Some(&matt), Some(json!({"model": "claude-sonnet-5-5"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(fake.seen.lock().unwrap().len(), 1);

    // The admin overview has the month's spend.
    let (_, ov) = send(&app, Method::GET, "/api/admin/advisor-shared", Some(&owner), None).await;
    assert!((ov["spent_this_month"].as_f64().unwrap() - 0.0042).abs() < 1e-9, "{ov}");
    assert_eq!(ov["grants"][0]["questions_this_month"], 1);
    assert_eq!(ov["monthly_usd"], 10.0);
    let (_, usage) = send(&app, Method::GET, "/api/admin/usage", Some(&owner), None).await;
    let row = usage["accounts"].as_array().unwrap().iter().find(|a| a["email"] == "matt@example.com").unwrap().clone();
    assert_eq!((row["advisor_mode"].as_str(), row["advisor_shared"].as_bool()), (Some("shared"), Some(true)));

    // Matt adds his own key: his is used, with every model. Removing it brings the shared key back.
    send(&app, Method::PUT, "/api/advisor/key", Some(&matt), Some(json!({"api_key": KEY}))).await;
    let (_, st) = send(&app, Method::GET, "/api/advisor/status", Some(&matt), None).await;
    assert_eq!((st["mode"].as_str(), st["shared_granted"].as_bool(), st["models"].as_array().map(Vec::len)), (Some("own_key"), Some(true), Some(3)));
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &matt, json!({"question": "Hi", "model": "claude-sonnet-5-5"})).await;
    assert_eq!(status, StatusCode::OK);
    let req = fake.seen.lock().unwrap()[1].1.clone();
    assert_eq!((req["mode"].as_str(), req["api_key"].as_str()), (Some("api_key"), Some(KEY)));
    let (_, st) = send(&app, Method::DELETE, "/api/advisor/key", Some(&matt), None).await;
    assert_eq!(st["mode"], "shared");

    // The subscription owner stays on the subscription, granted or not.
    send(&app, Method::PUT, &grant_path(&owner_id), Some(&owner), Some(json!({}))).await;
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &owner, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::OK);
    let req = fake.seen.lock().unwrap()[2].1.clone();
    assert_eq!(req["mode"], "subscription");

    // Revoked: back to "add your own key".
    let (status, ov) = send(&app, Method::DELETE, &grant_path(&matt_id), Some(&owner), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ov["grants"].as_array().unwrap().len(), 1, "only the owner's grant is left");
    let (_, st) = send(&app, Method::GET, "/api/advisor/status", Some(&matt), None).await;
    assert_eq!(st["reason"], "needs_key");
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &matt, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(fake.seen.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn shared_questions_have_a_daily_cap_and_a_monthly_cap() {
    let fake = Fake { lines: Arc::new(Mutex::new(shared_answer(0.01))), status: 200, shared: true, ..Default::default() };
    let url = fake_sidecar(fake.clone()).await;
    let mut c = cfg(Some(&url), &["owner@example.com"], true);
    c.shared_monthly_usd = 1.0;
    let (app, pool) = app_with(c).await;
    let (_, owner) = bryan(&pool, "owner@example.com").await;
    let (admin_id, admin) = user(&pool, "admin@example.com").await;
    sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&admin_id).execute(&pool).await.unwrap();
    let (matt_id, matt) = google_user(&pool, "matt@example.com").await;
    let (sam_id, sam) = google_user(&pool, "sam@example.com").await;

    // Caps are 1 to 1,000, and only for accounts that exist.
    for bad in [json!({"daily_limit": 0}), json!({"daily_limit": 5000})] {
        let (status, _) = send(&app, Method::PUT, &grant_path(&matt_id), Some(&owner), Some(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    assert_eq!(send(&app, Method::PUT, &grant_path("nobody"), Some(&owner), Some(json!({}))).await.0, StatusCode::NOT_FOUND);

    // Matt's own cap is 2; an admin on the shared key has the usual cap, not an admin's none.
    send(&app, Method::PUT, &grant_path(&matt_id), Some(&owner), Some(json!({"daily_limit": 2}))).await;
    send(&app, Method::PUT, &grant_path(&admin_id), Some(&owner), Some(json!({"daily_limit": null}))).await;
    let (_, st) = send(&app, Method::GET, "/api/advisor/status", Some(&matt), None).await;
    assert_eq!(st["per_day"], 2);
    let (_, st) = send(&app, Method::GET, "/api/advisor/status", Some(&admin), None).await;
    assert_eq!((st["mode"].as_str(), st["per_day"].as_i64()), (Some("shared"), Some(DAILY_INVITED)));

    for _ in 0..2 {
        let (status, body) = send_text(&app, Method::POST, "/api/advisor/ask", &matt, json!({"question": "Hi"})).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (status, body) = send_text(&app, Method::POST, "/api/advisor/ask", &matt, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(body.contains("2 questions"), "{body}");

    // The month: everyone's shared spending together, this calendar month only.
    let spend = |owner: String, cost: f64, at: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query("INSERT INTO advisor_usage (id, owner_id, mode, model, created_at, cost_usd) VALUES (?, ?, 'shared', ?, ?, ?)")
                .bind(new_id())
                .bind(owner)
                .bind(DEFAULT_MODEL)
                .bind(if at == "now" { now() } else { at.to_string() })
                .bind(cost)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    spend(sam_id.clone(), 50.0, "2000-01-01T00:00:00Z").await;
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &admin, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::OK, "last month's spending doesn't count");
    // Spending that wasn't on the shared key doesn't count either.
    sqlx::query("INSERT INTO advisor_usage (id, owner_id, mode, model, created_at, cost_usd) VALUES (?, ?, 'own_key', ?, ?, 40.0)")
        .bind(new_id())
        .bind(&sam_id)
        .bind(DEFAULT_MODEL)
        .bind(now())
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &admin, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::OK);
    // 0.01 x 4 so far; this tips the month over $1.
    spend(sam_id.clone(), 0.97, "now").await;
    let asks = fake.seen.lock().unwrap().len();
    let (status, body) = send_text(&app, Method::POST, "/api/advisor/ask", &admin, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(body.contains("Bryan's shared key has reached this month's limit"), "{body}");
    assert_eq!(fake.seen.lock().unwrap().len(), asks, "a paused shared key asks nothing");
    let (_, st) = send(&app, Method::GET, "/api/advisor/status", Some(&admin), None).await;
    let until = st["shared_paused_until"].as_str().unwrap().to_string();
    assert_eq!(until, shared::next_month_start(chrono::Utc::now()).to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    let (_, ov) = send(&app, Method::GET, "/api/admin/advisor-shared", Some(&owner), None).await;
    assert!(ov["spent_this_month"].as_f64().unwrap() >= 1.0, "{ov}");

    // People on their own key, or the subscription, aren't held back by the shared key's month.
    send(&app, Method::PUT, "/api/advisor/key", Some(&sam), Some(json!({"api_key": KEY}))).await;
    send(&app, Method::PUT, &grant_path(&sam_id), Some(&owner), Some(json!({}))).await;
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &sam, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &owner, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::OK);
    let modes: Vec<String> = fake.seen.lock().unwrap()[asks..].iter().map(|(_, r)| r["mode"].as_str().unwrap().to_string()).collect();
    assert_eq!(modes, ["api_key", "subscription"]);
    assert_eq!(usage_rows(&pool, &matt_id).await.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["shared", "shared"]);
}

#[tokio::test]
async fn without_the_key_on_the_sidecar_a_grant_does_nothing() {
    let fake = Fake { lines: Arc::new(Mutex::new(shared_answer(0.01))), status: 200, shared: false, ..Default::default() };
    let url = fake_sidecar(fake.clone()).await;
    let (app, pool) = app_with(cfg(Some(&url), &["owner@example.com"], true)).await;
    let (_, owner) = bryan(&pool, "owner@example.com").await;
    let (matt_id, matt) = google_user(&pool, "matt@example.com").await;
    let (_, ov) = send(&app, Method::PUT, &grant_path(&matt_id), Some(&owner), Some(json!({}))).await;
    assert_eq!(ov["key_on_sidecar"], false);
    assert!(ov["grants"][0]["mode"].is_null());
    let (_, st) = send(&app, Method::GET, "/api/advisor/status", Some(&matt), None).await;
    assert_eq!((st["reason"].as_str(), st["shared_granted"].as_bool()), (Some("needs_key"), Some(true)));
    let (status, _) = send_text(&app, Method::POST, "/api/advisor/ask", &matt, json!({"question": "Hi"})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(fake.seen.lock().unwrap().is_empty());
    let (_, server) = send(&app, Method::GET, "/api/admin/server", Some(&owner), None).await;
    assert_eq!((server["advisor"]["shared_key"].as_bool(), server["advisor"]["shared_accounts"].as_i64()), (Some(false), Some(1)));
}

#[tokio::test]
async fn view_as_never_asks_on_someone_elses_grant() {
    let fake = Fake { lines: Arc::new(Mutex::new(shared_answer(0.01))), status: 200, shared: true, ..Default::default() };
    let url = fake_sidecar(fake.clone()).await;
    let (app, pool) = app_with(cfg(Some(&url), &["owner@example.com"], true)).await;
    let (_, owner) = bryan(&pool, "owner@example.com").await;
    let (matt_id, _) = google_user(&pool, "matt@example.com").await;
    send(&app, Method::PUT, &grant_path(&matt_id), Some(&owner), Some(json!({}))).await;

    let start = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/admin/users/{matt_id}/view"))
        .header(header::AUTHORIZATION, format!("Bearer {owner}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(start).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let cookie = res
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|v| v.split(';').next().filter(|kv| kv.starts_with("yama_view=")).map(str::to_string))
        .expect("a view cookie");
    for (method, path, body) in [
        (Method::POST, "/api/advisor/ask".to_string(), json!({"question": "On Matt's grant?"})),
        (Method::GET, "/api/advisor/status".to_string(), Value::Null),
        (Method::DELETE, grant_path(&matt_id), Value::Null),
    ] {
        let req = Request::builder()
            .method(method.clone())
            .uri(&path)
            .header(header::AUTHORIZATION, format!("Bearer {owner}"))
            .header(header::COOKIE, &cookie)
            .header(header::CONTENT_TYPE, "application/json")
            .body(if body.is_null() { Body::empty() } else { Body::from(body.to_string()) })
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN, "{method} {path}");
    }
    assert!(fake.seen.lock().unwrap().is_empty(), "nothing was asked as Matt");
    let grants: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM advisor_shared_access").fetch_one(&pool).await.unwrap();
    assert_eq!(grants, 1);
}

#[tokio::test]
async fn the_command_line_grants_and_revokes_by_email() {
    let pool = crate::db::test_pool().await;
    let (bryan_id, _) = user(&pool, "bryan@example.com").await;
    let (matt_id, _) = user(&pool, "matt@example.com").await;
    let cfg = Config { admin_emails: vec!["bryan@example.com".into()], ..config() };
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let row = |pool: SqlitePool, id: String| async move {
        sqlx::query_as::<_, (Option<String>, Option<i64>)>("SELECT granted_by, daily_limit FROM advisor_shared_access WHERE user_id = ?")
            .bind(id)
            .fetch_optional(&pool)
            .await
            .unwrap()
    };

    shared::cli(&pool, &cfg, &args(&["share", "Matt@Example.com", "--daily", "20"])).await.unwrap();
    assert_eq!(row(pool.clone(), matt_id.clone()).await, Some((Some(bryan_id.clone()), Some(20))), "granted in the first admin's name");
    // Changing the cap keeps who granted it.
    shared::cli(&pool, &cfg, &args(&["share", "matt@example.com"])).await.unwrap();
    assert_eq!(row(pool.clone(), matt_id.clone()).await, Some((Some(bryan_id.clone()), None)));
    shared::cli(&pool, &cfg, &args(&["shared"])).await.unwrap();
    for bad in [
        &["share", "nobody@example.com"][..],
        &["share", "matt@example.com", "--daily", "0"],
        &["share", "matt@example.com", "--daily", "lots"],
        &["share", "matt@example.com", "--by", "nobody@example.com"],
        &["share"],
        &[],
        &["frobnicate"],
    ] {
        assert!(shared::cli(&pool, &cfg, &args(bad)).await.is_err(), "{bad:?}");
    }
    shared::cli(&pool, &cfg, &args(&["unshare", "matt@example.com"])).await.unwrap();
    assert_eq!(row(pool.clone(), matt_id.clone()).await, None);
    shared::cli(&pool, &cfg, &args(&["unshare", "matt@example.com"])).await.unwrap();
}

#[test]
fn shared_settings_default_to_haiku_and_ten_dollars() {
    use crate::config::{monthly_usd, shared_models};
    assert_eq!(shared_models(None).unwrap(), [DEFAULT_MODEL]);
    assert_eq!(shared_models(Some(" ")).unwrap(), [DEFAULT_MODEL]);
    assert_eq!(shared_models(Some("claude-haiku-5-5, Claude-Sonnet-5-5")).unwrap(), ["claude-haiku-5-5", "claude-sonnet-5-5"]);
    assert!(shared_models(Some("gpt-5")).is_err(), "a model the advisor doesn't offer is a startup error");
    assert_eq!(monthly_usd(None).unwrap(), 10.0);
    assert_eq!(monthly_usd(Some("25.50")).unwrap(), 25.5);
    assert_eq!(monthly_usd(Some("$5")).unwrap(), 5.0);
    assert_eq!(monthly_usd(Some("0")).unwrap(), 0.0);
    assert!(monthly_usd(Some("-1")).is_err());
    assert!(monthly_usd(Some("lots")).is_err());
    let d = AdvisorConfig::default();
    assert_eq!((d.shared_monthly_usd, d.shared_models.as_slice()), (10.0, [DEFAULT_MODEL.to_string()].as_slice()));
}
