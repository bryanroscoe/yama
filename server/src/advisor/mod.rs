//! "Ask Claude": advice about your own decks, plans and lab runs, from Claude through the advisor
//! sidecar (`advisor/` at the repo root, `deploy/Dockerfile.advisor`).
//!
//! **Whose Claude** ([`access`], the one place that decides, in this order):
//! 1. An account listed in YAMA_ADVISOR_SUBSCRIPTION_EMAILS (Bryan's own) asks on the server's
//!    subscription token, which only the sidecar holds. Anthropic doesn't allow an app to share one
//!    person's Claude subscription with other people, so nothing else ever reaches it.
//! 2. An account with an Anthropic API key it saved itself (`keys.rs`: encrypted, never sent back)
//!    asks with that key.
//! 3. An account an admin granted the shared key (`shared.rs`) asks on the owner's pay-per-use API
//!    key, which only the sidecar holds (ANTHROPIC_SHARED_API_KEY). Never the subscription.
//! 4. Everyone else sees the advisor as unavailable, with what they could do about it.
//!
//! **What it can do.** Read: the conversation's context is rebuilt from the asker's own rows on
//! every question (`context.rs`), and Claude's only tools are Yama's own read tools for the asker
//! (`mcp/`, through a one-question token). It can't change anything; the page offers to save a
//! suggested swap as an idea through the planner's own inbox.
//!
//! **Limits.** Six questions a minute per account (`limits.rs`), one at a time, and a daily count
//! kept in `advisor_usage` (so deleting conversations doesn't reset it): 30 for accounts that joined
//! without an invite, 150 for invited ones, none for admins. On the shared key: the grant's own
//! daily cap or else 30/150 (admins included), only YAMA_ADVISOR_SHARED_MODELS, and a server-wide
//! monthly cap in USD from the cost recorded with each answer (`shared.rs`).
//!
//! **Streaming.** `POST /api/advisor/ask` answers as server-sent events (`start`, `text`…, then
//! `done` or `error`). The answer is saved when it ends, also when the browser leaves early (marked
//! stopped), and hanging up stops the request to the sidecar, which stops Claude.

pub mod context;
pub mod keys;
pub mod shared;

use crate::auth::{CurrentUser, User};
use crate::config::AdvisorConfig;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Haiku by default (Bryan, 2026-10-22: Opus kept him on "Thinking…" for most of a minute).
pub const DEFAULT_MODEL: &str = "claude-haiku-5-5";
/// (id, label, note) of every model the advisor offers.
pub const MODELS: [(&str, &str, &str); 3] = [
    ("claude-haiku-5-5", "Claude Haiku 5.5", "The quickest. The default."),
    ("claude-sonnet-5-5", "Claude Sonnet 5.5", "Slower, more thorough."),
    ("claude-opus-5-5", "Claude Opus 5.5", "The most thoughtful answers, and the slowest: often a minute."),
];
/// Questions a day for an account that joined without an invite, and for an invited account.
pub const DAILY_LIMITED: i64 = 30;
pub const DAILY_INVITED: i64 = 150;
/// A question, in characters.
pub const MAX_QUESTION: usize = 8_000;
/// Earlier messages sent with each question, newest kept, and characters kept of each.
const HISTORY: i64 = 20;
const HISTORY_CHARS: usize = 20_000;
/// How long one answer may take before the server gives up on the sidecar.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/advisor/status", get(status_route))
        .route("/api/advisor/key", put(save_key_route).delete(delete_key_route))
        .route("/api/advisor/settings", put(settings_route))
        .route("/api/advisor/conversations", get(list_route).delete(delete_all_route))
        .route("/api/advisor/conversations/{id}", get(conversation_route).delete(delete_route))
        .route("/api/advisor/ask", post(ask_route))
        .merge(shared::router())
}

