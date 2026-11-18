//! Scan photos kept to improve the scanner (docs/scanner.md, "Scan photos").
//!
//! While "Save scan photos" is on, the scanner sends the part of the frame around a card it found,
//! with what it thought the card was and what the person said: added (confirmed), corrected (they
//! named another card or printing), or wrong (not this card, no answer). These are the labelled real
//! photos the scanner's accuracy work needs: a real eval set first, training data later.
//!
//! Kept per account: every query here binds the owner, the account keeps at most [`KEEP`] photos
//! and [`KEEP_BYTES`] (oldest go first), uploads are rate limited per account, and they're deleted
//! with the account (admin/delete.rs) or on request (`DELETE /api/scan/samples`).
//!
//! Shared with Yama's developer (Bryan, 15 Nov 2026): a photo saved by a scanner that said so
//! (`shared: true`; migration 0092) can be read by an admin (`/api/admin/scan-samples`, the admin
//! area's Scan photos page, `yama-server scan-samples-export`). Photos saved before that, when the
//! switch promised they were shown to no one, are never shown to an admin. Only the small card
//! photo is kept here; nothing else from the camera.

use crate::admin::AdminUser;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use anyhow::Context;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Most photos kept per account; a new one past this drops the oldest.
pub const KEEP: i64 = 2000;
/// Most bytes of photos kept per account (they live in the main database); past it the oldest go.
pub const KEEP_BYTES: i64 = 100 * 1024 * 1024;
/// Largest photo accepted. The scanner sends at most 640 px on the long side, about 30 to 90 kB.
const MAX_IMAGE: usize = 160 * 1024;
const MAX_TEXT: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/scan/samples",
            post(add).get(summary).delete(delete_all).layer(DefaultBodyLimit::max(MAX_IMAGE * 4 / 3 + 16 * 1024)),
        )
        .route("/api/admin/scan-samples", get(admin_list))
        .route("/api/admin/scan-samples/{id}/image", get(admin_image))
}

#[derive(Deserialize)]
struct NewSample {
    /// The photo, a base64 JPEG.
    image: String,
    kind: String,
    label_scryfall_id: Option<String>,
    label_name: Option<String>,
    guess_name: Option<String>,
    guess_scryfall_id: Option<String>,
    guess_illustration_id: Option<String>,
    method: Option<String>,
    score: Option<f64>,
    quad: Option<[[f64; 2]; 4]>,
    camera: Option<String>,
    /// The embed graph's file name the phone's art recognizer loaded (`files.embed`), if any.
    embed: Option<String>,
    /// The scanner told the person that saved photos are shared with Yama's developer.
    #[serde(default)]
    shared: bool,
}

fn text(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().chars().take(MAX_TEXT).collect::<String>()).filter(|s| !s.is_empty())
}

async fn add(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(s): Json<NewSample>) -> AppResult<Json<Value>> {
    st.limits.scan_samples.check_user(&user)?;
    if !matches!(s.kind.as_str(), "added" | "corrected" | "wrong") {
        return Err(AppError::BadRequest("kind is added, corrected or wrong".into()));
    }
    let image = base64::engine::general_purpose::STANDARD.decode(s.image.trim()).map_err(|_| AppError::BadRequest("image isn't base64".into()))?;
    if image.len() > MAX_IMAGE {
        return Err(AppError::BadRequest("image is too large".into()));
    }
    // JPEG only: it starts FF D8 FF.
    if !image.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err(AppError::BadRequest("image isn't a JPEG".into()));
    }
    let quad = match s.quad {
        Some(q) if q.iter().flatten().all(|v| v.is_finite()) => Some(serde_json::to_string(&q).map_err(anyhow::Error::from)?),
        Some(_) => return Err(AppError::BadRequest("quad isn't four points".into())),
        None => None,
    };
    let score = s.score.filter(|v| v.is_finite());
    let id = crate::util::new_id();
    let bytes = image.len() as i64;
    // The bundle, and Yama's query model if the phone ran it (scan.rs), to tell models apart later.
    let bundle = crate::scan::recorded_version(&st.cfg, s.embed.as_deref()).await;
    let mut tx = st.pool.begin().await?;
    sqlx::query(
        "INSERT INTO scan_samples (id, owner_id, created_at, kind, label_scryfall_id, label_name, guess_name, guess_scryfall_id,
           guess_illustration_id, method, score, quad, camera, bundle, image, bytes, shared)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(crate::util::now())
    .bind(&s.kind)
    .bind(text(s.label_scryfall_id))
    .bind(text(s.label_name))
    .bind(text(s.guess_name))
    .bind(text(s.guess_scryfall_id))
    .bind(text(s.guess_illustration_id))
    .bind(text(s.method))
    .bind(score)
    .bind(quad)
    .bind(text(s.camera))
    .bind(bundle)
    .bind(image)
    .bind(bytes)
    .bind(s.shared)
    .execute(&mut *tx)
    .await?;
    // Keep the newest KEEP, and no more than KEEP_BYTES of them.
    sqlx::query(
        "DELETE FROM scan_samples WHERE owner_id = ?1 AND id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER w AS n, SUM(bytes) OVER w AS running
               FROM scan_samples WHERE owner_id = ?1
             WINDOW w AS (ORDER BY created_at DESC, rowid DESC ROWS UNBOUNDED PRECEDING))
           WHERE n > ?2 OR running > ?3)",
    )
    .bind(&user.id)
    .bind(KEEP)
    .bind(KEEP_BYTES)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(json!({ "id": id })))
}

