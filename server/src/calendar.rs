//! Release calendar and precon watch.
//!
//! - **Upcoming sets** come from Scryfall's `/sets` (every set in one list): Yama keeps the ones
//!   releasing today or later, with each set's card count so far as a preview figure, plus every
//!   set someone watches and the sets under it. One request a day (Scryfall's API rules: name
//!   the app in the User-Agent, send Accept, 50-100 ms between requests; read 2026-10-19 at
//!   <https://scryfall.com/docs/api>).
//! - **Precon lists** come from MTGJSON (<https://mtgjson.com>): `DeckList.json` names every
//!   preconstructed deck it has a list for, by set code and release date. Yama reads it once a
//!   day (about 70 KB compressed) and keeps the Commander decks; a Collector's Edition is kept as
//!   a variant of its base deck, and a deck MTGJSON stops listing is removed. A deck's own file
//!   (about half a megabyte, full card data) is downloaded only when its set is watched, or when
//!   someone starts a deck from it, one file a second at most, and kept as a pasteable list.
//!
//! The refresh runs with the other Scryfall jobs when `YAMA_AUTO_IMPORT=1`, or once with
//! `yama-server import-calendar`. Runs are logged in `import_runs` like the card imports.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use anyhow::Context;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::Duration;

pub const SCRYFALL_SETS: &str = "https://api.scryfall.com/sets";
pub const MTGJSON_API: &str = "https://mtgjson.com/api/v5";

const SETS_KIND: &str = "scryfall_sets";
const DECKLIST_KIND: &str = "mtgjson_decklist";
/// MTGJSON's deck type for Commander precons (Collector's Editions included; Yama files each
/// one under its base deck).
const COMMANDER_DECK: &str = "Commander Deck";
/// How MTGJSON's file names mark a Collector's Edition: `TheFantasticFourCollectorSEdition_MSC`
/// beside `TheFantasticFour_MSC`. Its deck names say `Collector's Edition`.
const COLLECTOR_FILE: &str = "CollectorSEdition";
const COLLECTOR_NAME: &str = " Collector's Edition";

/// A refresh counts as current for this long. The job wakes hourly, so this means daily.
const FRESH_HOURS: i64 = 20;
/// After a failed refresh, the next try waits this long.
const RETRY_MINUTES: i64 = 55;
/// Scryfall asks for 50-100 ms between requests.
const SCRYFALL_GAP: Duration = Duration::from_millis(100);
/// Most pages of `/sets` to follow (it has been one page; this only stops a runaway loop).
const MAX_SET_PAGES: usize = 20;
/// Pause between two MTGJSON deck file downloads.
const MTGJSON_GAP: Duration = Duration::from_secs(1);
/// A watched set's lists are downloaded again after this long, in case Wizards corrects one…
const LIST_REFRESH_DAYS: i64 = 7;
/// …until this long after the deck's release (corrections land early). A list never downloaded
/// is still fetched once, whenever its set is watched.
const LIST_REFRESH_AFTER_RELEASE_DAYS: i64 = 28;
/// The daily job leaves a list whose download failed for this long before trying again…
const LIST_RETRY_HOURS: i64 = 1;
/// …and "Start a deck" waits this long after a failed download before asking MTGJSON again.
const LIST_RETRY_SECS: i64 = 60;
/// Most lists one pass of the job downloads.
const LIST_BATCH: i64 = 16;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Where the calendar's data comes from. Tests point these at a local server.
#[derive(Clone, Debug)]
pub struct Sources {
    pub sets_url: String,
    pub mtgjson: String,
}

impl Default for Sources {
    fn default() -> Self {
        Self { sets_url: SCRYFALL_SETS.into(), mtgjson: MTGJSON_API.into() }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/calendar", get(calendar))
        .route("/api/calendar/watch/{code}", put(watch).delete(unwatch))
        .route("/api/calendar/precons/{file_name}", get(precon))
}

// ── Scryfall sets ──────────────────────────────────────────────────────────

#[derive(Deserialize, Debug, Clone)]
pub struct ScryfallSet {
    pub code: String,
    pub name: String,
    pub set_type: String,
    pub released_at: Option<String>,
    #[serde(default)]
    pub card_count: i64,
    pub printed_size: Option<i64>,
    pub parent_set_code: Option<String>,
    #[serde(default)]
    pub digital: bool,
    pub scryfall_uri: Option<String>,
}

#[derive(Deserialize)]
struct SetPage {
    data: Vec<ScryfallSet>,
    #[serde(default)]
    has_more: bool,
    next_page: Option<String>,
}

async fn get_json<T: serde::de::DeserializeOwned>(http: &reqwest::Client, url: &str) -> anyhow::Result<T> {
    let resp = http
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("asking {url}"))?
        .error_for_status()?;
    resp.json().await.with_context(|| format!("reading {url}"))
}

async fn fetch_sets(http: &reqwest::Client, url: &str) -> anyhow::Result<Vec<ScryfallSet>> {
    let mut sets = Vec::new();
    let mut next = Some(url.to_string());
    for page in 0..MAX_SET_PAGES {
        let Some(url) = next.take() else { break };
        if page > 0 {
            tokio::time::sleep(SCRYFALL_GAP).await;
        }
        let p: SetPage = get_json(http, &url).await?;
        sets.extend(p.data);
        if p.has_more {
            next = p.next_page;
        }
    }
    Ok(sets)
}

/// Keep the sets that release on or after the day before `today` (so a set out today still
/// shows for someone a time zone behind the server), every watched set, and the sets under a
/// watched set. Drop the rest, except rows for watched sets Scryfall no longer lists.
pub async fn store_sets(pool: &SqlitePool, sets: &[ScryfallSet], today: NaiveDate) -> anyhow::Result<usize> {
    let watched: HashSet<String> = sqlx::query_scalar("SELECT DISTINCT set_code FROM calendar_watches").fetch_all(pool).await?.into_iter().collect();
    let cutoff = (today - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    let stamp = now();
    let mut kept = Vec::new();
    let mut tx = pool.begin().await?;
    for s in sets {
        let code = s.code.to_lowercase();
        let parent = s.parent_set_code.as_ref().map(|p| p.to_lowercase());
        let upcoming = s.released_at.as_deref().is_none_or(|d| d >= cutoff.as_str());
        if !(upcoming || watched.contains(&code) || parent.as_ref().is_some_and(|p| watched.contains(p))) {
            continue;
        }
        sqlx::query(
            "INSERT INTO calendar_sets (code, name, set_type, released_at, card_count, printed_size, parent_set_code, digital, scryfall_uri, checked_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(code) DO UPDATE SET name = excluded.name, set_type = excluded.set_type, released_at = excluded.released_at,
               card_count = excluded.card_count, printed_size = excluded.printed_size, parent_set_code = excluded.parent_set_code,
               digital = excluded.digital, scryfall_uri = excluded.scryfall_uri, checked_at = excluded.checked_at",
        )
        .bind(&code)
        .bind(&s.name)
        .bind(&s.set_type)
        .bind(&s.released_at)
        .bind(s.card_count)
        .bind(s.printed_size)
        .bind(&parent)
        .bind(s.digital)
        .bind(&s.scryfall_uri)
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
        kept.push(code);
    }
    sqlx::query(
        "DELETE FROM calendar_sets WHERE code NOT IN (SELECT value FROM json_each(?))
           AND code NOT IN (SELECT set_code FROM calendar_watches)",
    )
    .bind(serde_json::to_string(&kept)?)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(kept.len())
}

/// Read Scryfall's set list and store the upcoming and watched sets.
pub async fn refresh_sets(pool: &SqlitePool, http: &reqwest::Client, url: &str, today: NaiveDate) -> anyhow::Result<usize> {
    let run = start_run(pool, SETS_KIND, url).await?;
    let result = async { store_sets(pool, &fetch_sets(http, url).await?, today).await }.await;
    finish_run(pool, &run, &result, None).await?;
    result
}

// ── MTGJSON precon lists ───────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct Meta {
    date: Option<String>,
    version: Option<String>,
}

