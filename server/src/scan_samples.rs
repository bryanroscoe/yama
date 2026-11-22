//! Scan photos kept to improve the scanner (docs/scanner.md, "Scan photos").
//!
//! While "Save scan photos" is on, the scanner sends the part of the frame around each card it
//! names, with what it thought the card was and what the person said: added (confirmed),
//! corrected (they named another card or printing), wrong (not this card, no answer), or, since
//! 22 Nov 2026, unconfirmed (the person let it go without filing it: Skip, Scan next, leaving the
//! scanner), with the scanner's guess, its scores and the rule that named it. One photo per card
//! placed in view: a later answer about the same card changes its label (`PATCH
//! /api/scan/samples/{id}`) rather than adding another. These are the labelled real photos the
//! scanner's training needs (Bryan, 22 Nov 2026: "so we can have a better corpus of training
//! photos").
//!
//! Kept per account: every query here binds the owner, the account keeps at most [`INVITED`]'s
//! photos and bytes ([`OPEN`]'s for an account that signed up without an invite; oldest go first),
//! uploads are rate limited per account, nothing new is kept while the server's disk is low
//! (`Config::scan_photos_min_free`), and they're deleted with the account (admin/delete.rs) or on
//! request (`DELETE /api/scan/samples`).
//!
//! Shared with Yama's developer (Bryan, 15 Nov 2026): a photo saved by a scanner that said so
//! (`shared: true`; migration 0092) can be read by an admin (`/api/admin/scan-samples`, the admin
//! area's Scan photos page, `yama-server scan-samples-export`). Photos saved before that, when the
//! switch promised they were shown to no one, are never shown to an admin. Only the card is kept
//! here; nothing else from the camera.
//!
//! Files, not the database (22 Nov 2026): each photo and its full-resolution crops of the card
//! ([`CROP_NAMES`]: the set symbol's area, the collector strip and the whole card, warped upright
//! from its corners at the card's own resolution in the frame) are files under the data directory,
//! `scan-samples/<owner>/<id>/` (`photo.jpg`, `<name>.jpg`), listed in the photo's row. Photos
//! kept before then stay in the row's `image`, as they were. They go together: the caps (which
//! count them all), Delete them, and the account. Crops are shared exactly when their photo is.

use crate::admin::AdminUser;
use crate::auth::{CurrentUser, User};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use anyhow::Context;
use axum::extract::{DefaultBodyLimit, FromRequest, Path, Query, Request, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

/// How much one account keeps: at most `photos` photos and `bytes` of photos and crops together.
/// Past either, the oldest go, files and all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    pub photos: i64,
    pub bytes: i64,
}

/// An invited account's (and an admin's): room for a large collection scanned once, with deck and
/// box scans besides, before anything is pushed out. A photo with its three crops is about 0.3 to
/// 0.5 MB (docs/scanner.md, "Scan photos"), so the two caps meet at about 20,000 photos.
pub const INVITED: Caps = Caps { photos: 20_000, bytes: 8 * 1024 * 1024 * 1024 };
/// An account that signed up without an invite (`User::limited`): the smaller allowance, as
/// everywhere else; about what any account kept before 22 Nov 2026.
pub const OPEN: Caps = Caps { photos: 2_000, bytes: 800 * 1024 * 1024 };

/// The caps for this account.
pub fn caps_for(user: &User) -> Caps {
    if user.limited { OPEN } else { INVITED }
}

/// Largest photo accepted. The scanner sends at most 640 px on the long side, about 30 to 90 kB.
const MAX_IMAGE: usize = 160 * 1024;
/// Largest crop accepted: a collector strip at most 2,400 px wide, or the whole card at most
/// about 1,100 px tall.
pub const MAX_CROP: usize = 1024 * 1024;
/// The crops a photo may have: the set symbol's area, the collector strip and the whole card.
pub const CROP_NAMES: [&str; 3] = ["symbol", "strip", "card"];
/// What a photo may say happened to its card.
pub const KINDS: [&str; 4] = ["added", "corrected", "wrong", "unconfirmed"];
/// What a later answer may change a photo's label to: never back to unconfirmed.
const ANSWERS: [&str; 3] = ["added", "corrected", "wrong"];
/// Where the frame came from: the browser's camera, the Android app's own, or a still photo.
pub const SOURCES: [&str; 3] = ["browser", "native", "photo"];
/// The photo's own file, beside its crops.
const PHOTO_FILE: &str = "photo.jpg";
/// The art's best matches kept with a photo.
const MAX_SCORES: usize = 8;
const MAX_TEXT: usize = 200;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/scan/samples",
            post(add).get(summary).delete(delete_all).layer(DefaultBodyLimit::max((MAX_IMAGE + CROP_NAMES.len() * MAX_CROP) * 4 / 3 + 16 * 1024)),
        )
        .route("/api/scan/samples/{id}", patch(relabel).delete(delete_one).layer(DefaultBodyLimit::max(4 * 1024)))
        .route("/api/admin/scan-samples", get(admin_list))
        .route("/api/admin/scan-samples/stats", get(admin_stats))
        .route("/api/admin/scan-samples/{id}/image", get(admin_image))
        .route("/api/admin/scan-samples/{id}/crops/{name}", get(admin_crop))
}

/// The folder an account's photo files live in.
pub fn owner_dir(data_dir: &std::path::Path, owner: &str) -> std::path::PathBuf {
    data_dir.join("scan-samples").join(owner)
}

/// Ids are the server's own (crate::util::new_id): plain enough to be a folder name.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Remove every file an account kept (after its rows are gone). Never fails the caller.
pub fn remove_owner_files(data_dir: &std::path::Path, owner: &str) {
    let dir = owner_dir(data_dir, owner);
    if let Err(e) = std::fs::remove_dir_all(&dir)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("couldn't remove scan photos in {}: {e}", dir.display());
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
        tracing::warn!("couldn't remove scan photo files {}: {e}", dir.display());
    }
}

/// One of a photo's files, or None when it isn't there.
fn read_file(data_dir: &std::path::Path, owner: &str, id: &str, file: &str) -> AppResult<Option<Vec<u8>>> {
    if !plain_id(id) {
        return Ok(None);
    }
    match std::fs::read(owner_dir(data_dir, owner).join(id).join(file)) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(anyhow::Error::from(e).context("reading a scan photo file").into()),
    }
}

/// A crop's JPEG, when the photo lists it.
fn read_crop(data_dir: &std::path::Path, owner: &str, id: &str, crops: Option<&str>, name: &str) -> AppResult<Option<Vec<u8>>> {
    let listed = crops.and_then(|c| serde_json::from_str::<Vec<Value>>(c).ok()).unwrap_or_default().iter().any(|c| c.get("name").and_then(Value::as_str) == Some(name));
    if !listed || !CROP_NAMES.contains(&name) {
        return Ok(None);
    }
    read_file(data_dir, owner, id, &format!("{name}.jpg"))
}

/// The photo's JPEG: in the row for one kept before 22 Nov 2026, else its file.
fn read_photo(data_dir: &std::path::Path, owner: &str, id: &str, image: Option<Vec<u8>>) -> AppResult<Option<Vec<u8>>> {
    match image {
        Some(bytes) if !bytes.is_empty() => Ok(Some(bytes)),
        _ => read_file(data_dir, owner, id, PHOTO_FILE),
    }
}

/// Bytes free to this process on the disk that holds `path`, when the system says.
#[allow(clippy::unnecessary_cast)]
fn free_bytes(path: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `c` is a NUL-terminated path and `s` a zeroed statvfs that statvfs(3) fills in.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    Some((s.f_bavail as u64).saturating_mul(s.f_frsize as u64))
}

#[derive(Deserialize)]
struct NewCrop {
    name: String,
    /// A base64 JPEG.
    image: String,
    width: Option<i64>,
    height: Option<i64>,
}