// ── who may ask, and how ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// The server's Claude subscription (listed accounts only).
    Subscription,
    /// The asker's own Anthropic API key.
    OwnKey,
    /// The owner's shared API key, held by the sidecar (granted accounts only, `shared.rs`).
    Shared,
}

impl Mode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Mode::Subscription => "subscription",
            Mode::OwnKey => "own_key",
            Mode::Shared => "shared",
        }
    }
}

/// What [`access`] knows about the shared key for one account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SharedGrant {
    NotGranted,
    /// An admin granted it; `key_on_sidecar` is false only when the sidecar said it has no key.
    Granted { key_on_sidecar: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Ready(Mode),
    /// The server has no advisor set up.
    Off,
    /// The server can't store keys (no YAMA_ADVISOR_KEY_SECRET), and this account isn't listed.
    KeysOff,
    /// The account could add its own key.
    NeedsKey,
}

impl Access {
    pub(crate) fn reason(self) -> Option<&'static str> {
        match self {
            Access::Ready(_) => None,
            Access::Off => Some("off"),
            Access::KeysOff => Some("keys_off"),
            Access::NeedsKey => Some("needs_key"),
        }
    }
}

/// The one place that decides whose Claude an account uses: the subscription for an exact, listed
/// email; else the account's own saved key (only when the server can decrypt keys); else the
/// shared key, when granted and the sidecar holds one. The shared key never wins over the other
/// two, and nothing but a listed email ever gets the subscription.
pub fn access(cfg: &AdvisorConfig, user: &User, has_key: bool, shared: SharedGrant) -> Access {
    if !cfg.enabled() {
        return Access::Off;
    }
    let email = user.email.trim().to_lowercase();
    if !email.is_empty() && cfg.subscription_emails.contains(&email) {
        return Access::Ready(Mode::Subscription);
    }
    if has_key && cfg.key_secret.is_some() {
        return Access::Ready(Mode::OwnKey);
    }
    if shared == (SharedGrant::Granted { key_on_sidecar: true }) {
        return Access::Ready(Mode::Shared);
    }
    if cfg.key_secret.is_none() { Access::KeysOff } else { Access::NeedsKey }
}

/// Questions a day for the account in this mode. Admins have no cap on the subscription or their
/// own key; on the shared key everyone has one (the grant's own, else the usual).
fn daily_limit(user: &User, mode: Option<Mode>, grant: Option<&shared::Grant>) -> Option<i64> {
    if mode == Some(Mode::Shared) {
        Some(shared_daily_limit(user, grant.and_then(|g| g.daily_limit)))
    } else if user.is_admin {
        None
    } else if user.limited {
        Some(DAILY_LIMITED)
    } else {
        Some(DAILY_INVITED)
    }
}

/// The daily cap on shared questions: the grant's own, else 30 or 150 (also for an admin).
pub(crate) fn shared_daily_limit(user: &User, grant_limit: Option<i64>) -> i64 {
    grant_limit.unwrap_or(if user.limited { DAILY_LIMITED } else { DAILY_INVITED })
}

/// The models this mode may use: YAMA_ADVISOR_SHARED_MODELS on the shared key, all of them otherwise.
fn models_for(cfg: &AdvisorConfig, mode: Option<Mode>) -> Vec<&'static (&'static str, &'static str, &'static str)> {
    MODELS.iter().filter(|(id, ..)| mode != Some(Mode::Shared) || cfg.shared_models.iter().any(|m| m == id)).collect()
}

/// The names of the models shared questions may use ("Claude Haiku 5.5").
pub(crate) fn shared_model_labels(cfg: &AdvisorConfig) -> Vec<&'static str> {
    models_for(cfg, Some(Mode::Shared)).iter().map(|m| m.1).collect()
}

fn shared_models_message(cfg: &AdvisorConfig) -> String {
    format!("On the shared key, Claude answers with {} only.", shared_model_labels(cfg).join(" or "))
}

