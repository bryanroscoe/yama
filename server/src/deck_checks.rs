//! Outside checks of deck versions: Commander Spellbook's bracket estimate, the cards it flags
//! (Game Changers, mass land denial, extra turns) and the combos it finds in the list.
//!
//! A check is queued when a version is saved (`decks::insert_version`) and run by one background
//! worker, so saving never waits on the network. An answer depends only on the list sent
//! ([`list_hash`]), so a version whose list was already answered (a save that changed only
//! printings, a reverted list, a precon many people have) reuses that answer without a request.
//! The worker sends one request at a time, paced with the research tools' requests to
//! Spellbook ([`Research::pace`], every 4 s), which keeps Yama far under Spellbook's guideline
//! of about 80 requests a minute; a 429 from either holds both off as long as Spellbook asks. Failures retry with growing
//! pauses and stop after [`MAX_ATTEMPTS`] until someone presses "check again". One account's
//! decks get at most [`PER_OWNER_HOUR`] checks an hour; the rest wait their turn, so nobody (with
//! open sign-up, a stranger saving deck after deck) can keep Spellbook busy on Yama's behalf or
//! hold up everyone else's checks.
//!
//! Spellbook's API guidelines (docs/api.md in SpaceCowMedia/commander-spellbook-backend, read
//! 2026-10-19): sparse unauthenticated requests, name the service in the User-Agent, handle
//! 429, credit and link to commanderspellbook.com. The card-list signals are theirs; Yama
//! interprets them as a dated starting suggestion, never replacing the owner's declared bracket.

use crate::decks::{Board, DeckCard, load_version_cards};
use crate::error::{AppError, AppResult};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;
use crate::mcp::research::client::{Provider, Research};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Notify;

/// `deck_version_checks.source` for Commander Spellbook.
pub const SPELLBOOK: &str = "commander_spellbook";
pub const SPELLBOOK_ESTIMATE_URL: &str = "https://backend.commanderspellbook.com/estimate-bracket";
pub const SPELLBOOK_SITE: &str = "https://commanderspellbook.com/";

/// How old an answer for the same list may be and still be reused when a version is saved.
/// "Check again" asks for a newer one.
const REUSE_DAYS: i64 = 14;
/// Failed tries before the worker gives up on a version until it's requested again.
pub const MAX_ATTEMPTS: i64 = 6;
/// Pause before try n+1 after n failures.
const BACKOFF_SECS: [i64; 6] = [0, 60, 5 * 60, 30 * 60, 2 * 3600, 12 * 3600];
/// How often an idle worker looks for checks queued by another process.
const IDLE_POLL: Duration = Duration::from_secs(10 * 60);
/// Checks one account's decks may have in an hour (counted by the last try of each version).
pub const PER_OWNER_HOUR: i64 = 20;
/// How long the worker waits before looking again when every due check is held by that limit.
const OWNER_WAIT: Duration = Duration::from_secs(5 * 60);
/// "Check again" is refused this soon after an answer, so a button can't hammer Spellbook.
pub const RECHECK_AFTER_SECS: i64 = 10 * 60;
/// …and this soon after a failed try, so pressing it while retries wait out a pause still
/// sends at most one request a minute.
pub const RETRY_GUARD_SECS: i64 = 60;

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

/// What decides a check's answer: the commander and main cards sent ([`request_body`]), each
/// oracle id with its quantity and board, in order. Printings and the sideboard don't count.
pub fn list_hash(cards: &[DeckCard]) -> String {
    use sha2::Digest;
    let mut lines: Vec<String> = cards
        .iter()
        .filter(|c| c.board != Board::Side && c.qty > 0)
        .map(|c| format!("{}\t{}\t{}", c.oracle_id, c.qty, if c.board == Board::Commander { "commander" } else { "main" }))
        .collect();
    lines.sort();
    hex::encode(sha2::Sha256::digest(lines.join("\n").as_bytes()))
}

