//! Test helpers: the whole app on an in-memory database, so router tests go through the same
//! extractors, routes and error handling as a real request.

use crate::config::Config;
use crate::routes::AppState;
use crate::util::{now, random_token, sha256_hex};
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use sqlx::SqlitePool;
use std::sync::Arc;
use tower::ServiceExt;

/// Settings for tests: no sign-in providers, no engine card data, nothing reachable from outside.
pub fn config() -> Config {
    Config {
        database_url: "sqlite::memory:".into(),
        bind: "127.0.0.1:0".into(),
        web_dist: None,
        google_client_ids: vec![],
        admin_emails: vec![],
        dev_login: false,
        data_dir: std::env::temp_dir(),
        secure_cookies: false,
        cors_origins: vec![],
        auto_import: false,
        // No Commander Spellbook calls from tests.
        deck_checks: false,
        engine_card_data: None,
        cf_access_team: None,
        cf_access_aud: None,
        // The lab's worker runs, but with no engine card data it starts nothing (503s).
        lab_threads: 2,
    }
}

/// An `AppState` on a fresh in-memory database with every migration applied. Online play and the
/// lab's experiments are off (no engine card data), which is what their routes report in that case
/// anyway.
pub async fn state() -> AppState {
    let pool = crate::db::test_pool().await;
    let cfg = config();
    let play = crate::play::PlayHub::start(None, pool.clone());
    let lab = crate::lab::worker::LabWorker::start(pool.clone(), cfg.lab_threads, play.clone(), None);
    AppState {
        pool,
        cfg: Arc::new(cfg),
        http: crate::routes::http_client(),
        google_keys: Arc::default(),
        cf_keys: None,
        rooms: Arc::default(),
        play,
        lab,
    }
}

/// The full router plus its database, for tests that also seed or check rows.
pub async fn app() -> (Router, SqlitePool) {
    let st = state().await;
    let pool = st.pool.clone();
    (crate::routes::app(st), pool)
}

/// A user with a live session. Returns (user id, bearer token).
pub async fn user(pool: &SqlitePool, email: &str) -> (String, String) {
    let id = crate::util::new_id();
    sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(email)
        .bind(email.split('@').next().unwrap_or("player"))
        .bind(now())
        .execute(pool)
        .await
        .unwrap();
    let token = random_token();
    sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, '9999-12-31T00:00:00Z')")
        .bind(sha256_hex(&token))
        .bind(&id)
        .bind(now())
        .execute(pool)
        .await
        .unwrap();
    (id, token)
}

/// A deck with one version, owned by `owner`. Returns (deck id, version id).
pub async fn deck(pool: &SqlitePool, owner: &str, name: &str) -> (String, String) {
    let cards = vec![crate::decks::DeckCard {
        oracle_id: "o-commander".into(),
        name: "Test Commander".into(),
        qty: 1,
        board: crate::decks::Board::Commander,
    }];
    let deck_id = crate::decks::create_deck_with_cards(pool, owner, name, None, cards).await.unwrap();
    let version: String = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(&deck_id).fetch_one(pool).await.unwrap();
    (deck_id, version)
}

/// Send one request through the router. `token` goes in `Authorization: Bearer`; `body` is
/// sent as JSON. Returns the status and the body parsed as JSON (`Null` when empty or not JSON).
pub async fn send(app: &Router, method: Method, path: &str, token: Option<&str>, body: Option<serde_json::Value>) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    let req = match body {
        Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
        None => req.body(Body::empty()),
    }
    .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null))
}
