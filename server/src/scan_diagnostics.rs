//! Scanner diagnostics (docs/scanner.md, "Scanner diagnostics").
//!
//! With "Scanner diagnostics" on (Scan settings, per device, off by default), the scanner sends a
//! record for each card it struggled with (the printing list used, Wrong card or Wrong printing, a
//! read that gave up, the close-up taking over, a title overruling the art): the card's bottom strip
//! at the camera's full resolution (both collector corners, warped upright: what a replay reads),
//! a 640 px photo of the card, and as JSON every frame's reads per crop, the evidence, the art's
//! matches, the title reads, the camera and what it delivered, and how it ended.
//!
//! Owner-only: every query binds the owner, nothing here is shared with an admin or sent anywhere.
//! The images are files under the data directory (`scan-diagnostics/<owner>/<id>/<name>.jpg`), out
//! of the main database; the row lists them. An account keeps at most [`KEEP`] records and
//! [`KEEP_BYTES`] of images (oldest go first), uploads are rate limited, and they're deleted on
//! request (one, or all) and with the account (admin/delete.rs). The owner reads them here and
//! through the MCP tools `list_scan_diagnostics` and `get_scan_diagnostic`.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::path::{Path as FsPath, PathBuf};

/// Most records kept per account; a new one past this drops the oldest.
pub const KEEP: i64 = 200;
/// Most bytes of images kept per account; past it the oldest go.
pub const KEEP_BYTES: i64 = 200 * 1024 * 1024;
/// Largest image accepted: a full-resolution bottom strip of a large card in view.
pub const MAX_IMAGE: usize = 1536 * 1024;
/// Most images in one record, and their total.
pub const MAX_IMAGES: usize = 8;
pub const MAX_TOTAL: usize = 4 * 1024 * 1024;
/// Longest `detail` (JSON) and `camera` (JSON) accepted.
const MAX_DETAIL: usize = 256 * 1024;
const MAX_CAMERA: usize = 8 * 1024;
const MAX_TEXT: usize = 200;
/// How a record may end.
pub const OUTCOMES: [&str; 5] = ["filed", "picked", "wrong", "skipped", "left"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/scan/diagnostics",
            post(add).get(list_route).delete(delete_all).layer(DefaultBodyLimit::max(MAX_TOTAL * 4 / 3 + MAX_DETAIL + 64 * 1024)),
        )
        .route("/api/scan/diagnostics/{id}", get(get_route).delete(delete_one))
        .route("/api/scan/diagnostics/{id}/images/{name}", get(image_route))
}

/// The folder an account's records live in.
pub fn owner_dir(data_dir: &FsPath, owner: &str) -> PathBuf {
    data_dir.join("scan-diagnostics").join(owner)
}

/// Remove every file an account kept (after its rows are gone). Never fails the caller.
pub fn remove_owner_files(data_dir: &FsPath, owner: &str) {
    let dir = owner_dir(data_dir, owner);
    if let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("couldn't remove scanner diagnostics in {}: {e}", dir.display());
    }
}

fn remove_record_files(data_dir: &FsPath, owner: &str, id: &str) {
    let dir = owner_dir(data_dir, owner).join(id);
    if let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("couldn't remove scanner diagnostic {}: {e}", dir.display());
    }
}

#[derive(Deserialize)]
struct NewImage {
    name: String,
    /// A base64 JPEG.
    image: String,
    width: Option<i64>,
    height: Option<i64>,
}

#[derive(Deserialize)]
struct NewDiagnostic {
    outcome: String,
    card_name: Option<String>,
    engine: Option<String>,
    camera: Option<Value>,
    detail: Value,
    #[serde(default)]
    images: Vec<NewImage>,
}

fn text(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().chars().take(MAX_TEXT).collect::<String>()).filter(|s| !s.is_empty())
}

