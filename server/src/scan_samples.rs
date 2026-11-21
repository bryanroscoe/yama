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
//! switch promised they were shown to no one, are never shown to an admin. Only the card is kept
//! here; nothing else from the camera.
//!
//! Full-resolution crops (Bryan, 20 Nov 2026: a printing model needs the set symbol, which the
//! 640 px photo shrinks to about 20 px): with each photo the scanner may send the set symbol's area
//! and the collector strip, warped upright from the card's corners at the card's own resolution in
//! the frame ([`CROP_NAMES`]). They're files under the data directory,
//! `scan-samples/<owner>/<id>/<name>.jpg` (out of the main database, like scanner diagnostics'
//! images), listed in the photo's row, and they go with their photo: the caps (which count them),
//! Delete them, and the account. They're shared exactly when their photo is.

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
/// Most bytes of photos and their crops together per account; past it the oldest go, crops and all.
pub const KEEP_TOTAL_BYTES: i64 = 400 * 1024 * 1024;
/// Largest photo accepted. The scanner sends at most 640 px on the long side, about 30 to 90 kB.
const MAX_IMAGE: usize = 160 * 1024;
/// Largest crop accepted: a collector strip at most 2,400 px wide.
pub const MAX_CROP: usize = 1024 * 1024;
/// The crops a photo may have: the set symbol's area and the collector strip.
pub const CROP_NAMES: [&str; 2] = ["symbol", "strip"];
const MAX_TEXT: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/scan/samples",
            post(add).get(summary).delete(delete_all).layer(DefaultBodyLimit::max((MAX_IMAGE + CROP_NAMES.len() * MAX_CROP) * 4 / 3 + 16 * 1024)),
        )
        .route("/api/admin/scan-samples", get(admin_list))
        .route("/api/admin/scan-samples/{id}/image", get(admin_image))
        .route("/api/admin/scan-samples/{id}/crops/{name}", get(admin_crop))
}

/// The folder an account's crops live in.
pub fn owner_dir(data_dir: &std::path::Path, owner: &str) -> std::path::PathBuf {
    data_dir.join("scan-samples").join(owner)
}

/// Ids are the server's own (crate::util::new_id): plain enough to be a folder name.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Remove every crop an account kept (after its rows are gone). Never fails the caller.
pub fn remove_owner_files(data_dir: &std::path::Path, owner: &str) {
    let dir = owner_dir(data_dir, owner);
    if let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("couldn't remove scan photo crops in {}: {e}", dir.display());
    }
}

fn remove_sample_files(data_dir: &std::path::Path, owner: &str, id: &str) {
    if !plain_id(id) {
        return;
    }
    let dir = owner_dir(data_dir, owner).join(id);
    if let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("couldn't remove scan photo crops {}: {e}", dir.display());
    }
}

/// A crop's JPEG, when the photo lists it.
fn read_crop(data_dir: &std::path::Path, owner: &str, id: &str, crops: Option<&str>, name: &str) -> AppResult<Option<Vec<u8>>> {
    let listed = crops.and_then(|c| serde_json::from_str::<Vec<Value>>(c).ok()).unwrap_or_default().iter().any(|c| c.get("name").and_then(Value::as_str) == Some(name));
    if !listed || !CROP_NAMES.contains(&name) || !plain_id(id) {
        return Ok(None);
    }
    match std::fs::read(owner_dir(data_dir, owner).join(id).join(format!("{name}.jpg"))) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::Error::from(e).context("reading a scan photo crop").into()),
    }
}

#[derive(Deserialize)]
struct NewCrop {
    name: String,
    /// A base64 JPEG.
    image: String,
    width: Option<i64>,
    height: Option<i64>,
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
    /// The option each of the scanner's slots ran (scan.rs, `recorded_models`), if said.
    models: Option<Value>,
    /// The scanner told the person that saved photos are shared with Yama's developer.
    #[serde(default)]
    shared: bool,
    /// Full-resolution crops of the card: the set symbol's area and the collector strip.
    #[serde(default)]
    crops: Vec<NewCrop>,
}

