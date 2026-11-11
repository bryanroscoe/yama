//! Guest players (Bryan, 2026-11-11: "make the public play page public… as much of this public as
//! possible but we need to put some bot protection in place").
//!
//! Someone with no account may play the computer online. Pressing Play as a guest passes a
//! Cloudflare Turnstile check, and the server, after checking that token with Cloudflare, makes a
//! throwaway `users` row (`guest = 1`, an `.invalid` email, the name "Guest") with a session in its
//! own cookie, [`GUEST_COOKIE`]. Only [`Player`] reads that cookie, and only the play routes (and
//! the precon list and board data they need) take a `Player`; every other way in (`CurrentUser`,
//! script keys, `/mcp`) refuses a guest's session however it is sent (`auth::user_for_token`). So a
//! guest can't save decks, keep a collection, join playgroups or use anything else that needs an
//! account, and nothing a guest does reaches anyone else's data.
//!
//! Limits, since every game holds an engine thread:
//! - guest play is on only with guest mode, open sign-up and Turnstile all set up (`Config`);
//! - new guests per address a day and on the whole server an hour (`limits.rs`), counted only once
//!   Turnstile has passed;
//! - a guest is `limited` (the open sign-up allowance) and may host [`GUEST_MAX_OPEN_GAMES`]
//!   unfinished game; guests together [`GUEST_MAX_OPEN_GAMES_ALL`] (`play.rs`, `check_open_games`);
//! - guests play precons only, and can't join a friend's game by code;
//! - a guest and everything it made is deleted [`GUEST_DAYS`] after it was made ([`spawn_sweeper`]).
//!
//! Signing in with Google doesn't carry a guest's games over: the account's own games show from
//! then on, and the guest is deleted on schedule.

use crate::auth::{User, user_columns};
use crate::error::{AppError, AppResult};
use crate::limits::{ClientAddress, address_key};
use crate::routes::AppState;
use crate::util::{new_id, now, random_token, sha256_hex};
use axum::extract::{FromRequestParts, State};
use axum::http::HeaderMap;
use axum::http::request::Parts;
use axum::routing::get;
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

pub const GUEST_COOKIE: &str = "yama_guest";
/// How long a guest lasts, from when it was made.
pub const GUEST_DAYS: i64 = 7;
/// Unfinished online games one guest may host.
pub const GUEST_MAX_OPEN_GAMES: i64 = 1;
/// Unfinished online games all guests together may host (inside the open sign-up pool).
pub const GUEST_MAX_OPEN_GAMES_ALL: i64 = 6;
/// The Turnstile action the web app names, checked against Cloudflare's answer.
pub const TURNSTILE_ACTION: &str = "guest-play";
const SITEVERIFY: &str = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
pub const SIGN_IN_TO_JOIN: &str = "Sign in to join a friend's game. Guests play the computer.";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/guest/session", get(status).post(start).delete(end))
}

/// Guest play is on: guest mode, open sign-up and Turnstile all set up.
pub fn enabled(st: &AppState) -> bool {
    st.cfg.guest_mode && st.cfg.open_signup && st.cfg.turnstile.is_some()
}

/// Extractor for the play routes: the signed-in account, else a guest player.
pub struct Player(pub User);

impl FromRequestParts<AppState> for Player {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        match crate::auth::CurrentUser::from_request_parts(parts, state).await {
            Ok(crate::auth::CurrentUser(user)) => return Ok(Player(user)),
            Err(AppError::Unauthorized) => {}
            Err(other) => return Err(other),
        }
        if let Some(token) = guest_token(&parts.headers)
            && let Some(user) = guest_for_token(state, &token).await?
        {
            crate::request_log::note_user(&parts.extensions, &user.id);
            return Ok(Player(user));
        }
        Err(AppError::Unauthorized)
    }
}

fn guest_token(headers: &HeaderMap) -> Option<String> {
    CookieJar::from_headers(headers).get(GUEST_COOKIE).map(|c| c.value().to_string())
}