async fn used_today(pool: &SqlitePool, owner: &str) -> AppResult<i64> {
    let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM advisor_usage WHERE owner_id = ? AND created_at >= ?").bind(owner).bind(since).fetch_one(pool).await?)
}

/// The account's chosen model when this mode allows it, else the default, else the first allowed.
async fn model_for(pool: &SqlitePool, owner: &str, allowed: &[&(&str, &str, &str)]) -> AppResult<String> {
    let m: Option<String> = sqlx::query_scalar("SELECT model FROM advisor_settings WHERE user_id = ?").bind(owner).fetch_optional(pool).await?;
    let ok = |id: &str| allowed.iter().any(|(a, ..)| *a == id);
    Ok(match m {
        Some(m) if ok(&m) => m,
        _ if ok(DEFAULT_MODEL) => DEFAULT_MODEL.to_string(),
        _ => allowed.first().map_or(DEFAULT_MODEL, |m| m.0).to_string(),
    })
}

/// What [`access`] needs about one account, from the database and, only for an account with a
/// shared grant, the sidecar's health.
struct Facts {
    key_hint: Option<String>,
    grant: Option<shared::Grant>,
    access: Access,
}

impl Facts {
    fn mode(&self) -> Option<Mode> {
        match self.access {
            Access::Ready(m) => Some(m),
            _ => None,
        }
    }
}

async fn facts(st: &AppState, user: &User) -> AppResult<Facts> {
    let key_hint = keys::hint_for(&st.pool, &user.id).await?;
    let grant = shared::grant_for(&st.pool, &user.id).await?;
    let shared = match &grant {
        None => SharedGrant::NotGranted,
        // A sidecar that doesn't answer may still have the key; asking says so if it doesn't.
        Some(_) if st.cfg.advisor.enabled() => SharedGrant::Granted { key_on_sidecar: sidecar_health(st).await.is_none_or(|h| h.shared == Some(true)) },
        Some(_) => SharedGrant::Granted { key_on_sidecar: false },
    };
    let access = access(&st.cfg.advisor, user, key_hint.is_some(), shared);
    Ok(Facts { key_hint, grant, access })
}

/// Accounts with a question in flight: one at a time each.
fn in_flight() -> &'static Mutex<HashSet<String>> {
    static SET: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

struct FlightGuard(String);

impl FlightGuard {
    fn take(user_id: &str) -> AppResult<Self> {
        let mut set = in_flight().lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(user_id.to_string()) {
            return Err(AppError::TooManyRequests { message: "Claude is still answering your last question.".into(), retry_after: 5 });
        }
        Ok(Self(user_id.to_string()))
    }
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        in_flight().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

// ── status, key, settings ───────────────────────────────────────────────────

#[derive(Serialize)]
struct ModelInfo {
    id: &'static str,
    label: &'static str,
    note: &'static str,
}

#[derive(Serialize)]
pub struct Status {
    available: bool,
    mode: Option<Mode>,
    /// Why it isn't available: off | keys_off | needs_key.
    reason: Option<&'static str>,
    has_key: bool,
    /// The last four characters of the saved key.
    key_hint: Option<String>,
    /// Whether this server can store a key at all.
    can_save_key: bool,
    model: String,
    models: Vec<ModelInfo>,
    per_day: Option<i64>,
    used_today: i64,
    /// For subscription accounts: whether the sidecar holds the subscription token (null when the
    /// sidecar didn't answer).
    subscription_connected: Option<bool>,
    /// An admin granted this account the shared key (it's used only when the subscription and the
    /// account's own key don't apply).
    shared_granted: bool,
    /// Whose shared key it is ("Bryan"), when granted.
    shared_owner: Option<String>,
    /// Shared mode only: when the month's cap is reached, the time questions start again (UTC).
    shared_paused_until: Option<String>,
}

/// What the sidecar's `/health` says it holds. A field is `None` when it didn't say.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SidecarHealth {
    /// The subscription token.
    pub subscription: Option<bool>,
    /// The shared API key (never the key, only whether it's there).
    pub shared: Option<bool>,
}

