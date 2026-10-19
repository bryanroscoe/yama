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
        .route("/api/auth/password", post(password_login))
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
            .or_else(|| CookieJar::from_headers(&parts.headers).get(SESSION_COOKIE).map(|c| c.value().to_string()));
        if let Some(token) = token
            && let Some(user) = user_for_token(&state.pool, &token).await?
        {
            return Ok(CurrentUser(user));
        }
        access_user(parts, state).await?.map(CurrentUser).ok_or(AppError::Unauthorized)
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
    /// Some account has a password (`yama-server user add`), so show the password form.
    password_login: bool,
    /// Signed in by Cloudflare Access before the app loads; sign-out goes through Cloudflare too.
    cf_access: bool,
}

async fn auth_config(State(st): State<AppState>) -> AppResult<Json<AuthConfig>> {
    let password_login: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE password_hash IS NOT NULL)")
        .fetch_one(&st.pool)
        .await?;
    Ok(Json(AuthConfig {
        google_client_id: st.cfg.google_client_ids.first().cloned(),
        dev_login: st.cfg.dev_login,
        password_login,
        cf_access: st.cf_keys.is_some(),
    }))
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
    let claims: GoogleClaims = st.google_keys.verify(&st.http, &body.credential, &st.cfg.google_client_ids, &GOOGLE_ISSUERS).await?;
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

#[derive(Deserialize)]
struct PasswordLogin {
    email: String,
    password: String,
}

/// Sign in to an account given a password with `yama-server user add`. Only someone with a shell
/// on the server can create one, so these accounts skip the invite check.
async fn password_login(
    State(st): State<AppState>,
    jar: CookieJar,
    Json(body): Json<PasswordLogin>,
) -> AppResult<(CookieJar, Json<LoginResponse>)> {
    let email = body.email.trim().to_lowercase();
    let row: Option<(String,)> = sqlx::query_as("SELECT password_hash FROM users WHERE email = ? AND password_hash IS NOT NULL")
        .bind(&email)
        .fetch_optional(&st.pool)
        .await?;
    let ok = match row {
        Some((hash,)) => {
            let password = body.password;
            tokio::task::spawn_blocking(move || verify_password(&password, &hash)).await.unwrap_or(false)
        }
        None => false,
    };
    if !ok {
        // Same answer and a pause either way: no hint which emails have accounts, and guessing is slow.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        tracing::warn!(%email, "failed password sign-in");
        return Err(AppError::Forbidden("wrong email or password".into()));
    }
    let user = sqlx::query_as::<_, User>("SELECT id, email, display_name, is_admin FROM users WHERE email = ?")
        .bind(&email)
        .fetch_one(&st.pool)
        .await?;
    start_session(&st, jar, user).await
}

// ── local accounts (command line) ──────────────────────────────────────────

/// `yama-server user add`: create the account if needed, give it a password, optionally make it admin.
/// Returns the generated password when none was supplied.
pub async fn add_local_user(
    pool: &SqlitePool,
    email: &str,
    name: Option<&str>,
    admin: bool,
    password: Option<String>,
) -> anyhow::Result<Option<String>> {
    let email = email.trim().to_lowercase();
    anyhow::ensure!(email.contains('@'), "{email} isn't an email address");
    let generated = password.is_none().then(generate_password);
    let password = password.or_else(|| generated.clone()).unwrap();
    anyhow::ensure!(password.chars().count() >= 12, "use a password of at least 12 characters");
    let hash = hash_password(&password)?;
    let name = name.map(str::to_string).unwrap_or_else(|| email.split('@').next().unwrap_or("player").to_string());
    sqlx::query(
        "INSERT INTO users (id, email, display_name, is_admin, admin_granted, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash,
                                          admin_granted = users.admin_granted OR excluded.admin_granted,
                                          is_admin = users.is_admin OR excluded.admin_granted",
    )
    .bind(new_id())
    .bind(&email)
    .bind(&name)
    .bind(admin)
    .bind(admin)
    .bind(&hash)
    .bind(now())
    .execute(pool)
    .await?;
    // A new password ends the account's existing sessions.
    sqlx::query("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)").bind(&email).execute(pool).await?;
    Ok(generated)
}

