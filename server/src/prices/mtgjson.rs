//! Card Kingdom's retail and buylist prices and Mana Pool's lowest listings, from MTGJSON's daily
//! price file (2026-11-02; ARCHITECTURE.md, "Price history"; migration 0065).
//!
//! - One feed per provider (`mtgjson:cardkingdom`, `mtgjson:manapool`), one observation per feed
//!   per day. A provider missing from a day's file leaves that day a gap for it, not a NULL for
//!   every printing; a printing it no longer lists gets a NULL row (missing stays missing).
//! - Each value keeps its provider, kind (retail, buylist, lowest listing), finish and date
//!   (series 20 to 28). Providers are never merged into one number, and none is a store quote.
//! - MTGJSON keys prices by its own uuid; `cardIdentifiers.csv` maps those to Scryfall ids, and only
//!   printings Yama has are kept. A card's faces share a Scryfall id: their one value is used, and
//!   if they disagree that series has no price that day (counted in the log), never one of them.
//! - The first import replays MTGJSON's last 90 days (`AllPrices`) while the feeds have nothing
//!   observed, then each day's `AllPricesToday`, days in order, through the one price [`Writer`].

use super::{Writer, date_of, day_of};
use anyhow::Context;
use serde::Deserialize;
use serde::de::{DeserializeSeed, IgnoredAny, MapAccess, Visitor};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

pub const CARDKINGDOM: &str = "mtgjson:cardkingdom";
pub const MANAPOOL: &str = "mtgjson:manapool";
/// Each feed and its series ids (migration 0065).
pub const FEEDS: [(&str, i64, i64); 2] = [(CARDKINGDOM, 20, 25), (MANAPOOL, 26, 28)];
const BASE: &str = "https://mtgjson.com/api/v5/";
const IMPORT_KIND: &str = "mtgjson_prices";

/// The series of a provider's kind and finish in MTGJSON's terms; Mana Pool's "retail" is its
/// lowest listing. Anything else (MTGJSON's TCGplayer, Cardmarket and Cardhoarder copies, which
/// Scryfall already gives Yama) is none.
fn series_of(provider: &str, kind: &str, finish: usize) -> Option<i64> {
    let base = match (provider, kind) {
        ("cardkingdom", "retail") => 20,
        ("cardkingdom", "buylist") => 23,
        ("manapool", "retail") => 26,
        _ => return None,
    };
    Some(base + finish as i64)
}

fn feed_of(series: i64) -> Option<(&'static str, i64, i64)> {
    FEEDS.into_iter().find(|(_, lo, hi)| (*lo..=*hi).contains(&series))
}

// ── reading MTGJSON's files ────────────────────────────────────────────────────────────────

type Dated = BTreeMap<String, f64>;

#[derive(Deserialize, Default)]
struct Finishes {
    normal: Option<Dated>,
    foil: Option<Dated>,
    etched: Option<Dated>,
}

#[derive(Deserialize)]
struct Provider {
    #[serde(default)]
    retail: Option<Finishes>,
    #[serde(default)]
    buylist: Option<Finishes>,
    currency: Option<String>,
}

#[derive(Deserialize, Default)]
struct Paper {
    cardkingdom: Option<Provider>,
    manapool: Option<Provider>,
}

/// One card's prices, as much of them as Yama reads.
#[derive(Deserialize, Default)]
pub(crate) struct Entry {
    #[serde(default)]
    paper: Option<Paper>,
}

/// Whole cents from MTGJSON's dollars; anything else (negative, fractions of a cent) is no price.
fn cents(x: f64) -> Option<i64> {
    let c = (x * 100.0).round();
    ((x * 100.0 - c).abs() < 1e-6 && c >= 0.0).then_some(c as i64)
}