/// How many photos this account has kept, and their size.
async fn summary(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    let (count, bytes): (i64, Option<i64>) =
        sqlx::query_as("SELECT COUNT(*), SUM(bytes) FROM scan_samples WHERE owner_id = ?").bind(&user.id).fetch_one(&st.pool).await?;
    Ok(Json(json!({ "count": count, "bytes": bytes.unwrap_or(0), "keep": KEEP })))
}

async fn delete_all(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    let gone = sqlx::query("DELETE FROM scan_samples WHERE owner_id = ?").bind(&user.id).execute(&st.pool).await?.rows_affected();
    Ok(Json(json!({ "deleted": gone })))
}

/// One shared photo as the admin sees it: who saved it, when, and what was said; the image is
/// fetched separately.
#[derive(Serialize, sqlx::FromRow)]
pub struct SharedSample {
    pub id: String,
    pub owner_id: String,
    pub owner_name: String,
    pub created_at: String,
    pub kind: String,
    pub label_scryfall_id: Option<String>,
    pub label_name: Option<String>,
    pub guess_name: Option<String>,
    pub guess_scryfall_id: Option<String>,
    pub guess_illustration_id: Option<String>,
    pub method: Option<String>,
    pub score: Option<f64>,
    pub quad: Option<String>,
    pub camera: Option<String>,
    pub bundle: Option<String>,
    pub bytes: i64,
}

const SHARED_COLUMNS: &str = "s.id, s.owner_id, u.display_name AS owner_name, s.created_at, s.kind, s.label_scryfall_id, s.label_name,
  s.guess_name, s.guess_scryfall_id, s.guess_illustration_id, s.method, s.score, s.quad, s.camera, s.bundle, s.bytes";

/// Shared photos, newest first: everyone's, or one account's (`owner`), from `since` (a date or
/// moment), before the cursor `before` (`created_at|id` of the last one already seen).
async fn shared_page(pool: &sqlx::SqlitePool, owner: Option<&str>, since: Option<&str>, before: Option<(&str, &str)>, limit: i64) -> AppResult<Vec<SharedSample>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SHARED_COLUMNS} FROM scan_samples s JOIN users u ON u.id = s.owner_id
          WHERE s.shared = 1 AND (?1 IS NULL OR s.owner_id = ?1) AND (?2 IS NULL OR s.created_at >= ?2)
            AND (?3 IS NULL OR (s.created_at, s.id) < (?3, ?4))
          ORDER BY s.created_at DESC, s.id DESC LIMIT ?5"
    )))
    .bind(owner)
    .bind(since)
    .bind(before.map(|b| b.0))
    .bind(before.map(|b| b.1))
    .bind(limit)
    .fetch_all(pool)
    .await?)
}

#[derive(Deserialize)]
struct AdminPage {
    owner: Option<String>,
    since: Option<String>,
    before: Option<String>,
    limit: Option<i64>,
}

/// The shared photos, a page at a time, with the total shared.
async fn admin_list(State(st): State<AppState>, AdminUser(_): AdminUser, Query(q): Query<AdminPage>) -> AppResult<Json<Value>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let before = q.before.as_deref().and_then(|b| b.split_once('|'));
    let samples = shared_page(&st.pool, q.owner.as_deref(), q.since.as_deref(), before, limit).await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_samples WHERE shared = 1").fetch_one(&st.pool).await?;
    let next = (samples.len() as i64 == limit).then(|| samples.last().map(|s| format!("{}|{}", s.created_at, s.id))).flatten();
    Ok(Json(json!({ "samples": samples, "total": total, "next": next })))
}

/// One shared photo's JPEG. A photo that wasn't shared is "not found", like one that doesn't exist.
async fn admin_image(State(st): State<AppState>, AdminUser(_): AdminUser, Path(id): Path<String>) -> AppResult<axum::response::Response> {
    let image: Option<Vec<u8>> = sqlx::query_scalar("SELECT image FROM scan_samples WHERE id = ? AND shared = 1").bind(&id).fetch_optional(&st.pool).await?;
    let image = image.ok_or(AppError::NotFound("No such scan photo"))?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=3600")], image).into_response())
}

