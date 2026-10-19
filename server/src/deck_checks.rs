//! Outside checks of deck versions: Commander Spellbook's bracket estimate, the cards it flags
//! (Game Changers, mass land denial, extra turns) and the combos it finds in the list.
//!
//! A check is queued when a version is saved (`decks::insert_version`) and run by one background
//! worker, so saving never waits on the network. The worker sends one request at a time, at
//! least [`MIN_GAP`] apart, which keeps Yama far under Spellbook's guideline of about 80
//! requests a minute; a 429 makes it wait as long as Spellbook asks. Failures retry with growing
//! pauses and stop after [`MAX_ATTEMPTS`] until someone presses "check again".
//!
//! Spellbook's API guidelines (docs/api.md in SpaceCowMedia/commander-spellbook-backend, read
//! 2026-10-19): sparse unauthenticated requests, name the service in the User-Agent, handle
//! 429, credit and link to commanderspellbook.com. The estimate is theirs; Yama shows it as an
//! estimate with its date and never in place of the bracket the owner declares.

use crate::decks::{Board, DeckCard, load_version_cards};
use crate::error::{AppError, AppResult};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Notify;

/// `deck_version_checks.source` for Commander Spellbook.
pub const SPELLBOOK: &str = "commander_spellbook";
pub const SPELLBOOK_ESTIMATE_URL: &str = "https://backend.commanderspellbook.com/estimate-bracket";
pub const SPELLBOOK_SITE: &str = "https://commanderspellbook.com/";

/// Shortest pause between two requests to Spellbook (at most 15 a minute).
const MIN_GAP: Duration = Duration::from_secs(4);
/// Failed tries before the worker gives up on a version until it's requested again.
pub const MAX_ATTEMPTS: i64 = 6;
/// Pause before try n+1 after n failures.
const BACKOFF_SECS: [i64; 6] = [0, 60, 5 * 60, 30 * 60, 2 * 3600, 12 * 3600];
/// How often an idle worker looks for checks queued by another process.
const IDLE_POLL: Duration = Duration::from_secs(10 * 60);
/// "Check again" is refused this soon after an answer, so a button can't hammer Spellbook.
pub const RECHECK_AFTER_SECS: i64 = 10 * 60;

