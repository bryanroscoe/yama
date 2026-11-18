//! The card scanner's server side (web/src/scanner, docs/scanner.md).
//!
//! - The art recognition bundle: three ONNX graphs and an index of artworks, published by
//!   ManaVault (MPL-2.0, github.com/cfbender/manavault). One pinned version is downloaded once into
//!   `data/scan-bundle/<version>/`, checked against the SHA-256 sums below, and served to the app
//!   from `/scan-bundle/<version>/` so phones never fetch it from GitHub and it works offline once
//!   cached. Nothing is downloaded until the server's card imports run or someone opens the scanner.
//! - Yama's own query embedder (`QUERY_MODEL`, docs/scanner.md, "Yama's query embedder"): a
//!   fine-tuned copy of the bundle's `embed.onnx`, published as a release asset of this
//!   repository, downloaded and checked the same way into the bundle's folder under its own name,
//!   and served as the bundle's embed graph while it fits the bundle's gallery.
//! - `GET /api/scan/printings`: every printing that shares a recognised artwork, so the scanner
//!   only has to tell those apart (collector line, or the person picks).
//! - `GET /api/scan/sets` and `GET /api/scan/set?code=`: the sets to lock a scan to, and one set's
//!   printings with their artworks, so a locked scan matches only that set's art and files its
//!   printing without reading the collector line (docs/scanner.md, "Set lock").

use crate::auth::CurrentUser;
use crate::cards::{Printing, PRINTING_SELECT};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use anyhow::Context;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::AssertSqlSafe;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tower_http::services::ServeDir;

/// The pinned bundle. To move to a newer one, change the tag, sizes and sums (from the release's
/// SHA256SUMS and manifest.json), check the search graph's inputs still match `recognizer.ts`
/// (this one added `mask`), run the recognizer eval (docs/scanner.md) and note the result.
pub const BUNDLE_VERSION: &str = "gallery-20261106T183001884398Z";
const RELEASE_URL: &str = "https://github.com/cfbender/manavault/releases/download/scanner-bundle-";
const FILES: [(&str, u64, &str); 5] = [
    ("manifest.json", 2_146, "cee5b38ede2100bb05fed174988bb296fb1a7944b41d8393547d499ecd0610ca"),
    ("detector.onnx", 12_576_317, "1e8cdd520dce3570ca2f24c270ac39cc7ac0639d0504c3032b7850fbf8c0c771"),
    ("embed.onnx", 5_118_408, "f71739bbe6804cd442ddb0a40ec1f22f62c47991fc9cf7a4f445257e8081fb7c"),
    ("search.onnx", 14_240_610, "02a7352f2479c40beb6d463a11eba4c3bf3a26e87d2730afeed87dd29d32d938"),
    ("arts.json", 18_083_400, "df8164150343bb5dc85b39b5d1ba3893c124105eef1d6af9f393bb038d7d977f"),
];
/// The artwork index reduced to what the scanner reads (about a third of arts.json), gzipped.
pub(crate) const ARTS: &str = "arts.slim.json";
/// After a failed download, wait this long before trying again.
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

/// Yama's own query embedder (docs/scanner.md, "Yama's query embedder", 18 Nov 2026): the bundle's
/// `embed.onnx` with its embedding half fine-tuned on simulated sleeved, glare and blue-box
/// captures against the bundle's frozen gallery (scanner-lab/). Derived from ManaVault's MPL-2.0
/// weights, so the file is MPL-2.0; it is a release asset of this repository. Phones run it in
/// place of the bundle's `embed.onnx`: same inputs (`scene`, `quad`) and output (`embeddings`).
/// The gallery side stays the bundle's (search.onnx, arts.json, and scan_art.rs's supplement,
/// which embeds new art with the bundle's own `embed.onnx`). Served only with a bundle made by
/// the recogniser it was trained against, while `YAMA_SCAN_QUERY_MODEL` allows it, and once it's
/// downloaded; otherwise phones get the bundle's own `embed.onnx` as before. To pin a newer one,
/// change all five fields together and run the recognizer eval (docs/scanner.md).
pub(crate) struct QueryModel {
    /// What diagnostics and kept scan photos call it (their `bundle`, after a `+`).
    pub name: &'static str,
    pub url: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    /// The bundle manifest's `recogniser.sha256`: the checkpoint whose gallery it was trained
    /// against. A bundle from a newer checkpoint names another, and gets its own `embed.onnx`.
    pub recogniser: &'static str,
}

pub(crate) const QUERY_MODEL: QueryModel = QueryModel {
    name: "yama-art-20261118",
    url: "https://github.com/bryanroscoe/yama/releases/download/scanner-art-20261118/yama-art-20261118.onnx",
    bytes: 5_139_404,
    sha256: "52420d900728e25e2c4733c7fce45dbea0ae7f4f244fa027421a0f00cdd8faee",
    recogniser: "eb6558461672b30c8b699570cc1669c4baa1a31d5fd28d617800e8a1f4d2e2c3",
};

impl QueryModel {
    /// Its file in the bundle's folder. Never `embed.onnx`, which scan_art.rs embeds new art with.
    pub fn file(&self) -> String {
        format!("query-{}.onnx", &self.sha256[..12])
    }

