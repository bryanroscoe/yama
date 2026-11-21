//! The scanner speed test (docs/scanner.md, "Speed test").
//!
//! Bryan, 21 Nov 2026: the scanner should be as fast as CardVision, and "It should work on any phone
//! but mostly [care] about the Pixel one for now". Every speed number so far came from Chrome on a
//! laptop (scanner-lab/speed/). "Test scanner speed" in Scan settings times the scanner on the
//! device itself, with a few cards' pictures in place of the camera (web/src/scanner/speed.ts), and
//! sends the result here, only when the person presses the button: per model choice (the device's,
//! the defaults, the faster options) the median and 90th percentile of a card finder pass, the art
//! embedding, the search and a whole frame, the warm-up, the printing look, and the browser (user
//! agent, cores, memory, threads, WebGPU).
//!
//! Owner-only: every query binds the owner, nothing is shared or shown to an admin, and an admin's
//! View as can't read them (view_as.rs `HIDDEN`). The newest [`KEEP`] per account; the owner can
//! delete them (`DELETE /api/scan/speed-tests`), and they go with the account (admin/delete.rs).
//! Read through `GET /api/scan/speed-tests` and the MCP tool `get_scan_speed_tests`.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::extract::{DefaultBodyLimit, FromRequest, Query, Request, State};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;

/// Tests kept per account; a new one past this drops the oldest.
pub const KEEP: i64 = 50;
/// Longest report (JSON) accepted: a test is about 10 KB.
const MAX_REPORT: usize = 64 * 1024;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/scan/speed-tests", post(add).get(get_route).delete(delete_route).layer(DefaultBodyLimit::max(MAX_REPORT + 1024)))
}

/// A whole number of milliseconds within reason (an hour), to a tenth, else nothing.
fn millis(v: Option<&Value>) -> Option<f64> {
    v?.as_f64().filter(|n| n.is_finite() && (0.0..=3_600_000.0).contains(n)).map(|n| (n * 10.0).round() / 10.0)
}

/// The median tracked frame of the configuration standing for `role` ("yours", "faster").
fn frame_of(report: &Value, role: &str) -> Option<f64> {
    let configs = report.get("configs")?.as_array()?;
    let c = configs.iter().find(|c| c.get("roles").and_then(Value::as_array).is_some_and(|r| r.iter().any(|x| x.as_str() == Some(role))))?;
    millis(c.pointer("/stats/tracked/median"))
}

async fn add(State(st): State<AppState>, CurrentUser(user): CurrentUser, req: Request) -> AppResult<axum::response::Response> {
    st.limits.scan_speed_tests.check_user(&user)?;
    let Json(report) = match Json::<Value>::from_request(req, &st).await {
        Ok(json) => json,
        // Axum's own answer: 413 for too large, 400/415/422 for the rest.
        Err(rejection) => return Ok(rejection.into_response()),
    };
    if !report.is_object() {
        return Err(AppError::bad("a speed test is a JSON object"));
    }
    if !report.get("configs").is_some_and(Value::is_array) {
        return Err(AppError::bad("a speed test lists its configs"));
    }
    let text = report.to_string();
    if text.len() > MAX_REPORT {
        return Err(AppError::bad("the speed test is too long"));
    }
    let device = report.get("device").and_then(Value::as_str).map(|s| s.trim().chars().take(120).collect::<String>()).filter(|s| !s.is_empty()).unwrap_or_else(|| "Unknown device".into());
    let id = crate::util::new_id();
    let bytes = (text.len() + device.len() + 64) as i64;
    let mut tx = st.pool.begin().await?;
    sqlx::query("INSERT INTO scan_speed_tests (id, owner_id, created_at, device, frame_ms, fast_ms, report, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&user.id)
        .bind(crate::util::now())
        .bind(&device)
        .bind(frame_of(&report, "yours"))
        .bind(frame_of(&report, "faster"))
        .bind(&text)
        .bind(bytes)
        .execute(&mut *tx)
        .await?;
    // Keep the newest KEEP.
    sqlx::query(
        "DELETE FROM scan_speed_tests WHERE owner_id = ?1 AND id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC, rowid DESC) AS n FROM scan_speed_tests WHERE owner_id = ?1)
           WHERE n > ?2)",
    )
    .bind(&user.id)
    .bind(KEEP)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id })).into_response())
}

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    created_at: String,
    device: String,
    frame_ms: Option<f64>,
    fast_ms: Option<f64>,
    report: String,
}

/// Each configuration's per-frame times out of a report (most of its size), for a shorter answer.
fn without_frames(mut report: Value) -> Value {
    if let Some(configs) = report.get_mut("configs").and_then(Value::as_array_mut) {
        for c in configs {
            if let Some(c) = c.as_object_mut() {
                c.remove("frames");
            }
        }
    }
    report
}