/// One of the art's best matches, as the scanner saw them.
#[derive(Deserialize)]
struct NewScore {
    name: Option<String>,
    set: Option<String>,
    number: Option<String>,
    score: Option<f64>,
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
    /// Full-resolution crops of the card: the set symbol's area, the collector strip, the card.
    #[serde(default)]
    crops: Vec<NewCrop>,
    /// Which camera: browser, native or photo ([`SOURCES`]).
    source: Option<String>,
    /// printing (the collection) or identity (deck and box scans), as for timing records.
    mode: Option<String>,
    /// The rule that named the card (scan_timings.rs, `RULES`).
    rule: Option<String>,
    /// The art's lead over the next different card, and its best matches.
    lead: Option<f64>,
    #[serde(default)]
    scores: Vec<NewScore>,
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
    text_of(v, MAX_TEXT)
}

fn text_of(v: Option<String>, max: usize) -> Option<String> {
    v.map(|s| s.trim().chars().take(max).collect::<String>()).filter(|s| !s.is_empty())
}

/// Only one of `allowed`, else nothing.
fn one_of(v: Option<String>, allowed: &[&str]) -> Option<String> {
    v.map(|s| s.trim().to_string()).filter(|s| allowed.contains(&s.as_str()))
}

/// The art's best matches as kept: at most MAX_SCORES, each with a finite score, as JSON.
fn scores_json(scores: Vec<NewScore>) -> Option<String> {
    let kept: Vec<Value> = scores
        .into_iter()
        .filter_map(|m| {
            let score = m.score.filter(|v| v.is_finite())?;
            Some(json!({"name": text(m.name), "set": text_of(m.set, 20), "number": text_of(m.number, 20), "score": (score * 1000.0).round() / 1000.0}))
        })
        .take(MAX_SCORES)
        .collect();
    (!kept.is_empty()).then(|| Value::Array(kept).to_string())
}