/// Millisecond RFC 3339 times, so a request and an answer in the same second still order.
fn stamp_of(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn stamp() -> String {
    stamp_of(Utc::now())
}

fn parse_stamp(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
}

static WAKE: OnceLock<Notify> = OnceLock::new();

/// Tell the worker (if this process runs one) that a check was queued.
pub fn wake() {
    WAKE.get_or_init(Notify::new).notify_one();
}

/// Queue a check of a new version. Does nothing if it's already queued or checked.
pub async fn queue<'e, E: sqlx::SqliteExecutor<'e>>(db: E, version_id: &str) -> sqlx::Result<()> {
    sqlx::query("INSERT INTO deck_version_checks (version_id, source, requested_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(version_id)
        .bind(SPELLBOOK)
        .bind(stamp())
        .execute(db)
        .await?;
    Ok(())
}

/// Ask for a fresh check of a version that may have been checked before (outside data changes:
/// new combos, Game Changer list updates). The old answer stays until the new one arrives.
/// Refused within [`RECHECK_AFTER_SECS`] of the last answer.
pub async fn request_again(pool: &SqlitePool, version_id: &str) -> AppResult<()> {
    let checked: Option<Option<String>> =
        sqlx::query_scalar("SELECT checked_at FROM deck_version_checks WHERE version_id = ? AND source = ?")
            .bind(version_id)
            .bind(SPELLBOOK)
            .fetch_optional(pool)
            .await?;
    if let Some(at) = checked.flatten().as_deref().and_then(parse_stamp) {
        let age = (Utc::now() - at).num_seconds();
        if age < RECHECK_AFTER_SECS {
            let wait = (RECHECK_AFTER_SECS - age + 59) / 60;
            return Err(AppError::Conflict(format!(
                "checked {} ago; try again in {wait} {}",
                ago(age),
                if wait == 1 { "minute" } else { "minutes" }
            )));
        }
    }
    sqlx::query(
        "INSERT INTO deck_version_checks (version_id, source, requested_at) VALUES (?, ?, ?)
         ON CONFLICT DO UPDATE SET requested_at = excluded.requested_at, attempts = 0, error = NULL",
    )
    .bind(version_id)
    .bind(SPELLBOOK)
    .bind(stamp())
    .execute(pool)
    .await?;
    wake();
    Ok(())
}

fn ago(secs: i64) -> String {
    match secs {
        ..60 => "less than a minute".into(),
        60..120 => "a minute".into(),
        _ => format!("{} minutes", secs / 60),
    }
}

// ── what the API returns ───────────────────────────────────────────────────

/// A deck version's check as the deck page shows it.
#[derive(Serialize, Debug)]
pub struct CheckView {
    /// Whether this server runs checks at all (`YAMA_DECK_CHECKS`).
    pub enabled: bool,
    pub version_id: Option<String>,
    pub source: &'static str,
    pub source_url: &'static str,
    /// A check is queued or running.
    pub pending: bool,
    /// The last try failed (kept until one succeeds).
    pub error: Option<String>,
    /// Tries have stopped until someone asks again.
    pub gave_up: bool,
    pub requested_at: Option<String>,
    /// The newest answer, if any; it can be older than a pending re-check.
    pub result: Option<CheckResult>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CheckResult {
    /// When the request that got this answer was sent.
    pub checked_at: String,
    /// Spellbook's tag: E C O P S R, or B when a card is banned.
    pub bracket_tag: String,
    pub bracket_label: &'static str,
    /// The 1-5 bracket Spellbook gives the tag (its own `bracket` field); `None` for B.
    pub bracket: Option<i64>,
    pub game_changers: Vec<String>,
    pub mld: Vec<String>,
    pub extra_turns: Vec<String>,
    pub combos: Vec<Combo>,
    /// Deck cards Spellbook didn't know, so they played no part in the estimate.
    pub unrecognized: Vec<String>,
}

/// One combo Spellbook found, trimmed to what the deck page shows.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Combo {
    /// Spellbook's variant id; the page is https://commanderspellbook.com/combo/{id}/
    pub id: String,
    pub cards: Vec<String>,
    /// Requirements that aren't a named card ("a creature that taps for mana").
    #[serde(default)]
    pub templates: Vec<String>,
    pub results: Vec<String>,
    /// Exactly two cards and nothing else named.
    pub two_card: bool,
    #[serde(default)]
    pub mana_needed: Option<String>,
    /// Plain-language reasons this combo matters for brackets ("extra turns", "lock").
    #[serde(default)]
    pub flags: Vec<String>,
    /// Spellbook's bracket tag for the combo on its own.
    #[serde(default)]
    pub bracket_tag: Option<String>,
}

/// Spellbook's bracket tags, with the 1-5 number its `bracket` field gives each (Variant model,
/// read 2026-10-19). Ruthless is "4" there, though it covers bracket 4 and up.
pub fn bracket_of_tag(tag: &str) -> (&'static str, Option<i64>) {
    match tag {
        "E" => ("Exhibition", Some(1)),
        "C" => ("Core", Some(2)),
        "O" => ("Oddball", Some(2)),
        "P" => ("Powerful", Some(3)),
        "S" => ("Spicy", Some(3)),
        "R" => ("Ruthless", Some(4)),
        "B" => ("Banned card", None),
        _ => ("Unknown", None),
    }
}

// ── Spellbook's response ───────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    bracket_tag: String,
    #[serde(default)]
    cards: Vec<ClassifiedCard>,
    #[serde(default)]
    combos: Vec<ClassifiedCombo>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ClassifiedCard {
    card: SbCard,
    #[serde(default)]
    game_changer: bool,
    #[serde(default)]
    mass_land_denial: bool,
    #[serde(default)]
    extra_turn: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SbCard {
    name: String,
    #[serde(default)]
    oracle_id: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ClassifiedCombo {
    combo: Variant,
    #[serde(default)]
    mass_land_denial: bool,
    #[serde(default)]
    extra_turn: bool,
    #[serde(default)]
    lock: bool,
    #[serde(default)]
    skip_turns: bool,
    #[serde(default)]
    control_all_opponents: bool,
    #[serde(default)]
    control_some_opponents: bool,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Variant {
    id: String,
    #[serde(default)]
    uses: Vec<Uses>,
    #[serde(default)]
    requires: Vec<Requires>,
    #[serde(default)]
    produces: Vec<Produces>,
    #[serde(default)]
    mana_needed: Option<String>,
    #[serde(default)]
    bracket_tag: Option<String>,
}

#[derive(Deserialize, Debug)]
struct Uses {
    card: SbCard,
    #[serde(default = "one")]
    quantity: i64,
}

#[derive(Deserialize, Debug)]
struct Requires {
    template: Named,
}

#[derive(Deserialize, Debug)]
struct Produces {
    feature: Named,
}

#[derive(Deserialize, Debug)]
struct Named {
    name: String,
}

fn one() -> i64 {
    1
}

/// Turn Spellbook's answer into what Yama stores, naming cards as the deck does.
pub fn summarize(est: Estimate, deck: &[DeckCard], checked_at: &str) -> CheckResult {
    let ours: HashMap<&str, &str> = deck.iter().map(|c| (c.oracle_id.as_str(), c.name.as_str())).collect();
    let name = |c: &SbCard| -> String {
        c.oracle_id.as_deref().and_then(|id| ours.get(id)).map_or_else(|| c.name.clone(), |n| n.to_string())
    };
    let pick = |test: fn(&ClassifiedCard) -> bool| -> Vec<String> {
        let mut v: Vec<String> = est.cards.iter().filter(|c| test(c)).map(|c| name(&c.card)).collect();
        v.sort();
        v.dedup();
        v
    };
    let game_changers = pick(|c| c.game_changer);
    let mld = pick(|c| c.mass_land_denial);
    let extra_turns = pick(|c| c.extra_turn);

    let known: std::collections::HashSet<&str> = est.cards.iter().filter_map(|c| c.card.oracle_id.as_deref()).collect();
    let mut unrecognized: Vec<String> = deck
        .iter()
        .filter(|c| c.board != Board::Side && !known.contains(c.oracle_id.as_str()))
        .map(|c| c.name.clone())
        .collect();
    unrecognized.sort();
    unrecognized.dedup();

    let mut combos: Vec<Combo> = est
        .combos
        .iter()
        .map(|c| {
            let v = &c.combo;
            let cards: Vec<String> = v.uses.iter().map(|u| name(&u.card)).collect();
            let templates: Vec<String> = v.requires.iter().map(|r| r.template.name.clone()).collect();
            let copies: i64 = v.uses.iter().map(|u| u.quantity.max(1)).sum();
            let flags = [
                (c.extra_turn, "extra turns"),
                (c.mass_land_denial, "mass land denial"),
                (c.lock, "lock"),
                (c.skip_turns, "skips turns"),
                (c.control_all_opponents, "controls all opponents"),
                (c.control_some_opponents, "controls an opponent"),
            ]
            .into_iter()
            .filter(|(on, _)| *on)
            .map(|(_, label)| label.to_string())
            .collect();
            Combo {
                id: v.id.clone(),
                two_card: copies == 2 && templates.is_empty(),
                cards,
                templates,
                results: v.produces.iter().map(|p| p.feature.name.clone()).collect(),
                mana_needed: v.mana_needed.clone().filter(|m| !m.is_empty()),
                flags,
                bracket_tag: v.bracket_tag.clone(),
            }
        })
        .collect();
    // Two-card combos first, then by their cards, so the order is stable between checks.
    combos.sort_by(|a, b| b.two_card.cmp(&a.two_card).then_with(|| a.cards.cmp(&b.cards)));

    let (bracket_label, bracket) = bracket_of_tag(&est.bracket_tag);
    CheckResult {
        checked_at: checked_at.to_string(),
        bracket_tag: est.bracket_tag,
        bracket_label,
        bracket,
        game_changers,
        mld,
        extra_turns,
        combos,
        unrecognized,
    }
}

/// The body Spellbook's estimate-bracket takes: cards by Scryfall oracle id (unambiguous, and
/// Spellbook accepts them for every card), commander and main deck only.
pub fn request_body(cards: &[DeckCard]) -> serde_json::Value {
    let list = |board: Board| -> Vec<serde_json::Value> {
        cards
            .iter()
            .filter(|c| c.board == board && c.qty > 0)
            .map(|c| serde_json::json!({ "card": c.oracle_id, "quantity": c.qty }))
            .collect()
    };
    serde_json::json!({ "commanders": list(Board::Commander), "main": list(Board::Main) })
}

// ── reading checks ─────────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct Row {
    requested_at: String,
    checked_at: Option<String>,
    bracket_tag: Option<String>,
    game_changers: Option<String>,
    mld: Option<String>,
    extra_turns: Option<String>,
    combos: Option<String>,
    unrecognized: Option<String>,
    attempts: i64,
    error: Option<String>,
}

const ROW_COLUMNS: &str =
    "requested_at, checked_at, bracket_tag, game_changers, mld, extra_turns, combos, unrecognized, attempts, error";

fn list<T: serde::de::DeserializeOwned>(json: &Option<String>) -> Vec<T> {
    json.as_deref().and_then(|j| serde_json::from_str(j).ok()).unwrap_or_default()
}

impl Row {
    fn result(&self) -> Option<CheckResult> {
        let (checked_at, tag) = (self.checked_at.as_ref()?, self.bracket_tag.as_ref()?);
        let (bracket_label, bracket) = bracket_of_tag(tag);
        Some(CheckResult {
            checked_at: checked_at.clone(),
            bracket_tag: tag.clone(),
            bracket_label,
            bracket,
            game_changers: list(&self.game_changers),
            mld: list(&self.mld),
            extra_turns: list(&self.extra_turns),
            combos: list(&self.combos),
            unrecognized: list(&self.unrecognized),
        })
    }

    fn waiting(&self) -> bool {
        self.checked_at.as_ref().is_none_or(|c| c < &self.requested_at)
    }
}

/// The Spellbook check of one version, for the deck page.
pub async fn view(pool: &SqlitePool, version_id: Option<&str>, enabled: bool) -> AppResult<CheckView> {
    let row: Option<Row> = match version_id {
        Some(v) => {
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT {ROW_COLUMNS} FROM deck_version_checks WHERE version_id = ? AND source = ?"
            )))
            .bind(v)
            .bind(SPELLBOOK)
            .fetch_optional(pool)
            .await?
        }
        None => None,
    };
    let gave_up = row.as_ref().is_some_and(|r| r.waiting() && r.attempts >= MAX_ATTEMPTS);
    Ok(CheckView {
        enabled,
        version_id: version_id.map(str::to_string),
        source: "Commander Spellbook",
        source_url: SPELLBOOK_SITE,
        pending: enabled && row.as_ref().is_some_and(|r| r.waiting() && r.attempts < MAX_ATTEMPTS),
        error: row.as_ref().and_then(|r| r.error.clone()),
        gave_up,
        requested_at: row.as_ref().map(|r| r.requested_at.clone()),
        result: row.as_ref().and_then(Row::result),
    })
}

/// The estimated bracket of each version that has an answer: version id → (tag, bracket).
pub async fn estimates(pool: &SqlitePool, version_ids: &[String]) -> sqlx::Result<HashMap<String, Estimated>> {
    let mut out = HashMap::new();
    for v in version_ids {
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT bracket_tag, checked_at FROM deck_version_checks WHERE version_id = ? AND source = ? AND bracket_tag IS NOT NULL",
        )
        .bind(v)
        .bind(SPELLBOOK)
        .fetch_optional(pool)
        .await?;
        if let Some((tag, checked_at)) = row {
            let (label, bracket) = bracket_of_tag(&tag);
            out.insert(v.clone(), Estimated { tag, label, bracket, checked_at });
        }
    }
    Ok(out)
}