/// Queue a check of a new version with its `cards`, or give it the answer for the same list
/// from the last [`REUSE_DAYS`] days (with no try of its own, so it doesn't count toward the
/// owner's [`PER_OWNER_HOUR`]). Does nothing if it's already queued or checked.
pub async fn queue(conn: &mut sqlx::SqliteConnection, version_id: &str, cards: &[DeckCard]) -> sqlx::Result<()> {
    let hash = list_hash(cards);
    let requested = stamp();
    let queued = sqlx::query("INSERT INTO deck_version_checks (version_id, source, requested_at, list_hash) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
        .bind(version_id)
        .bind(SPELLBOOK)
        .bind(&requested)
        .bind(&hash)
        .execute(&mut *conn)
        .await?;
    if queued.rows_affected() > 0 {
        reuse(conn, version_id, cards, &hash, &stamp_of(Utc::now() - chrono::Duration::days(REUSE_DAYS)), &requested).await?;
    }
    Ok(())
}

/// Give `version_id`'s check Spellbook's answer for the same list, if one came back since
/// `since`, summarized against this version's own `cards`: the names shown come from this deck
/// or from Spellbook, never from whichever deck asked first (another account's included). The
/// row is answered, not pending, and records no try of its own. Only while the row's request is
/// still `requested`: a "Check again" that came in meanwhile wants a newer answer, and keeps
/// waiting for it. True if it took one.
async fn reuse(conn: &mut sqlx::SqliteConnection, version_id: &str, cards: &[DeckCard], hash: &str, since: &str, requested: &str) -> sqlx::Result<bool> {
    let source: Option<(String, String)> = sqlx::query_as(
        "SELECT estimate, checked_at FROM deck_version_checks
          WHERE source = ? AND list_hash = ? AND version_id != ? AND estimate IS NOT NULL AND checked_at >= ?
          ORDER BY checked_at DESC LIMIT 1",
    )
    .bind(SPELLBOOK)
    .bind(hash)
    .bind(version_id)
    .bind(since)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((raw, at)) = source else { return Ok(false) };
    let Ok(est) = serde_json::from_str::<Estimate>(&raw) else { return Ok(false) };
    let r = summarize(est, cards, &at);
    let done = sqlx::query(
        "UPDATE deck_version_checks SET requested_at = MIN(requested_at, ?), checked_at = ?, bracket_tag = ?, game_changers = ?, mld = ?,
            extra_turns = ?, combos = ?, unrecognized = ?, estimate = ?, list_hash = ?, attempts = 0, error = NULL
         WHERE version_id = ? AND source = ? AND requested_at = ?",
    )
    .bind(&r.checked_at)
    .bind(&r.checked_at)
    .bind(&r.bracket_tag)
    .bind(json(&r.game_changers))
    .bind(json(&r.mld))
    .bind(json(&r.extra_turns))
    .bind(json(&r.combos))
    .bind(json(&r.unrecognized))
    .bind(&raw)
    .bind(hash)
    .bind(version_id)
    .bind(SPELLBOOK)
    .bind(requested)
    .execute(&mut *conn)
    .await?;
    Ok(done.rows_affected() > 0)
}

/// For the worker: a pending check takes the answer for the same list if one came back since it
/// was requested (identical lists queued together, or checked again elsewhere). True if it did.
async fn reuse_answer(pool: &SqlitePool, version_id: &str, cards: &[DeckCard], hash: &str) -> sqlx::Result<bool> {
    let mut conn = pool.acquire().await?;
    let requested: Option<String> = sqlx::query_scalar("SELECT requested_at FROM deck_version_checks WHERE version_id = ? AND source = ?")
        .bind(version_id)
        .bind(SPELLBOOK)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(requested) = requested else { return Ok(false) };
    if reuse(&mut conn, version_id, cards, hash, &requested, &requested).await? {
        return Ok(true);
    }
    sqlx::query("UPDATE deck_version_checks SET list_hash = ? WHERE version_id = ? AND source = ?")
        .bind(hash)
        .bind(version_id)
        .bind(SPELLBOOK)
        .execute(&mut *conn)
        .await?;
    Ok(false)
}

/// Ask for a fresh check of a version that may have been checked before (outside data changes:
/// new combos, Game Changer list updates). The old answer stays until the new one arrives.
/// Refused within [`RECHECK_AFTER_SECS`] of the last answer or [`RETRY_GUARD_SECS`] of a failed
/// try, and for anything the worker wouldn't run: an archived deck, or a version that isn't its
/// deck's current one.
pub async fn request_again(pool: &SqlitePool, version_id: &str) -> AppResult<()> {
    match deck_state(pool, version_id).await? {
        DeckState::Live => {}
        DeckState::Archived => return Err(AppError::Conflict("the deck is archived, so it isn't checked".into())),
        DeckState::Superseded => return Err(AppError::Conflict("only a deck's current version is checked".into())),
    }
    let row: Option<(Option<String>, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT checked_at, requested_at, attempts, last_attempt_at FROM deck_version_checks WHERE version_id = ? AND source = ?",
    )
    .bind(version_id)
    .bind(SPELLBOOK)
    .fetch_optional(pool)
    .await?;
    let now = Utc::now();
    let too_soon = |at: Option<&str>, guard: i64, what: &str| -> AppResult<()> {
        let Some(age) = at.and_then(parse_stamp).map(|t| (now - t).num_seconds()) else { return Ok(()) };
        if age >= guard {
            return Ok(());
        }
        let wait = (guard - age + 59) / 60;
        Err(AppError::Conflict(format!(
            "{what} {} ago; try again in {wait} {}",
            ago(age),
            if wait == 1 { "minute" } else { "minutes" }
        )))
    };
    if let Some((checked_at, requested_at, attempts, last_attempt_at)) = &row {
        too_soon(checked_at.as_deref(), RECHECK_AFTER_SECS, "checked")?;
        let waiting = checked_at.as_ref().is_none_or(|c| c < requested_at);
        if waiting && *attempts > 0 {
            too_soon(last_attempt_at.as_deref(), RETRY_GUARD_SECS, "tried")?;
        }
    }
    sqlx::query(
        "INSERT INTO deck_version_checks (version_id, source, requested_at) VALUES (?, ?, ?)
         ON CONFLICT DO UPDATE SET requested_at = excluded.requested_at, attempts = 0, error = NULL",
    )
    .bind(version_id)
    .bind(SPELLBOOK)
    .bind(stamp_of(now))
    .execute(pool)
    .await?;
    wake();
    Ok(())
}

/// Whether the worker runs checks of a version: only a live deck's current version.
#[derive(Debug, PartialEq)]
enum DeckState {
    Live,
    Archived,
    /// Not the current version of any deck (a later save replaced it).
    Superseded,
}

async fn deck_state(pool: &SqlitePool, version_id: &str) -> sqlx::Result<DeckState> {
    let archived: Option<i64> = sqlx::query_scalar("SELECT archived FROM decks WHERE current_version_id = ?")
        .bind(version_id)
        .fetch_optional(pool)
        .await?;
    Ok(match archived {
        Some(0) => DeckState::Live,
        Some(_) => DeckState::Archived,
        None => DeckState::Superseded,
    })
}

/// When a waiting check's next try falls due: right away for a fresh request (no failures
/// since it), else the last failed try plus the pause for that many failures.
fn due_at(attempts: i64, last_attempt_at: Option<&str>, now: DateTime<Utc>) -> DateTime<Utc> {
    if attempts <= 0 {
        return now;
    }
    let wait = BACKOFF_SECS[attempts.clamp(0, MAX_ATTEMPTS - 1) as usize];
    last_attempt_at.and_then(parse_stamp).map_or(now, |t| t + chrono::Duration::seconds(wait))
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
    /// A try is due now or running, so an answer (or an error) comes within seconds.
    pub pending: bool,
    /// The last try failed and the next one waits until `next_try_at`.
    pub retrying: bool,
    /// RFC 3339; set while `retrying`.
    pub next_try_at: Option<String>,
    /// The last try failed (kept until one succeeds).
    pub error: Option<String>,
    /// Tries have stopped until someone asks again.
    pub gave_up: bool,
    /// The deck is archived, so its checks don't run.
    pub archived: bool,
    pub requested_at: Option<String>,
    /// The newest answer, if any; it can be older than a pending re-check.
    pub result: Option<CheckResult>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct CheckResult {
    /// When the request that got this answer was sent.
    pub checked_at: String,
    /// Spellbook's tag: E C O P S R, or B when a card is banned. Kept as sent, so a tag Yama
    /// doesn't know yet reads as unknown rather than as anything else.
    pub bracket_tag: String,
    pub bracket_label: &'static str,
    /// Yama's starting suggestion: E defaults to Core (2), never automatic Exhibition.
    /// Other known tags keep Spellbook's number; `None` for B and unknown tags.
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
    /// Spellbook's own count (`definitelyTwoCard`): at most two pieces, counting templates, a
    /// notable prerequisite and a result that matters only in context as pieces, and leaving
    /// the commander out because it's always available.
    #[serde(default)]
    pub definitely_two_card: bool,
    /// Spellbook's `arguablyTwoCard`: at most two cards, plus at most one of those extras.
    #[serde(default)]
    pub arguably_two_card: bool,
    #[serde(default)]
    pub mana_needed: Option<String>,
    /// Plain-language reasons this combo matters for brackets ("extra turns", "lock").
    #[serde(default)]
    pub flags: Vec<String>,
    /// Spellbook's bracket tag for the combo on its own.
    #[serde(default)]
    pub bracket_tag: Option<String>,
}

/// Yama's starting suggestion from Spellbook's card-list signals. E is its fallback when no
/// higher signal matches, not evidence of theme-over-power intent: suggest Core provisionally.
/// Keep the raw tag for attribution. This mapping is applied on reads too, so stored answers
/// are corrected without a new third-party request or a database rewrite.
pub fn bracket_of_tag(tag: &str) -> (&'static str, Option<i64>) {
    match tag {
        "E" => ("Core starting point", Some(2)),
        "C" => ("Core", Some(2)),
        "O" => ("Oddball", Some(2)),
        "P" => ("Powerful", Some(3)),
        "S" => ("Spicy", Some(3)),
        "R" => ("Ruthless", Some(4)),
        "B" => ("Banned card", None),
        _ => ("Unknown tag", None),
    }
}

/// Whether [`bracket_of_tag`] knows a tag. A new tag from Spellbook is stored as sent and shown
/// as unknown (never as banned) until Yama learns it.
pub fn is_known_tag(tag: &str) -> bool {
    matches!(tag, "E" | "C" | "O" | "P" | "S" | "R" | "B")
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
    #[serde(default)]
    definitely_two_card: bool,
    #[serde(default)]
    arguably_two_card: bool,
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
                // Spellbook's own classification, not a recount: it weighs prerequisites and the
                // commander, which the card list alone doesn't show.
                definitely_two_card: c.definitely_two_card,
                arguably_two_card: c.arguably_two_card || c.definitely_two_card,
                cards,
                templates,
                results: v.produces.iter().map(|p| p.feature.name.clone()).collect(),
                mana_needed: v.mana_needed.clone().filter(|m| !m.is_empty()),
                flags,
                bracket_tag: v.bracket_tag.clone(),
            }
        })
        .collect();
    // Two-card combos first, then arguably two-card, then by their cards, so the order is
    // stable between checks.
    combos.sort_by(|a, b| {
        (b.definitely_two_card, b.arguably_two_card).cmp(&(a.definitely_two_card, a.arguably_two_card)).then_with(|| a.cards.cmp(&b.cards))
    });

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
    last_attempt_at: Option<String>,
    error: Option<String>,
}

