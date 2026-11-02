//! Scryfall bulk data import.
//!
//! - `oracle_cards`: one object per card (rules text, legality) → `cards`, `card_names`.
//! - `default_cards`: every printing in English, or its only language → `printings`, `price_snapshots`.
//! - `rulings`: Wizards' and Scryfall's rulings by oracle ID → `rulings` (replaced as a whole).
//!
//! Images: Scryfall added WebP sizes on 2026-10-14 and drops the `small`, `large`, `border_crop`
//! and `art_crop` JPEGs on 2027-01-01 (<https://scryfall.com/blog/new-webp-images-jpeg-deprecations-237>).
//! We read `thumb`, `grid` and `art`, falling back to the JPEG keys for older files. Column
//! names stay as they were (`image_small` holds the thumb, `image_normal` the grid image, and
//! `image_art_crop` the art). Only URLs are stored; images load from Scryfall at runtime.
//!
//! The files are large (hundreds of MB), so they're parsed as a stream on a blocking thread and
//! handed to the async writer in batches. Scryfall regenerates bulk files every 12 hours; weekly
//! is enough for rules data, daily for prices.

use crate::config::Config;
use crate::util::{new_id, now};
use anyhow::{Context, bail};
use futures_util::StreamExt;
use serde::Deserialize;
use serde::de::{DeserializeOwned, SeqAccess, Visitor};
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use std::fmt;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

const BULK_INDEX: &str = "https://api.scryfall.com/bulk-data";
const BATCH: usize = 500;

/// Layouts that aren't cards anyone plays.
const SKIP_LAYOUTS: [&str; 1] = ["art_series"];

pub async fn run(
    pool: &SqlitePool,
    cfg: &Config,
    oracle: Option<PathBuf>,
    default: Option<PathBuf>,
    rulings: Option<PathBuf>,
) -> anyhow::Result<()> {
    let result = run_from(pool, &cfg.data_dir, BULK_INDEX, oracle, default, rulings).await;
    crate::db::after_import(pool).await;
    result
}

/// [`run`] against any bulk index, so tests can serve one locally.
///
/// Each downloaded file is deleted as soon as its import is done, and also when anything fails
/// (see [`BulkFile`]): the disk is small. Files given on the command line are never deleted.
async fn run_from(
    pool: &SqlitePool,
    data_dir: &Path,
    index_url: &str,
    oracle: Option<PathBuf>,
    default: Option<PathBuf>,
    rulings: Option<PathBuf>,
) -> anyhow::Result<()> {
    let http = crate::routes::http_client();
    // Given both card files, stay offline: rulings come only from --rulings then.
    let offline = oracle.is_some() && default.is_some();
    let index = if !offline { Some(bulk_index(&http, index_url).await?) } else { None };

    let file = match oracle {
        Some(p) => BulkFile::given(p),
        None => download(&http, index.as_ref().unwrap().find("oracle_cards")?, data_dir).await?,
    };
    let n = import_oracle(pool, &file.path, file.meta.as_ref()).await?;
    println!("oracle cards: {n}");
    drop(file);

    let file = match default {
        Some(p) => BulkFile::given(p),
        None => download(&http, index.as_ref().unwrap().find("default_cards")?, data_dir).await?,
    };
    let n = import_default(pool, &file.path, file.meta.as_ref()).await?;
    println!("printings: {n}");
    drop(file);

    let file = match (rulings, &index) {
        (Some(p), _) => BulkFile::given(p),
        (None, Some(index)) => download(&http, index.find("rulings")?, data_dir).await?,
        (None, None) => return Ok(()),
    };
    let n = import_rulings(pool, &file.path, file.meta.as_ref()).await?;
    println!("rulings: {n}");
    Ok(())
}

/// Version of the import for one kind of bulk file, stored with each run
/// (`import_runs.importer_version`; runs from before it existed count as 1). Raise a kind's
/// number when its import starts reading a field it didn't before: a running server then
/// re-imports that kind on its next pass, even if Scryfall's file hasn't changed.
pub fn importer_version(kind: &str) -> i64 {
    match kind {
        "oracle_cards" => 3, // 2: game_changer; 3: produced_mana (both migration 0008)
        // 2: digital, set_type (migration 0008); 3: illustration IDs (0036); 4: Cardmarket's etched
        // price and the price history (0060), so the current file is read again once.
        "default_cards" => 4,
        _ => 1,
    }
}

/// The oracle importer version that first read Scryfall's Game Changer flag.
const GAME_CHANGER_VERSION: i64 = 2;

/// The newest successful import of `kind` made by the current importer version, as a date
/// (YYYY-MM-DD): when Scryfall generated the file, or for a file given on the command line,
/// when it was imported. `None` means data that import brings isn't loaded yet (for example
/// rulings, or Game Changer flags right after migration 0008).
pub async fn current_import_date(pool: &SqlitePool, kind: &str) -> sqlx::Result<Option<String>> {
    import_date_since(pool, kind, importer_version(kind)).await
}

/// Date of the Scryfall data behind the Game Changer flags (YYYY-MM-DD), or `None` before an
/// oracle import that reads them. Unlike [`current_import_date`] it doesn't wait for later
/// importer versions, which read other fields.
pub async fn game_changers_date(pool: &SqlitePool) -> sqlx::Result<Option<String>> {
    import_date_since(pool, "oracle_cards", GAME_CHANGER_VERSION).await
}

async fn import_date_since(pool: &SqlitePool, kind: &str, min_version: i64) -> sqlx::Result<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT substr(COALESCE(source_updated_at, finished_at), 1, 10) FROM import_runs
         WHERE kind = ? AND error IS NULL AND finished_at IS NOT NULL AND IFNULL(importer_version, 1) >= ?
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(kind)
    .bind(min_version)
    .fetch_optional(pool)
    .await?
    .flatten())
}

/// The newest day with prices (YYYY-MM-DD): the price history's newest observed Scryfall file
/// (prices/). `price_dates` (migration 0057) is still filled beside `price_snapshots` so a server
/// rolled back to before the history reads it right.
pub async fn latest_price_date(pool: &SqlitePool) -> sqlx::Result<Option<String>> {
    crate::prices::latest_date(pool).await
}

/// When the card table last changed: the newest rules-text import's end, or its start while it
/// runs, so a cache built mid-import is rebuilt once it ends. From `import_runs`, where
/// `MAX(updated_at)` over cards reads every card.
pub async fn cards_changed_at(pool: &SqlitePool) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar("SELECT MAX(COALESCE(finished_at, started_at)) FROM import_runs WHERE kind = 'oracle_cards'").fetch_one(pool).await
}