impl Entry {
    /// Every (series, date, cents) the entry has, in US dollars only.
    fn values(&self) -> Vec<(i64, &str, i64)> {
        let mut out = Vec::new();
        let Some(paper) = &self.paper else { return out };
        for (name, provider) in [("cardkingdom", &paper.cardkingdom), ("manapool", &paper.manapool)] {
            let Some(p) = provider else { continue };
            if p.currency.as_deref() != Some("USD") {
                continue;
            }
            for (kind, finishes) in [("retail", &p.retail), ("buylist", &p.buylist)] {
                let Some(f) = finishes else { continue };
                for (i, dated) in [&f.normal, &f.foil, &f.etched].into_iter().enumerate() {
                    let (Some(series), Some(dated)) = (series_of(name, kind, i), dated) else { continue };
                    out.extend(dated.iter().filter_map(|(date, x)| cents(*x).map(|c| (series, date.as_str(), c))));
                }
            }
        }
        out
    }
}

fn open(path: &Path) -> anyhow::Result<Box<dyn Read + Send>> {
    let mut file = BufReader::with_capacity(1 << 20, std::fs::File::open(path).with_context(|| format!("opening {}", path.display()))?);
    let gzipped = file.fill_buf()?.starts_with(&[0x1f, 0x8b]);
    Ok(if gzipped { Box::new(BufReader::with_capacity(1 << 20, flate2::read::MultiGzDecoder::new(file))) } else { Box::new(file) })
}

/// Read a MTGJSON prices file (gzipped or not) one card at a time, without loading it whole.
pub(crate) fn read_prices(path: &Path, mut each: impl FnMut(&str, Entry)) -> anyhow::Result<Option<String>> {
    let mut de = serde_json::Deserializer::from_reader(open(path)?);
    FileSeed(&mut each).deserialize(&mut de).with_context(|| format!("reading {}", path.display()))
}

struct FileSeed<'a, F>(&'a mut F);

impl<'de, F: FnMut(&str, Entry)> DeserializeSeed<'de> for FileSeed<'_, F> {
    type Value = Option<String>;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de, F: FnMut(&str, Entry)> Visitor<'de> for FileSeed<'_, F> {
    type Value = Option<String>;
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("a MTGJSON file")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut date = None;
        while let Some(key) = map.next_key::<String>()? {
            if key == "data" {
                map.next_value_seed(DataSeed(&mut *self.0))?;
            } else if key == "meta" {
                date = Some(map.next_value::<MetaData>()?.date);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(date)
    }
}

struct DataSeed<'a, F>(&'a mut F);

impl<'de, F: FnMut(&str, Entry)> DeserializeSeed<'de> for DataSeed<'_, F> {
    type Value = ();
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<(), D::Error> {
        d.deserialize_map(self)
    }
}

impl<'de, F: FnMut(&str, Entry)> Visitor<'de> for DataSeed<'_, F> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("MTGJSON's cards by uuid")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<(), A::Error> {
        while let Some(uuid) = map.next_key::<String>()? {
            let entry: Entry = map.next_value()?;
            (self.0)(&uuid, entry);
        }
        Ok(())
    }
}

/// MTGJSON uuid to Scryfall id, for printings Yama has (`known`), and how many uuids each of those
/// Scryfall ids has (a card's faces).
pub(crate) fn identifiers(path: &Path, known: &HashSet<String>) -> anyhow::Result<(HashMap<String, String>, HashMap<String, usize>)> {
    let mut csv = csv::Reader::from_reader(open(path)?);
    let headers = csv.headers()?.clone();
    let column = |name: &str| headers.iter().position(|h| h == name).with_context(|| format!("cardIdentifiers.csv has no {name} column"));
    let (uuid, scryfall) = (column("uuid")?, column("scryfallId")?);
    let (mut by_uuid, mut faces) = (HashMap::new(), HashMap::<String, usize>::new());
    for record in csv.records() {
        let record = record?;
        let (Some(u), Some(s)) = (record.get(uuid), record.get(scryfall)) else { continue };
        if !s.is_empty() && known.contains(s) {
            by_uuid.insert(u.to_string(), s.to_string());
            *faces.entry(s.to_string()).or_default() += 1;
        }
    }
    Ok((by_uuid, faces))
}