/// An estimated bracket for chips beside the declared one.
#[derive(Serialize, Debug, Clone)]
pub struct Estimated {
    pub tag: String,
    pub label: &'static str,
    pub bracket: Option<i64>,
    pub checked_at: Option<String>,
}

// ── the worker ─────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum CheckError {
    /// 429: wait this long before the next request.
    RateLimited(Duration),
    Failed(String),
}

impl std::fmt::Display for CheckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RateLimited(d) => write!(f, "Commander Spellbook asked us to slow down (wait {} s)", d.as_secs()),
            Self::Failed(m) => f.write_str(m),
        }
    }
}

/// A queued check that's due now, or when the next one falls due.
enum Next {
    Due(String),
    Later(Duration),
    Idle,
}

/// The oldest due check of a deck's current version. Superseded versions wait (a later save
/// replaced them before their turn came), as do archived decks.
async fn next_pending(pool: &SqlitePool) -> sqlx::Result<Next> {
    let rows: Vec<(String, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT c.version_id, c.requested_at, c.attempts, c.last_attempt_at FROM deck_version_checks c
         JOIN decks d ON d.current_version_id = c.version_id AND d.archived = 0
         WHERE c.source = ? AND (c.checked_at IS NULL OR c.checked_at < c.requested_at) AND c.attempts < ?
         ORDER BY c.requested_at",
    )
    .bind(SPELLBOOK)
    .bind(MAX_ATTEMPTS)
    .fetch_all(pool)
    .await?;
    let now = Utc::now();
    let mut soonest: Option<Duration> = None;
    for (version, _, attempts, last) in rows {
        let wait = BACKOFF_SECS[attempts.clamp(0, MAX_ATTEMPTS - 1) as usize];
        let due = last.as_deref().and_then(parse_stamp).map_or(now, |t| t + chrono::Duration::seconds(wait));
        if due <= now {
            return Ok(Next::Due(version));
        }
        let left = (due - now).to_std().unwrap_or_default();
        soonest = Some(soonest.map_or(left, |s| s.min(left)));
    }
    Ok(soonest.map_or(Next::Idle, Next::Later))
}