/// The sidecar's health: `None` when it didn't answer (2 s at most).
pub(crate) async fn sidecar_health(st: &AppState) -> Option<SidecarHealth> {
    let (url, secret) = (st.cfg.advisor.url.as_ref()?, st.cfg.advisor.secret.as_ref()?);
    let res = st.http.get(format!("{url}/health")).header("x-advisor-secret", secret).timeout(Duration::from_secs(2)).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let v = res.json::<Value>().await.unwrap_or_default();
    Some(SidecarHealth { subscription: v["subscription"].as_bool(), shared: v["shared"].as_bool() })
}

async fn status_for(st: &AppState, user: &User) -> AppResult<Status> {
    let f = facts(st, user).await?;
    let mode = f.mode();
    let cfg = &st.cfg.advisor;
    let allowed = models_for(cfg, mode);
    let shared_paused_until = match mode {
        Some(Mode::Shared) => shared::paused_until(&st.pool, cfg).await?.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        _ => None,
    };
    Ok(Status {
        available: mode.is_some(),
        mode,
        reason: f.access.reason(),
        has_key: f.key_hint.is_some(),
        key_hint: f.key_hint.clone(),
        can_save_key: cfg.enabled() && cfg.key_secret.is_some(),
        model: model_for(&st.pool, &user.id, &allowed).await?,
        models: allowed.iter().map(|(id, label, note)| ModelInfo { id, label, note }).collect(),
        per_day: daily_limit(user, mode, f.grant.as_ref()),
        used_today: used_today(&st.pool, &user.id).await?,
        subscription_connected: if mode == Some(Mode::Subscription) { sidecar_health(st).await.and_then(|h| h.subscription) } else { None },
        shared_granted: f.grant.is_some(),
        shared_owner: f.grant.as_ref().map(|g| shared::owner_name(cfg, Some(g))),
        shared_paused_until,
    })
}

async fn status_route(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Status>> {
    Ok(Json(status_for(&st, &user).await?))
}

#[derive(Deserialize)]
struct KeyBody {
    api_key: String,
}

async fn save_key_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<KeyBody>) -> AppResult<Json<Status>> {
    let secret = match (&st.cfg.advisor.key_secret, st.cfg.advisor.enabled()) {
        (Some(s), true) => s.clone(),
        _ => return Err(AppError::Conflict("This server can't store API keys.".into())),
    };
    st.limits.imports.check_user(&user)?;
    let key = body.api_key.trim();
    if !keys::looks_like_api_key(key) {
        return Err(AppError::bad("That doesn't look like an Anthropic API key. Keys start with sk-ant- (make one at console.anthropic.com)."));
    }
    keys::save(&st.pool, &secret, &user.id, key).await?;
    Ok(Json(status_for(&st, &user).await?))
}

async fn delete_key_route(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Status>> {
    keys::remove(&st.pool, &user.id).await?;
    Ok(Json(status_for(&st, &user).await?))
}

#[derive(Deserialize)]
struct SettingsBody {
    model: String,
}

async fn settings_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<SettingsBody>) -> AppResult<Json<Status>> {
    if !MODELS.iter().any(|(id, ..)| *id == body.model) {
        return Err(AppError::bad(format!("model must be one of {}", MODELS.iter().map(|m| m.0).collect::<Vec<_>>().join(", "))));
    }
    let mode = facts(&st, &user).await?.mode();
    if mode == Some(Mode::Shared) && !models_for(&st.cfg.advisor, mode).iter().any(|(id, ..)| *id == body.model) {
        return Err(AppError::bad(shared_models_message(&st.cfg.advisor)));
    }
    sqlx::query(
        "INSERT INTO advisor_settings (user_id, model, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at",
    )
    .bind(&user.id)
    .bind(&body.model)
    .bind(now())
    .execute(&st.pool)
    .await?;
    Ok(Json(status_for(&st, &user).await?))
}