const ROW_COLUMNS: &str =
    "requested_at, checked_at, bracket_tag, game_changers, mld, extra_turns, combos, unrecognized, attempts, last_attempt_at, error";

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
///
/// `pending` only while a try is due or running, so the page can poll briefly; while failed
/// tries wait out their pause it's `retrying` with `next_try_at` instead, and the error shows.
pub async fn view(pool: &SqlitePool, version_id: Option<&str>, enabled: bool) -> AppResult<CheckView> {
    let (row, state): (Option<Row>, DeckState) = match version_id {
        Some(v) => (
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT {ROW_COLUMNS} FROM deck_version_checks WHERE version_id = ? AND source = ?"
            )))
            .bind(v)
            .bind(SPELLBOOK)
            .fetch_optional(pool)
            .await?,
            deck_state(pool, v).await?,
        ),
        None => (None, DeckState::Superseded),
    };
    let gave_up = row.as_ref().is_some_and(|r| r.waiting() && r.attempts >= MAX_ATTEMPTS);
    // The worker only runs a live deck's current version (see `next_pending`).
    let runs = enabled && state == DeckState::Live;
    let now = Utc::now();
    let due = row
        .as_ref()
        .filter(|r| runs && r.waiting() && r.attempts < MAX_ATTEMPTS)
        .map(|r| due_at(r.attempts, r.last_attempt_at.as_deref(), now));
    let retrying = due.is_some_and(|d| d > now);
    Ok(CheckView {
        enabled,
        version_id: version_id.map(str::to_string),
        source: "Commander Spellbook",
        source_url: SPELLBOOK_SITE,
        pending: due.is_some_and(|d| d <= now),
        retrying,
        next_try_at: due.filter(|_| retrying).map(stamp_of),
        error: row.as_ref().and_then(|r| r.error.clone()),
        gave_up,
        archived: state == DeckState::Archived,
        requested_at: row.as_ref().map(|r| r.requested_at.clone()),
        result: row.as_ref().and_then(Row::result),
    })
}

