//! OAuth sign-in for Yama's tools (docs/mcp-design.md, slice 3), so Claude Code and claude.ai's
//! custom connectors reach `POST /mcp` without a pasted script key.
//!
//! **Flow.** The client finds us from `/mcp`'s 401 (`WWW-Authenticate: Bearer resource_metadata=…`),
//! reads the protected resource metadata (RFC 9728) and the authorization server metadata
//! (RFC 8414), registers itself (RFC 7591, `POST /oauth/register`) and sends the person to
//! `/oauth/authorize`. That page is the web app's (`web/src/oauth/`): after the usual sign-in it
//! asks `GET /api/oauth/authorize` whether the request is good, shows the app, where it sends
//! the person back and which account it will connect, and posts Allow or Deny to
//! `POST /api/oauth/authorize`, which answers with the URL to go back to (`code`, `state` and
//! `iss`, RFC 9207). The client trades the code for tokens at `POST /oauth/token` with its PKCE
//! verifier, and refreshes there. `POST /oauth/revoke` (RFC 7009) ends a connection.
//!
//! **What is checked.**
//! - Redirect URIs are loopback or https on an allowlisted host, at registration and again at
//!   every authorization request (`redirect.rs`). A bad client or redirect URI is an error page,
//!   never a redirect.
//! - PKCE with S256 is required (plain and missing are refused). Codes are random, stored hashed,
//!   single use, two minutes, bound to the client, the exact redirect URI, the challenge, the
//!   account, the scope and the resource. Using a code twice revokes the grant it made.
//! - Access tokens (`yama_oat_`, an hour) and refresh tokens (`yama_ort_`, 30 days) are random and
//!   stored hashed. Refresh tokens rotate; presenting a used one revokes the whole grant, except
//!   within ten seconds of its first use, so two refreshes racing each other (Claude refreshes on
//!   any 401) don't cut the connection.
//! - `resource` (RFC 8707), when sent, must be this server's `/mcp`, compared in canonical form.
//! - Approving needs the person's own session, from our own page (`Origin` is checked; the cookie
//!   is SameSite=Lax) and never while an admin views as them (`view_as.rs` refuses the POST
//!   anyway). Accounts that may not use Yama can't approve, and their tokens stop working.
//! - Access tokens work only on `/mcp` (`mcp::caller`). `CurrentUser` refuses them outright, so
//!   every other route answers 401.
//!
//! **Where the addresses come from.** YAMA_PUBLIC_URL, never a request's Host header. Without it
//! every route here is a 404, `/mcp`'s 401 carries a bare `Bearer`, and OAuth tokens are refused.
//!
//! **Housekeeping.** Registration is rate-limited per address and capped; clients nobody finished
//! a sign-in with are swept after a day, and expired codes, tokens and revoked grants soon after.
//! Logs carry ids and outcomes, never a token, code, verifier or secret.

mod redirect;
#[cfg(test)]
mod tests;

use crate::auth::{CurrentUser, User, may_use_yama, user_by_id};
use crate::error::{AppError, AppResult};
use crate::limits::{ClientAddress, address_key};
use crate::routes::AppState;
use crate::util::{new_id, now, random_token, sha256_hex};
use crate::view_as::{MaybeView, ViewAs};
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Sqlite, SqlitePool, Transaction};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};

pub const PREFIX_ACCESS: &str = "yama_oat_";
pub const PREFIX_REFRESH: &str = "yama_ort_";
const PREFIX_SECRET: &str = "yama_ocs_";
/// Everything the tools do, as the account (what an `mcp` script key allows): read, stage
/// changes and apply them after the person's yes. Every connection made before 2026-11-11 has
/// this scope and keeps it.
pub const SCOPE_MCP: &str = "mcp";
/// The narrower scopes a person may choose on the consent page. Each includes the one before.
pub const SCOPE_READ: &str = "mcp:read";
pub const SCOPE_STAGE: &str = "mcp:stage";
pub const SCOPE_APPLY: &str = "mcp:apply";

/// What a connection may do with the tools. Each level includes the ones before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Access {
    /// Read the account's data and search.
    Read,
    /// Also stage changes for review and save research notes. Nothing staged is applied.
    Stage,
    /// Also apply or discard a staged change, after the person's yes.
    Apply,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::Read => "read",
            Access::Stage => "stage",
            Access::Apply => "apply",
        }
    }

    pub fn from_word(word: &str) -> Option<Self> {
        [Access::Read, Access::Stage, Access::Apply].into_iter().find(|a| a.as_str() == word)
    }

    /// The most a scope string allows; none when it names no tool scope at all.
    pub fn of(scope: &str) -> Option<Self> {
        scope
            .split_whitespace()
            .filter_map(|word| match word {
                SCOPE_MCP | SCOPE_APPLY => Some(Access::Apply),
                SCOPE_STAGE => Some(Access::Stage),
                SCOPE_READ => Some(Access::Read),
                _ => None,
            })
            .max()
    }

    /// The scope a grant of this level carries. Everything is `mcp`, as it always was.
    fn scope(self) -> &'static str {
        match self {
            Access::Read => SCOPE_READ,
            Access::Stage => SCOPE_STAGE,
            Access::Apply => SCOPE_MCP,
        }
    }
}

/// The scope string for a level, with `offline_access` when the request had it.
fn scope_for(access: Access, requested: &str) -> String {
    if requested.split_whitespace().any(|w| w == SCOPE_OFFLINE) { format!("{} {SCOPE_OFFLINE}", access.scope()) } else { access.scope().to_string() }
}
/// Advertised so clients ask for a refresh token (Claude Code and claude.ai add it when listed).
/// Refresh tokens are issued either way.
const SCOPE_OFFLINE: &str = "offline_access";
const CODE_SECONDS: i64 = 120;
const ACCESS_SECONDS: i64 = 3600;
const REFRESH_DAYS: i64 = 30;
/// How long after its first use a refresh token still works, for two refreshes that race.
const REFRESH_GRACE_SECONDS: i64 = 10;
/// Registered clients nobody has finished a sign-in with yet, and all clients, at most.
const MAX_WAITING_CLIENTS: i64 = 500;
const MAX_CLIENTS: i64 = 5_000;
/// Connected apps one account may have at once.
const MAX_LIVE_GRANTS: i64 = 20;
const MAX_CLIENT_NAME: usize = 80;
const MAX_REDIRECT_URIS: usize = 10;
const MAX_STATE: usize = 1024;
/// Largest registration, token or revocation request read.
const MAX_BODY: usize = 16 * 1024;
const AUTH_METHODS: [&str; 3] = ["none", "client_secret_basic", "client_secret_post"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/.well-known/oauth-protected-resource", get(resource_metadata))
        .route("/.well-known/oauth-protected-resource/mcp", get(resource_metadata))
        .route("/.well-known/oauth-authorization-server", get(server_metadata))
        .route("/oauth/register", post(register_route))
        .route("/oauth/token", post(token_route))
        .route("/oauth/revoke", post(revoke_route))
        .route("/api/oauth/authorize", get(check_route).post(decide_route))
        .route("/api/me/connected-apps", get(list_apps))
        .route("/api/me/connected-apps/{id}", delete(disconnect))
}

