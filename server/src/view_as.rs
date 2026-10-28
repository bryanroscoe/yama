//! Admin "View as": an admin sees Yama as one other person sees it, read only, to help them.
//!
//! - **Start:** Admin, People, a person, View as (`POST /api/admin/users/{id}/view`). Not for
//!   admins (yours or another's) or yourself; disabled accounts can be viewed, which is when
//!   support most often needs it. It sets a second cookie, `yama_view`, beside the admin's own
//!   session, which is never replaced: the view is tied to that session (its hash is stored), so
//!   the cookie is useless to anyone else and dies with the admin's session.
//! - **Read only, enforced here:** [`guard`] wraps the whole router. While a view is live it
//!   refuses every request but GET and HEAD on any path (except stopping the view and signing
//!   out), so the API and `/mcp` alike; every WebSocket (online games, watched games and shared
//!   tables send actions over them); and the GETs that would show secrets or reach the person's
//!   Claude ([`HIDDEN`]: Ask Claude's one-question tokens are minted only by asking, which is a
//!   POST under it). The refusal comes before routing, so a route added later is covered without
//!   being listed.
//! - **Who the request is:** a GET the guard lets through carries [`ViewAs`]; `CurrentUser` then
//!   answers as the viewed person, so every page shows exactly their data. The viewed person's
//!   last-seen time isn't touched.
//! - **Short:** 30 minutes ([`VIEW_MINUTES`]), or until Stop, sign-out, the admin's session ending
//!   or the admin losing admin. A stale cookie is cleared; a write sent with one is refused rather
//!   than run as the admin.
//! - **Logged:** every view is a `view_sessions` row (who, whom, when, how it ended), listed in
//!   Admin, People, Viewing log. Only admins see it; the viewed person isn't shown a list.

use crate::admin::AdminUser;
use crate::auth::{User, request_session_token};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, random_token, sha256_hex};
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{Duration, Utc};
use serde::Serialize;

pub const VIEW_COOKIE: &str = "yama_view";
/// How long a view lasts before it ends on its own.
pub const VIEW_MINUTES: i64 = 30;

/// Requests allowed while viewing even though they aren't reads: they end the view.
const ALLOWED_WRITES: [&str; 2] = ["/api/view/stop", "/api/auth/logout"];

/// GETs refused while viewing: script keys, connected apps (`oauth/`), and Ask Claude (its status
/// shows the person's stored key; asking would spend it, and conversations are theirs to keep
/// private). The OAuth consent page's own check refuses a view by itself, with its own reason.
const HIDDEN: [&str; 3] = ["/api/me/tokens", "/api/me/connected-apps", "/api/advisor"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/users/{id}/view", post(start))
        .route("/api/admin/views", get(log))
        .route("/api/view/stop", post(stop))
}

/// A live view, resolved by [`guard`] and attached to the request.
#[derive(Clone, Debug)]
pub struct ViewAs {
    pub admin: User,
    pub target: User,
    pub target_disabled: bool,
    pub started_at: String,
    pub expires_at: String,
}

/// What `/api/me` says about a view, for the banner.
#[derive(Serialize)]
pub struct Viewing {
    admin_id: String,
    admin_name: String,
    admin_email: String,
    target_disabled: bool,
    started_at: String,
    expires_at: String,
}

impl From<&ViewAs> for Viewing {
    fn from(v: &ViewAs) -> Self {
        Viewing {
            admin_id: v.admin.id.clone(),
            admin_name: v.admin.display_name.clone(),
            admin_email: v.admin.email.clone(),
            target_disabled: v.target_disabled,
            started_at: v.started_at.clone(),
            expires_at: v.expires_at.clone(),
        }
    }
}

/// Extractor: the live view on this request, if any.
pub struct MaybeView(pub Option<ViewAs>);

impl<S: Send + Sync> FromRequestParts<S> for MaybeView {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        Ok(MaybeView(parts.extensions.get::<ViewAs>().cloned()))
    }
}

fn view_cookie(headers: &HeaderMap) -> Option<String> {
    CookieJar::from_headers(headers).get(VIEW_COOKIE).map(|c| c.value().to_string())
}

fn expired_cookie() -> HeaderValue {
    // Clearing needs the same name and path; Max-Age=0 removes it at once.
    HeaderValue::from_static("yama_view=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax")
}

fn refuse(status: StatusCode, message: String, clear: bool) -> Response {
    let mut res = (status, Json(serde_json::json!({ "error": message, "viewing": !clear }))).into_response();
    if clear {
        res.headers_mut().append(header::SET_COOKIE, expired_cookie());
    }
    res
}

fn is_websocket(headers: &HeaderMap) -> bool {
    headers.get(header::UPGRADE).is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
}

fn is_hidden(path: &str) -> bool {
    HIDDEN.iter().any(|h| path == *h || path.strip_prefix(h).is_some_and(|rest| rest.starts_with('/')))
}