/// The guest a live guest session belongs to, while guest play is on.
async fn guest_for_token(st: &AppState, token: &str) -> AppResult<Option<User>> {
    if !enabled(st) {
        return Ok(None);
    }
    Ok(sqlx::query_as(concat!(
        "SELECT ",
        user_columns!(),
        " FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.guest = 1 AND u.disabled_at IS NULL"
    ))
    .bind(sha256_hex(token))
    .bind(now())
    .fetch_optional(&st.pool)
    .await?)
}

#[derive(Serialize)]
struct Status {
    /// Someone with no account may play as a guest here.
    enabled: bool,
    /// The Turnstile site key the web app shows the check with.
    site_key: Option<String>,
    /// This browser is a guest already.
    guest: bool,
    /// When this guest and its games are deleted.
    expires_at: Option<String>,
}

async fn status(State(st): State<AppState>, headers: HeaderMap) -> AppResult<Json<Status>> {
    let on = enabled(&st);
    let guest = match guest_token(&headers) {
        Some(token) if on => guest_for_token(&st, &token).await?,
        _ => None,
    };
    let expires_at = match &guest {
        Some(g) => expires_of(&st.pool, &g.id).await?,
        None => None,
    };
    Ok(Json(Status {
        enabled: on,
        site_key: on.then(|| st.cfg.turnstile.as_ref().map(|t| t.site_key.clone())).flatten(),
        guest: guest.is_some(),
        expires_at,
    }))
}