async fn add(State(st): State<AppState>, CurrentUser(user): CurrentUser, req: Request) -> AppResult<axum::response::Response> {
    // The rate limit before the body: a limited account isn't let make the server buffer and parse
    // another few megabytes of photo and crops first (Codex review of #171; as scan_diagnostics.rs).
    st.limits.scan_samples.check_user(&user)?;
    // When it began, against "Delete them" (scan_clears.rs).
    let started = crate::scan_clears::stamp();
    let Json(s) = match Json::<NewSample>::from_request(req, &st).await {
        Ok(json) => json,
        // Axum's own answer: 413 for too large, 400/415/422 for the rest.
        Err(rejection) => return Ok(rejection.into_response()),
    };
    if !KINDS.contains(&s.kind.as_str()) {
        return Err(AppError::BadRequest(format!("kind is {}", KINDS.join(", "))));
    }
    // Scan photos are worth having, not worth filling the server's disk for: the scanner drops a
    // photo it can't send.
    if let Some(free) = free_bytes(&st.cfg.data_dir)
        && free < st.cfg.scan_photos_min_free
    {
        return Err(AppError::Unavailable("The server is short of disk space, so scan photos aren't kept for now.".into()));
    }
    let image = jpeg(&s.image, MAX_IMAGE)?;
    let mut crops: Vec<(String, Vec<u8>, Option<i64>, Option<i64>)> = Vec::with_capacity(s.crops.len());
    for c in s.crops {
        if !CROP_NAMES.contains(&c.name.as_str()) || crops.iter().any(|(n, ..)| n == &c.name) {
            return Err(AppError::BadRequest(format!("crops are {}, once each", CROP_NAMES.join(", "))));
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
    // A card let go unfiled has no answer from the person, whatever was sent.
    let answered = s.kind != "unconfirmed";
    let t = SampleText {
        label_scryfall_id: text(s.label_scryfall_id).filter(|_| answered),
        label_name: text(s.label_name).filter(|_| answered),
        guess_name: text(s.guess_name),
        guess_scryfall_id: text(s.guess_scryfall_id),
        guess_illustration_id: text(s.guess_illustration_id),
        method: text(s.method),
        score,
        quad,
        camera: text(s.camera),
        models: crate::scan::recorded_models(s.models.as_ref()),
        shared: s.shared,
        source: one_of(s.source, &SOURCES),
        mode: one_of(s.mode, &crate::scan_timings::MODES),
        rule: one_of(s.rule, &crate::scan_timings::RULES),
        lead: s.lead.filter(|v| v.is_finite()).map(|v| (v * 1000.0).round() / 1000.0),
        scores: scores_json(s.scores),
    };
    let caps = caps_for(&user);
    // Files, row and cleanup in a task of their own: a client gone mid-request (the handler's
    // future dropped) doesn't leave files written without their row, or a row without its files.
    let (owner, kind, embed) = (user.id.clone(), s.kind, s.embed);
    let task = tokio::spawn(async move {
        let data_dir = &st.cfg.data_dir;
        // The files first, in a folder of their own; the row only once they're all written.
        let dir = owner_dir(data_dir, &owner).join(&id);
        let write = || -> std::io::Result<()> {
            std::fs::create_dir_all(&dir)?;
            std::fs::write(dir.join(PHOTO_FILE), &image)?;
            for (name, b, ..) in &crops {
                std::fs::write(dir.join(format!("{name}.jpg")), b)?;
            }
            Ok(())
        };
        if let Err(e) = write() {
            remove_sample_files(data_dir, &owner, &id);
            return Err(AppError::from(anyhow::Error::from(e).context("writing a scan photo")));
        }
        // The bundle, and Yama's query model if the phone ran it (scan.rs), to tell models apart later.
        let bundle = crate::scan::recorded_version(&st.cfg, embed.as_deref()).await;
        match save(&st.pool, &owner, &id, &kind, bundle, bytes, listed, crop_bytes, t, &started, caps).await {
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
    Ok(Json(json!({ "id": id })).into_response())
}

/// How old a folder with no row must be before Delete them takes it: an upload writes its folder
/// seconds before its row, so a younger one may be on its way.
const ORPHAN_AGE: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Folders of this account with no photo row, older than ORPHAN_AGE (a server stopped between
/// writing the files and the row): removed.
async fn sweep_orphans(pool: &SqlitePool, data_dir: &std::path::Path, owner: &str) -> AppResult<()> {
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

/// What a photo's row says beside its files.
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
    source: Option<String>,
    mode: Option<String>,
    rule: Option<String>,
    lead: Option<f64>,
    scores: Option<String>,
}

/// The row, then the caps: the ids of the older photos it pushed out (their folders go once this
/// has committed).
#[allow(clippy::too_many_arguments)]
async fn save(
    pool: &SqlitePool,
    owner: &str,
    id: &str,
    kind: &str,
    bundle: String,
    bytes: i64,
    crops: Option<String>,
    crop_bytes: i64,
    t: SampleText,
    started: &str,
    caps: Caps,
) -> AppResult<Vec<String>> {
    let mut tx = pool.begin().await?;
    // The photo is its file (photo.jpg): `image` stays NULL.
    sqlx::query(
        "INSERT INTO scan_samples (id, owner_id, created_at, kind, label_scryfall_id, label_name, guess_name, guess_scryfall_id,
           guess_illustration_id, method, score, quad, camera, bundle, models, image, bytes, shared, crops, crop_bytes,
           source, mode, rule, lead, scores)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(bytes)
    .bind(t.shared)
    .bind(crops)
    .bind(crop_bytes)
    .bind(t.source)
    .bind(t.mode)
    .bind(t.rule)
    .bind(t.lead)
    .bind(t.scores)
    .execute(&mut *tx)
    .await?;
    // "Delete them" since it began: not kept (the caller removes its files).
    crate::scan_clears::refuse_if_cleared(&mut tx, owner, crate::scan_clears::SAMPLES, started).await?;
    // Keep the newest `caps.photos`, and no more than `caps.bytes` of photos and crops together.
    let gone: Vec<String> = sqlx::query_scalar(
        "DELETE FROM scan_samples WHERE owner_id = ?1 AND id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER w AS n, SUM(bytes + crop_bytes) OVER w AS total
               FROM scan_samples WHERE owner_id = ?1
             WINDOW w AS (ORDER BY created_at DESC, rowid DESC ROWS UNBOUNDED PRECEDING))
           WHERE n > ?2 OR total > ?3)
         RETURNING id",
    )
    .bind(owner)
    .bind(caps.photos)
    .bind(caps.bytes)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(gone)
}

#[derive(Deserialize)]
struct Relabel {
    kind: String,
    label_scryfall_id: Option<String>,
    label_name: Option<String>,
}

/// The person answered about a card whose photo is already kept (filed a card let go as "wrong",
/// corrected a printing after filing): its label changes; no second photo is kept.
async fn relabel(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, Json(r): Json<Relabel>) -> AppResult<Json<Value>> {
    st.limits.scan_samples.check_user(&user)?;
    if !ANSWERS.contains(&r.kind.as_str()) {
        return Err(AppError::BadRequest(format!("kind is {}", ANSWERS.join(", "))));
    }
    let done = sqlx::query("UPDATE scan_samples SET kind = ?, label_scryfall_id = ?, label_name = ?, labelled_at = ? WHERE id = ? AND owner_id = ?")
        .bind(&r.kind)
        .bind(text(r.label_scryfall_id))
        .bind(text(r.label_name))
        .bind(crate::util::now())
        .bind(&id)
        .bind(&user.id)
        .execute(&st.pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("No such scan photo"));
    }
    Ok(Json(json!({ "id": id, "kind": r.kind })))
}

/// One photo deleted, its files with it: the owner's own only.
async fn delete_one(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let gone: Option<String> = sqlx::query_scalar("DELETE FROM scan_samples WHERE id = ? AND owner_id = ? RETURNING id").bind(&id).bind(&user.id).fetch_optional(&st.pool).await?;
    let id = gone.ok_or(AppError::NotFound("No such scan photo"))?;
    remove_sample_files(&st.cfg.data_dir, &user.id, &id);
    Ok(Json(json!({ "deleted": 1 })))
}

/// The camera a row came from, as stats count it: what it said, or for a photo kept before
/// 22 Nov 2026 its camera label (the app's own camera says "native" in it).
const SOURCE_SQL: &str = "COALESCE(s.source, CASE WHEN s.camera LIKE '% native%' THEN 'native' WHEN s.camera IS NULL THEN 'unknown' ELSE 'browser' END)";

/// How a set of photos is made up: counts by kind, camera and mode, the crops they have, their
/// bytes, and the last 14 days, photo by photo. `owner` for one account's; `shared_only` for those
/// shared with Yama's developer (the corpus the export gives).
pub async fn stats(pool: &SqlitePool, owner: Option<&str>, shared_only: bool) -> AppResult<Value> {
    let scope = "(?1 IS NULL OR s.owner_id = ?1) AND (?2 = 0 OR s.shared = 1)";
    let (count, bytes, crop_bytes, accounts, shared, labelled, first, last): (i64, Option<i64>, Option<i64>, i64, Option<i64>, Option<i64>, Option<String>, Option<String>) =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*), SUM(s.bytes), SUM(s.crop_bytes), COUNT(DISTINCT s.owner_id), SUM(s.shared), SUM(s.labelled_at IS NOT NULL), MIN(s.created_at), MAX(s.created_at)
               FROM scan_samples s WHERE {scope}"
        )))
        .bind(owner)
        .bind(shared_only)
        .fetch_one(pool)
        .await?;
    let group = |by: &str| {
        sqlx::AssertSqlSafe(format!("SELECT {by} AS k, COUNT(*), SUM(s.bytes + s.crop_bytes) FROM scan_samples s WHERE {scope} GROUP BY k ORDER BY COUNT(*) DESC, k"))
    };
    let counted = |rows: Vec<(Option<String>, i64, Option<i64>)>| -> Vec<Value> {
        rows.into_iter().map(|(k, n, b)| json!({"name": k.unwrap_or_else(|| "unknown".into()), "photos": n, "bytes": b.unwrap_or(0)})).collect()
    };
    let kinds: Vec<(Option<String>, i64, Option<i64>)> = sqlx::query_as(group("s.kind")).bind(owner).bind(shared_only).fetch_all(pool).await?;
    let sources: Vec<(Option<String>, i64, Option<i64>)> = sqlx::query_as(group(SOURCE_SQL)).bind(owner).bind(shared_only).fetch_all(pool).await?;
    let modes: Vec<(Option<String>, i64, Option<i64>)> = sqlx::query_as(group("s.mode")).bind(owner).bind(shared_only).fetch_all(pool).await?;
    let rules: Vec<(Option<String>, i64, Option<i64>)> = sqlx::query_as(group("s.rule")).bind(owner).bind(shared_only).fetch_all(pool).await?;
    // Each crop's count and bytes, from the list in each row.
    let crops: Vec<(Option<String>, i64, Option<i64>)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT json_extract(j.value, '$.name') AS k, COUNT(*), SUM(json_extract(j.value, '$.bytes'))
           FROM scan_samples s, json_each(CASE WHEN json_valid(s.crops) THEN s.crops ELSE '[]' END) j
          WHERE {scope} GROUP BY k ORDER BY k"
    )))
    .bind(owner)
    .bind(shared_only)
    .fetch_all(pool)
    .await?;
    let with_all: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT COUNT(*) FROM scan_samples s WHERE {scope}
            AND (SELECT COUNT(DISTINCT json_extract(j.value, '$.name')) FROM json_each(CASE WHEN json_valid(s.crops) THEN s.crops ELSE '[]' END) j) = {}",
        CROP_NAMES.len()
    )))
    .bind(owner)
    .bind(shared_only)
    .fetch_one(pool)
    .await?;
    let since = (chrono::Utc::now() - chrono::Duration::days(13)).format("%Y-%m-%d").to_string();
    let days: Vec<(String, i64, Option<i64>, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT substr(s.created_at, 1, 10) AS day, COUNT(*), SUM(s.bytes + s.crop_bytes), SUM(s.kind = 'unconfirmed')
           FROM scan_samples s WHERE {scope} AND s.created_at >= ?3 GROUP BY day ORDER BY day"
    )))
    .bind(owner)
    .bind(shared_only)
    .bind(&since)
    .fetch_all(pool)
    .await?;
    let (bytes, crop_bytes) = (bytes.unwrap_or(0), crop_bytes.unwrap_or(0));
    Ok(json!({
        "count": count,
        "bytes": bytes,
        "crop_bytes": crop_bytes,
        "total_bytes": bytes + crop_bytes,
        "accounts": accounts,
        "shared": shared.unwrap_or(0),
        // Photos whose label a later answer changed (one photo per card, not two).
        "relabelled": labelled.unwrap_or(0),
        "first": first,
        "last": last,
        "kinds": counted(kinds),
        "sources": counted(sources),
        "modes": counted(modes),
        "rules": counted(rules),
        "crops": crops.into_iter().map(|(k, n, b)| json!({"name": k.unwrap_or_else(|| "unknown".into()), "photos": n, "bytes": b.unwrap_or(0)})).collect::<Vec<_>>(),
        "with_every_crop": with_all,
        "days": days.into_iter().map(|(day, n, b, u)| json!({"day": day, "photos": n, "bytes": b.unwrap_or(0), "unconfirmed": u})).collect::<Vec<_>>(),
    }))
}

/// The newest of an account's photos, as rows say them (no images): for checking what was kept.
pub async fn newest(pool: &SqlitePool, owner: &str, limit: i64) -> AppResult<Vec<Value>> {
    let rows: Vec<OwnSample> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT s.id, s.created_at, s.kind, s.label_name, s.guess_name, s.method, s.score, s.rule, s.lead, s.mode, {SOURCE_SQL} AS source,
                s.camera, s.bytes, s.crops, s.crop_bytes, s.shared, s.labelled_at
           FROM scan_samples s WHERE s.owner_id = ? ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?"
    )))
    .bind(owner)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let crops: Vec<Value> = r.crops.as_deref().and_then(|c| serde_json::from_str::<Vec<Value>>(c).ok()).unwrap_or_default();
            json!({
                "id": r.id, "created_at": r.created_at, "kind": r.kind, "label_name": r.label_name, "guess_name": r.guess_name,
                "method": r.method, "score": r.score, "rule": r.rule, "lead": r.lead, "mode": r.mode, "source": r.source,
                "camera": r.camera, "bytes": r.bytes, "crop_bytes": r.crop_bytes, "shared": r.shared, "labelled_at": r.labelled_at,
                "crops": crops,
            })
        })
        .collect())
}