#[derive(Deserialize)]
struct DeckListFile {
    #[serde(default)]
    meta: Meta,
    data: Vec<DeckListEntry>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeckListEntry {
    pub code: String,
    pub file_name: String,
    pub name: String,
    pub release_date: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub source: Option<String>,
}

/// The base deck a Collector's Edition belongs to, from the same index: same set, and the same
/// file name or deck name without the Collector's Edition mark. `None` for a base deck, or a
/// Collector's Edition whose base MTGJSON doesn't list (it then stands as a deck of its own).
fn base_deck<'a>(e: &DeckListEntry, decks: &[&'a DeckListEntry]) -> Option<&'a DeckListEntry> {
    let by_file = e.file_name.contains(COLLECTOR_FILE).then(|| e.file_name.replacen(COLLECTOR_FILE, "", 1));
    let by_name = e.name.replace('\u{2019}', "'").contains(COLLECTOR_NAME).then(|| e.name.replace('\u{2019}', "'").replacen(COLLECTOR_NAME, "", 1));
    if by_file.is_none() && by_name.is_none() {
        return None;
    }
    decks.iter().copied().find(|b| {
        b.file_name != e.file_name
            && b.code.eq_ignore_ascii_case(&e.code)
            && (by_file.as_deref() == Some(b.file_name.as_str()) || by_name.as_deref() == Some(b.name.as_str()))
    })
}

/// Store the Commander decks from MTGJSON's list. A deck seen before keeps its first-seen time
/// and any list already downloaded; a Collector's Edition is filed under its base deck; a deck
/// the list no longer names (renamed or withdrawn) is removed. An index with no Commander decks
/// at all is refused rather than taken as "every deck withdrawn". Returns the decks stored,
/// Collector's Editions included.
async fn store_decklist(pool: &SqlitePool, entries: &[DeckListEntry]) -> anyhow::Result<usize> {
    let decks: Vec<&DeckListEntry> = entries.iter().filter(|e| e.kind == COMMANDER_DECK).collect();
    if decks.is_empty() {
        anyhow::bail!("MTGJSON's deck index lists no Commander decks; keeping the ones Yama has");
    }
    let stamp = now();
    let mut tx = pool.begin().await?;
    for e in &decks {
        sqlx::query(
            "INSERT INTO calendar_precons (file_name, set_code, name, variant_of, release_date, source_url, first_seen_at) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(file_name) DO UPDATE SET set_code = excluded.set_code, name = excluded.name, variant_of = excluded.variant_of,
               release_date = excluded.release_date, source_url = excluded.source_url",
        )
        .bind(&e.file_name)
        .bind(e.code.to_lowercase())
        .bind(&e.name)
        .bind(base_deck(e, &decks).map(|b| &b.file_name))
        .bind(&e.release_date)
        .bind(e.source.as_deref().filter(|s| s.starts_with("http")))
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
    }
    let listed: Vec<&str> = decks.iter().map(|e| e.file_name.as_str()).collect();
    sqlx::query("DELETE FROM calendar_precons WHERE file_name NOT IN (SELECT value FROM json_each(?))")
        .bind(serde_json::to_string(&listed)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(decks.len())
}

/// Read MTGJSON's deck index and store its Commander decks.
pub async fn refresh_decklist(pool: &SqlitePool, http: &reqwest::Client, base: &str) -> anyhow::Result<usize> {
    let url = format!("{}/DeckList.json", base.trim_end_matches('/'));
    let run = start_run(pool, DECKLIST_KIND, &url).await?;
    let mut source_date = None;
    let result = async {
        let file: DeckListFile = get_json(http, &url).await?;
        source_date = file.meta.date.clone();
        store_decklist(pool, &file.data).await
    }
    .await;
    finish_run(pool, &run, &result, source_date.as_deref()).await?;
    result
}

#[derive(Deserialize)]
struct DeckFile {
    #[serde(default)]
    meta: Meta,
    data: DeckData,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeckData {
    #[serde(default)]
    pub commander: Vec<DeckCardRef>,
    #[serde(default)]
    pub main_board: Vec<DeckCardRef>,
    #[serde(default)]
    pub side_board: Vec<DeckCardRef>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeckCardRef {
    pub name: String,
    /// The face this entry is, for cards with more than one ("Gisela, the Broken Blade").
    pub face_name: Option<String>,
    /// MTGJSON's layout: normal, transform, meld, reversible_card, ...
    pub layout: Option<String>,
    #[serde(default = "one")]
    pub count: i64,
    pub set_code: Option<String>,
    pub number: Option<String>,
}

fn one() -> i64 {
    1
}

impl DeckCardRef {
    /// The card's name as Scryfall (and so Yama's card data) has it. MTGJSON names every
    /// multi-face card "Front // Back". That is Scryfall's name too for split, adventure and
    /// double-faced cards, but not for a meld card (each half is its own card: "Gisela, the
    /// Broken Blade // Brisela, Voice of Nightmares" is Gisela) or a reversible card (the same
    /// card on both sides: "Sol Ring // Sol Ring" is Sol Ring). Checked against all 198 Commander
    /// decks in MTGJSON 5.3.0+20261018: these two layouts were the only names Yama didn't know.
    pub fn card_name(&self) -> &str {
        let single_card = matches!(self.layout.as_deref(), Some("meld" | "reversible_card"));
        if single_card && let Some(face) = self.face_name.as_deref().filter(|f| !f.trim().is_empty()) {
            return face;
        }
        // The same name twice is one card whatever the layout says.
        match self.name.split_once(" // ") {
            Some((front, back)) if front == back => front,
            _ => &self.name,
        }
    }
}

/// The deck as a list Yama's deck import reads (`decks::parse_list`): Commander, Deck and, if
/// the precon has one, Sideboard sections, one `1 Name (SET) 123` line per printing. Tokens,
/// planes and schemes aren't part of the 100.
pub fn stock_list(deck: &DeckData) -> String {
    fn lines(out: &mut String, heading: &str, cards: &[DeckCardRef]) {
        if cards.is_empty() {
            return;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(heading);
        out.push('\n');
        for c in cards {
            out.push_str(&format!("{} {}", c.count, c.card_name()));
            if let (Some(set), Some(number)) = (&c.set_code, &c.number) {
                out.push_str(&format!(" ({set}) {number}"));
            }
            out.push('\n');
        }
    }
    let mut out = String::new();
    lines(&mut out, "Commander", &deck.commander);
    lines(&mut out, "Deck", &deck.main_board);
    lines(&mut out, "Sideboard", &deck.side_board);
    out
}

fn deck_url(base: &str, file_name: &str) -> anyhow::Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(base)?;
    url.path_segments_mut()
        .map_err(|_| anyhow::anyhow!("MTGJSON base URL can't take a path: {base}"))?
        .pop_if_empty()
        .push("decks")
        .push(&format!("{file_name}.json"));
    Ok(url)
}

/// Download one precon's list from MTGJSON and keep it. A failure is recorded on the row (and
/// returned) so the next try can wait.
pub async fn fetch_list(pool: &SqlitePool, http: &reqwest::Client, base: &str, file_name: &str) -> anyhow::Result<()> {
    let tried = now();
    let result = async {
        let url = deck_url(base, file_name)?;
        let file: DeckFile = get_json(http, url.as_str()).await?;
        if file.data.commander.is_empty() && file.data.main_board.is_empty() {
            anyhow::bail!("MTGJSON's file for {file_name} has no cards");
        }
        Ok(file)
    }
    .await;
    match result {
        Ok(file) => {
            let commanders: Vec<&str> = file.data.commander.iter().map(DeckCardRef::card_name).collect();
            let cards: i64 = file.data.commander.iter().chain(&file.data.main_board).map(|c| c.count).sum();
            sqlx::query(
                "UPDATE calendar_precons SET commanders = ?, list_text = ?, list_cards = ?, list_fetched_at = ?,
                   list_source_version = ?, list_error = NULL, list_tried_at = ? WHERE file_name = ?",
            )
            .bind(serde_json::to_string(&commanders)?)
            .bind(stock_list(&file.data))
            .bind(cards)
            .bind(now())
            .bind(&file.meta.version)
            .bind(&tried)
            .bind(file_name)
            .execute(pool)
            .await?;
            Ok(())
        }
        Err(e) => {
            sqlx::query("UPDATE calendar_precons SET list_error = ?, list_tried_at = ? WHERE file_name = ?")
                .bind(format!("{e:#}"))
                .bind(&tried)
                .bind(file_name)
                .execute(pool)
                .await?;
            Err(e)
        }
    }
}

/// Download the lists of watched sets' precons that Yama doesn't have yet, or got more than
/// [`LIST_REFRESH_DAYS`] ago while the deck is still within [`LIST_REFRESH_AFTER_RELEASE_DAYS`]
/// of its release. A Collector's Edition is left to "Start a deck" (same deck, other printings);
/// once someone has started one it's refreshed like the rest. Returns how many downloads
/// succeeded.
pub async fn fetch_watched_lists(pool: &SqlitePool, http: &reqwest::Client, base: &str) -> anyhow::Result<usize> {
    let stale = stamp_ago(chrono::Duration::days(LIST_REFRESH_DAYS));
    let retry = stamp_ago(chrono::Duration::hours(LIST_RETRY_HOURS));
    let released_since = (Utc::now() - chrono::Duration::days(LIST_REFRESH_AFTER_RELEASE_DAYS)).format("%Y-%m-%d").to_string();
    let due: Vec<String> = sqlx::query_scalar(
        "SELECT file_name FROM calendar_precons
         WHERE (set_code IN (SELECT set_code FROM calendar_watches)
             OR set_code IN (SELECT code FROM calendar_sets WHERE parent_set_code IN (SELECT set_code FROM calendar_watches)))
           AND (variant_of IS NULL OR list_fetched_at IS NOT NULL)
           AND (list_fetched_at IS NULL
                OR (list_fetched_at < ? AND (release_date IS NULL OR release_date >= ?)))
           AND (list_tried_at IS NULL OR list_tried_at < ?)
         ORDER BY list_fetched_at IS NOT NULL, release_date DESC, file_name LIMIT ?",
    )
    .bind(&stale)
    .bind(&released_since)
    .bind(&retry)
    .bind(LIST_BATCH)
    .fetch_all(pool)
    .await?;
    let mut ok = 0;
    for (i, file_name) in due.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(MTGJSON_GAP).await;
        }
        match fetch_list(pool, http, base, file_name).await {
            Ok(()) => ok += 1,
            Err(e) => tracing::warn!(file_name, error = %format!("{e:#}"), "MTGJSON precon list download failed"),
        }
    }
    Ok(ok)
}

// ── schedule ───────────────────────────────────────────────────────────────

fn stamp_ago(d: chrono::Duration) -> String {
    (Utc::now() - d).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn parse_time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
}

/// Whether a daily refresh should run: nothing good within [`FRESH_HOURS`], and no try (good or
/// failed) within [`RETRY_MINUTES`].
pub fn is_due(last_ok: Option<DateTime<Utc>>, last_try: Option<DateTime<Utc>>, at: DateTime<Utc>) -> bool {
    if last_ok.is_some_and(|t| at - t < chrono::Duration::hours(FRESH_HOURS)) {
        return false;
    }
    last_try.is_none_or(|t| at - t >= chrono::Duration::minutes(RETRY_MINUTES))
}

async fn due(pool: &SqlitePool, kind: &str) -> sqlx::Result<bool> {
    let (last_ok, last_try): (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT MAX(CASE WHEN error IS NULL AND finished_at IS NOT NULL THEN finished_at END), MAX(started_at)
         FROM import_runs WHERE kind = ?",
    )
    .bind(kind)
    .fetch_one(pool)
    .await?;
    Ok(is_due(last_ok.as_deref().and_then(parse_time), last_try.as_deref().and_then(parse_time), Utc::now()))
}

/// One pass: refresh what's due, then download watched sets' new lists.
pub async fn run_due(pool: &SqlitePool, http: &reqwest::Client, src: &Sources) -> anyhow::Result<()> {
    if due(pool, SETS_KIND).await? {
        match refresh_sets(pool, http, &src.sets_url, Utc::now().date_naive()).await {
            Ok(n) => tracing::info!(sets = n, "release calendar refreshed from Scryfall"),
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "release calendar refresh failed"),
        }
    }
    if due(pool, DECKLIST_KIND).await? {
        match refresh_decklist(pool, http, &src.mtgjson).await {
            Ok(n) => tracing::info!(decks = n, "Commander precon index refreshed from MTGJSON"),
            Err(e) => tracing::warn!(error = %format!("{e:#}"), "MTGJSON precon index refresh failed"),
        }
    }
    let n = fetch_watched_lists(pool, http, &src.mtgjson).await?;
    if n > 0 {
        tracing::info!(lists = n, "downloaded watched precon lists from MTGJSON");
    }
    Ok(())
}