#[derive(sqlx::FromRow)]
struct VersionRow {
    version_id: String,
    #[sqlx(flatten)]
    row: Row,
}

/// The stored answers of many versions in one query, by version id: what each check found,
/// without the polling state [`view`] works out for the deck page.
pub async fn results(pool: &SqlitePool, version_ids: &[String]) -> sqlx::Result<HashMap<String, CheckResult>> {
    if version_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<VersionRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT version_id, {ROW_COLUMNS} FROM deck_version_checks WHERE source = ? AND version_id IN (SELECT value FROM json_each(?))"
    )))
    .bind(SPELLBOOK)
    .bind(serde_json::to_string(version_ids).unwrap_or_default())
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().filter_map(|r| Some((r.version_id, r.row.result()?))).collect())
}

/// The newest stored answer for exactly this list, summarized with these cards' names. For the
/// measuring command (analysis/eval.rs), whose lists are files and not saved decks; like
/// [`reuse`], it reads only what Spellbook said about the same cards.
pub async fn stored_for_list(pool: &SqlitePool, cards: &[DeckCard]) -> sqlx::Result<Option<CheckResult>> {
    let source: Option<(String, String)> =
        sqlx::query_as("SELECT estimate, checked_at FROM deck_version_checks WHERE source = ? AND list_hash = ? AND estimate IS NOT NULL ORDER BY checked_at DESC LIMIT 1")
            .bind(SPELLBOOK)
            .bind(list_hash(cards))
            .fetch_optional(pool)
            .await?;
    Ok(source.and_then(|(raw, at)| Some(summarize(serde_json::from_str::<Estimate>(&raw).ok()?, cards, &at))))
}

/// The estimated bracket of each version that has an answer: version id → (tag, bracket).
pub async fn estimates(pool: &SqlitePool, version_ids: &[String]) -> sqlx::Result<HashMap<String, Estimated>> {
    if version_ids.is_empty() {
        return Ok(HashMap::new());
    }
    // One query for every version, however many decks.
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT version_id, bracket_tag, checked_at FROM deck_version_checks
          WHERE source = ? AND bracket_tag IS NOT NULL AND version_id IN (SELECT value FROM json_each(?))",
    )
    .bind(SPELLBOOK)
    .bind(serde_json::to_string(version_ids).unwrap_or_default())
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(v, tag, checked_at)| {
            let (label, bracket) = bracket_of_tag(&tag);
            (v, Estimated { tag, label, bracket, checked_at })
        })
        .collect())
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
/// replaced them before their turn came), as do archived decks, and the decks of an account that
/// has had [`PER_OWNER_HOUR`] checks in the last hour.
async fn next_pending(pool: &SqlitePool) -> sqlx::Result<Next> {
    let rows: Vec<(String, String, i64, Option<String>, String)> = sqlx::query_as(
        "SELECT c.version_id, c.requested_at, c.attempts, c.last_attempt_at, d.owner_id FROM deck_version_checks c
         JOIN decks d ON d.current_version_id = c.version_id AND d.archived = 0
         WHERE c.source = ? AND (c.checked_at IS NULL OR c.checked_at < c.requested_at) AND c.attempts < ?
         ORDER BY c.requested_at",
    )
    .bind(SPELLBOOK)
    .bind(MAX_ATTEMPTS)
    .fetch_all(pool)
    .await?;
    let now = Utc::now();
    let busy: HashMap<String, i64> = if rows.is_empty() {
        HashMap::new()
    } else {
        sqlx::query_as::<_, (String, i64)>(
            "SELECT d.owner_id, COUNT(*) FROM deck_version_checks c JOIN deck_versions v ON v.id = c.version_id JOIN decks d ON d.id = v.deck_id
             WHERE c.source = ? AND c.last_attempt_at > ? GROUP BY d.owner_id",
        )
        .bind(SPELLBOOK)
        .bind(stamp_of(now - chrono::Duration::hours(1)))
        .fetch_all(pool)
        .await?
        .into_iter()
        .collect()
    };
    let mut soonest: Option<Duration> = None;
    for (version, _, attempts, last, owner) in rows {
        if busy.get(&owner).is_some_and(|n| *n >= PER_OWNER_HOUR) {
            soonest = Some(soonest.map_or(OWNER_WAIT, |s| s.min(OWNER_WAIT)));
            continue;
        }
        let due = due_at(attempts, last.as_deref(), now);
        if due <= now {
            return Ok(Next::Due(version));
        }
        let left = (due - now).to_std().unwrap_or_default();
        soonest = Some(soonest.map_or(left, |s| s.min(left)));
    }
    Ok(soonest.map_or(Next::Idle, Next::Later))
}