// ── conversations ───────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
struct ConversationItem {
    id: String,
    title: String,
    context_kind: String,
    context_ref: Option<String>,
    created_at: String,
    updated_at: String,
    messages: i64,
}

#[derive(Deserialize)]
struct ListQuery {
    kind: Option<String>,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

async fn list_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(q): Query<ListQuery>) -> AppResult<Json<Vec<ConversationItem>>> {
    Ok(Json(
        sqlx::query_as(
            "SELECT c.id, c.title, c.context_kind, c.context_ref, c.created_at, c.updated_at,
               (SELECT COUNT(*) FROM advisor_messages m WHERE m.conversation_id = c.id) AS messages
             FROM advisor_conversations c
             WHERE c.owner_id = ?1 AND (?2 IS NULL OR c.context_kind = ?2) AND (?3 IS NULL OR c.context_ref = ?3)
             ORDER BY c.updated_at DESC, c.rowid DESC LIMIT 100",
        )
        .bind(&user.id)
        .bind(q.kind.as_deref())
        .bind(q.reference.as_deref())
        .fetch_all(&st.pool)
        .await?,
    ))
}

#[derive(Serialize, sqlx::FromRow)]
struct MessageItem {
    id: String,
    role: String,
    content: String,
    model: Option<String>,
    mode: Option<String>,
    status: String,
    error: Option<String>,
    #[sqlx(json(nullable))]
    usage: Option<Value>,
    created_at: String,
}

#[derive(Serialize)]
struct ConversationDetail {
    #[serde(flatten)]
    conversation: ConversationItem,
    items: Vec<MessageItem>,
}

async fn owned_conversation(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<ConversationItem> {
    sqlx::query_as(
        "SELECT c.id, c.title, c.context_kind, c.context_ref, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM advisor_messages m WHERE m.conversation_id = c.id) AS messages
         FROM advisor_conversations c WHERE c.id = ? AND c.owner_id = ?",
    )
    .bind(id)
    .bind(owner)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound("conversation"))
}

async fn conversation_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<ConversationDetail>> {
    let conversation = owned_conversation(&st.pool, &user.id, &id).await?;
    let items = sqlx::query_as(
        "SELECT id, role, content, model, mode, status, error, usage, created_at FROM advisor_messages
         WHERE conversation_id = ? AND owner_id = ? ORDER BY created_at, rowid",
    )
    .bind(&id)
    .bind(&user.id)
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(ConversationDetail { conversation, items }))
}

async fn delete_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    let done = sqlx::query("DELETE FROM advisor_conversations WHERE id = ? AND owner_id = ?").bind(&id).bind(&user.id).execute(&st.pool).await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("conversation"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_all_route(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM advisor_conversations WHERE owner_id = ?").bind(&user.id).execute(&st.pool).await?;
    Ok(StatusCode::NO_CONTENT)
}

// ── asking ──────────────────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
struct ContextRef {
    kind: String,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

#[derive(Deserialize)]
struct AskBody {
    conversation_id: Option<String>,
    context: Option<ContextRef>,
    question: String,
    model: Option<String>,
}

fn sse(event: &str, data: &Value) -> Bytes {
    Bytes::from(format!("event: {event}\ndata: {data}\n\n"))
}

fn title_from(question: &str) -> String {
    let line = question.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Question");
    let mut t: String = line.chars().take(80).collect();
    if line.chars().count() > 80 {
        t.push('…');
    }
    t
}

/// Earlier messages to send with a question: the newest done (or stopped, with text) ones.
async fn history(pool: &SqlitePool, owner: &str, conversation: &str) -> AppResult<Vec<Value>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT role, content FROM (
           SELECT role, content, created_at, rowid FROM advisor_messages
           WHERE conversation_id = ? AND owner_id = ? AND content != '' AND (role = 'user' OR status IN ('done', 'stopped'))
           ORDER BY created_at DESC, rowid DESC LIMIT ?)
         ORDER BY created_at, rowid",
    )
    .bind(conversation)
    .bind(owner)
    .bind(HISTORY)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(role, content)| {
            let content: String = content.chars().take(HISTORY_CHARS).collect();
            json!({"role": role, "content": content})
        })
        .collect())
}

