//! The card scanner's server side (web/src/scanner, docs/scanner.md).
//!
//! - The art recognition bundle: three ONNX graphs and an index of artworks, published by
//!   ManaVault (MPL-2.0, github.com/cfbender/manavault). One pinned version is downloaded once into
//!   `data/scan-bundle/<version>/`, checked against the SHA-256 sums below, and served to the app
//!   from `/scan-bundle/<version>/` so phones never fetch it from GitHub and it works offline once
//!   cached. Nothing is downloaded until the server's card imports run or someone opens the scanner.
//! - `GET /api/scan/printings`: every printing that shares a recognised artwork, so the scanner
//!   only has to tell those apart (collector line, or the person picks).

use crate::auth::CurrentUser;
use crate::cards::{Printing, PRINTING_SELECT};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use anyhow::Context;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::AssertSqlSafe;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tower_http::services::ServeDir;

/// The pinned bundle. To move to a newer one, change the tag and the four sums (from the
/// release's SHA256SUMS), run the recognizer eval (docs/scanner.md) and note the result.
pub const BUNDLE_VERSION: &str = "retrain-20261026T052522727512Z";
const RELEASE_URL: &str = "https://github.com/cfbender/manavault/releases/download/scanner-bundle-";
const FILES: [(&str, u64, &str); 5] = [
    ("manifest.json", 2_147, "1f07721c519c4abb306fbbf77c2be9c7a5354c2ed27280ad29be6bf320138fe1"),
    ("detector.onnx", 12_576_317, "1e8cdd520dce3570ca2f24c270ac39cc7ac0639d0504c3032b7850fbf8c0c771"),
    ("embed.onnx", 5_118_408, "f71739bbe6804cd442ddb0a40ec1f22f62c47991fc9cf7a4f445257e8081fb7c"),
    ("search.onnx", 13_895_006, "51d6089d13a318e74630d71fdc35c70f6b3c5f86a1ce1d9758064a9cda764285"),
    ("arts.json", 17_907_030, "c9714add18668fba04bcca187a7743b24196dc88fcff92bbe6886a3c9ff0a542"),
];
/// The artwork index reduced to what the scanner reads (about a third of arts.json), gzipped.
const ARTS: &str = "arts.slim.json";
/// After a failed download, wait this long before trying again.
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

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
        .merge(files)
}

fn bundle_dir(data_dir: &Path) -> PathBuf {
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

fn is_ready(dir: &Path) -> bool {
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

async fn download(http: &reqwest::Client, dir: &Path) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    for (name, bytes, sha) in FILES {
        let path = dir.join(name);
        if path.exists() || (name == "arts.json" && dir.join(format!("{ARTS}.gz")).exists()) {
            continue;
        }
        let url = format!("{RELEASE_URL}{BUNDLE_VERSION}/{name}");
        let part = dir.join(format!("{name}.part"));
        let res = http.get(&url).send().await?.error_for_status().with_context(|| format!("downloading {url}"))?;
        let mut file = tokio::fs::File::create(&part).await?;
        let mut hash = Sha256::new();
        let mut got = 0u64;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            got += chunk.len() as u64;
            anyhow::ensure!(got <= bytes, "{name} is larger than expected");
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
        tokio::fs::rename(&part, &path).await?;
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
    Ok(())
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

fn gzip(data: &[u8]) -> anyhow::Result<Vec<u8>> {
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
}

#[derive(Serialize)]
struct BundleFiles {
    detector: String,
    embed: String,
    search: String,
    arts: String,
}

async fn bundle_info(State(st): State<AppState>, _user: CurrentUser) -> AppResult<Json<BundleInfo>> {
    let dir = bundle_dir(&st.cfg.data_dir);
    let error = ensure(st.cfg.data_dir.clone(), st.http.clone()).await;
    let ready = is_ready(&dir);
    let constants = if ready {
        let manifest: serde_json::Value = serde_json::from_slice(&tokio::fs::read(dir.join("manifest.json")).await.map_err(anyhow::Error::from)?).map_err(anyhow::Error::from)?;
        manifest.get("constants").cloned()
    } else {
        None
    };
    let url = |f: &str| format!("/scan-bundle/{BUNDLE_VERSION}/{f}");
    let size = |f: &str| FILES.iter().find(|(name, _, _)| *name == f).map_or(0, |(_, bytes, _)| *bytes);
    let arts = if ready { tokio::fs::metadata(dir.join(ARTS)).await.map_or(0, |m| m.len()) } else { 0 };
    Ok(Json(BundleInfo {
        version: BUNDLE_VERSION,
        ready,
        error,
        files: BundleFiles { detector: url("detector.onnx"), embed: url("embed.onnx"), search: url("search.onnx"), arts: url(ARTS) },
        bytes: BundleBytes { detector: size("detector.onnx"), embed: size("embed.onnx"), search: size("search.onnx"), arts },
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
        (Some(id), _) if !id.is_empty() => ("SELECT oracle_id FROM printings WHERE scryfall_id = ?", id.strip_suffix("-1").unwrap_or(id)),
        (_, Some(name)) if !name.trim().is_empty() => ("SELECT oracle_id FROM card_names WHERE name = ? LIMIT 1", name.trim()),
        _ => return Err(AppError::BadRequest("give art and id, or name".into())),
    };
    let printings = sqlx::query_as::<_, Printing>(AssertSqlSafe(format!("{PRINTING_SELECT} WHERE p.oracle_id = ({oracle_sql}) {ORDER}")))
        .bind(key)
        .fetch_all(&st.pool)
        .await?;
    if printings.is_empty() {
        return Err(AppError::NotFound("card"));
    }
    Ok(Json(ArtPrintings { same_art: false, printings }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil;
    use axum::http::{Method, StatusCode};

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

        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/printings?name=Nothing", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = testutil::send(&app, Method::GET, "/api/scan/printings?art=i1&id=p1", None, None).await;
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