/// The account's speed tests, newest first, from `offset`: each with its device, the headline frame
/// times and the report, with each configuration's per-frame times only when `frames` is set.
pub async fn list(pool: &SqlitePool, owner: &str, offset: usize, limit: usize, frames: bool) -> AppResult<Value> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_speed_tests WHERE owner_id = ?").bind(owner).fetch_one(pool).await?;
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT id, created_at, device, frame_ms, fast_ms, report FROM scan_speed_tests WHERE owner_id = ?
          ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
    )
    .bind(owner)
    .bind(limit as i64)
    .bind(offset as i64)
    .fetch_all(pool)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            json!({
                "id": r.id, "created_at": r.created_at, "device": r.device, "frame_ms": r.frame_ms, "fast_ms": r.fast_ms,
                "report": serde_json::from_str::<Value>(&r.report).map(|v| if frames { v } else { without_frames(v) }).unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(json!({ "count": count, "keep": KEEP, "items": items }))
}

#[derive(Deserialize)]
struct GetQuery {
    offset: Option<usize>,
    limit: Option<usize>,
    /// Each configuration's per-frame times too (false leaves them out).
    frames: Option<bool>,
}

async fn get_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(q): Query<GetQuery>) -> AppResult<Json<Value>> {
    let limit = q.limit.unwrap_or(20).clamp(0, KEEP as usize);
    Ok(Json(list(&st.pool, &user.id, q.offset.unwrap_or(0).min(1_000_000), limit, q.frames.unwrap_or(true)).await?))
}