/// Check one version against Spellbook and store the answer (or the failure).
pub async fn run_one(pool: &SqlitePool, http: &reqwest::Client, url: &str, version_id: &str) -> Result<(), CheckError> {
    let started = stamp();
    let outcome = fetch(pool, http, url, version_id, &started).await;
    let stored = match &outcome {
        Ok(result) => store(pool, version_id, result).await,
        Err(e) => record_failure(pool, version_id, &started, &e.to_string()).await,
    };
    if let Err(e) = stored {
        tracing::warn!(error = %e, version_id, "couldn't save a deck check");
    }
    outcome.map(|_| ())
}

async fn fetch(pool: &SqlitePool, http: &reqwest::Client, url: &str, version_id: &str, started: &str) -> Result<CheckResult, CheckError> {
    let cards = load_version_cards(pool, version_id).await.map_err(|e| CheckError::Failed(format!("couldn't read the deck: {e}")))?;
    if !cards.iter().any(|c| c.board != Board::Side) {
        return Err(CheckError::Failed("the deck has no cards to check".into()));
    }
    let res = http
        .post(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&request_body(&cards))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| CheckError::Failed(format!("couldn't reach Commander Spellbook ({})", short_error(&e))))?;
    let status = res.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let secs = res
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(60)
            .clamp(10, 3600);
        return Err(CheckError::RateLimited(Duration::from_secs(secs)));
    }
    if !status.is_success() {
        return Err(CheckError::Failed(format!("Commander Spellbook answered {status}")));
    }
    let est: Estimate = res
        .json()
        .await
        .map_err(|e| CheckError::Failed(format!("Commander Spellbook's answer didn't read as expected ({})", short_error(&e))))?;
    Ok(summarize(est, &cards, started))
}