/// Background refresh for a running server (with `YAMA_AUTO_IMPORT=1`): wakes hourly, does
/// each daily refresh once it's due.
pub fn spawn_scheduler(pool: SqlitePool, http: reqwest::Client) {
    tokio::spawn(async move {
        let src = Sources::default();
        loop {
            if let Err(e) = run_due(&pool, &http, &src).await {
                tracing::warn!(error = %format!("{e:#}"), "release calendar pass failed");
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });
}

/// `yama-server import-calendar`: every refresh once, now.
pub async fn run_once(pool: &SqlitePool) -> anyhow::Result<()> {
    let http = crate::routes::http_client();
    let src = Sources::default();
    let sets = refresh_sets(pool, &http, &src.sets_url, Utc::now().date_naive()).await?;
    println!("upcoming and watched sets: {sets}");
    let decks = refresh_decklist(pool, &http, &src.mtgjson).await?;
    println!("Commander precons MTGJSON has lists for: {decks}");
    let lists = fetch_watched_lists(pool, &http, &src.mtgjson).await?;
    println!("watched precon lists downloaded: {lists}");
    Ok(())
}

async fn start_run(pool: &SqlitePool, kind: &str, url: &str) -> sqlx::Result<String> {
    let id = new_id();
    sqlx::query("INSERT INTO import_runs (id, kind, source_url, started_at) VALUES (?, ?, ?, ?)")
        .bind(&id)
        .bind(kind)
        .bind(url)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(id)
}

async fn finish_run(pool: &SqlitePool, id: &str, result: &anyhow::Result<usize>, source_date: Option<&str>) -> sqlx::Result<()> {
    let (rows, error) = match result {
        Ok(n) => (Some(*n as i64), None),
        Err(e) => (None, Some(format!("{e:#}"))),
    };
    sqlx::query("UPDATE import_runs SET finished_at = ?, rows = ?, error = ?, source_updated_at = ? WHERE id = ?")
        .bind(now())
        .bind(rows)
        .bind(error)
        .bind(source_date)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ── API ────────────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow, Debug)]
pub struct SetView {
    pub code: String,
    pub name: String,
    pub set_type: String,
    pub released_at: Option<String>,
    pub card_count: i64,
    pub printed_size: Option<i64>,
    pub parent_set_code: Option<String>,
    pub digital: bool,
    pub scryfall_uri: Option<String>,
    pub checked_at: String,
    #[sqlx(skip)]
    pub parent_name: Option<String>,
    /// This person watches the set itself.
    #[sqlx(skip)]
    pub watched: bool,
    /// This person watches the set it sits under (so its precons count as watched too).
    #[sqlx(skip)]
    pub parent_watched: bool,
    /// Commander precons MTGJSON has lists for, in this set or a set under it.
    #[sqlx(skip)]
    pub precons: Vec<PreconSummary>,
}

#[derive(Serialize, Debug, Clone)]
pub struct PreconSummary {
    pub file_name: String,
    pub set_code: String,
    pub name: String,
    pub release_date: Option<String>,
    pub source_url: Option<String>,
    pub first_seen_at: String,
    /// `None` until the list is downloaded.
    pub commanders: Option<Vec<String>>,
    pub list_cards: Option<i64>,
    /// Other editions of this deck MTGJSON lists separately (its Collector's Edition).
    pub variants: Vec<PreconVariant>,
}

/// A Collector's Edition: the base deck in other printings, with a list of its own.
#[derive(Serialize, Debug, Clone)]
pub struct PreconVariant {
    pub file_name: String,
    pub name: String,
}

#[derive(sqlx::FromRow, Clone)]
struct PreconRow {
    file_name: String,
    set_code: String,
    name: String,
    variant_of: Option<String>,
    release_date: Option<String>,
    source_url: Option<String>,
    first_seen_at: String,
    commanders: Option<String>,
    list_cards: Option<i64>,
}

impl PreconRow {
    fn summary(self, variants: Vec<PreconVariant>) -> PreconSummary {
        PreconSummary {
            commanders: self.commanders.as_deref().and_then(|c| serde_json::from_str(c).ok()),
            file_name: self.file_name,
            set_code: self.set_code,
            name: self.name,
            release_date: self.release_date,
            source_url: self.source_url,
            first_seen_at: self.first_seen_at,
            list_cards: self.list_cards,
            variants,
        }
    }
}

#[derive(Serialize, Debug)]
pub struct RunState {
    /// The last good refresh, RFC 3339.
    pub checked_at: Option<String>,
    /// The source's own date for that data, when it gives one (MTGJSON's build date).
    pub source_date: Option<String>,
    /// Why the latest try failed, when it's newer than the last good one.
    pub error: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct CalendarView {
    pub today: String,
    pub sets: RunState,
    pub precons: RunState,
    /// Whether this server refreshes by itself (`YAMA_AUTO_IMPORT=1`).
    pub auto_refresh: bool,
    pub upcoming: Vec<SetView>,
}

async fn run_state(pool: &SqlitePool, kind: &str) -> sqlx::Result<RunState> {
    let ok: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT finished_at, source_updated_at FROM import_runs WHERE kind = ? AND error IS NULL AND finished_at IS NOT NULL
         ORDER BY finished_at DESC LIMIT 1",
    )
    .bind(kind)
    .fetch_optional(pool)
    .await?;
    let failed: Option<(String, String)> = sqlx::query_as(
        "SELECT started_at, error FROM import_runs WHERE kind = ? AND error IS NOT NULL ORDER BY started_at DESC LIMIT 1",
    )
    .bind(kind)
    .fetch_optional(pool)
    .await?;
    let checked_at = ok.as_ref().map(|o| o.0.clone());
    let error = failed.filter(|(at, _)| checked_at.as_ref().is_none_or(|c| at > c)).map(|(_, e)| e);
    Ok(RunState { checked_at, source_date: ok.and_then(|o| o.1), error })
}

/// The calendar as `user` sees it on `today` (their local date): sets releasing that day or
/// later, plus the sets they watch (and the sets under them) whatever the date.
pub async fn view(pool: &SqlitePool, user: &str, today: NaiveDate, auto_refresh: bool) -> AppResult<CalendarView> {
    let today_s = today.format("%Y-%m-%d").to_string();
    let mine: HashSet<String> =
        sqlx::query_scalar("SELECT set_code FROM calendar_watches WHERE user_id = ?").bind(user).fetch_all(pool).await?.into_iter().collect();
    let mut sets: Vec<SetView> = sqlx::query_as(
        "SELECT code, name, set_type, released_at, card_count, printed_size, parent_set_code, digital, scryfall_uri, checked_at
         FROM calendar_sets s
         WHERE released_at IS NULL OR released_at >= ?
            OR code IN (SELECT set_code FROM calendar_watches WHERE user_id = ?)
            OR parent_set_code IN (SELECT set_code FROM calendar_watches WHERE user_id = ?)
         ORDER BY released_at IS NULL, released_at, COALESCE(parent_set_code, code), parent_set_code IS NOT NULL, name",
    )
    .bind(&today_s)
    .bind(user)
    .bind(user)
    .fetch_all(pool)
    .await?;

    // Names and children of every known set, for parents' names and precons in sets below.
    let all: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT code, name, parent_set_code FROM calendar_sets").fetch_all(pool).await?;
    let names: HashMap<&str, &str> = all.iter().map(|(c, n, _)| (c.as_str(), n.as_str())).collect();
    let mut wanted: BTreeSet<String> = BTreeSet::new();
    for s in &sets {
        wanted.insert(s.code.clone());
        for (child, _, parent) in &all {
            if parent.as_deref() == Some(s.code.as_str()) {
                wanted.insert(child.clone());
            }
        }
    }
    let precons: Vec<PreconRow> = sqlx::query_as(
        "SELECT file_name, set_code, name, variant_of, release_date, source_url, first_seen_at, commanders, list_cards
         FROM calendar_precons WHERE set_code IN (SELECT value FROM json_each(?)) ORDER BY name",
    )
    .bind(serde_json::to_string(&wanted).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    // A Collector's Edition goes under its base deck (same set), so lists count decks, not files.
    let bases: HashSet<String> = precons.iter().filter(|p| p.variant_of.is_none()).map(|p| p.file_name.clone()).collect();
    let mut variants: HashMap<String, Vec<PreconVariant>> = HashMap::new();
    for p in &precons {
        if let Some(base) = p.variant_of.as_ref().filter(|b| bases.contains(*b)) {
            variants.entry(base.clone()).or_default().push(PreconVariant { file_name: p.file_name.clone(), name: p.name.clone() });
        }
    }
    let mut by_set: HashMap<String, Vec<PreconSummary>> = HashMap::new();
    for p in precons {
        if p.variant_of.as_ref().is_some_and(|b| bases.contains(b)) {
            continue;
        }
        let v = variants.remove(&p.file_name).unwrap_or_default();
        by_set.entry(p.set_code.clone()).or_default().push(p.summary(v));
    }
    for s in &mut sets {
        s.parent_name = s.parent_set_code.as_deref().and_then(|p| names.get(p)).map(|n| n.to_string());
        s.watched = mine.contains(&s.code);
        s.parent_watched = s.parent_set_code.as_ref().is_some_and(|p| mine.contains(p));
        let mut codes = vec![s.code.as_str()];
        codes.extend(all.iter().filter(|(_, _, p)| p.as_deref() == Some(s.code.as_str())).map(|(c, _, _)| c.as_str()));
        // A Commander set's decks show on its own row and on the main set's.
        s.precons = codes.into_iter().flat_map(|c| by_set.get(c)).flatten().cloned().collect();
    }
    Ok(CalendarView {
        today: today_s,
        sets: run_state(pool, SETS_KIND).await?,
        precons: run_state(pool, DECKLIST_KIND).await?,
        auto_refresh,
        upcoming: sets,
    })
}

#[derive(Deserialize)]
struct CalendarQuery {
    /// The reader's local date (YYYY-MM-DD); the server's UTC date if absent.
    today: Option<String>,
}

fn parse_day(s: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| AppError::bad("today must be a date like 2026-10-19"))
}

/// The reader's date, held to within a day of the server's UTC date (every time zone's local
/// date is). Without the limit an old date would show past sets the calendar only keeps because
/// someone else watches them.
pub fn reader_today(asked: Option<NaiveDate>, utc: NaiveDate) -> NaiveDate {
    let day = chrono::Duration::days(1);
    asked.map_or(utc, |d| d.clamp(utc - day, utc + day))
}

async fn calendar(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(q): Query<CalendarQuery>) -> AppResult<Json<CalendarView>> {
    let asked = q.today.as_deref().map(parse_day).transpose()?;
    let today = reader_today(asked, Utc::now().date_naive());
    Ok(Json(view(&st.pool, &user.id, today, st.cfg.auto_import).await?))
}

fn set_code(code: &str) -> AppResult<String> {
    let code = code.trim().to_lowercase();
    if code.is_empty() || code.len() > 10 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::bad("not a set code"));
    }
    Ok(code)
}

