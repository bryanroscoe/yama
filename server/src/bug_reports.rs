//! Bug reports (2026-11-12): any signed-in person can report a bug from any page or dialog, and
//! point at the part of the screen it's about. Admins read them in Admin, Bug reports.
//!
//! A report keeps the person's words, the page's address and a small JSON `context` the web app
//! gathers: the dialog it came from, the box they drew and the text and controls inside it, the
//! window size and the app build. No screenshot: the words on screen say what was there without
//! copying card images or anyone else's picture. Reports are private to the reporter and admins,
//! and go with the account (admin/delete.rs).

use crate::admin::AdminUser;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

/// The longest description, in characters.
pub const MAX_MESSAGE: usize = 4000;
/// The longest page address, in characters.
pub const MAX_PAGE: usize = 1000;
/// The largest context, as stored JSON, in bytes.
pub const MAX_CONTEXT: usize = 16 * 1024;
/// Reports one account may send in a day.
pub const PER_DAY: i64 = 20;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/bug-reports", post(create))
        .route("/api/admin/bug-reports", axum::routing::get(list))
        .route("/api/admin/bug-reports/{id}", patch(set_resolved).delete(remove))
}

#[derive(Deserialize)]
struct NewReport {
    message: String,
    page: String,
    #[serde(default)]
    context: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct Created {
    id: String,
}

async fn create(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<NewReport>) -> AppResult<(StatusCode, Json<Created>)> {
    let message = body.message.trim();
    if message.is_empty() {
        return Err(AppError::bad("say what went wrong"));
    }
    if message.chars().count() > MAX_MESSAGE {
        return Err(AppError::bad(format!("keep the description under {MAX_MESSAGE} characters")));
    }
    let page = body.page.trim();
    if !is_app_path(page) {
        return Err(AppError::bad("the page must be an address in Yama, starting with /"));
    }
    let context = match body.context {
        None | Some(serde_json::Value::Null) => serde_json::json!({}),
        Some(serde_json::Value::Object(map)) => clean_context(&map),
        Some(_) => return Err(AppError::bad("context must be an object")),
    }
    .to_string();
    if context.len() > MAX_CONTEXT {
        return Err(AppError::bad("too much detail came with the report"));
    }
    let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let id = new_id();
    // Counted and written in one statement, so reports sent at once can't pass the limit together.
    let added = sqlx::query(
        "INSERT INTO bug_reports (id, owner_id, created_at, page, message, context)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE (SELECT COUNT(*) FROM bug_reports WHERE owner_id = ?2 AND created_at > ?7) < ?8",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(now())
    .bind(page)
    .bind(message)
    .bind(&context)
    .bind(&since)
    .bind(PER_DAY)
    .execute(&st.pool)
    .await?;
    if added.rows_affected() == 0 {
        return Err(AppError::TooManyRequests { message: format!("that's {PER_DAY} reports today; thank you, try again tomorrow"), retry_after: 3600 });
    }
    tracing::info!(account = %user.id, report = %id, "bug reported");
    Ok((StatusCode::CREATED, Json(Created { id })))
}

/// A path in the app ("/decks/1?tab=list"): one leading slash, no scheme or host, no control
/// characters. The admin page links to it, so it must never lead off the site.
pub fn is_app_path(page: &str) -> bool {
    page.starts_with('/') && !page.starts_with("//") && !page.contains('\\') && page.chars().count() <= MAX_PAGE && !page.chars().any(char::is_control)
}

fn text(v: Option<&serde_json::Value>, max: usize) -> Option<serde_json::Value> {
    let t = v?.as_str()?.trim();
    (!t.is_empty()).then(|| serde_json::Value::String(t.chars().take(max).collect()))
}

fn number(v: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let n = v?.as_f64()?;
    n.is_finite().then(|| serde_json::json!((n * 100.0).round() / 100.0))
}

fn texts(v: Option<&serde_json::Value>, max_items: usize, max: usize) -> serde_json::Value {
    let items = v.and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|i| text(Some(i), max)).take(max_items).collect()).unwrap_or_default();
    serde_json::Value::Array(items)
}

