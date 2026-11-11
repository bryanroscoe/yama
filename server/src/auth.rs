//! Sign-in, sessions, invites, open sign-up and accounts an admin has turned off.
//!
//! Who gets in:
//! - **Google** (web and native both send an ID token): the token must be signed by Google for one
//!   of our client IDs, with issuer, audience, expiry and subject all present and checked, and a
//!   verified email (`email_verified`). With YAMA_OPEN_SIGNUP off (the default) the email must be
//!   an admin's or invited. With it on, anyone may make an account; an account that isn't invited
//!   is `limited` (the smaller lab and play allowance), and is shut out again if open sign-up is
//!   turned off. An account is tied to its Google subject: a different Google account with the
//!   same email is refused, and open sign-up never gives a Google sign-in an existing account that
//!   was made another way (a password, Cloudflare Access, dev login) unless that email is invited.
//! - **Password**: only accounts given one with `yama-server user add` on the server. No route
//!   creates a password account or sets a password. YAMA_PASSWORD_LOGIN=0 turns it off.
//! - **Cloudflare Access**: Access has already checked the person against its policy, which is
//!   the invite list.
//! - **Dev login**: any email, only while the server listens on localhost.
//!
//! Sign-in attempts (Google and password) are rate-limited per client address and per email
//! (`limits.rs`). A disabled account has no sessions, and every way in refuses it.

use crate::admin::AdminUser;
use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::limits::{ClientAddress, address_key};
use crate::routes::AppState;
use crate::util::{new_id, now, random_token, sha256_hex};
use axum::extract::{FromRequestParts, Path, State};
use axum::http::HeaderMap;
use axum::http::request::Parts;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{Duration, Utc};
use jsonwebtoken::{DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration as StdDuration, Instant};
use tokio::sync::RwLock;

pub const SESSION_COOKIE: &str = "yama_session";
const SESSION_DAYS: i64 = 90;
const GOOGLE_CERTS: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: [&str; 2] = ["accounts.google.com", "https://accounts.google.com"];
/// Claims a Google ID token must carry; jsonwebtoken only insists on `exp` by default, and skips
/// the issuer and audience checks for a token without them.
const GOOGLE_REQUIRED: [&str; 4] = ["exp", "iss", "aud", "sub"];
const ACCESS_REQUIRED: [&str; 3] = ["exp", "iss", "aud"];
/// Longest display name kept from a Google profile.
const MAX_NAME: usize = 60;
pub const DISABLED: &str = "This account has been turned off. Ask the host if that's a mistake.";

/// SQL that is true for a `users u` row with the smaller allowance (`User::limited`): a Google
/// account that isn't an admin, has no password from the command line, and isn't invited.
/// Accounts made any other way (Cloudflare Access, dev login, `user add`) never are. Being a power
/// user doesn't change the allowance; an invite does.
macro_rules! limited_sql {
    () => {
        "(u.google_sub IS NOT NULL AND u.is_admin = 0 AND u.password_hash IS NULL \
          AND NOT EXISTS (SELECT 1 FROM invites i WHERE i.email = u.email))"
    };
}
pub(crate) use limited_sql;

/// SQL that is true for a `users u` row that may use the heavy and AI features (`User::power`):
/// an admin, or an account an admin made a power user (migration 0047).
macro_rules! power_sql {
    () => {
        "(u.is_admin = 1 OR u.power_user = 1)"
    };
}
pub(crate) use power_sql;

/// Why a request for a power-user feature was refused.
pub const POWER_ONLY: &str = "Simulations and Ask Claude are open to admins and power users for now.";

/// The columns of [`User`], read from `users u`.
macro_rules! user_columns {
    () => {
        concat!(
            "u.id, u.email, u.display_name, u.is_admin, ",
            $crate::auth::limited_sql!(),
            " AS limited, ",
            $crate::auth::power_sql!(),
            " AS power"
        )
    };
}
pub(crate) use user_columns;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/google", post(google_login))
        .route("/api/auth/dev", post(dev_login))
        .route("/api/auth/password", post(password_login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/config", get(auth_config))
        .route("/api/me", get(me).delete(delete_me))
        .route("/api/invites", get(list_invites).post(create_invite))
        .route("/api/invites/{email}", delete(delete_invite))
        .route("/api/admin/users", get(admin_list_users))
        .route("/api/admin/users/{id}/disable", post(admin_disable_user))
        .route("/api/admin/users/{id}/enable", post(admin_enable_user))
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub is_admin: bool,
    /// A Google account that isn't invited (nor an admin or a password account): someone who
    /// joined through open sign-up, or whose invite was withdrawn. Gets the smaller lab and play
    /// allowance, and can't use Yama while open sign-up is off.
    pub limited: bool,
    /// An admin, or an account an admin made a power user: may start simulations and watched AI
    /// games and use Ask Claude (2026-10-31). Everyone else keeps their own data and reads
    /// simulation results, but can't start that work.
    pub power: bool,
}

impl User {
    /// Refuse a power-user feature (simulations, watched AI games, Ask Claude) to anyone else.
    pub fn require_power(&self) -> AppResult<()> {
        if self.power { Ok(()) } else { Err(AppError::Forbidden(POWER_ONLY.into())) }
    }
}

/// A user and whether an admin has turned the account off.
#[derive(sqlx::FromRow)]
struct AccountRow {
    #[sqlx(flatten)]
    user: User,
    disabled: bool,
}

async fn account_by_email(pool: &SqlitePool, email: &str) -> sqlx::Result<Option<AccountRow>> {
    sqlx::query_as(concat!("SELECT ", user_columns!(), ", u.disabled_at IS NOT NULL AS disabled FROM users u WHERE u.email = ?"))
        .bind(email)
        .fetch_optional(pool)
        .await
}

async fn account_by_id(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<AccountRow>> {
    sqlx::query_as(concat!("SELECT ", user_columns!(), ", u.disabled_at IS NOT NULL AS disabled FROM users u WHERE u.id = ?"))
        .bind(id)
        .fetch_optional(pool)
        .await
}

async fn account_by_google(pool: &SqlitePool, sub: &str) -> sqlx::Result<Option<AccountRow>> {
    sqlx::query_as(concat!("SELECT ", user_columns!(), ", u.disabled_at IS NOT NULL AS disabled FROM users u WHERE u.google_sub = ?"))
        .bind(sub)
        .fetch_optional(pool)
        .await
}

/// An account that isn't invited may use Yama only while open sign-up is on.
pub fn may_use_yama(cfg: &Config, user: &User) -> bool {
    cfg.open_signup || !user.limited
}

/// Extractor: the signed-in user, from the session cookie or `Authorization: Bearer`.
pub struct CurrentUser(pub User);

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let user = signed_in(parts, state).await?;
        // A write request's log line says whose it was (request_log.rs).
        crate::request_log::note_user(&parts.extensions, &user.id);
        Ok(CurrentUser(user))
    }
}