/// One printing's value for a series and day across its faces: the one value they give, or none
/// when they disagree.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Merged {
    Price(i64),
    Disagree,
}

fn merge(slot: &mut Option<Merged>, cents: i64) -> bool {
    match slot {
        None => {
            *slot = Some(Merged::Price(cents));
            false
        }
        Some(Merged::Price(c)) if *c == cents => false,
        Some(Merged::Price(_)) => {
            *slot = Some(Merged::Disagree);
            true
        }
        Some(Merged::Disagree) => false,
    }
}

// ── downloads ──────────────────────────────────────────────────────────────────────────────

/// A downloaded file, deleted when dropped (after its import, or when anything fails).
struct Download(PathBuf);

impl Drop for Download {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

async fn download(http: &reqwest::Client, name: &str, dir: &Path) -> anyhow::Result<Download> {
    use tokio::io::AsyncWriteExt;
    tokio::fs::create_dir_all(dir).await?;
    let file = Download(dir.join(format!("mtgjson-{}-{}", crate::util::new_id(), name.replace('/', "-"))));
    let resp = http.get(format!("{BASE}{name}")).timeout(crate::util::DOWNLOAD_TOTAL).send().await?.error_for_status()?;
    let mut out = tokio::fs::File::create(&file.0).await?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = crate::util::next_chunk(&mut stream).await? {
        out.write_all(&chunk).await?;
    }
    out.flush().await?;
    Ok(file)
}

#[derive(Deserialize)]
struct Meta {
    data: MetaData,
}

#[derive(Deserialize)]
struct MetaData {
    date: String,
}

// ── writing ────────────────────────────────────────────────────────────────────────────────

async fn known_printings(pool: &SqlitePool) -> anyhow::Result<HashSet<String>> {
    Ok(sqlx::query_scalar("SELECT scryfall_id FROM printings").fetch_all(pool).await?.into_iter().collect())
}

/// The newest day each MTGJSON feed was observed.
async fn newest_days(pool: &SqlitePool) -> anyhow::Result<HashMap<&'static str, i64>> {
    let mut out = HashMap::new();
    for (feed, ..) in FEEDS {
        if let Some(day) = super::newest_observation(pool, feed).await? {
            out.insert(feed, day);
        }
    }
    Ok(out)
}