/// Keeps what the report button sends, typed and cut to size, and drops anything else, so the
/// admin page can trust every field it shows.
fn clean_context(ctx: &serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    let mut put = |k: &str, v: Option<serde_json::Value>| {
        if let Some(v) = v {
            out.insert(k.into(), v);
        }
    };
    put("dialog", text(ctx.get("dialog"), 200));
    put("heading", text(ctx.get("heading"), 200));
    put("build", text(ctx.get("build"), 64));
    put("agent", text(ctx.get("agent"), 400));
    if let Some(vp) = ctx.get("viewport").and_then(|v| v.as_object())
        && let (Some(w), Some(h)) = (number(vp.get("w")), number(vp.get("h")))
    {
        let dpr = number(vp.get("dpr")).unwrap_or(serde_json::json!(1));
        put("viewport", Some(serde_json::json!({ "w": w, "h": h, "dpr": dpr })));
    }
    if let Some(sel) = ctx.get("selection").and_then(|v| v.as_object())
        && let (Some(x), Some(y), Some(w), Some(h)) = (number(sel.get("x")), number(sel.get("y")), number(sel.get("w")), number(sel.get("h")))
    {
        let mut s = serde_json::json!({ "x": x, "y": y, "w": w, "h": h,
            "controls": texts(sel.get("controls"), 20, 120), "images": texts(sel.get("images"), 20, 120) });
        if let Some(t) = text(sel.get("text"), 2000) {
            s["text"] = t;
        }
        if let Some(p) = text(sel.get("path"), 400) {
            s["path"] = p;
        }
        put("selection", Some(s));
    }
    serde_json::Value::Object(out)
}

#[derive(Deserialize)]
struct ListQuery {
    /// `resolved` lists the resolved ones; anything else, the open ones.
    #[serde(default)]
    show: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
struct ReportRow {
    id: String,
    created_at: String,
    page: String,
    message: String,
    #[sqlx(json)]
    context: serde_json::Value,
    resolved_at: Option<String>,
    reporter_id: String,
    reporter_email: String,
    reporter_name: String,
}

#[derive(Serialize)]
struct ReportList {
    reports: Vec<ReportRow>,
    open: i64,
    resolved: i64,
}

/// The newest 200 reports, open or resolved, with how many there are of each.
async fn list(State(st): State<AppState>, AdminUser(_): AdminUser, Query(q): Query<ListQuery>) -> AppResult<Json<ReportList>> {
    let resolved = q.show.as_deref() == Some("resolved");
    let filter = if resolved { "b.resolved_at IS NOT NULL" } else { "b.resolved_at IS NULL" };
    let reports: Vec<ReportRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT b.id, b.created_at, b.page, b.message, b.context, b.resolved_at,
                u.id AS reporter_id, u.email AS reporter_email, u.display_name AS reporter_name
           FROM bug_reports b JOIN users u ON u.id = b.owner_id
          WHERE {filter}
          ORDER BY b.created_at DESC LIMIT 200"
    )))
    .fetch_all(&st.pool)
    .await?;
    let (open, done): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(resolved_at IS NULL), 0), COALESCE(SUM(resolved_at IS NOT NULL), 0) FROM bug_reports",
    )
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(ReportList { reports, open, resolved: done }))
}

#[derive(Deserialize)]
struct SetResolved {
    resolved: bool,
}