/// A bearer token this module issued. `CurrentUser` refuses these: they're for `/mcp` only.
pub fn is_oauth_token(token: &str) -> bool {
    token.starts_with(PREFIX_ACCESS) || token.starts_with(PREFIX_REFRESH)
}

/// Yama's OAuth addresses, all from YAMA_PUBLIC_URL.
struct Urls {
    base: String,
}

impl Urls {
    fn issuer(&self) -> &str {
        &self.base
    }
    fn resource(&self) -> String {
        format!("{}/mcp", self.base)
    }
    fn resource_metadata(&self) -> String {
        format!("{}/.well-known/oauth-protected-resource/mcp", self.base)
    }
}

fn urls(st: &AppState) -> Option<Urls> {
    st.cfg.public_url.as_ref().map(|b| Urls { base: b.clone() })
}

fn stamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn not_found() -> Response {
    AppError::NotFound("route").into_response()
}

/// Equal strings, compared in constant time (hashes of secrets).
fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `/mcp`'s 401 challenge: where the metadata is and which scope to ask for (RFC 9728 5.1).
/// `presented` says a token came and wasn't good (RFC 6750 3.1).
pub fn challenge(st: &AppState, presented: bool) -> HeaderValue {
    let Some(u) = urls(st) else { return HeaderValue::from_static("Bearer") };
    let error = if presented { r#"error="invalid_token", "# } else { "" };
    HeaderValue::from_str(&format!(r#"Bearer {error}resource_metadata="{}", scope="{SCOPE_MCP}""#, u.resource_metadata()))
        .unwrap_or_else(|_| HeaderValue::from_static("Bearer"))
}

// ── errors in OAuth's own shape (RFC 6749 5.2, RFC 7591 3.2.2) ─────────────

#[derive(Debug)]
struct OAuthError {
    status: StatusCode,
    error: &'static str,
    description: String,
    /// The client authenticated with HTTP Basic, so a 401 says how (RFC 6749 5.2).
    basic: bool,
    retry_after: Option<u64>,
}

impl OAuthError {
    fn new(status: StatusCode, error: &'static str, description: impl Into<String>) -> Self {
        Self { status, error, description: description.into(), basic: false, retry_after: None }
    }
    fn bad(error: &'static str, description: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, error, description)
    }
    fn grant(description: impl Into<String>) -> Self {
        Self::bad("invalid_grant", description)
    }
    fn client(basic: bool) -> Self {
        Self { basic, ..Self::new(StatusCode::UNAUTHORIZED, "invalid_client", "Yama doesn't know this app or its secret is wrong. Register again.") }
    }
}

impl From<AppError> for OAuthError {
    fn from(e: AppError) -> Self {
        match e {
            AppError::TooManyRequests { message, retry_after } => {
                Self { retry_after: Some(retry_after), ..Self::new(StatusCode::TOO_MANY_REQUESTS, "too_many_requests", message) }
            }
            AppError::Db(_) | AppError::Other(_) => {
                tracing::error!(error = ?e, "oauth request failed");
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, "server_error", "Yama couldn't finish that. Try again.")
            }
            other => Self::bad("invalid_request", other.to_string()),
        }
    }
}

impl From<sqlx::Error> for OAuthError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Db(e).into()
    }
}

/// Token responses and errors are never cached (RFC 6749 5.1).
fn no_store(res: &mut Response) {
    res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res.headers_mut().insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
}

impl IntoResponse for OAuthError {
    fn into_response(self) -> Response {
        let mut res = (self.status, Json(json!({"error": self.error, "error_description": self.description}))).into_response();
        no_store(&mut res);
        if self.status == StatusCode::UNAUTHORIZED && self.basic {
            res.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static(r#"Basic realm="yama""#));
        }
        if let Some(s) = self.retry_after {
            res.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(s));
        }
        res
    }
}

fn answer(out: Result<Value, OAuthError>, status: StatusCode) -> Response {
    match out {
        Ok(v) => {
            let mut res = (status, Json(v)).into_response();
            no_store(&mut res);
            res
        }
        Err(e) => e.into_response(),
    }
}

/// A form body (RFC 6749 3.2) or a query string as a map. A parameter given twice is refused
/// (RFC 6749 3.1).
fn parse_pairs(raw: &[u8]) -> Result<HashMap<String, String>, OAuthError> {
    if raw.len() > MAX_BODY {
        return Err(OAuthError::bad("invalid_request", "the request is too large"));
    }
    let mut map = HashMap::new();
    for (k, v) in url::form_urlencoded::parse(raw) {
        if map.insert(k.to_string(), v.to_string()).is_some() {
            return Err(OAuthError::bad("invalid_request", format!("{k} appears more than once")));
        }
    }
    Ok(map)
}

fn required<'a>(form: &'a HashMap<String, String>, key: &str) -> Result<&'a str, OAuthError> {
    form.get(key).map(String::as_str).filter(|v| !v.is_empty()).ok_or_else(|| OAuthError::bad("invalid_request", format!("{key} is missing")))
}

fn check_resource(urls: &Urls, raw: &str) -> Result<(), OAuthError> {
    if redirect::canonical_resource(raw).as_deref() == Some(urls.resource().as_str()) {
        Ok(())
    } else {
        Err(OAuthError::bad("invalid_target", format!("Yama's tokens are for {}", urls.resource())))
    }
}