async fn delete_route(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    let deleted = sqlx::query("DELETE FROM scan_speed_tests WHERE owner_id = ?").bind(&user.id).execute(&st.pool).await?.rows_affected();
    Ok(Json(json!({ "deleted": deleted })))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::testutil;
    use axum::http::{Method, StatusCode};

    const PATH: &str = "/api/scan/speed-tests";

    /// A report as the scanner sends one (speed.ts, `SpeedReport`), trimmed.
    pub(crate) fn report(yours: f64, faster: Option<f64>) -> Value {
        let config = |roles: &[&str], tracked: f64| {
            json!({"roles": roles, "wanted": {"detector": {"id": "bundle-detector", "label": "ManaVault's card finder"}, "art": {"id": "yama-art-20261118", "label": "Yama's art model"}},
                   "ran": {"detector": "bundle-detector", "art": "yama-art-20261118"}, "loadMs": 2100.0, "downloaded": false, "firstFrameMs": 300.0,
                   "stats": {"detector": {"median": 50.0, "p90": 60.0, "n": 40}, "tracked": {"median": tracked, "p90": tracked + 20.0, "n": 21}, "fresh": {"median": tracked + 50.0, "p90": tracked + 80.0, "n": 7}},
                   "found": 32, "right": 32, "frames": [{"card": 0, "frame": 0, "fresh": true, "roundMs": 200.0}], "error": null})
        };
        let mut configs = vec![config(&["yours", "defaults"], yours)];
        if let Some(f) = faster {
            configs.push(config(&["faster"], f));
        }
        json!({"version": 1, "startedAt": "2026-11-21T10:00:00Z", "ms": 41000, "bundle": "gallery-20261106", "device": "Pixel 10 Pro, Android 16, Chrome 142",
               "env": {"userAgent": "Mozilla/5.0 (Linux; Android 10; K)", "cores": 8, "memory": 8, "isolated": false, "webgpu": {"api": true, "adapter": true, "vendor": "imagination", "f16": true}},
               "configs": configs, "look": {"option": "look-v1", "picture": {"median": 70.0, "p90": 90.0, "n": 7}}})
    }

    #[tokio::test]
    async fn kept_for_the_owner_only_newest_first_and_deleted_by_them() {
        let (app, pool) = testutil::app().await;
        let (_, mine) = testutil::user(&pool, "me@example.com").await;
        let (_, theirs) = testutil::user(&pool, "them@example.com").await;
        let (status, made) = testutil::send(&app, Method::POST, PATH, Some(&mine), Some(report(142.4, Some(48.06)))).await;
        assert_eq!(status, StatusCode::OK, "{made}");
        let (status, _) = testutil::send(&app, Method::POST, PATH, Some(&mine), Some(report(130.0, None))).await;
        assert_eq!(status, StatusCode::OK);

        let (status, s) = testutil::send(&app, Method::GET, PATH, Some(&mine), None).await;
        assert_eq!(status, StatusCode::OK, "{s}");
        assert_eq!(s["count"], 2);
        assert_eq!(s["keep"], KEEP);
        let items = s["items"].as_array().unwrap();
        assert_eq!(items[0]["frame_ms"], 130.0, "newest first");
        assert_eq!(items[0]["fast_ms"], Value::Null);
        assert_eq!(items[1]["id"], made["id"]);
        assert_eq!(items[1]["frame_ms"], 142.4);
        assert_eq!(items[1]["fast_ms"], 48.1);
        assert_eq!(items[1]["device"], "Pixel 10 Pro, Android 16, Chrome 142");
        assert_eq!(items[1]["report"]["env"]["webgpu"]["vendor"], "imagination");
        assert_eq!(items[1]["report"]["look"]["option"], "look-v1");
        assert_eq!(items[1]["report"]["configs"][0]["frames"][0]["roundMs"], 200.0);
        // Without the per-frame times, when asked.
        let (_, s) = testutil::send(&app, Method::GET, &format!("{PATH}?frames=false"), Some(&mine), None).await;
        assert!(s["items"][1]["report"]["configs"][0].get("frames").is_none(), "{s}");
        assert_eq!(s["items"][1]["report"]["configs"][0]["stats"]["tracked"]["median"], 142.4);

        // Someone else sees none of them, and their delete deletes none.
        let (_, s) = testutil::send(&app, Method::GET, PATH, Some(&theirs), None).await;
        assert_eq!(s["count"], 0);
        assert_eq!(s["items"], json!([]));
        let (_, d) = testutil::send(&app, Method::DELETE, PATH, Some(&theirs), None).await;
        assert_eq!(d["deleted"], 0);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_speed_tests").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 2);

        // Paged.
        let (_, s) = testutil::send(&app, Method::GET, &format!("{PATH}?limit=1&offset=1"), Some(&mine), None).await;
        assert_eq!(s["items"].as_array().unwrap().len(), 1);
        assert_eq!(s["items"][0]["frame_ms"], 142.4);

        // The owner deletes theirs.
        let (_, d) = testutil::send(&app, Method::DELETE, PATH, Some(&mine), None).await;
        assert_eq!(d["deleted"], 2);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_speed_tests").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0);
        let (status, _) = testutil::send(&app, Method::GET, PATH, None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = testutil::send(&app, Method::POST, PATH, None, Some(report(1.0, None))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn refuses_what_isnt_a_report_and_keeps_the_newest_fifty() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        let (them, _) = testutil::user(&pool, "them@example.com").await;
        let post = |b: Value| {
            let app = app.clone();
            let token = token.clone();
            async move { testutil::send(&app, Method::POST, PATH, Some(&token), Some(b)).await.0 }
        };
        assert_eq!(post(json!([1, 2])).await, StatusCode::BAD_REQUEST);
        assert_eq!(post(json!({"device": "x"})).await, StatusCode::BAD_REQUEST);
        let mut long = report(100.0, None);
        long["padding"] = json!("y".repeat(MAX_REPORT));
        assert!(post(long).await.is_client_error());
        // A clock gone wrong keeps the test without its headline time.
        assert_eq!(post(report(-5.0, Some(f64::MAX))).await, StatusCode::OK);
        let (frame, fast): (Option<f64>, Option<f64>) = sqlx::query_as("SELECT frame_ms, fast_ms FROM scan_speed_tests").fetch_one(&pool).await.unwrap();
        assert_eq!((frame, fast), (None, None));
        // A device name is kept short, and a report without one says so.
        let mut nameless = report(100.0, None);
        nameless.as_object_mut().unwrap().remove("device");
        assert_eq!(post(nameless).await, StatusCode::OK);
        let device: String = sqlx::query_scalar("SELECT device FROM scan_speed_tests ORDER BY rowid DESC LIMIT 1").fetch_one(&pool).await.unwrap();
        assert_eq!(device, "Unknown device");

        // The cap: KEEP of mine (the oldest go), and another account's untouched.
        sqlx::query("DELETE FROM scan_speed_tests").execute(&pool).await.unwrap();
        for i in 0..KEEP {
            sqlx::query("INSERT INTO scan_speed_tests (id, owner_id, created_at, device, report, bytes) VALUES (?, ?, '2026-01-01T00:00:00Z', 'old', '{}', 2)")
                .bind(format!("old{i}"))
                .bind(&me)
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO scan_speed_tests (id, owner_id, created_at, device, report, bytes) VALUES ('theirs', ?, '2026-01-01T00:00:00Z', 'old', '{}', 2)")
            .bind(&them)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(post(report(90.0, None)).await, StatusCode::OK);
        let mine: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_speed_tests WHERE owner_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(mine, KEEP);
        let newest: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_speed_tests WHERE owner_id = ? AND frame_ms = 90.0").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(newest, 1);
        let theirs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_speed_tests WHERE id = 'theirs'").fetch_one(&pool).await.unwrap();
        assert_eq!(theirs, 1);
    }

    #[tokio::test]
    async fn go_with_the_account() {
        let (app, pool) = testutil::app().await;
        let (pat, token) = testutil::user(&pool, "pat@example.com").await;
        let (status, _) = testutil::send(&app, Method::POST, PATH, Some(&token), Some(report(140.0, None))).await;
        assert_eq!(status, StatusCode::OK);
        let (status, r) = testutil::send(&app, Method::DELETE, "/api/me", Some(&token), Some(json!({"confirm_email": "pat@example.com"}))).await;
        assert_eq!(status, StatusCode::OK, "{r}");
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_speed_tests WHERE owner_id = ?").bind(&pat).fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 0);
    }
}