async fn signed_in(parts: &mut Parts, state: &AppState) -> Result<User, AppError> {
    // An admin viewing as someone (view_as.rs): the middleware checked the view and the
    // admin's own session, and refuses anything but reading, so this request is theirs.
    if let Some(view) = parts.extensions.get::<crate::view_as::ViewAs>() {
        return Ok(view.target.clone());
    }
    let bearer = bearer_token(&parts.headers);
    // OAuth access and refresh tokens (`oauth/`) are for `/mcp` only. Refuse them here rather
    // than fall back to the cookie, so a client sending one hears it doesn't work.
    if bearer.as_deref().is_some_and(crate::oauth::is_oauth_token) {
        return Err(AppError::Unauthorized);
    }
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
    let token = bearer.or(ws_token).or_else(|| cookie_token(&parts.headers));
    if let Some(token) = token
        && let Some(user) = user_for_token(state, &token).await?
    {
        return Ok(user);
    }
    access_user(parts, state).await?.ok_or(AppError::Unauthorized)
}

/// Extractor: the signed-in user, when they may use the power-user features (simulations, watched
/// AI games, Ask Claude). Anyone else signed in gets a 403 that says why; signed out is 401.
pub struct PowerUser(pub User);

impl FromRequestParts<AppState> for PowerUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        user.require_power()?;
        Ok(PowerUser(user))
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    CookieJar::from_headers(headers).get(SESSION_COOKIE).map(|c| c.value().to_string())
}

/// The session token an ordinary request carries: `Authorization: Bearer`, else the session cookie.
pub fn request_session_token(headers: &HeaderMap) -> Option<String> {
    bearer_token(headers).or_else(|| cookie_token(headers))
}

/// The live session's user. A disabled account has no sessions (disabling deletes them), and the
/// check here covers one made between that and now; an account that isn't invited only works
/// while open sign-up is on.
pub async fn user_for_token(st: &AppState, token: &str) -> AppResult<Option<User>> {
    let row: Option<SessionUser> = sqlx::query_as(concat!(
        "SELECT ",
        user_columns!(),
        ", u.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL"
    ))
    .bind(sha256_hex(token))
    .bind(now())
    .fetch_optional(&st.pool)
    .await?;
    let Some(row) = row.filter(|r| may_use_yama(&st.cfg, &r.user)) else { return Ok(None) };
    if seen_is_stale(row.last_seen_at.as_deref()) {
        note_seen(&st.pool, &row.user.id).await?;
    }
    Ok(Some(row.user))
}

/// An account by id, when it isn't disabled and may use Yama now (the same rule as sessions).
/// For credentials that name an account rather than a session: script keys and Claude's
/// one-question tool tokens (`mcp/`).
pub async fn user_by_id(st: &AppState, id: &str) -> AppResult<Option<User>> {
    let user: Option<User> = sqlx::query_as(concat!("SELECT ", user_columns!(), " FROM users u WHERE u.id = ? AND u.disabled_at IS NULL"))
        .bind(id)
        .fetch_optional(&st.pool)
        .await?;
    Ok(user.filter(|u| may_use_yama(&st.cfg, u)))
}

/// A session's user and when the account was last seen (`users.last_seen_at`, for the admin area).
#[derive(sqlx::FromRow)]
struct SessionUser {
    #[sqlx(flatten)]
    user: User,
    last_seen_at: Option<String>,
}

/// How often an account's last-seen time is rewritten: at most once an hour, so a busy session
/// costs one small write an hour rather than one per request.
const SEEN_EVERY: Duration = Duration::hours(1);

fn seen_is_stale(last: Option<&str>) -> bool {
    match last.and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()) {
        Some(t) => Utc::now().signed_duration_since(t) >= SEEN_EVERY,
        None => true,
    }
}

/// Record that the account used Yama now. The WHERE repeats the staleness check, so two requests
/// racing past the read write once.
async fn note_seen(pool: &SqlitePool, user_id: &str) -> AppResult<()> {
    let stamp = now();
    let since = (Utc::now() - SEEN_EVERY).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    sqlx::query("UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)")
        .bind(&stamp)
        .bind(user_id)
        .bind(since)
        .execute(pool)
        .await?;
    Ok(())
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
    /// Anyone with a Google account may join (YAMA_OPEN_SIGNUP, with Google sign-in set up).
    open_signup: bool,
}