    /// Whether its vectors compare with the gallery of the bundle this manifest describes.
    fn fits(&self, manifest: &serde_json::Value) -> bool {
        manifest.pointer("/recogniser/sha256").and_then(serde_json::Value::as_str) == Some(self.recogniser)
    }

    /// Downloaded and whole in `dir` (its checksum was checked before it got its name).
    async fn is_in(&self, dir: &Path) -> bool {
        tokio::fs::metadata(dir.join(self.file())).await.is_ok_and(|m| m.is_file() && m.len() == self.bytes)
    }
}

pub fn router(data_dir: &Path) -> Router<AppState> {
    // Public like /ocr/: model files, no one's data. The version is in the path, so they never change.
    let files = Router::new()
        .nest_service(&format!("/scan-bundle/{BUNDLE_VERSION}"), ServeDir::new(bundle_dir(data_dir)).precompressed_gzip())
        .layer(axum::middleware::map_response(|mut res: axum::response::Response| async move {
            if res.status().is_success() {
                res.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
            }
            res
        }));
    Router::new()
        .route("/api/scan/bundle", get(bundle_info))
        .route("/api/scan/printings", get(printings_by_art))
        .route("/api/scan/sets", get(scan_sets))
        .route("/api/scan/set", get(set_printings))
        .merge(files)
}

pub(crate) fn bundle_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("scan-bundle").join(BUNDLE_VERSION)
}

enum Fetch {
    Idle,
    Running,
    Failed(String, Instant),
}

fn fetch_state() -> &'static Mutex<Fetch> {
    static STATE: OnceLock<Mutex<Fetch>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Fetch::Idle))
}

fn query_state() -> &'static Mutex<Fetch> {
    static STATE: OnceLock<Mutex<Fetch>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(Fetch::Idle))
}

pub(crate) fn is_ready(dir: &Path) -> bool {
    FILES.iter().all(|(name, _, _)| *name == "arts.json" || dir.join(name).exists()) && dir.join(format!("{ARTS}.gz")).exists()
}

/// Download the bundle in the background unless it's here, already downloading, or failed
/// recently. Returns the last failure, if any.
pub async fn ensure(data_dir: PathBuf, http: reqwest::Client) -> Option<String> {
    let dir = bundle_dir(&data_dir);
    if is_ready(&dir) {
        return None;
    }
    let mut state = fetch_state().lock().await;
    match &*state {
        Fetch::Running => return None,
        Fetch::Failed(e, at) if at.elapsed() < RETRY_AFTER => return Some(e.clone()),
        _ => {}
    }
    *state = Fetch::Running;
    tokio::spawn(async move {
        let result = download(&http, &dir).await;
        let mut state = fetch_state().lock().await;
        *state = match result {
            Ok(()) => {
                tracing::info!(version = BUNDLE_VERSION, "scanner bundle ready");
                Fetch::Idle
            }
            Err(e) => {
                tracing::warn!(error = %format!("{e:#}"), "scanner bundle download failed");
                Fetch::Failed(format!("{e:#}"), Instant::now())
            }
        };
    });
    None
}

pub(crate) async fn download(http: &reqwest::Client, dir: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    for (name, bytes, sha) in FILES {
        let path = dir.join(name);
        if path.exists() || (name == "arts.json" && dir.join(format!("{ARTS}.gz")).exists()) {
            continue;
        }
        fetch_checked(http, &format!("{RELEASE_URL}{BUNDLE_VERSION}/{name}"), dir, name, bytes, sha).await?;
    }
    let raw = tokio::fs::read(dir.join("arts.json")).await?;
    let slim = tokio::task::spawn_blocking(move || slim_arts(&raw)).await??;
    let gz = dir.join(format!("{ARTS}.gz"));
    let part = dir.join(format!("{ARTS}.gz.part"));
    tokio::fs::write(&part, gzip(&slim)?).await?;
    // ServeDir serves the .gz to browsers that accept it; the plain file is for anything else.
    tokio::fs::write(dir.join(ARTS), &slim).await?;
    tokio::fs::rename(&part, &gz).await?;
    let _ = tokio::fs::remove_file(dir.join("arts.json")).await;
    if let Some(root) = dir.parent() {
        remove_other_bundles(root).await;
    }
    Ok(())
}