/// Image names are short, lower-case and plain: "strip", "card".
pub fn valid_name(name: &str) -> bool {
    (1..=40).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Record ids are the server's own UUIDs; anything else isn't one (and never reaches a path).
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

async fn add(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(d): Json<NewDiagnostic>) -> AppResult<Json<Value>> {
    st.limits.scan_diagnostics.check_user(&user)?;
    if !OUTCOMES.contains(&d.outcome.as_str()) {
        return Err(AppError::bad(format!("outcome is one of {}", OUTCOMES.join(", "))));
    }
    if !d.detail.is_object() {
        return Err(AppError::bad("detail is a JSON object"));
    }
    let detail = d.detail.to_string();
    if detail.len() > MAX_DETAIL {
        return Err(AppError::bad("detail is too long"));
    }
    let camera = match d.camera {
        None | Some(Value::Null) => None,
        Some(c) if c.is_object() => {
            let c = c.to_string();
            if c.len() > MAX_CAMERA {
                return Err(AppError::bad("camera is too long"));
            }
            Some(c)
        }
        Some(_) => return Err(AppError::bad("camera is a JSON object")),
    };
    if d.images.len() > MAX_IMAGES {
        return Err(AppError::bad(format!("at most {MAX_IMAGES} images")));
    }
    let mut images: Vec<(String, Vec<u8>, Option<i64>, Option<i64>)> = Vec::with_capacity(d.images.len());
    let mut total = 0usize;
    for i in d.images {
        if !valid_name(&i.name) || images.iter().any(|(n, ..)| n == &i.name) {
            return Err(AppError::bad("image names are short, lower case, and different"));
        }
        let bytes = base64::engine::general_purpose::STANDARD.decode(i.image.trim()).map_err(|_| AppError::bad("image isn't base64"))?;
        if bytes.len() > MAX_IMAGE {
            return Err(AppError::bad("image is too large"));
        }
        if !bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return Err(AppError::bad("image isn't a JPEG"));
        }
        total += bytes.len();
        let dim = |v: Option<i64>| v.filter(|n| (1..=20_000).contains(n));
        images.push((i.name, bytes, dim(i.width), dim(i.height)));
    }
    if total > MAX_TOTAL {
        return Err(AppError::bad("images are too large together"));
    }
    let id = crate::util::new_id();
    let listed: Vec<Value> = images.iter().map(|(n, b, w, h)| json!({"name": n, "width": w, "height": h, "bytes": b.len()})).collect();
    // The files first, under a folder of their own; the row only once they're all written.
    let dir = owner_dir(&st.cfg.data_dir, &user.id).join(&id);
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        for (name, bytes, ..) in &images {
            std::fs::write(dir.join(format!("{name}.jpg")), bytes)?;
        }
        Ok(())
    };
    if let Err(e) = write() {
        remove_record_files(&st.cfg.data_dir, &user.id, &id);
        return Err(anyhow::Error::from(e).context("writing scanner diagnostic images").into());
    }
    let saved = async {
        let mut tx = st.pool.begin().await?;
        sqlx::query(
            "INSERT INTO scan_diagnostics (id, owner_id, created_at, outcome, card_name, engine, camera, detail, bundle, images, bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(&user.id)
        .bind(crate::util::now())
        .bind(&d.outcome)
        .bind(text(d.card_name))
        .bind(text(d.engine))
        .bind(camera)
        .bind(detail)
        .bind(crate::scan::BUNDLE_VERSION)
        .bind(Value::Array(listed).to_string())
        .bind(total as i64)
        .execute(&mut *tx)
        .await?;
        // Keep the newest KEEP, and no more than KEEP_BYTES of them.
        let gone: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER w AS n, SUM(bytes) OVER w AS running
                 FROM scan_diagnostics WHERE owner_id = ?1
               WINDOW w AS (ORDER BY created_at DESC, rowid DESC ROWS UNBOUNDED PRECEDING))
             WHERE n > ?2 OR running > ?3",
        )
        .bind(&user.id)
        .bind(KEEP)
        .bind(KEEP_BYTES)
        .fetch_all(&mut *tx)
        .await?;
        for old in &gone {
            sqlx::query("DELETE FROM scan_diagnostics WHERE owner_id = ? AND id = ?").bind(&user.id).bind(old).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        AppResult::Ok(gone)
    }
    .await;
    match saved {
        Ok(gone) => {
            for old in gone {
                remove_record_files(&st.cfg.data_dir, &user.id, &old);
            }
            Ok(Json(json!({ "id": id })))
        }
        Err(e) => {
            remove_record_files(&st.cfg.data_dir, &user.id, &id);
            Err(e)
        }
    }
}