/// A base64 JPEG of at most `max` bytes.
fn jpeg(b64: &str, max: usize) -> AppResult<Vec<u8>> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|_| AppError::BadRequest("image isn't base64".into()))?;
    if bytes.len() > max {
        return Err(AppError::BadRequest("image is too large".into()));
    }
    // JPEG only: it starts FF D8 FF.
    if !bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Err(AppError::BadRequest("image isn't a JPEG".into()));
    }
    Ok(bytes)
}

fn text(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().chars().take(MAX_TEXT).collect::<String>()).filter(|s| !s.is_empty())
}

async fn add(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(s): Json<NewSample>) -> AppResult<Json<Value>> {
    st.limits.scan_samples.check_user(&user)?;
    if !matches!(s.kind.as_str(), "added" | "corrected" | "wrong") {
        return Err(AppError::BadRequest("kind is added, corrected or wrong".into()));
    }
    let image = jpeg(&s.image, MAX_IMAGE)?;
    let mut crops: Vec<(String, Vec<u8>, Option<i64>, Option<i64>)> = Vec::with_capacity(s.crops.len());
    for c in s.crops {
        if !CROP_NAMES.contains(&c.name.as_str()) || crops.iter().any(|(n, ..)| n == &c.name) {
            return Err(AppError::BadRequest(format!("crops are {}, once each", CROP_NAMES.join(" and "))));
        }
        let dim = |v: Option<i64>| v.filter(|n| (1..=20_000).contains(n));
        crops.push((c.name, jpeg(&c.image, MAX_CROP)?, dim(c.width), dim(c.height)));
    }
    let quad = match s.quad {
        Some(q) if q.iter().flatten().all(|v| v.is_finite()) => Some(serde_json::to_string(&q).map_err(anyhow::Error::from)?),
        Some(_) => return Err(AppError::BadRequest("quad isn't four points".into())),
        None => None,
    };
    let score = s.score.filter(|v| v.is_finite());
    let id = crate::util::new_id();
    let bytes = image.len() as i64;
    let crop_bytes: i64 = crops.iter().map(|(_, b, ..)| b.len() as i64).sum();
    let listed = (!crops.is_empty()).then(|| Value::Array(crops.iter().map(|(n, b, w, h)| json!({"name": n, "width": w, "height": h, "bytes": b.len()})).collect()).to_string());
    let t = SampleText {
        label_scryfall_id: text(s.label_scryfall_id),
        label_name: text(s.label_name),
        guess_name: text(s.guess_name),
        guess_scryfall_id: text(s.guess_scryfall_id),
        guess_illustration_id: text(s.guess_illustration_id),
        method: text(s.method),
        score,
        quad,
        camera: text(s.camera),
        models: crate::scan::recorded_models(s.models.as_ref()),
        shared: s.shared,
    };
    // Files, row and cleanup in a task of their own: a client gone mid-request (the handler's
    // future dropped) doesn't leave crops written without their row, or a row without its crops.
    let (owner, kind, embed) = (user.id.clone(), s.kind, s.embed);
    let task = tokio::spawn(async move {
        let data_dir = &st.cfg.data_dir;
        // The crops' files first, under a folder of their own; the row only once they're all written.
        if !crops.is_empty() {
            let dir = owner_dir(data_dir, &owner).join(&id);
            let write = || -> std::io::Result<()> {
                std::fs::create_dir_all(&dir)?;
                for (name, b, ..) in &crops {
                    std::fs::write(dir.join(format!("{name}.jpg")), b)?;
                }
                Ok(())
            };
            if let Err(e) = write() {
                remove_sample_files(data_dir, &owner, &id);
                return Err(AppError::from(anyhow::Error::from(e).context("writing scan photo crops")));
            }
        }
        // The bundle, and Yama's query model if the phone ran it (scan.rs), to tell models apart later.
        let bundle = crate::scan::recorded_version(&st.cfg, embed.as_deref()).await;
        match save(&st.pool, &owner, &id, &kind, bundle, image, bytes, listed, crop_bytes, t).await {
            Ok(gone) => {
                for old in gone {
                    remove_sample_files(data_dir, &owner, &old);
                }
                Ok(id)
            }
            Err(e) => {
                remove_sample_files(data_dir, &owner, &id);
                Err(e)
            }
        }
    });
    let id = task.await.map_err(|e| AppError::from(anyhow::anyhow!("saving a scan photo: {e}")))??;
    Ok(Json(json!({ "id": id })))
}