/// Check one version against Spellbook and store the answer (or the failure). With `pacer`,
/// the request waits for Spellbook's shared turn and a 429 holds everyone off.
pub async fn run_one(pool: &SqlitePool, http: &reqwest::Client, url: &str, version_id: &str, pacer: Option<&Research>) -> Result<(), CheckError> {
    let cards = load_version_cards(pool, version_id).await.map_err(|e| CheckError::Failed(format!("couldn't read the deck: {e}")))?;
    let reused = reuse_answer(pool, version_id, &cards, &list_hash(&cards)).await.map_err(|e| CheckError::Failed(format!("couldn't read the checks: {e}")))?;
    if reused {
        return Ok(());
    }
    if let Some(pacer) = pacer {
        pacer.pace(Provider::Spellbook).await;
        // The wait can be long (a 429 holds every Spellbook request off): the deck may have been
        // saved again or archived meanwhile, or the same list answered elsewhere.
        let failed = |e: sqlx::Error| CheckError::Failed(format!("couldn't read the checks: {e}"));
        if !still_wanted(pool, version_id).await.map_err(failed)? || reuse_answer(pool, version_id, &cards, &list_hash(&cards)).await.map_err(failed)? {
            return Ok(());
        }
    }
    let started = stamp();
    let outcome = fetch(http, url, &cards, version_id, &started).await;
    if let (Some(pacer), Err(CheckError::RateLimited(wait))) = (pacer, &outcome) {
        pacer.hold_off(Provider::Spellbook, *wait);
    }
    let stored = match &outcome {
        Ok((result, raw)) => store(pool, version_id, result, Some(raw)).await,
        Err(e) => record_failure(pool, version_id, &started, &e.to_string()).await,
    };
    if let Err(e) = stored {
        tracing::warn!(error = %e, version_id, "couldn't save a deck check");
    }
    outcome.map(|_| ())
}

/// Whether a check still needs an answer: its deck is live, this is its current version, and
/// no answer has come since it was requested.
async fn still_wanted(pool: &SqlitePool, version_id: &str) -> sqlx::Result<bool> {
    if !matches!(deck_state(pool, version_id).await?, DeckState::Live) {
        return Ok(false);
    }
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM deck_version_checks WHERE version_id = ? AND source = ? AND (checked_at IS NULL OR checked_at < requested_at))",
    )
    .bind(version_id)
    .bind(SPELLBOOK)
    .fetch_one(pool)
    .await
}

/// Spellbook's answer for `cards`, summarized, with the answer as sent (kept, so the same list
/// elsewhere can be summarized from it).
async fn fetch(http: &reqwest::Client, url: &str, cards: &[DeckCard], version_id: &str, started: &str) -> Result<(CheckResult, String), CheckError> {
    if !cards.iter().any(|c| c.board != Board::Side) {
        return Err(CheckError::Failed("the deck has no cards to check".into()));
    }
    let res = http
        .post(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&request_body(cards))
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
            .map(|v| crate::mcp::research::client::retry_after(v.trim()))
            .unwrap_or(60)
            .clamp(10, 3600);
        return Err(CheckError::RateLimited(Duration::from_secs(secs)));
    }
    if !status.is_success() {
        return Err(CheckError::Failed(format!("Commander Spellbook answered {status}")));
    }
    let raw = res
        .text()
        .await
        .map_err(|e| CheckError::Failed(format!("Commander Spellbook's answer didn't read as expected ({})", short_error(&e))))?;
    let est: Estimate = serde_json::from_str(&raw)
        .map_err(|_| CheckError::Failed("Commander Spellbook's answer didn't read as expected (unexpected data)".into()))?;
    if !is_known_tag(&est.bracket_tag) {
        tracing::warn!(tag = %est.bracket_tag, version_id, "Commander Spellbook sent a bracket tag Yama doesn't know; shown as unknown");
    }
    Ok((summarize(est, cards, started), raw))
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

async fn store(pool: &SqlitePool, version_id: &str, r: &CheckResult, raw: Option<&str>) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE deck_version_checks SET checked_at = ?, bracket_tag = ?, game_changers = ?, mld = ?, extra_turns = ?,
            combos = ?, unrecognized = ?, attempts = 0, last_attempt_at = ?, error = NULL, estimate = ?
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
    .bind(raw)
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