fn short_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timed out".into()
    } else if e.is_connect() {
        "no connection".into()
    } else if e.is_decode() {
        "unexpected data".into()
    } else {
        e.status().map_or_else(|| "network error".into(), |s| s.to_string())
    }
}

fn json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

async fn store(pool: &SqlitePool, version_id: &str, r: &CheckResult) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE deck_version_checks SET checked_at = ?, bracket_tag = ?, game_changers = ?, mld = ?, extra_turns = ?,
            combos = ?, unrecognized = ?, attempts = 0, last_attempt_at = ?, error = NULL
         WHERE version_id = ? AND source = ?",
    )
    .bind(&r.checked_at)
    .bind(&r.bracket_tag)
    .bind(json(&r.game_changers))
    .bind(json(&r.mld))
    .bind(json(&r.extra_turns))
    .bind(json(&r.combos))
    .bind(json(&r.unrecognized))
    .bind(&r.checked_at)
    .bind(version_id)
    .bind(SPELLBOOK)
    .execute(pool)
    .await?;
    Ok(())
}

async fn record_failure(pool: &SqlitePool, version_id: &str, at: &str, error: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE deck_version_checks SET attempts = attempts + 1, last_attempt_at = ?, error = ? WHERE version_id = ? AND source = ?",
    )
    .bind(at)
    .bind(error)
    .bind(version_id)
    .bind(SPELLBOOK)
    .execute(pool)
    .await?;
    Ok(())
}