/// `yama-server user remove-password`: no more password sign-in, and sign the account out everywhere.
pub async fn remove_local_password(pool: &SqlitePool, email: &str) -> anyhow::Result<bool> {
    let email = email.trim().to_lowercase();
    let done = sqlx::query("UPDATE users SET password_hash = NULL WHERE email = ? AND password_hash IS NOT NULL")
        .bind(&email)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)").bind(&email).execute(pool).await?;
    Ok(done.rows_affected() > 0)
}

/// `yama-server user list`: who has an account and how they sign in.
pub async fn list_users(pool: &SqlitePool) -> anyhow::Result<()> {
    let rows: Vec<(String, String, bool, bool, bool)> = sqlx::query_as(
        "SELECT email, display_name, is_admin, password_hash IS NOT NULL, google_sub IS NOT NULL FROM users ORDER BY email",
    )
    .fetch_all(pool)
    .await?;
    for (email, name, admin, password, google) in rows {
        let how: Vec<&str> = [(google, "google"), (password, "password")].into_iter().filter(|(on, _)| *on).map(|(_, s)| s).collect();
        println!(
            "{email:<36} {name:<20} {:<6} {}",
            if admin { "admin" } else { "" },
            if how.is_empty() { "dev/access".to_string() } else { how.join(", ") }
        );
    }
    Ok(())
}

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    use argon2::password_hash::PasswordHasher;
    argon2::Argon2::default()
        .hash_password(password.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hashing password: {e}"))
}

fn verify_password(password: &str, hash: &str) -> bool {
    use argon2::password_hash::{PasswordVerifier, phc::PasswordHash};
    PasswordHash::new(hash).is_ok_and(|h| argon2::Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
}

/// A generated password: 20 characters from a 32-letter alphabet (100 bits), in groups of five.
pub fn generate_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789A";
    // Skip the UUID bytes that carry the fixed version and variant bits.
    let bytes: Vec<u8> = (0..3)
        .flat_map(|_| uuid::Uuid::new_v4().into_bytes().into_iter().enumerate().filter(|(i, _)| *i != 6 && *i != 8).map(|(_, b)| b))
        .take(20)
        .collect();
    let chars: Vec<char> = bytes.iter().map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect();
    chars.chunks(5).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-")
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

pub async fn upsert_user(st: &AppState, google_sub: Option<&str>, email: &str, name: &str) -> AppResult<User> {
    let is_admin = st.cfg.admin_emails.contains(&email.to_lowercase());
    sqlx::query(
        "INSERT INTO users (id, google_sub, email, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET google_sub = COALESCE(excluded.google_sub, users.google_sub),
                                          is_admin = excluded.is_admin OR users.admin_granted",
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
    // Revoking an invite signs that person out everywhere and revokes their script keys, unless
    // they're an admin.
    if !st.cfg.admin_emails.contains(&email) {
        sqlx::query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)").bind(&email).execute(&st.pool).await?;
        sqlx::query("UPDATE api_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND owner_id IN (SELECT id FROM users WHERE email = ?)")
            .bind(now())
            .bind(&email)
            .execute(&st.pool)
            .await?;
    }
    Ok(())
}

/// Admin-only routes. The planner uses it for lab approval only; plans have no admin read path.
pub(crate) fn require_admin(user: &User) -> AppResult<()> {
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

/// Signing keys for an identity provider (Google, Cloudflare Access). Providers rotate keys
/// every few days; refetch hourly or on an unknown `kid`.
pub struct JwkCache {
    url: String,
    cache: RwLock<Option<(Instant, Vec<Jwk>)>>,
}

pub type GoogleKeys = JwkCache;

impl Default for JwkCache {
    fn default() -> Self {
        Self::new(GOOGLE_CERTS)
    }
}

impl JwkCache {
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string(), cache: RwLock::new(None) }
    }

    async fn keys(&self, http: &reqwest::Client, force: bool) -> AppResult<Vec<Jwk>> {
        if !force && let Some((at, keys)) = &*self.cache.read().await && at.elapsed().as_secs() < 3600 {
            return Ok(keys.clone());
        }
        let set: JwkSet = http
            .get(&self.url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| anyhow::anyhow!("fetching signing keys from {}: {e}", self.url))?
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("parsing signing keys from {}: {e}", self.url))?;
        *self.cache.write().await = Some((Instant::now(), set.keys.clone()));
        Ok(set.keys)
    }

    async fn verify<T: serde::de::DeserializeOwned>(
        &self,
        http: &reqwest::Client,
        token: &str,
        audiences: &[String],
        issuers: &[&str],
    ) -> AppResult<T> {
        let header = jsonwebtoken::decode_header(token).map_err(|_| AppError::bad("malformed sign-in token"))?;
        let kid = header.kid.ok_or_else(|| AppError::bad("sign-in token has no key id"))?;
        let mut jwk = self.keys(http, false).await?.into_iter().find(|k| k.kid == kid);
        if jwk.is_none() {
            jwk = self.keys(http, true).await?.into_iter().find(|k| k.kid == kid);
        }
        let jwk = jwk.ok_or_else(|| AppError::bad("sign-in token signed with an unknown key"))?;
        let key = DecodingKey::from_rsa_components(&jwk.n, &jwk.e).map_err(|e| anyhow::anyhow!("bad signing key: {e}"))?;
        let mut validation = Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.set_audience(audiences);
        validation.set_issuer(issuers);
        jsonwebtoken::decode::<T>(token, &key, &validation)
            .map(|d| d.claims)
            .map_err(|e| AppError::Forbidden(format!("sign-in token rejected: {e}")))
    }
}