/// Download `url` to `dir/name`, which it gets only once its size and SHA-256 are the pinned ones.
async fn fetch_checked(http: &reqwest::Client, url: &str, dir: &Path, name: &str, bytes: u64, sha: &str) -> anyhow::Result<()> {
    let part = dir.join(format!("{name}.part"));
    let res = http.get(url).timeout(crate::util::DOWNLOAD_TOTAL).send().await?.error_for_status().with_context(|| format!("downloading {url}"))?;
    let mut file = tokio::fs::File::create(&part).await?;
    let mut hash = Sha256::new();
    let mut got = 0u64;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = crate::util::next_chunk(&mut stream).await? {
        got += chunk.len() as u64;
        if got > bytes {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            anyhow::bail!("{name} is larger than expected");
        }
        hash.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    drop(file);
    let digest = hex::encode(hash.finalize());
    if got != bytes || digest != sha {
        let _ = tokio::fs::remove_file(&part).await;
        anyhow::bail!("{name}: checksum or size mismatch ({got} bytes, sha256 {digest})");
    }
    tokio::fs::rename(&part, dir.join(name)).await?;
    Ok(())
}

/// Download Yama's query model into the bundle's folder in the background, unless it's there,
/// already downloading, failed recently, or the bundle (its manifest) isn't here or isn't the one
/// it fits. The caller checks the switch. A failure only means phones get the bundle's own
/// `embed.onnx` a while longer; it's logged, and the next call at least `RETRY_AFTER` later
/// tries again (a scanner open, or the server's start).
pub async fn ensure_query(data_dir: PathBuf, http: reqwest::Client) {
    let dir = bundle_dir(&data_dir);
    if QUERY_MODEL.is_in(&dir).await {
        return;
    }
    let Some(manifest) = read_manifest(&dir).await else { return };
    if !QUERY_MODEL.fits(&manifest) {
        return;
    }
    let mut state = query_state().lock().await;
    match &*state {
        Fetch::Running => return,
        Fetch::Failed(_, at) if at.elapsed() < RETRY_AFTER => return,
        _ => {}
    }
    *state = Fetch::Running;
    tokio::spawn(async move {
        let result = download_query(&http, &QUERY_MODEL, &dir).await;
        let mut state = query_state().lock().await;
        *state = match result {
            Ok(()) => {
                tracing::info!(model = QUERY_MODEL.name, "scanner query model ready");
                Fetch::Idle
            }
            Err(e) => {
                tracing::warn!(model = QUERY_MODEL.name, error = %format!("{e:#}"), "scanner query model download failed; serving the bundle's embed.onnx");
                Fetch::Failed(format!("{e:#}"), Instant::now())
            }
        };
    });
}

/// Fetch `model` into `dir` and drop the query models of pins before the last there.
async fn download_query(http: &reqwest::Client, model: &QueryModel, dir: &Path) -> anyhow::Result<()> {
    let file = model.file();
    fetch_checked(http, model.url, dir, &file, model.bytes, model.sha256).await?;
    remove_other_queries(dir, &file).await;
    Ok(())
}

/// Delete the `query-*.onnx` files of earlier pins, and unfinished `.part` downloads, but keep
/// `keep` and the newest other one: a phone that read the bundle info just before the pin moved
/// may still ask for it (as scan_art.rs keeps the supplement it replaced).
async fn remove_other_queries(dir: &Path, keep: &str) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else { return };
    let mut older = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("query-") || name == keep {
            continue;
        }
        if name.ends_with(".onnx") {
            let modified = entry.metadata().await.and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
            older.push((modified, entry.path(), name));
        } else if name.ends_with(".onnx.part") {
            older.push((std::time::UNIX_EPOCH, entry.path(), name));
        }
    }
    // Newest first; the first complete one stays.
    older.sort_by(|a, b| b.0.cmp(&a.0));
    let previous = older.iter().position(|(_, _, name)| name.ends_with(".onnx"));
    for (i, (_, path, name)) in older.into_iter().enumerate() {
        if Some(i) == previous {
            continue;
        }
        match tokio::fs::remove_file(&path).await {
            Ok(()) => tracing::info!(file = %name, "removed an older scanner query model"),
            Err(e) => tracing::warn!(file = %name, error = %e, "couldn't remove an older scanner query model"),
        }
    }
}

async fn read_manifest(dir: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&tokio::fs::read(dir.join("manifest.json")).await.ok()?).ok()
}

/// Whether phones opening the scanner get Yama's query model as the embed graph: the switch
/// allows it, it fits this bundle's gallery and it's downloaded. Otherwise the bundle's own.
async fn serves_query(cfg: &crate::config::Config, dir: &Path, manifest: &serde_json::Value) -> bool {
    cfg.scan_query_model && QUERY_MODEL.fits(manifest) && QUERY_MODEL.is_in(dir).await
}

/// The bundle a kept scan photo or diagnostic is recorded with: the pinned version, plus
/// `+<query model>` when the phone ran one of Yama's query models. `embed` is the embed graph's
/// file name the phone's art recognizer runs (`ArtRecognizer.embed`), or "none" while it reads
/// text only:
/// - the bundle's `embed.onnx` or "none": the version alone;
/// - this pin's query model: `+yama-art-…`; an earlier pin's (a tab open across the change):
///   `+query-<sha>`, never relabelled as the current one;
/// - anything else: `+unknown`;
/// - not said (a web build from before it was sent): what the server serves now, the best guess.
pub(crate) async fn recorded_version(cfg: &crate::config::Config, embed: Option<&str>) -> String {
    let query = format!("{BUNDLE_VERSION}+{}", QUERY_MODEL.name);
    let earlier = |name: &str| {
        let sha = name.strip_prefix("query-")?.strip_suffix(".onnx")?;
        (sha.len() == 12 && sha.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).then(|| format!("{BUNDLE_VERSION}+query-{sha}"))
    };
    match embed {
        Some("embed.onnx" | "none") => BUNDLE_VERSION.to_string(),
        Some(name) if name == QUERY_MODEL.file() => query,
        Some(name) => earlier(name).unwrap_or_else(|| format!("{BUNDLE_VERSION}+unknown")),
        None => {
            let dir = bundle_dir(&cfg.data_dir);
            if is_ready(&dir)
                && let Some(manifest) = read_manifest(&dir).await
                && serves_query(cfg, &dir, &manifest).await
            {
                return query;
            }
            BUNDLE_VERSION.to_string()
        }
    }
}

