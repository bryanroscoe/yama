//! Scryfall bulk data import.
//!
//! - `oracle_cards`: one object per card (rules text, legality) → `cards`, `card_names`.
//! - `default_cards`: every printing in English, or its only language → `printings`, `price_snapshots`.
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

pub async fn run(pool: &SqlitePool, cfg: &Config, oracle: Option<PathBuf>, default: Option<PathBuf>) -> anyhow::Result<()> {
    let http = crate::routes::http_client();
    let index = if oracle.is_none() || default.is_none() { Some(bulk_index(&http).await?) } else { None };

    let (oracle_path, oracle_meta) = match oracle {
        Some(p) => (p, None),
        None => {
            let item = index.as_ref().unwrap().find("oracle_cards")?;
            (download(&http, item, &cfg.data_dir).await?, Some(item.clone()))
        }
    };
    let n = import_oracle(pool, &oracle_path, oracle_meta.as_ref()).await?;
    println!("oracle cards: {n}");

    let (default_path, default_meta) = match default {
        Some(p) => (p, None),
        None => {
            let item = index.as_ref().unwrap().find("default_cards")?;
            (download(&http, item, &cfg.data_dir).await?, Some(item.clone()))
        }
    };
    let n = import_default(pool, &default_path, default_meta.as_ref()).await?;
    println!("printings: {n}");

    // Downloaded files are only needed during import, and the disk is small.
    for (path, meta) in [(&oracle_path, &oracle_meta), (&default_path, &default_meta)] {
        if meta.is_some() {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// Download and import the latest file of one kind, unless we already have that exact file.
/// Returns whether anything was imported.
pub async fn refresh(pool: &SqlitePool, data_dir: &Path, kind: &str) -> anyhow::Result<bool> {
    let http = crate::routes::http_client();
    let index = bulk_index(&http).await?;
    let item = index.find(kind)?;
    let have: Option<String> = sqlx::query_scalar(
        "SELECT source_updated_at FROM import_runs WHERE kind = ? AND error IS NULL AND finished_at IS NOT NULL
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(kind)
    .fetch_optional(pool)
    .await?
    .flatten();
    if have.as_deref() == Some(item.updated_at.as_str()) {
        return Ok(false);
    }
    let path = download(&http, item, data_dir).await?;
    let result = match kind {
        "oracle_cards" => import_oracle(pool, &path, Some(item)).await,
        _ => import_default(pool, &path, Some(item)).await,
    };
    let _ = std::fs::remove_file(&path);
    result.map(|_| true)
}

/// Background refresh for a running server: prices daily, rules text weekly.
pub fn spawn_scheduler(pool: SqlitePool, data_dir: PathBuf) {
    tokio::spawn(async move {
        loop {
            for (kind, max_age_hours) in [("default_cards", 20), ("oracle_cards", 24 * 6)] {
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
                if age.is_none_or(|h| h >= max_age_hours) {
                    match refresh(&pool, &data_dir, kind).await {
                        Ok(true) => tracing::info!(kind, "imported fresh Scryfall data"),
                        Ok(false) => tracing::debug!(kind, "Scryfall data unchanged"),
                        Err(e) => tracing::warn!(kind, error = %format!("{e:#}"), "Scryfall import failed"),
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        }
    });
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

async fn bulk_index(http: &reqwest::Client) -> anyhow::Result<BulkIndex> {
    Ok(http
        .get(BULK_INDEX)
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

async fn download(http: &reqwest::Client, item: &BulkItem, dir: &Path) -> anyhow::Result<PathBuf> {
    let url = item.url()?;
    let path = dir.join(url.rsplit('/').next().unwrap_or("scryfall-bulk"));
    let mb = item.compressed_size.or(item.size).unwrap_or(0) / 1_000_000;
    println!("downloading {} ({mb} MB)…", item.kind);
    let resp = http.get(url).send().await?.error_for_status()?;
    let mut file = tokio::fs::File::create(&path).await?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        file.write_all(&chunk?).await?;
    }
    file.flush().await?;
    Ok(path)
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

#[derive(Deserialize, Default, Clone)]
struct ImageUris {
    small: Option<String>,
    normal: Option<String>,
    art_crop: Option<String>,
}

#[derive(Deserialize, Clone, serde::Serialize)]
struct Face {
    name: String,
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
    image_uris: Option<ImageUris>,
    card_faces: Option<Vec<Face>>,
    artist: Option<String>,
    // printing fields (default_cards)
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
    tix: Option<String>,
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
        self.card_faces.as_ref()?.get(1)?.image_uris.as_ref()?.normal.clone()
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

fn price(s: &Option<String>) -> Option<f64> {
    s.as_deref().and_then(|v| v.parse().ok())
}

async fn start_run(pool: &SqlitePool, kind: &str, meta: Option<&BulkItem>) -> anyhow::Result<String> {
    let id = new_id();
    sqlx::query("INSERT INTO import_runs (id, kind, source_url, source_updated_at, started_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(kind)
        .bind(meta.and_then(|m| m.url().ok().map(str::to_string)))
        .bind(meta.map(|m| m.updated_at.clone()))
        .bind(now())
        .execute(pool)
        .await?;
    Ok(id)
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
    let run = start_run(pool, "oracle_cards", meta).await?;
    let result = import_oracle_inner(pool, path).await;
    finish_run(pool, &run, &result).await?;
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
                    image_small, image_normal, image_art_crop, back_image_normal, artist, faces, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(oracle_id) DO UPDATE SET name=excluded.name, mana_cost=excluded.mana_cost,
                    cmc=excluded.cmc, type_line=excluded.type_line, oracle_text=excluded.oracle_text,
                    colors=excluded.colors, color_identity=excluded.color_identity, power=excluded.power,
                    toughness=excluded.toughness, loyalty=excluded.loyalty, keywords=excluded.keywords,
                    legalities=excluded.legalities, rarity=excluded.rarity, layout=excluded.layout,
                    edhrec_rank=excluded.edhrec_rank, default_printing=excluded.default_printing,
                    image_small=excluded.image_small, image_normal=excluded.image_normal,
                    image_art_crop=excluded.image_art_crop, back_image_normal=excluded.back_image_normal,
                    artist=excluded.artist, faces=excluded.faces, updated_at=excluded.updated_at",
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
            .bind(&images.small)
            .bind(&images.normal)
            .bind(&images.art_crop)
            .bind(c.back_image())
            .bind(&c.artist)
            .bind(faces)
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
    let run = start_run(pool, "default_cards", meta).await?;
    // Prices belong to the day Scryfall generated the file, not the day we imported it.
    let price_date = meta.map(|m| m.updated_at[..10].to_string()).unwrap_or_else(|| now()[..10].to_string());
    let result = import_default_inner(pool, path, &price_date).await;
    finish_run(pool, &run, &result).await?;
    result
}

async fn import_default_inner(pool: &SqlitePool, path: &Path, price_date: &str) -> anyhow::Result<usize> {
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
            sqlx::query(
                "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang,
                    rarity, finishes, released_at, image_normal, image_small, image_art_crop, back_image_normal,
                    artist, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(scryfall_id) DO UPDATE SET oracle_id=excluded.oracle_id, name=excluded.name,
                    set_code=excluded.set_code, set_name=excluded.set_name,
                    collector_number=excluded.collector_number, lang=excluded.lang, rarity=excluded.rarity,
                    finishes=excluded.finishes, released_at=excluded.released_at,
                    image_normal=excluded.image_normal, image_small=excluded.image_small,
                    image_art_crop=excluded.image_art_crop, back_image_normal=excluded.back_image_normal,
                    artist=excluded.artist, updated_at=excluded.updated_at",
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
            .bind(&images.normal)
            .bind(&images.small)
            .bind(&images.art_crop)
            .bind(c.back_image())
            .bind(&c.artist)
            .bind(&stamp)
            .execute(&mut *tx)
            .await?;

            let p = &c.prices;
            let values = [price(&p.usd), price(&p.usd_foil), price(&p.usd_etched), price(&p.eur), price(&p.eur_foil), price(&p.tix)];
            if values.iter().any(Option::is_some) {
                sqlx::query(
                    "INSERT OR REPLACE INTO price_snapshots (scryfall_id, date, usd, usd_foil, usd_etched, eur, eur_foil, tix)
                     VALUES (?,?,?,?,?,?,?,?)",
                )
                .bind(&c.id)
                .bind(price_date)
                .bind(values[0])
                .bind(values[1])
                .bind(values[2])
                .bind(values[3])
                .bind(values[4])
                .bind(values[5])
                .execute(&mut *tx)
                .await?;
            }
            count += 1;
        }
        tx.commit().await?;
    }
    if count == 0 {
        bail!("no printings found in {}", path.display());
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      {"id":"p1","oracle_id":"o1","name":"Sol Ring","layout":"normal","mana_cost":"{1}","cmc":1.0,
       "type_line":"Artifact","oracle_text":"{T}: Add {C}{C}.","colors":[],"color_identity":[],
       "keywords":[],"legalities":{"commander":"legal","vintage":"restricted"},"rarity":"uncommon",
       "image_uris":{"small":"s","normal":"n","art_crop":"a"},"set":"cmm","set_name":"Commander Masters",
       "collector_number":"410","lang":"en","finishes":["nonfoil","foil"],
       "prices":{"usd":"1.50","usd_foil":null,"eur":"1.20","tix":null}},
      {"id":"p2","oracle_id":"o2","name":"Fable of the Mirror-Breaker // Reflection of Kiki-Jiki",
       "layout":"transform","cmc":3.0,"type_line":"Enchantment — Saga // Enchantment Creature — Goblin Shaman",
       "colors":["R"],"color_identity":["R"],"legalities":{"commander":"legal"},
       "card_faces":[{"name":"Fable of the Mirror-Breaker","mana_cost":"{2}{R}","type_line":"Enchantment — Saga",
         "oracle_text":"(As this Saga enters...)","image_uris":{"normal":"front"}},
        {"name":"Reflection of Kiki-Jiki","mana_cost":"","type_line":"Enchantment Creature — Goblin Shaman",
         "oracle_text":"{1}, {T}: Create a token...","power":"2","toughness":"2","image_uris":{"normal":"back"}}],
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

        // Missing prices stay missing; a printing with no prices at all gets no row.
        let prices: Vec<(String, Option<f64>, Option<f64>)> =
            sqlx::query_as("SELECT scryfall_id, usd, usd_foil FROM price_snapshots").fetch_all(&pool).await.unwrap();
        assert_eq!(prices, vec![("p1".into(), Some(1.5), None)]);
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
}