/// Watch a set. Doing it twice is the same as once. Only sets the calendar shows this person
/// can be watched: ones releasing from the day before `today` (the server's UTC date) on, or a
/// set they already watch, directly or through the set above. A past set kept only for someone
/// else's watch answers like an unknown one, so nobody learns what others watch.
pub async fn add_watch(pool: &SqlitePool, user: &str, code: &str, today: NaiveDate) -> AppResult<()> {
    let code = set_code(code)?;
    let set: Option<(Option<String>, Option<String>)> =
        sqlx::query_as("SELECT released_at, parent_set_code FROM calendar_sets WHERE code = ?").bind(&code).fetch_optional(pool).await?;
    let Some((released, parent)) = set else {
        return Err(AppError::NotFound("set"));
    };
    let cutoff = (today - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    if released.is_some_and(|d| d < cutoff) {
        let follows: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM calendar_watches WHERE user_id = ? AND set_code IN (?, ?))")
            .bind(user)
            .bind(&code)
            .bind(parent.as_deref().unwrap_or(""))
            .fetch_one(pool)
            .await?;
        if !follows {
            return Err(AppError::NotFound("set"));
        }
    }
    sqlx::query("INSERT INTO calendar_watches (user_id, set_code, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(user)
        .bind(&code)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(())
}

async fn watch(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(code): Path<String>) -> AppResult<StatusCode> {
    add_watch(&st.pool, &user.id, &code, Utc::now().date_naive()).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn unwatch(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(code): Path<String>) -> AppResult<StatusCode> {
    sqlx::query("DELETE FROM calendar_watches WHERE user_id = ? AND set_code = ?")
        .bind(&user.id)
        .bind(set_code(&code)?)
        .execute(&st.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize, Debug)]
pub struct PreconList {
    pub file_name: String,
    pub name: String,
    pub set_code: String,
    pub release_date: Option<String>,
    pub source_url: Option<String>,
    pub commanders: Vec<String>,
    /// The stock list, ready to paste into a new deck.
    pub text: String,
    pub cards: Option<i64>,
    pub fetched_at: String,
    /// Card names in the list that Yama's card data doesn't match: brand-new cards (they arrive
    /// with the weekly card import) or a name MTGJSON writes differently. A deck made now would
    /// leave them out.
    pub unknown: Vec<String>,
}

#[derive(sqlx::FromRow)]
struct ListRow {
    name: String,
    set_code: String,
    release_date: Option<String>,
    source_url: Option<String>,
    commanders: Option<String>,
    list_text: Option<String>,
    list_cards: Option<i64>,
    list_fetched_at: Option<String>,
    list_error: Option<String>,
    list_tried_at: Option<String>,
}

async fn list_row(pool: &SqlitePool, file_name: &str) -> AppResult<ListRow> {
    sqlx::query_as(
        "SELECT name, set_code, release_date, source_url, commanders, list_text, list_cards, list_fetched_at, list_error, list_tried_at
         FROM calendar_precons WHERE file_name = ?",
    )
    .bind(file_name)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound("precon"))
}

/// One precon's stock list, downloading it from MTGJSON first if Yama doesn't have it. Only
/// decks from MTGJSON's own index can be asked for, and a failed download isn't repeated within
/// [`LIST_RETRY_SECS`].
pub async fn precon_list(pool: &SqlitePool, http: &reqwest::Client, base: &str, file_name: &str) -> AppResult<PreconList> {
    let mut row = list_row(pool, file_name).await?;
    if row.list_text.is_none() {
        let recent_failure = row.list_error.is_some()
            && row.list_tried_at.as_deref().and_then(parse_time).is_some_and(|t| Utc::now() - t < chrono::Duration::seconds(LIST_RETRY_SECS));
        if recent_failure {
            return Err(AppError::Unavailable(format!(
                "MTGJSON didn't send this list a moment ago ({}). Try again in a minute.",
                row.list_error.unwrap_or_default()
            )));
        }
        if let Err(e) = fetch_list(pool, http, base, file_name).await {
            tracing::warn!(file_name, error = %format!("{e:#}"), "MTGJSON precon list download failed");
            return Err(AppError::Unavailable(format!("MTGJSON didn't send this list ({e:#}). Try again in a minute.")));
        }
        row = list_row(pool, file_name).await?;
    }
    let text = row.list_text.unwrap_or_default();
    let mut seen = HashSet::new();
    let names: Vec<String> =
        crate::decks::parse_list(&text, false).into_iter().map(|l| l.name).filter(|n| seen.insert(n.clone())).collect();
    let known = crate::cards::resolve_names(pool, &names).await?;
    Ok(PreconList {
        file_name: file_name.to_string(),
        name: row.name,
        set_code: row.set_code,
        release_date: row.release_date,
        source_url: row.source_url,
        commanders: row.commanders.as_deref().and_then(|c| serde_json::from_str(c).ok()).unwrap_or_default(),
        text,
        cards: row.list_cards,
        fetched_at: row.list_fetched_at.unwrap_or_default(),
        unknown: names.into_iter().filter(|n| !known.contains_key(n)).collect(),
    })
}

async fn precon(State(st): State<AppState>, _user: CurrentUser, Path(file_name): Path<String>) -> AppResult<Json<PreconList>> {
    Ok(Json(precon_list(&st.pool, &st.http, MTGJSON_API, &file_name).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get as axum_get;

    fn set(code: &str, released: &str, kind: &str, count: i64, parent: Option<&str>) -> ScryfallSet {
        ScryfallSet {
            code: code.into(),
            name: format!("Set {code}"),
            set_type: kind.into(),
            released_at: Some(released.into()),
            card_count: count,
            printed_size: None,
            parent_set_code: parent.map(str::to_string),
            digital: false,
            scryfall_uri: Some(format!("https://scryfall.com/sets/{code}")),
        }
    }

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    async fn user(pool: &SqlitePool, id: &str) {
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, '2026-10-19T00:00:00Z')")
            .bind(id)
            .bind(format!("{id}@example.com"))
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    fn t(s: &str) -> DateTime<Utc> {
        parse_time(s).unwrap()
    }

    #[test]
    fn refreshes_are_daily_and_failures_wait_an_hour() {
        let at = t("2026-10-19T12:00:00Z");
        assert!(is_due(None, None, at), "never run");
        assert!(!is_due(Some(t("2026-10-19T01:00:00Z")), Some(t("2026-10-19T01:00:00Z")), at), "fresh");
        assert!(is_due(Some(t("2026-10-18T12:00:00Z")), Some(t("2026-10-18T12:00:00Z")), at), "a day old");
        assert!(!is_due(Some(t("2026-10-18T12:00:00Z")), Some(t("2026-10-19T11:30:00Z")), at), "failed half an hour ago");
        assert!(is_due(None, Some(t("2026-10-19T10:30:00Z")), at), "failed 90 minutes ago");
    }

    #[test]
    fn stock_lists_read_back_as_the_precon() {
        let card = |name: &str, count: i64, number: Option<&str>| DeckCardRef {
            name: name.into(),
            face_name: None,
            layout: None,
            count,
            set_code: number.map(|_| "FRC".into()),
            number: number.map(str::to_string),
        };
        let deck = DeckData {
            commander: vec![card("Jace, Multiverse Architect", 1, Some("1"))],
            main_board: vec![
                card("Sol Ring", 1, Some("90")),
                card("Island", 7, Some("120")),
                card("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", 1, None),
            ],
            side_board: vec![],
        };
        let text = stock_list(&deck);
        assert!(text.starts_with("Commander\n1 Jace, Multiverse Architect (FRC) 1\n\nDeck\n"));
        assert!(!text.contains("Sideboard"));
        let lines = crate::decks::parse_list(&text, false);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0], crate::decks::ParsedLine { qty: 1, name: "Jace, Multiverse Architect".into(), board: crate::decks::Board::Commander });
        assert_eq!(lines[2].qty, 7);
        assert_eq!(lines[2].name, "Island");
        assert_eq!(lines[3].name, "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki");
        assert!(lines[1..].iter().all(|l| l.board == crate::decks::Board::Main));
    }

    #[tokio::test]
    async fn sets_keep_upcoming_and_watched_and_drop_the_rest() {
        let pool = crate::db::test_pool().await;
        user(&pool, "u1").await;
        let today = day("2026-10-19");
        let sets = vec![
            set("trk", "2026-11-13", "expansion", 135, None),
            set("trc", "2026-11-13", "commander", 41, Some("trk")),
            set("mbc", "2026-10-19", "draft_innovation", 80, None),
            set("frc", "2026-10-02", "commander", 99, None),
            set("old", "2020-01-01", "core", 280, None),
        ];
        assert_eq!(store_sets(&pool, &sets, today).await.unwrap(), 3);

        // Watch Star Trek; a month after release it and the Commander set under it stay.
        add_watch(&pool, "u1", "TRK", today).await.unwrap();
        add_watch(&pool, "u1", "trk", today).await.unwrap(); // twice is once
        assert!(matches!(add_watch(&pool, "u1", "frc", today).await, Err(AppError::NotFound(_))), "only sets in the calendar");
        let later = day("2026-12-15");
        assert_eq!(store_sets(&pool, &sets, later).await.unwrap(), 2);
        let codes: Vec<String> = sqlx::query_scalar("SELECT code FROM calendar_sets ORDER BY code").fetch_all(&pool).await.unwrap();
        assert_eq!(codes, ["trc", "trk"]);

        let v = view(&pool, "u1", later, false).await.unwrap();
        let trk = v.upcoming.iter().find(|s| s.code == "trk").unwrap();
        let trc = v.upcoming.iter().find(|s| s.code == "trc").unwrap();
        assert!(trk.watched && !trk.parent_watched);
        assert!(!trc.watched && trc.parent_watched);
        assert_eq!(trc.parent_name.as_deref(), Some("Set trk"));
        assert_eq!(v.upcoming[0].code, "trk", "a parent sorts before the sets under it");

        // Someone who watches nothing sees only what's still to come.
        user(&pool, "u2").await;
        assert!(view(&pool, "u2", later, false).await.unwrap().upcoming.is_empty());

        // u1 still follows Star Trek after release: watching again, or watching the Commander set
        // under it directly, is fine. u2 gets the same answer as for a set that doesn't exist, so
        // the past sets kept for u1 stay private.
        add_watch(&pool, "u1", "trk", later).await.unwrap();
        add_watch(&pool, "u1", "trc", later).await.unwrap();
        for code in ["trk", "trc"] {
            assert!(matches!(add_watch(&pool, "u2", code, later).await, Err(AppError::NotFound("set"))), "{code}");
        }
        let u2: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM calendar_watches WHERE user_id = 'u2'").fetch_one(&pool).await.unwrap();
        assert_eq!(u2, 0);
    }

    #[test]
    fn the_readers_date_stays_within_a_day_of_the_servers() {
        let utc = day("2026-12-15");
        assert_eq!(reader_today(None, utc), utc);
        assert_eq!(reader_today(Some(day("2026-12-14")), utc), day("2026-12-14"), "a day behind (Hawaii late at night)");
        assert_eq!(reader_today(Some(day("2026-12-16")), utc), day("2026-12-16"), "a day ahead (Kiribati)");
        assert_eq!(reader_today(Some(day("2000-01-01")), utc), day("2026-12-14"), "no peeking at old sets");
        assert_eq!(reader_today(Some(day("2030-01-01")), utc), day("2026-12-16"));
    }

    const DECKLIST: &str = r#"{"meta":{"date":"2026-10-19","version":"5.3.0+20261019"},"data":[
        {"code":"TRC","fileName":"FederationFleet_TRC","name":"Federation Fleet","releaseDate":"2026-11-13","source":"https://magic.wizards.com/en/news/star-trek-commander-decklists","type":"Commander Deck"},
        {"code":"TRC","fileName":"WeAreTheBorg_TRC","name":"We Are the Borg","releaseDate":"2026-11-13","source":"default database query","type":"Commander Deck"},
        {"code":"TRK","fileName":"Starter_TRK","name":"Starter","releaseDate":"2026-11-13","type":"Welcome Deck"}
    ]}"#;

    const DECK: &str = r#"{"meta":{"date":"2026-10-19","version":"5.3.0+20261019"},"data":{
        "code":"TRC","name":"Federation Fleet","type":"Commander Deck",
        "commander":[{"name":"Sol Ring","count":1,"setCode":"TRC","number":"1","isFoil":true,"identifiers":{}}],
        "mainBoard":[{"name":"Island","count":98,"setCode":"TRC","number":"200"},{"name":"Captain Not Yet Imported","count":1,"setCode":"TRC","number":"2"}],
        "sideBoard":[],"tokens":[{"name":"Soldier","count":1,"setCode":"TTRC","number":"3"}]
    }}"#;

    /// A local stand-in for Scryfall and MTGJSON. `fail_decks` makes deck files answer 500.
    async fn fake_sources(fail_decks: bool) -> Sources {
        use axum::http::HeaderMap;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let page2 = format!("{base}/sets2");
        let polite = |h: &HeaderMap| {
            assert!(h.get("user-agent").unwrap().to_str().unwrap().starts_with("Yama/"));
            assert_eq!(h.get("accept").unwrap(), "application/json");
        };
        let app = axum::Router::new()
            .route(
                "/sets",
                axum_get(move |h: HeaderMap| async move {
                    polite(&h);
                    let body = serde_json::json!({"object":"list","has_more":true,"next_page":page2,"data":[
                        {"code":"trk","name":"Star Trek","set_type":"expansion","released_at":"2026-11-13","card_count":135,"digital":false,"scryfall_uri":"https://scryfall.com/sets/trk"}
                    ]});
                    Json(body)
                }),
            )
            .route(
                "/sets2",
                axum_get(move |h: HeaderMap| async move {
                    polite(&h);
                    Json(serde_json::json!({"object":"list","has_more":false,"data":[
                        {"code":"trc","name":"Star Trek Commander","set_type":"commander","released_at":"2026-11-13","card_count":41,"parent_set_code":"trk","digital":false}
                    ]}))
                }),
            )
            .route(
                "/DeckList.json",
                axum_get(move |h: HeaderMap| async move {
                    polite(&h);
                    ([("content-type", "application/json")], DECKLIST)
                }),
            )
            .route(
                "/decks/{file}",
                axum_get(move |h: HeaderMap, Path(file): Path<String>| async move {
                    polite(&h);
                    if fail_decks || file != "FederationFleet_TRC.json" {
                        return (StatusCode::INTERNAL_SERVER_ERROR, [("content-type", "text/plain")], String::new());
                    }
                    (StatusCode::OK, [("content-type", "application/json")], DECK.to_string())
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Sources { sets_url: format!("{base}/sets"), mtgjson: base }
    }

    #[tokio::test]
    async fn watched_sets_show_their_precons_and_lists_download_once() {
        let pool = crate::db::test_pool().await;
        user(&pool, "u1").await;
        let http = crate::routes::http_client();
        let src = fake_sources(false).await;
        let today = day("2026-10-19");

        // Both pages of sets, then MTGJSON's index: only Commander decks, codes lowercased.
        assert_eq!(refresh_sets(&pool, &http, &src.sets_url, today).await.unwrap(), 2);
        assert_eq!(refresh_decklist(&pool, &http, &src.mtgjson).await.unwrap(), 2);
        let v = view(&pool, "u1", today, true).await.unwrap();
        assert_eq!(v.precons.source_date.as_deref(), Some("2026-10-19"));
        assert!(v.sets.checked_at.is_some() && v.sets.error.is_none());
        let trk = v.upcoming.iter().find(|s| s.code == "trk").unwrap();
        assert_eq!(trk.precons.len(), 2, "the Commander set's decks show under the main set too");
        let borg = trk.precons.iter().find(|p| p.name == "We Are the Borg").unwrap();
        assert_eq!(borg.source_url, None, "MTGJSON's 'default database query' isn't a link");
        assert_eq!(borg.commanders, None, "not downloaded yet");

        // Nothing is watched, so the daily pass downloads no lists.
        assert_eq!(fetch_watched_lists(&pool, &http, &src.mtgjson).await.unwrap(), 0);

        // Watching the main set downloads its Commander decks' lists; one of the two fails.
        add_watch(&pool, "u1", "trk", today).await.unwrap();
        assert_eq!(fetch_watched_lists(&pool, &http, &src.mtgjson).await.unwrap(), 1);
        let v = view(&pool, "u1", today, true).await.unwrap();
        let fleet = v.upcoming.iter().find(|s| s.code == "trc").unwrap().precons.iter().find(|p| p.name == "Federation Fleet").unwrap();
        assert_eq!(fleet.commanders.as_deref(), Some(&["Sol Ring".to_string()][..]));
        assert_eq!(fleet.list_cards, Some(100), "commander and main board; tokens left out");
        // The pass after doesn't download either again: one is fresh, the other failed recently.
        assert_eq!(fetch_watched_lists(&pool, &http, &src.mtgjson).await.unwrap(), 0);

        // The list, ready to paste, names cards Yama doesn't know yet.
        sqlx::query("INSERT INTO cards (oracle_id, name, cmc, type_line, color_identity, colors, legalities, updated_at) VALUES ('o1', 'Island', 0, 'Basic Land — Island', '', '', '{}', '2026-10-19')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('Island', 'o1')").execute(&pool).await.unwrap();
        let list = precon_list(&pool, &http, &src.mtgjson, "FederationFleet_TRC").await.unwrap();
        assert!(list.text.starts_with("Commander\n1 Sol Ring (TRC) 1\n\nDeck\n98 Island (TRC) 200\n"));
        assert_eq!(list.unknown, ["Sol Ring", "Captain Not Yet Imported"]);
        assert_eq!(list.commanders, ["Sol Ring"]);

        // A list that failed a moment ago isn't asked for again; an unknown deck is a 404.
        assert!(matches!(precon_list(&pool, &http, &src.mtgjson, "WeAreTheBorg_TRC").await, Err(AppError::Unavailable(m)) if m.contains("a moment ago")));
        assert!(matches!(precon_list(&pool, &http, &src.mtgjson, "../../etc").await, Err(AppError::NotFound(_))));

        // Refreshing the index keeps the downloaded list and when the deck was first seen.
        let first: String = sqlx::query_scalar("SELECT first_seen_at FROM calendar_precons WHERE file_name = 'FederationFleet_TRC'").fetch_one(&pool).await.unwrap();
        sqlx::query("UPDATE calendar_precons SET first_seen_at = '2026-10-01T00:00:00Z' WHERE file_name = 'FederationFleet_TRC'").execute(&pool).await.unwrap();
        refresh_decklist(&pool, &http, &src.mtgjson).await.unwrap();
        let (seen, text): (String, Option<String>) =
            sqlx::query_as("SELECT first_seen_at, list_text FROM calendar_precons WHERE file_name = 'FederationFleet_TRC'").fetch_one(&pool).await.unwrap();
        assert_eq!(seen, "2026-10-01T00:00:00Z");
        assert_ne!(seen, first);
        assert!(text.is_some());
    }

    async fn known_card(pool: &SqlitePool, id: &str, name: &str) {
        sqlx::query("INSERT INTO cards (oracle_id, name, cmc, type_line, color_identity, colors, legalities, updated_at) VALUES (?, ?, 0, 'Creature', '', '', '{}', '2026-10-19')")
            .bind(id)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(id).execute(pool).await.unwrap();
    }

    /// MTGJSON names meld and reversible cards "Front // Back" (with `faceName` holding the
    /// front), which Scryfall's card names don't have. These are the commanders of three Secret
    /// Lair Commander decks in MTGJSON's index (5.3.0+20261018): Angels (Gisela), Heads I Win
    /// (Zndrsplt and Okaun), Raining Cats and Dogs (Rin and Seri). Found in review.
    #[tokio::test]
    async fn meld_and_reversible_precon_cards_resolve() {
        let pool = crate::db::test_pool().await;
        known_card(&pool, "gisela", "Gisela, the Broken Blade").await;
        known_card(&pool, "zndr", "Zndrsplt, Eye of Wisdom").await;
        known_card(&pool, "solring", "Sol Ring").await;
        known_card(&pool, "fable", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki").await;
        // The shape of MTGJSON's deck file entries (trimmed).
        let deck: DeckData = serde_json::from_str(
            r#"{
            "commander":[
              {"name":"Gisela, the Broken Blade // Brisela, Voice of Nightmares","faceName":"Gisela, the Broken Blade","layout":"meld","side":"a","count":1,"setCode":"SLD","number":"1335"},
              {"name":"Zndrsplt, Eye of Wisdom // Zndrsplt, Eye of Wisdom","faceName":"Zndrsplt, Eye of Wisdom","layout":"reversible_card","side":"a","count":1,"setCode":"SLD","number":"379"}
            ],
            "mainBoard":[
              {"name":"Sol Ring // Sol Ring","faceName":"Sol Ring","layout":"reversible_card","side":"a","count":1,"setCode":"SLD","number":"1512"},
              {"name":"Fable of the Mirror-Breaker // Reflection of Kiki-Jiki","faceName":"Fable of the Mirror-Breaker","layout":"transform","side":"a","count":1,"setCode":"NEO","number":"141"}
            ]}"#,
        )
        .unwrap();
        let text = stock_list(&deck);
        assert!(text.starts_with("Commander\n1 Gisela, the Broken Blade (SLD) 1335\n1 Zndrsplt, Eye of Wisdom (SLD) 379\n"), "{text}");
        assert!(text.contains("\n1 Fable of the Mirror-Breaker // Reflection of Kiki-Jiki (NEO) 141\n"), "a double-faced card keeps both names, as Scryfall does");
        sqlx::query(
            "INSERT INTO calendar_precons (file_name, set_code, name, first_seen_at, list_text, list_cards, list_fetched_at)
             VALUES ('Angels_SLD', 'sld', 'Angels', '2026-10-19T00:00:00Z', ?, 4, '2026-10-19T00:00:00Z')",
        )
        .bind(&text)
        .execute(&pool)
        .await
        .unwrap();
        let http = crate::routes::http_client();
        let list = precon_list(&pool, &http, "http://127.0.0.1:9", "Angels_SLD").await.unwrap();
        assert!(list.unknown.is_empty(), "known cards reported as missing: {:?}", list.unknown);

        // A layout MTGJSON hasn't sent before still reads "X // X" as one card.
        let odd = DeckCardRef { name: "Okaun, Eye of Chaos // Okaun, Eye of Chaos".into(), face_name: None, layout: None, count: 1, set_code: None, number: None };
        assert_eq!(odd.card_name(), "Okaun, Eye of Chaos");
    }

    fn decklist_entry(file: &str, name: &str, code: &str, release: &str) -> serde_json::Value {
        serde_json::json!({"code": code, "fileName": file, "name": name, "releaseDate": release, "type": "Commander Deck"})
    }

    /// A deck MTGJSON drops from DeckList.json (renamed or withdrawn) leaves the calendar at the
    /// next good refresh. Found in review.
    #[tokio::test]
    async fn decks_mtgjson_drops_leave_the_calendar() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU8, Ordering};
        let pool = crate::db::test_pool().await;
        let today = day("2026-10-19");
        store_sets(&pool, &[set("trc", "2026-11-13", "commander", 41, None)], today).await.unwrap();

        // 0: both decks; 1: the preview deck is gone; 2: no Commander decks at all.
        let stage = Arc::new(AtomicU8::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = axum::Router::new()
            .route(
                "/DeckList.json",
                axum_get(|State(stage): State<Arc<AtomicU8>>| async move {
                    let fleet = decklist_entry("FederationFleet_TRC", "Federation Fleet", "TRC", "2026-11-13");
                    let preview = decklist_entry("FederationFleetPreview_TRC", "Federation Fleet (preview)", "TRC", "2026-11-13");
                    let welcome = serde_json::json!({"code":"TRK","fileName":"Starter_TRK","name":"Starter","type":"Welcome Deck"});
                    let data = match stage.load(Ordering::SeqCst) {
                        0 => vec![preview, fleet],
                        1 => vec![fleet],
                        _ => vec![welcome],
                    };
                    Json(serde_json::json!({"meta": {"date": "2026-10-19"}, "data": data}))
                }),
            )
            .with_state(stage.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let http = crate::routes::http_client();

        assert_eq!(refresh_decklist(&pool, &http, &base).await.unwrap(), 2);
        stage.store(1, Ordering::SeqCst);
        assert_eq!(refresh_decklist(&pool, &http, &base).await.unwrap(), 1);
        let names = |v: CalendarView| v.upcoming[0].precons.iter().map(|p| p.file_name.clone()).collect::<Vec<_>>();
        assert_eq!(names(view(&pool, "nobody", today, true).await.unwrap()), ["FederationFleet_TRC"], "MTGJSON no longer lists the preview deck");

        // An index with no Commander decks is a failed refresh, not "every deck withdrawn".
        stage.store(2, Ordering::SeqCst);
        let err = refresh_decklist(&pool, &http, &base).await.unwrap_err();
        assert!(format!("{err:#}").contains("no Commander decks"));
        let logged: Option<String> = sqlx::query_scalar("SELECT error FROM import_runs WHERE kind = ? ORDER BY rowid DESC LIMIT 1")
            .bind(DECKLIST_KIND)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(logged.is_some_and(|e| e.contains("no Commander decks")));
        assert_eq!(names(view(&pool, "nobody", today, true).await.unwrap()), ["FederationFleet_TRC"]);
    }

    /// Collector's Editions are the base deck in other printings: they're listed under it, not as
    /// decks of their own, and the weekly pass leaves their lists alone.
    #[tokio::test]
    async fn collector_editions_sit_under_their_base_deck() {
        let pool = crate::db::test_pool().await;
        let today = day("2026-06-01");
        store_sets(&pool, &[set("msc", "2026-06-26", "commander", 400, None), set("fic", "2026-06-13", "commander", 400, None)], today).await.unwrap();
        let entries: Vec<DeckListEntry> = serde_json::from_value(serde_json::json!([
            decklist_entry("TheFantasticFour_MSC", "The Fantastic Four", "MSC", "2026-06-26"),
            decklist_entry("TheFantasticFourCollectorSEdition_MSC", "The Fantastic Four Collector's Edition", "MSC", "2026-06-26"),
            decklist_entry("DoomPrevails_MSC", "Doom Prevails", "MSC", "2026-06-26"),
            // MTGJSON's names for Final Fantasy put the edition in the middle.
            decklist_entry("CounterBlitzFinalFantasyX_FIC", "Counter Blitz (FINAL FANTASY X)", "FIC", "2026-06-13"),
            decklist_entry("CounterBlitzCollectorSEditionFinalFantasyX_FIC", "Counter Blitz Collector\u{2019}s Edition (FINAL FANTASY X)", "FIC", "2026-06-13"),
            // A Collector's Edition whose base deck isn't listed stands on its own.
            decklist_entry("WakandaForeverCollectorSEdition_MSC", "Wakanda Forever Collector's Edition", "MSC", "2026-06-26"),
        ]))
        .unwrap();
        assert_eq!(store_decklist(&pool, &entries).await.unwrap(), 6);

        let v = view(&pool, "nobody", today, true).await.unwrap();
        let msc = v.upcoming.iter().find(|s| s.code == "msc").unwrap();
        let listed: Vec<(&str, Vec<&str>)> =
            msc.precons.iter().map(|p| (p.file_name.as_str(), p.variants.iter().map(|v| v.file_name.as_str()).collect())).collect();
        assert_eq!(
            listed,
            [
                ("DoomPrevails_MSC", vec![]),
                ("TheFantasticFour_MSC", vec!["TheFantasticFourCollectorSEdition_MSC"]),
                ("WakandaForeverCollectorSEdition_MSC", vec![]),
            ]
        );
        let fic = v.upcoming.iter().find(|s| s.code == "fic").unwrap();
        assert_eq!(fic.precons.len(), 1);
        assert_eq!(fic.precons[0].variants[0].file_name, "CounterBlitzCollectorSEditionFinalFantasyX_FIC");
    }

    /// The weekly pass: lists never downloaded come first; a list is downloaded again weekly
    /// only until four weeks after release; Collector's Editions only once someone started one.
    #[tokio::test]
    async fn the_weekly_pass_stops_after_release_and_skips_collector_editions() {
        use std::sync::{Arc, Mutex};
        let pool = crate::db::test_pool().await;
        user(&pool, "u1").await;
        sqlx::query("INSERT INTO calendar_watches (user_id, set_code, created_at) VALUES ('u1', 'trc', '2026-10-19T00:00:00Z')").execute(&pool).await.unwrap();
        let date = |days: i64| (Utc::now() + chrono::Duration::days(days)).format("%Y-%m-%d").to_string();
        let week_old = stamp_ago(chrono::Duration::days(10));
        let rows: [(&str, Option<&str>, String, Option<&str>); 6] = [
            ("Coming_TRC", None, date(25), Some(&week_old)),                       // due: stale, before release
            ("JustOut_TRC", None, date(-20), Some(&week_old)),                     // due: stale, three weeks after release
            ("LongOut_TRC", None, date(-60), Some(&week_old)),                     // not due: two months after release
            ("NeverFetched_TRC", None, date(-60), None),                           // due: never downloaded
            ("ComingCollectorSEdition_TRC", Some("Coming_TRC"), date(25), None),   // not due: nobody started it
            ("StartedCollectorSEdition_TRC", Some("Coming_TRC"), date(25), Some(&week_old)), // due: someone started it
        ];
        for (file, variant_of, release, fetched) in &rows {
            sqlx::query(
                "INSERT INTO calendar_precons (file_name, set_code, name, variant_of, release_date, first_seen_at, list_text, list_fetched_at)
                 VALUES (?, 'trc', ?, ?, ?, '2026-10-01T00:00:00Z', ?, ?)",
            )
            .bind(file)
            .bind(file)
            .bind(variant_of)
            .bind(release)
            .bind(fetched.map(|_| "Commander\n1 Sol Ring\n"))
            .bind(fetched)
            .execute(&pool)
            .await
            .unwrap();
        }
        let asked = Arc::new(Mutex::new(Vec::<String>::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = axum::Router::new()
            .route(
                "/decks/{file}",
                axum_get(|State(asked): State<Arc<Mutex<Vec<String>>>>, Path(file): Path<String>| async move {
                    asked.lock().unwrap().push(file.trim_end_matches(".json").to_string());
                    StatusCode::INTERNAL_SERVER_ERROR
                }),
            )
            .with_state(asked.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        assert_eq!(fetch_watched_lists(&pool, &crate::routes::http_client(), &base).await.unwrap(), 0);
        let asked = asked.lock().unwrap().clone();
        assert_eq!(asked, ["NeverFetched_TRC", "Coming_TRC", "StartedCollectorSEdition_TRC", "JustOut_TRC"]);
    }

    #[tokio::test]
    async fn failed_refreshes_are_logged_and_shown() {
        let pool = crate::db::test_pool().await;
        user(&pool, "u1").await;
        let http = crate::routes::http_client();
        let src = fake_sources(true).await;
        // Nothing listens at this path: the run is logged with its error, and the view says so.
        let bad = format!("{}/missing", src.mtgjson);
        assert!(refresh_sets(&pool, &http, &bad, day("2026-10-19")).await.is_err());
        let v = view(&pool, "u1", day("2026-10-19"), true).await.unwrap();
        assert!(v.sets.checked_at.is_none());
        assert!(v.sets.error.unwrap().contains("404"));
        assert!(!due(&pool, SETS_KIND).await.unwrap(), "a failed try waits before the next");
        assert!(due(&pool, DECKLIST_KIND).await.unwrap());
    }
}