/// `yama-server scan-samples-export DIR [--since DATE] [--owner USER_ID]`: writes every shared
/// photo to DIR as `<id>.jpg`, with `manifest.jsonl` (one line per photo: who, when and what was
/// said). For tuning the scanner; run on the server (`docker exec yama …`) and copy DIR off.
pub async fn export_cli(pool: &sqlx::SqlitePool, args: &[String]) -> anyhow::Result<()> {
    let flag = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let dir = args.first().filter(|a| !a.starts_with("--")).context("usage: yama-server scan-samples-export DIR [--since DATE] [--owner USER_ID]")?;
    let dir = std::path::Path::new(dir);
    std::fs::create_dir_all(dir)?;
    let (since, owner) = (flag("--since"), flag("--owner"));
    let mut manifest = String::new();
    let mut before: Option<(String, String)> = None;
    let mut n = 0usize;
    loop {
        let page = shared_page(pool, owner.as_deref(), since.as_deref(), before.as_ref().map(|(a, b)| (a.as_str(), b.as_str())), 200).await?;
        for s in &page {
            // Ids are ours (crate::util::new_id): safe as file names, but checked anyway.
            anyhow::ensure!(s.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "odd sample id {}", s.id);
            let image: Vec<u8> = sqlx::query_scalar("SELECT image FROM scan_samples WHERE id = ? AND shared = 1").bind(&s.id).fetch_one(pool).await?;
            std::fs::write(dir.join(format!("{}.jpg", s.id)), image)?;
            manifest.push_str(&serde_json::to_string(s)?);
            manifest.push('\n');
            n += 1;
        }
        match page.last() {
            Some(last) if page.len() == 200 => before = Some((last.created_at.clone(), last.id.clone())),
            _ => break,
        }
    }
    std::fs::write(dir.join("manifest.jsonl"), manifest)?;
    println!("Wrote {n} shared scan photos and manifest.jsonl to {}", dir.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use axum::http::{Method, StatusCode};

    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 2, 3, 0xFF, 0xD9];

    fn body(kind: &str) -> Value {
        json!({
            "image": base64::engine::general_purpose::STANDARD.encode(JPEG),
            "kind": kind,
            "label_scryfall_id": "p1",
            "label_name": "Sol Ring",
            "guess_name": "Sol Ring",
            "method": "art",
            "score": 0.91,
            "quad": [[1.0, 2.0], [3.0, 2.0], [3.0, 5.0], [1.0, 5.0]],
            "camera": "3840×2160",
        })
    }

    #[tokio::test]
    async fn photos_are_kept_per_account_and_deleted_on_request() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let (_, theirs) = testutil::user(&pool, "them@example.com").await;

        // Each says which art model the phone ran; the server records it with the bundle.
        let mut added = body("added");
        added["embed"] = json!(crate::scan::QUERY_MODEL.file());
        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(added)).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        let mut wrong = body("wrong");
        wrong["embed"] = json!("embed.onnx");
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(wrong)).await;
        assert_eq!(status, StatusCode::OK);
        let bundles: Vec<(String, String)> = sqlx::query_as("SELECT kind, bundle FROM scan_samples ORDER BY kind").fetch_all(&pool).await.unwrap();
        let bundle = crate::scan::BUNDLE_VERSION;
        assert_eq!(bundles, [("added".to_string(), format!("{bundle}+yama-art-20261118")), ("wrong".to_string(), bundle.to_string())]);
        let (_, s) = testutil::send(&app, Method::GET, "/api/scan/samples", Some(&mine), None).await;
        assert_eq!(s["count"], 2);
        assert_eq!(s["bytes"], 2 * JPEG.len() as i64);
        // Someone else sees none of them, and can't delete them.
        let (_, s) = testutil::send(&app, Method::GET, "/api/scan/samples", Some(&theirs), None).await;
        assert_eq!(s["count"], 0);
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/samples", Some(&theirs), None).await;
        assert_eq!(d["deleted"], 0);
        let stored: (String, String, Option<String>, Vec<u8>) = sqlx::query_as("SELECT owner_id, kind, quad, image FROM scan_samples ORDER BY kind LIMIT 1").fetch_one(&pool).await.unwrap();
        assert_eq!(stored.0, me);
        assert_eq!(stored.1, "added");
        assert_eq!(stored.2.as_deref(), Some("[[1.0,2.0],[3.0,2.0],[3.0,5.0],[1.0,5.0]]"));
        assert_eq!(stored.3, JPEG);

        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/samples", Some(&mine), None).await;
        assert_eq!(d["deleted"], 2);
        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/samples", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn the_admin_sees_only_photos_saved_as_shared() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let (admin, admin_token) = testutil::user(&pool, "admin@example.com").await;
        sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&admin).execute(&pool).await.unwrap();

        // Saved before sharing (no `shared`): private for good.
        let (status, private) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(body("added"))).await;
        assert_eq!(status, StatusCode::OK);
        let mut b = body("corrected");
        b["shared"] = json!(true);
        let (status, shared) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(b)).await;
        assert_eq!(status, StatusCode::OK);

        let (status, list) = testutil::send(&app, Method::GET, "/api/admin/scan-samples", Some(&admin_token), None).await;
        assert_eq!(status, StatusCode::OK, "{list}");
        assert_eq!(list["total"], 1);
        let rows = list["samples"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], shared["id"]);
        assert_eq!(rows[0]["owner_id"], me.as_str());
        assert_eq!(rows[0]["kind"], "corrected");
        assert_eq!(rows[0]["label_name"], "Sol Ring");
        assert!(rows[0].get("image").is_none());

        let image = |id: &str, token: &str| {
            let req = axum::http::Request::get(format!("/api/admin/scan-samples/{id}/image"))
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(axum::body::Body::empty())
                .unwrap();
            let app = app.clone();
            async move {
                use tower::ServiceExt;
                let res = app.oneshot(req).await.unwrap();
                (res.status(), axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec())
            }
        };
        let (status, bytes) = image(shared["id"].as_str().unwrap(), &admin_token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, JPEG);
        let (status, _) = image(private["id"].as_str().unwrap(), &admin_token).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Not an admin: as if the routes didn't exist.
        let (status, _) = testutil::send(&app, Method::GET, "/api/admin/scan-samples", Some(&mine), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = image(shared["id"].as_str().unwrap(), &mine).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // The export writes the shared one only.
        let dir = std::env::temp_dir().join(format!("yama-scan-export-{}", crate::util::new_id()));
        export_cli(&pool, &[dir.to_string_lossy().into_owned()]).await.unwrap();
        let manifest = std::fs::read_to_string(dir.join("manifest.jsonl")).unwrap();
        assert_eq!(manifest.lines().count(), 1);
        assert!(manifest.contains(shared["id"].as_str().unwrap()));
        assert_eq!(std::fs::read(dir.join(format!("{}.jpg", shared["id"].as_str().unwrap()))).unwrap(), JPEG);
        assert!(!dir.join(format!("{}.jpg", private["id"].as_str().unwrap())).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn refuses_what_isnt_a_small_jpeg_or_a_known_kind() {
        let (app, pool) = testutil::app().await;
        let (_, token) = testutil::user(&pool, "me@example.com").await;
        let mut b = body("guess");
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        b["kind"] = json!("added");
        b["image"] = json!(base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n"));
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let mut big = JPEG.to_vec();
        big.resize(MAX_IMAGE + 1, 0);
        b["image"] = json!(base64::engine::general_purpose::STANDARD.encode(&big));
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b)).await;
        assert!(status == StatusCode::BAD_REQUEST || status == StatusCode::PAYLOAD_TOO_LARGE, "{status}");
    }

    #[tokio::test]
    async fn keeps_no_more_than_the_byte_cap() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        for (id, at) in [("oldest", "2026-01-01T00:00:00Z"), ("older", "2026-01-02T00:00:00Z")] {
            sqlx::query("INSERT INTO scan_samples (id, owner_id, created_at, kind, image, bytes) VALUES (?, ?, ?, 'added', x'FFD8FF', ?)")
                .bind(id)
                .bind(&me)
                .bind(at)
                .bind(KEEP_BYTES / 2)
                .execute(&pool)
                .await
                .unwrap();
        }
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(body("added"))).await;
        assert_eq!(status, StatusCode::OK);
        let left: Vec<String> = sqlx::query_scalar("SELECT id FROM scan_samples WHERE owner_id = ? AND id LIKE 'old%' ORDER BY id").bind(&me).fetch_all(&pool).await.unwrap();
        assert_eq!(left, ["older"]);
    }

    #[tokio::test]
    async fn keeps_only_the_newest() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        // Fill to the cap directly, older than now.
        for i in 0..KEEP {
            sqlx::query("INSERT INTO scan_samples (id, owner_id, created_at, kind, image, bytes) VALUES (?, ?, ?, 'added', x'FFD8FF', 3)")
                .bind(format!("old{i}"))
                .bind(&me)
                .bind(format!("2026-01-01T00:00:{:02}Z", i % 60))
                .execute(&pool)
                .await
                .unwrap();
        }
        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(body("added"))).await;
        assert_eq!(status, StatusCode::OK);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_samples WHERE owner_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(count, KEEP);
        let newest: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_samples WHERE id = ?").bind(res["id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
        assert_eq!(newest, 1);
    }
}