/// Once this version is ready, drop the folders of earlier pinned bundles (about 45 MB each). They
/// are this module's own downloads; a server rolled back to one fetches it again.
async fn remove_other_bundles(root: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else { return };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let is_dir = entry.file_type().await.is_ok_and(|t| t.is_dir());
        if is_dir && entry.file_name() != BUNDLE_VERSION {
            match tokio::fs::remove_dir_all(entry.path()).await {
                Ok(()) => tracing::info!(path = %entry.path().display(), "removed an older scanner bundle"),
                Err(e) => tracing::warn!(path = %entry.path().display(), error = %e, "couldn't remove an older scanner bundle"),
            }
        }
    }
}

#[derive(Deserialize)]
struct ArtRow {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    set: String,
    #[serde(default)]
    collector_number: Option<String>,
    #[serde(default)]
    illustration_id: Option<String>,
    #[serde(default)]
    layout: Option<String>,
    #[serde(default)]
    printing_count: Option<u32>,
}

/// arts.json as columns and rows, in gallery order (the row index is the search graph's index).
fn slim_arts(raw: &[u8]) -> anyhow::Result<Vec<u8>> {
    let rows: Vec<ArtRow> = serde_json::from_slice(raw).context("reading arts.json")?;
    let rows: Vec<_> = rows
        .into_iter()
        .map(|r| (r.id, r.name, r.set, r.collector_number.unwrap_or_default(), r.illustration_id, r.layout.unwrap_or_else(|| "normal".into()), r.printing_count.unwrap_or(1)))
        .collect();
    Ok(serde_json::to_vec(&serde_json::json!({
        "version": BUNDLE_VERSION,
        "columns": ["id", "name", "set", "number", "illustration_id", "layout", "printings"],
        "rows": rows,
    }))?)
}

pub(crate) fn gzip(data: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    std::io::Write::write_all(&mut enc, data)?;
    Ok(enc.finish()?)
}