async fn expires_of(pool: &SqlitePool, id: &str) -> AppResult<Option<String>> {
    let made: Option<String> = sqlx::query_scalar("SELECT created_at FROM users WHERE id = ? AND guest = 1").bind(id).fetch_optional(pool).await?;
    Ok(made
        .and_then(|m| chrono::DateTime::parse_from_rfc3339(&m).ok())
        .map(|m| (m + Duration::days(GUEST_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)))
}

#[derive(Deserialize)]
struct StartGuest {
    /// The Turnstile token from the web app's check.
    turnstile: String,
}

/// Become a guest: the Turnstile token is checked with Cloudflare, then a guest is made and its
/// cookie set. A browser that is a guest already keeps the one it has.
async fn start(
    State(st): State<AppState>,
    ClientAddress(addr): ClientAddress,
    jar: CookieJar,
    Json(body): Json<StartGuest>,
) -> AppResult<(CookieJar, Json<Status>)> {
    if !enabled(&st) {
        return Err(AppError::Forbidden("Playing without an account is off on this server. Sign in to play.".into()));
    }
    if let Some(token) = jar.get(GUEST_COOKIE).map(|c| c.value().to_string())
        && let Some(guest) = guest_for_token(&st, &token).await?
    {
        let expires_at = expires_of(&st.pool, &guest.id).await?;
        return Ok((jar, Json(Status { enabled: true, site_key: st.cfg.turnstile.as_ref().map(|t| t.site_key.clone()), guest: true, expires_at })));
    }
    let key = address_key(addr);
    st.limits.new_guests_address.allows(&key)?;
    st.limits.new_guests.allows("all")?;
    if !verify_turnstile(&st, body.turnstile.trim(), addr).await? {
        return Err(AppError::Forbidden("The check that you're a person didn't go through. Try it again.".into()));
    }
    // Counted once the check passes, so a page left open doesn't use up the address's allowance.
    st.limits.new_guests_address.check(&key)?;
    st.limits.new_guests.check("all")?;
    let id = new_id();
    let stamp = now();
    let token = random_token();
    let expires = Utc::now() + Duration::days(GUEST_DAYS);
    let mut tx = st.pool.begin().await?;
    sqlx::query("INSERT INTO users (id, email, display_name, is_admin, created_at, guest) VALUES (?, ?, 'Guest', 0, ?, 1)")
        .bind(&id)
        .bind(format!("guest-{id}@guest.yama.invalid"))
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(sha256_hex(&token))
        .bind(&id)
        .bind(&stamp)
        .bind(expires.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(guest = %id, "a guest player started");
    let cookie = Cookie::build((GUEST_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(st.cfg.secure_cookies)
        .max_age(time::Duration::days(GUEST_DAYS))
        .build();
    Ok((
        jar.add(cookie),
        Json(Status {
            enabled: true,
            site_key: st.cfg.turnstile.as_ref().map(|t| t.site_key.clone()),
            guest: true,
            expires_at: Some(expires.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        }),
    ))
}

/// Stop being a guest: the guest and its games are deleted now, and the cookie with them.
async fn end(State(st): State<AppState>, jar: CookieJar) -> AppResult<CookieJar> {
    if let Some(token) = jar.get(GUEST_COOKIE).map(|c| c.value().to_string()) {
        let id: Option<String> = sqlx::query_scalar("SELECT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.guest = 1")
            .bind(sha256_hex(&token))
            .fetch_optional(&st.pool)
            .await?;
        if let Some(id) = id {
            crate::admin::delete::delete_account(&st, &id).await?;
        }
    }
    Ok(jar.remove(Cookie::build(GUEST_COOKIE).path("/")))
}

#[derive(Deserialize)]
struct SiteVerify {
    success: bool,
    #[serde(default)]
    action: Option<String>,
    #[serde(default, rename = "error-codes")]
    error_codes: Vec<String>,
}

/// Ask Cloudflare whether a Turnstile token is good, for this address and the guest-play action.
async fn verify_turnstile(st: &AppState, token: &str, addr: Option<std::net::IpAddr>) -> AppResult<bool> {
    let Some(t) = &st.cfg.turnstile else { return Ok(false) };
    if token.is_empty() || token.len() > 2048 {
        return Ok(false);
    }
    // Tests stand in for Cloudflare with this secret: the token "pass" passes.
    #[cfg(test)]
    if t.secret == "test-secret" {
        return Ok(token == "pass");
    }
    // Siteverify takes JSON as well as a form.
    let mut body = serde_json::json!({ "secret": t.secret, "response": token, "idempotency_key": uuid::Uuid::new_v4().to_string() });
    if let Some(ip) = addr {
        body["remoteip"] = ip.to_string().into();
    }
    let answer = st
        .http
        .post(SITEVERIFY)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| AppError::Unavailable(format!("Couldn't reach Cloudflare to finish the check ({e}). Try again in a moment.")))?;
    let v: SiteVerify = answer.json().await.map_err(|e| AppError::Unavailable(format!("Cloudflare's answer to the check didn't read ({e}). Try again.")))?;
    if !v.success {
        tracing::info!(errors = ?v.error_codes, "a guest's Turnstile check was refused");
        return Ok(false);
    }
    Ok(v.action.as_deref() == Some(TURNSTILE_ACTION))
}

/// Delete guests older than [`GUEST_DAYS`], and everything they made, every hour.
pub fn spawn_sweeper(st: AppState) {
    tokio::spawn(async move {
        loop {
            match sweep(&st).await {
                Ok(0) => {}
                Ok(n) => tracing::info!(guests = n, "deleted guests past their week"),
                Err(err) => tracing::warn!(error = %err, "couldn't delete old guests"),
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

/// Delete the guests made more than [`GUEST_DAYS`] ago. Returns how many went.
pub async fn sweep(st: &AppState) -> AppResult<usize> {
    let before = (Utc::now() - Duration::days(GUEST_DAYS)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let old: Vec<String> = sqlx::query_scalar("SELECT id FROM users WHERE guest = 1 AND created_at < ? LIMIT 500").bind(before).fetch_all(&st.pool).await?;
    for id in &old {
        crate::admin::delete::delete_account(st, id).await?;
    }
    Ok(old.len())
}

#[cfg(test)]
pub(crate) mod tests {
    use crate::config::Turnstile;
    use crate::testutil::{config, send, state_with};
    use axum::Router;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode, header};
    use serde_json::{Value, json};
    use sqlx::SqlitePool;
    use tower::ServiceExt;

    /// A server with guest play on: open sign-up and a stand-in Turnstile whose token "pass" passes.
    pub(crate) async fn guest_server(state: Option<crate::routes::AppState>) -> (Router, SqlitePool) {
        let st = match state {
            Some(st) => st,
            None => {
                let mut cfg = config();
                cfg.open_signup = true;
                cfg.turnstile = Some(Turnstile { site_key: "site".into(), secret: "test-secret".into() });
                state_with(cfg, crate::db::test_pool().await).await
            }
        };
        let pool = st.pool.clone();
        (crate::routes::app(st), pool)
    }

    /// One request with the guest cookie (and an optional bearer): status, body and any cookie set.
    pub(crate) async fn as_guest(app: &Router, method: Method, path: &str, guest: Option<&str>, bearer: Option<&str>, body: Option<Value>) -> (StatusCode, Value, Option<String>) {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(g) = guest {
            req = req.header(header::COOKIE, format!("{}={g}", super::GUEST_COOKIE));
        }
        if let Some(b) = bearer {
            req = req.header(header::AUTHORIZATION, format!("Bearer {b}"));
        }
        let req = match body {
            Some(b) => req.header(header::CONTENT_TYPE, "application/json").body(Body::from(b.to_string())),
            None => req.body(Body::empty()),
        }
        .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let cookie = res
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .find_map(|v| v.strip_prefix(&format!("{}=", super::GUEST_COOKIE)).map(|rest| rest.split(';').next().unwrap_or("").to_string()));
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null), cookie)
    }

    /// Become a guest; returns the guest cookie's value.
    pub(crate) async fn become_guest(app: &Router) -> String {
        let (status, body, cookie) = as_guest(app, Method::POST, "/api/guest/session", None, None, Some(json!({ "turnstile": "pass" }))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["guest"], true);
        cookie.expect("a guest cookie")
    }

    #[tokio::test]
    async fn guest_play_is_off_without_turnstile_or_open_signup() {
        let (app, _) = crate::testutil::app().await;
        let (status, body) = send(&app, Method::GET, "/api/guest/session", None, None).await;
        assert_eq!((status, body["enabled"].as_bool(), body["site_key"].is_null()), (StatusCode::OK, Some(false), true));
        let (status, _) = send(&app, Method::POST, "/api/guest/session", None, Some(json!({ "turnstile": "pass" }))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);

        // Turnstile set up but open sign-up off: still off.
        let mut cfg = config();
        cfg.turnstile = Some(Turnstile { site_key: "site".into(), secret: "test-secret".into() });
        let (app, _) = guest_server(Some(state_with(cfg, crate::db::test_pool().await).await)).await;
        let (status, _) = send(&app, Method::POST, "/api/guest/session", None, Some(json!({ "turnstile": "pass" }))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_guest_needs_a_passing_check_and_reaches_only_the_play_routes() {
        let (app, pool) = guest_server(None).await;
        let (_, status_body) = send(&app, Method::GET, "/api/guest/session", None, None).await;
        assert_eq!((status_body["enabled"].as_bool(), status_body["site_key"].as_str()), (Some(true), Some("site")));
        // A failed or missing check makes nobody.
        for token in ["fail", ""] {
            let (status, _, cookie) = as_guest(&app, Method::POST, "/api/guest/session", None, None, Some(json!({ "turnstile": token }))).await;
            assert_eq!((status, cookie), (StatusCode::FORBIDDEN, None));
        }
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users").fetch_one(&pool).await.unwrap(), 0);

        let guest = become_guest(&app).await;
        let (made, name, limited): (String, String, bool) =
            sqlx::query_as(concat!("SELECT u.email, u.display_name, ", crate::auth::limited_sql!(), " FROM users u WHERE u.guest = 1")).fetch_one(&pool).await.unwrap();
        assert!(made.ends_with("@guest.yama.invalid"));
        assert_eq!((name.as_str(), limited), ("Guest", true));
        // Asking again with the cookie keeps the same guest.
        let (status, _, _) = as_guest(&app, Method::POST, "/api/guest/session", Some(&guest), None, Some(json!({ "turnstile": "fail" }))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users").fetch_one(&pool).await.unwrap(), 1);
        let (_, body, _) = as_guest(&app, Method::GET, "/api/guest/session", Some(&guest), None, None).await;
        assert_eq!((body["guest"].as_bool(), body["expires_at"].is_string()), (Some(true), true));

        // The play routes take the guest.
        for path in ["/api/play", "/api/play/status", "/api/precons"] {
            let (status, body, _) = as_guest(&app, Method::GET, path, Some(&guest), None, None).await;
            assert_eq!(status, StatusCode::OK, "{path}: {body}");
        }
        // Nothing else does, as a cookie or as a bearer token: the guest's session is not an account's.
        for path in ["/api/me", "/api/decks", "/api/collection", "/api/playgroups", "/api/games", "/api/watch"] {
            let (status, _, _) = as_guest(&app, Method::GET, path, Some(&guest), None, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{path} with the guest cookie");
            let (status, _, _) = as_guest(&app, Method::GET, path, None, Some(&guest), None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{path} with the guest token as a bearer");
        }
        let (status, _) = send(&app, Method::POST, "/mcp", Some(&guest), Some(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        // Guests play the computer: no joining by code.
        let (status, _, _) = as_guest(&app, Method::POST, "/api/play/join", Some(&guest), None, Some(json!({ "code": "ABCDEF", "deck_id": "x" }))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        // The admin's account lists leave guests out.
        let (_, admin) = crate::testutil::user(&pool, "admin@example.com").await;
        sqlx::query("UPDATE users SET is_admin = 1 WHERE email = 'admin@example.com'").execute(&pool).await.unwrap();
        let (status, list) = send(&app, Method::GET, "/api/admin/users", Some(&admin), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(list.as_array().unwrap().iter().all(|u| !u["email"].as_str().unwrap().ends_with(".invalid")), "{list}");

        // Ending it deletes the guest and clears the cookie.
        let (status, _, _) = as_guest(&app, Method::DELETE, "/api/guest/session", Some(&guest), None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users WHERE guest = 1").fetch_one(&pool).await.unwrap(), 0);
        let (status, _, _) = as_guest(&app, Method::GET, "/api/play", Some(&guest), None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn new_guests_are_limited_per_address() {
        let (app, _) = guest_server(None).await;
        for _ in 0..6 {
            become_guest(&app).await;
        }
        let (status, _, _) = as_guest(&app, Method::POST, "/api/guest/session", None, None, Some(json!({ "turnstile": "pass" }))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn guests_past_their_week_are_deleted() {
        let mut cfg = config();
        cfg.open_signup = true;
        cfg.turnstile = Some(Turnstile { site_key: "site".into(), secret: "test-secret".into() });
        let st = state_with(cfg, crate::db::test_pool().await).await;
        let (app, pool) = guest_server(Some(st.clone())).await;
        let old = become_guest(&app).await;
        let fresh = become_guest(&app).await;
        let (_, account) = crate::testutil::user(&pool, "someone@example.com").await;
        sqlx::query("UPDATE users SET created_at = '2026-01-01T00:00:00Z' WHERE guest = 1 AND id = (SELECT user_id FROM sessions WHERE token_hash = ?)")
            .bind(crate::util::sha256_hex(&old))
            .execute(&pool)
            .await
            .unwrap();
        // An old account that isn't a guest stays.
        sqlx::query("UPDATE users SET created_at = '2026-01-01T00:00:00Z' WHERE guest = 0").execute(&pool).await.unwrap();
        assert_eq!(super::sweep(&st).await.unwrap(), 1);
        assert_eq!(as_guest(&app, Method::GET, "/api/play", Some(&old), None, None).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(as_guest(&app, Method::GET, "/api/play", Some(&fresh), None, None).await.0, StatusCode::OK);
        assert_eq!(send(&app, Method::GET, "/api/me", Some(&account), None).await.0, StatusCode::OK);
    }
}