/// Publish one feed's prices for a day newer than any it has, in one transaction: a row for each
/// value that changed, no price from the day for every printing it priced before and doesn't list
/// now, then the observation. `rows`: (Scryfall id, series, cents).
async fn publish_day(pool: &SqlitePool, writer: &Writer, feed: (&str, i64, i64), day: i64, rows: &[(String, i64, i64)], run: &str) -> anyhow::Result<()> {
    let (name, lo, hi) = feed;
    let mut tx = writer.begin(pool).await?;
    clear_unpublished(&mut tx, feed).await?;
    sqlx::query(
        "CREATE TEMP TABLE IF NOT EXISTS mtgjson_stage (scryfall_id TEXT NOT NULL, series INTEGER NOT NULL, cents INTEGER NOT NULL,
            PRIMARY KEY (scryfall_id, series)) WITHOUT ROWID",
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM temp.mtgjson_stage").execute(&mut *tx).await?;
    for chunk in rows.chunks(5000) {
        let json = serde_json::to_string(chunk)?;
        sqlx::query("INSERT INTO temp.mtgjson_stage SELECT j.value ->> 0, j.value ->> 1, j.value ->> 2 FROM json_each(?) j")
            .bind(json)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT OR IGNORE INTO price_printing (scryfall_id) SELECT DISTINCT scryfall_id FROM temp.mtgjson_stage").execute(&mut *tx).await?;
    // A row where the value isn't the one before the day.
    sqlx::query(
        "INSERT INTO price_point (printing, series, day, cents)
         SELECT k.id, st.series, ?1, st.cents FROM temp.mtgjson_stage st JOIN price_printing k ON k.scryfall_id = st.scryfall_id
          WHERE st.cents IS NOT (SELECT pp.cents FROM price_point pp WHERE pp.printing = k.id AND pp.series = st.series AND pp.day < ?1
                                 ORDER BY pp.day DESC LIMIT 1)
         ON CONFLICT (printing, series, day) DO UPDATE SET cents = excluded.cents",
    )
    .bind(day)
    .execute(&mut *tx)
    .await?;
    // A printing the feed priced before and doesn't list today has no price from today.
    sqlx::query(
        "INSERT INTO price_point (printing, series, day, cents)
         SELECT l.printing, l.series, ?1, NULL
           FROM (SELECT printing, series, MAX(day) AS day FROM price_point WHERE series BETWEEN ?2 AND ?3 AND day < ?1 GROUP BY printing, series) l
           JOIN price_point p ON p.printing = l.printing AND p.series = l.series AND p.day = l.day
          WHERE p.cents IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM price_printing k JOIN temp.mtgjson_stage st ON st.scryfall_id = k.scryfall_id AND st.series = l.series
                             WHERE k.id = l.printing)
         ON CONFLICT (printing, series, day) DO UPDATE SET cents = NULL",
    )
    .bind(day)
    .bind(lo)
    .bind(hi)
    .execute(&mut *tx)
    .await?;
    let printings: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT scryfall_id) FROM temp.mtgjson_stage").fetch_one(&mut *tx).await?;
    observe(&mut tx, name, day, run, printings).await?;
    sqlx::query("DELETE FROM temp.mtgjson_stage").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Abandoned backfill batches must never become visible when either a replay or a first daily
/// import publishes the feed. Called inside the fenced writer transaction, preserving any feed
/// that already has observed days.
async fn clear_unpublished(conn: &mut sqlx::SqliteConnection, feed: (&str, i64, i64)) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM price_point WHERE series BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM price_observation WHERE feed = ?)")
        .bind(feed.1)
        .bind(feed.2)
        .bind(feed.0)
        .execute(conn)
        .await?;
    Ok(())
}