/// How old a crops folder with no row must be before Delete them takes it: an upload writes its
/// folder seconds before its row, so a younger one may be on its way.
const ORPHAN_AGE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Crop folders of this account with no photo row, older than ORPHAN_AGE (a server stopped
/// between writing the files and the row): removed.
async fn sweep_orphans(pool: &sqlx::SqlitePool, data_dir: &std::path::Path, owner: &str) -> AppResult<()> {
    let Ok(entries) = std::fs::read_dir(owner_dir(data_dir, owner)) else { return Ok(()) };
    let ids: std::collections::HashSet<String> = sqlx::query_scalar("SELECT id FROM scan_samples WHERE owner_id = ?").bind(owner).fetch_all(pool).await?.into_iter().collect();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age >= ORPHAN_AGE);
        if old && !ids.contains(&name) {
            remove_sample_files(data_dir, owner, &name);
        }
    }
    Ok(())
}

/// What a photo's row says beside its image.
struct SampleText {
    label_scryfall_id: Option<String>,
    label_name: Option<String>,
    guess_name: Option<String>,
    guess_scryfall_id: Option<String>,
    guess_illustration_id: Option<String>,
    method: Option<String>,
    score: Option<f64>,
    quad: Option<String>,
    camera: Option<String>,
    /// The option each of the scanner's slots ran, as JSON (scan.rs, `recorded_models`).
    models: Option<String>,
    shared: bool,
}

/// The row, then the caps: the ids of the older photos it pushed out (their crops' folders go
/// once this has committed).
#[allow(clippy::too_many_arguments)]
async fn save(
    pool: &sqlx::SqlitePool,
    owner: &str,
    id: &str,
    kind: &str,
    bundle: String,
    image: Vec<u8>,
    bytes: i64,
    crops: Option<String>,
    crop_bytes: i64,
    t: SampleText,
) -> AppResult<Vec<String>> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO scan_samples (id, owner_id, created_at, kind, label_scryfall_id, label_name, guess_name, guess_scryfall_id,
           guess_illustration_id, method, score, quad, camera, bundle, models, image, bytes, shared, crops, crop_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(owner)
    .bind(crate::util::now())
    .bind(kind)
    .bind(t.label_scryfall_id)
    .bind(t.label_name)
    .bind(t.guess_name)
    .bind(t.guess_scryfall_id)
    .bind(t.guess_illustration_id)
    .bind(t.method)
    .bind(t.score)
    .bind(t.quad)
    .bind(t.camera)
    .bind(bundle)
    .bind(t.models)
    .bind(image)
    .bind(bytes)
    .bind(t.shared)
    .bind(crops)
    .bind(crop_bytes)
    .execute(&mut *tx)
    .await?;
    // Keep the newest KEEP, no more than KEEP_BYTES of photos (in the database), and no more than
    // KEEP_TOTAL_BYTES of photos and crops together.
    let gone: Vec<String> = sqlx::query_scalar(
        "DELETE FROM scan_samples WHERE owner_id = ?1 AND id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER w AS n, SUM(bytes) OVER w AS running, SUM(bytes + crop_bytes) OVER w AS total
               FROM scan_samples WHERE owner_id = ?1
             WINDOW w AS (ORDER BY created_at DESC, rowid DESC ROWS UNBOUNDED PRECEDING))
           WHERE n > ?2 OR running > ?3 OR total > ?4)
         RETURNING id",
    )
    .bind(owner)
    .bind(KEEP)
    .bind(KEEP_BYTES)
    .bind(KEEP_TOTAL_BYTES)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(gone)
}