#[derive(sqlx::FromRow)]
struct OwnSample {
    id: String,
    created_at: String,
    kind: String,
    label_name: Option<String>,
    guess_name: Option<String>,
    method: Option<String>,
    score: Option<f64>,
    rule: Option<String>,
    lead: Option<f64>,
    mode: Option<String>,
    source: String,
    camera: Option<String>,
    bytes: i64,
    crops: Option<String>,
    crop_bytes: i64,
    shared: bool,
    labelled_at: Option<String>,
}

/// The account's own photos, for Scan settings and `get_scan_photos`: how many, their bytes, how
/// they're made up and the caps.
pub async fn own_summary(pool: &SqlitePool, user: &User) -> AppResult<Value> {
    let mut out = stats(pool, Some(&user.id), false).await?;
    let caps = caps_for(user);
    out["keep"] = json!(caps.photos);
    out["keep_bytes"] = json!(caps.bytes);
    if let Some(o) = out.as_object_mut() {
        o.remove("accounts");
    }
    Ok(out)
}

/// How many photos this account has kept, their size (photos, and their crops) and how they're made up.
async fn summary(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    Ok(Json(own_summary(&st.pool, &user).await?))
}

async fn delete_all(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    // Only the folders of the rows this deleted: an upload still waiting to commit has written its
    // files already (as for scanner diagnostics).
    // Its moment is recorded with it, so an upload that began before can't arrive after (scan_clears.rs).
    let mut tx = st.pool.begin().await?;
    crate::scan_clears::mark(&mut tx, &user.id, crate::scan_clears::SAMPLES, &crate::scan_clears::stamp()).await?;
    let gone: Vec<String> = sqlx::query_scalar("DELETE FROM scan_samples WHERE owner_id = ? RETURNING id").bind(&user.id).fetch_all(&mut *tx).await?;
    tx.commit().await?;
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
    /// browser, native or photo; for a photo kept before 22 Nov 2026, from its camera label.
    pub source: String,
    pub mode: Option<String>,
    /// The rule that named the card, the art's lead and its best matches (JSON) when it was read by art.
    pub rule: Option<String>,
    pub lead: Option<f64>,
    #[serde(skip)]
    pub scores: Option<String>,
    /// When a later answer changed its label.
    pub labelled_at: Option<String>,
}

impl SharedSample {
    /// As the admin list and the export give it: the crops parsed, each with where it's read
    /// (under `key`: the admin's "url", the export's "file"), and the scores parsed.
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
        v["scores"] = self.scores.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or_else(|| json!([]));
        Ok(v)
    }
}

fn shared_columns() -> String {
    format!(
        "s.id, s.owner_id, u.display_name AS owner_name, s.created_at, s.kind, s.label_scryfall_id, s.label_name,
  s.guess_name, s.guess_scryfall_id, s.guess_illustration_id, s.method, s.score, s.quad, s.camera, s.bundle, s.models, s.bytes, s.crops, s.crop_bytes,
  {SOURCE_SQL} AS source, s.mode, s.rule, s.lead, s.scores, s.labelled_at"
    )
}

/// A date (midnight UTC) or an RFC 3339 moment, as the stored times are written (`util::now`: UTC,
/// to the second, `Z`), so the two compare as text. Codex review of #197: a moment with another
/// offset compared as text missed newer photos or took older ones.
pub fn since_utc(since: &str) -> Option<String> {
    let since = since.trim();
    if let Ok(at) = chrono::DateTime::parse_from_rfc3339(since) {
        return Some(at.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string());
    }
    chrono::NaiveDate::parse_from_str(since, "%Y-%m-%d").ok().map(|d| format!("{}T00:00:00Z", d.format("%Y-%m-%d")))
}

/// Shared photos, newest first: everyone's, or one account's (`owner`), made or labelled from
/// `since` (as [`since_utc`] gives it), before the cursor `before` (`created_at|id` of the last one already seen).
async fn shared_page(pool: &SqlitePool, owner: Option<&str>, since: Option<&str>, before: Option<(&str, &str)>, limit: i64) -> AppResult<Vec<SharedSample>> {
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {} FROM scan_samples s JOIN users u ON u.id = s.owner_id
          WHERE s.shared = 1 AND (?1 IS NULL OR s.owner_id = ?1) AND (?2 IS NULL OR s.created_at >= ?2 OR s.labelled_at >= ?2)
            AND (?3 IS NULL OR (s.created_at, s.id) < (?3, ?4))
          ORDER BY s.created_at DESC, s.id DESC LIMIT ?5",
        shared_columns()
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
    let since = match q.since.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(s) => Some(since_utc(s).ok_or_else(|| AppError::bad("since is a date (2026-11-22) or a moment (2026-11-22T10:00:00Z)"))?),
        None => None,
    };
    let samples = shared_page(&st.pool, q.owner.as_deref(), since.as_deref(), before, limit).await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_samples WHERE shared = 1").fetch_one(&st.pool).await?;
    let next = (samples.len() as i64 == limit).then(|| samples.last().map(|s| format!("{}|{}", s.created_at, s.id))).flatten();
    let samples = samples.iter().map(|s| s.json("url", |name| format!("/api/admin/scan-samples/{}/crops/{name}", s.id))).collect::<AppResult<Vec<_>>>()?;
    Ok(Json(json!({ "samples": samples, "total": total, "next": next })))
}

/// How the shared corpus is made up (every account's shared photos together): what the export gives.
async fn admin_stats(State(st): State<AppState>, AdminUser(_): AdminUser) -> AppResult<Json<Value>> {
    Ok(Json(stats(&st.pool, None, true).await?))
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
    let row: Option<(String, Option<Vec<u8>>)> = sqlx::query_as("SELECT owner_id, image FROM scan_samples WHERE id = ? AND shared = 1").bind(&id).fetch_optional(&st.pool).await?;
    let (owner, image) = row.ok_or(AppError::NotFound("No such scan photo"))?;
    let image = read_photo(&st.cfg.data_dir, &owner, &id, image)?.ok_or(AppError::NotFound("No such scan photo"))?;
    Ok(([(header::CONTENT_TYPE, "image/jpeg"), (header::CACHE_CONTROL, "private, max-age=3600")], image).into_response())
}

const EXPORT_USAGE: &str = "usage: yama-server scan-samples-export DIR [--since DATE] [--owner USER_ID]";

