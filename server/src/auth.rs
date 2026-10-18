//! Sign-in with Google ID tokens (web and native both send one), sessions, and the invite allowlist.

use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, random_token, sha256_hex};
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{Duration, Utc};
use jsonwebtoken::{DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::time::Instant;
use tokio::sync::RwLock;

pub const SESSION_COOKIE: &str = "yama_session";
const SESSION_DAYS: i64 = 90;
const GOOGLE_CERTS: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: [&str; 2] = ["accounts.google.com", "https://accounts.google.com"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/google", post(google_login))
        .route("/api/auth/dev", post(dev_login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/config", get(auth_config))
        .route("/api/me", get(me))
        .route("/api/invites", get(list_invites).post(create_invite))
        .route("/api/invites/{email}", delete(delete_invite))
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub is_admin: bool,
}

/// Extractor: the signed-in user, from the session cookie or `Authorization: Bearer`.
pub struct CurrentUser(pub User);

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let bearer = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_string);
        // WebSockets from the native apps can't send headers or share the web cookie, so they
        // pass the token as `?token=`. Only honored on WebSocket upgrades.
        let ws_token = parts
            .headers
            .get(axum::http::header::UPGRADE)
            .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
            .then(|| parts.uri.query())
            .flatten()
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=")))
            .map(str::to_string);
        let token = bearer
            .or(ws_token)
            .or_else(|| CookieJar::from_headers(&parts.headers).get(SESSION_COOKIE).map(|c| c.value().to_string()))
            .ok_or(AppError::Unauthorized)?;
        user_for_token(&state.pool, &token).await?.map(CurrentUser).ok_or(AppError::Unauthorized)
    }
}

pub async fn user_for_token(pool: &SqlitePool, token: &str) -> AppResult<Option<User>> {
    Ok(sqlx::query_as::<_, User>(
        "SELECT u.id, u.email, u.display_name, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?",
    )
    .bind(sha256_hex(token))
    .bind(now())
    .fetch_optional(pool)
    .await?)
}

#[derive(Serialize)]
struct LoginResponse {
    user: User,
    /// For native apps, which send it as a bearer token. The web app uses the cookie.
    token: String,
}

#[derive(Serialize)]
struct AuthConfig {
    google_client_id: Option<String>,
    dev_login: bool,
}

async fn auth_config(State(st): State<AppState>) -> Json<AuthConfig> {
    Json(AuthConfig { google_client_id: st.cfg.google_client_ids.first().cloned(), dev_login: st.cfg.dev_login })
}

#[derive(Deserialize)]
struct GoogleLogin {
    credential: String,
}

#[derive(Debug, Deserialize)]
struct GoogleClaims {
    sub: String,
    email: String,
    #[serde(default)]
    email_verified: bool,
    name: Option<String>,
}

async fn google_login(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(body): Json<GoogleLogin>,
) -> AppResult<(CookieJar, Json<LoginResponse>)> {
    if st.cfg.google_client_ids.is_empty() {
        return Err(AppError::bad("Google sign-in is not configured (YAMA_GOOGLE_CLIENT_IDS)"));
    }
    let claims = st.google_keys.verify(&st.http, &body.credential, &st.cfg.google_client_ids).await?;
    if !claims.email_verified {
        return Err(AppError::Forbidden("Google account email is not verified".into()));
    }
    ensure_allowed(&st, &claims.email).await?;
    let name = claims.name.clone().unwrap_or_else(|| claims.email.split('@').next().unwrap_or("player").to_string());
    let user = upsert_user(&st, Some(&claims.sub), &claims.email, &name).await?;
    start_session(&st, jar, user).await
}

#[derive(Deserialize)]
struct DevLogin {
    email: String,
    name: Option<String>,
}

async fn dev_login(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(body): Json<DevLogin>,
) -> AppResult<(CookieJar, Json<LoginResponse>)> {
    if !st.cfg.dev_login {
        return Err(AppError::NotFound("route"));
    }
    let email = body.email.trim().to_lowercase();
    if !email.contains('@') {
        return Err(AppError::bad("enter an email address"));
    }
    let name = body.name.filter(|n| !n.trim().is_empty()).unwrap_or_else(|| email.split('@').next().unwrap().to_string());
    let user = upsert_user(&st, None, &email, &name).await?;
    start_session(&st, jar, user).await
}

async fn logout(State(st): State<AppState>, jar: CookieJar) -> AppResult<CookieJar> {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?").bind(sha256_hex(c.value())).execute(&st.pool).await?;
    }
    Ok(jar.remove(Cookie::build(SESSION_COOKIE).path("/")))
}

async fn me(CurrentUser(user): CurrentUser) -> Json<User> {
    Json(user)
}

async fn ensure_allowed(st: &AppState, email: &str) -> AppResult<()> {
    let email = email.to_lowercase();
    if st.cfg.admin_emails.contains(&email) {
        return Ok(());
    }
    let invited: Option<(String,)> =
        sqlx::query_as("SELECT email FROM invites WHERE email = ?").bind(&email).fetch_optional(&st.pool).await?;
    match invited {
        Some(_) => Ok(()),
        None => Err(AppError::Forbidden(format!("{email} hasn't been invited to Yama yet"))),
    }
}