/// How many photos this account has kept, and their size (photos, and their crops).
async fn summary(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    let (count, bytes, crop_bytes): (i64, Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT COUNT(*), SUM(bytes), SUM(crop_bytes) FROM scan_samples WHERE owner_id = ?").bind(&user.id).fetch_one(&st.pool).await?;
    Ok(Json(json!({ "count": count, "bytes": bytes.unwrap_or(0), "crop_bytes": crop_bytes.unwrap_or(0), "keep": KEEP })))
}

async fn delete_all(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    // Only the folders of the rows this deleted: an upload still waiting to commit has written its
    // crops already (as for scanner diagnostics).
    let gone: Vec<String> = sqlx::query_scalar("DELETE FROM scan_samples WHERE owner_id = ? RETURNING id").bind(&user.id).fetch_all(&st.pool).await?;
    for id in &gone {
        remove_sample_files(&st.cfg.data_dir, &user.id, id);
    }
    // and any left by an upload that never got its row.
    sweep_orphans(&st.pool, &st.cfg.data_dir, &user.id).await?;
    Ok(Json(json!({ "deleted": gone.len() })))
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
    /// The option each scanner slot ran, as JSON (scan.rs, `recorded_models`), when the phone said.
    pub models: Option<String>,
    pub bytes: i64,
    /// Its full-resolution crops, as JSON (name, width, height, bytes); none for older photos.
    #[serde(skip)]
    pub crops: Option<String>,
    pub crop_bytes: i64,
}

impl SharedSample {
    /// As the admin list and the export give it: the crops parsed, each with where it's read
    /// (under `key`: the admin's "url", the export's "file").
    fn json(&self, key: &str, crop_ref: impl Fn(&str) -> String) -> AppResult<Value> {
        let mut v = serde_json::to_value(self).map_err(anyhow::Error::from)?;
        let crops: Vec<Value> = self
            .crops
            .as_deref()
            .and_then(|c| serde_json::from_str::<Vec<Value>>(c).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|mut c| {
                if let Some(name) = c.get("name").and_then(Value::as_str).map(str::to_owned) {
                    c[key] = json!(crop_ref(&name));
                }
                c
            })
            .collect();
        v["crops"] = json!(crops);
        Ok(v)
    }
}

const SHARED_COLUMNS: &str = "s.id, s.owner_id, u.display_name AS owner_name, s.created_at, s.kind, s.label_scryfall_id, s.label_name,
  s.guess_name, s.guess_scryfall_id, s.guess_illustration_id, s.method, s.score, s.quad, s.camera, s.bundle, s.models, s.bytes, s.crops, s.crop_bytes";

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
    let samples = samples.iter().map(|s| s.json("url", |name| format!("/api/admin/scan-samples/{}/crops/{name}", s.id))).collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({ "samples": samples, "total": total, "next": next })))
}

/// One crop of a shared photo. A photo that wasn't shared, or a crop it doesn't list, is "not found".
async fn admin_crop(State(st): State<AppState>, AdminUser(_): AdminUser, Path((id, name)): Path<(String, String)>) -> AppResult<axum::response::Response> {
    let name = name.strip_suffix(".jpg").unwrap_or(&name).to_string();
    let row: Option<(String, Option<String>)> = sqlx::query_as("SELECT owner_id, crops FROM scan_samples WHERE id = ? AND shared = 1").bind(&id).fetch_optional(&st.pool).await?;
    let (owner, crops) = row.ok_or(AppError::NotFound("No such scan photo"))?;
    let bytes = read_crop(&st.cfg.data_dir, &owner, &id, crops.as_deref(), &name)?.ok_or(AppError::NotFound("No such crop"))?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=3600")], bytes).into_response())
}

/// One shared photo's JPEG. A photo that wasn't shared is "not found", like one that doesn't exist.
async fn admin_image(State(st): State<AppState>, AdminUser(_): AdminUser, Path(id): Path<String>) -> AppResult<axum::response::Response> {
    let image: Option<Vec<u8>> = sqlx::query_scalar("SELECT image FROM scan_samples WHERE id = ? AND shared = 1").bind(&id).fetch_optional(&st.pool).await?;
    let image = image.ok_or(AppError::NotFound("No such scan photo"))?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=3600")], image).into_response())
}