// ── Cloudflare Access ──────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct AccessClaims {
    email: String,
}

/// When Yama sits behind a Cloudflare Access application, Cloudflare has already checked who
/// this is (against its allow policy) and forwards a signed token. Verify it and sign the person
/// in; the Access policy is the invite list.
async fn access_user(parts: &Parts, state: &AppState) -> AppResult<Option<User>> {
    let (Some(team), Some(aud), Some(keys)) = (&state.cfg.cf_access_team, &state.cfg.cf_access_aud, &state.cf_keys) else {
        return Ok(None);
    };
    let token = parts
        .headers
        .get("cf-access-jwt-assertion")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .or_else(|| CookieJar::from_headers(&parts.headers).get("CF_Authorization").map(|c| c.value().to_string()));
    let Some(token) = token else { return Ok(None) };
    let issuer = format!("https://{team}.cloudflareaccess.com");
    let claims: AccessClaims = keys.verify(&state.http, &token, std::slice::from_ref(aud), &[issuer.as_str()]).await?;
    let email = claims.email.to_lowercase();
    if let Some(user) =
        sqlx::query_as::<_, User>("SELECT id, email, display_name, is_admin FROM users WHERE email = ?").bind(&email).fetch_optional(&state.pool).await?
    {
        return Ok(Some(user));
    }
    let name = email.split('@').next().unwrap_or("player").to_string();
    Ok(Some(upsert_user(state, None, &email, &name).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_passwords_look_right_and_verify() {
        let p = generate_password();
        assert_eq!(p.len(), 23, "{p}");
        assert_eq!(p.matches('-').count(), 3);
        assert_ne!(p, generate_password());
        let hash = hash_password(&p).unwrap();
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password(&p, &hash));
        assert!(!verify_password("not the password", &hash));
        assert!(!verify_password(&p, "garbage"));
    }

    #[tokio::test]
    async fn local_accounts_can_be_added_promoted_and_turned_off() {
        let pool = crate::db::test_pool().await;
        let generated = add_local_user(&pool, "Debug@Example.com", Some("Debug"), false, None).await.unwrap().unwrap();
        let (hash, admin): (String, bool) =
            sqlx::query_as("SELECT password_hash, is_admin FROM users WHERE email = 'debug@example.com'").fetch_one(&pool).await.unwrap();
        assert!(verify_password(&generated, &hash));
        assert!(!admin);

        // Adding again with --admin and a chosen password keeps one account and promotes it.
        assert!(add_local_user(&pool, "debug@example.com", None, true, Some("short".into())).await.is_err());
        assert!(add_local_user(&pool, "debug@example.com", None, true, Some("a long enough one".into())).await.unwrap().is_none());
        let (n, admin, granted): (i64, bool, bool) =
            sqlx::query_as("SELECT COUNT(*), MAX(is_admin), MAX(admin_granted) FROM users").fetch_one(&pool).await.unwrap();
        assert_eq!((n, admin, granted), (1, true, true));

        assert!(remove_local_password(&pool, "debug@example.com").await.unwrap());
        assert!(!remove_local_password(&pool, "debug@example.com").await.unwrap());
    }
}