/// The scope a request asks for, in its canonical form: the most its tool scopes allow (`mcp`,
/// everything, when it names none, as before the narrower scopes existed), plus `offline_access`
/// when asked. `Err` names a scope Yama doesn't have.
fn parse_scope(raw: Option<&str>) -> Result<String, String> {
    let raw = raw.unwrap_or_default();
    if let Some(other) = raw.split_whitespace().find(|w| ![SCOPE_MCP, SCOPE_READ, SCOPE_STAGE, SCOPE_APPLY, SCOPE_OFFLINE].contains(w)) {
        return Err(other.chars().take(60).collect());
    }
    Ok(scope_for(Access::of(raw).unwrap_or(Access::Apply), raw))
}

/// A PKCE challenge or verifier: 43 to 128 unreserved characters (RFC 7636 4.1).
fn pkce_shaped(s: &str) -> bool {
    (43..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
}

fn pkce_ok(verifier: &str, challenge: &str) -> bool {
    pkce_shaped(verifier) && ct_eq(&URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())), challenge)
}

/// An app's name as it claims it: control, bidirectional and zero-width characters removed,
/// spaces collapsed, at most 80 characters. Shown only as text.
fn clean_name(raw: &str) -> Option<String> {
    let hidden = |c: char| c.is_control() || matches!(c, '\u{061C}' | '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2069}' | '\u{FEFF}');
    let kept: String = raw.chars().filter(|c| !hidden(*c)).collect();
    let name: String = kept.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_CLIENT_NAME).collect();
    (!name.is_empty()).then_some(name)
}

// ── metadata ────────────────────────────────────────────────────────────────

async fn resource_metadata(State(st): State<AppState>) -> Response {
    let Some(u) = urls(&st) else { return not_found() };
    Json(json!({
        "resource": u.resource(),
        "authorization_servers": [u.issuer()],
        "scopes_supported": [SCOPE_MCP, SCOPE_READ, SCOPE_STAGE, SCOPE_APPLY],
        "bearer_methods_supported": ["header"],
        "resource_name": "Yama",
        "resource_documentation": format!("{}/about/", u.base),
    }))
    .into_response()
}

async fn server_metadata(State(st): State<AppState>) -> Response {
    let Some(u) = urls(&st) else { return not_found() };
    Json(json!({
        "issuer": u.issuer(),
        "authorization_endpoint": format!("{}/oauth/authorize", u.base),
        "token_endpoint": format!("{}/oauth/token", u.base),
        "registration_endpoint": format!("{}/oauth/register", u.base),
        "revocation_endpoint": format!("{}/oauth/revoke", u.base),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": AUTH_METHODS,
        "revocation_endpoint_auth_methods_supported": AUTH_METHODS,
        "scopes_supported": [SCOPE_MCP, SCOPE_READ, SCOPE_STAGE, SCOPE_APPLY, SCOPE_OFFLINE],
        "authorization_response_iss_parameter_supported": true,
    }))
    .into_response()
}

// ── clients (RFC 7591) ──────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct ClientRow {
    id: String,
    name: Option<String>,
    redirect_uris: String,
    secret_hash: Option<String>,
}

struct Client {
    id: String,
    name: Option<String>,
    redirect_uris: Vec<String>,
    secret_hash: Option<String>,
}