/// Middleware over the whole router: resolve a view, keep it read only, and hand it to
/// `CurrentUser`. Requests without the view cookie pass untouched.
pub async fn guard(State(st): State<AppState>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let reading = method == Method::GET || method == Method::HEAD;
    // Pages and files are only read. Anything else on any path is checked: the API, and `/mcp`
    // (whose tools take a bearer token, never this cookie, but a write there is still a write).
    if reading && (!path.starts_with("/api/") || crate::public_precons::is_public_api(&path) || crate::sharing::is_public_api(&path)) && !is_websocket(req.headers()) {
        return next.run(req).await;
    }
    let Some(view_token) = view_cookie(req.headers()) else { return next.run(req).await };
    let session = request_session_token(req.headers());
    let view = match resolve(&st, &view_token, session.as_deref()).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };
    let Some(view) = view else {
        // A view that ended (expired, stopped elsewhere, the admin's session or admin rights
        // gone). Reads go on as whoever the session is; anything else is refused, because the
        // page sending it still thinks it's viewing. Either way the cookie is cleared.
        if reading || ALLOWED_WRITES.contains(&path.as_str()) {
            let mut res = next.run(req).await;
            res.headers_mut().append(header::SET_COOKIE, expired_cookie());
            return res;
        }
        return refuse(StatusCode::FORBIDDEN, "Viewing as someone has ended. Reload the page.".into(), true);
    };
    let who = view.target.display_name.clone();
    if is_websocket(req.headers()) {
        return refuse(
            StatusCode::FORBIDDEN,
            format!("Viewing as {who}: read only. Live games and shared tables don't open while viewing."),
            false,
        );
    }
    if !reading && !ALLOWED_WRITES.contains(&path.as_str()) {
        return refuse(StatusCode::FORBIDDEN, format!("Viewing as {who}: read only. Stop viewing to make changes."), false);
    }
    if is_hidden(&path) {
        return refuse(StatusCode::FORBIDDEN, format!("Viewing as {who}: their script keys, connected apps and Ask Claude stay private."), false);
    }
    req.extensions_mut().insert(view);
    next.run(req).await
}

#[derive(sqlx::FromRow)]
struct ViewRow {
    id: String,
    admin_id: String,
    target_id: String,
    started_at: String,
    expires_at: String,
}

#[derive(sqlx::FromRow)]
struct Account {
    #[sqlx(flatten)]
    user: User,
    disabled: bool,
}

async fn account(st: &AppState, id: &str) -> AppResult<Option<Account>> {
    Ok(sqlx::query_as(concat!("SELECT ", crate::auth::user_columns!(), ", u.disabled_at IS NOT NULL AS disabled FROM users u WHERE u.id = ?"))
        .bind(id)
        .fetch_optional(&st.pool)
        .await?)
}

/// The live view for this cookie and session, or None. A view is live while it hasn't ended or
/// expired, the admin's own session (the one it was started from) is live, the admin is still an
/// admin and not disabled, and the viewed account isn't an admin. An expired view is recorded as
/// such the first time it's noticed.
async fn resolve(st: &AppState, view_token: &str, session: Option<&str>) -> AppResult<Option<ViewAs>> {
    let at = now();
    let hash = sha256_hex(view_token);
    let row: Option<ViewRow> = match session {
        Some(session) => {
            sqlx::query_as(
                "SELECT v.id, v.admin_id, v.target_id, v.started_at, v.expires_at FROM view_sessions v
                   JOIN sessions s ON s.token_hash = v.admin_session_hash AND s.user_id = v.admin_id AND s.expires_at > ?1
                   JOIN users a ON a.id = v.admin_id AND a.is_admin = 1 AND a.disabled_at IS NULL
                  WHERE v.token_hash = ?2 AND v.admin_session_hash = ?3 AND v.ended_at IS NULL AND v.expires_at > ?1",
            )
            .bind(&at)
            .bind(&hash)
            .bind(sha256_hex(session))
            .fetch_optional(&st.pool)
            .await?
        }
        None => None,
    };
    let Some(row) = row else {
        // Record how a view that isn't live any more ended, the first time it's noticed: it ran
        // out, or its admin lost admin rights or the session it was started from. (Someone else's
        // session presenting the cookie ends nothing.)
        sqlx::query("UPDATE view_sessions SET ended_at = expires_at, end_reason = 'expired' WHERE token_hash = ? AND ended_at IS NULL AND expires_at <= ?")
            .bind(&hash)
            .bind(&at)
            .execute(&st.pool)
            .await?;
        sqlx::query(
            "UPDATE view_sessions SET ended_at = ?1, end_reason = 'ended'
              WHERE token_hash = ?2 AND ended_at IS NULL AND (
                NOT EXISTS (SELECT 1 FROM users a WHERE a.id = view_sessions.admin_id AND a.is_admin = 1 AND a.disabled_at IS NULL)
                OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = view_sessions.admin_session_hash AND s.expires_at > ?1))",
        )
        .bind(&at)
        .bind(&hash)
        .execute(&st.pool)
        .await?;
        return Ok(None);
    };
    let (Some(admin), Some(target)) = (account(st, &row.admin_id).await?, account(st, &row.target_id).await?) else { return Ok(None) };
    if target.user.is_admin {
        end(st, &row.id, "ended").await?;
        return Ok(None);
    }
    Ok(Some(ViewAs {
        admin: admin.user,
        target: target.user,
        target_disabled: target.disabled,
        started_at: row.started_at,
        expires_at: row.expires_at,
    }))
}