#[derive(Serialize)]
struct BundleInfo {
    version: &'static str,
    /// False while the server is still downloading it (the scanner reads text meanwhile).
    ready: bool,
    error: Option<String>,
    files: BundleFiles,
    /// Size of each file once downloaded (and unzipped), for a progress bar.
    bytes: BundleBytes,
    /// `manifest.constants`, as the recognizer reads them.
    constants: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct BundleBytes {
    detector: u64,
    embed: u64,
    search: u64,
    arts: u64,
    supplement: u64,
}

#[derive(Serialize)]
struct BundleFiles {
    detector: String,
    embed: String,
    search: String,
    arts: String,
    /// Artworks Yama embedded itself that the bundle doesn't know (scan_art.rs), or null.
    supplement: Option<String>,
}

async fn bundle_info(State(st): State<AppState>, _user: CurrentUser) -> AppResult<Json<BundleInfo>> {
    let dir = bundle_dir(&st.cfg.data_dir);
    let error = if st.cfg.offline {
        (!is_ready(&dir)).then(|| crate::error::offline("the scanner's download site").to_string())
    } else {
        ensure(st.cfg.data_dir.clone(), st.http.clone()).await
    };
    let ready = is_ready(&dir);
    let manifest: Option<serde_json::Value> = if ready {
        Some(serde_json::from_slice(&tokio::fs::read(dir.join("manifest.json")).await.map_err(anyhow::Error::from)?).map_err(anyhow::Error::from)?)
    } else {
        None
    };
    let constants = manifest.as_ref().and_then(|m| m.get("constants").cloned());
    if ready && st.cfg.scan_query_model && !st.cfg.offline {
        ensure_query(st.cfg.data_dir.clone(), st.http.clone()).await;
    }
    // Yama's query model in place of the bundle's embed graph once it's here; a different file
    // name, so the phone's cache (keyed by URL) fetches it once and drops the other.
    let query = match &manifest {
        Some(m) => serves_query(&st.cfg, &dir, m).await,
        None => false,
    };
    let embed = if query { QUERY_MODEL.file() } else { "embed.onnx".to_string() };
    let url = |f: &str| format!("/scan-bundle/{BUNDLE_VERSION}/{f}");
    let size = |f: &str| FILES.iter().find(|(name, _, _)| *name == f).map_or(0, |(_, bytes, _)| *bytes);
    let arts = if ready { tokio::fs::metadata(dir.join(ARTS)).await.map_or(0, |m| m.len()) } else { 0 };
    let supplement = if ready && st.cfg.scan_supplement { crate::scan_art::current(&st.cfg.data_dir).await } else { None };
    Ok(Json(BundleInfo {
        version: BUNDLE_VERSION,
        ready,
        error,
        files: BundleFiles {
            detector: url("detector.onnx"),
            embed: url(&embed),
            search: url("search.onnx"),
            arts: url(ARTS),
            supplement: supplement.as_ref().map(|(name, _)| url(name)),
        },
        bytes: BundleBytes {
            detector: size("detector.onnx"),
            embed: if query { QUERY_MODEL.bytes } else { size("embed.onnx") },
            search: size("search.onnx"),
            arts,
            supplement: supplement.map_or(0, |(_, bytes)| bytes),
        },
        constants,
    }))
}

#[derive(Deserialize)]
struct ArtParams {
    /// Scryfall illustration ID of the recognised art.
    art: Option<String>,
    /// Scryfall ID of a printing with that art (a back face may end in `-1`).
    id: Option<String>,
    /// Or a card or face name, when the card was read as text.
    name: Option<String>,
}

#[derive(Serialize)]
struct ArtPrintings {
    /// True when these are exactly the printings with that art. False when they are all the
    /// card's printings (asked by name, or Yama's card data has no illustration IDs for it yet).
    same_art: bool,
    printings: Vec<Printing>,
}

const ORDER: &str = "ORDER BY p.lang = 'en' DESC, p.released_at DESC, p.set_code, p.collector_number";

async fn printings_by_art(State(st): State<AppState>, _user: CurrentUser, Query(p): Query<ArtParams>) -> AppResult<Json<ArtPrintings>> {
    if let Some(art) = p.art.as_deref().filter(|a| !a.is_empty()) {
        let printings = sqlx::query_as::<_, Printing>(AssertSqlSafe(format!(
            "{PRINTING_SELECT} WHERE p.illustration_id = ?1 OR p.back_illustration_id = ?1 {ORDER}"
        )))
        .bind(art)
        .fetch_all(&st.pool)
        .await?;
        if !printings.is_empty() {
            return Ok(Json(ArtPrintings { same_art: true, printings }));
        }
    }
    let (oracle_sql, key) = match (p.id.as_deref(), p.name.as_deref()) {
        (Some(id), _) if !id.is_empty() => ("SELECT oracle_id FROM printings WHERE scryfall_id = ?1", id.strip_suffix("-1").unwrap_or(id)),
        // A card's own name wins over another card's face with the same name (Brainstorm, and the
        // adventure face called Brainstorm). Failing that, every card with that face is offered.
        (_, Some(name)) if !name.trim().is_empty() => (
            "SELECT oracle_id FROM cards WHERE name = ?1 COLLATE NOCASE
             UNION SELECT oracle_id FROM card_names WHERE name = ?1
               AND NOT EXISTS (SELECT 1 FROM cards WHERE name = ?1 COLLATE NOCASE)",
            name.trim(),
        ),
        _ => return Err(AppError::BadRequest("give art and id, or name".into())),
    };
    let printings = sqlx::query_as::<_, Printing>(AssertSqlSafe(format!("{PRINTING_SELECT} WHERE p.oracle_id IN ({oracle_sql}) {ORDER}")))
        .bind(key)
        .fetch_all(&st.pool)
        .await?;
    if printings.is_empty() {
        return Err(AppError::NotFound("card"));
    }
    Ok(Json(ArtPrintings { same_art: false, printings }))
}

#[derive(Serialize, sqlx::FromRow)]
struct ScanSet {
    code: String,
    name: String,
    released_at: Option<String>,
    /// English printings in Yama's card data.
    cards: i64,
}

/// Every set with English printings, newest first, for the set lock's picker.
async fn scan_sets(State(st): State<AppState>, _user: CurrentUser) -> AppResult<Json<Vec<ScanSet>>> {
    let sets = sqlx::query_as::<_, ScanSet>(
        "SELECT set_code AS code, MAX(set_name) AS name, MAX(released_at) AS released_at, COUNT(*) AS cards
           FROM printings WHERE lang = 'en' GROUP BY set_code ORDER BY MAX(released_at) DESC, set_code",
    )
    .fetch_all(&st.pool)
    .await?;
    Ok(Json(sets))
}

#[derive(Deserialize)]
struct SetParams {
    code: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct SetPrinting {
    #[sqlx(flatten)]
    #[serde(flatten)]
    printing: Printing,
    illustration_id: Option<String>,
    back_illustration_id: Option<String>,
}

#[derive(Serialize)]
struct SetPrintings {
    code: String,
    name: String,
    printings: Vec<SetPrinting>,
}

/// One set's printings with their artworks: what a scan locked to the set may match.
async fn set_printings(State(st): State<AppState>, _user: CurrentUser, Query(p): Query<SetParams>) -> AppResult<Json<SetPrintings>> {
    let code = p.code.trim().to_lowercase();
    let select = PRINTING_SELECT.replacen("p.artist,", "p.artist, p.illustration_id, p.back_illustration_id,", 1);
    let printings = sqlx::query_as::<_, SetPrinting>(AssertSqlSafe(format!("{select} WHERE p.set_code = ? ORDER BY p.lang = 'en' DESC, p.collector_number")))
        .bind(&code)
        .fetch_all(&st.pool)
        .await?;
    let Some(first) = printings.first() else { return Err(AppError::NotFound("set")) };
    let name = first.printing.set_name.clone();
    Ok(Json(SetPrintings { code, name, printings }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use axum::http::{Method, StatusCode};

    #[tokio::test]
    async fn a_ready_bundle_removes_older_ones_only() {
        let root = tempfile::tempdir().unwrap();
        for dir in [BUNDLE_VERSION, "retrain-20261026T052522727512Z"] {
            std::fs::create_dir_all(root.path().join(dir)).unwrap();
            std::fs::write(root.path().join(dir).join("search.onnx"), b"x").unwrap();
        }
        std::fs::write(root.path().join("note.txt"), b"not a bundle").unwrap();
        remove_other_bundles(root.path()).await;
        assert!(root.path().join(BUNDLE_VERSION).join("search.onnx").exists());
        assert!(!root.path().join("retrain-20261026T052522727512Z").exists());
        assert!(root.path().join("note.txt").exists());
    }

    /// A bundle folder `is_ready` accepts, whose manifest names `recogniser`.
    fn ready_bundle(data_dir: &Path, recogniser: &str) -> PathBuf {
        let dir = bundle_dir(data_dir);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({"version": BUNDLE_VERSION, "recogniser": {"sha256": recogniser}, "constants": {"scene": 640}});
        std::fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        for f in ["detector.onnx", "embed.onnx", "search.onnx", "arts.slim.json.gz"] {
            std::fs::write(dir.join(f), b"bundle").unwrap();
        }
        assert!(is_ready(&dir));
        dir
    }

    #[tokio::test]
    async fn the_query_model_is_served_only_when_it_fits_is_allowed_and_is_whole() {
        let data = tempfile::tempdir().unwrap();
        let dir = ready_bundle(data.path(), QUERY_MODEL.recogniser);
        let mut cfg = testutil::config();
        cfg.data_dir = data.path().to_path_buf();
        let with_query = format!("{BUNDLE_VERSION}+{}", QUERY_MODEL.name);
        assert_eq!(QUERY_MODEL.file(), "query-52420d900728.onnx");

        // What the server would serve (a client that doesn't say what it loaded).
        // Not downloaded yet, or cut short: the bundle's own.
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
        std::fs::write(dir.join(QUERY_MODEL.file()), b"short").unwrap();
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
        std::fs::write(dir.join(QUERY_MODEL.file()), vec![0u8; QUERY_MODEL.bytes as usize]).unwrap();
        assert_eq!(recorded_version(&cfg, None).await, with_query);
        // Switched off.
        cfg.scan_query_model = false;
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
        cfg.scan_query_model = true;
        // A bundle from another recogniser checkpoint: its own embed graph.
        ready_bundle(data.path(), "0000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
        ready_bundle(data.path(), QUERY_MODEL.recogniser);
        assert_eq!(recorded_version(&cfg, None).await, with_query);
        // What the phone says it ran wins over what the server serves now.
        assert_eq!(recorded_version(&cfg, Some("embed.onnx")).await, BUNDLE_VERSION);
        assert_eq!(recorded_version(&cfg, Some("none")).await, BUNDLE_VERSION);
        cfg.scan_query_model = false;
        assert_eq!(recorded_version(&cfg, Some(QUERY_MODEL.file().as_str())).await, with_query);
        cfg.scan_query_model = true;
        // An earlier pin's model keeps its own name; anything else is unknown, never a guess.
        assert_eq!(recorded_version(&cfg, Some("query-0123456789ab.onnx")).await, format!("{BUNDLE_VERSION}+query-0123456789ab"));
        for odd in ["query-../x.onnx", "query-0123456789AB.onnx", "something.onnx", ""] {
            assert_eq!(recorded_version(&cfg, Some(odd)).await, format!("{BUNDLE_VERSION}+unknown"), "{odd}");
        }
        // A bundle that isn't ready yet.
        std::fs::remove_file(dir.join("search.onnx")).unwrap();
        assert_eq!(recorded_version(&cfg, None).await, BUNDLE_VERSION);
    }

    #[tokio::test]
    async fn bundle_info_names_the_query_model_or_else_the_bundles_embed() {
        let data = tempfile::tempdir().unwrap();
        let dir = ready_bundle(data.path(), QUERY_MODEL.recogniser);
        let pool = crate::db::test_pool().await;
        let (_, token) = testutil::user(&pool, "scan@example.com").await;
        // Offline, so a missing query model is never fetched from GitHub here.
        let app_with = |on: bool| {
            let pool = pool.clone();
            let mut cfg = testutil::config();
            cfg.data_dir = data.path().to_path_buf();
            cfg.offline = true;
            cfg.scan_query_model = on;
            async move { crate::routes::app(testutil::state_with(cfg, pool).await) }
        };
        let bundle_embed = format!("/scan-bundle/{BUNDLE_VERSION}/embed.onnx");
        let query_embed = format!("/scan-bundle/{BUNDLE_VERSION}/{}", QUERY_MODEL.file());

        // Not downloaded: the bundle's embed graph, as before.
        let app = app_with(true).await;
        let (status, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(info["ready"], true);
        assert_eq!(info["error"], serde_json::Value::Null);
        assert_eq!(info["files"]["embed"], bundle_embed.as_str());
        assert_eq!(info["bytes"]["embed"], 5_118_408);

        // Downloaded: the query model, served from the bundle's folder like its files.
        let model: Vec<u8> = (0..QUERY_MODEL.bytes).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join(QUERY_MODEL.file()), &model).unwrap();
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(info["files"]["embed"], query_embed.as_str());
        assert_eq!(info["bytes"]["embed"], QUERY_MODEL.bytes);
        assert_eq!(info["files"]["detector"], format!("/scan-bundle/{BUNDLE_VERSION}/detector.onnx").as_str());
        assert_eq!(info["files"]["search"], format!("/scan-bundle/{BUNDLE_VERSION}/search.onnx").as_str());
        assert_eq!(info["constants"]["scene"], 640);
        let res = tower::ServiceExt::oneshot(app.clone(), axum::http::Request::get(&query_embed).body(axum::body::Body::empty()).unwrap()).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
        let body = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.len() as u64, QUERY_MODEL.bytes);
        assert!(body == model);
        // The bundle's own stays where scan_art.rs reads it.
        assert_eq!(std::fs::read(dir.join("embed.onnx")).unwrap(), b"bundle");

        // Switched off: the bundle's.
        let off = app_with(false).await;
        let (_, info) = testutil::send(&off, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(info["files"]["embed"], bundle_embed.as_str());
        assert_eq!(info["bytes"]["embed"], 5_118_408);

        // A bundle from another recogniser: the bundle's, though the file is here.
        ready_bundle(data.path(), "eb6558461672b30c8b699570cc1669c4baa1a31d5fd28d617800e8a1f4d2e2c4");
        let (_, info) = testutil::send(&app, Method::GET, "/api/scan/bundle", Some(&token), None).await;
        assert_eq!(info["files"]["embed"], bundle_embed.as_str());
    }

    #[tokio::test]
    async fn the_query_download_is_checked_and_keeps_only_the_pin_before() {
        let served = axum::Router::new()
            .route("/good", get(|| async { "model" }))
            .route("/bad", get(|| async { "modem" }))
            .route("/long", get(|| async { "model and more" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, served).await.unwrap() });
        let model = |path: &str| QueryModel {
            name: "test",
            url: Box::leak(format!("{base}{path}").into_boxed_str()),
            bytes: 5,
            sha256: Box::leak(hex::encode(Sha256::digest(b"model")).into_boxed_str()),
            recogniser: QUERY_MODEL.recogniser,
        };
        let dir = tempfile::tempdir().unwrap();
        let http = crate::routes::http_client();
        let file = model("/good").file();
        std::fs::write(dir.path().join("embed.onnx"), b"bundle").unwrap();
        let day = std::time::Duration::from_secs(24 * 3600);
        for (name, age) in [("query-000000000000.onnx", 2), ("query-aaaaaaaaaaaa.onnx", 1)] {
            let f = std::fs::File::create(dir.path().join(name)).unwrap();
            std::io::Write::write_all(&mut &f, b"older pin").unwrap();
            f.set_modified(std::time::SystemTime::now() - day * age).unwrap();
        }
        std::fs::write(dir.path().join("query-111111111111.onnx.part"), b"older, unfinished").unwrap();
        std::fs::write(dir.path().join("supplement-abc.json"), b"{}").unwrap();

        // Wrong bytes or too many: nothing named, nothing left over, older pins untouched.
        for path in ["/bad", "/long"] {
            let err = download_query(&http, &model(path), dir.path()).await.unwrap_err();
            assert!(format!("{err:#}").contains(&file), "{err:#}");
            assert!(!dir.path().join(&file).exists());
            assert!(!dir.path().join(format!("{file}.part")).exists());
            assert!(dir.path().join("query-000000000000.onnx").exists());
        }

        download_query(&http, &model("/good"), dir.path()).await.unwrap();
        assert_eq!(std::fs::read(dir.path().join(&file)).unwrap(), b"model");
        // The pin just before stays for phones that still name it; older ones and leftovers go.
        assert!(dir.path().join("query-aaaaaaaaaaaa.onnx").exists());
        assert!(!dir.path().join("query-000000000000.onnx").exists());
        assert!(!dir.path().join("query-111111111111.onnx.part").exists());
        assert_eq!(std::fs::read(dir.path().join("embed.onnx")).unwrap(), b"bundle");
        assert!(dir.path().join("supplement-abc.json").exists());
        server.abort();
    }

    #[tokio::test]
    async fn printings_that_share_the_art_or_else_the_whole_card() {
        let (app, pool) = testutil::app().await;
        let (_, token) = testutil::user(&pool, "scan@example.com").await;
        sqlx::query("INSERT INTO cards (oracle_id, name, layout, color_identity, colors, cmc, updated_at) VALUES ('o', 'Sol Ring', 'normal', '', '', 1, '2026-10-28')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('sol ring', 'o')").execute(&pool).await.unwrap();
        for (id, set, art, released) in [("p1", "ecc", Some("i1"), "2026-01-01"), ("p2", "c21", Some("i1"), "2021-04-23"), ("p3", "lea", Some("i0"), "1993-08-05"), ("p4", "cmm", None, "2023-08-04")] {
            sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, released_at, illustration_id, updated_at) VALUES (?, 'o', 'Sol Ring', ?, 'Set', '1', 'en', ?, ?, '2026-10-28')")
                .bind(id).bind(set).bind(released).bind(art).execute(&pool).await.unwrap();
        }
        let ids = |v: &serde_json::Value| v["printings"].as_array().unwrap().iter().map(|p| p["scryfall_id"].as_str().unwrap().to_string()).collect::<Vec<_>>();

        let (status, body) = testutil::send(&app, Method::GET, "/api/scan/printings?art=i1&id=p1", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["same_art"], true);
        assert_eq!(ids(&body), ["p1", "p2"]);

        // An art Yama has no illustration IDs for yet: every printing of the card, newest first.
        let (_, body) = testutil::send(&app, Method::GET, "/api/scan/printings?art=unknown&id=p1-1", Some(&token), None).await;
        assert_eq!(body["same_art"], false);
        assert_eq!(ids(&body), ["p1", "p4", "p2", "p3"]);

        let (_, body) = testutil::send(&app, Method::GET, "/api/scan/printings?name=Sol%20Ring", Some(&token), None).await;
        assert_eq!(ids(&body).len(), 4);

        // A standalone card and another card's face share the name: the standalone card's printings only.
        sqlx::query("INSERT INTO cards (oracle_id, name, layout, color_identity, colors, cmc, updated_at) VALUES ('adv', 'Big Score // Sol Ring', 'adventure', '', '', 1, '2026-10-28')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('sol ring', 'adv')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES ('a1', 'adv', 'Big Score // Sol Ring', 'woe', 'Set', '9', 'en', '2026-10-28')")
            .execute(&pool).await.unwrap();
        let (_, body) = testutil::send(&app, Method::GET, "/api/scan/printings?name=sol%20ring", Some(&token), None).await;
        assert_eq!(ids(&body).len(), 4);
        // A face name alone offers its card.
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('big score', 'adv')").execute(&pool).await.unwrap();
        let (_, body) = testutil::send(&app, Method::GET, "/api/scan/printings?name=Big%20Score", Some(&token), None).await;
        assert_eq!(ids(&body), ["a1"]);

        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/printings?name=Nothing", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/printings?art=i1&id=p1", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn sets_and_one_sets_printings_with_their_art() {
        let (app, pool) = testutil::app().await;
        let (_, token) = testutil::user(&pool, "scan@example.com").await;
        sqlx::query("INSERT INTO cards (oracle_id, name, layout, color_identity, colors, cmc, updated_at) VALUES ('o', 'Sol Ring', 'normal', '', '', 1, '2026-10-28')")
            .execute(&pool).await.unwrap();
        for (id, set, name, num, lang, art, released) in [
            ("p1", "ecc", "Edge of Eternities Commander", "57", "en", Some("i1"), "2025-08-01"),
            ("p1j", "ecc", "Edge of Eternities Commander", "57", "ja", Some("i1"), "2025-08-01"),
            ("p2", "c21", "Commander 2021", "263", "en", Some("i2"), "2021-04-23"),
        ] {
            sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, released_at, illustration_id, updated_at) VALUES (?, 'o', 'Sol Ring', ?, ?, ?, ?, ?, ?, '2026-10-28')")
                .bind(id).bind(set).bind(name).bind(num).bind(lang).bind(released).bind(art).execute(&pool).await.unwrap();
        }
        let (status, sets) = testutil::send(&app, Method::GET, "/api/scan/sets", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(sets[0]["code"], "ecc");
        assert_eq!(sets[0]["name"], "Edge of Eternities Commander");
        assert_eq!(sets[0]["cards"], 1);
        assert_eq!(sets[1]["code"], "c21");

        let (status, set) = testutil::send(&app, Method::GET, "/api/scan/set?code=ECC", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(set["name"], "Edge of Eternities Commander");
        let printings = set["printings"].as_array().unwrap();
        assert_eq!(printings.len(), 2);
        assert_eq!(printings[0]["scryfall_id"], "p1");
        assert_eq!(printings[0]["illustration_id"], "i1");
        assert_eq!(printings[0]["set_code"], "ecc");

        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/set?code=zzz", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/sets", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn slim_arts_keeps_gallery_order_and_fields() {
        let raw = br#"[{"id":"a","name":"Sol Ring","set":"ecc","collector_number":"57","illustration_id":"i1","layout":"normal","printing_count":3,"url":"x","frame":"modern"},
                       {"id":"b-1","name":"Back","set":"mid","illustration_id":null}]"#;
        let v: serde_json::Value = serde_json::from_slice(&slim_arts(raw).unwrap()).unwrap();
        assert_eq!(v["rows"][0], serde_json::json!(["a", "Sol Ring", "ecc", "57", "i1", "normal", 3]));
        assert_eq!(v["rows"][1], serde_json::json!(["b-1", "Back", "mid", "", null, "normal", 1]));
    }
}