/// `yama-server scan-samples-export DIR [--since DATE] [--owner USER_ID]`: writes every shared
/// photo to DIR as `<id>.jpg`, its crops as `<id>.<name>.jpg`, with `manifest.jsonl` (one line per
/// photo: who, when and what was said, and its crops with their file, width, height and bytes).
/// For tuning the scanner; run on the server (`docker exec yama …`) and copy DIR off.
pub async fn export_cli(pool: &sqlx::SqlitePool, data_dir: &std::path::Path, args: &[String]) -> anyhow::Result<()> {
    let flag = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let dir = args.first().filter(|a| !a.starts_with("--")).context("usage: yama-server scan-samples-export DIR [--since DATE] [--owner USER_ID]")?;
    let dir = std::path::Path::new(dir);
    std::fs::create_dir_all(dir)?;
    let (since, owner) = (flag("--since"), flag("--owner"));
    let mut manifest = String::new();
    let mut before: Option<(String, String)> = None;
    let (mut n, mut crops) = (0usize, 0usize);
    loop {
        let page = shared_page(pool, owner.as_deref(), since.as_deref(), before.as_ref().map(|(a, b)| (a.as_str(), b.as_str())), 200).await?;
        for s in &page {
            // Ids are ours (crate::util::new_id): safe as file names, but checked anyway.
            anyhow::ensure!(s.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "odd sample id {}", s.id);
            let image: Vec<u8> = sqlx::query_scalar("SELECT image FROM scan_samples WHERE id = ? AND shared = 1").bind(&s.id).fetch_one(pool).await?;
            std::fs::write(dir.join(format!("{}.jpg", s.id)), image)?;
            let mut line = s.json("file", |name| format!("{}.{name}.jpg", s.id)).map_err(|e| anyhow::anyhow!("{e}"))?;
            // Only the crops whose files are there (a folder can't be half written: see `add`).
            let mut kept = Vec::new();
            for c in line["crops"].as_array().cloned().unwrap_or_default() {
                let name = c.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                if let Some(bytes) = read_crop(data_dir, &s.owner_id, &s.id, s.crops.as_deref(), &name).map_err(|e| anyhow::anyhow!("{e}"))? {
                    std::fs::write(dir.join(format!("{}.{name}.jpg", s.id)), bytes)?;
                    kept.push(c);
                    crops += 1;
                }
            }
            line["crops"] = json!(kept);
            manifest.push_str(&line.to_string());
            manifest.push('\n');
            n += 1;
        }
        match page.last() {
            Some(last) if page.len() == 200 => before = Some((last.created_at.clone(), last.id.clone())),
            _ => break,
        }
    }
    std::fs::write(dir.join("manifest.jsonl"), manifest)?;
    println!("Wrote {n} shared scan photos, {crops} crops and manifest.jsonl to {}", dir.display());
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
        added["embed"] = json!(format!("{}/{}", crate::scan::BUNDLE_VERSION, crate::scan::QUERY_MODEL.file().unwrap()));
        added["models"] = json!({"art": "yama-art-20261118", "look": "off", "text": "paddle", "lock": "lead", "other": "x"});
        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(added)).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        let mut wrong = body("wrong");
        wrong["embed"] = json!(format!("{}/embed.onnx", crate::scan::BUNDLE_VERSION));
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(wrong)).await;
        assert_eq!(status, StatusCode::OK);
        let bundles: Vec<(String, String)> = sqlx::query_as("SELECT kind, bundle FROM scan_samples ORDER BY kind").fetch_all(&pool).await.unwrap();
        let bundle = crate::scan::BUNDLE_VERSION;
        assert_eq!(bundles, [("added".to_string(), format!("{bundle}+yama-art-20261118")), ("wrong".to_string(), bundle.to_string())]);
        // And each slot's choice, when it says them (not an older build's photo).
        let models: Vec<Option<String>> = sqlx::query_scalar("SELECT models FROM scan_samples ORDER BY kind").fetch_all(&pool).await.unwrap();
        let said: serde_json::Value = serde_json::from_str(models[0].as_deref().unwrap()).unwrap();
        assert_eq!(said, json!({"art": "yama-art-20261118", "look": "off", "text": "paddle", "lock": "lead"}));
        assert_eq!(models[1], None);
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
        export_cli(&pool, &std::env::temp_dir(), &[dir.to_string_lossy().into_owned()]).await.unwrap();
        let manifest = std::fs::read_to_string(dir.join("manifest.jsonl")).unwrap();
        assert_eq!(manifest.lines().count(), 1);
        assert!(manifest.contains(shared["id"].as_str().unwrap()));
        assert_eq!(std::fs::read(dir.join(format!("{}.jpg", shared["id"].as_str().unwrap()))).unwrap(), JPEG);
        assert!(!dir.join(format!("{}.jpg", private["id"].as_str().unwrap())).exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn files(owner: &str) -> Vec<String> {
        let dir = owner_dir(&std::env::temp_dir(), owner);
        let mut out = Vec::new();
        for d in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            for f in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
                out.push(format!("{}/{}", d.file_name().to_string_lossy(), f.file_name().to_string_lossy()));
            }
        }
        out.sort();
        out
    }

    fn with_crops(kind: &str) -> Value {
        let mut b = body(kind);
        let jpeg = base64::engine::general_purpose::STANDARD.encode(JPEG);
        b["shared"] = json!(true);
        b["crops"] = json!([{"name": "symbol", "image": jpeg, "width": 450, "height": 272}, {"name": "strip", "image": jpeg, "width": 1500, "height": 293}]);
        b
    }

    #[tokio::test]
    async fn crops_go_with_their_photo_and_are_shared_as_it_is() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let (admin, admin_token) = testutil::user(&pool, "admin@example.com").await;
        sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&admin).execute(&pool).await.unwrap();

        let (status, shared) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(with_crops("added"))).await;
        assert_eq!(status, StatusCode::OK, "{shared}");
        let id = shared["id"].as_str().unwrap().to_string();
        // Files, not database rows; the row lists them with their sizes.
        assert_eq!(files(&me), [format!("{id}/strip.jpg"), format!("{id}/symbol.jpg")]);
        let (crops, crop_bytes): (String, i64) = sqlx::query_as("SELECT crops, crop_bytes FROM scan_samples WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
        assert_eq!(crop_bytes, 2 * JPEG.len() as i64);
        let crops: Value = serde_json::from_str(&crops).unwrap();
        assert_eq!(crops[0], json!({"name": "symbol", "width": 450, "height": 272, "bytes": JPEG.len()}));
        let (_, sum) = testutil::send(&app, Method::GET, "/api/scan/samples", Some(&mine), None).await;
        assert_eq!(sum["crop_bytes"], 2 * JPEG.len() as i64);

        // A photo saved before sharing keeps its crops private too.
        let mut private = with_crops("corrected");
        private["shared"] = json!(false);
        let (_, private) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(private)).await;
        let private = private["id"].as_str().unwrap().to_string();

        // The admin reads a shared photo's crops; not a private one's, nor a name it doesn't list.
        let get = |uri: String, token: String| {
            let app = app.clone();
            async move {
                use tower::ServiceExt;
                let req = axum::http::Request::get(uri).header(axum::http::header::AUTHORIZATION, format!("Bearer {token}")).body(axum::body::Body::empty()).unwrap();
                let res = app.oneshot(req).await.unwrap();
                (res.status(), axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec())
            }
        };
        let (_, list) = testutil::send(&app, Method::GET, "/api/admin/scan-samples", Some(&admin_token), None).await;
        assert_eq!(list["samples"][0]["crops"][1]["url"], format!("/api/admin/scan-samples/{id}/crops/strip"));
        assert_eq!(list["samples"][0]["crop_bytes"], 2 * JPEG.len() as i64);
        let (status, bytes) = get(format!("/api/admin/scan-samples/{id}/crops/symbol"), admin_token.clone()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, JPEG);
        let (status, _) = get(format!("/api/admin/scan-samples/{private}/crops/symbol"), admin_token.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = get(format!("/api/admin/scan-samples/{id}/crops/card"), admin_token.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = get(format!("/api/admin/scan-samples/{id}/crops/..%2F..%2Fyama"), admin_token.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = get(format!("/api/admin/scan-samples/{id}/crops/symbol"), mine.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // The export writes the shared photo's crops beside it, with their sizes in the manifest.
        let dir = std::env::temp_dir().join(format!("yama-scan-export-{}", crate::util::new_id()));
        export_cli(&pool, &std::env::temp_dir(), &[dir.to_string_lossy().into_owned()]).await.unwrap();
        let manifest: Value = serde_json::from_str(std::fs::read_to_string(dir.join("manifest.jsonl")).unwrap().trim()).unwrap();
        assert_eq!(manifest["crops"][0], json!({"name": "symbol", "width": 450, "height": 272, "bytes": JPEG.len(), "file": format!("{id}.symbol.jpg")}));
        assert_eq!(std::fs::read(dir.join(format!("{id}.strip.jpg"))).unwrap(), JPEG);
        assert!(!dir.join(format!("{private}.strip.jpg")).exists());
        std::fs::remove_dir_all(&dir).unwrap();

        // Delete them takes the crops' files, and an old folder left with no row (a server stopped
        // between the files and the row); not a young one, which may be an upload on its way.
        let orphan = owner_dir(&std::env::temp_dir(), &me).join("orphan");
        let young = owner_dir(&std::env::temp_dir(), &me).join("young");
        for d in [&orphan, &young] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("strip.jpg"), JPEG).unwrap();
        }
        std::fs::File::open(&orphan).unwrap().set_modified(std::time::SystemTime::now() - 2 * ORPHAN_AGE).unwrap();
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/samples", Some(&mine), None).await;
        assert_eq!(d["deleted"], 2);
        assert_eq!(files(&me), ["young/strip.jpg"]);
        remove_owner_files(&std::env::temp_dir(), &me);
    }

    #[tokio::test]
    async fn crops_go_with_the_caps_and_the_account() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        // An old photo whose crops reach the total cap: the next photo pushes it out, files and all.
        sqlx::query("INSERT INTO scan_samples (id, owner_id, created_at, kind, image, bytes, crops, crop_bytes) VALUES ('old', ?, '2026-01-01T00:00:00Z', 'added', x'FFD8FF', 3, '[{\"name\":\"strip\"}]', ?)")
            .bind(&me)
            .bind(KEEP_TOTAL_BYTES)
            .execute(&pool)
            .await
            .unwrap();
        let old = owner_dir(&std::env::temp_dir(), &me).join("old");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("strip.jpg"), JPEG).unwrap();
        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(with_crops("added"))).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        let left: Vec<String> = sqlx::query_scalar("SELECT id FROM scan_samples WHERE owner_id = ?").bind(&me).fetch_all(&pool).await.unwrap();
        assert_eq!(left, [res["id"].as_str().unwrap().to_string()]);
        assert!(!old.exists());
        assert_eq!(files(&me).len(), 2);

        // Refused: an unknown crop, the same one twice, one that isn't a JPEG. Nothing is written.
        let mut b = with_crops("added");
        b["crops"][0]["name"] = json!("card");
        assert_eq!(testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b)).await.0, StatusCode::BAD_REQUEST);
        let mut b = with_crops("added");
        b["crops"][1]["name"] = json!("symbol");
        assert_eq!(testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b)).await.0, StatusCode::BAD_REQUEST);
        let mut b = with_crops("added");
        b["crops"][1]["image"] = json!(base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n"));
        assert_eq!(testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b)).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(files(&me).len(), 2);

        // With the account, files and all.
        let (status, report) = testutil::send(&app, Method::DELETE, "/api/me", Some(&token), Some(json!({"confirm_email": "me@example.com"}))).await;
        assert_eq!(status, StatusCode::OK, "{report}");
        assert!(!owner_dir(&std::env::temp_dir(), &me).exists());
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
