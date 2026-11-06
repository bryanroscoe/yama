//! Scan photos kept to improve the scanner (docs/scanner.md, "Scan photos").
//!
//! While "Save scan photos" is on, the scanner sends the part of the frame around a card it found,
//! with what it thought the card was and what the person said: added (confirmed), corrected (they
//! named another card or printing), or wrong (not this card, no answer). These are the labelled real
//! photos the scanner's accuracy work needs: a real eval set first, training data later.
//!
//! Private to the account: every query binds the owner, nothing here is shared or sent anywhere,
//! the account keeps at most [`KEEP`] photos and [`KEEP_BYTES`] (oldest go first), uploads are
//! rate limited per account, and they're deleted with the account
//! (admin/delete.rs) or on request (`DELETE /api/scan/samples`).

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::extract::{DefaultBodyLimit, State};
use axum::routing::post;
use axum::{Json, Router};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

/// Most photos kept per account; a new one past this drops the oldest.
pub const KEEP: i64 = 2000;
/// Most bytes of photos kept per account (they live in the main database); past it the oldest go.
pub const KEEP_BYTES: i64 = 100 * 1024 * 1024;
/// Largest photo accepted. The scanner sends at most 640 px on the long side, about 30 to 90 kB.
const MAX_IMAGE: usize = 160 * 1024;
const MAX_TEXT: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/scan/samples",
        post(add).get(summary).delete(delete_all).layer(DefaultBodyLimit::max(MAX_IMAGE * 4 / 3 + 16 * 1024)),
    )
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
    let mut tx = st.pool.begin().await?;
    sqlx::query(
        "INSERT INTO scan_samples (id, owner_id, created_at, kind, label_scryfall_id, label_name, guess_name, guess_scryfall_id,
           guess_illustration_id, method, score, quad, camera, bundle, image, bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(crate::scan::BUNDLE_VERSION)
    .bind(image)
    .bind(bytes)
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

        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(body("added"))).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(body("wrong"))).await;
        assert_eq!(status, StatusCode::OK);
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