/// Download and import the latest file of one kind, unless we already have that exact file
/// (`force` imports it anyway). Returns whether anything was imported.
pub async fn refresh(pool: &SqlitePool, data_dir: &Path, kind: &str, force: bool) -> anyhow::Result<bool> {
    let http = crate::routes::http_client();
    let index = bulk_index(&http, BULK_INDEX).await?;
    let item = index.find(kind)?;
    let have: Option<String> = sqlx::query_scalar(
        "SELECT source_updated_at FROM import_runs WHERE kind = ? AND error IS NULL AND finished_at IS NOT NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(kind)
    .fetch_optional(pool)
    .await?
    .flatten();
    if !force && have.as_deref() == Some(item.updated_at.as_str()) {
        return Ok(false);
    }
    let file = download(&http, item, data_dir).await?;
    match kind {
        "oracle_cards" => import_oracle(pool, &file.path, Some(item)).await?,
        "rulings" => import_rulings(pool, &file.path, Some(item)).await?,
        _ => import_default(pool, &file.path, Some(item)).await?,
    };
    Ok(true)
}

/// Background refresh for a running server: prices daily, rules text and rulings weekly. A kind
/// whose last successful import came from an older importer version (see [`importer_version`])
/// is imported on the first pass, which runs at startup.
pub fn spawn_scheduler(pool: SqlitePool, data_dir: PathBuf) {
    tokio::spawn(async move {
        loop {
            for (kind, max_age_hours) in [("default_cards", 20), ("oracle_cards", 24 * 6), ("rulings", 24 * 6)] {
                let last: Option<String> = sqlx::query_scalar(
                    "SELECT MAX(finished_at) FROM import_runs WHERE kind = ? AND error IS NULL",
                )
                .bind(kind)
                .fetch_one(&pool)
                .await
                .unwrap_or(None);
                let age = last
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok())
                    .map(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).num_hours());
                // On a database error, assume the current import is there rather than
                // downloading every hour.
                let behind = matches!(current_import_date(&pool, kind).await, Ok(None));
                if behind || age.is_none_or(|h| h >= max_age_hours) {
                    match refresh(&pool, &data_dir, kind, behind).await {
                        Ok(true) => {
                            tracing::info!(kind, "imported fresh Scryfall data");
                            crate::db::after_import(&pool).await;
                            // New names, art and prices for the public pages.
                            crate::derived::nudge();
                        }
                        Ok(false) => tracing::debug!(kind, "Scryfall data unchanged"),
                        // Batches committed before the failure still changed the tables.
                        Err(e) => {
                            tracing::warn!(kind, error = %format!("{e:#}"), "Scryfall import failed");
                            crate::db::after_import(&pool).await;
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
}

/// A bulk file to import: one given on the command line, or one we downloaded. A download is
/// deleted when this is dropped, so it goes away after its import, and also when the import, a
/// later download or the download itself fails partway.
struct BulkFile {
    path: PathBuf,
    /// Scryfall's index entry, for downloads.
    meta: Option<BulkItem>,
    downloaded: bool,
}

impl BulkFile {
    fn given(path: PathBuf) -> Self {
        Self { path, meta: None, downloaded: false }
    }
}

impl Drop for BulkFile {
    fn drop(&mut self) {
        if self.downloaded {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[derive(Deserialize, Clone)]
pub struct BulkItem {
    #[serde(rename = "type")]
    kind: String,
    /// Scryfall moved to gzipped JSON Lines in 2026; older indexes had a plain JSON array.
    jsonl_download_uri: Option<String>,
    download_uri: Option<String>,
    updated_at: String,
    compressed_size: Option<u64>,
    size: Option<u64>,
}

impl BulkItem {
    fn url(&self) -> anyhow::Result<&str> {
        self.jsonl_download_uri
            .as_deref()
            .or(self.download_uri.as_deref())
            .with_context(|| format!("no download link for {}", self.kind))
    }
}

#[derive(Deserialize)]
struct BulkIndex {
    data: Vec<BulkItem>,
}

impl BulkIndex {
    fn find(&self, kind: &str) -> anyhow::Result<&BulkItem> {
        self.data.iter().find(|i| i.kind == kind).with_context(|| format!("no {kind} in Scryfall bulk index"))
    }
}

async fn bulk_index(http: &reqwest::Client, url: &str) -> anyhow::Result<BulkIndex> {
    Ok(http
        .get(url)
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

/// Download one bulk file into `dir`. A partly written file is deleted if the download fails.
async fn download(http: &reqwest::Client, item: &BulkItem, dir: &Path) -> anyhow::Result<BulkFile> {
    let url = item.url()?;
    let path = dir.join(url.rsplit('/').next().unwrap_or("scryfall-bulk"));
    let mb = item.compressed_size.or(item.size).unwrap_or(0) / 1_000_000;
    println!("downloading {} ({mb} MB)…", item.kind);
    let resp = http.get(url).send().await?.error_for_status()?;
    let bulk = BulkFile { path, meta: Some(item.clone()), downloaded: true };
    let mut file = tokio::fs::File::create(&bulk.path).await?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        file.write_all(&chunk?).await?;
    }
    file.flush().await?;
    Ok(bulk)
}

/// Open a bulk file, gzipped or not.
fn open_bulk(path: &Path) -> anyhow::Result<Box<dyn BufRead + Send>> {
    let mut file = BufReader::with_capacity(1 << 20, std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?);
    let gzipped = file.fill_buf()?.starts_with(&[0x1f, 0x8b]);
    Ok(if gzipped {
        Box::new(BufReader::with_capacity(1 << 20, flate2::bufread::GzDecoder::new(file)))
    } else {
        Box::new(file)
    })
}

/// Parse a bulk file one card at a time on a blocking thread, sending batches.
/// Accepts JSON Lines (current Scryfall format) or one top-level JSON array (older files).
fn stream_cards<T: DeserializeOwned + Send + 'static>(path: PathBuf) -> mpsc::Receiver<anyhow::Result<Vec<T>>> {
    let (tx, rx) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let result = (|| -> anyhow::Result<()> {
            let mut reader = open_bulk(&path)?;
            let is_array = loop {
                let buf = reader.fill_buf()?;
                match buf.iter().position(|b| !b.is_ascii_whitespace()) {
                    Some(i) => {
                        let first = buf[i];
                        reader.consume(i);
                        break first == b'[';
                    }
                    None if buf.is_empty() => bail!("{} is empty", path.display()),
                    None => {
                        let n = buf.len();
                        reader.consume(n);
                    }
                }
            };
            let mut de = serde_json::Deserializer::from_reader(reader);
            if is_array {
                serde::Deserializer::deserialize_seq(&mut de, Each { tx: tx.clone() }).context("parsing bulk file")?;
            } else {
                let mut batch = Vec::with_capacity(BATCH);
                for item in de.into_iter::<T>() {
                    batch.push(item.context("parsing bulk file")?);
                    if batch.len() == BATCH && tx.blocking_send(Ok(std::mem::take(&mut batch))).is_err() {
                        return Ok(());
                    }
                }
                if !batch.is_empty() {
                    let _ = tx.blocking_send(Ok(batch));
                }
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = tx.blocking_send(Err(e));
        }
    });
    rx
}

struct Each<T> {
    tx: mpsc::Sender<anyhow::Result<Vec<T>>>,
}

impl<'de, T: DeserializeOwned> Visitor<'de> for Each<T> {
    type Value = ();
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a JSON array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        let mut batch = Vec::with_capacity(BATCH);
        while let Some(item) = seq.next_element::<T>()? {
            batch.push(item);
            if batch.len() == BATCH && self.tx.blocking_send(Ok(std::mem::take(&mut batch))).is_err() {
                return Ok(()); // receiver gone
            }
        }
        if !batch.is_empty() {
            let _ = self.tx.blocking_send(Ok(batch));
        }
        Ok(())
    }
}

// ── Scryfall card shape (only the fields we keep) ──────────────────────────

/// Scryfall's image links. The WebP keys (`thumb`, `grid`, `art`) arrived on 2026-10-14; the
/// old JPEG keys are read only as a fallback. `jpeg` is the old `normal` under its new name.
#[derive(Deserialize, Default, Clone)]
struct ImageUris {
    thumb: Option<String>,
    grid: Option<String>,
    art: Option<String>,
    jpeg: Option<String>,
    small: Option<String>,
    normal: Option<String>,
    art_crop: Option<String>,
}

impl ImageUris {
    /// 146 × 204, for lists (`image_small`).
    fn small(&self) -> Option<&String> {
        self.thumb.as_ref().or(self.small.as_ref())
    }

    /// 488 × 680, the everyday card image (`image_normal`).
    fn normal(&self) -> Option<&String> {
        self.grid.as_ref().or(self.jpeg.as_ref()).or(self.normal.as_ref())
    }

    /// The illustration alone (`image_art_crop`). Credit the artist wherever it's shown.
    fn art(&self) -> Option<&String> {
        self.art.as_ref().or(self.art_crop.as_ref())
    }
}

#[derive(Deserialize, Clone, serde::Serialize)]
struct Face {
    name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    artist: Option<String>,
    #[serde(default)]
    mana_cost: Option<String>,
    #[serde(default)]
    type_line: Option<String>,
    #[serde(default)]
    oracle_text: Option<String>,
    #[serde(default)]
    colors: Option<Vec<String>>,
    #[serde(default)]
    power: Option<String>,
    #[serde(default)]
    toughness: Option<String>,
    #[serde(default)]
    loyalty: Option<String>,
    #[serde(default)]
    oracle_id: Option<String>,
    #[serde(default, skip_serializing)]
    image_uris: Option<ImageUris>,
    #[serde(default, skip_serializing)]
    illustration_id: Option<String>,
}

#[derive(Deserialize)]
struct ScryCard {
    id: String,
    oracle_id: Option<String>,
    name: String,
    #[serde(default)]
    layout: Option<String>,
    mana_cost: Option<String>,
    #[serde(default)]
    cmc: Option<f64>,
    type_line: Option<String>,
    oracle_text: Option<String>,
    colors: Option<Vec<String>>,
    #[serde(default)]
    color_identity: Vec<String>,
    power: Option<String>,
    toughness: Option<String>,
    loyalty: Option<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    legalities: BTreeMap<String, String>,
    rarity: Option<String>,
    edhrec_rank: Option<i64>,
    /// On the Commander Game Changers list (oracle_cards). Scryfall sends true or false for
    /// every card; absent or null stays unknown (NULL), never false.
    #[serde(default)]
    game_changer: Option<bool>,
    /// Colors of mana the card can make. Scryfall leaves it out for cards that make none.
    #[serde(default)]
    produced_mana: Option<Vec<String>>,
    image_uris: Option<ImageUris>,
    card_faces: Option<Vec<Face>>,
    artist: Option<String>,
    // printing fields (default_cards)
    /// The art's identity across printings (cards with one image; faces carry their own).
    #[serde(default)]
    illustration_id: Option<String>,
    #[serde(default)]
    set: String,
    #[serde(default)]
    set_name: String,
    #[serde(default)]
    collector_number: String,
    #[serde(default)]
    lang: String,
    #[serde(default)]
    finishes: Vec<String>,
    released_at: Option<String>,
    /// Only released in a video game (MTGO, Arena). Absent stays unknown (NULL), never false.
    #[serde(default)]
    digital: Option<bool>,
    /// Scryfall's kind of set: expansion, core, masters, commander, memorabilia, promo, ...
    #[serde(default)]
    set_type: Option<String>,
    #[serde(default)]
    prices: Prices,
}

#[derive(Deserialize, Default)]
struct Prices {
    usd: Option<String>,
    usd_foil: Option<String>,
    usd_etched: Option<String>,
    eur: Option<String>,
    eur_foil: Option<String>,
    eur_etched: Option<String>,
    tix: Option<String>,
}

impl Prices {
    /// In whole cents, in `prices::SCRYFALL_SERIES` order.
    fn cents(&self) -> [Option<i64>; 7] {
        let c = |s: &Option<String>| s.as_deref().and_then(crate::prices::parse_cents);
        [c(&self.usd), c(&self.usd_foil), c(&self.usd_etched), c(&self.eur), c(&self.eur_foil), c(&self.eur_etched), c(&self.tix)]
    }
}

impl ScryCard {
    /// Reversible cards carry the oracle ID only on their faces.
    fn oracle_id(&self) -> Option<&str> {
        self.oracle_id
            .as_deref()
            .or_else(|| self.card_faces.as_ref()?.first()?.oracle_id.as_deref())
    }

    fn front_images(&self) -> ImageUris {
        self.image_uris
            .clone()
            .or_else(|| self.card_faces.as_ref()?.first()?.image_uris.clone())
            .unwrap_or_default()
    }

    fn back_image(&self) -> Option<String> {
        if self.image_uris.is_some() {
            return None; // single image (split, adventure, flip…)
        }
        self.card_faces.as_ref()?.get(1)?.image_uris.as_ref()?.normal().cloned()
    }

    /// Illustration IDs of the front and, for cards with two images, the back.
    fn illustrations(&self) -> (Option<&String>, Option<&String>) {
        let face = |i: usize| self.card_faces.as_ref()?.get(i)?.illustration_id.as_ref();
        let front = self.illustration_id.as_ref().or_else(|| face(0));
        let back = if self.image_uris.is_some() { None } else { face(1) };
        (front, back)
    }

    fn front(&self, get: fn(&Face) -> Option<&String>) -> Option<&String> {
        self.card_faces.as_ref().and_then(|fs| fs.first()).and_then(get)
    }

    /// Rules text of every face, joined the way Scryfall shows it.
    fn full_oracle_text(&self) -> String {
        if let Some(t) = &self.oracle_text {
            return t.clone();
        }
        self.card_faces
            .as_ref()
            .map(|fs| fs.iter().filter_map(|f| f.oracle_text.clone()).collect::<Vec<_>>().join("\n//\n"))
            .unwrap_or_default()
    }

    fn colors(&self) -> String {
        let cs = self.colors.clone().or_else(|| {
            let fs = self.card_faces.as_ref()?;
            Some(fs.iter().flat_map(|f| f.colors.clone().unwrap_or_default()).collect())
        });
        wubrg(&cs.unwrap_or_default())
    }
}

/// Colors in WUBRG order as a compact string, e.g. ["G","W"] → "WG".
pub fn wubrg(colors: &[String]) -> String {
    "WUBRG".chars().filter(|c| colors.iter().any(|x| x.starts_with(*c))).collect()
}

/// Scryfall's produced_mana (["G","W","C"]) as "WGC": WUBRG order, colorless last. Empty for
/// a card that makes no mana.
fn produced_mana(colors: &[String]) -> String {
    "WUBRGC".chars().filter(|c| colors.iter().any(|x| x.len() == 1 && x.starts_with(*c))).collect()
}

async fn start_run(pool: &SqlitePool, kind: &str, meta: Option<&BulkItem>) -> anyhow::Result<String> {
    let id = new_id();
    sqlx::query(
        "INSERT INTO import_runs (id, kind, source_url, source_updated_at, started_at, importer_version) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(kind)
    .bind(meta.and_then(|m| m.url().ok().map(str::to_string)))
    .bind(meta.map(|m| m.updated_at.clone()))
    .bind(now())
    .bind(importer_version(kind))
    .execute(pool)
    .await?;
    Ok(id)
}

/// An import slower than this is a warning in the log (perf.rs). The daily printings and prices
/// take about two minutes on saget.
const SLOW_IMPORT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Record an import's end in `import_runs`, then time it: one log line, and a row in Admin,
/// Server. The import fails if its record can't be written either.
async fn finish_timed(pool: &SqlitePool, run: &str, kind: &str, job: crate::perf::Job, result: &anyhow::Result<usize>) -> anyhow::Result<()> {
    let recorded = finish_run(pool, run, result).await;
    let rows = result.as_ref().map(|n| format!(", {n} rows")).unwrap_or_default();
    let unrecorded = if recorded.is_err() { ", its import_runs row not written" } else { "" };
    job.done(result.is_ok() && recorded.is_ok(), format!("{kind}{rows}{unrecorded}"));
    recorded
}

async fn finish_run(pool: &SqlitePool, id: &str, result: &anyhow::Result<usize>) -> anyhow::Result<()> {
    let (rows, error) = match result {
        Ok(n) => (Some(*n as i64), None),
        Err(e) => (None, Some(format!("{e:#}"))),
    };
    sqlx::query("UPDATE import_runs SET finished_at = ?, rows = ?, error = ? WHERE id = ?")
        .bind(now())
        .bind(rows)
        .bind(error)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn import_oracle(pool: &SqlitePool, path: &Path, meta: Option<&BulkItem>) -> anyhow::Result<usize> {
    let job = crate::perf::Job::start("Scryfall import", SLOW_IMPORT);
    let run = start_run(pool, "oracle_cards", meta).await?;
    let result = import_oracle_inner(pool, path).await;
    finish_timed(pool, &run, "oracle_cards", job, &result).await?;
    result
}

async fn import_oracle_inner(pool: &SqlitePool, path: &Path) -> anyhow::Result<usize> {
    let mut rx = stream_cards::<ScryCard>(path.to_path_buf());
    let mut count = 0;
    let stamp = now();
    while let Some(batch) = rx.recv().await {
        let mut tx = pool.begin().await?;
        for c in batch? {
            if c.layout.as_deref().is_some_and(|l| SKIP_LAYOUTS.contains(&l)) {
                continue;
            }
            let Some(oracle_id) = c.oracle_id().map(str::to_string) else { continue };
            let images = c.front_images();
            let faces = c.card_faces.as_ref().map(|f| serde_json::to_string(f)).transpose()?;
            sqlx::query(
                "INSERT INTO cards (oracle_id, name, mana_cost, cmc, type_line, oracle_text, colors, color_identity,
                    power, toughness, loyalty, keywords, legalities, rarity, layout, edhrec_rank, default_printing,
                    image_small, image_normal, image_art_crop, back_image_normal, artist, faces, game_changer,
                    produced_mana, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(oracle_id) DO UPDATE SET name=excluded.name, mana_cost=excluded.mana_cost,
                    cmc=excluded.cmc, type_line=excluded.type_line, oracle_text=excluded.oracle_text,
                    colors=excluded.colors, color_identity=excluded.color_identity, power=excluded.power,
                    toughness=excluded.toughness, loyalty=excluded.loyalty, keywords=excluded.keywords,
                    legalities=excluded.legalities, rarity=excluded.rarity, layout=excluded.layout,
                    edhrec_rank=excluded.edhrec_rank, default_printing=excluded.default_printing,
                    image_small=excluded.image_small, image_normal=excluded.image_normal,
                    image_art_crop=excluded.image_art_crop, back_image_normal=excluded.back_image_normal,
                    artist=excluded.artist, faces=excluded.faces, game_changer=excluded.game_changer,
                    produced_mana=excluded.produced_mana, updated_at=excluded.updated_at",
            )
            .bind(&oracle_id)
            .bind(&c.name)
            .bind(c.mana_cost.as_ref().or(c.front(|f| f.mana_cost.as_ref())))
            .bind(c.cmc.unwrap_or(0.0))
            .bind(c.type_line.as_ref().or(c.front(|f| f.type_line.as_ref())).cloned().unwrap_or_default())
            .bind(c.full_oracle_text())
            .bind(c.colors())
            .bind(wubrg(&c.color_identity))
            .bind(c.power.as_ref().or(c.front(|f| f.power.as_ref())))
            .bind(c.toughness.as_ref().or(c.front(|f| f.toughness.as_ref())))
            .bind(c.loyalty.as_ref().or(c.front(|f| f.loyalty.as_ref())))
            .bind(serde_json::to_string(&c.keywords)?)
            .bind(serde_json::to_string(&c.legalities)?)
            .bind(&c.rarity)
            .bind(&c.layout)
            .bind(c.edhrec_rank)
            .bind(&c.id)
            .bind(images.small())
            .bind(images.normal())
            .bind(images.art())
            .bind(c.back_image())
            .bind(&c.artist)
            .bind(faces)
            .bind(c.game_changer)
            .bind(produced_mana(c.produced_mana.as_deref().unwrap_or_default()))
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;

            let mut names = vec![c.name.clone()];
            if let Some(fs) = &c.card_faces {
                names.extend(fs.iter().map(|f| f.name.clone()));
            }
            for name in names {
                sqlx::query("INSERT OR IGNORE INTO card_names (name, oracle_id) VALUES (?, ?)")
                    .bind(name)
                    .bind(&oracle_id)
                    .execute(&mut *tx)
                    .await?;
            }
            count += 1;
        }
        tx.commit().await?;
    }
    if count == 0 {
        bail!("no cards found in {}", path.display());
    }
    sqlx::query("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')").execute(pool).await?;
    Ok(count)
}

pub async fn import_default(pool: &SqlitePool, path: &Path, meta: Option<&BulkItem>) -> anyhow::Result<usize> {
    // Price days are written in order, by one writer: the replay of the old table first, if it
    // has days the history doesn't.
    let writer = crate::prices::Writer::acquire(pool).await?;
    let result = import_default_writing(pool, path, meta, &writer).await;
    writer.release().await;
    result
}

async fn import_default_writing(pool: &SqlitePool, path: &Path, meta: Option<&BulkItem>, writer: &crate::prices::Writer) -> anyhow::Result<usize> {
    crate::prices::backfill::backfill_if_needed(pool, writer).await.context("replaying the old price table")?;
    let job = crate::perf::Job::start("Scryfall import", SLOW_IMPORT);
    let run = start_run(pool, "default_cards", meta).await?;
    // Prices belong to the day Scryfall generated the file, not the day we imported it.
    let price_date = meta.map(|m| m.updated_at[..10].to_string()).unwrap_or_else(|| now()[..10].to_string());
    let day = crate::prices::day_of(&price_date).with_context(|| format!("{price_date:?} isn't a date"))?;
    // Never into the past: a value written before the newest observed day could change what
    // later days read. The printings still import.
    let newest = crate::prices::newest_observation(pool, crate::prices::SCRYFALL).await?;
    let history = newest.is_none_or(|n| day >= n);
    if !history {
        tracing::warn!(price_date, newest = newest.map(crate::prices::date_of), "Scryfall's file is older than the newest prices; its prices aren't written");
    }
    let file = HistoryFile { day, date: &price_date, run: &run, updated_at: meta.map(|m| m.updated_at.clone()), writer, prices: history };
    let result = import_default_inner(pool, path, &file).await;
    finish_timed(pool, &run, "default_cards", job, &result).await?;
    let count = result?;
    if history {
        verify_day(pool, &price_date).await;
    }
    Ok(count)
}

/// Where a printings import's prices go.
struct HistoryFile<'a> {
    day: i64,
    date: &'a str,
    run: &'a str,
    updated_at: Option<String>,
    writer: &'a crate::prices::Writer,
    /// False for a file older than the newest observed day: no prices are written, in either
    /// table.
    prices: bool,
}

/// While `price_snapshots` is still written, check the day's history against it and keep the
/// result (`price_meta`, shown in Admin, Server). A difference is logged, never fatal.
async fn verify_day(pool: &SqlitePool, date: &str) {
    match crate::prices::backfill::verify(pool, Some(date)).await {
        Ok(v) => {
            let text = serde_json::to_string(&v).unwrap_or_default();
            if !v.clean() {
                tracing::error!(date, %text, "price history doesn't match price_snapshots for this day");
            }
            let stored = sqlx::query("INSERT INTO price_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
                .bind(format!("verify:{date}"))
                .bind(text)
                .execute(pool)
                .await;
            if let Err(e) = stored {
                tracing::warn!(error = %e, "couldn't record the price history check");
            }
        }
        Err(e) => tracing::warn!(date, error = %e, "couldn't check the price history against price_snapshots"),
    }
}

async fn import_default_inner(pool: &SqlitePool, path: &Path, file: &HistoryFile<'_>) -> anyhow::Result<usize> {
    let price_date = file.date;
    let mut rx = stream_cards::<ScryCard>(path.to_path_buf());
    let mut count = 0;
    let stamp = now();
    while let Some(batch) = rx.recv().await {
        let mut tx = pool.begin().await?;
        // A writer whose lease another process took stops before it writes anything more.
        file.writer.fence(&mut tx).await?;
        let mut prices = Vec::new();
        for c in batch? {
            if c.layout.as_deref().is_some_and(|l| SKIP_LAYOUTS.contains(&l)) {
                continue;
            }
            let Some(oracle_id) = c.oracle_id().map(str::to_string) else { continue };
            let images = c.front_images();
            let (illustration, back_illustration) = c.illustrations();
            sqlx::query(
                "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang,
                    rarity, finishes, released_at, image_normal, image_small, image_art_crop, back_image_normal,
                    artist, digital, set_type, illustration_id, back_illustration_id, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(scryfall_id) DO UPDATE SET oracle_id=excluded.oracle_id, name=excluded.name,
                    set_code=excluded.set_code, set_name=excluded.set_name,
                    collector_number=excluded.collector_number, lang=excluded.lang, rarity=excluded.rarity,
                    finishes=excluded.finishes, released_at=excluded.released_at,
                    image_normal=excluded.image_normal, image_small=excluded.image_small,
                    image_art_crop=excluded.image_art_crop, back_image_normal=excluded.back_image_normal,
                    artist=excluded.artist, digital=excluded.digital, set_type=excluded.set_type,
                    illustration_id=excluded.illustration_id, back_illustration_id=excluded.back_illustration_id,
                    updated_at=excluded.updated_at
                 -- Only a printing that changed (136 of 117,181 between two days' files): updated_at
                 -- now means its last change, and an import rewrites a few rows, not every one.
                 WHERE (printings.oracle_id, printings.name, printings.set_code, printings.set_name, printings.collector_number,
                        printings.lang, printings.rarity, printings.finishes, printings.released_at, printings.image_normal,
                        printings.image_small, printings.image_art_crop, printings.back_image_normal, printings.artist,
                        printings.digital, printings.set_type, printings.illustration_id, printings.back_illustration_id)
                    IS NOT (excluded.oracle_id, excluded.name, excluded.set_code, excluded.set_name, excluded.collector_number,
                        excluded.lang, excluded.rarity, excluded.finishes, excluded.released_at, excluded.image_normal,
                        excluded.image_small, excluded.image_art_crop, excluded.back_image_normal, excluded.artist,
                        excluded.digital, excluded.set_type, excluded.illustration_id, excluded.back_illustration_id)",
            )
            .bind(&c.id)
            .bind(&oracle_id)
            .bind(&c.name)
            .bind(&c.set)
            .bind(&c.set_name)
            .bind(&c.collector_number)
            .bind(&c.lang)
            .bind(&c.rarity)
            .bind(serde_json::to_string(&c.finishes)?)
            .bind(&c.released_at)
            .bind(images.normal())
            .bind(images.small())
            .bind(images.art())
            .bind(c.back_image())
            .bind(&c.artist)
            .bind(c.digital)
            .bind(&c.set_type)
            .bind(illustration)
            .bind(back_illustration)
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;

            prices.push(crate::prices::write::ScryfallRow { scryfall_id: c.id.clone(), cents: c.prices.cents() });
            count += 1;
        }
        if file.prices {
            crate::prices::write::stage(&mut tx, file.run, &prices).await?;
        }
        tx.commit().await?;
    }
    if count == 0 {
        bail!("no printings found in {}", path.display());
    }
    // The whole file at once, in both tables: its prices, and none for printings it left out.
    if file.prices {
        let observation = crate::prices::write::Observation {
            file: file.run.to_string(),
            file_updated_at: file.updated_at.clone(),
            import_run: Some(file.run.to_string()),
            printings: count as i64,
        };
        let mut tx = pool.begin().await?;
        file.writer.fence(&mut tx).await?;
        replace_old_day(&mut tx, price_date, file.run).await?;
        crate::prices::write::publish(&mut tx, file.writer, file.day, price_date, &observation).await?;
        tx.commit().await?;
    }
    Ok(count)
}

/// The old table's day becomes this staged file's, in the publish's transaction: a row for each
/// printing it prices, and none for one it doesn't (a second file for the day replaces the
/// first). The old table never kept Cardmarket's etched price, nor a row without one of its six
/// prices. REAL = cents / 100.0, the same double as the decimal text it used to parse.
async fn replace_old_day(conn: &mut sqlx::SqliteConnection, date: &str, file: &str) -> sqlx::Result<()> {
    const PRICED: &str = "(st.usd IS NOT NULL OR st.usd_foil IS NOT NULL OR st.usd_etched IS NOT NULL OR st.eur IS NOT NULL
        OR st.eur_foil IS NOT NULL OR st.tix IS NOT NULL)";
    for template in [
        "DELETE FROM price_snapshots WHERE date = ?1 AND scryfall_id NOT IN (SELECT st.scryfall_id FROM price_stage st WHERE st.file = ?2 AND {PRICED})",
        "INSERT OR REPLACE INTO price_snapshots (scryfall_id, date, usd, usd_foil, usd_etched, eur, eur_foil, tix)
         SELECT st.scryfall_id, ?1, st.usd / 100.0, st.usd_foil / 100.0, st.usd_etched / 100.0, st.eur / 100.0, st.eur_foil / 100.0, st.tix / 100.0
           FROM price_stage st WHERE st.file = ?2 AND {PRICED}",
        "INSERT OR IGNORE INTO price_dates (date) SELECT ?1 WHERE EXISTS (SELECT 1 FROM price_stage st WHERE st.file = ?2 AND {PRICED})",
    ] {
        sqlx::query(sqlx::AssertSqlSafe(template.replace("{PRICED}", PRICED))).bind(date).bind(file).execute(&mut *conn).await?;
    }
    Ok(())
}

#[derive(Deserialize)]
struct ScryRuling {
    oracle_id: Option<String>,
    #[serde(default)]
    source: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    comment: String,
}

pub async fn import_rulings(pool: &SqlitePool, path: &Path, meta: Option<&BulkItem>) -> anyhow::Result<usize> {
    let job = crate::perf::Job::start("Scryfall import", SLOW_IMPORT);
    let run = start_run(pool, "rulings", meta).await?;
    let result = import_rulings_inner(pool, path).await;
    finish_timed(pool, &run, "rulings", job, &result).await?;
    result
}

/// Replace every ruling in one transaction, so a failed import leaves the old set in place
/// and running it twice gives the same table.
async fn import_rulings_inner(pool: &SqlitePool, path: &Path) -> anyhow::Result<usize> {
    let mut rx = stream_cards::<ScryRuling>(path.to_path_buf());
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM rulings").execute(&mut *tx).await?;
    let mut count = 0;
    while let Some(batch) = rx.recv().await {
        for r in batch? {
            let Some(oracle_id) = r.oracle_id.filter(|id| !id.is_empty()) else { continue };
            if r.comment.trim().is_empty() {
                continue;
            }
            sqlx::query("INSERT INTO rulings (oracle_id, source, published_at, comment) VALUES (?,?,?,?)")
                .bind(oracle_id)
                .bind(&r.source)
                .bind(&r.published_at)
                .bind(&r.comment)
                .execute(&mut *tx)
                .await?;
            count += 1;
        }
    }
    if count == 0 {
        bail!("no rulings found in {}", path.display());
    }
    tx.commit().await?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      {"id":"p1","oracle_id":"o1","name":"Sol Ring","layout":"normal","mana_cost":"{1}","cmc":1.0,
       "type_line":"Artifact","oracle_text":"{T}: Add {C}{C}.","colors":[],"color_identity":[],
       "produced_mana":["C"],"keywords":[],"legalities":{"commander":"legal","vintage":"restricted"},"rarity":"uncommon",
       "image_uris":{"small":"s","normal":"n","art_crop":"a"},"illustration_id":"ill-sol","set":"cmm","set_name":"Commander Masters",
       "collector_number":"410","lang":"en","finishes":["nonfoil","foil"],"digital":false,"set_type":"masters",
       "prices":{"usd":"1.50","usd_foil":null,"eur":"1.20","tix":null}},
      {"id":"p2","oracle_id":"o2","name":"Fable of the Mirror-Breaker // Reflection of Kiki-Jiki",
       "layout":"transform","cmc":3.0,"type_line":"Enchantment — Saga // Enchantment Creature — Goblin Shaman",
       "colors":["R"],"color_identity":["R"],"legalities":{"commander":"legal"},
       "card_faces":[{"name":"Fable of the Mirror-Breaker","mana_cost":"{2}{R}","type_line":"Enchantment — Saga",
         "oracle_text":"(As this Saga enters...)","image_uris":{"normal":"front"},"illustration_id":"ill-fable"},
        {"name":"Reflection of Kiki-Jiki","mana_cost":"","type_line":"Enchantment Creature — Goblin Shaman",
         "oracle_text":"{1}, {T}: Create a token...","power":"2","toughness":"2","image_uris":{"normal":"back"},"illustration_id":"ill-kiki"}],
       "set":"neo","set_name":"Kamigawa: Neon Dynasty","collector_number":"141","lang":"en","finishes":["nonfoil"],
       "prices":{"usd":null}},
      {"id":"p3","oracle_id":"o3","name":"Art","layout":"art_series","set":"x","collector_number":"1","lang":"en"}
    ]"#;

    #[tokio::test]
    async fn imports_cards_faces_and_prices() {
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bulk.json");
        std::fs::write(&path, SAMPLE).unwrap();

        assert_eq!(import_oracle(&pool, &path, None).await.unwrap(), 2);
        assert_eq!(import_default(&pool, &path, None).await.unwrap(), 2);

        let (mana, text, back): (Option<String>, String, Option<String>) =
            sqlx::query_as("SELECT mana_cost, oracle_text, back_image_normal FROM cards WHERE oracle_id='o2'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(mana.as_deref(), Some("{2}{R}"));
        assert!(text.contains("\n//\n"));
        assert_eq!(back.as_deref(), Some("back"));

        let face: (String,) = sqlx::query_as("SELECT oracle_id FROM card_names WHERE name='reflection of kiki-jiki'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(face.0, "o2");

        // Mana a card makes; a card that makes none (Scryfall omits the field) is '', not unknown.
        let made: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT oracle_id, produced_mana FROM cards ORDER BY oracle_id").fetch_all(&pool).await.unwrap();
        assert_eq!(made, vec![("o1".into(), Some("C".into())), ("o2".into(), Some(String::new()))]);
        assert_eq!(produced_mana(&["G".into(), "W".into(), "C".into(), "U".into()]), "WUGC");

        // Paper or digital-only, and the kind of set; a file without them leaves them unknown.
        let kinds: Vec<(String, Option<bool>, Option<String>)> =
            sqlx::query_as("SELECT scryfall_id, digital, set_type FROM printings ORDER BY scryfall_id").fetch_all(&pool).await.unwrap();
        assert_eq!(kinds, vec![("p1".into(), Some(false), Some("masters".into())), ("p2".into(), None, None)]);

        // Art identity for the scanner: the card's, or each face's when the faces have their own images.
        let arts: Vec<(String, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT scryfall_id, illustration_id, back_illustration_id FROM printings ORDER BY scryfall_id").fetch_all(&pool).await.unwrap();
        assert_eq!(arts, vec![("p1".into(), Some("ill-sol".into()), None), ("p2".into(), Some("ill-fable".into()), Some("ill-kiki".into()))]);

        // Missing prices stay missing; a printing with no prices at all gets no row.
        let prices: Vec<(String, Option<f64>, Option<f64>)> =
            sqlx::query_as("SELECT scryfall_id, usd, usd_foil FROM price_snapshots").fetch_all(&pool).await.unwrap();
        assert_eq!(prices, vec![("p1".into(), Some(1.5), None)]);
        // The newest price date is the one those prices went under, without reading them all.
        let stored: String = sqlx::query_scalar("SELECT MAX(date) FROM price_snapshots").fetch_one(&pool).await.unwrap();
        assert_eq!(latest_price_date(&pool).await.unwrap(), Some(stored.clone()));
        // The history has the same prices, in cents, and checks clean against the old table.
        let latest: Vec<(String, String, Option<f64>, Option<f64>, Option<f64>)> =
            sqlx::query_as("SELECT scryfall_id, date, usd, usd_foil, eur FROM price_latest").fetch_all(&pool).await.unwrap();
        assert_eq!(latest, vec![("p1".into(), stored.clone(), Some(1.5), None, Some(1.2))]);
        let check = crate::prices::backfill::verify(&pool, Some(&stored)).await.unwrap();
        assert_eq!((check.rows, check.mismatches, check.stale), (1, 0, 0));
        let kept: String = sqlx::query_scalar("SELECT value FROM price_meta WHERE key = ?").bind(format!("verify:{stored}")).fetch_one(&pool).await.unwrap();
        assert!(kept.contains("\"mismatches\":0"), "{kept}");

        // The same file again: no printing is rewritten, and the history doesn't change.
        sqlx::query("UPDATE printings SET updated_at = 'before'").execute(&pool).await.unwrap();
        let points: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM price_point").fetch_one(&pool).await.unwrap();
        assert_eq!(import_default(&pool, &path, None).await.unwrap(), 2);
        let touched: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM printings WHERE updated_at != 'before'").fetch_one(&pool).await.unwrap();
        assert_eq!(touched, 0);
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM price_point").fetch_one(&pool).await.unwrap(), points);
    }

    #[tokio::test]
    async fn an_older_file_never_writes_into_the_price_history() {
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bulk.json");
        std::fs::write(&path, SAMPLE.replace("\"usd\":\"1.50\"", "\"usd\":\"1.50\",\"eur_etched\":\"3.00\"")).unwrap();
        let item = |date: &str| BulkItem { kind: "default_cards".into(), jsonl_download_uri: None, download_uri: None, updated_at: format!("{date}T09:05:00Z"), compressed_size: None, size: None };
        import_default(&pool, &path, Some(&item("2026-11-01"))).await.unwrap();
        let points: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM price_point").fetch_one(&pool).await.unwrap();
        // Cardmarket's etched price is read now too.
        let etched: Option<f64> = sqlx::query_scalar("SELECT eur_etched FROM price_latest WHERE scryfall_id = 'p1'").fetch_one(&pool).await.unwrap();
        assert_eq!(etched, Some(3.0));
        // An older file still imports its printings, but writes no prices, in the history or the
        // old table.
        import_default(&pool, &path, Some(&item("2026-10-30"))).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM price_point").fetch_one(&pool).await.unwrap(), points);
        let days: Vec<i64> = sqlx::query_scalar("SELECT day FROM price_observation ORDER BY day").fetch_all(&pool).await.unwrap();
        assert_eq!(days, vec![crate::prices::day_of("2026-11-01").unwrap()]);
        let old: Vec<String> = sqlx::query_scalar("SELECT DISTINCT date FROM price_snapshots UNION SELECT date FROM price_dates").fetch_all(&pool).await.unwrap();
        assert_eq!(old, ["2026-11-01"]);
    }

    #[tokio::test]
    async fn a_writer_that_lost_its_lease_writes_no_prices() {
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bulk.json");
        std::fs::write(&path, SAMPLE).unwrap();
        // It stalls past its lease, and another process takes it and carries on.
        let writer = crate::prices::Writer::acquire(&pool).await.unwrap();
        sqlx::query("UPDATE price_meta SET value = json_object('id', 'elsewhere', 'until', 0) WHERE key = 'writer'").execute(&pool).await.unwrap();
        let err = import_default_writing(&pool, &path, None, &writer).await.unwrap_err();
        writer.release().await;
        assert!(err.to_string().contains("lease"), "{err}");
        for table in ["price_snapshots", "price_dates", "price_stage", "price_point", "price_latest", "printings"] {
            let rows: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}"))).fetch_one(&pool).await.unwrap();
            assert_eq!(rows, 0, "{table}");
        }
    }

    #[tokio::test]
    async fn a_second_file_for_the_day_replaces_the_first_in_both_tables() {
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bulk.json");
        let at = |time: &str| BulkItem { kind: "default_cards".into(), jsonl_download_uri: None, download_uri: None, updated_at: format!("2026-11-01T{time}Z"), compressed_size: None, size: None };
        std::fs::write(&path, SAMPLE).unwrap();
        import_default(&pool, &path, Some(&at("09:05:00"))).await.unwrap();
        // The evening's file has no price for Sol Ring.
        std::fs::write(&path, SAMPLE.replace("\"usd\":\"1.50\"", "\"usd\":null").replace("\"eur\":\"1.20\"", "\"eur\":null")).unwrap();
        import_default(&pool, &path, Some(&at("21:06:00"))).await.unwrap();
        let old: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM price_snapshots WHERE date = '2026-11-01'").fetch_one(&pool).await.unwrap();
        assert_eq!(old, 0, "the morning's price isn't left in the old table");
        let latest: (String, Option<f64>, Option<f64>) = sqlx::query_as("SELECT date, usd, eur FROM price_latest WHERE scryfall_id = 'p1'").fetch_one(&pool).await.unwrap();
        assert_eq!(latest, ("2026-11-01".into(), None, None));
        // Nor in the history: with no price before the day, it has no row at all.
        let points: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM price_point").fetch_one(&pool).await.unwrap();
        assert_eq!(points, 0);
        let check = crate::prices::backfill::verify(&pool, Some("2026-11-01")).await.unwrap();
        assert_eq!((check.rows, check.mismatches, check.stale), (0, 0, 0));
    }

    #[tokio::test]
    async fn reads_gzipped_json_lines() {
        use std::io::Write;
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bulk.jsonl.gz");
        let cards: Vec<serde_json::Value> = serde_json::from_str(SAMPLE).unwrap();
        let mut gz = flate2::write::GzEncoder::new(std::fs::File::create(&path).unwrap(), flate2::Compression::fast());
        for c in &cards {
            writeln!(gz, "{c}").unwrap();
        }
        gz.finish().unwrap();
        assert_eq!(import_oracle(&pool, &path, None).await.unwrap(), 2);
    }

    /// Shape of Scryfall's image_uris since 2026-10-14 (Sol Ring, checked 2026-10-18): the old
    /// JPEG keys and the new WebP ones side by side.
    const WEBP: &str = r#"[
      {"id":"p1","oracle_id":"o1","name":"Sol Ring","layout":"normal","cmc":1.0,"type_line":"Artifact",
       "color_identity":[],"legalities":{"commander":"legal"},"game_changer":true,
       "image_uris":{"small":"https://cards.scryfall.io/small/front/s.jpg","normal":"https://cards.scryfall.io/normal/front/s.jpg",
         "large":"https://cards.scryfall.io/large/front/s.jpg","art_crop":"https://cards.scryfall.io/art_crop/front/s.jpg",
         "thumb":"https://cards.scryfall.io/thumb/front/s.webp","grid":"https://cards.scryfall.io/grid/front/s.webp",
         "display":"https://cards.scryfall.io/display/front/s.webp","art":"https://cards.scryfall.io/art/front/s.webp",
         "crop":"https://cards.scryfall.io/crop/front/s.webp","jpeg":"https://cards.scryfall.io/normal/front/s.jpg"},
       "set":"cmm","set_name":"Commander Masters","collector_number":"410","lang":"en","finishes":["nonfoil"]},
      {"id":"p2","oracle_id":"o2","name":"Front // Back","layout":"transform","cmc":2.0,"type_line":"Creature // Creature",
       "color_identity":["G"],"legalities":{"commander":"legal"},"game_changer":null,
       "card_faces":[{"name":"Front","image_uris":{"normal":"old-front","grid":"front.webp"}},
                     {"name":"Back","image_uris":{"jpeg":"back.jpg"}}],
       "set":"x","set_name":"X","collector_number":"2","lang":"en","finishes":["nonfoil"]}
    ]"#;

    #[tokio::test]
    async fn prefers_webp_image_keys_and_reads_game_changer() {
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bulk.json");
        std::fs::write(&path, WEBP).unwrap();
        import_oracle(&pool, &path, None).await.unwrap();
        import_default(&pool, &path, None).await.unwrap();

        type Images = (Option<String>, Option<String>, Option<String>, Option<String>, Option<bool>);
        let sol: Images = sqlx::query_as(
            "SELECT image_small, image_normal, image_art_crop, back_image_normal, game_changer FROM cards WHERE oracle_id='o1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(sol.0.as_deref(), Some("https://cards.scryfall.io/thumb/front/s.webp"));
        assert_eq!(sol.1.as_deref(), Some("https://cards.scryfall.io/grid/front/s.webp"));
        assert_eq!(sol.2.as_deref(), Some("https://cards.scryfall.io/art/front/s.webp"));
        assert_eq!(sol.3, None);
        assert_eq!(sol.4, Some(true));

        let dfc: Images = sqlx::query_as(
            "SELECT image_small, image_normal, image_art_crop, back_image_normal, game_changer FROM cards WHERE oracle_id='o2'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(dfc.1.as_deref(), Some("front.webp"));
        assert_eq!(dfc.3.as_deref(), Some("back.jpg"), "the renamed jpeg key is a fallback for grid");
        assert_eq!(dfc.4, None, "a null game_changer stays unknown");

        let printing: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT image_small, image_normal FROM printings WHERE scryfall_id='p1'").fetch_one(&pool).await.unwrap();
        assert_eq!(printing.0.as_deref(), Some("https://cards.scryfall.io/thumb/front/s.webp"));
        assert_eq!(printing.1.as_deref(), Some("https://cards.scryfall.io/grid/front/s.webp"));

        // Files from before the change only have the JPEG keys.
        let old = dir.path().join("old.json");
        std::fs::write(&old, SAMPLE).unwrap();
        import_oracle(&pool, &old, None).await.unwrap();
        let (small, normal, art): (Option<String>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT image_small, image_normal, image_art_crop FROM cards WHERE oracle_id='o1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((small.as_deref(), normal.as_deref(), art.as_deref()), (Some("s"), Some("n"), Some("a")));
    }

    #[tokio::test]
    async fn imports_rulings_replacing_the_old_set() {
        use std::io::Write;
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rulings.jsonl.gz");
        let lines = [
            r#"{"object":"ruling","oracle_id":"o1","source":"wotc","published_at":"2004-10-04","comment":"First."}"#,
            r#"{"object":"ruling","oracle_id":"o1","source":"scryfall","published_at":"2021-03-19","comment":"Second."}"#,
            r#"{"object":"ruling","oracle_id":"o2","source":"wotc","published_at":"2019-05-03","comment":"Other card."}"#,
            r#"{"object":"ruling","oracle_id":null,"source":"wotc","published_at":"2019-05-03","comment":"No card."}"#,
        ];
        let mut gz = flate2::write::GzEncoder::new(std::fs::File::create(&path).unwrap(), flate2::Compression::fast());
        for l in lines {
            writeln!(gz, "{l}").unwrap();
        }
        gz.finish().unwrap();

        assert_eq!(import_rulings(&pool, &path, None).await.unwrap(), 3);
        // Running it again replaces rather than duplicates.
        assert_eq!(import_rulings(&pool, &path, None).await.unwrap(), 3);
        let rows: Vec<(String, String, String)> =
            sqlx::query_as("SELECT source, published_at, comment FROM rulings WHERE oracle_id='o1' ORDER BY published_at")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            rows,
            vec![
                ("wotc".into(), "2004-10-04".into(), "First.".into()),
                ("scryfall".into(), "2021-03-19".into(), "Second.".into())
            ]
        );
        // What GET /api/cards/:id returns: oldest first.
        let served = crate::cards::rulings_for(&pool, "o1").await.unwrap();
        assert_eq!(served.iter().map(|r| r.comment.as_str()).collect::<Vec<_>>(), ["First.", "Second."]);
        assert!(crate::cards::rulings_for(&pool, "o9").await.unwrap().is_empty());

        let runs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM import_runs WHERE kind='rulings' AND error IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(runs, 2);

        // An empty file is an error and leaves the rulings we had.
        let empty = dir.path().join("empty.json");
        std::fs::write(&empty, "[]").unwrap();
        assert!(import_rulings(&pool, &empty, None).await.is_err());
        let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rulings").fetch_one(&pool).await.unwrap();
        assert_eq!(total, 3);
    }

    /// A local stand-in for Scryfall's bulk index whose rulings file breaks off after its first
    /// bytes, the way a dropped connection would. Returns the index URL.
    async fn bulk_server_with_broken_rulings() -> String {
        use axum::{Router, body::Body, routing::get};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let item = |kind: &str| {
            serde_json::json!({"type": kind, "jsonl_download_uri": format!("{base}/files/{kind}-20261018.json"),
                               "updated_at": "2026-10-18T21:00:00.000+00:00"})
        };
        let index = serde_json::json!({"data": [item("oracle_cards"), item("default_cards"), item("rulings")]}).to_string();
        let app = Router::new()
            .route("/bulk-data", get(move || async move { index }))
            .route("/files/oracle_cards-20261018.json", get(|| async { SAMPLE }))
            .route("/files/default_cards-20261018.json", get(|| async { SAMPLE }))
            .route(
                "/files/rulings-20261018.json",
                get(|| async {
                    // The pause lets the first bytes reach the client (and the file) before the break.
                    let chunks = futures_util::stream::iter([false, true]).then(|broken| async move {
                        if broken {
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            Err(std::io::Error::other("connection lost"))
                        } else {
                            Ok(r#"{"object":"ruling","oracle_id":"o1""#)
                        }
                    });
                    Body::from_stream(chunks)
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("{base}/bulk-data")
    }

    #[tokio::test]
    async fn a_failed_rulings_download_still_deletes_the_card_files() {
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let index = bulk_server_with_broken_rulings().await;

        assert!(run_from(&pool, dir.path(), &index, None, None, None).await.is_err());
        // Both card files were downloaded and imported…
        let cards: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cards").fetch_one(&pool).await.unwrap();
        let printings: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM printings").fetch_one(&pool).await.unwrap();
        assert_eq!((cards, printings), (2, 2));
        // …and nothing is left on disk, not even the partial rulings file.
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert!(left.is_empty(), "left behind: {left:?}");
    }

    #[tokio::test]
    async fn files_given_on_the_command_line_are_kept() {
        let pool = crate::db::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let cards = dir.path().join("cards.json");
        std::fs::write(&cards, SAMPLE).unwrap();
        let rulings = dir.path().join("rulings.json");
        std::fs::write(&rulings, r#"[{"oracle_id":"o1","source":"wotc","published_at":"2004-10-04","comment":"First."}]"#).unwrap();

        // Both card files given: no network at all (the index URL is never fetched).
        run_from(&pool, dir.path(), "http://127.0.0.1:9/unused", Some(cards.clone()), Some(cards.clone()), Some(rulings.clone()))
            .await
            .unwrap();
        assert!(cards.exists() && rulings.exists());
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rulings").fetch_one(&pool).await.unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn data_from_older_importers_counts_as_not_loaded() {
        let pool = crate::db::test_pool().await;
        // Runs made before migration 0008 have no importer version: they count as version 1.
        sqlx::query(
            "INSERT INTO import_runs (id, kind, source_updated_at, started_at, finished_at, rows) VALUES
             ('o', 'oracle_cards', '2026-10-17T09:01:55.818+00:00', '2026-10-17T20:08:18Z', '2026-10-17T20:08:30Z', 2),
             ('d', 'default_cards', '2026-10-17T09:06:08.225+00:00', '2026-10-17T20:08:31Z', '2026-10-17T20:09:10Z', 2)",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Nothing these importers added is loaded: printings' digital flags (default_cards
        // version 2), Game Changer flags (oracle_cards version 2) and rulings.
        assert_eq!(current_import_date(&pool, "default_cards").await.unwrap(), None);
        assert_eq!(current_import_date(&pool, "oracle_cards").await.unwrap(), None);
        assert_eq!(game_changers_date(&pool).await.unwrap(), None);
        assert_eq!(current_import_date(&pool, "rulings").await.unwrap(), None);

        // A failed import doesn't load anything.
        let dir = tempfile::tempdir().unwrap();
        let empty = dir.path().join("empty.json");
        std::fs::write(&empty, "[]").unwrap();
        assert!(import_oracle(&pool, &empty, None).await.is_err());
        assert_eq!(current_import_date(&pool, "oracle_cards").await.unwrap(), None);

        // An import by today's code does; a file given by hand is dated by when it was imported.
        let path = dir.path().join("bulk.json");
        std::fs::write(&path, SAMPLE).unwrap();
        import_oracle(&pool, &path, None).await.unwrap();
        assert_eq!(current_import_date(&pool, "oracle_cards").await.unwrap(), Some(now()[..10].to_string()));
        assert_eq!(game_changers_date(&pool).await.unwrap(), Some(now()[..10].to_string()));

        // A version-2 run (Game Changers, no produced_mana) still dates the Game Changer flags,
        // while the oracle data as a whole counts as behind, so the scheduler re-imports it.
        sqlx::query("DELETE FROM import_runs").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO import_runs (id, kind, source_updated_at, started_at, finished_at, rows, importer_version) VALUES
             ('o2', 'oracle_cards', '2026-10-18T09:01:55.818+00:00', '2026-10-18T20:08:18Z', '2026-10-18T20:08:30Z', 2, 2)",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert_eq!(current_import_date(&pool, "oracle_cards").await.unwrap(), None);
        assert_eq!(game_changers_date(&pool).await.unwrap().as_deref(), Some("2026-10-18"));
    }
}