async fn auth_config(State(st): State<AppState>) -> AppResult<Json<AuthConfig>> {
    let password_login = st.cfg.password_login
        && sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM users WHERE password_hash IS NOT NULL AND disabled_at IS NULL)")
            .fetch_one(&st.pool)
            .await?;
    Ok(Json(AuthConfig {
        google_client_id: st.cfg.google_client_ids.first().cloned(),
        dev_login: st.cfg.dev_login,
        password_login,
        cf_access: st.cf_keys.is_some(),
        open_signup: st.cfg.open_signup && !st.cfg.google_client_ids.is_empty(),
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
    /// Google sends a boolean; some older tokens carried the string "true". Missing is false.
    #[serde(default, deserialize_with = "bool_or_string")]
    email_verified: bool,
    name: Option<String>,
}

fn bool_or_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Flag {
        Bool(bool),
        Text(String),
    }
    Ok(match Option::<Flag>::deserialize(d)? {
        Some(Flag::Bool(b)) => b,
        Some(Flag::Text(t)) => t.eq_ignore_ascii_case("true"),
        None => false,
    })
}

async fn google_login(
    State(st): State<AppState>,
    ClientAddress(address): ClientAddress,
    jar: CookieJar,
    Json(body): Json<GoogleLogin>,
) -> AppResult<(CookieJar, Json<LoginResponse>)> {
    if st.cfg.google_client_ids.is_empty() {
        return Err(AppError::bad("Google sign-in is not configured (YAMA_GOOGLE_CLIENT_IDS)"));
    }
    // Checking the token means fetching Google's keys.
    if st.cfg.offline {
        return Err(crate::error::offline("Google"));
    }
    // Before any work, including fetching Google's keys.
    st.limits.sign_in_address.check(&address_key(address))?;
    let claims: GoogleClaims =
        st.google_keys.verify(&st.http, &body.credential, &st.cfg.google_client_ids, &GOOGLE_ISSUERS, &GOOGLE_REQUIRED).await?;
    if !claims.email_verified {
        return Err(AppError::Forbidden("Google account email is not verified".into()));
    }
    let email = claims.email.trim().to_lowercase();
    if !email.contains('@') {
        return Err(AppError::Forbidden("the Google sign-in had no email address".into()));
    }
    st.limits.sign_in_email.check(&email)?;
    let user = google_account(&st, &claims.sub, &email, claims.name.as_deref(), &address_key(address)).await?;
    start_session(&st, jar, user).await
}

fn not_invited(email: &str) -> AppError {
    AppError::Forbidden(format!("{email} hasn't been invited to Yama yet"))
}

fn is_admin_email(cfg: &Config, email: &str) -> bool {
    cfg.admin_emails.iter().any(|a| a.eq_ignore_ascii_case(email))
}

/// An admin's email, or one on the invite list.
async fn is_invited(st: &AppState, email: &str) -> AppResult<bool> {
    if is_admin_email(&st.cfg, email) {
        return Ok(true);
    }
    Ok(sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM invites WHERE email = ?)").bind(email).fetch_one(&st.pool).await?)
}

fn display_name(name: Option<&str>, email: &str) -> String {
    let name = name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or_else(|| email.split('@').next().unwrap_or("player"));
    name.chars().take(MAX_NAME).collect()
}

/// The account a verified Google sign-in (`sub`, lower-cased `email`) belongs to, made if need
/// be, or why it can't come in. See the module notes for the rules.
async fn google_account(st: &AppState, sub: &str, email: &str, name: Option<&str>, address: &str) -> AppResult<User> {
    let invited = is_invited(st, email).await?;
    let open = st.cfg.open_signup;
    let id = if let Some(acc) = account_by_google(&st.pool, sub).await? {
        // The Google account that signed in before (its email may have changed at Google since).
        if acc.disabled {
            return Err(AppError::Forbidden(DISABLED.into()));
        }
        if !open && !invited && acc.user.limited {
            return Err(not_invited(email));
        }
        acc.user.id
    } else {
        let by_email: Option<(String, Option<String>, bool)> =
            sqlx::query_as("SELECT id, google_sub, disabled_at IS NOT NULL FROM users WHERE email = ?").bind(email).fetch_optional(&st.pool).await?;
        match by_email {
            Some((_, Some(_), _)) => {
                tracing::warn!(%email, "Google sign-in refused: the email is tied to a different Google account");
                return Err(AppError::Forbidden(format!(
                    "{email} is tied to a different Google account in Yama. Sign in with that one, or ask the host."
                )));
            }
            Some((_, None, true)) => return Err(AppError::Forbidden(DISABLED.into())),
            Some((id, None, false)) => {
                // An account made another way. Only an invite lets Google into it; open sign-up never does.
                if !invited {
                    return Err(if open {
                        AppError::Forbidden(format!(
                            "{email} already has a Yama account that signs in another way. Ask the host to invite this email to add Google sign-in."
                        ))
                    } else {
                        not_invited(email)
                    });
                }
                sqlx::query("UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL").bind(sub).bind(&id).execute(&st.pool).await?;
                id
            }
            None => {
                if !open && !invited {
                    return Err(not_invited(email));
                }
                // Open sign-up makes accounts at a person's pace: a few per address a day, and a
                // ceiling for everyone together, so scripted sign-ups stop. Invites aren't counted.
                // One sign-up at a time from here to the count below (making accounts is rare), so
                // sign-ups arriving together can't all pass the limits before any is counted.
                let _gate = if invited { None } else { Some(st.limits.new_account_gate.lock().await) };
                // Another sign-in for this same Google account may have made it while this one
                // waited at the gate: then it's theirs to sign in to, with no limit to meet.
                let made_meanwhile: bool =
                    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM users WHERE google_sub = ?)").bind(sub).fetch_one(&st.pool).await?;
                if !invited && !made_meanwhile {
                    // Both must allow it, and it counts only once the account is really made
                    // (below): a refusal from the ceiling for everyone, or two sign-ins racing to
                    // make the same account, doesn't use up this address's own few.
                    st.limits.new_accounts_address.allows(address)?;
                    st.limits.new_accounts.allows("all")?;
                }
                let made = sqlx::query(
                    "INSERT INTO users (id, google_sub, email, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT DO NOTHING",
                )
                .bind(new_id())
                .bind(sub)
                .bind(email)
                .bind(display_name(name, email))
                .bind(now())
                .execute(&st.pool)
                .await?;
                if !invited && made.rows_affected() == 1 {
                    st.limits.new_accounts_address.record(address);
                    st.limits.new_accounts.record("all");
                    tracing::info!(%email, "new account through open sign-up");
                }
                // Two sign-ins at once: the second finds the first one's row.
                sqlx::query_scalar("SELECT id FROM users WHERE google_sub = ?")
                    .bind(sub)
                    .fetch_optional(&st.pool)
                    .await?
                    .ok_or_else(|| AppError::Conflict("another sign-in with this email happened at the same moment; try again".into()))?
            }
        }
    };
    // Admin from YAMA_ADMIN_EMAILS is applied at every sign-in; admin given on the command line stays.
    sqlx::query("UPDATE users SET is_admin = (? OR admin_granted) WHERE id = ?").bind(is_admin_email(&st.cfg, email)).bind(&id).execute(&st.pool).await?;
    Ok(account_by_id(&st.pool, &id).await?.ok_or(AppError::NotFound("account"))?.user)
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
    let name = display_name(body.name.as_deref(), &email);
    let user = upsert_user(&st, &email, &name).await?;
    start_session(&st, jar, user).await
}