/// The URL an image is read at, for the owner.
pub fn image_url(id: &str, name: &str) -> String {
    format!("/api/scan/diagnostics/{id}/images/{name}")
}

/// How many records the account has, their size, and a page of them, newest first.
pub async fn list(pool: &SqlitePool, owner: &str, offset: i64, limit: i64) -> AppResult<Value> {
    let (count, bytes): (i64, Option<i64>) =
        sqlx::query_as("SELECT COUNT(*), SUM(bytes) FROM scan_diagnostics WHERE owner_id = ?").bind(owner).fetch_one(pool).await?;
    let rows: Vec<(String, String, String, Option<String>, Option<String>, String, String, i64)> = sqlx::query_as(
        "SELECT id, created_at, outcome, card_name, engine, detail, images, bytes FROM scan_diagnostics
          WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?",
    )
    .bind(owner)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    let items: Vec<Value> = rows
        .into_iter()
        .map(|(id, created_at, outcome, card_name, engine, detail, images, bytes)| {
            let detail: Value = serde_json::from_str(&detail).unwrap_or(Value::Null);
            let names: Vec<Value> = serde_json::from_str::<Vec<Value>>(&images).unwrap_or_default().into_iter().filter_map(|i| i.get("name").cloned()).collect();
            json!({
                "id": id, "created_at": created_at, "outcome": outcome, "card_name": card_name, "engine": engine,
                "reasons": detail.get("reasons").cloned().unwrap_or(Value::Null),
                "chosen": detail.get("final").cloned().unwrap_or(Value::Null),
                "bytes": bytes, "images": names,
            })
        })
        .collect();
    Ok(json!({ "count": count, "bytes": bytes.unwrap_or(0), "keep": KEEP, "keep_bytes": KEEP_BYTES, "items": items }))
}

/// One record in full (without image bytes), or None when it isn't this account's.
pub async fn one(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<Option<Value>> {
    let row: Option<(String, String, Option<String>, Option<String>, Option<String>, String, Option<String>, String, i64)> = sqlx::query_as(
        "SELECT created_at, outcome, card_name, engine, camera, detail, bundle, images, bytes FROM scan_diagnostics WHERE owner_id = ? AND id = ?",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let Some((created_at, outcome, card_name, engine, camera, detail, bundle, images, bytes)) = row else { return Ok(None) };
    let parse = |s: Option<String>| s.and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
    let images: Vec<Value> = serde_json::from_str::<Vec<Value>>(&images)
        .unwrap_or_default()
        .into_iter()
        .map(|mut i| {
            if let Some(name) = i.get("name").and_then(Value::as_str).map(str::to_owned) {
                i["url"] = json!(image_url(id, &name));
            }
            i
        })
        .collect();
    Ok(Some(json!({
        "id": id, "created_at": created_at, "outcome": outcome, "card_name": card_name, "engine": engine,
        "camera": parse(camera), "detail": parse(Some(detail)), "bundle": bundle, "bytes": bytes, "images": images,
    })))
}

/// One image's JPEG bytes, or None when it isn't this account's (or isn't one of the record's).
pub async fn image(pool: &SqlitePool, data_dir: &FsPath, owner: &str, id: &str, name: &str) -> AppResult<Option<Vec<u8>>> {
    if !valid_id(id) || !valid_name(name) {
        return Ok(None);
    }
    let images: Option<String> = sqlx::query_scalar("SELECT images FROM scan_diagnostics WHERE owner_id = ? AND id = ?").bind(owner).bind(id).fetch_optional(pool).await?;
    let Some(images) = images else { return Ok(None) };
    let listed = serde_json::from_str::<Vec<Value>>(&images).unwrap_or_default().iter().any(|i| i.get("name").and_then(Value::as_str) == Some(name));
    if !listed {
        return Ok(None);
    }
    match std::fs::read(owner_dir(data_dir, owner).join(id).join(format!("{name}.jpg"))) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::Error::from(e).context("reading a scanner diagnostic image").into()),
    }
}

