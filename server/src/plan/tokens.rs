//! Script keys for `publish.py` and `pull.py` (docs/planner-design.md 5.1, Decision 12).
//!
//! A key is `yama_pat_` plus 64 hex digits (`util::random_token`). Only its SHA-256 is stored, in
//! `api_tokens`, with a scope, an expiry and a revoked time. A `plan:sync` key is accepted only by
//! the `SyncUser` extractor, on the routes a script needs (import, head, inbox, ack); an `mcp` key
//! only by `POST /mcp` (Claude's tools, `mcp/`).
//! Admin-only `lab:worker:saget|laptop|github` keys are accepted only by the lab worker API.
//!
//! `CurrentUser` never accepts a key: it looks bearer tokens (and WebSocket `?token=`) up in
//! `sessions`, where a key never is, so a key anywhere else is a 401. A key is never admin, and a
//! key can't make keys, because the key routes below take `CurrentUser`. Revoking someone's invite
//! revokes their keys (`auth::delete_invite`); `yama-server user add` ends sessions, not keys. A
//! disabled account's keys are refused while it stays disabled, and so are the keys of an account
//! that isn't invited while open sign-up is off (the same rule as its sessions).

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, random_token, sha256_hex};
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::{Json, Router};
use chrono::{Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

pub const PREFIX: &str = "yama_pat_";
pub const SCOPE_SYNC: &str = "plan:sync";
/// Claude's tools from outside Yama (`mcp/`, `POST /mcp`): reads the account's data and, later,
/// stages changes for review. A key has one scope; `plan:sync` keys can't use the tools.
pub const SCOPE_MCP: &str = "mcp";
const DEFAULT_DAYS: i64 = 365;
const MAX_DAYS: i64 = 730;
/// Live (not revoked, not expired) keys one account may hold.
const MAX_LIVE: i64 = 20;

pub fn router() -> Router<AppState> {
    use axum::routing::{delete, get};
    Router::new()
        .route("/api/me/tokens", get(list).post(create))
        .route("/api/me/tokens/{id}", delete(revoke))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Session,
    Token,
}

/// Extractor for the routes a script may call: a `yama_pat_` key with the `plan:sync` scope, or
/// anything `CurrentUser` accepts (cookie, session bearer, Cloudflare Access). Never carries admin.
pub struct SyncUser {
    pub user_id: String,
    pub via: Via,
    /// The account isn't invited (`auth::User::limited`): smaller imports.
    pub limited: bool,
    pub is_admin: bool,
}

impl FromRequestParts<AppState> for SyncUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let key = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .filter(|t| t.starts_with(PREFIX))
            .map(str::to_string);
        if let Some(key) = key {
            // A key that doesn't work never falls back to a cookie: the script should hear about it.
            let owner = user_for_key(&state.pool, &key, SCOPE_SYNC)
                .await?
                .filter(|o| state.cfg.open_signup || !o.limited)
                .ok_or(AppError::Unauthorized)?;
            crate::request_log::note_user(&parts.extensions, &owner.id);
            return Ok(SyncUser { user_id: owner.id, via: Via::Token, limited: owner.limited, is_admin: owner.is_admin });
        }
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        Ok(SyncUser { user_id: user.id, via: Via::Session, limited: user.limited, is_admin: user.is_admin })
    }
}

fn time(t: chrono::DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// Whose a key is.
pub struct KeyOwner {
    pub id: String,
    pub limited: bool,
    pub is_admin: bool,
}

/// The owner of a live key with `scope` whose account isn't disabled, or `None`. Records the
/// key's last use, at most once a minute.
pub async fn user_for_key(pool: &SqlitePool, key: &str, scope: &str) -> AppResult<Option<KeyOwner>> {
    let stamp = now();
    let row: Option<(String, String, bool, bool, Option<String>)> = sqlx::query_as(concat!(
        "SELECT t.id, t.owner_id, ",
        crate::auth::limited_sql!(),
        ", u.is_admin, t.last_used_at FROM api_tokens t JOIN users u ON u.id = t.owner_id
         WHERE t.token_hash = ? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?) AND u.disabled_at IS NULL
           AND EXISTS (SELECT 1 FROM json_each(t.scopes) WHERE value = ?)"
    ))
    .bind(sha256_hex(key))
    .bind(&stamp)
    .bind(scope)
    .fetch_optional(pool)
    .await?;
    let Some((id, owner, limited, is_admin, last)) = row else { return Ok(None) };
    let minute_ago = time(Utc::now() - Duration::seconds(60));
    if last.as_deref().is_none_or(|l| l < minute_ago.as_str()) {
        sqlx::query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(&stamp).bind(&id).execute(pool).await?;
    }
    Ok(Some(KeyOwner { id: owner, limited, is_admin }))
}