async fn ask_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<AskBody>) -> AppResult<Response> {
    let question = body.question.trim().to_string();
    if question.is_empty() {
        return Err(AppError::bad("Ask a question first."));
    }
    if question.chars().count() > MAX_QUESTION {
        return Err(AppError::bad(format!("Keep a question under {MAX_QUESTION} characters.")));
    }
    let f = facts(&st, &user).await?;
    let mode = match f.access {
        Access::Ready(m) => m,
        Access::Off => return Err(AppError::Unavailable("Ask Claude isn't set up on this server.".into())),
        Access::KeysOff => return Err(AppError::Forbidden("Ask Claude is only available to the server's owner here.".into())),
        Access::NeedsKey => return Err(AppError::Forbidden("Add your own Anthropic API key in Settings to ask Claude.".into())),
    };
    let allowed = models_for(&st.cfg.advisor, Some(mode));
    let model = match body.model {
        Some(m) if allowed.iter().any(|(id, ..)| *id == m) => m,
        Some(m) if mode == Mode::Shared && MODELS.iter().any(|(id, ..)| *id == m) => return Err(AppError::bad(shared_models_message(&st.cfg.advisor))),
        Some(m) => return Err(AppError::bad(format!("\"{m}\" isn't a model the advisor offers."))),
        None => model_for(&st.pool, &user.id, &allowed).await?,
    };

    // The conversation and its context: an existing one is the caller's, or a 404.
    let (conversation_id, ctx, is_new) = match &body.conversation_id {
        Some(id) => {
            let c = owned_conversation(&st.pool, &user.id, id).await?;
            (c.id, ContextRef { kind: c.context_kind, reference: c.context_ref }, false)
        }
        None => {
            let ctx = body.context.clone().unwrap_or(ContextRef { kind: "general".into(), reference: None });
            if !context::KINDS.contains(&ctx.kind.as_str()) {
                return Err(AppError::bad(format!("context kind \"{}\" isn't one of {}", ctx.kind, context::KINDS.join(", "))));
            }
            if ctx.reference.as_deref().is_some_and(|r| r.len() > 300) {
                return Err(AppError::bad("context ref is too long"));
            }
            (new_id(), ctx, true)
        }
    };
    let data = context::build(&st.pool, &user, &ctx.kind, ctx.reference.as_deref()).await?;

    st.limits.advisor.check_user(&user)?;
    if let Some(limit) = daily_limit(&user, Some(mode), f.grant.as_ref())
        && used_today(&st.pool, &user.id).await? >= limit
    {
        return Err(AppError::TooManyRequests { message: format!("That's {limit} questions in the last 24 hours, this account's daily allowance. Try again later."), retry_after: 3600 });
    }
    if mode == Mode::Shared
        && let Some(until) = shared::paused_until(&st.pool, &st.cfg.advisor).await?
    {
        return Err(shared::paused_error(&shared::owner_name(&st.cfg.advisor, f.grant.as_ref()), until));
    }
    let guard = FlightGuard::take(&user.id)?;

    // Only own-key questions carry a key: the subscription token and the shared key stay in the
    // sidecar, which picks the credential from `mode` alone.
    let api_key = match mode {
        Mode::Subscription | Mode::Shared => None,
        Mode::OwnKey => {
            let secret = st.cfg.advisor.key_secret.clone().ok_or_else(|| AppError::Forbidden("This server can't use saved keys.".into()))?;
            Some(keys::load(&st.pool, &secret, &user.id).await?.ok_or_else(|| AppError::Forbidden("Add your own Anthropic API key in Settings to ask Claude.".into()))?)
        }
    };
    let mut messages = if is_new { Vec::new() } else { history(&st.pool, &user.id, &conversation_id).await? };
    messages.push(json!({"role": "user", "content": question}));
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    // Claude may call Yama's tools as this account until the answer ends (`mcp/`).
    let tools = st.cfg.advisor.tools_url.clone().map(|url| (url, crate::mcp::QuestionToken::mint(&user.id)));
    let request = json!({
        "mode": match mode {
            Mode::Subscription => "subscription",
            Mode::OwnKey => "api_key",
            Mode::Shared => "shared",
        },
        "api_key": api_key,
        "model": model,
        "system": context::system_prompt(&user, &data, &today, tools.is_some()),
        "messages": messages,
        "tools": tools.as_ref().map(|(url, t)| json!({"url": url, "token": t.token})),
    });

    // Ask the sidecar before saving anything, so a refused or unreachable sidecar leaves no trace.
    let (url, secret) = match (&st.cfg.advisor.url, &st.cfg.advisor.secret) {
        (Some(u), Some(s)) => (u.clone(), s.clone()),
        _ => return Err(AppError::Unavailable("Ask Claude isn't set up on this server.".into())),
    };
    let resp = st
        .http
        .post(format!("{url}/advise"))
        .header("x-advisor-secret", secret)
        .json(&request)
        .timeout(ANSWER_TIMEOUT)
        .send()
        .await
        .map_err(|_| AppError::Unavailable("The advisor isn't answering right now. Try again in a minute.".into()))?;
    drop(request);
    if !resp.status().is_success() {
        let code = resp.status();
        let message = resp.json::<Value>().await.ok().and_then(|v| v["error"].as_str().map(str::to_string)).unwrap_or_default();
        tracing::warn!(status = %code, "advisor sidecar refused a request");
        return Err(match code.as_u16() {
            503 => AppError::Unavailable(if message.is_empty() { "The advisor is busy. Try again in a moment.".into() } else { message }),
            _ => AppError::Unavailable("The advisor couldn't take that question.".into()),
        });
    }

    let at = now();
    let user_message_id = new_id();
    let mut tx = st.pool.begin().await?;
    if is_new {
        sqlx::query(
            "INSERT INTO advisor_conversations (id, owner_id, title, context_kind, context_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&conversation_id)
        .bind(&user.id)
        .bind(title_from(&question))
        .bind(&ctx.kind)
        .bind(&ctx.reference)
        .bind(&at)
        .bind(&at)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("INSERT INTO advisor_messages (id, conversation_id, owner_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)")
        .bind(&user_message_id)
        .bind(&conversation_id)
        .bind(&user.id)
        .bind(&question)
        .bind(&at)
        .execute(&mut *tx)
        .await?;
    let usage_id = new_id();
    sqlx::query("INSERT INTO advisor_usage (id, owner_id, mode, model, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&usage_id)
        .bind(&user.id)
        .bind(mode.as_str())
        .bind(&model)
        .bind(&at)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let (send, recv) = tokio::sync::mpsc::channel::<Bytes>(64);
    let pool = st.pool.clone();
    let owner = user.id.clone();
    tokio::spawn(async move {
        let _guard = guard;
        // The tools stop working for this answer when it ends.
        let _tools = tools;
        let _ = send.send(sse("start", &json!({"conversation_id": conversation_id, "user_message_id": user_message_id, "model": model, "mode": mode}))).await;
        let mut text = String::new();
        let mut status = "error";
        let mut error: Option<String> = None;
        let mut usage: Option<Value> = None;
        // What the answer cost, when the sidecar says (API-key and shared modes).
        let mut cost: Option<f64> = None;
        let mut buf: Vec<u8> = Vec::new();
        let mut stream = resp.bytes_stream();
        let mut gone = false;
        'read: while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(b) => buf.extend_from_slice(&b),
                Err(_) => {
                    error = Some("The connection to the advisor dropped.".into());
                    break;
                }
            }
            while let Some(pos) = buf.iter().position(|&c| c == b'\n') {
                let line: Vec<u8> = buf.drain(..=pos).collect();
                let Ok(ev) = serde_json::from_slice::<Value>(&line[..line.len() - 1]) else { continue };
                match ev["type"].as_str() {
                    Some("text") => {
                        let t = ev["text"].as_str().unwrap_or_default();
                        text.push_str(t);
                        if send.send(sse("text", &json!({"text": t}))).await.is_err() {
                            gone = true;
                            break 'read;
                        }
                    }
                    Some("tool") => {
                        // Which tool Claude is using, for the panel's "Looking up cards…".
                        let name = ev["name"].as_str().unwrap_or_default();
                        if send.send(sse("tool", &json!({"name": name}))).await.is_err() {
                            gone = true;
                            break 'read;
                        }
                    }
                    Some("done") => {
                        status = "done";
                        let mut u = ev["usage"].clone();
                        cost = ev["cost_usd"].as_f64().filter(|c| c.is_finite() && *c >= 0.0);
                        if let (Some(obj), Some(c)) = (u.as_object_mut(), cost) {
                            obj.insert("cost_usd".into(), json!(c));
                        }
                        usage = Some(u);
                    }
                    Some("error") => {
                        status = "error";
                        error = ev["message"].as_str().map(str::to_string);
                        // A failed answer can still have cost something.
                        cost = ev["cost_usd"].as_f64().filter(|c| c.is_finite() && *c >= 0.0);
                    }
                    _ => {}
                }
            }
        }
        // Dropping the stream hangs up on the sidecar, which stops Claude.
        drop(stream);
        if gone && status != "done" {
            status = "stopped";
        } else if status == "error" && error.is_none() {
            error = Some("Claude stopped without finishing the answer.".into());
        }
        let message_id = new_id();
        let at = now();
        let saved = sqlx::query(
            "INSERT INTO advisor_messages (id, conversation_id, owner_id, role, content, model, mode, status, error, usage, created_at)
             VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&message_id)
        .bind(&conversation_id)
        .bind(&owner)
        .bind(&text)
        .bind(&model)
        .bind(mode.as_str())
        .bind(status)
        .bind(&error)
        .bind(usage.as_ref().map(Value::to_string))
        .bind(&at)
        .execute(&pool)
        .await;
        if let Err(e) = &saved {
            // The conversation may have been deleted while Claude answered.
            tracing::debug!(error = %e, "advisor answer not saved");
        }
        let _ = sqlx::query("UPDATE advisor_conversations SET updated_at = ? WHERE id = ? AND owner_id = ?").bind(&at).bind(&conversation_id).bind(&owner).execute(&pool).await;
        // The cost stays with the usage row, which outlives the conversation (the shared key's
        // monthly cap and each account's spend are summed from it).
        if let Some(c) = cost
            && let Err(e) = sqlx::query("UPDATE advisor_usage SET cost_usd = ? WHERE id = ?").bind(c).bind(&usage_id).execute(&pool).await
        {
            tracing::warn!(error = %e, "advisor answer's cost not recorded");
        }
        let end = if status == "done" { "done" } else { "error" };
        let _ = send.send(sse(end, &json!({"message_id": message_id, "status": status, "error": error, "usage": usage}))).await;
    });

    let body = Body::from_stream(futures_util::stream::unfold(recv, |mut r| async move { r.recv().await.map(|b| (Ok::<_, std::convert::Infallible>(b), r)) }));
    Ok((
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache, no-store"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        body,
    )
        .into_response())
}

#[cfg(test)]
mod tests;