/// Queue the current version of every live deck that has never been queued (decks saved before
/// checks existed, or by the command line while no server ran).
pub async fn backfill(pool: &SqlitePool) -> sqlx::Result<u64> {
    Ok(sqlx::query(
        "INSERT INTO deck_version_checks (version_id, source, requested_at)
         SELECT current_version_id, ?, ? FROM decks WHERE archived = 0 AND current_version_id IS NOT NULL
         ON CONFLICT DO NOTHING",
    )
    .bind(SPELLBOOK)
    .bind(stamp())
    .execute(pool)
    .await?
    .rows_affected())
}

/// Run checks in the background for as long as the server runs.
pub fn spawn_worker(pool: SqlitePool, http: reqwest::Client, url: String) {
    tokio::spawn(async move {
        match backfill(&pool).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(n, "queued Commander Spellbook checks for decks saved before checks existed"),
            Err(e) => tracing::warn!(error = %e, "couldn't queue deck checks"),
        }
        let wake = WAKE.get_or_init(Notify::new);
        let mut last_request: Option<tokio::time::Instant> = None;
        loop {
            match next_pending(&pool).await {
                Ok(Next::Due(version)) => {
                    if let Some(t) = last_request {
                        tokio::time::sleep_until(t + MIN_GAP).await;
                    }
                    last_request = Some(tokio::time::Instant::now());
                    match run_one(&pool, &http, &url, &version).await {
                        Ok(()) => tracing::debug!(version, "checked a deck with Commander Spellbook"),
                        Err(CheckError::RateLimited(wait)) => {
                            tracing::warn!(secs = wait.as_secs(), "Commander Spellbook rate limit; pausing deck checks");
                            tokio::time::sleep(wait).await;
                        }
                        Err(e) => tracing::warn!(version, error = %e, "deck check failed"),
                    }
                }
                Ok(Next::Later(wait)) => {
                    let _ = tokio::time::timeout(wait.max(Duration::from_secs(1)), wake.notified()).await;
                }
                // Also look again now and then: the command line (import-decks) queues checks
                // from another process, which can't wake this one.
                Ok(Next::Idle) => {
                    let _ = tokio::time::timeout(IDLE_POLL, wake.notified()).await;
                }
                Err(e) => {
                    tracing::warn!(error = %e, "couldn't read the deck check queue");
                    tokio::time::sleep(Duration::from_secs(60)).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../tests/fixtures/spellbook-estimate-bracket.json");

    fn dc(oracle_id: &str, name: &str, board: Board) -> DeckCard {
        DeckCard { oracle_id: oracle_id.into(), name: name.into(), qty: 1, board }
    }

    fn rohan_sample() -> Vec<DeckCard> {
        vec![
            dc("98a2a642-a30a-43e7-b47f-4776c22d1cb0", "Éowyn, Shieldmaiden", Board::Commander),
            dc("0f5a3a09-2f07-4774-9e0f-e99d9a444166", "Aurelia, the Warleader", Board::Main),
            dc("27e83bae-0ffe-4cc7-a6c0-cbca25f2ba4e", "Gilraen, Dúnedain Protector", Board::Main),
            dc("53236dd7-845a-444c-96d5-f41ed7325d8f", "Rhystic Study", Board::Main),
            dc("6ad8011d-3471-4369-9d68-b264cc027487", "Sol Ring", Board::Main),
            dc("3aa83ed2-f48b-4ce6-a614-2c54ddf50538", "The One Ring", Board::Main),
            dc("00000000-0000-0000-0000-000000000001", "Brand New Card", Board::Main),
            dc("00000000-0000-0000-0000-000000000002", "Sideboard Card", Board::Side),
        ]
    }

    #[test]
    fn reads_a_real_spellbook_answer() {
        // Trimmed from Spellbook's answer for Riders of Rohan on 2026-10-19.
        let est: Estimate = serde_json::from_str(FIXTURE).unwrap();
        let r = summarize(est, &rohan_sample(), "2026-10-19T06:00:00.000Z");
        assert_eq!(r.bracket_tag, "R");
        assert_eq!((r.bracket_label, r.bracket), ("Ruthless", Some(4)));
        assert_eq!(r.game_changers, vec!["Rhystic Study", "The One Ring"]);
        assert!(r.mld.is_empty() && r.extra_turns.is_empty());
        // Spellbook skips cards it doesn't know; the sideboard was never sent.
        assert_eq!(r.unrecognized, vec!["Brand New Card"]);
        assert_eq!(r.combos.len(), 1);
        let c = &r.combos[0];
        assert_eq!(c.id, "847-4364");
        assert_eq!(c.cards, vec!["Aurelia, the Warleader", "Gilraen, Dúnedain Protector"]);
        assert!(c.two_card);
        assert!(c.results.iter().any(|x| x == "Infinite combat phases"));
        assert_eq!(c.bracket_tag.as_deref(), Some("S"));
    }

    #[test]
    fn tags_map_to_spellbooks_bracket_numbers() {
        let n = |t| bracket_of_tag(t).1;
        assert_eq!([n("E"), n("C"), n("O"), n("P"), n("S"), n("R"), n("B")], [Some(1), Some(2), Some(2), Some(3), Some(3), Some(4), None]);
    }

    #[test]
    fn request_sends_oracle_ids_without_the_sideboard() {
        let body = request_body(&rohan_sample());
        assert_eq!(body["commanders"], serde_json::json!([{ "card": "98a2a642-a30a-43e7-b47f-4776c22d1cb0", "quantity": 1 }]));
        assert_eq!(body["main"].as_array().unwrap().len(), 6);
        assert!(!body.to_string().contains("00000000-0000-0000-0000-000000000002"));
    }

    async fn user(pool: &SqlitePool) -> String {
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1', 'a@example.com', 'A', '2026-10-19T00:00:00Z')")
            .execute(pool)
            .await
            .unwrap();
        "u1".into()
    }

    async fn current_version(pool: &SqlitePool, deck: &str) -> String {
        sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(deck).fetch_one(pool).await.unwrap()
    }

    #[tokio::test]
    async fn saving_queues_a_check_and_superseded_versions_wait() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Rohan", None, rohan_sample()).await.unwrap();
        let v1 = current_version(&pool, &deck).await;
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Due(v) if v == v1));

        // A second save before the worker got to the first: only the new version is checked.
        crate::decks::insert_version(&pool, &deck, &rohan_sample()[..3], None).await.unwrap();
        let v2 = current_version(&pool, &deck).await;
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Due(v) if v == v2));

        let view = view(&pool, Some(&v2), true).await.unwrap();
        assert!(view.pending && view.result.is_none());
        // Off on this server: nothing is pending.
        assert!(!super::view(&pool, Some(&v2), false).await.unwrap().pending);
    }

    #[tokio::test]
    async fn failures_back_off_and_give_up() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Rohan", None, rohan_sample()).await.unwrap();
        let v = current_version(&pool, &deck).await;
        record_failure(&pool, &v, &stamp(), "no connection").await.unwrap();
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Later(d) if d > Duration::from_secs(50)));
        for _ in 1..MAX_ATTEMPTS {
            record_failure(&pool, &v, &stamp(), "no connection").await.unwrap();
        }
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Idle));
        let gave_up = view(&pool, Some(&v), true).await.unwrap();
        assert!(gave_up.gave_up && !gave_up.pending);
        assert_eq!(gave_up.error.as_deref(), Some("no connection"));

        // Asking again starts over.
        request_again(&pool, &v).await.unwrap();
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Due(_)));
    }

    async fn fake_spellbook(status: u16) -> String {
        use axum::{Router, http::StatusCode, routing::post};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/estimate-bracket", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/estimate-bracket",
            post(move |headers: axum::http::HeaderMap, body: String| async move {
                assert!(headers.get("user-agent").unwrap().to_str().unwrap().starts_with("Yama/"));
                assert!(body.contains("98a2a642-a30a-43e7-b47f-4776c22d1cb0"));
                let code = StatusCode::from_u16(status).unwrap();
                if code == StatusCode::TOO_MANY_REQUESTS {
                    return (code, [("retry-after", "120"), ("content-type", "text/plain")], String::new());
                }
                (code, [("retry-after", "0"), ("content-type", "application/json")], FIXTURE.to_string())
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        url
    }

    #[tokio::test]
    async fn worker_stores_answers_and_honours_rate_limits() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Rohan", None, rohan_sample()).await.unwrap();
        let v = current_version(&pool, &deck).await;
        let http = crate::routes::http_client();

        // 429: the wait Spellbook asks for, counted as a failed try.
        let url = fake_spellbook(429).await;
        match run_one(&pool, &http, &url, &v).await {
            Err(CheckError::RateLimited(d)) => assert_eq!(d, Duration::from_secs(120)),
            other => panic!("expected a rate limit, got {other:?}"),
        }
        assert!(view(&pool, Some(&v), true).await.unwrap().error.unwrap().contains("slow down"));

        // 200: stored, the error cleared, nothing pending.
        let url = fake_spellbook(200).await;
        run_one(&pool, &http, &url, &v).await.unwrap();
        let shown = view(&pool, Some(&v), true).await.unwrap();
        assert!(!shown.pending && shown.error.is_none());
        let r = shown.result.unwrap();
        assert_eq!(r.bracket, Some(4));
        assert_eq!(r.combos[0].id, "847-4364");
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Idle));
        let est = estimates(&pool, std::slice::from_ref(&v)).await.unwrap();
        assert_eq!(est[&v].label, "Ruthless");

        // "Check again" right after an answer is refused; the answer stays.
        assert!(matches!(request_again(&pool, &v).await, Err(AppError::Conflict(_))));

        // A failed re-check keeps the old answer and shows the error beside it.
        sqlx::query("UPDATE deck_version_checks SET checked_at = '2026-01-01T00:00:00.000Z'").execute(&pool).await.unwrap();
        request_again(&pool, &v).await.unwrap();
        let url = fake_spellbook(500).await;
        assert!(run_one(&pool, &http, &url, &v).await.is_err());
        let shown = view(&pool, Some(&v), true).await.unwrap();
        assert!(shown.pending && shown.result.is_some());
        assert!(shown.error.unwrap().contains("500"));
    }
}