#[derive(Deserialize)]
struct ListQuery {
    offset: Option<i64>,
    limit: Option<i64>,
}

async fn list_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(q): Query<ListQuery>) -> AppResult<Json<Value>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).clamp(0, 1_000_000);
    Ok(Json(list(&st.pool, &user.id, offset, limit).await?))
}

async fn get_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Value>> {
    one(&st.pool, &user.id, &id).await?.map(Json).ok_or(AppError::NotFound("scan diagnostic"))
}

async fn image_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path((id, name)): Path<(String, String)>) -> AppResult<impl IntoResponse> {
    let name = name.strip_suffix(".jpg").unwrap_or(&name).to_string();
    let bytes = image(&st.pool, &st.cfg.data_dir, &user.id, &id, &name).await?.ok_or(AppError::NotFound("scan diagnostic image"))?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, no-store")], bytes))
}

async fn delete_one(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let gone = sqlx::query("DELETE FROM scan_diagnostics WHERE owner_id = ? AND id = ?").bind(&user.id).bind(&id).execute(&st.pool).await?.rows_affected();
    if gone > 0 && valid_id(&id) {
        remove_record_files(&st.cfg.data_dir, &user.id, &id);
    }
    Ok(Json(json!({ "deleted": gone })))
}

async fn delete_all(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    let gone = sqlx::query("DELETE FROM scan_diagnostics WHERE owner_id = ?").bind(&user.id).execute(&st.pool).await?.rows_affected();
    remove_owner_files(&st.cfg.data_dir, &user.id);
    Ok(Json(json!({ "deleted": gone })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use tower::ServiceExt;

    pub(crate) const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 2, 3, 0xFF, 0xD9];

    pub(crate) fn body(outcome: &str) -> Value {
        let b64 = base64::engine::general_purpose::STANDARD.encode(JPEG);
        json!({
            "outcome": outcome,
            "card_name": "Westvale Abbey // Ormendahl, Profane Prince",
            "engine": "mlkit",
            "camera": {"label": "camera2 0, facing back", "width": 2160, "height": 3840, "zoom": 1},
            "detail": {"reasons": ["picked"], "final": {"set": "soi", "number": "281", "how": "picked"}, "frames": [{"t": 0, "reads": [{"crop": "edges", "text": "281/297 R"}]}]},
            "images": [
                {"name": "strip", "image": b64, "width": 2400, "height": 460},
                {"name": "card", "image": b64, "width": 458, "height": 640},
            ],
        })
    }

    async fn get_bytes(app: &axum::Router, uri: &str, token: &str) -> (StatusCode, Vec<u8>, Option<String>) {
        let req = Request::builder().method(Method::GET).uri(uri).header(header::AUTHORIZATION, format!("Bearer {token}")).body(Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let kind = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap().to_vec();
        (status, bytes, kind)
    }

    fn files(owner: &str) -> usize {
        let dir = owner_dir(&std::env::temp_dir(), owner);
        walk(&dir)
    }
    fn walk(dir: &FsPath) -> usize {
        std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| if e.path().is_dir() { walk(&e.path()) } else { 1 }).sum()).unwrap_or(0)
    }

    #[tokio::test]
    async fn kept_as_files_readable_by_the_owner_only_and_deleted_on_request() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let (them_id, theirs) = testutil::user(&pool, "them@example.com").await;

        let (status, made) = testutil::send(&app, Method::POST, "/api/scan/diagnostics", Some(&mine), Some(body("picked"))).await;
        assert_eq!(status, StatusCode::OK, "{made}");
        let id = made["id"].as_str().unwrap().to_string();
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/diagnostics", Some(&mine), Some(body("wrong"))).await;
        assert_eq!(status, StatusCode::OK);
        // The images are files, not database rows.
        assert_eq!(files(&me), 4);
        let stored: String = sqlx::query_scalar("SELECT images FROM scan_diagnostics WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
        assert!(stored.contains("\"strip\""), "{stored}");

        let (_, l) = testutil::send(&app, Method::GET, "/api/scan/diagnostics", Some(&mine), None).await;
        assert_eq!(l["count"], 2);
        assert_eq!(l["bytes"], 4 * JPEG.len() as i64);
        assert_eq!(l["items"][1]["images"], json!(["strip", "card"]));
        assert_eq!(l["items"][1]["reasons"], json!(["picked"]));

        let (status, one) = testutil::send(&app, Method::GET, &format!("/api/scan/diagnostics/{id}"), Some(&mine), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(one["camera"]["label"], "camera2 0, facing back");
        assert_eq!(one["detail"]["final"]["how"], "picked");
        assert_eq!(one["images"][0]["url"], format!("/api/scan/diagnostics/{id}/images/strip"));
        let (status, bytes, kind) = get_bytes(&app, &format!("/api/scan/diagnostics/{id}/images/strip"), &mine).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, JPEG);
        assert_eq!(kind.as_deref(), Some("image/jpeg"));

        // Someone else sees none of it, can't read one by id or its images, and can't delete it.
        let (_, l) = testutil::send(&app, Method::GET, "/api/scan/diagnostics", Some(&theirs), None).await;
        assert_eq!(l["count"], 0);
        let (status, _) = testutil::send(&app, Method::GET, &format!("/api/scan/diagnostics/{id}"), Some(&theirs), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _, _) = get_bytes(&app, &format!("/api/scan/diagnostics/{id}/images/strip"), &theirs).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (_, d) = testutil::send(&app, Method::DELETE, &format!("/api/scan/diagnostics/{id}"), Some(&theirs), None).await;
        assert_eq!(d["deleted"], 0);
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/diagnostics", Some(&theirs), None).await;
        assert_eq!(d["deleted"], 0);
        assert_eq!(files(&me), 4);
        assert_eq!(files(&them_id), 0);
        // A name that isn't one of the record's, or a path, reads nothing.
        let (status, _, _) = get_bytes(&app, &format!("/api/scan/diagnostics/{id}/images/..%2F..%2Fyama"), &mine).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // One, then the rest, with their files.
        let (_, d) = testutil::send(&app, Method::DELETE, &format!("/api/scan/diagnostics/{id}"), Some(&mine), None).await;
        assert_eq!(d["deleted"], 1);
        assert_eq!(files(&me), 2);
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/diagnostics", Some(&mine), None).await;
        assert_eq!(d["deleted"], 1);
        assert_eq!(files(&me), 0);
        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/diagnostics", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn go_with_the_account_files_and_all() {
        let (app, pool) = testutil::app().await;
        let (pat, token) = testutil::user(&pool, "pat@example.com").await;
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/diagnostics", Some(&token), Some(body("picked"))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(files(&pat), 2);
        let (status, report) = testutil::send(&app, Method::DELETE, "/api/me", Some(&token), Some(json!({"confirm_email": "pat@example.com"}))).await;
        assert_eq!(status, StatusCode::OK, "{report}");
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_diagnostics WHERE owner_id = ?").bind(&pat).fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 0);
        assert_eq!(files(&pat), 0);
        assert!(!owner_dir(&std::env::temp_dir(), &pat).exists());
    }

    #[tokio::test]
    async fn refuses_what_isnt_small_jpegs_and_known_outcomes() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        let post = |b: Value| {
            let app = app.clone();
            let token = token.clone();
            async move { testutil::send(&app, Method::POST, "/api/scan/diagnostics", Some(&token), Some(b)).await.0 }
        };
        assert_eq!(post(body("maybe")).await, StatusCode::BAD_REQUEST);
        let mut b = body("filed");
        b["images"][0]["image"] = json!(base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n"));
        assert_eq!(post(b).await, StatusCode::BAD_REQUEST);
        let mut b = body("filed");
        b["images"][1]["name"] = json!("strip");
        assert_eq!(post(b).await, StatusCode::BAD_REQUEST, "two images of one name");
        let mut b = body("filed");
        b["images"][1]["name"] = json!("../etc");
        assert_eq!(post(b).await, StatusCode::BAD_REQUEST);
        let mut b = body("filed");
        b["detail"] = json!("text");
        assert_eq!(post(b).await, StatusCode::BAD_REQUEST);
        let mut big = JPEG.to_vec();
        big.resize(MAX_IMAGE + 1, 0);
        let mut b = body("filed");
        b["images"][0]["image"] = json!(base64::engine::general_purpose::STANDARD.encode(&big));
        let status = post(b).await;
        assert!(status == StatusCode::BAD_REQUEST || status == StatusCode::PAYLOAD_TOO_LARGE, "{status}");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_diagnostics").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
        assert_eq!(files(&me), 0);
    }

    #[tokio::test]
    async fn keeps_only_the_newest_within_the_caps_and_removes_their_files() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        let (them, _) = testutil::user(&pool, "them@example.com").await;
        let old = |id: String, owner: String, bytes: i64| {
            let pool = pool.clone();
            async move {
                sqlx::query("INSERT INTO scan_diagnostics (id, owner_id, created_at, outcome, detail, images, bytes) VALUES (?, ?, '2026-01-01T00:00:00Z', 'left', '{}', '[{\"name\":\"strip\"}]', ?)")
                    .bind(&id)
                    .bind(&owner)
                    .bind(bytes)
                    .execute(&pool)
                    .await
                    .unwrap();
                let dir = owner_dir(&std::env::temp_dir(), &owner).join(&id);
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(dir.join("strip.jpg"), JPEG).unwrap();
            }
        };
        for i in 0..KEEP {
            old(format!("00000000-0000-0000-0000-{i:012}"), me.clone(), 3).await;
        }
        // Someone else's are never pruned by my uploads.
        old("11111111-1111-1111-1111-111111111111".into(), them.clone(), KEEP_BYTES).await;
        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/diagnostics", Some(&token), Some(body("filed"))).await;
        assert_eq!(status, StatusCode::OK);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_diagnostics WHERE owner_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(count, KEEP);
        // The one pruned took its files with it: KEEP - 1 old ones of one file, and the new one's two.
        assert_eq!(files(&me), (KEEP as usize - 1) + 2);
        let newest: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_diagnostics WHERE id = ?").bind(res["id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
        assert_eq!(newest, 1);
        assert_eq!(files(&them), 1);

        // The byte cap: one big old record goes when a new one would pass it.
        let (_, _) = testutil::send(&app, Method::DELETE, "/api/scan/diagnostics", Some(&token), None).await;
        old("22222222-2222-2222-2222-222222222222".into(), me.clone(), KEEP_BYTES).await;
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/diagnostics", Some(&token), Some(body("filed"))).await;
        assert_eq!(status, StatusCode::OK);
        let big: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_diagnostics WHERE id = '22222222-2222-2222-2222-222222222222'").fetch_one(&pool).await.unwrap();
        assert_eq!(big, 0);
        assert_eq!(files(&me), 2);
        remove_owner_files(&std::env::temp_dir(), &me);
        remove_owner_files(&std::env::temp_dir(), &them);
    }
}