async fn load_client(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<Client>> {
    let row: Option<ClientRow> =
        sqlx::query_as("SELECT id, name, redirect_uris, secret_hash FROM oauth_clients WHERE id = ?").bind(id).fetch_optional(pool).await?;
    Ok(row.map(|r| Client {
        id: r.id,
        name: r.name,
        redirect_uris: serde_json::from_str(&r.redirect_uris).unwrap_or_default(),
        secret_hash: r.secret_hash,
    }))
}

async fn register_route(State(st): State<AppState>, ClientAddress(address): ClientAddress, body: Bytes) -> Response {
    if urls(&st).is_none() {
        return not_found();
    }
    let out = async {
        st.limits.oauth_register.check(&address_key(address))?;
        register(&st, &body).await
    }
    .await;
    answer(out, StatusCode::CREATED)
}

fn string_list(v: &Value, field: &str) -> Result<Vec<String>, OAuthError> {
    v.as_array()
        .and_then(|a| a.iter().map(|x| x.as_str().map(str::to_string)).collect::<Option<Vec<_>>>())
        .ok_or_else(|| OAuthError::bad("invalid_client_metadata", format!("{field} must be a list of strings")))
}

async fn register(st: &AppState, body: &[u8]) -> Result<Value, OAuthError> {
    if body.len() > MAX_BODY {
        return Err(OAuthError::bad("invalid_client_metadata", "the registration is too large"));
    }
    let meta: Value = serde_json::from_slice(body).map_err(|_| OAuthError::bad("invalid_client_metadata", "send the registration as JSON"))?;
    if !meta.is_object() {
        return Err(OAuthError::bad("invalid_client_metadata", "send the registration as a JSON object"));
    }
    let uris = match meta.get("redirect_uris") {
        Some(v) => string_list(v, "redirect_uris")?,
        None => Vec::new(),
    };
    if uris.is_empty() || uris.len() > MAX_REDIRECT_URIS {
        return Err(OAuthError::bad("invalid_redirect_uri", format!("send 1 to {MAX_REDIRECT_URIS} redirect_uris")));
    }
    for uri in &uris {
        redirect::check_registration(uri, &st.cfg.oauth_redirect_hosts).map_err(|why| OAuthError::bad("invalid_redirect_uri", why))?;
    }
    // RFC 7591's default is client_secret_basic. Claude's clients register as public ("none").
    let method = match meta.get("token_endpoint_auth_method") {
        None | Some(Value::Null) => "client_secret_basic",
        Some(Value::String(m)) => AUTH_METHODS
            .iter()
            .copied()
            .find(|a| a == m)
            .ok_or_else(|| OAuthError::bad("invalid_client_metadata", format!("token_endpoint_auth_method must be one of {}", AUTH_METHODS.join(", "))))?,
        Some(_) => return Err(OAuthError::bad("invalid_client_metadata", "token_endpoint_auth_method must be a string")),
    };
    if let Some(g) = meta.get("grant_types").filter(|v| !v.is_null()) {
        if string_list(g, "grant_types")?.iter().any(|t| t != "authorization_code" && t != "refresh_token") {
            return Err(OAuthError::bad("invalid_client_metadata", "Yama supports the authorization_code and refresh_token grants only"));
        }
    }
    if let Some(r) = meta.get("response_types").filter(|v| !v.is_null()) {
        if string_list(r, "response_types")?.iter().any(|t| t != "code") {
            return Err(OAuthError::bad("invalid_client_metadata", "Yama supports response_type code only"));
        }
    }
    let name = meta.get("client_name").and_then(Value::as_str).and_then(clean_name);

    sweep(&st.pool).await?;
    let (waiting, total): (i64, i64) =
        sqlx::query_as("SELECT COALESCE(SUM(used_at IS NULL), 0), COUNT(*) FROM oauth_clients").fetch_one(&st.pool).await?;
    if waiting >= MAX_WAITING_CLIENTS || total >= MAX_CLIENTS {
        tracing::warn!(waiting, total, "oauth registration refused: too many clients");
        return Err(OAuthError::new(StatusCode::SERVICE_UNAVAILABLE, "temporarily_unavailable", "Yama has too many apps waiting to connect. Try again later."));
    }
    let id = new_id();
    let secret = (method != "none").then(|| format!("{PREFIX_SECRET}{}", random_token()));
    let issued = Utc::now();
    sqlx::query("INSERT INTO oauth_clients (id, name, redirect_uris, auth_method, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&name)
        .bind(serde_json::to_string(&uris).map_err(anyhow::Error::from).map_err(AppError::from)?)
        .bind(method)
        .bind(secret.as_deref().map(sha256_hex))
        .bind(stamp(issued))
        .execute(&st.pool)
        .await?;
    tracing::info!(client = %id, method, "oauth client registered");
    let mut out = json!({
        "client_id": id,
        "client_id_issued_at": issued.timestamp(),
        "redirect_uris": uris,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": method,
    });
    if let Some(n) = name {
        out["client_name"] = json!(n);
    }
    if let Some(s) = secret {
        out["client_secret"] = json!(s);
        out["client_secret_expires_at"] = json!(0);
    }
    Ok(out)
}

// ── the authorization request ───────────────────────────────────────────────

#[derive(Deserialize, Default, Clone)]
struct AuthParams {
    client_id: Option<String>,
    redirect_uri: Option<String>,
    response_type: Option<String>,
    code_challenge: Option<String>,
    code_challenge_method: Option<String>,
    scope: Option<String>,
    state: Option<String>,
    resource: Option<String>,
}

impl AuthParams {
    fn from_map(mut m: HashMap<String, String>) -> Self {
        Self {
            client_id: m.remove("client_id"),
            redirect_uri: m.remove("redirect_uri"),
            response_type: m.remove("response_type"),
            code_challenge: m.remove("code_challenge"),
            code_challenge_method: m.remove("code_challenge_method"),
            scope: m.remove("scope"),
            state: m.remove("state"),
            resource: m.remove("resource"),
        }
    }
}

struct Valid {
    client: Client,
    redirect_uri: String,
    challenge: String,
    scope: String,
    resource: String,
    state: Option<String>,
}

enum Checked {
    Valid(Box<Valid>),
    /// Something the app got wrong, said to the app on its own redirect URI (RFC 6749 4.1.2.1).
    Bounce { redirect: String, message: String },
    /// No trustworthy redirect URI: shown on Yama's page, never redirected.
    Refuse(String),
}

/// The redirect back to the app with `params`, plus `state` and `iss`.
fn back(urls: &Urls, redirect_uri: &str, state: Option<&str>, params: &[(&str, &str)]) -> String {
    let mut all: Vec<(&str, &str)> = params.to_vec();
    if let Some(s) = state {
        all.push(("state", s));
    }
    all.push(("iss", urls.issuer()));
    redirect::with_params(redirect_uri, &all).unwrap_or_else(|| redirect_uri.to_string())
}

async fn check_request(st: &AppState, urls: &Urls, p: &AuthParams) -> AppResult<Checked> {
    let client = match p.client_id.as_deref().filter(|c| !c.is_empty()) {
        Some(id) => load_client(&st.pool, id).await?,
        None => None,
    };
    let Some(client) = client else {
        return Ok(Checked::Refuse(
            "Yama doesn't know this app, or its registration lapsed. Remove Yama from the app, add it again, and try once more.".into(),
        ));
    };
    let Some(redirect_uri) = p.redirect_uri.clone().filter(|r| !r.is_empty()) else {
        return Ok(Checked::Refuse("The app didn't say where to send you back (no redirect_uri).".into()));
    };
    if !client.redirect_uris.iter().any(|r| redirect::matches(r, &redirect_uri)) {
        return Ok(Checked::Refuse("The app asked Yama to send you to an address it never registered, so Yama won't send you there.".into()));
    }
    let state = p.state.clone();
    if state.as_ref().is_some_and(|s| s.len() > MAX_STATE) {
        return Ok(Checked::Refuse("The app's sign-in request is too long (state).".into()));
    }
    let bounce = |error: &str, message: &str| Checked::Bounce {
        redirect: back(urls, &redirect_uri, state.as_deref(), &[("error", error), ("error_description", message)]),
        message: message.to_string(),
    };
    if p.response_type.as_deref() != Some("code") {
        return Ok(bounce("unsupported_response_type", "Yama only gives out authorization codes (response_type=code)."));
    }
    let Some(challenge) = p.code_challenge.clone().filter(|c| pkce_shaped(c)) else {
        return Ok(bounce("invalid_request", "Yama needs PKCE: a code_challenge with code_challenge_method=S256."));
    };
    if p.code_challenge_method.as_deref() != Some("S256") {
        return Ok(bounce("invalid_request", "Yama needs code_challenge_method=S256 (plain isn't allowed)."));
    }
    let scope = match parse_scope(p.scope.as_deref()) {
        Ok(s) => s,
        Err(bad) => return Ok(bounce("invalid_scope", &format!("Yama has no scope \"{bad}\". Ask for mcp."))),
    };
    if let Some(r) = p.resource.as_deref()
        && redirect::canonical_resource(r).as_deref() != Some(urls.resource().as_str())
    {
        return Ok(bounce("invalid_target", &format!("This sign-in is for Yama's tools at {}.", urls.resource())));
    }
    Ok(Checked::Valid(Box::new(Valid { client, redirect_uri, challenge, scope, resource: urls.resource(), state })))
}

fn viewing_refusal(view: &ViewAs) -> AppError {
    AppError::Forbidden(format!(
        "You're viewing Yama as {}. Stop viewing to connect an app: a connection is only ever for your own account.",
        view.target.display_name
    ))
}

fn may_connect(st: &AppState, user: &User) -> AppResult<()> {
    if may_use_yama(&st.cfg, user) { Ok(()) } else { Err(AppError::Forbidden("This account can't use Yama right now, so it can't connect apps.".into())) }
}

/// `GET /api/oauth/authorize?…`: is this request good, and what should the consent page show.
async fn check_route(State(st): State<AppState>, MaybeView(view): MaybeView, CurrentUser(user): CurrentUser, RawQuery(query): RawQuery) -> AppResult<Json<Value>> {
    let urls = urls(&st).ok_or(AppError::NotFound("route"))?;
    if let Some(v) = &view {
        return Err(viewing_refusal(v));
    }
    may_connect(&st, &user)?;
    let params = AuthParams::from_map(parse_pairs(query.unwrap_or_default().as_bytes()).map_err(|e| AppError::bad(e.description))?);
    Ok(Json(match check_request(&st, &urls, &params).await? {
        Checked::Valid(v) => {
            let (host, loopback) = redirect::describe(&v.redirect_uri);
            let asked = Access::of(&v.scope).unwrap_or(Access::Apply);
            // What the person may give it: what it asked for, or less.
            let choices: Vec<&str> = [Access::Read, Access::Stage, Access::Apply].into_iter().filter(|a| *a <= asked).map(Access::as_str).collect();
            json!({
                "ok": true,
                "client_name": v.client.name,
                "redirect_host": host,
                "loopback": loopback,
                "scopes": v.scope.split(' ').collect::<Vec<_>>(),
                "access": asked.as_str(),
                "access_choices": choices,
                "account": {"display_name": user.display_name, "email": user.email},
            })
        }
        Checked::Bounce { redirect, message } => json!({"ok": false, "error": message, "redirect": redirect}),
        Checked::Refuse(message) => return Err(AppError::BadRequest(message)),
    }))
}

#[derive(Deserialize)]
struct Decision {
    #[serde(flatten)]
    params: AuthParams,
    approve: bool,
    /// What the person chose to allow: read, stage or apply, no more than the app asked for.
    /// Left out, the app gets what it asked for.
    #[serde(default)]
    access: Option<String>,
}

/// `POST /api/oauth/authorize`: Allow or Deny, from the consent page. Answers with the URL to
/// send the browser to.
async fn decide_route(
    State(st): State<AppState>,
    MaybeView(view): MaybeView,
    headers: HeaderMap,
    CurrentUser(user): CurrentUser,
    Json(body): Json<Decision>,
) -> AppResult<Json<Value>> {
    let urls = urls(&st).ok_or(AppError::NotFound("route"))?;
    // Only our own page may answer: no other site, even with the cookie (which SameSite=Lax
    // already keeps off cross-site POSTs).
    if headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) != Some(urls.base.as_str()) {
        return Err(AppError::Forbidden("Answer from Yama's own page.".into()));
    }
    if let Some(v) = &view {
        return Err(viewing_refusal(v));
    }
    may_connect(&st, &user)?;
    st.limits.oauth_approve.check_user(&user)?;
    let v = match check_request(&st, &urls, &body.params).await? {
        Checked::Valid(v) => v,
        Checked::Bounce { redirect, .. } => return Ok(Json(json!({"redirect": redirect}))),
        Checked::Refuse(message) => return Err(AppError::BadRequest(message)),
    };
    if !body.approve {
        tracing::info!(user = %user.id, client = %v.client.id, "oauth sign-in denied");
        let to = back(&urls, &v.redirect_uri, v.state.as_deref(), &[("error", "access_denied"), ("error_description", "The person said no.")]);
        return Ok(Json(json!({"redirect": to})));
    }
    // The person may give the app less than it asked for, never more.
    let asked = Access::of(&v.scope).unwrap_or(Access::Apply);
    let granted = match body.access.as_deref() {
        None => asked,
        Some(word) => Access::from_word(word).filter(|a| *a <= asked).ok_or_else(|| AppError::bad("access is read, stage or apply, and no more than the app asked for"))?,
    };
    let scope = scope_for(granted, &v.scope);
    // Signing in again with an app already connected replaces that connection, so it doesn't count.
    let live: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM oauth_grants WHERE user_id = ? AND client_id != ? AND revoked_at IS NULL")
        .bind(&user.id)
        .bind(&v.client.id)
        .fetch_one(&st.pool)
        .await?;
    if live >= MAX_LIVE_GRANTS {
        return Err(AppError::Conflict(format!("You have {MAX_LIVE_GRANTS} connected apps. Disconnect one in Decks, Plans, Settings first.")));
    }
    let code = random_token();
    let at = Utc::now();
    sqlx::query(
        "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(sha256_hex(&code))
    .bind(&v.client.id)
    .bind(&user.id)
    .bind(&v.redirect_uri)
    .bind(&v.challenge)
    .bind(&scope)
    .bind(&v.resource)
    .bind(stamp(at))
    .bind(stamp(at + Duration::seconds(CODE_SECONDS)))
    .execute(&st.pool)
    .await?;
    tracing::info!(user = %user.id, client = %v.client.id, access = granted.as_str(), "oauth sign-in approved");
    Ok(Json(json!({"redirect": back(&urls, &v.redirect_uri, v.state.as_deref(), &[("code", &code)])})))
}

// ── the token endpoint ──────────────────────────────────────────────────────

/// The client making a token or revocation request: HTTP Basic, or `client_id` (and
/// `client_secret` for a confidential client) in the form.
async fn authenticate(st: &AppState, headers: &HeaderMap, form: &HashMap<String, String>) -> Result<Client, OAuthError> {
    let basic = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Basic ").or_else(|| v.strip_prefix("basic ")))
        .map(str::trim);
    let (id, secret) = match basic {
        Some(b) => {
            // RFC 6749 2.3.1: each part is form-encoded before joining with ':'.
            let decoded = STANDARD.decode(b).ok().and_then(|d| String::from_utf8(d).ok()).ok_or_else(|| OAuthError::client(true))?;
            let (id, secret) = decoded.split_once(':').ok_or_else(|| OAuthError::client(true))?;
            let unescape = |s: &str| url::form_urlencoded::parse(format!("v={s}").as_bytes()).next().map(|(_, v)| v.to_string()).unwrap_or_default();
            let (id, secret) = (unescape(id), unescape(secret));
            if form.get("client_id").is_some_and(|f| *f != id) || form.contains_key("client_secret") {
                return Err(OAuthError::client(true));
            }
            (id, Some(secret))
        }
        None => (required(form, "client_id").map_err(|_| OAuthError::client(false))?.to_string(), form.get("client_secret").cloned()),
    };
    let client = load_client(&st.pool, &id).await?.ok_or_else(|| OAuthError::client(basic.is_some()))?;
    match (&client.secret_hash, secret) {
        // A public client (Claude's): PKCE stands in for a secret.
        (None, _) => Ok(client),
        (Some(hash), Some(s)) if ct_eq(&sha256_hex(&s), hash) => Ok(client),
        _ => Err(OAuthError::client(basic.is_some())),
    }
}

async fn token_route(State(st): State<AppState>, ClientAddress(address): ClientAddress, headers: HeaderMap, body: Bytes) -> Response {
    let Some(urls) = urls(&st) else { return not_found() };
    let out = async {
        st.limits.oauth_token.check(&address_key(address))?;
        let form = parse_pairs(&body)?;
        let client = authenticate(&st, &headers, &form).await?;
        match form.get("grant_type").map(String::as_str) {
            Some("authorization_code") => exchange_code(&st, &urls, &client, &form).await,
            Some("refresh_token") => refresh(&st, &urls, &client, &form).await,
            Some(_) => Err(OAuthError::bad("unsupported_grant_type", "Yama accepts the authorization_code and refresh_token grants")),
            None => Err(OAuthError::bad("invalid_request", "grant_type is missing")),
        }
    }
    .await;
    answer(out, StatusCode::OK)
}

/// A new access and refresh token for a grant.
async fn issue(tx: &mut Transaction<'_, Sqlite>, grant_id: &str, scope: &str) -> sqlx::Result<Value> {
    let access = format!("{PREFIX_ACCESS}{}", random_token());
    let refresh = format!("{PREFIX_REFRESH}{}", random_token());
    let at = Utc::now();
    for (token, kind, until) in [(&access, "access", at + Duration::seconds(ACCESS_SECONDS)), (&refresh, "refresh", at + Duration::days(REFRESH_DAYS))] {
        sqlx::query("INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
            .bind(sha256_hex(token))
            .bind(grant_id)
            .bind(kind)
            .bind(stamp(at))
            .bind(stamp(until))
            .execute(&mut **tx)
            .await?;
    }
    Ok(json!({"access_token": access, "token_type": "Bearer", "expires_in": ACCESS_SECONDS, "refresh_token": refresh, "scope": scope}))
}

/// End a grant: it shows as revoked, and its tokens are deleted.
async fn revoke_in(tx: &mut Transaction<'_, Sqlite>, grant_id: &str, reason: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ?), revoke_reason = COALESCE(revoke_reason, ?) WHERE id = ?")
        .bind(now())
        .bind(reason)
        .bind(grant_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM oauth_tokens WHERE grant_id = ?").bind(grant_id).execute(&mut **tx).await?;
    Ok(())
}

async fn revoke_grant(pool: &SqlitePool, grant_id: &str, reason: &str) -> sqlx::Result<()> {
    let mut tx = pool.begin().await?;
    revoke_in(&mut tx, grant_id, reason).await?;
    tx.commit().await
}

#[derive(sqlx::FromRow)]
struct CodeRow {
    client_id: String,
    user_id: String,
    redirect_uri: String,
    code_challenge: String,
    scope: String,
    expires_at: String,
    used_at: Option<String>,
    resource: String,
}

const CODE_USED: &str = "This code was already used, so the connection it made is cut off. Sign in again.";

async fn code_replayed(pool: &SqlitePool, hash: &str) -> Result<Value, OAuthError> {
    let grant: Option<String> = sqlx::query_scalar("SELECT grant_id FROM oauth_codes WHERE code_hash = ?").bind(hash).fetch_optional(pool).await?.flatten();
    if let Some(g) = grant {
        revoke_grant(pool, &g, "code replayed").await?;
        tracing::warn!(grant = %g, "an authorization code was used twice; its grant is revoked");
    }
    Err(OAuthError::grant(CODE_USED))
}

async fn exchange_code(st: &AppState, urls: &Urls, client: &Client, form: &HashMap<String, String>) -> Result<Value, OAuthError> {
    let code = required(form, "code")?;
    let redirect_uri = required(form, "redirect_uri")?;
    let verifier = required(form, "code_verifier")?;
    if let Some(r) = form.get("resource") {
        check_resource(urls, r)?;
    }
    sweep(&st.pool).await?;
    let hash = sha256_hex(code);
    let row: Option<CodeRow> = sqlx::query_as(
        "SELECT client_id, user_id, redirect_uri, code_challenge, scope, expires_at, used_at, resource FROM oauth_codes WHERE code_hash = ?",
    )
    .bind(&hash)
    .fetch_optional(&st.pool)
    .await?;
    let Some(row) = row else { return Err(OAuthError::grant("This code isn't valid. Sign in again.")) };
    if row.used_at.is_some() {
        return code_replayed(&st.pool, &hash).await;
    }
    // A failed check leaves the code alone: only the app that holds the verifier can use it.
    if row.expires_at <= now() {
        return Err(OAuthError::grant("This code expired. Sign in again."));
    }
    if row.client_id != client.id {
        return Err(OAuthError::grant("This code was given to another app."));
    }
    if row.redirect_uri != redirect_uri {
        return Err(OAuthError::grant("redirect_uri isn't the one this code was given for."));
    }
    if !pkce_ok(verifier, &row.code_challenge) {
        return Err(OAuthError::grant("code_verifier doesn't match the code_challenge."));
    }
    let user = user_by_id(st, &row.user_id).await?.ok_or_else(|| OAuthError::grant("This account can't use Yama right now."))?;
    let at = now();
    let mut tx = st.pool.begin().await?;
    // Claiming the code takes SQLite's write lock, so a second exchange racing this one waits,
    // then finds it used, with the grant to revoke.
    let claimed = sqlx::query("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").bind(&at).bind(&hash).execute(&mut *tx).await?;
    if claimed.rows_affected() == 0 {
        drop(tx);
        return code_replayed(&st.pool, &hash).await;
    }
    // One grant per app and account: signing in again replaces the last one.
    let old: Vec<String> = sqlx::query_scalar("SELECT id FROM oauth_grants WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL")
        .bind(&user.id)
        .bind(&client.id)
        .fetch_all(&mut *tx)
        .await?;
    for g in old {
        revoke_in(&mut tx, &g, "replaced").await?;
    }
    let grant_id = new_id();
    sqlx::query(
        "INSERT INTO oauth_grants (id, user_id, client_id, scope, resource, redirect_uri, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&grant_id)
    .bind(&user.id)
    .bind(&client.id)
    .bind(&row.scope)
    .bind(&row.resource)
    .bind(&row.redirect_uri)
    .bind(&at)
    .bind(&at)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE oauth_codes SET grant_id = ? WHERE code_hash = ?").bind(&grant_id).bind(&hash).execute(&mut *tx).await?;
    sqlx::query("UPDATE oauth_clients SET used_at = ? WHERE id = ?").bind(&at).bind(&client.id).execute(&mut *tx).await?;
    let tokens = issue(&mut tx, &grant_id, &row.scope).await?;
    tx.commit().await?;
    tracing::info!(user = %user.id, client = %client.id, grant = %grant_id, "oauth app connected");
    Ok(tokens)
}

#[derive(sqlx::FromRow)]
struct RefreshRow {
    grant_id: String,
    expires_at: String,
    used_at: Option<String>,
    client_id: String,
    user_id: String,
    scope: String,
    revoked_at: Option<String>,
}

fn within_grace(used_at: &str) -> bool {
    DateTime::parse_from_rfc3339(used_at).is_ok_and(|t| Utc::now().signed_duration_since(t) <= Duration::seconds(REFRESH_GRACE_SECONDS))
}

const REFRESH_REUSED: &str = "This refresh token was already used, so the connection is cut off to be safe. Sign in again.";

async fn refresh(st: &AppState, urls: &Urls, client: &Client, form: &HashMap<String, String>) -> Result<Value, OAuthError> {
    let token = required(form, "refresh_token")?;
    if let Some(r) = form.get("resource") {
        check_resource(urls, r)?;
    }
    let hash = sha256_hex(token);
    let row: Option<RefreshRow> = sqlx::query_as(
        "SELECT t.grant_id, t.expires_at, t.used_at, g.client_id, g.user_id, g.scope, g.revoked_at
           FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ? AND t.kind = 'refresh'",
    )
    .bind(&hash)
    .fetch_optional(&st.pool)
    .await?;
    let Some(row) = row else { return Err(OAuthError::grant("This refresh token isn't valid. Sign in again.")) };
    if row.client_id != client.id {
        return Err(OAuthError::grant("This refresh token belongs to another app."));
    }
    if row.revoked_at.is_some() {
        return Err(OAuthError::grant("This connection was ended. Sign in again."));
    }
    if row.used_at.as_deref().is_some_and(|u| !within_grace(u)) {
        revoke_grant(&st.pool, &row.grant_id, "refresh token reused").await?;
        tracing::warn!(grant = %row.grant_id, "a refresh token was used twice; its grant is revoked");
        return Err(OAuthError::grant(REFRESH_REUSED));
    }
    if row.expires_at <= now() {
        return Err(OAuthError::grant("This refresh token expired. Sign in again."));
    }
    if let Some(asked) = form.get("scope") {
        let granted: Vec<&str> = row.scope.split(' ').collect();
        // A client may ask again for what it first asked for (`mcp`) after the person gave it
        // less: that is not an error and never widens the connection. The new tokens carry
        // the grant's own scope. A scope Yama doesn't have is still refused.
        if let Some(extra) = asked.split_whitespace().find(|s| !granted.contains(s) && Access::of(s).is_none()) {
            return Err(OAuthError::bad("invalid_scope", format!("this connection wasn't given \"{}\"", extra.chars().take(60).collect::<String>())));
        }
    }
    user_by_id(st, &row.user_id).await?.ok_or_else(|| OAuthError::grant("This account can't use Yama right now."))?;
    let mut tx = st.pool.begin().await?;
    // Mark it used, keeping the first time if a racing refresh got there first.
    sqlx::query("UPDATE oauth_tokens SET used_at = COALESCE(used_at, ?) WHERE token_hash = ?").bind(now()).bind(&hash).execute(&mut *tx).await?;
    let used: Option<Option<String>> = sqlx::query_scalar("SELECT used_at FROM oauth_tokens WHERE token_hash = ?").bind(&hash).fetch_optional(&mut *tx).await?;
    let live: Option<bool> = sqlx::query_scalar("SELECT revoked_at IS NULL FROM oauth_grants WHERE id = ?").bind(&row.grant_id).fetch_optional(&mut *tx).await?;
    match (used.flatten(), live) {
        (Some(u), Some(true)) if within_grace(&u) => {}
        (Some(_), Some(true)) => {
            revoke_in(&mut tx, &row.grant_id, "refresh token reused").await?;
            tx.commit().await?;
            tracing::warn!(grant = %row.grant_id, "a refresh token was used twice; its grant is revoked");
            return Err(OAuthError::grant(REFRESH_REUSED));
        }
        // Revoked meanwhile (Disconnect, or another refresh found a reuse).
        _ => return Err(OAuthError::grant("This connection was ended. Sign in again.")),
    }
    let tokens = issue(&mut tx, &row.grant_id, &row.scope).await?;
    sqlx::query("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(now()).bind(&row.grant_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(tokens)
}

/// `POST /oauth/revoke` (RFC 7009): end the connection a token belongs to, if it's this client's.
/// An unknown token is not an error.
async fn revoke_route(State(st): State<AppState>, ClientAddress(address): ClientAddress, headers: HeaderMap, body: Bytes) -> Response {
    if urls(&st).is_none() {
        return not_found();
    }
    let out = async {
        st.limits.oauth_token.check(&address_key(address))?;
        let form = parse_pairs(&body)?;
        let client = authenticate(&st, &headers, &form).await?;
        let token = required(&form, "token")?;
        let grant: Option<(String, String)> =
            sqlx::query_as("SELECT g.id, g.client_id FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id WHERE t.token_hash = ?")
                .bind(sha256_hex(token))
                .fetch_optional(&st.pool)
                .await?;
        if let Some((g, owner)) = grant
            && owner == client.id
        {
            revoke_grant(&st.pool, &g, "revoked by the app").await?;
            tracing::info!(grant = %g, "oauth grant revoked by its app");
        }
        Ok::<_, OAuthError>(())
    }
    .await;
    match out {
        Ok(()) => {
            let mut res = StatusCode::OK.into_response();
            no_store(&mut res);
            res
        }
        Err(e) => e.into_response(),
    }
}

// ── using a token (`mcp::caller`) ───────────────────────────────────────────

/// The account a live access token acts for, recording its grant's last use at most once a
/// minute. The caller still applies the disabled and open sign-up rules (`auth::user_by_id`).
/// The account an access token is for and what its connection may do; none when the token is
/// unknown, expired or its connection ended. A connection made before the narrower scopes has
/// `mcp`, which is everything.
pub async fn access_token_user(st: &AppState, token: &str) -> AppResult<Option<(String, Access)>> {
    if urls(st).is_none() {
        return Ok(None);
    }
    let at = now();
    let row: Option<(String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT g.id, g.user_id, g.last_used_at, g.scope FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
          WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ? AND g.revoked_at IS NULL",
    )
    .bind(sha256_hex(token))
    .bind(&at)
    .fetch_optional(&st.pool)
    .await?;
    let Some((grant, user, last, scope)) = row else { return Ok(None) };
    let minute_ago = stamp(Utc::now() - Duration::seconds(60));
    if last.as_deref().is_none_or(|l| l < minute_ago.as_str()) {
        sqlx::query("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").bind(&at).bind(&grant).execute(&st.pool).await?;
    }
    // A scope that names no tool scope allows the least.
    Ok(Some((user, Access::of(&scope).unwrap_or(Access::Read))))
}

// ── Connected apps (Decks, Plans, Settings) ─────────────────────────────────

#[derive(sqlx::FromRow)]
struct AppRow {
    id: String,
    name: Option<String>,
    scope: String,
    redirect_uri: String,
    created_at: String,
    last_used_at: Option<String>,
}

#[derive(Serialize)]
struct ConnectedApp {
    id: String,
    /// The app's own name for itself; null when it gave none.
    name: Option<String>,
    redirect_host: String,
    loopback: bool,
    /// read, stage or apply: what it may do with the tools.
    access: &'static str,
    connected_at: String,
    last_used_at: Option<String>,
}

/// The caller's live connections (a token that still works), newest first, and the address to
/// connect to.
async fn list_apps(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    let rows: Vec<AppRow> = sqlx::query_as(
        "SELECT g.id, c.name, g.scope, g.redirect_uri, g.created_at, g.last_used_at FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
          WHERE g.user_id = ? AND g.revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = g.id AND t.expires_at > ? AND (t.kind = 'access' OR t.used_at IS NULL))
          ORDER BY g.created_at DESC, g.id LIMIT 50",
    )
    .bind(&user.id)
    .bind(now())
    .fetch_all(&st.pool)
    .await?;
    let apps: Vec<ConnectedApp> = rows
        .into_iter()
        .map(|r| {
            let (redirect_host, loopback) = redirect::describe(&r.redirect_uri);
            ConnectedApp { id: r.id, name: r.name, redirect_host, loopback, access: Access::of(&r.scope).unwrap_or(Access::Read).as_str(), connected_at: r.created_at, last_used_at: r.last_used_at }
        })
        .collect();
    let u = urls(&st);
    Ok(Json(json!({"enabled": u.is_some(), "mcp_url": u.map(|u| u.resource()), "apps": apps})))
}

/// Disconnect one of the caller's apps: all its tokens stop working at once.
async fn disconnect(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    let owned: Option<String> = sqlx::query_scalar("SELECT id FROM oauth_grants WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
        .bind(&id)
        .bind(&user.id)
        .fetch_optional(&st.pool)
        .await?;
    let id = owned.ok_or(AppError::NotFound("connected app"))?;
    revoke_grant(&st.pool, &id, "disconnected").await?;
    tracing::info!(user = %user.id, grant = %id, "oauth app disconnected");
    Ok(StatusCode::NO_CONTENT)
}

/// Withdrawing someone's invite ends their connections too, as it does their script keys.
pub async fn revoke_all_for_email(pool: &SqlitePool, email: &str) -> sqlx::Result<()> {
    let grants: Vec<String> =
        sqlx::query_scalar("SELECT g.id FROM oauth_grants g JOIN users u ON u.id = g.user_id WHERE u.email = ? AND g.revoked_at IS NULL")
            .bind(email)
            .fetch_all(pool)
            .await?;
    for g in grants {
        revoke_grant(pool, &g, "disconnected").await?;
    }
    Ok(())
}

// ── housekeeping ────────────────────────────────────────────────────────────

static LAST_SWEEP: AtomicI64 = AtomicI64::new(0);
const SWEEP_EVERY_SECONDS: i64 = 600;

/// Sweep at most every ten minutes (called from registration and code exchange).
async fn sweep(pool: &SqlitePool) -> sqlx::Result<()> {
    let at = Utc::now().timestamp();
    let last = LAST_SWEEP.load(Ordering::Relaxed);
    if at - last < SWEEP_EVERY_SECONDS || LAST_SWEEP.compare_exchange(last, at, Ordering::Relaxed, Ordering::Relaxed).is_err() {
        return Ok(());
    }
    sweep_now(pool, Utc::now()).await
}

/// Delete codes and tokens a day after they expire, grants a day after they end (revoked, or with
/// no token left), clients nobody finished a sign-in with after a day, and clients whose
/// connections are all gone after 30 days.
async fn sweep_now(pool: &SqlitePool, at: DateTime<Utc>) -> sqlx::Result<()> {
    let day_ago = stamp(at - Duration::days(1));
    let month_ago = stamp(at - Duration::days(30));
    sqlx::query("DELETE FROM oauth_codes WHERE expires_at < ?").bind(&day_ago).execute(pool).await?;
    sqlx::query("DELETE FROM oauth_tokens WHERE expires_at < ?").bind(&day_ago).execute(pool).await?;
    sqlx::query(
        "DELETE FROM oauth_grants WHERE (revoked_at IS NOT NULL AND revoked_at < ?1)
            OR (created_at < ?1 AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.grant_id = oauth_grants.id))",
    )
    .bind(&day_ago)
    .execute(pool)
    .await?;
    sqlx::query(
        "DELETE FROM oauth_clients WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.id)
            AND ((used_at IS NULL AND created_at < ?) OR used_at < ?)",
    )
    .bind(&day_ago)
    .bind(&month_ago)
    .execute(pool)
    .await?;
    Ok(())
}