/// A key as the list shows it: never the key or its hash.
#[derive(Serialize, sqlx::FromRow)]
pub struct KeyInfo {
    id: String,
    name: String,
    #[sqlx(json)]
    scopes: Vec<String>,
    created_at: String,
    last_used_at: Option<String>,
    expires_at: Option<String>,
    revoked_at: Option<String>,
}

async fn list(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<KeyInfo>>> {
    Ok(Json(
        sqlx::query_as(
            "SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_tokens
             WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50",
        )
        .bind(&user.id)
        .fetch_all(&st.pool)
        .await?,
    ))
}

#[derive(Deserialize)]
struct NewKey {
    name: String,
    /// Days until it expires; 365 when missing.
    days: Option<i64>,
    /// `plan:sync` (the default), `mcp`, or an admin-only `lab:worker:<target>` scope.
    scope: Option<String>,
}

#[derive(Serialize)]
struct CreatedKey {
    id: String,
    name: String,
    /// Shown once. Yama keeps only its hash.
    token: String,
    scopes: Vec<String>,
    created_at: String,
    expires_at: String,
}

async fn create(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<NewKey>) -> AppResult<Json<CreatedKey>> {
    let name = body.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::bad("name: say where the key is used (up to 100 characters), for example \"commander-decks on the Mac\""));
    }
    let days = body.days.unwrap_or(DEFAULT_DAYS);
    if !(1..=MAX_DAYS).contains(&days) {
        return Err(AppError::bad(format!("days: a key lasts 1 to {MAX_DAYS} days")));
    }
    let stamp = now();
    let live: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM api_tokens WHERE owner_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(&user.id)
    .bind(&stamp)
    .fetch_one(&st.pool)
    .await?;
    if live >= MAX_LIVE {
        return Err(AppError::Conflict(format!("You have {MAX_LIVE} keys that still work. Revoke one you no longer use first.")));
    }
    let token = format!("{PREFIX}{}", random_token());
    let id = new_id();
    let expires_at = time(Utc::now() + Duration::days(days));
    if body.scope.as_deref().is_some_and(|s| s.starts_with("lab:worker:")) && !user.is_admin {
        return Err(AppError::Forbidden("Remote execution is an admin pilot".into()));
    }
    let scope = match body.scope.as_deref() {
        None | Some(SCOPE_SYNC) => SCOPE_SYNC,
        Some(SCOPE_MCP) => SCOPE_MCP,
        Some("lab:worker:saget") => "lab:worker:saget",
        Some("lab:worker:laptop") => "lab:worker:laptop",
        Some("lab:worker:github") => "lab:worker:github",
        Some(other) => return Err(AppError::bad(format!("unknown token scope {other:?}"))),
    };
    let scopes = vec![scope.to_string()];
    sqlx::query("INSERT INTO api_tokens (id, owner_id, name, token_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&user.id)
        .bind(&name)
        .bind(sha256_hex(&token))
        .bind(serde_json::to_string(&scopes).map_err(anyhow::Error::from)?)
        .bind(&stamp)
        .bind(&expires_at)
        .execute(&st.pool)
        .await?;
    Ok(Json(CreatedKey { id, name, token, scopes, created_at: stamp, expires_at }))
}

/// Revoke one of the caller's keys. Revoking twice keeps the first time; anyone else's id is a 404.
async fn revoke(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<KeyInfo>> {
    let done = sqlx::query("UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND owner_id = ?")
        .bind(now())
        .bind(&id)
        .bind(&user.id)
        .execute(&st.pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("key"));
    }
    Ok(Json(
        sqlx::query_as("SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_tokens WHERE id = ? AND owner_id = ?")
            .bind(&id)
            .bind(&user.id)
            .fetch_one(&st.pool)
            .await?,
    ))
}