#[derive(Deserialize)]
struct PasswordLogin {
    email: String,
    password: String,
}

/// Sign in to an account given a password with `yama-server user add`. Only someone with a shell
/// on the server can create one, so these accounts skip the invite check. This route never makes
/// an account or sets a password: an email without one is refused like a wrong password.
async fn password_login(
    State(st): State<AppState>,
    ClientAddress(address): ClientAddress,
    jar: CookieJar,
    Json(body): Json<PasswordLogin>,
) -> AppResult<(CookieJar, Json<LoginResponse>)> {
    if !st.cfg.password_login {
        return Err(AppError::Forbidden("password sign-in is turned off on this server".into()));
    }
    st.limits.sign_in_address.check(&address_key(address))?;
    let email = body.email.trim().to_lowercase();
    st.limits.sign_in_email.check(&email)?;
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
    let acc = account_by_email(&st.pool, &email).await?.ok_or(AppError::NotFound("account"))?;
    if acc.disabled {
        return Err(AppError::Forbidden(DISABLED.into()));
    }
    start_session(&st, jar, acc.user).await
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

/// `yama-server user list`: who has an account, how they sign in, and whether it's invited
/// (an account without an invite has the smaller allowance) or turned off.
pub async fn list_users(pool: &SqlitePool) -> anyhow::Result<()> {
    let rows: Vec<(String, String, bool, bool, bool, bool, bool)> = sqlx::query_as(concat!(
        "SELECT u.email, u.display_name, u.is_admin, u.password_hash IS NOT NULL, u.google_sub IS NOT NULL, ",
        limited_sql!(),
        ", u.disabled_at IS NOT NULL FROM users u ORDER BY u.email"
    ))
    .fetch_all(pool)
    .await?;
    for (email, name, admin, password, google, limited, disabled) in rows {
        let how: Vec<&str> = [(google, "google"), (password, "password")].into_iter().filter(|(on, _)| *on).map(|(_, s)| s).collect();
        let notes: Vec<&str> = [(limited, "not invited"), (disabled, "disabled")].into_iter().filter(|(on, _)| *on).map(|(_, s)| s).collect();
        println!(
            "{email:<36} {name:<20} {:<6} {:<18} {}",
            if admin { "admin" } else { "" },
            if how.is_empty() { "dev/access".to_string() } else { how.join(", ") },
            notes.join(", ")
        );
    }
    Ok(())
}

/// Turn an account off (its sessions end at once; every way in refuses it) or back on. Returns
/// false when there's no such account.
async fn set_disabled(pool: &SqlitePool, user_id: &str, disabled: bool) -> sqlx::Result<bool> {
    let mut tx = pool.begin().await?;
    let found = if disabled {
        let n = sqlx::query("UPDATE users SET disabled_at = COALESCE(disabled_at, ?) WHERE id = ?").bind(now()).bind(user_id).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM sessions WHERE user_id = ?").bind(user_id).execute(&mut *tx).await?;
        n.rows_affected() > 0
    } else {
        sqlx::query("UPDATE users SET disabled_at = NULL WHERE id = ?").bind(user_id).execute(&mut *tx).await?.rows_affected() > 0
    };
    tx.commit().await?;
    Ok(found)
}

/// `yama-server user disable EMAIL` / `user enable EMAIL`.
pub async fn set_disabled_by_email(pool: &SqlitePool, email: &str, disabled: bool) -> anyhow::Result<bool> {
    let email = email.trim().to_lowercase();
    let id: Option<String> = sqlx::query_scalar("SELECT id FROM users WHERE email = ?").bind(&email).fetch_optional(pool).await?;
    match id {
        Some(id) => Ok(set_disabled(pool, &id, disabled).await?),
        None => Ok(false),
    }
}

/// Longest session `yama-server user session` will make.
pub const CLI_SESSION_MAX_HOURS: i64 = 24;

/// `yama-server user session EMAIL --hours N`: a short session for an existing account, printed
/// once, for a tool that drives the web app as that person (the polish screenshots, docs/polish.md).
/// Only someone with a shell on the server can make one, the same trust as a password from
/// `user add`. It never makes an account, refuses a turned-off one, and the usual checks still apply
/// when it's used (an account that isn't invited only works while open sign-up is on).
pub async fn cli_session(pool: &SqlitePool, email: &str, hours: i64) -> anyhow::Result<String> {
    anyhow::ensure!((1..=CLI_SESSION_MAX_HOURS).contains(&hours), "--hours is 1 to {CLI_SESSION_MAX_HOURS}");
    let email = email.trim().to_lowercase();
    let acc = account_by_email(pool, &email).await?.ok_or_else(|| anyhow::anyhow!("there's no account for {email}"))?;
    anyhow::ensure!(!acc.disabled, "{email} is turned off");
    let token = random_token();
    let expires = Utc::now() + Duration::hours(hours);
    sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .bind(sha256_hex(&token))
        .bind(&acc.user.id)
        .bind(now())
        .bind(expires.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .execute(pool)
        .await?;
    Ok(token)
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

/// Every session token a request presents: the bearer (the native apps have no cookie) and the
/// session cookie (the web). Usually one, or the same one twice.
fn presented_session_tokens(headers: &HeaderMap) -> Vec<String> {
    let mut tokens: Vec<String> = bearer_token(headers).into_iter().chain(cookie_token(headers)).collect();
    tokens.dedup();
    tokens
}

/// Sign out: end the session this request came with, whichever way it was sent. The native apps
/// send only `Authorization: Bearer`, so deleting by cookie alone left their 90-day session live.
async fn logout(State(st): State<AppState>, headers: HeaderMap, jar: CookieJar) -> AppResult<CookieJar> {
    let hashes: Vec<String> = presented_session_tokens(&headers).iter().map(|t| sha256_hex(t)).collect();
    // Signing out while viewing as someone ends the view too (and every view of this session).
    let jar = crate::view_as::end_for_logout(&st, jar, &hashes).await?;
    for hash in &hashes {
        sqlx::query("DELETE FROM sessions WHERE token_hash = ?").bind(hash).execute(&st.pool).await?;
    }
    Ok(jar.remove(Cookie::build(SESSION_COOKIE).path("/")))
}

/// `/api/me`: the user, and while an admin views as them, who is viewing and until when.
#[derive(Serialize)]
struct Me {
    #[serde(flatten)]
    user: User,
    #[serde(skip_serializing_if = "Option::is_none")]
    viewing: Option<crate::view_as::Viewing>,
}

async fn me(CurrentUser(user): CurrentUser, crate::view_as::MaybeView(view): crate::view_as::MaybeView) -> Json<Me> {
    Json(Me { user, viewing: view.as_ref().map(crate::view_as::Viewing::from) })
}

#[derive(Deserialize)]
struct DeleteMe {
    /// The account's email, typed to confirm.
    confirm_email: String,
}

/// `DELETE /api/me`: the signed-in person deletes their own account and everything it owns, as
/// an admin's deletion does (`admin/delete.rs` says what goes and what stays, anonymised, for
/// other people's records). Google Play wants this in the app and at a web link (`/account/`).
/// It takes a Yama session (script keys, OAuth tokens and Cloudflare Access alone can't), never
/// runs while an admin views as someone or on a server behind Cloudflare Access, and refuses an
/// admin account: Access and YAMA_ADMIN_EMAILS would only make them again.
async fn delete_me(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    crate::view_as::MaybeView(view): crate::view_as::MaybeView,
    headers: HeaderMap,
    jar: CookieJar,
    Json(body): Json<DeleteMe>,
) -> AppResult<(CookieJar, Json<crate::admin::delete::DeleteReport>)> {
    if view.is_some() {
        return Err(AppError::Forbidden("stop viewing as someone to delete an account".into()));
    }
    // Behind Cloudflare Access the Access credential would sign the account straight back in and
    // make it again, whatever happens to the Yama session: there an admin removes the person from
    // the Access policy and deletes the account.
    if st.cfg.cf_access_team.is_some() {
        return Err(AppError::Forbidden("on this server an admin deletes accounts; ask yours".into()));
    }
    // A Yama session of this account, not Cloudflare Access alone: Access would sign the
    // account straight back in, making it again (`upsert_user`).
    let session = match bearer_token(&headers).or_else(|| cookie_token(&headers)) {
        Some(token) => user_for_token(&st, &token).await?.is_some_and(|u| u.id == user.id),
        None => false,
    };
    if !session {
        return Err(AppError::Forbidden("this sign-in can't delete its account; ask an admin to delete it".into()));
    }
    if user.is_admin {
        return Err(AppError::Forbidden("an admin account can't be deleted here; remove it from YAMA_ADMIN_EMAILS first".into()));
    }
    if !body.confirm_email.trim().eq_ignore_ascii_case(&user.email) {
        return Err(AppError::bad("type your account's email exactly to confirm"));
    }
    let report = crate::admin::delete::delete_account(&st, &user.id).await?;
    tracing::info!(account = %report.email, games_kept = report.games_kept, games_deleted = report.games_deleted,
        rows = report.rows_deleted, "account deleted by its owner");
    Ok((jar.remove(Cookie::build(SESSION_COOKIE).path("/")), Json(report)))
}

/// The account for a dev login or a Cloudflare Access sign-in, made if need be. Admin from
/// YAMA_ADMIN_EMAILS is applied again; a disabled account is refused.
async fn upsert_user(st: &AppState, email: &str, name: &str) -> AppResult<User> {
    let is_admin = is_admin_email(&st.cfg, email);
    sqlx::query(
        "INSERT INTO users (id, email, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET is_admin = excluded.is_admin OR users.admin_granted",
    )
    .bind(new_id())
    .bind(email)
    .bind(name)
    .bind(is_admin)
    .bind(now())
    .execute(&st.pool)
    .await?;
    let acc = account_by_email(&st.pool, email).await?.ok_or(AppError::NotFound("account"))?;
    if acc.disabled {
        return Err(AppError::Forbidden(DISABLED.into()));
    }
    Ok(acc.user)
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
    // Signing in counts as being seen.
    sqlx::query("UPDATE users SET last_seen_at = ? WHERE id = ?").bind(now()).bind(&user.id).execute(&st.pool).await?;
    // Housekeeping never fails a sign-in.
    if let Err(err) = sweep_sessions(&st.pool).await {
        tracing::warn!(error = %err, "couldn't delete expired sessions");
    }
    let cookie = Cookie::build((SESSION_COOKIE, token.clone()))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(st.cfg.secure_cookies)
        .max_age(time_days(SESSION_DAYS))
        .build();
    Ok((jar.add(cookie), Json(LoginResponse { user, token })))
}

static LAST_SESSION_SWEEP: AtomicI64 = AtomicI64::new(0);
const SESSION_SWEEP_EVERY_SECONDS: i64 = 600;

/// Delete expired sessions, at most every ten minutes, when someone signs in (the way `oauth`
/// sweeps its codes and tokens). A session past its 90 days signs nobody in (`user_for_token`
/// checks the date), but each sign-in adds a row and nothing ever took one away.
async fn sweep_sessions(pool: &SqlitePool) -> sqlx::Result<()> {
    let at = Utc::now().timestamp();
    let last = LAST_SESSION_SWEEP.load(Ordering::Relaxed);
    if at - last < SESSION_SWEEP_EVERY_SECONDS || LAST_SESSION_SWEEP.compare_exchange(last, at, Ordering::Relaxed, Ordering::Relaxed).is_err() {
        return Ok(());
    }
    delete_expired_sessions(pool).await.map(|_| ())
}

/// Delete every session whose time is up. Returns how many went.
async fn delete_expired_sessions(pool: &SqlitePool) -> sqlx::Result<u64> {
    Ok(sqlx::query("DELETE FROM sessions WHERE expires_at <= ?").bind(now()).execute(pool).await?.rows_affected())
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

async fn list_invites(State(st): State<AppState>, AdminUser(_): AdminUser) -> AppResult<Json<Vec<Invite>>> {
    Ok(Json(sqlx::query_as("SELECT email, created_at FROM invites ORDER BY created_at").fetch_all(&st.pool).await?))
}

#[derive(Deserialize)]
struct NewInvite {
    email: String,
}

async fn create_invite(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    Json(body): Json<NewInvite>,
) -> AppResult<()> {
    add_invite(&st.pool, &body.email, Some(&user.id)).await
}

async fn delete_invite(
    State(st): State<AppState>,
    AdminUser(_): AdminUser,
    axum::extract::Path(email): axum::extract::Path<String>,
) -> AppResult<()> {
    remove_invite(&st, &email).await
}

/// Withdraw an invite. Unless the email is an admin's, that person is signed out everywhere and
/// their script keys and connected apps are revoked; with open sign-up they may sign in again with the smaller
/// allowance.
pub(crate) async fn remove_invite(st: &AppState, email: &str) -> AppResult<()> {
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
        crate::oauth::revoke_all_for_email(&st.pool, &email).await?;
    }
    Ok(())
}


// ── accounts (admins) ──────────────────────────────────────────────────────

/// An account as the admin list in Group shows it.
#[derive(Serialize, sqlx::FromRow)]
struct AccountInfo {
    id: String,
    email: String,
    display_name: String,
    is_admin: bool,
    limited: bool,
    invited: bool,
    /// Made a power user by an admin (admins are power users without it).
    power_user: bool,
    google: bool,
    password: bool,
    disabled_at: Option<String>,
    created_at: String,
    /// The newest session's start: roughly the last sign-in.
    last_sign_in: Option<String>,
    /// When the account last used Yama (to the hour).
    last_seen_at: Option<String>,
}

/// Newest accounts first, at most 500.
async fn admin_list_users(State(st): State<AppState>, AdminUser(_): AdminUser) -> AppResult<Json<Vec<AccountInfo>>> {
    Ok(Json(
        sqlx::query_as(concat!(
            "SELECT u.id, u.email, u.display_name, u.is_admin, ",
            limited_sql!(),
            " AS limited, EXISTS (SELECT 1 FROM invites i WHERE i.email = u.email) AS invited, u.power_user = 1 AS power_user,
               u.google_sub IS NOT NULL AS google, u.password_hash IS NOT NULL AS password, u.disabled_at, u.created_at,
               (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_sign_in, u.last_seen_at
             FROM users u ORDER BY u.created_at DESC, u.email LIMIT 500"
        ))
        .fetch_all(&st.pool)
        .await?,
    ))
}

async fn admin_disable_user(State(st): State<AppState>, AdminUser(user): AdminUser, Path(id): Path<String>) -> AppResult<()> {
    if id == user.id {
        return Err(AppError::bad("you can't turn off your own account"));
    }
    let target = account_by_id(&st.pool, &id).await?.ok_or(AppError::NotFound("account"))?;
    if target.user.is_admin {
        return Err(AppError::Forbidden("an admin can only be turned off on the server: yama-server user disable EMAIL".into()));
    }
    set_disabled(&st.pool, &id, true).await?;
    tracing::info!(by = %user.email, account = %target.user.email, "account disabled");
    Ok(())
}

async fn admin_enable_user(State(st): State<AppState>, AdminUser(_): AdminUser, Path(id): Path<String>) -> AppResult<()> {
    if !set_disabled(&st.pool, &id, false).await? {
        return Err(AppError::NotFound("account"));
    }
    Ok(())
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
/// every few days; refetch when the provider's Cache-Control max-age runs out (an hour if it
/// gives none) or on an unknown `kid`, but at most once a minute, so tokens with made-up key ids
/// can't make Yama hammer the provider. A refresh that fails keeps the keys already held, for up
/// to a day past their age, so a provider hiccup doesn't sign everybody out.
pub struct JwkCache {
    url: String,
    cache: RwLock<Option<HeldKeys>>,
    /// Keys given up front (tests): never fetched.
    fixed: bool,
}

struct HeldKeys {
    keys: Vec<Jwk>,
    fetched: Instant,
    max_age: StdDuration,
    /// The last fetch tried, failed or not.
    tried: Instant,
}

/// Soonest refetch after the last try when a token names an unknown key or a refresh failed.
const MIN_REFETCH: StdDuration = StdDuration::from_secs(60);
/// How long keys whose refresh keeps failing stay in use past their max-age.
const STALE_KEYS: StdDuration = StdDuration::from_secs(24 * 3600);

/// A response's Cache-Control max-age, kept between five minutes and a day; an hour without one.
fn max_age(headers: &reqwest::header::HeaderMap) -> StdDuration {
    let secs = headers
        .get_all(reqwest::header::CACHE_CONTROL)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .find_map(|d| d.trim().strip_prefix("max-age=").and_then(|n| n.trim().parse::<u64>().ok()))
        .unwrap_or(3600);
    StdDuration::from_secs(secs.clamp(300, 24 * 3600))
}

pub type GoogleKeys = JwkCache;

impl Default for JwkCache {
    fn default() -> Self {
        Self::new(GOOGLE_CERTS)
    }
}

impl JwkCache {
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string(), cache: RwLock::new(None), fixed: false }
    }

    /// Keys known up front, as (kid, n, e); nothing is ever fetched.
    #[cfg(test)]
    pub fn fixed(keys: &[(&str, &str, &str)]) -> Self {
        let keys = keys.iter().map(|(kid, n, e)| Jwk { kid: kid.to_string(), n: n.to_string(), e: e.to_string() }).collect();
        let now = Instant::now();
        Self { url: String::new(), cache: RwLock::new(Some(HeldKeys { keys, fetched: now, max_age: StdDuration::MAX, tried: now })), fixed: true }
    }

    async fn keys(&self, http: &reqwest::Client, force: bool) -> AppResult<Vec<Jwk>> {
        if let Some(held) = &*self.cache.read().await {
            let fresh = held.fetched.elapsed() < held.max_age && !force;
            if self.fixed || fresh || held.tried.elapsed() < MIN_REFETCH {
                return Ok(held.keys.clone());
            }
        }
        if self.fixed {
            return Ok(Vec::new());
        }
        let fetched = self.fetch(http).await;
        let mut cache = self.cache.write().await;
        let now = Instant::now();
        match (fetched, cache.as_mut()) {
            (Ok((keys, max_age)), _) => {
                *cache = Some(HeldKeys { keys: keys.clone(), fetched: now, max_age, tried: now });
                Ok(keys)
            }
            (Err(e), Some(held)) if held.fetched.elapsed() < held.max_age.saturating_add(STALE_KEYS) => {
                tracing::warn!(error = %e, age_secs = held.fetched.elapsed().as_secs(), "couldn't refresh signing keys; still using the ones held");
                held.tried = now;
                Ok(held.keys.clone())
            }
            (Err(e), _) => Err(e),
        }
    }

    async fn fetch(&self, http: &reqwest::Client) -> AppResult<(Vec<Jwk>, StdDuration)> {
        let res = http
            .get(&self.url)
            .timeout(StdDuration::from_secs(10))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| anyhow::anyhow!("fetching signing keys from {}: {e}", self.url))?;
        let max_age = max_age(res.headers());
        let set: JwkSet = res.json().await.map_err(|e| anyhow::anyhow!("parsing signing keys from {}: {e}", self.url))?;
        Ok((set.keys, max_age))
    }

    async fn verify<T: serde::de::DeserializeOwned>(
        &self,
        http: &reqwest::Client,
        token: &str,
        audiences: &[String],
        issuers: &[&str],
        required: &[&str],
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
        validation.set_required_spec_claims(required);
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
    let claims: AccessClaims = keys.verify(&state.http, &token, std::slice::from_ref(aud), &[issuer.as_str()], &ACCESS_REQUIRED).await?;
    let email = claims.email.to_lowercase();
    if let Some(acc) = account_by_email(&state.pool, &email).await? {
        if acc.disabled {
            return Err(AppError::Forbidden(DISABLED.into()));
        }
        return Ok(Some(acc.user));
    }
    let name = display_name(None, &email);
    Ok(Some(upsert_user(state, &email, &name).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn signing_keys_follow_max_age_and_survive_a_failed_refresh() {
        use std::sync::atomic::{AtomicU16, Ordering};
        let status = std::sync::Arc::new(AtomicU16::new(200));
        let code = status.clone();
        let app = axum::Router::new().route(
            "/certs",
            axum::routing::get(move || {
                let code = code.clone();
                async move {
                    let code = axum::http::StatusCode::from_u16(code.load(Ordering::SeqCst)).unwrap();
                    (code, [("cache-control", "public, max-age=600, must-revalidate")], r#"{"keys":[{"kid":"a","n":"n","e":"e","kty":"RSA"}]}"#)
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/certs", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = crate::routes::http_client();
        let cache = JwkCache::new(&url);
        assert_eq!(cache.keys(&http, false).await.unwrap()[0].kid, "a");
        assert_eq!(cache.cache.read().await.as_ref().unwrap().max_age, StdDuration::from_secs(600));
        // Their age is up and the provider fails: the keys held stay in use.
        status.store(500, Ordering::SeqCst);
        /// Make the held keys `secs` old; None if this machine hasn't been up that long.
        async fn age(cache: &JwkCache, secs: u64) -> Option<()> {
            let at = Instant::now().checked_sub(StdDuration::from_secs(secs))?;
            let mut held = cache.cache.write().await;
            let held = held.as_mut().unwrap();
            held.fetched = at;
            held.tried = at;
            Some(())
        }
        age(&cache, 700).await.unwrap();
        assert_eq!(cache.keys(&http, false).await.unwrap()[0].kid, "a");
        // A day past their age, they aren't (when this machine has been up long enough to say).
        if age(&cache, 700 + 24 * 3600).await.is_some() {
            assert!(cache.keys(&http, false).await.is_err());
        }
        // Nothing held and a failure: an error.
        assert!(JwkCache::new(&url).keys(&http, false).await.is_err());
    }

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

    /// The native apps sign in with a bearer and have no cookie: signing out must end that
    /// session too, not only one named by a cookie.
    #[tokio::test]
    async fn sign_out_ends_a_bearer_session_and_only_that_one() {
        use axum::http::{Method, StatusCode};
        let (app, pool) = crate::testutil::app().await;
        let (id, phone) = crate::testutil::user(&pool, "pat@example.com").await;
        // A second device of the same account, and another account, stay signed in.
        let laptop = cli_session(&pool, "pat@example.com", 1).await.unwrap();
        let (_, sam) = crate::testutil::user(&pool, "sam@example.com").await;

        let (status, _) = crate::testutil::send(&app, Method::POST, "/api/auth/logout", Some(&phone), None).await;
        assert!(status.is_success(), "{status}");
        let (status, _) = crate::testutil::send(&app, Method::GET, "/api/me", Some(&phone), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE token_hash = ?").bind(sha256_hex(&phone)).fetch_one(&pool).await.unwrap();
        assert_eq!(left, 0);
        for other in [&laptop, &sam] {
            let (status, _) = crate::testutil::send(&app, Method::GET, "/api/me", Some(other), None).await;
            assert_eq!(status, StatusCode::OK);
        }
        let mine: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = ?").bind(&id).fetch_one(&pool).await.unwrap();
        assert_eq!(mine, 1);
        // Signing out twice, or with no session at all, is still a success.
        let (status, _) = crate::testutil::send(&app, Method::POST, "/api/auth/logout", Some(&phone), None).await;
        assert!(status.is_success(), "{status}");
        let (status, _) = crate::testutil::send(&app, Method::POST, "/api/auth/logout", None, None).await;
        assert!(status.is_success(), "{status}");
    }

    #[tokio::test]
    async fn expired_sessions_are_deleted_and_live_ones_kept() {
        let (app, pool) = crate::testutil::app().await;
        let (pat, live) = crate::testutil::user(&pool, "pat@example.com").await;
        let short = cli_session(&pool, "pat@example.com", 1).await.unwrap();
        for (hash, expires) in [("old-1", "2020-01-01T00:00:00Z"), ("old-2", "2026-01-01T00:00:00Z")] {
            sqlx::query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, '2019-10-01T00:00:00Z', ?)")
                .bind(hash).bind(&pat).bind(expires).execute(&pool).await.unwrap();
        }
        assert_eq!(delete_expired_sessions(&pool).await.unwrap(), 2);
        assert_eq!(delete_expired_sessions(&pool).await.unwrap(), 0);
        let left: Vec<String> = sqlx::query_scalar("SELECT token_hash FROM sessions ORDER BY token_hash").fetch_all(&pool).await.unwrap();
        let mut expected = vec![sha256_hex(&live), sha256_hex(&short)];
        expected.sort();
        assert_eq!(left, expected);
        for token in [&live, &short] {
            let (status, _) = crate::testutil::send(&app, axum::http::Method::GET, "/api/me", Some(token), None).await;
            assert_eq!(status, axum::http::StatusCode::OK);
        }
    }

    #[tokio::test]
    async fn cli_sessions_are_short_and_only_for_live_accounts() {
        let (app, pool) = crate::testutil::app().await;
        crate::testutil::user(&pool, "polish@example.com").await;
        let token = cli_session(&pool, "Polish@Example.com", 2).await.unwrap();
        let (status, me) = crate::testutil::send(&app, axum::http::Method::GET, "/api/me", Some(&token), None).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(me["email"], "polish@example.com");
        let expires: String = sqlx::query_scalar("SELECT expires_at FROM sessions WHERE token_hash = ?").bind(sha256_hex(&token)).fetch_one(&pool).await.unwrap();
        let left = chrono::DateTime::parse_from_rfc3339(&expires).unwrap().with_timezone(&Utc) - Utc::now();
        assert!(left <= Duration::hours(2) && left > Duration::minutes(110), "{left}");

        assert!(cli_session(&pool, "polish@example.com", 0).await.is_err());
        assert!(cli_session(&pool, "polish@example.com", CLI_SESSION_MAX_HOURS + 1).await.is_err());
        assert!(cli_session(&pool, "nobody@example.com", 1).await.is_err());
        assert!(set_disabled_by_email(&pool, "polish@example.com", true).await.unwrap());
        assert!(cli_session(&pool, "polish@example.com", 1).await.is_err());
        let (status, _) = crate::testutil::send(&app, axum::http::Method::GET, "/api/me", Some(&token), None).await;
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    }
}