/// `yama-server scan-samples-export DIR [--since DATE] [--owner USER_ID]`: writes every shared
/// photo to DIR as `<id>.jpg`, its crops as `<id>.<name>.jpg`, with `manifest.jsonl` (one line per
/// photo: who, when and what was said, how the scanner named it with its scores, and its crops with
/// their file, width, height and bytes). `--since` takes the photos made or relabelled from then
/// (a photo relabelled after an earlier export comes again: keep the newest line per id). And
/// `shared_ids.txt`, every photo shared now, whatever `--since` and `--owner` say: a copy made
/// earlier drops what isn't in it (deleted since by Delete them, with its account, or by the caps).
/// For training and tuning the scanner; run on the server (`docker exec yama …`, or
/// scanner-lab/corpus_pull.sh) and copy DIR off.
pub async fn export_cli(pool: &SqlitePool, data_dir: &std::path::Path, args: &[String]) -> anyhow::Result<()> {
    let flag = |f: &str| args.iter().position(|a| a == f).and_then(|i| args.get(i + 1)).cloned();
    let dir = args.first().filter(|a| !a.starts_with("--")).context(EXPORT_USAGE)?;
    for (i, a) in args.iter().enumerate().skip(1) {
        let value_of_flag = args.get(i - 1).is_some_and(|p| p == "--since" || p == "--owner");
        anyhow::ensure!(value_of_flag || a == "--since" || a == "--owner", "{EXPORT_USAGE} ({a:?}?)");
    }
    let dir = std::path::Path::new(dir);
    std::fs::create_dir_all(dir)?;
    let since = match flag("--since") {
        Some(s) => Some(since_utc(&s).with_context(|| format!("--since {s:?} isn't a date (2026-11-22) or a moment (2026-11-22T10:00:00Z)"))?),
        None => None,
    };
    let owner = flag("--owner");
    let mut manifest = String::new();
    let mut before: Option<(String, String)> = None;
    let (mut n, mut crops, mut missing) = (0usize, 0usize, 0usize);
    loop {
        let page = shared_page(pool, owner.as_deref(), since.as_deref(), before.as_ref().map(|(a, b)| (a.as_str(), b.as_str())), 200).await?;
        for s in &page {
            // Ids are ours (crate::util::new_id): safe as file names, but checked anyway.
            anyhow::ensure!(plain_id(&s.id), "odd sample id {}", s.id);
            // Gone since its page was read (Delete them, or pushed out by the caps while the account
            // scans): left out, as is a row whose photo file is gone (a disk restored without it).
            let row: Option<Option<Vec<u8>>> = sqlx::query_scalar("SELECT image FROM scan_samples WHERE id = ? AND shared = 1").bind(&s.id).fetch_optional(pool).await?;
            let Some(image) = row.map(|image| read_photo(data_dir, &s.owner_id, &s.id, image)).transpose().map_err(|e| anyhow::anyhow!("{e}"))?.flatten() else {
                missing += 1;
                continue;
            };
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
    // Every photo shared now, read after the photos: one saved meanwhile is on the list too.
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM scan_samples WHERE shared = 1 ORDER BY id").fetch_all(pool).await?;
    std::fs::write(dir.join("shared_ids.txt"), ids.iter().map(|id| format!("{id}\n")).collect::<String>())?;
    let gone = if missing > 0 { format!(" ({missing} left out: gone meanwhile, or their photo file is missing)") } else { String::new() };
    println!("Wrote {n} shared scan photos, {crops} crops, manifest.jsonl and shared_ids.txt ({} shared) to {}{gone}", ids.len(), dir.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use axum::http::{Method, StatusCode};

    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 2, 3, 0xFF, 0xD9];

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn body(kind: &str) -> Value {
        json!({
            "image": b64(JPEG),
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

    fn data() -> std::path::PathBuf {
        std::env::temp_dir()
    }

    /// Every file an account keeps, as `<id>/<file>`.
    fn files(owner: &str) -> Vec<String> {
        let dir = owner_dir(&data(), owner);
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
        b["shared"] = json!(true);
        b["crops"] = json!([
            {"name": "symbol", "image": b64(JPEG), "width": 450, "height": 272},
            {"name": "strip", "image": b64(JPEG), "width": 1500, "height": 293},
            {"name": "card", "image": b64(JPEG), "width": 786, "height": 1100},
        ]);
        b
    }

    async fn get_bytes(app: &axum::Router, uri: String, token: &str) -> (StatusCode, Vec<u8>) {
        use tower::ServiceExt;
        let req = axum::http::Request::get(uri).header(axum::http::header::AUTHORIZATION, format!("Bearer {token}")).body(axum::body::Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        (res.status(), axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec())
    }

    async fn admin(pool: &SqlitePool) -> String {
        let (admin, token) = testutil::user(pool, &format!("admin-{}@example.com", crate::util::new_id())).await;
        sqlx::query("UPDATE users SET is_admin = 1 WHERE id = ?").bind(&admin).execute(pool).await.unwrap();
        token
    }

    #[tokio::test]
    async fn photos_are_kept_per_account_as_files_and_deleted_on_request() {
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
        assert_eq!(s["keep"], INVITED.photos);
        // Someone else sees none of them, and can't delete them.
        let (_, s) = testutil::send(&app, Method::GET, "/api/scan/samples", Some(&theirs), None).await;
        assert_eq!(s["count"], 0);
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/samples", Some(&theirs), None).await;
        assert_eq!(d["deleted"], 0);
        // The photo is a file beside its crops, not a blob in the database.
        let stored: (String, String, String, Option<String>, Option<Vec<u8>>) =
            sqlx::query_as("SELECT id, owner_id, kind, quad, image FROM scan_samples ORDER BY kind LIMIT 1").fetch_one(&pool).await.unwrap();
        assert_eq!(stored.1, me);
        assert_eq!(stored.2, "added");
        assert_eq!(stored.3.as_deref(), Some("[[1.0,2.0],[3.0,2.0],[3.0,5.0],[1.0,5.0]]"));
        assert_eq!(stored.4, None);
        assert_eq!(std::fs::read(owner_dir(&data(), &me).join(&stored.0).join(PHOTO_FILE)).unwrap(), JPEG);
        assert_eq!(files(&me).len(), 2);

        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/samples", Some(&mine), None).await;
        assert_eq!(d["deleted"], 2);
        assert!(files(&me).is_empty());
        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/samples", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_card_let_go_is_kept_unconfirmed_with_how_the_scanner_named_it() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let mut b = with_crops("unconfirmed");
        b["guess_scryfall_id"] = json!("p1");
        b["source"] = json!("native");
        b["mode"] = json!("identity");
        b["rule"] = json!("leads");
        b["lead"] = json!(0.123_456);
        b["scores"] = json!([
            {"name": "Sol Ring", "set": "cmm", "number": "1", "score": 0.912_345},
            {"name": "Mind Stone", "set": "cmm", "number": "2", "score": 0.7},
            {"name": "No score"},
        ]);
        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(b)).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        let id = res["id"].as_str().unwrap().to_string();
        type Row = (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<f64>, Option<String>);
        let row: Row = sqlx::query_as("SELECT kind, label_scryfall_id, label_name, guess_name, source, mode, rule, lead, scores FROM scan_samples WHERE id = ?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        // No answer from the person, whatever the body said; the scanner's guess and scores kept.
        assert_eq!(row.0, "unconfirmed");
        assert_eq!((row.1, row.2), (None, None));
        assert_eq!(row.3.as_deref(), Some("Sol Ring"));
        assert_eq!((row.4.as_deref(), row.5.as_deref(), row.6.as_deref()), (Some("native"), Some("identity"), Some("leads")));
        assert_eq!(row.7, Some(0.123));
        let scores: Value = serde_json::from_str(row.8.as_deref().unwrap()).unwrap();
        assert_eq!(scores, json!([{"name": "Sol Ring", "set": "cmm", "number": "1", "score": 0.912}, {"name": "Mind Stone", "set": "cmm", "number": "2", "score": 0.7}]));
        // Three crops, the whole card among them, each a file beside the photo.
        assert_eq!(files(&me), [format!("{id}/card.jpg"), format!("{id}/photo.jpg"), format!("{id}/strip.jpg"), format!("{id}/symbol.jpg")]);
        // An unknown source, mode or rule is dropped, not refused.
        let mut odd = body("unconfirmed");
        odd["source"] = json!("webcam");
        odd["rule"] = json!("guess");
        odd["mode"] = json!("deck");
        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(odd)).await;
        assert_eq!(status, StatusCode::OK);
        let row: (Option<String>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT source, rule, mode FROM scan_samples WHERE id = ?").bind(res["id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
        assert_eq!(row, (None, None, None));
        remove_owner_files(&data(), &me);
    }

    #[tokio::test]
    async fn a_later_answer_relabels_the_photo_only_for_its_owner() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let (_, theirs) = testutil::user(&pool, "them@example.com").await;
        let (_, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(body("wrong"))).await;
        let id = res["id"].as_str().unwrap().to_string();
        let path = format!("/api/scan/samples/{id}");
        let answer = json!({"kind": "corrected", "label_scryfall_id": "p2", "label_name": "Arcane Signet"});
        // Not someone else's, nor back to unconfirmed, nor a kind that isn't one.
        let (status, _) = testutil::send(&app, Method::PATCH, &path, Some(&theirs), Some(answer.clone())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        for kind in ["unconfirmed", "guess"] {
            let (status, _) = testutil::send(&app, Method::PATCH, &path, Some(&mine), Some(json!({"kind": kind}))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{kind}");
        }
        let (status, res) = testutil::send(&app, Method::PATCH, &path, Some(&mine), Some(answer)).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        let row: (String, Option<String>, Option<String>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT kind, label_scryfall_id, label_name, guess_name, labelled_at FROM scan_samples WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
        assert_eq!((row.0.as_str(), row.1.as_deref(), row.2.as_deref()), ("corrected", Some("p2"), Some("Arcane Signet")));
        // What the scanner said stays; one photo, not two.
        assert_eq!(row.3.as_deref(), Some("Sol Ring"));
        assert!(row.4.is_some());
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_samples WHERE owner_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1);
        let (_, s) = testutil::send(&app, Method::GET, "/api/scan/samples", Some(&mine), None).await;
        assert_eq!(s["relabelled"], 1);
        // One photo deleted by its id: only by its owner, files and all.
        let (status, _) = testutil::send(&app, Method::DELETE, &path, Some(&theirs), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(files(&me), [format!("{id}/photo.jpg")]);
        let (status, d) = testutil::send(&app, Method::DELETE, &path, Some(&mine), None).await;
        assert_eq!((status, d["deleted"].as_i64()), (StatusCode::OK, Some(1)));
        assert!(files(&me).is_empty());
        // A photo deleted meanwhile: nothing to relabel.
        let (status, _) = testutil::send(&app, Method::PATCH, &path, Some(&mine), Some(json!({"kind": "added"}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        remove_owner_files(&data(), &me);
    }

    #[tokio::test]
    async fn the_admin_sees_only_photos_saved_as_shared() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let admin_token = admin(&pool).await;

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
        // From its camera label, for a photo that didn't say.
        assert_eq!(rows[0]["source"], "browser");
        assert!(rows[0].get("image").is_none());

        let image = |id: &str, token: &str| {
            let (app, uri, token) = (app.clone(), format!("/api/admin/scan-samples/{id}/image"), token.to_string());
            async move { get_bytes(&app, uri, &token).await }
        };
        let (status, bytes) = image(shared["id"].as_str().unwrap(), &admin_token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, JPEG);
        let (status, _) = image(private["id"].as_str().unwrap(), &admin_token).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // Not an admin: as if the routes didn't exist.
        let (status, _) = testutil::send(&app, Method::GET, "/api/admin/scan-samples", Some(&mine), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = testutil::send(&app, Method::GET, "/api/admin/scan-samples/stats", Some(&mine), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = image(shared["id"].as_str().unwrap(), &mine).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // The corpus's make-up counts the shared photo only.
        let (status, stats) = testutil::send(&app, Method::GET, "/api/admin/scan-samples/stats", Some(&admin_token), None).await;
        assert_eq!(status, StatusCode::OK, "{stats}");
        assert_eq!(stats["count"], 1);
        assert_eq!(stats["kinds"], json!([{"name": "corrected", "photos": 1, "bytes": JPEG.len()}]));

        // The export writes the shared one only.
        let dir = data().join(format!("yama-scan-export-{}", crate::util::new_id()));
        export_cli(&pool, &data(), &[dir.to_string_lossy().into_owned()]).await.unwrap();
        let manifest = std::fs::read_to_string(dir.join("manifest.jsonl")).unwrap();
        assert_eq!(manifest.lines().count(), 1);
        assert!(manifest.contains(shared["id"].as_str().unwrap()));
        assert_eq!(std::fs::read(dir.join(format!("{}.jpg", shared["id"].as_str().unwrap()))).unwrap(), JPEG);
        assert!(!dir.join(format!("{}.jpg", private["id"].as_str().unwrap())).exists());
        std::fs::remove_dir_all(&dir).unwrap();
        remove_owner_files(&data(), &me);
    }

    #[tokio::test]
    async fn a_photo_kept_in_the_database_before_still_reads() {
        let (app, pool) = testutil::app().await;
        let (me, _) = testutil::user(&pool, "me@example.com").await;
        let admin_token = admin(&pool).await;
        // As migration 0106 left a photo kept before it: the JPEG in the row, no photo file.
        let old = b"\xFF\xD8\xFF old photo";
        sqlx::query("INSERT INTO scan_samples (id, owner_id, created_at, kind, image, bytes, shared, camera) VALUES ('olddb', ?, '2026-11-16T00:00:00Z', 'added', ?, ?, 1, '2160×3840 native main 60fps')")
            .bind(&me)
            .bind(old.as_slice())
            .bind(old.len() as i64)
            .execute(&pool)
            .await
            .unwrap();
        let (status, bytes) = get_bytes(&app, "/api/admin/scan-samples/olddb/image".into(), &admin_token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, old);
        let (_, list) = testutil::send(&app, Method::GET, "/api/admin/scan-samples", Some(&admin_token), None).await;
        assert_eq!(list["samples"][0]["source"], "native");
        let dir = data().join(format!("yama-scan-export-{}", crate::util::new_id()));
        export_cli(&pool, &data(), &[dir.to_string_lossy().into_owned()]).await.unwrap();
        assert_eq!(std::fs::read(dir.join("olddb.jpg")).unwrap(), old);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn crops_go_with_their_photo_and_are_shared_as_it_is() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let admin_token = admin(&pool).await;

        let mut b = with_crops("added");
        b["rule"] = json!("sure");
        b["scores"] = json!([{"name": "Sol Ring", "set": "cmm", "number": "1", "score": 0.95}]);
        let (status, shared) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(b)).await;
        assert_eq!(status, StatusCode::OK, "{shared}");
        let id = shared["id"].as_str().unwrap().to_string();
        // Files, not database rows; the row lists the crops with their sizes.
        assert_eq!(files(&me), [format!("{id}/card.jpg"), format!("{id}/photo.jpg"), format!("{id}/strip.jpg"), format!("{id}/symbol.jpg")]);
        let (crops, crop_bytes): (String, i64) = sqlx::query_as("SELECT crops, crop_bytes FROM scan_samples WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
        assert_eq!(crop_bytes, 3 * JPEG.len() as i64);
        let crops: Value = serde_json::from_str(&crops).unwrap();
        assert_eq!(crops[0], json!({"name": "symbol", "width": 450, "height": 272, "bytes": JPEG.len()}));
        assert_eq!(crops[2], json!({"name": "card", "width": 786, "height": 1100, "bytes": JPEG.len()}));
        let (_, sum) = testutil::send(&app, Method::GET, "/api/scan/samples", Some(&mine), None).await;
        assert_eq!(sum["crop_bytes"], 3 * JPEG.len() as i64);
        assert_eq!(sum["with_every_crop"], 1);
        assert_eq!(sum["crops"], json!([{"name": "card", "photos": 1, "bytes": JPEG.len()}, {"name": "strip", "photos": 1, "bytes": JPEG.len()}, {"name": "symbol", "photos": 1, "bytes": JPEG.len()}]));

        // A photo saved before sharing keeps its crops private too.
        let mut private = with_crops("corrected");
        private["shared"] = json!(false);
        let (_, private) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(private)).await;
        let private = private["id"].as_str().unwrap().to_string();

        // The admin reads a shared photo's crops; not a private one's, nor a name it doesn't list.
        let get = |uri: String, token: String| {
            let app = app.clone();
            async move { get_bytes(&app, uri, &token).await }
        };
        let (_, list) = testutil::send(&app, Method::GET, "/api/admin/scan-samples", Some(&admin_token), None).await;
        assert_eq!(list["samples"][0]["crops"][2]["url"], format!("/api/admin/scan-samples/{id}/crops/card"));
        assert_eq!(list["samples"][0]["crop_bytes"], 3 * JPEG.len() as i64);
        assert_eq!(list["samples"][0]["scores"][0]["name"], "Sol Ring");
        for name in ["symbol", "card"] {
            let (status, bytes) = get(format!("/api/admin/scan-samples/{id}/crops/{name}"), admin_token.clone()).await;
            assert_eq!(status, StatusCode::OK, "{name}");
            assert_eq!(bytes, JPEG);
        }
        let (status, _) = get(format!("/api/admin/scan-samples/{private}/crops/symbol"), admin_token.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = get(format!("/api/admin/scan-samples/{id}/crops/photo"), admin_token.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = get(format!("/api/admin/scan-samples/{id}/crops/..%2F..%2Fyama"), admin_token.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = get(format!("/api/admin/scan-samples/{id}/crops/symbol"), mine.clone()).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // The export writes the shared photo's crops beside it, with their sizes, the rule and the
        // scores in the manifest.
        let dir = data().join(format!("yama-scan-export-{}", crate::util::new_id()));
        export_cli(&pool, &data(), &[dir.to_string_lossy().into_owned()]).await.unwrap();
        let manifest: Value = serde_json::from_str(std::fs::read_to_string(dir.join("manifest.jsonl")).unwrap().trim()).unwrap();
        assert_eq!(manifest["crops"][0], json!({"name": "symbol", "width": 450, "height": 272, "bytes": JPEG.len(), "file": format!("{id}.symbol.jpg")}));
        assert_eq!(manifest["crops"][2]["file"], format!("{id}.card.jpg"));
        assert_eq!(manifest["rule"], "sure");
        assert_eq!(manifest["scores"][0]["score"], 0.95);
        assert_eq!(std::fs::read(dir.join(format!("{id}.card.jpg"))).unwrap(), JPEG);
        assert_eq!(std::fs::read(dir.join(format!("{id}.jpg"))).unwrap(), JPEG);
        assert!(!dir.join(format!("{private}.strip.jpg")).exists());
        std::fs::remove_dir_all(&dir).unwrap();

        // Delete them takes the files, and an old folder left with no row (a server stopped
        // between the files and the row); not a young one, which may be an upload on its way.
        let orphan = owner_dir(&data(), &me).join("orphan");
        let young = owner_dir(&data(), &me).join("young");
        for d in [&orphan, &young] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("strip.jpg"), JPEG).unwrap();
        }
        std::fs::File::open(&orphan).unwrap().set_modified(std::time::SystemTime::now() - 2 * ORPHAN_AGE).unwrap();
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/samples", Some(&mine), None).await;
        assert_eq!(d["deleted"], 2);
        assert_eq!(files(&me), ["young/strip.jpg"]);
        remove_owner_files(&data(), &me);
    }

    #[tokio::test]
    async fn the_export_takes_photos_made_or_relabelled_since() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let mut ids = Vec::new();
        for kind in ["unconfirmed", "wrong", "added"] {
            let mut b = body(kind);
            b["shared"] = json!(true);
            let (_, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(b)).await;
            ids.push(res["id"].as_str().unwrap().to_string());
        }
        // Two made long ago; one of them answered just now.
        sqlx::query("UPDATE scan_samples SET created_at = '2026-01-01T00:00:00Z' WHERE id IN (?, ?)").bind(&ids[0]).bind(&ids[1]).execute(&pool).await.unwrap();
        let (status, _) = testutil::send(&app, Method::PATCH, &format!("/api/scan/samples/{}", ids[1]), Some(&mine), Some(json!({"kind": "corrected", "label_name": "Sol Ring"}))).await;
        assert_eq!(status, StatusCode::OK);
        let dir = data().join(format!("yama-scan-export-{}", crate::util::new_id()));
        let args = [dir.to_string_lossy().into_owned(), "--since".into(), "2026-06-01".into()];
        export_cli(&pool, &data(), &args).await.unwrap();
        let lines: Vec<Value> = std::fs::read_to_string(dir.join("manifest.jsonl")).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let got: std::collections::BTreeSet<&str> = lines.iter().map(|l| l["id"].as_str().unwrap()).collect();
        assert_eq!(got, [ids[1].as_str(), ids[2].as_str()].into_iter().collect());
        let relabelled = lines.iter().find(|l| l["id"] == ids[1].as_str()).unwrap();
        assert_eq!(relabelled["kind"], "corrected");
        assert!(relabelled["labelled_at"].is_string());
        // Every photo shared now, whatever --since said, so a copy made before can drop the rest.
        let mut shared: Vec<String> = std::fs::read_to_string(dir.join("shared_ids.txt")).unwrap().lines().map(str::to_owned).collect();
        let mut all = ids.clone();
        all.sort();
        shared.sort();
        assert_eq!(shared, all);
        std::fs::remove_dir_all(&dir).unwrap();
        // Everything without it, the unconfirmed one included; a flag it doesn't know is refused.
        let dir = data().join(format!("yama-scan-export-{}", crate::util::new_id()));
        export_cli(&pool, &data(), &[dir.to_string_lossy().into_owned()]).await.unwrap();
        let manifest = std::fs::read_to_string(dir.join("manifest.jsonl")).unwrap();
        assert_eq!(manifest.lines().count(), 3);
        assert!(manifest.contains("\"kind\":\"unconfirmed\""));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(export_cli(&pool, &data(), &[dir.to_string_lossy().into_owned(), "--kind".into(), "added".into()]).await.is_err());
        assert!(export_cli(&pool, &data(), &[dir.to_string_lossy().into_owned(), "--since".into(), "last week".into()]).await.is_err());
        // A moment with an offset is the instant it names: 02:00 at +02:00 is midnight UTC, before
        // the photo made now, so it's taken.
        let dir = data().join(format!("yama-scan-export-{}", crate::util::new_id()));
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        export_cli(&pool, &data(), &[dir.to_string_lossy().into_owned(), "--since".into(), format!("{today}T02:00:00+02:00")]).await.unwrap();
        assert!(std::fs::read_to_string(dir.join("manifest.jsonl")).unwrap().contains(ids[2].as_str()));
        std::fs::remove_dir_all(&dir).unwrap();
        remove_owner_files(&data(), &me);
    }

    #[tokio::test]
    async fn a_photo_begun_before_delete_them_isnt_kept() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        let (_, d) = testutil::send(&app, Method::DELETE, "/api/scan/samples", Some(&token), None).await;
        assert_eq!(d["deleted"], 0);
        let marked: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_clears WHERE owner_id = ? AND kind = 'samples'").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(marked, 1);
        // A deletion later than this upload's start: refused, its files removed.
        sqlx::query("UPDATE scan_clears SET cleared_at = '9999-01-01T00:00:00.000Z' WHERE owner_id = ?").bind(&me).execute(&pool).await.unwrap();
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(with_crops("added"))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_samples WHERE owner_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0);
        assert!(files(&me).is_empty());
        // An upload begun after the deletion is kept.
        sqlx::query("UPDATE scan_clears SET cleared_at = '2000-01-01T00:00:00.000Z' WHERE owner_id = ?").bind(&me).execute(&pool).await.unwrap();
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(with_crops("added"))).await;
        assert_eq!(status, StatusCode::OK);
        remove_owner_files(&data(), &me);
    }

    #[tokio::test]
    async fn files_go_with_the_caps_and_the_account() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        // An old photo whose crops reach the total cap: the next photo pushes it out, files and all.
        sqlx::query("INSERT INTO scan_samples (id, owner_id, created_at, kind, image, bytes, crops, crop_bytes) VALUES ('old', ?, '2026-01-01T00:00:00Z', 'added', x'FFD8FF', 3, '[{\"name\":\"strip\"}]', ?)")
            .bind(&me)
            .bind(INVITED.bytes)
            .execute(&pool)
            .await
            .unwrap();
        let old = owner_dir(&data(), &me).join("old");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("strip.jpg"), JPEG).unwrap();
        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(with_crops("added"))).await;
        assert_eq!(status, StatusCode::OK, "{res}");
        let left: Vec<String> = sqlx::query_scalar("SELECT id FROM scan_samples WHERE owner_id = ?").bind(&me).fetch_all(&pool).await.unwrap();
        assert_eq!(left, [res["id"].as_str().unwrap().to_string()]);
        assert!(!old.exists());
        assert_eq!(files(&me).len(), 4);

        // Refused: an unknown crop, the same one twice, one that isn't a JPEG. Nothing is written.
        let mut b = with_crops("added");
        b["crops"][0]["name"] = json!("frame");
        assert_eq!(testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b)).await.0, StatusCode::BAD_REQUEST);
        let mut b = with_crops("added");
        b["crops"][1]["name"] = json!("symbol");
        assert_eq!(testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b)).await.0, StatusCode::BAD_REQUEST);
        let mut b = with_crops("added");
        b["crops"][2]["image"] = json!(b64(b"\x89PNG\r\n"));
        assert_eq!(testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b)).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(files(&me).len(), 4);

        // With the account, files and all.
        let (status, report) = testutil::send(&app, Method::DELETE, "/api/me", Some(&token), Some(json!({"confirm_email": "me@example.com"}))).await;
        assert_eq!(status, StatusCode::OK, "{report}");
        assert!(!owner_dir(&data(), &me).exists());
    }

    #[tokio::test]
    async fn refuses_what_isnt_a_small_jpeg_or_a_known_kind() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        let mut b = body("guess");
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        b["kind"] = json!("added");
        b["image"] = json!(b64(b"\x89PNG\r\n"));
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let mut big = JPEG.to_vec();
        big.resize(MAX_IMAGE + 1, 0);
        b["image"] = json!(b64(&big));
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(b)).await;
        assert!(status == StatusCode::BAD_REQUEST || status == StatusCode::PAYLOAD_TOO_LARGE, "{status}");
        assert!(files(&me).is_empty());
    }

    #[tokio::test]
    async fn nothing_is_kept_while_the_disk_is_low() {
        let pool = crate::db::test_pool().await;
        let cfg = crate::config::Config { scan_photos_min_free: u64::MAX, ..testutil::config() };
        let app = crate::routes::app(testutil::state_with(cfg, pool.clone()).await);
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(with_crops("added"))).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(files(&me).is_empty());
    }

    #[test]
    fn since_is_compared_as_the_stored_utc_times() {
        assert_eq!(since_utc("2026-11-22").as_deref(), Some("2026-11-22T00:00:00Z"));
        assert_eq!(since_utc("2026-11-22T10:00:00Z").as_deref(), Some("2026-11-22T10:00:00Z"));
        // Another offset is the same instant in UTC, not its text.
        assert_eq!(since_utc("2026-11-22T10:00:00+02:00").as_deref(), Some("2026-11-22T08:00:00Z"));
        assert_eq!(since_utc("2026-11-21T22:30:00.250-05:00").as_deref(), Some("2026-11-22T03:30:00Z"));
        assert_eq!(since_utc("yesterday"), None);
        assert_eq!(since_utc("2026-13-01"), None);
    }

    #[test]
    fn an_invited_account_keeps_more_than_an_open_one() {
        let user = |limited: bool| User { id: "u".into(), email: "u@example.com".into(), display_name: "U".into(), is_admin: false, limited, power: false, guest: false };
        assert_eq!(caps_for(&user(false)), INVITED);
        assert_eq!(caps_for(&user(true)), OPEN);
        assert!(OPEN.photos < INVITED.photos && OPEN.bytes < INVITED.bytes);
    }

    /// `n` photos for `owner`, older than now, made in one statement.
    async fn fill(pool: &SqlitePool, owner: &str, n: i64, bytes: i64) {
        sqlx::query(
            "WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?2)
             INSERT INTO scan_samples (id, owner_id, created_at, kind, image, bytes)
             SELECT 'old' || i, ?1, printf('2026-01-01T00:%02d:%02dZ', (i / 60) % 60, i % 60), 'added', x'FFD8FF', ?3 FROM k",
        )
        .bind(owner)
        .bind(n)
        .bind(bytes)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn keeps_no_more_than_the_byte_cap() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        fill(&pool, &me, 2, INVITED.bytes / 2).await;
        let (status, _) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(body("added"))).await;
        assert_eq!(status, StatusCode::OK);
        let left: Vec<String> = sqlx::query_scalar("SELECT id FROM scan_samples WHERE owner_id = ? AND id LIKE 'old%' ORDER BY id").bind(&me).fetch_all(&pool).await.unwrap();
        assert_eq!(left, ["old2"]);
        remove_owner_files(&data(), &me);
    }

    #[tokio::test]
    async fn keeps_only_the_newest() {
        let (app, pool) = testutil::app().await;
        let (me, token) = testutil::user(&pool, "me@example.com").await;
        // Filled to an invited account's cap, older than now.
        fill(&pool, &me, INVITED.photos, 3).await;
        let (status, res) = testutil::send(&app, Method::POST, "/api/scan/samples", Some(&token), Some(body("added"))).await;
        assert_eq!(status, StatusCode::OK);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_samples WHERE owner_id = ?").bind(&me).fetch_one(&pool).await.unwrap();
        assert_eq!(count, INVITED.photos);
        let newest: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM scan_samples WHERE id = ?").bind(res["id"].as_str().unwrap()).fetch_one(&pool).await.unwrap();
        assert_eq!(newest, 1);
        // An open account's smaller cap, on the same rows.
        let gone = save(&pool, &me, "next", "added", "b".into(), 3, None, 0, text_row(), "2000-01-01T00:00:00.000Z", OPEN).await.unwrap();
        assert_eq!(gone.len() as i64, INVITED.photos + 1 - OPEN.photos);
        remove_owner_files(&data(), &me);
    }

    fn text_row() -> SampleText {
        SampleText {
            label_scryfall_id: None,
            label_name: None,
            guess_name: None,
            guess_scryfall_id: None,
            guess_illustration_id: None,
            method: None,
            score: None,
            quad: None,
            camera: None,
            models: None,
            shared: false,
            source: None,
            mode: None,
            rule: None,
            lead: None,
            scores: None,
        }
    }

    #[tokio::test]
    async fn the_make_up_counts_kinds_cameras_and_days() {
        let (app, pool) = testutil::app().await;
        let (me, mine) = testutil::user(&pool, "me@example.com").await;
        let (_, theirs) = testutil::user(&pool, "them@example.com").await;
        for (kind, source) in [("unconfirmed", "native"), ("unconfirmed", "native"), ("added", "browser"), ("wrong", "photo")] {
            let mut b = with_crops(kind);
            b["source"] = json!(source);
            assert_eq!(testutil::send(&app, Method::POST, "/api/scan/samples", Some(&mine), Some(b)).await.0, StatusCode::OK);
        }
        testutil::send(&app, Method::POST, "/api/scan/samples", Some(&theirs), Some(body("added"))).await;
        let s = own_summary(&pool, &User { id: me.clone(), email: "me@example.com".into(), display_name: "me".into(), is_admin: false, limited: false, power: false, guest: false }).await.unwrap();
        assert_eq!(s["count"], 4);
        assert_eq!(s["total_bytes"], 4 * 4 * JPEG.len() as i64);
        assert_eq!(s["kinds"][0], json!({"name": "unconfirmed", "photos": 2, "bytes": 2 * 4 * JPEG.len()}));
        assert_eq!(s["sources"][0]["name"], "native");
        assert_eq!(s["with_every_crop"], 4);
        assert_eq!(s["days"].as_array().unwrap().len(), 1);
        assert_eq!(s["days"][0]["photos"], 4);
        assert_eq!(s["days"][0]["unconfirmed"], 2);
        assert!(s.get("accounts").is_none());
        // Everyone's shared photos together, for the admin: two accounts.
        let all = stats(&pool, None, true).await.unwrap();
        assert_eq!(all["count"], 4);
        assert_eq!(all["accounts"], 1);
        let any = stats(&pool, None, false).await.unwrap();
        assert_eq!((any["count"].as_i64(), any["accounts"].as_i64()), (Some(5), Some(2)));
        // The newest rows, no images.
        let rows = newest(&pool, &me, 2).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["source"], "photo");
        assert_eq!(rows[0]["crops"].as_array().unwrap().len(), 3);
        remove_owner_files(&data(), &me);
    }
}