async fn observe(conn: &mut sqlx::SqliteConnection, feed: &str, day: i64, run: &str, printings: i64) -> sqlx::Result<()> {
    sqlx::query(
        "INSERT INTO price_observation (feed, day, file_updated_at, observed_at, import_run, printings) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (feed, day) DO UPDATE SET observed_at = excluded.observed_at, import_run = excluded.import_run, printings = excluded.printings",
    )
    .bind(feed)
    .bind(day)
    .bind(date_of(day))
    .bind(crate::util::now())
    .bind(run)
    .bind(printings)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// What one file's reading found, for the log.
#[derive(Default, Debug, serde::Serialize, PartialEq)]
pub struct ReadStats {
    /// Cards in the file with a Scryfall id Yama has.
    pub mapped: usize,
    /// Cards Yama has no printing for.
    pub unmapped: usize,
    /// Series and days where a card's faces gave different prices, left without one.
    pub disagreements: usize,
}

/// One day's file (`AllPricesToday`): each provider it has, published as that day where the day is
/// newer than the feed's newest. Returns the rows staged and what was read.
pub(crate) async fn import_day(pool: &SqlitePool, writer: &Writer, prices: &Path, ids: &Path, date: &str, run: &str) -> anyhow::Result<(usize, ReadStats)> {
    let day = day_of(date).with_context(|| format!("MTGJSON's date {date:?} isn't one"))?;
    let newest = newest_days(pool).await?;
    let known = known_printings(pool).await?;
    let (prices, ids, date_owned) = (prices.to_path_buf(), ids.to_path_buf(), date.to_string());
    let (values, read) = tokio::task::spawn_blocking(move || -> anyhow::Result<_> {
        let (by_uuid, _) = identifiers(&ids, &known)?;
        let mut values: HashMap<(String, i64), Option<Merged>> = HashMap::new();
        let mut read = ReadStats::default();
        let source_date = read_prices(&prices, |uuid, entry| {
            let Some(scryfall) = by_uuid.get(uuid) else {
                read.unmapped += 1;
                return;
            };
            read.mapped += 1;
            for (series, d, c) in entry.values() {
                if d == date_owned && merge(values.entry((scryfall.clone(), series)).or_default(), c) {
                    read.disagreements += 1;
                }
            }
        })?;
        // Meta.json and the daily file can be cached/published at different times. A stale or
        // empty file must remain retryable, not mark a new source day successfully imported.
        anyhow::ensure!(source_date.as_deref().and_then(day_of) == Some(day), "MTGJSON daily file date {:?} does not match requested {date_owned}", source_date);
        anyhow::ensure!(!values.is_empty(), "MTGJSON daily file has no supported prices for {date_owned}");
        Ok((values, read))
    })
    .await??;
    let mut staged = 0;
    for feed in FEEDS {
        if newest.get(feed.0).is_some_and(|n| *n >= day) {
            continue;
        }
        let rows: Vec<(String, i64, i64)> = values
            .iter()
            .filter(|((_, s), _)| feed_of(*s).is_some_and(|f| f.0 == feed.0))
            .filter_map(|((id, s), v)| match v {
                Some(Merged::Price(c)) => Some((id.clone(), *s, *c)),
                _ => None,
            })
            .collect();
        // Not in today's file at all: a gap for this provider, not a missing price for every card.
        if rows.is_empty() {
            tracing::warn!(feed = feed.0, date, "MTGJSON's file has no prices from this provider today; the day stays a gap");
            continue;
        }
        staged += rows.len();
        publish_day(pool, writer, feed, day, &rows, run).await?;
    }
    Ok((staged, read))
}

/// The days of each feed in a file of many days (`AllPrices`), and its rows: the change points of
/// every printing's series over its feed's days, a NULL where a printing it priced isn't listed.
pub(crate) struct History {
    pub days: BTreeMap<&'static str, BTreeSet<i64>>,
    /// The Scryfall ids rows name, by their index (4.6 million rows for 90 days: an index each, not
    /// a copy of the id, keeps a replay well under 200 MB).
    pub ids: Vec<String>,
    /// (index into `ids`, series, day, cents)
    pub rows: Vec<(u32, u8, u32, Option<i32>)>,
    /// Printings priced per feed and day.
    pub counts: HashMap<(&'static str, i64), i64>,
    pub read: ReadStats,
}

/// Read `AllPrices` twice: the days each provider has, then each printing's changes over them.
/// Only cards whose Scryfall id has more than one uuid (faces) wait for their others.
pub(crate) fn read_history(prices: &Path, ids: &Path, known: &HashSet<String>) -> anyhow::Result<History> {
    let (by_uuid, faces) = identifiers(ids, known)?;
    let mut days: BTreeMap<&'static str, BTreeSet<i64>> = BTreeMap::new();
    read_prices(prices, |uuid, entry| {
        if !by_uuid.contains_key(uuid) {
            return;
        }
        for (series, d, _) in entry.values() {
            if let (Some(feed), Some(day)) = (feed_of(series), day_of(d)) {
                days.entry(feed.0).or_default().insert(day);
            }
        }
    })?;
    let mut out = History { days, ids: Vec::new(), rows: Vec::new(), counts: HashMap::new(), read: ReadStats::default() };
    let mut index: HashMap<String, u32> = HashMap::new();
    // A printing's values: series -> day -> merged value.
    type Values = BTreeMap<i64, BTreeMap<i64, Option<Merged>>>;
    let mut waiting: HashMap<String, (usize, Values)> = HashMap::new();
    let emit = |out: &mut History, index: &mut HashMap<String, u32>, scryfall: &str, values: Values| {
        let mut priced: HashSet<(&'static str, i64)> = HashSet::new();
        let id = *index.entry(scryfall.to_string()).or_insert_with(|| {
            out.ids.push(scryfall.to_string());
            (out.ids.len() - 1) as u32
        });
        for (series, by_day) in values {
            let Some(feed) = feed_of(series) else { continue };
            let Some(feed_days) = out.days.get(feed.0) else { continue };
            let mut last: Option<Option<i64>> = None;
            for day in feed_days.iter().copied() {
                let value = match by_day.get(&day) {
                    Some(Some(Merged::Price(c))) => Some(*c),
                    _ => None,
                };
                if value.is_some() {
                    priced.insert((feed.0, day));
                }
                // Change points only, from the first price on.
                if (last.is_none() && value.is_some()) || last.is_some_and(|l| l != value) {
                    out.rows.push((id, series as u8, day as u32, value.map(|c| c as i32)));
                    last = Some(value);
                }
            }
        }
        for key in priced {
            *out.counts.entry(key).or_default() += 1;
        }
    };
    read_prices(prices, |uuid, entry| {
        let Some(scryfall) = by_uuid.get(uuid) else {
            out.read.unmapped += 1;
            return;
        };
        out.read.mapped += 1;
        let face_count = faces.get(scryfall).copied().unwrap_or(1);
        let add = |values: &mut Values, read: &mut ReadStats| {
            for (series, d, c) in entry.values() {
                let Some(day) = day_of(d) else { continue };
                if merge(values.entry(series).or_default().entry(day).or_default(), c) {
                    read.disagreements += 1;
                }
            }
        };
        if face_count <= 1 {
            let mut values = Values::new();
            add(&mut values, &mut out.read);
            emit(&mut out, &mut index, scryfall, values);
            return;
        }
        let slot = waiting.entry(scryfall.clone()).or_insert_with(|| (face_count, Values::new()));
        add(&mut slot.1, &mut out.read);
        slot.0 -= 1;
        if slot.0 == 0 {
            let (_, values) = waiting.remove(scryfall).expect("waiting card");
            emit(&mut out, &mut index, scryfall, values);
        }
    })?;
    // Faces the file doesn't have: what the others gave.
    for (scryfall, (_, values)) in std::mem::take(&mut waiting) {
        emit(&mut out, &mut index, &scryfall, values);
    }
    Ok(out)
}

/// Replay a file of many days (`AllPrices`) into the feeds that have nothing observed yet: their
/// rows in batches, then every day observed in one transaction. An interrupted replay leaves no
/// day observed; a retry discards those unpublished rows before reading its new snapshot into
/// the feed, since the rolling source file may have changed. Returns the rows written.
pub(crate) async fn backfill(pool: &SqlitePool, writer: &Writer, prices: &Path, ids: &Path, run: &str) -> anyhow::Result<(usize, ReadStats)> {
    let newest = newest_days(pool).await?;
    let empty: Vec<&'static str> = FEEDS.iter().map(|f| f.0).filter(|f| !newest.contains_key(f)).collect();
    if empty.is_empty() {
        return Ok((0, ReadStats::default()));
    }
    let known = known_printings(pool).await?;
    let (prices, ids) = (prices.to_path_buf(), ids.to_path_buf());
    let history = tokio::task::spawn_blocking(move || read_history(&prices, &ids, &known)).await??;
    // A prior attempt may have committed some batches without publishing observations. Its
    // source can change before a retry (corrections, removed cards, or the rolling 90-day window),
    // so upserting the new change points alone would retain abandoned values. These feeds have
    // no observed days and are invisible to readers; preserve every already-published feed.
    let mut tx = writer.begin(pool).await?;
    for feed in FEEDS {
        if empty.contains(&feed.0) {
            clear_unpublished(&mut tx, feed).await?;
        }
    }
    tx.commit().await?;
    let rows: Vec<&(u32, u8, u32, Option<i32>)> =
        history.rows.iter().filter(|r| feed_of(i64::from(r.1)).is_some_and(|f| empty.contains(&f.0))).collect();
    for chunk in rows.chunks(10_000) {
        let mut tx = writer.begin(pool).await?;
        let named: Vec<(&str, u8, u32, Option<i32>)> = chunk.iter().map(|(i, s, d, c)| (history.ids[*i as usize].as_str(), *s, *d, *c)).collect();
        let json = serde_json::to_string(&named)?;
        sqlx::query("INSERT OR IGNORE INTO price_printing (scryfall_id) SELECT DISTINCT j.value ->> 0 FROM json_each(?) j")
            .bind(&json)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO price_point (printing, series, day, cents)
             SELECT k.id, j.value ->> 1, j.value ->> 2, j.value ->> 3 FROM json_each(?) j JOIN price_printing k ON k.scryfall_id = j.value ->> 0
             ON CONFLICT (printing, series, day) DO UPDATE SET cents = excluded.cents",
        )
        .bind(&json)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    let mut tx = writer.begin(pool).await?;
    for feed in &empty {
        for day in history.days.get(feed).into_iter().flatten() {
            observe(&mut tx, feed, *day, run, history.counts.get(&(*feed, *day)).copied().unwrap_or(0)).await?;
        }
    }
    tx.commit().await?;
    Ok((rows.len(), history.read))
}

// ── the daily import ───────────────────────────────────────────────────────────────────────

/// Whether this source day still needs reading, including retryable failed imports.
pub(crate) async fn needs_refresh(pool: &SqlitePool, date: &str) -> anyhow::Result<bool> {
    let day = day_of(date).with_context(|| format!("MTGJSON's date {date:?} isn't one"))?;
    let newest = newest_days(pool).await?;
    if FEEDS.iter().all(|f| newest.get(f.0).is_some_and(|n| *n >= day)) {
        return Ok(false);
    }
    // A provider absent from an otherwise successful file stays a gap. Re-reading that same
    // source day cannot fill it; do not download the daily file (or 90-day replay) every hour.
    let read: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM import_runs WHERE kind = ? AND source_updated_at = ? AND finished_at IS NOT NULL AND error IS NULL)")
        .bind(IMPORT_KIND)
        .bind(date)
        .fetch_one(pool)
        .await?;
    Ok(!read)
}

/// Import a new MTGJSON day, first replaying 90 days for feeds with no observations.
/// The small Meta.json check avoids downloading unchanged price files.
pub async fn refresh(pool: &SqlitePool, data_dir: &Path) -> anyhow::Result<bool> {
    let http = crate::routes::http_client();
    let meta: Meta = http.get(format!("{BASE}Meta.json")).timeout(std::time::Duration::from_secs(30)).send().await?.error_for_status()?.json().await?;
    if !needs_refresh(pool, &meta.data.date).await? {
        return Ok(false);
    }
    let writer = Writer::acquire(pool).await?;
    let result = refresh_writing(pool, data_dir, &http, &meta.data.date, &writer).await;
    writer.release().await;
    result
}

async fn refresh_writing(pool: &SqlitePool, data_dir: &Path, http: &reqwest::Client, date: &str, writer: &Writer) -> anyhow::Result<bool> {
    // Another process may have imported while this writer waited for its lease.
    if !needs_refresh(pool, date).await? {
        return Ok(false);
    }
    let job = crate::perf::Job::start("MTGJSON prices", std::time::Duration::from_secs(15 * 60));
    let run = start_run(pool, date).await?;
    let result = async {
        let ids = download(http, "csv/cardIdentifiers.csv.gz", data_dir).await?;
        let mut written = 0;
        if newest_days(pool).await?.len() < FEEDS.len() {
            let all = download(http, "AllPrices.json.gz", data_dir).await?;
            let (rows, read) = backfill(pool, writer, &all.0, &ids.0, &run).await?;
            tracing::info!(rows, ?read, "MTGJSON's 90 days of prices replayed");
            written += rows;
        }
        let today = download(http, "AllPricesToday.json.gz", data_dir).await?;
        let (rows, read) = import_day(pool, writer, &today.0, &ids.0, date, &run).await?;
        tracing::info!(rows, ?read, date, "MTGJSON prices read");
        Ok::<usize, anyhow::Error>(written + rows)
    }
    .await;
    finish_run(pool, &run, &result).await;
    job.finish(&result, date);
    result.map(|n| n > 0)
}

async fn start_run(pool: &SqlitePool, date: &str) -> anyhow::Result<String> {
    let id = crate::util::new_id();
    sqlx::query("INSERT INTO import_runs (id, kind, source_url, source_updated_at, started_at) VALUES (?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(IMPORT_KIND)
        .bind(format!("{BASE}AllPricesToday.json.gz"))
        .bind(date)
        .bind(crate::util::now())
        .execute(pool)
        .await?;
    Ok(id)
}

async fn finish_run(pool: &SqlitePool, run: &str, result: &anyhow::Result<usize>) {
    let (rows, error) = match result {
        Ok(n) => (Some(*n as i64), None),
        Err(e) => (None, Some(format!("{e:#}"))),
    };
    let done = sqlx::query("UPDATE import_runs SET finished_at = ?, rows = ?, error = ? WHERE id = ?")
        .bind(crate::util::now())
        .bind(rows)
        .bind(error)
        .bind(run)
        .execute(pool)
        .await;
    if let Err(e) = done {
        tracing::warn!(error = %e, "couldn't record the MTGJSON import's end");
    }
}

/// `yama-server prices import-mtgjson --prices FILE --ids FILE --date DATE`: one day's file already
/// downloaded, as the daily import reads it.
pub async fn import_day_cli(pool: &SqlitePool, prices: PathBuf, ids: PathBuf, date: &str) -> anyhow::Result<()> {
    let writer = Writer::acquire(pool).await?;
    let result = async {
        let run = start_run(pool, date).await?;
        let result = import_day(pool, &writer, &prices, &ids, date, &run).await.map(|(n, read)| {
            println!("{}", serde_json::json!({"rows": n, "read": read}));
            n
        });
        finish_run(pool, &run, &result).await;
        result.map(|_| ())
    }
    .await;
    writer.release().await;
    result
}

/// `yama-server prices backfill-mtgjson [--prices FILE] [--ids FILE]`: the 90-day replay by hand,
/// from files already downloaded or fetched now.
pub async fn backfill_cli(pool: &SqlitePool, data_dir: &Path, prices: Option<PathBuf>, ids: Option<PathBuf>) -> anyhow::Result<()> {
    let http = crate::routes::http_client();
    let writer = Writer::acquire(pool).await?;
    let result = async {
        let (_ids_dl, ids) = match ids {
            Some(p) => (None, p),
            None => {
                let d = download(&http, "csv/cardIdentifiers.csv.gz", data_dir).await?;
                let p = d.0.clone();
                (Some(d), p)
            }
        };
        let (_prices_dl, prices) = match prices {
            Some(p) => (None, p),
            None => {
                let d = download(&http, "AllPrices.json.gz", data_dir).await?;
                let p = d.0.clone();
                (Some(d), p)
            }
        };
        let run = start_run(pool, "backfill").await?;
        let result = backfill(pool, &writer, &prices, &ids, &run).await.map(|(n, read)| {
            println!("{}", serde_json::json!({"rows": n, "read": read}));
            n
        });
        finish_run(pool, &run, &result).await;
        result.map(|_| ())
    }
    .await;
    writer.release().await;
    result
}

#[cfg(test)]
pub(crate) fn series_for_test(provider: &str, kind: &str, finish: usize) -> Option<i64> {
    series_of(provider, kind, finish)
}