/// Run checks in the background for as long as the server runs, pacing Spellbook with
/// `research`.
pub fn spawn_worker(pool: SqlitePool, http: reqwest::Client, url: String, research: Arc<Research>) {
    tokio::spawn(async move {
        match backfill(&pool).await {
            Ok(0) => {}
            Ok(n) => tracing::info!(n, "queued Commander Spellbook checks for decks saved before checks existed"),
            Err(e) => tracing::warn!(error = %e, "couldn't queue deck checks"),
        }
        let wake = WAKE.get_or_init(Notify::new);
        loop {
            match next_pending(&pool).await {
                Ok(Next::Due(version)) => {
                    let job = crate::perf::Job::start("deck check", Duration::from_secs(30));
                    let result = run_one(&pool, &http, &url, &version, Some(&research)).await;
                    job.finish(&result, "Commander Spellbook");
                    match result {
                        Ok(()) => tracing::debug!(version, "checked a deck with Commander Spellbook"),
                        // The shared pacer now holds every Spellbook request off that long.
                        Err(CheckError::RateLimited(wait)) => {
                            tracing::warn!(secs = wait.as_secs(), "Commander Spellbook rate limit; pausing deck checks and research");
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
        // Two cards, but Spellbook counts its notable prerequisites (creatures that tap for {2},
        // Gilraen without summoning sickness): arguably two-card, not definitely.
        assert!(!c.definitely_two_card && c.arguably_two_card);
        assert!(c.results.iter().any(|x| x == "Infinite combat phases"));
        assert_eq!(c.bracket_tag.as_deref(), Some("S"));
    }

    #[test]
    fn two_card_follows_spellbooks_classification() {
        // Spellbook leaves the commander out of the count: commander plus two cards from the 99
        // is definitely two-card, though three cards are named.
        let mut raw: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        let combo = &mut raw["combos"][0];
        combo["definitelyTwoCard"] = true.into();
        combo["arguablyTwoCard"] = true.into();
        combo["combo"]["uses"].as_array_mut().unwrap().push(serde_json::json!({
            "card": { "name": "Éowyn, Shieldmaiden", "oracleId": "98a2a642-a30a-43e7-b47f-4776c22d1cb0" },
            "quantity": 1
        }));
        // A second combo of exactly two cards that Spellbook doesn't call two-card at all.
        let mut other = raw["combos"][0].clone();
        other["combo"]["id"] = "1-2".into();
        other["definitelyTwoCard"] = false.into();
        other["arguablyTwoCard"] = false.into();
        other["combo"]["uses"].as_array_mut().unwrap().truncate(2);
        raw["combos"].as_array_mut().unwrap().insert(0, other);

        let est: Estimate = serde_json::from_value(raw).unwrap();
        let r = summarize(est, &rohan_sample(), "2026-10-19T06:00:00.000Z");
        assert_eq!(r.combos.len(), 2);
        assert_eq!((r.combos[0].id.as_str(), r.combos[0].definitely_two_card, r.combos[0].cards.len()), ("847-4364", true, 3));
        assert!(r.combos[0].arguably_two_card);
        assert_eq!((r.combos[1].id.as_str(), r.combos[1].definitely_two_card, r.combos[1].arguably_two_card), ("1-2", false, false));

        // Answers stored before these fields existed read as neither.
        let old: Combo = serde_json::from_str(r#"{"id":"x","cards":["A","B"],"results":[],"two_card":true}"#).unwrap();
        assert!(!old.definitely_two_card && !old.arguably_two_card);
    }

    #[test]
    fn tags_suggest_core_instead_of_automatically_assigning_exhibition() {
        let n = |t| bracket_of_tag(t).1;
        assert_eq!([n("E"), n("C"), n("O"), n("P"), n("S"), n("R"), n("B")], [Some(2), Some(2), Some(2), Some(3), Some(3), Some(4), None]);
        assert_eq!(bracket_of_tag("E"), ("Core starting point", Some(2)));
        let r = summarize(serde_json::from_value(serde_json::json!({"bracketTag": "E"})).unwrap(), &rohan_sample(), "2026-10-25T00:00:00.000Z");
        assert_eq!((r.bracket_tag.as_str(), r.bracket_label, r.bracket), ("E", "Core starting point", Some(2)));
        // A tag Yama doesn't know isn't "banned": it keeps its own label, and the tag as sent.
        assert_eq!(bracket_of_tag("X"), ("Unknown tag", None));
        assert!(is_known_tag("B") && !is_known_tag("X"));
        let mut raw: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        raw["bracketTag"] = "X".into();
        let r = summarize(serde_json::from_value(raw).unwrap(), &rohan_sample(), "2026-10-19T06:00:00.000Z");
        assert_eq!((r.bracket_tag.as_str(), r.bracket_label, r.bracket), ("X", "Unknown tag", None));
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
    async fn stored_exhibition_tags_read_as_core_without_changing_the_declared_bracket() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Unflagged precon", None, rohan_sample()).await.unwrap();
        let v = current_version(&pool, &deck).await;
        // Model an answer stored by the old server; no new Spellbook request is made.
        sqlx::query("UPDATE deck_version_checks SET bracket_tag = 'E', checked_at = '2026-10-25T00:00:00.000Z' WHERE version_id = ?")
            .bind(&v).execute(&pool).await.unwrap();
        sqlx::query("UPDATE decks SET bracket = 1 WHERE id = ?").bind(&deck).execute(&pool).await.unwrap();
        let result = view(&pool, Some(&v), true).await.unwrap().result.unwrap();
        assert_eq!((result.bracket_tag.as_str(), result.bracket), ("E", Some(2)));
        let chips = estimates(&pool, &[v.clone()]).await.unwrap();
        assert_eq!(chips[&v].bracket, Some(2));
        let declared: Option<i64> = sqlx::query_scalar("SELECT bracket FROM decks WHERE id = ?").bind(&deck).fetch_one(&pool).await.unwrap();
        assert_eq!(declared, Some(1));
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
        // While the pause runs: not pending (the page stops polling every few seconds), but
        // retrying at a stated time, with the error to show.
        let waiting = view(&pool, Some(&v), true).await.unwrap();
        assert!(!waiting.pending && waiting.retrying && !waiting.gave_up);
        let next = parse_stamp(waiting.next_try_at.as_deref().unwrap()).unwrap();
        assert!((next - Utc::now()).num_seconds() > 50);
        assert_eq!(waiting.error.as_deref(), Some("no connection"));
        // "Check again" right after a failed try is refused too.
        assert!(matches!(request_again(&pool, &v).await, Err(AppError::Conflict(m)) if m.starts_with("tried")));
        // Once the pause is over the try is due again: pending, no longer retrying.
        sqlx::query("UPDATE deck_version_checks SET last_attempt_at = '2026-01-01T00:00:00.000Z'").execute(&pool).await.unwrap();
        let due = view(&pool, Some(&v), true).await.unwrap();
        assert!(due.pending && !due.retrying && due.next_try_at.is_none());

        for _ in 1..MAX_ATTEMPTS {
            record_failure(&pool, &v, &stamp(), "no connection").await.unwrap();
        }
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Idle));
        let gave_up = view(&pool, Some(&v), true).await.unwrap();
        assert!(gave_up.gave_up && !gave_up.pending && !gave_up.retrying);
        assert_eq!(gave_up.error.as_deref(), Some("no connection"));

        // Asking again starts over (once a minute has passed since the last try).
        sqlx::query("UPDATE deck_version_checks SET last_attempt_at = '2026-01-01T00:00:00.000Z'").execute(&pool).await.unwrap();
        request_again(&pool, &v).await.unwrap();
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Due(_)));
    }

    #[tokio::test]
    async fn one_account_gets_at_most_twenty_checks_an_hour() {
        let pool = crate::db::test_pool().await;
        let busy = user(&pool).await;
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u2', 'b@example.com', 'B', '2026-10-19T00:00:00Z')")
            .execute(&pool)
            .await
            .unwrap();
        // u1 saves 21 decks; 20 of them were checked in the last few minutes.
        let mut versions = Vec::new();
        for i in 0..=PER_OWNER_HOUR {
            let deck = crate::decks::create_deck_with_cards(&pool, &busy, &format!("Deck {i}"), None, rohan_sample()).await.unwrap();
            versions.push(current_version(&pool, &deck).await);
        }
        for v in &versions[..PER_OWNER_HOUR as usize] {
            store(&pool, v, &summarize(serde_json::from_value(serde_json::json!({"bracketTag": "C"})).unwrap(), &rohan_sample(), &stamp()), None).await.unwrap();
        }
        // u1's 21st waits, even though it was queued before u2's deck (another list: the same one
        // would take u1's answer at once)...
        let mut list = rohan_sample();
        list.iter_mut().find(|c| c.board == Board::Main).expect("a main card").qty += 1;
        let theirs = crate::decks::create_deck_with_cards(&pool, "u2", "B's deck", None, list).await.unwrap();
        let theirs = current_version(&pool, &theirs).await;
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Due(v) if v == theirs));
        // ...and with nothing else due the worker looks again in a few minutes.
        store(&pool, &theirs, &summarize(serde_json::from_value(serde_json::json!({"bracketTag": "C"})).unwrap(), &rohan_sample(), &stamp()), None).await.unwrap();
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Later(d) if d == OWNER_WAIT));
        // An hour on, it goes.
        sqlx::query("UPDATE deck_version_checks SET last_attempt_at = '2026-01-01T00:00:00.000Z'").execute(&pool).await.unwrap();
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Due(v) if v == versions[PER_OWNER_HOUR as usize]));
    }

    #[tokio::test]
    async fn archived_decks_are_not_checked_or_shown_as_pending() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Old deck", None, rohan_sample()).await.unwrap();
        let v = current_version(&pool, &deck).await;
        sqlx::query("UPDATE decks SET archived = 1 WHERE id = ?").bind(&deck).execute(&pool).await.unwrap();

        // Queued before it was archived: the worker skips it, so the page doesn't wait for it.
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Idle));
        let shown = view(&pool, Some(&v), true).await.unwrap();
        assert!(shown.archived && !shown.pending && !shown.retrying);

        // Answered long ago, then archived: "check again" is refused rather than queued for
        // nobody (the deck page still opens from a bookmark).
        sqlx::query("UPDATE deck_version_checks SET checked_at = '2026-01-01T00:00:00.000Z', bracket_tag = 'C'").execute(&pool).await.unwrap();
        assert!(matches!(request_again(&pool, &v).await, Err(AppError::Conflict(m)) if m.contains("archived")));
        let shown = view(&pool, Some(&v), true).await.unwrap();
        assert!(!shown.pending && shown.result.is_some());
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

    #[test]
    fn a_lists_hash_is_its_commander_and_main_cards_in_any_order() {
        let card = |id: &str, qty, board| DeckCard { oracle_id: id.into(), name: id.into(), qty, board };
        let a = vec![card("c", 1, Board::Commander), card("x", 1, Board::Main), card("y", 2, Board::Main)];
        let mut b = vec![card("y", 2, Board::Main), card("x", 1, Board::Main), card("c", 1, Board::Commander), card("s", 1, Board::Side)];
        assert_eq!(list_hash(&a), list_hash(&b));
        b[0].qty = 3;
        assert_ne!(list_hash(&a), list_hash(&b));
        assert_ne!(list_hash(&a), list_hash(&[card("c", 1, Board::Main), card("x", 1, Board::Main), card("y", 2, Board::Main)]));
    }

    #[tokio::test]
    async fn the_same_list_reuses_its_answer_instead_of_asking_again() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        // The first deck's card names are ones its owner typed.
        let typed: Vec<DeckCard> = rohan_sample().into_iter().map(|mut c| {
            c.name = format!("PRIVATE {}", c.name);
            c
        }).collect();
        let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Rohan", None, typed).await.unwrap();
        let v1 = current_version(&pool, &deck).await;
        let http = crate::routes::http_client();
        run_one(&pool, &http, &fake_spellbook(200).await, &v1, None).await.unwrap();
        let mine = serde_json::to_string(&view(&pool, Some(&v1), true).await.unwrap().result).unwrap();
        assert!(mine.contains("PRIVATE"), "the answer shows the deck's own names: {mine}");
        // Saved again with the same cards (a new printing changes no oracle card): answered at
        // once, nothing queued, and no try counted toward the owner's hour.
        let cards = load_version_cards(&pool, &v1).await.unwrap();
        let v2 = crate::decks::insert_version(&pool, &deck, &cards, Some("new printing")).await.unwrap();
        let shown = view(&pool, Some(&v2), true).await.unwrap();
        assert!(!shown.pending && shown.result.is_some());
        assert!(matches!(next_pending(&pool).await.unwrap(), Next::Idle));
        let tried: Option<String> = sqlx::query_scalar("SELECT last_attempt_at FROM deck_version_checks WHERE version_id = ?").bind(&v2).fetch_one(&pool).await.unwrap();
        assert_eq!(tried, None);

        // Another account with the same list takes the answer at once, with its own names.
        for (id, email) in [("u2", "b@example.com"), ("u3", "c@example.com")] {
            sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, 'X', '2026-10-19T00:00:00Z')")
                .bind(id)
                .bind(email)
                .execute(&pool)
                .await
                .unwrap();
        }
        let theirs = crate::decks::create_deck_with_cards(&pool, "u2", "Rohan too", None, rohan_sample()).await.unwrap();
        let t = current_version(&pool, &theirs).await;
        let shown = view(&pool, Some(&t), true).await.unwrap();
        assert!(!shown.pending);
        assert_eq!(shown.result.as_ref().unwrap().bracket, Some(4));
        let text = serde_json::to_string(&shown.result).unwrap();
        assert!(!text.contains("PRIVATE"), "another account's typed names leaked: {text}");

        // The worker: a check requested before an answer came back takes it when one does (this
        // "Spellbook" would fail), summarized the same way.
        sqlx::query("UPDATE deck_version_checks SET requested_at = '2025-01-01T00:00:00.000Z', checked_at = '2025-01-01T00:00:00.000Z'")
            .execute(&pool)
            .await
            .unwrap();
        let third = crate::decks::create_deck_with_cards(&pool, "u3", "Rohan three", None, rohan_sample()).await.unwrap();
        let t3 = current_version(&pool, &third).await;
        assert!(view(&pool, Some(&t3), true).await.unwrap().pending, "too old an answer isn't reused at save");
        sqlx::query("UPDATE deck_version_checks SET checked_at = ? WHERE version_id = ?").bind(stamp()).bind(&v1).execute(&pool).await.unwrap();
        run_one(&pool, &http, &fake_spellbook(500).await, &t3, None).await.unwrap();
        let shown = view(&pool, Some(&t3), true).await.unwrap();
        assert!(!shown.pending && shown.error.is_none());
        let text = serde_json::to_string(&shown.result).unwrap();
        assert!(!text.contains("PRIVATE"), "{text}");
        assert_eq!(shown.result.unwrap().bracket, Some(4));

        // A "Check again" that lands between the worker reading a request and taking an answer
        // for it isn't overwritten: the row keeps waiting for a newer answer.
        sqlx::query("UPDATE deck_version_checks SET requested_at = ?, checked_at = '2025-01-01T00:00:00.000Z' WHERE version_id = ?")
            .bind(stamp())
            .bind(&t3)
            .execute(&pool)
            .await
            .unwrap();
        let newer: String = sqlx::query_scalar("SELECT requested_at FROM deck_version_checks WHERE version_id = ?").bind(&t3).fetch_one(&pool).await.unwrap();
        let cards = load_version_cards(&pool, &t3).await.unwrap();
        let mut conn = pool.acquire().await.unwrap();
        assert!(!reuse(&mut conn, &t3, &cards, &list_hash(&cards), "2020-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").await.unwrap());
        drop(conn);
        let after: String = sqlx::query_scalar("SELECT requested_at FROM deck_version_checks WHERE version_id = ?").bind(&t3).fetch_one(&pool).await.unwrap();
        assert_eq!(after, newer);
        assert!(view(&pool, Some(&t3), true).await.unwrap().pending);
    }

    #[tokio::test]
    async fn a_check_waiting_for_spellbook_skips_a_deck_archived_meanwhile() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        let deck = crate::decks::create_deck_with_cards(&pool, &owner, "Rohan", None, rohan_sample()).await.unwrap();
        let v = current_version(&pool, &deck).await;
        // A 429 holds Spellbook off; while the check waits, the deck is archived.
        let pacer = Research::default();
        pacer.hold_off(Provider::Spellbook, Duration::from_millis(400));
        let archive = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            sqlx::query("UPDATE decks SET archived = 1 WHERE id = ?").bind(&deck).execute(&pool).await.unwrap();
        };
        // This "Spellbook" fails, so a request would show as an error.
        let url = fake_spellbook(500).await;
        let http = crate::routes::http_client();
        let (result, _) = tokio::join!(run_one(&pool, &http, &url, &v, Some(&pacer)), archive);
        result.unwrap();
        let (attempts, error): (i64, Option<String>) =
            sqlx::query_as("SELECT attempts, error FROM deck_version_checks WHERE version_id = ?").bind(&v).fetch_one(&pool).await.unwrap();
        assert_eq!((attempts, error), (0, None), "nothing was sent");
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
        match run_one(&pool, &http, &url, &v, None).await {
            Err(CheckError::RateLimited(d)) => assert_eq!(d, Duration::from_secs(120)),
            other => panic!("expected a rate limit, got {other:?}"),
        }
        assert!(view(&pool, Some(&v), true).await.unwrap().error.unwrap().contains("slow down"));

        // 200: stored, the error cleared, nothing pending.
        let url = fake_spellbook(200).await;
        run_one(&pool, &http, &url, &v, None).await.unwrap();
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

        // A failed re-check keeps the old answer and shows the error beside it, retrying later.
        sqlx::query("UPDATE deck_version_checks SET checked_at = '2026-01-01T00:00:00.000Z'").execute(&pool).await.unwrap();
        request_again(&pool, &v).await.unwrap();
        assert!(view(&pool, Some(&v), true).await.unwrap().pending);
        let url = fake_spellbook(500).await;
        assert!(run_one(&pool, &http, &url, &v, None).await.is_err());
        let shown = view(&pool, Some(&v), true).await.unwrap();
        assert!(!shown.pending && shown.retrying && shown.result.is_some());
        assert!(shown.error.unwrap().contains("500"));
    }
}