async fn end(st: &AppState, id: &str, reason: &str) -> AppResult<()> {
    sqlx::query("UPDATE view_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL")
        .bind(now())
        .bind(reason)
        .bind(id)
        .execute(&st.pool)
        .await?;
    Ok(())
}

#[derive(Serialize)]
struct Started {
    target: User,
    expires_at: String,
}

async fn start(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    headers: HeaderMap,
    jar: CookieJar,
    Path(id): Path<String>,
) -> AppResult<(CookieJar, Json<Started>)> {
    let Some(session) = request_session_token(&headers) else {
        return Err(AppError::Forbidden("View as needs a Yama sign-in session.".into()));
    };
    if id == admin.id {
        return Err(AppError::bad("you're already you"));
    }
    let target = account(&st, &id).await?.ok_or(AppError::NotFound("account"))?;
    if target.user.is_admin {
        return Err(AppError::Forbidden("Admins can't view other admins' accounts.".into()));
    }
    let session_hash = sha256_hex(&session);
    let at = now();
    let expires = (Utc::now() + Duration::minutes(VIEW_MINUTES)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let token = random_token();
    let mut tx = st.pool.begin().await?;
    // One view per admin session: starting another ends the last.
    sqlx::query("UPDATE view_sessions SET ended_at = ?, end_reason = 'replaced' WHERE admin_session_hash = ? AND ended_at IS NULL")
        .bind(&at)
        .bind(&session_hash)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO view_sessions (id, token_hash, admin_id, admin_session_hash, target_id, started_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(new_id())
    .bind(sha256_hex(&token))
    .bind(&admin.id)
    .bind(&session_hash)
    .bind(&target.user.id)
    .bind(&at)
    .bind(&expires)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    tracing::info!(admin = %admin.email, viewing = %target.user.email, "view as started");
    let cookie = Cookie::build((VIEW_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(st.cfg.secure_cookies)
        .max_age(time::Duration::minutes(VIEW_MINUTES))
        .build();
    Ok((jar.add(cookie), Json(Started { target: target.user, expires_at: expires })))
}

/// Stop viewing. Needs only the view cookie (stopping can't hurt anyone); works on an ended view
/// too, and always clears the cookie.
async fn stop(State(st): State<AppState>, jar: CookieJar) -> AppResult<(CookieJar, StatusCode)> {
    if let Some(c) = jar.get(VIEW_COOKIE) {
        sqlx::query("UPDATE view_sessions SET ended_at = ?, end_reason = 'stopped' WHERE token_hash = ? AND ended_at IS NULL")
            .bind(now())
            .bind(sha256_hex(c.value()))
            .execute(&st.pool)
            .await?;
    }
    Ok((jar.remove(Cookie::build(VIEW_COOKIE).path("/")), StatusCode::NO_CONTENT))
}

/// For sign-out: end the view on this cookie and every view started from this session.
pub async fn end_for_logout(st: &AppState, jar: CookieJar) -> AppResult<CookieJar> {
    let at = now();
    if let Some(c) = jar.get(VIEW_COOKIE) {
        sqlx::query("UPDATE view_sessions SET ended_at = ?, end_reason = 'signed out' WHERE token_hash = ? AND ended_at IS NULL")
            .bind(&at)
            .bind(sha256_hex(c.value()))
            .execute(&st.pool)
            .await?;
    }
    if let Some(c) = jar.get(crate::auth::SESSION_COOKIE) {
        sqlx::query("UPDATE view_sessions SET ended_at = ?, end_reason = 'signed out' WHERE admin_session_hash = ? AND ended_at IS NULL")
            .bind(&at)
            .bind(sha256_hex(c.value()))
            .execute(&st.pool)
            .await?;
    }
    Ok(if jar.get(VIEW_COOKIE).is_some() { jar.remove(Cookie::build(VIEW_COOKIE).path("/")) } else { jar })
}

/// One row of the audit log.
#[derive(Serialize, sqlx::FromRow)]
struct LogRow {
    id: String,
    admin_name: String,
    admin_email: String,
    target_id: String,
    target_name: String,
    target_email: String,
    started_at: String,
    expires_at: String,
    ended_at: Option<String>,
    end_reason: Option<String>,
}

/// The audit log, newest first (Admin, People).
async fn log(State(st): State<AppState>, AdminUser(_): AdminUser) -> AppResult<Json<Vec<LogRow>>> {
    Ok(Json(
        sqlx::query_as(
            "SELECT v.id, a.display_name AS admin_name, a.email AS admin_email, t.id AS target_id, t.display_name AS target_name,
                    t.email AS target_email, v.started_at, v.expires_at, v.ended_at, v.end_reason
               FROM view_sessions v JOIN users a ON a.id = v.admin_id JOIN users t ON t.id = v.target_id
              ORDER BY v.started_at DESC, v.id DESC LIMIT 200",
        )
        .fetch_all(&st.pool)
        .await?,
    ))
}