async fn upsert_user(st: &AppState, google_sub: Option<&str>, email: &str, name: &str) -> AppResult<User> {
    let is_admin = st.cfg.admin_emails.contains(&email.to_lowercase());
    sqlx::query(
        "INSERT INTO users (id, google_sub, email, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET google_sub = COALESCE(excluded.google_sub, users.google_sub),
                                          is_admin = excluded.is_admin",
    )
    .bind(new_id())
    .bind(google_sub)
    .bind(email)
    .bind(name)
    .bind(is_admin)
    .bind(now())
    .execute(&st.pool)
    .await?;
    Ok(sqlx::query_as::<_, User>("SELECT id, email, display_name, is_admin FROM users WHERE email = ?")
        .bind(email)
        .fetch_one(&st.pool)
        .await?)
}

async fn start_session(st: &AppState, jar: CookieJar, user: User) -> AppResult<(CookieJar, Json<LoginResponse>)> {
    let token = random_token();
    let expires = Utc::now() + Duration::days(SESSION_DAYS);
    sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(sha256_hex(&token))
        .bind(&user.id)
        .bind(now())
        .bind(expires.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .execute(&st.pool)
        .await?;
    let cookie = Cookie::build((SESSION_COOKIE, token.clone()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(st.cfg.secure_cookies)
        .max_age(time_days(SESSION_DAYS))
        .build();
    Ok((jar.add(cookie), Json(LoginResponse { user, token })))
}

fn time_days(days: i64) -> time::Duration {
    time::Duration::days(days)
}

// ── invites ────────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
struct Invite {
    email: String,
    created_at: String,
}

pub async fn add_invite(pool: &SqlitePool, email: &str, by: Option<&str>) -> AppResult<()> {
    let email = email.trim().to_lowercase();
    if !email.contains('@') {
        return Err(AppError::bad("not an email address"));
    }
    sqlx::query("INSERT INTO invites (email, invited_by, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(&email)
        .bind(by)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(())
}

async fn list_invites(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<Invite>>> {
    require_admin(&user)?;
    Ok(Json(sqlx::query_as("SELECT email, created_at FROM invites ORDER BY created_at").fetch_all(&st.pool).await?))
}

#[derive(Deserialize)]
struct NewInvite {
    email: String,
}

async fn create_invite(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(body): Json<NewInvite>,
) -> AppResult<()> {
    require_admin(&user)?;
    add_invite(&st.pool, &body.email, Some(&user.id)).await
}

async fn delete_invite(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    axum::extract::Path(email): axum::extract::Path<String>,
) -> AppResult<()> {
    require_admin(&user)?;
    let email = email.to_lowercase();
    sqlx::query("DELETE FROM invites WHERE email = ?").bind(&email).execute(&st.pool).await?;
    // Revoking an invite signs that person out everywhere, unless they're an admin.
    if !st.cfg.admin_emails.contains(&email) {
        sqlx::query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)").bind(&email).execute(&st.pool).await?;
    }
    Ok(())
}

fn require_admin(user: &User) -> AppResult<()> {
    if user.is_admin { Ok(()) } else { Err(AppError::Forbidden("admins only".into())) }
}

// ── Google signing keys ────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

#[derive(Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

/// Google rotates its keys every few days; refetch hourly or on an unknown `kid`.
#[derive(Default)]
pub struct GoogleKeys {
    cache: RwLock<Option<(Instant, Vec<Jwk>)>>,
}

impl GoogleKeys {
    async fn keys(&self, http: &reqwest::Client, force: bool) -> AppResult<Vec<Jwk>> {
        if !force && let Some((at, keys)) = &*self.cache.read().await && at.elapsed().as_secs() < 3600 {
            return Ok(keys.clone());
        }
        let set: JwkSet = http
            .get(GOOGLE_CERTS)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| anyhow::anyhow!("fetching Google keys: {e}"))?
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("parsing Google keys: {e}"))?;
        *self.cache.write().await = Some((Instant::now(), set.keys.clone()));
        Ok(set.keys)
    }

    async fn verify(&self, http: &reqwest::Client, token: &str, audiences: &[String]) -> AppResult<GoogleClaims> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| AppError::bad("malformed Google credential"))?;
        let kid = header.kid.ok_or_else(|| AppError::bad("Google credential has no key id"))?;
        let mut jwk = self.keys(http, false).await?.into_iter().find(|k| k.kid == kid);
        if jwk.is_none() {
            jwk = self.keys(http, true).await?.into_iter().find(|k| k.kid == kid);
        }
        let jwk = jwk.ok_or_else(|| AppError::bad("Google credential signed with an unknown key"))?;
        let key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e).map_err(|e| anyhow::anyhow!("bad Google key: {e}"))?;
        let mut validation = Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.set_audience(audiences);
        validation.set_issuer(&GOOGLE_ISSUERS);
        jsonwebtoken::decode::<GoogleClaims>(token, &key, &validation)
            .map(|d| d.claims)
            .map_err(|e| AppError::Forbidden(format!("Google credential rejected: {e}")))
    }
}