async fn set_resolved(State(st): State<AppState>, AdminUser(_): AdminUser, Path(id): Path<String>, Json(body): Json<SetResolved>) -> AppResult<StatusCode> {
    let at = body.resolved.then(now);
    let done = sqlx::query("UPDATE bug_reports SET resolved_at = ? WHERE id = ?").bind(at).bind(&id).execute(&st.pool).await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("bug report"));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn remove(State(st): State<AppState>, AdminUser(_): AdminUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    let done = sqlx::query("DELETE FROM bug_reports WHERE id = ?").bind(&id).execute(&st.pool).await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("bug report"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use crate::testutil::{app, send, user};
    use axum::http::{Method, StatusCode};
    use serde_json::json;

    async fn admin(pool: &sqlx::SqlitePool) -> String {
        let (id, token) = user(pool, "admin@example.com").await;
        sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&id).execute(pool).await.unwrap();
        token
    }

    #[tokio::test]
    async fn a_report_reaches_admins_and_no_one_else() {
        let (app, pool) = app().await;
        let (_, alice) = user(&pool, "alice@example.com").await;
        let (_, bob) = user(&pool, "bob@example.com").await;
        let boss = admin(&pool).await;

        let (status, _) = send(&app, Method::POST, "/api/bug-reports", None, Some(json!({ "message": "x", "page": "/" }))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let ctx = json!({ "dialog": "Add cards", "selection": { "x": 1, "y": 2, "w": 30, "h": 40, "text": "Sol Ring" } });
        let (status, body) =
            send(&app, Method::POST, "/api/bug-reports", Some(&alice), Some(json!({ "message": "  Total is wrong ", "page": "/decks/1", "context": ctx }))).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let id = body["id"].as_str().unwrap().to_string();

        // Not for other people, admin routes or not.
        let (status, _) = send(&app, Method::GET, "/api/admin/bug-reports", Some(&bob), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&app, Method::PATCH, &format!("/api/admin/bug-reports/{id}"), Some(&bob), Some(json!({ "resolved": true }))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, list) = send(&app, Method::GET, "/api/admin/bug-reports", Some(&boss), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list["open"], 1);
        let r = &list["reports"][0];
        assert_eq!(r["message"], "Total is wrong");
        assert_eq!(r["page"], "/decks/1");
        assert_eq!(r["reporter_email"], "alice@example.com");
        assert_eq!(r["context"]["selection"]["text"], "Sol Ring");

        let (status, _) = send(&app, Method::PATCH, &format!("/api/admin/bug-reports/{id}"), Some(&boss), Some(json!({ "resolved": true }))).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (_, list) = send(&app, Method::GET, "/api/admin/bug-reports", Some(&boss), None).await;
        assert_eq!(list["reports"].as_array().unwrap().len(), 0);
        assert_eq!(list["resolved"], 1);
        let (_, list) = send(&app, Method::GET, "/api/admin/bug-reports?show=resolved", Some(&boss), None).await;
        assert_eq!(list["reports"][0]["id"], id.as_str());

        let (status, _) = send(&app, Method::DELETE, &format!("/api/admin/bug-reports/{id}"), Some(&boss), None).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let (status, _) = send(&app, Method::DELETE, &format!("/api/admin/bug-reports/{id}"), Some(&boss), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn reports_are_checked_and_limited() {
        let (app, pool) = app().await;
        let (_, alice) = user(&pool, "alice@example.com").await;
        let post = |body: serde_json::Value| {
            let app = app.clone();
            let alice = alice.clone();
            async move { send(&app, Method::POST, "/api/bug-reports", Some(&alice), Some(body)).await.0 }
        };
        assert_eq!(post(json!({ "message": "   ", "page": "/" })).await, StatusCode::BAD_REQUEST);
        assert_eq!(post(json!({ "message": "a".repeat(super::MAX_MESSAGE + 1), "page": "/" })).await, StatusCode::BAD_REQUEST);
        assert_eq!(post(json!({ "message": "a", "page": "/", "context": [1] })).await, StatusCode::BAD_REQUEST);
        for page in ["https://evil.example/admin", "//evil.example", "", "decks", "/a\nb", "/\\evil.example"] {
            assert_eq!(post(json!({ "message": "a", "page": page })).await, StatusCode::BAD_REQUEST, "{page:?}");
        }
        // Unknown fields are dropped, so a big one doesn't count against the size.
        assert_eq!(post(json!({ "message": "a", "page": "/", "context": { "t": "x".repeat(super::MAX_CONTEXT) } })).await, StatusCode::CREATED);
        // The cleaned context keeps typed fields only, so the admin page can trust them.
        assert_eq!(
            super::clean_context(json!({ "agent": {}, "x": 1, "dialog": " Add ", "viewport": { "w": 390, "h": "tall" },
                "selection": { "x": 1, "y": 2, "w": 3, "h": 4, "images": "Sol Ring", "controls": ["button: Add", 7], "text": ["no"] } })
                .as_object().unwrap()),
            json!({ "dialog": "Add", "selection": { "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0, "controls": ["button: Add"], "images": [] } })
        );
        for _ in 0..super::PER_DAY - 1 {
            assert_eq!(post(json!({ "message": "a", "page": "/" })).await, StatusCode::CREATED);
        }
        assert_eq!(post(json!({ "message": "a", "page": "/" })).await, StatusCode::TOO_MANY_REQUESTS);
    }
}
