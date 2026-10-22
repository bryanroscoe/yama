//! "Try a change" and its relatives: a user's own experiments, played by the server's lab worker.
//!
//! Four modes ([`Mode`]), all stored and limited the same way:
//! - **change**: a base list and a changed copy of it play the same pods (see [`super::pairing`]):
//!   `games` = 2 x pods.
//! - **compare**: two different lists play the same pods the same way (the second list is the
//!   "variant"), so the difference is between the decks.
//! - **solo**: one list as it is plays every pod once (`games` = pods): its win rate against the
//!   field.
//! - **versus**: 2 to 4 lists play each other directly, in pods of four (precons fill empty seats)
//!   or 1v1, each rotated through every seat (`games` = games). The lists are frozen into the experiment when it is
//! created (cards, and the opponents' cards too), so a later edit to a deck or a re-imported
//! precon catalog never changes an experiment part way through.
//!
//! Isolation: every query binds the owner; another user's experiment is "not found". Limits for
//! anyone but an admin: 100, 200 or 400 games, Easy or Medium, and one experiment playing plus two
//! waiting. An account that joined without an invite (`User::limited`) gets less: 100 games, one
//! experiment at a time, and a daily number of games (YAMA_LAB_OPEN_DAILY_GAMES, counted from
//! `lab_usage`, which deleting an experiment doesn't touch). Games waiting or playing are capped
//! for everyone but admins together (YAMA_LAB_QUEUE_GAMES) and, within that, for accounts without
//! an invite together (YAMA_LAB_OPEN_QUEUE_GAMES), so a crowd of new accounts can't fill the
//! queue. Admins may ask for any even number of games up to 2,000 and any AI level, and no cap
//! applies to them.
//!
//! Sizes are checked before any expensive work: a request body of at most 256 KB, a pasted list of
//! at most 64 KB and 300 card lines, at most 200 cards to add and cut, at most 100 copies on a line
//! and 250 cards in a list. The rules engine only ever looks cards up by name here (it never
//! expands quantities), and a deck with a problem that stops a simulation is never sent to it.

use super::pairing::{self, LIMITS, Limits, POD};
use super::stats::{BASE_ID, BuildGames, Summary, VARIANT_ID};
use super::worker::Simulator;
use super::{Art, PreconCard, RunLabel, latest_global_ratings_run, ratings_for};
use crate::auth::{CurrentUser, User};
use crate::cards::{CARD_COLUMNS, Card};
use crate::config::LabQuota;
use crate::decks::{self, Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, sha256_hex};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, SqliteConnection, SqlitePool};
use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap, HashSet};
use yama_play::lab::{ENGINE, GameSpec, RUNNER};

/// What an experiment compares (see the module docs).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Change,
    Compare,
    Solo,
    Versus,
}

impl Mode {
    fn parse(s: Option<&str>) -> AppResult<Mode> {
        match s.map(str::trim).unwrap_or("change") {
            "" | "change" => Ok(Mode::Change),
            "compare" => Ok(Mode::Compare),
            "solo" => Ok(Mode::Solo),
            "versus" => Ok(Mode::Versus),
            other => Err(AppError::bad(format!("mode {other:?}: use change, compare, solo or versus"))),
        }
    }
}

/// Lists in a head-to-head experiment.
pub const MIN_ENTRANTS: usize = 2;
pub const MAX_ENTRANTS: usize = 4;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/lab/experiments", get(list_handler).post(create_handler))
        .route("/api/lab/experiments/{id}", get(detail_handler).delete(delete_handler))
        .route("/api/lab/experiments/{id}/cancel", post(cancel_handler))
        .route("/api/lab/experiments/{id}/again", post(again_handler))
        .route("/api/lab/experiments/{id}/pods", get(pods_handler))
        .route("/api/lab/pace", get(pace_handler))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
}

/// The 503 message when this server has no engine card data.
pub const NO_CARD_DATA: &str = "Simulations need the engine card data on this server";
/// Games an experiment may have, for anyone but an admin.
pub const GAME_CHOICES: [u32; 3] = [100, 200, 400];
/// Most games an admin's experiment may have.
pub const ADMIN_MAX_GAMES: u32 = 2_000;
/// Unfinished experiments (one playing plus two waiting) a user who isn't an admin may have.
pub const MAX_UNFINISHED: i64 = 3;
/// Games an experiment may have for an account that joined without an invite.
pub const OPEN_GAME_CHOICES: [u32; 1] = [100];
/// Unfinished experiments such an account may have: one at a time, none waiting.
pub const OPEN_MAX_UNFINISHED: i64 = 1;

/// The game counts `user` may choose.
pub fn game_choices(user: &User) -> &'static [u32] {
    if user.limited && !user.is_admin { &OPEN_GAME_CHOICES } else { &GAME_CHOICES }
}
/// AI levels anyone may choose; admins may choose any level the engine has.
const USER_DIFFICULTIES: [&str; 2] = ["Easy", "Medium"];
const DEFAULT_DIFFICULTY: &str = "Easy";
/// Field size for the "strongest" and "nearest in strength" precon fields when none is given.
pub const DEFAULT_FIELD: usize = 20;
pub const MIN_FIELD: usize = 3;
const MAX_FIELD: usize = 200;
const MAX_NAME: usize = 120;
/// Most bytes in a request to these endpoints (two pasted lists fit four times over).
const MAX_BODY_BYTES: usize = 256 * 1024;
/// Most bytes in a pasted list, and most card lines in it (sideboard lines not counted).
pub const MAX_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_TEXT_LINES: usize = 300;
/// Most copies of one card on a line: more than a Commander deck holds.
pub const MAX_LINE_QTY: u32 = 100;
/// Most cards in a list (a game needs exactly 100).
pub const MAX_LIST_CARDS: u64 = 250;
/// Most cards to add and cut, together.
pub const MAX_CHANGES: usize = 200;

// ── lists ───────────────────────────────────────────────────────────────────

/// One card line of a list as the lab plays it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabCard {
    pub name: String,
    /// Yama's oracle id when Yama knows the card; the engine resolves by it first, then by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oracle_id: Option<String>,
    pub qty: u32,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub commander: bool,
}

/// A frozen list in an experiment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LabList {
    /// The deck id its games use: "base", "variant", "precons/<slug>" or "deck/<id>".
    pub id: String,
    pub label: String,
    /// Where it came from: {kind: precon|deck|list|change, id?, version?}.
    pub source: Value,
    /// sha256 of the list's text (commander lines first), to tell lists apart.
    pub sha256: String,
    pub cards: Vec<LabCard>,
}

/// An opponent and how many pods it sits in.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Opponent {
    #[serde(flatten)]
    pub list: LabList,
    pub pods: usize,
}

fn key(c: &LabCard) -> (bool, String) {
    (c.commander, c.oracle_id.clone().unwrap_or_else(|| c.name.to_lowercase()))
}

/// Merge repeated lines (the first line's name and id kept) and order the list: commanders first,
/// then by name. Linear in the lines, plus the sort.
pub fn normalize(cards: Vec<LabCard>) -> Vec<LabCard> {
    let mut out: Vec<LabCard> = Vec::with_capacity(cards.len());
    let mut at: HashMap<(bool, String), usize> = HashMap::with_capacity(cards.len());
    for c in cards {
        if c.qty == 0 {
            continue;
        }
        match at.entry(key(&c)) {
            Entry::Occupied(e) => {
                let o = &mut out[*e.get()];
                o.qty = o.qty.saturating_add(c.qty);
            }
            Entry::Vacant(e) => {
                e.insert(out.len());
                out.push(c);
            }
        }
    }
    // Stable: lines with the same name keep their order, as before.
    out.sort_by_cached_key(|c| (!c.commander, c.name.to_lowercase()));
    out
}

/// What makes a list too big to work with, from its (name, copies) lines: too many lines, too many
/// copies on one line, or too many cards. Checked before anything expands or looks up the list.
fn size_problem<'a>(lines: impl IntoIterator<Item = (&'a str, u64)>) -> Option<String> {
    let mut count = 0usize;
    let mut total = 0u64;
    for (name, qty) in lines {
        count += 1;
        if qty > u64::from(MAX_LINE_QTY) {
            return Some(format!("{qty} copies of {name}; a line can have at most {MAX_LINE_QTY}"));
        }
        total += qty;
    }
    if count as u64 > MAX_LIST_CARDS || total > MAX_LIST_CARDS {
        return Some(format!("{total} cards on {count} lines; a list can have at most {MAX_LIST_CARDS} cards (a game needs exactly 100)"));
    }
    None
}

/// Which list a problem is about, and its key in a 400's details: "base list" or "changed list"
/// (change), deck A or B (compare, solo), or the nth deck of a head to head.
#[derive(Clone, Copy)]
enum Which {
    Base,
    Variant,
    /// compare: the two decks.
    DeckA,
    DeckB,
    /// versus: 0-based.
    Entrant(usize),
}

impl Which {
    fn label(self) -> String {
        match self {
            Which::Base => "base list".into(),
            Which::Variant => "changed list".into(),
            Which::DeckA => "first deck".into(),
            Which::DeckB => "second deck".into(),
            Which::Entrant(i) => format!("deck {}", i + 1),
        }
    }
}

/// A 400 for a problem with one list, in the shape of the other per-list problems.
fn list_problem(which: Which, problem: String) -> AppError {
    let details = match which {
        Which::Base | Which::DeckA => json!({"problems": {"base": [problem.clone()], "variant": []}}),
        Which::Variant | Which::DeckB => json!({"problems": {"base": [], "variant": [problem.clone()]}}),
        Which::Entrant(i) => json!({"problems": {"base": [], "variant": [], "entrants": {i.to_string(): [problem.clone()]}}}),
    };
    AppError::Invalid { message: format!("The {}: {problem}", which.label()), details }
}

/// `cards`, refused with a 400 when the list is too big to work with.
fn sized(which: Which, cards: Vec<LabCard>) -> AppResult<Vec<LabCard>> {
    match size_problem(cards.iter().map(|c| (c.name.as_str(), u64::from(c.qty)))) {
        Some(p) => Err(list_problem(which, p)),
        None => Ok(cards),
    }
}

/// A stored quantity as a lab quantity; one that doesn't fit is too many copies anyway.
fn copies(qty: i64) -> u32 {
    u32::try_from(qty).unwrap_or(u32::MAX)
}

fn list_text(cards: &[LabCard]) -> String {
    let line = |c: &LabCard| format!("{} {}\n", c.qty, c.name);
    let commanders: String = cards.iter().filter(|c| c.commander).map(line).collect();
    let main: String = cards.iter().filter(|c| !c.commander).map(line).collect();
    format!("Commander\n{commanders}\nDeck\n{main}")
}

fn make_list(id: &str, label: &str, source: Value, cards: Vec<LabCard>) -> LabList {
    let cards = normalize(cards);
    LabList { id: id.into(), label: label.into(), source, sha256: sha256_hex(&list_text(&cards)), cards }
}

/// Lines the changed list has more of (added) and fewer of (cut) than the base.
pub fn diff(base: &[LabCard], variant: &[LabCard]) -> (Vec<LabCard>, Vec<LabCard>) {
    let mut qty: BTreeMap<(bool, String), (i64, Option<&LabCard>)> = BTreeMap::new();
    for c in base {
        let e = qty.entry(key(c)).or_insert((0, Some(c)));
        e.0 -= i64::from(c.qty);
    }
    for c in variant {
        let e = qty.entry(key(c)).or_insert((0, Some(c)));
        e.0 += i64::from(c.qty);
        e.1 = Some(c);
    }
    let (mut added, mut cut) = (Vec::new(), Vec::new());
    for (d, card) in qty.into_values() {
        let Some(card) = card else { continue };
        let line = |n: i64| LabCard { qty: n as u32, ..card.clone() };
        if d > 0 {
            added.push(line(d));
        } else if d < 0 {
            cut.push(line(-d));
        }
    }
    let by_name = |a: &LabCard, b: &LabCard| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    added.sort_by(by_name);
    cut.sort_by(by_name);
    (added, cut)
}

fn from_deck_cards(cards: Vec<DeckCard>) -> Vec<LabCard> {
    cards
        .into_iter()
        .filter(|c| c.board != Board::Side && c.qty > 0)
        .map(|c| LabCard { name: c.name, oracle_id: Some(c.oracle_id), qty: copies(c.qty), commander: c.board == Board::Commander })
        .collect()
}

fn from_precon_cards(cards: Vec<PreconCard>) -> Vec<LabCard> {
    cards
        .into_iter()
        .filter(|c| c.board != Board::Side)
        .map(|c| LabCard { name: c.name, oracle_id: c.oracle_id, qty: c.qty, commander: c.board == Board::Commander })
        .collect()
}

/// Oracle ids and Yama's canonical names for `names`; names Yama doesn't know come back apart.
/// One lookup per distinct name.
async fn resolve(pool: &SqlitePool, names: &[String]) -> AppResult<(HashMap<String, (String, String)>, Vec<String>)> {
    let mut seen = HashSet::new();
    let names: Vec<String> = names.iter().filter(|n| seen.insert(n.as_str())).cloned().collect();
    let ids = crate::cards::resolve_names(pool, &names).await?;
    let wanted: Vec<&String> = ids.values().collect();
    let canonical: HashMap<String, String> =
        sqlx::query_as::<_, (String, String)>("SELECT oracle_id, name FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))")
            .bind(serde_json::to_string(&wanted).map_err(anyhow::Error::from)?)
            .fetch_all(pool)
            .await?
            .into_iter()
            .collect();
    let mut found = HashMap::new();
    let mut unknown = Vec::new();
    for n in names {
        match ids.get(&n).and_then(|oid| canonical.get(oid).map(|c| (oid.clone(), c.clone()))) {
            Some(hit) => {
                found.insert(n, hit);
            }
            None => unknown.push(n),
        }
    }
    Ok((found, unknown))
}

/// A pasted list: lines as the deck editor reads them (first card is the commander when there's
/// no Commander section), sideboards ignored. Names Yama doesn't know come back apart. Too long a
/// text, too many lines or cards are refused before any name is looked up.
async fn parse_text(pool: &SqlitePool, text: &str, which: Which) -> AppResult<(Vec<LabCard>, Vec<String>)> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(list_problem(which, format!("the pasted text is {} KB; at most {} KB", text.len().div_ceil(1024), MAX_TEXT_BYTES / 1024)));
    }
    let lines: Vec<decks::ParsedLine> = decks::parse_list(text, true).into_iter().filter(|l| l.board != Board::Side).collect();
    if lines.len() > MAX_TEXT_LINES {
        return Err(list_problem(which, format!("{} card lines; a pasted list can have at most {MAX_TEXT_LINES}", lines.len())));
    }
    if let Some(p) = size_problem(lines.iter().map(|l| (l.name.as_str(), u64::try_from(l.qty).unwrap_or(u64::MAX)))) {
        return Err(list_problem(which, p));
    }
    let names: Vec<String> = lines.iter().map(|l| l.name.clone()).collect();
    let (found, unknown) = resolve(pool, &names).await?;
    let cards = lines
        .into_iter()
        .filter_map(|l| {
            let (oid, name) = found.get(&l.name)?.clone();
            Some(LabCard { name, oracle_id: Some(oid), qty: copies(l.qty), commander: l.board == Board::Commander })
        })
        .collect();
    Ok((cards, unknown))
}

/// The base list with `cut` taken out and `add` put in, one copy per entry (repeat a name for more
/// copies). Entries are (oracle id, canonical name). Cut entries must be in the base's main deck.
pub fn apply_change(base: &[LabCard], add: &[(String, String)], cut: &[(String, String)]) -> Result<Vec<LabCard>, Vec<String>> {
    let mut cards = base.to_vec();
    let mut problems = Vec::new();
    let same = |c: &LabCard, oid: &str, name: &str| c.oracle_id.as_deref() == Some(oid) || (c.oracle_id.is_none() && c.name.eq_ignore_ascii_case(name));
    for (oid, name) in cut {
        if let Some(c) = cards.iter_mut().find(|c| !c.commander && c.qty > 0 && same(c, oid, name)) {
            c.qty -= 1;
        } else if cards.iter().any(|c| c.commander && same(c, oid, name)) {
            problems.push(format!("{name} is the commander; to change the commander, paste the whole changed list"));
        } else {
            problems.push(format!("{name} isn't in the base list (or not that many copies)"));
        }
    }
    for (oid, name) in add {
        match cards.iter_mut().find(|c| !c.commander && same(c, oid, name)) {
            Some(c) => c.qty += 1,
            None => cards.push(LabCard { name: name.clone(), oracle_id: Some(oid.clone()), qty: 1, commander: false }),
        }
    }
    if problems.is_empty() { Ok(normalize(cards)) } else { Err(problems) }
}

/// Card details for every oracle id in the lists (for checks, commanders and art).
async fn card_info(pool: &SqlitePool, lists: &[&[LabCard]]) -> AppResult<HashMap<String, Card>> {
    let ids: Vec<&str> = lists.iter().flat_map(|l| l.iter().filter_map(|c| c.oracle_id.as_deref())).collect::<HashSet<_>>().into_iter().collect();
    Ok(sqlx::query_as::<_, Card>(AssertSqlSafe(format!("SELECT {CARD_COLUMNS} FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))")))
        .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|c| (c.oracle_id.clone(), c))
        .collect())
}

/// What the deck checks say about a list, split the lab's way.
#[derive(Debug, Default)]
pub struct Checked {
    /// Problems that stop a simulation: the size (exactly 100) and the commander rules (one or
    /// two commanders, each able to be one, a legal pairing).
    pub blocking: Vec<String>,
    /// Everything else the checks find (singleton, colour identity, bans, unknown cards): shown,
    /// but the game is simulated anyway.
    pub warnings: Vec<String>,
    pub commanders: Vec<String>,
    pub color_identity: String,
}

/// Whether a finding of `decks::validate` stops a simulation: the deck's size and the commander
/// rules. Matched on validate's exact wording (a test pins it), so a card's name can't make a
/// singleton, colour or legality finding look like one.
fn blocks_simulation(e: &str) -> bool {
    e == "no commander chosen"
        || e.ends_with(" commanders; the most is two")
        || e.ends_with(" can't be a commander")
        || e.starts_with("two commanders need ")
        || e.ends_with(" cards; Commander decks have exactly 100 including the commander")
}

/// "Legal-ish": the deck module's Commander validation, blocking only on size and commanders.
pub fn check_list(cards: &[LabCard], info: &HashMap<String, Card>) -> Checked {
    let deck: Vec<DeckCard> = cards
        .iter()
        .map(|c| DeckCard {
            oracle_id: c.oracle_id.clone().unwrap_or_default(),
            name: c.name.clone(),
            qty: i64::from(c.qty),
            board: if c.commander { Board::Commander } else { Board::Main },
        })
        .collect();
    let v = decks::validate(&deck, info);
    let mut out = Checked { color_identity: v.color_identity, ..Default::default() };
    out.commanders = cards.iter().filter(|c| c.commander).map(|c| c.name.clone()).collect();
    for e in v.errors {
        if blocks_simulation(&e) {
            out.blocking.push(e);
        } else {
            out.warnings.push(e);
        }
    }
    out.warnings.extend(v.warnings);
    out
}

// ── requests ────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct NewExperiment {
    pub name: Option<String>,
    /// Client-generated: a retried create returns the experiment the first one made.
    pub op_id: Option<String>,
    /// "change" (the default), "compare", "solo" or "versus".
    #[serde(default)]
    pub mode: Option<String>,
    /// The list to start from (change, solo), deck A (compare). Versus uses `entrants` instead.
    #[serde(default)]
    pub base: Option<BaseChoice>,
    /// change only.
    #[serde(default)]
    pub variant: VariantChoice,
    /// compare only: deck B.
    #[serde(default)]
    pub other: Option<BaseChoice>,
    /// versus only: 2 to 4 lists.
    #[serde(default)]
    pub entrants: Vec<BaseChoice>,
    /// versus only: 4 (the default; precons from `field` fill empty seats) or 2 (1v1, two lists).
    #[serde(default)]
    pub pod: Option<usize>,
    /// The opponents. Versus needs it only to fill empty seats.
    #[serde(default)]
    pub field: Option<FieldChoice>,
    pub games: u32,
    pub difficulty: Option<String>,
}

/// kind: "deck_version" (id: a version of one of your decks), "deck" (id: one of your decks, its
/// current version), "precon" (id: a precon slug) or "list" (text: a pasted list, with an optional
/// `label` such as "Riders of Rohan, now" for a list taken from a plan).
#[derive(Debug, Deserialize)]
pub struct BaseChoice {
    pub kind: String,
    pub id: Option<String>,
    pub text: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

/// Either a whole changed list (`text`) or changes to the base (`add`, `cut`: card names, one copy
/// each).
#[derive(Debug, Default, Deserialize)]
pub struct VariantChoice {
    pub text: Option<String>,
    #[serde(default)]
    pub add: Vec<String>,
    #[serde(default)]
    pub cut: Vec<String>,
}

/// kind: "precons_all", "precons_top" (strongest n in the newest global rating run),
/// "precons_near" (n nearest in strength to the base precon, or to ids[0]), "precons_ids", or
/// "my_decks" (ids, or all your decks).
#[derive(Debug, Deserialize)]
pub struct FieldChoice {
    pub kind: String,
    pub n: Option<usize>,
    #[serde(default)]
    pub ids: Vec<String>,
    /// For a pick of fewer than three decks (my_decks, precons_ids): the precons that fill the
    /// other seats, "precons_near" or "precons_top". Unset: nearest in strength when the list has
    /// a rated precon to go by, else the strongest.
    #[serde(default)]
    pub fill: Option<String>,
}

// ── the stored spec ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldInfo {
    pub kind: String,
    pub n: Option<usize>,
    pub ids: Vec<String>,
    /// The first this-many opponents sit in every pod (a pick of fewer than three decks, topped up
    /// with precons for the other seats).
    #[serde(default)]
    pub every_pod: usize,
    /// e.g. "Strongest 20 precons in rating run precons-1".
    pub label: String,
    /// The rating run the field was chosen from, for precons_top and precons_near.
    pub run: Option<RunRef>,
    pub decks: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ListDisplay {
    pub label: String,
    pub commanders: Vec<String>,
    pub color_identity: String,
    /// The commander's Scryfall art_crop, shown behind the experiment (loaded by the browser).
    pub art: Option<Art>,
    pub source: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VariantDisplay {
    pub label: String,
    pub added: Vec<LabCard>,
    pub cut: Vec<LabCard>,
}

/// What lists show without reading the whole spec.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Display {
    #[serde(default)]
    pub mode: Mode,
    pub base: ListDisplay,
    /// change and compare (in compare, `added` and `cut` are empty: the lists are whole decks).
    #[serde(default)]
    pub variant: Option<VariantDisplay>,
    /// compare: deck A then deck B; versus: every list in order. Empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entrants: Vec<ListDisplay>,
    pub field: FieldInfo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExperimentSpec {
    pub version: u32,
    #[serde(default)]
    pub mode: Mode,
    pub seed: u64,
    /// Players per game (4, or 2 for a 1v1 head to head).
    pub pod: usize,
    /// Pod templates (change, compare, solo) or games (versus).
    pub pods: usize,
    pub difficulty: String,
    pub limits: Limits,
    pub display: Display,
    /// The list tested (change, solo), deck A (compare), the first entrant (versus).
    pub base: LabList,
    /// change and compare only.
    #[serde(default)]
    pub variant: Option<LabList>,
    /// versus: every list, in order (ids "e0".."e3"; `base` is a copy of the first).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entrants: Vec<LabList>,
    pub opponents: Vec<Opponent>,
    pub warnings: Vec<String>,
}

// ── building an experiment ──────────────────────────────────────────────────

/// A base list and what's known about where it came from.
struct Base {
    list: LabList,
    precon: Option<String>,
    deck: Option<String>,
    unknown: Vec<String>,
}

fn need<'a>(v: &'a Option<String>, what: &str) -> AppResult<&'a str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| AppError::bad(format!("{what} is required")))
}

async fn base_list(pool: &SqlitePool, owner: &str, b: &BaseChoice) -> AppResult<Base> {
    pick_list(pool, owner, b, BASE_ID, Which::Base).await
}

/// One chosen list, frozen under deck id `id`; problems name it as `which`.
async fn pick_list(pool: &SqlitePool, owner: &str, b: &BaseChoice, id_as: &str, which: Which) -> AppResult<Base> {
    match b.kind.as_str() {
        "deck" | "deck_version" => {
            let id = need(&b.id, "base.id")?;
            let row: Option<(String, String, String, String)> = if b.kind == "deck" {
                sqlx::query_as(
                    "SELECT d.id, d.name, v.id, v.cards FROM decks d JOIN deck_versions v ON v.id = d.current_version_id
                     WHERE d.id = ? AND d.owner_id = ? AND d.archived = 0",
                )
                .bind(id)
                .bind(owner)
                .fetch_optional(pool)
                .await?
            } else {
                sqlx::query_as("SELECT d.id, d.name, v.id, v.cards FROM deck_versions v JOIN decks d ON d.id = v.deck_id WHERE v.id = ? AND d.owner_id = ?")
                    .bind(id)
                    .bind(owner)
                    .fetch_optional(pool)
                    .await?
            };
            let (deck_id, name, version, cards) = row.ok_or(AppError::NotFound("deck"))?;
            let cards: Vec<DeckCard> = serde_json::from_str(&cards).map_err(anyhow::Error::from)?;
            let source = json!({"kind": "deck", "id": deck_id, "version": version});
            let cards = sized(which, from_deck_cards(cards))?;
            Ok(Base { list: make_list(id_as, &name, source, cards), precon: None, deck: Some(deck_id), unknown: vec![] })
        }
        "precon" => {
            let id = need(&b.id, "base.id")?;
            let (name, cards): (String, String) =
                sqlx::query_as("SELECT name, cards FROM precons WHERE id = ?").bind(id).fetch_optional(pool).await?.ok_or(AppError::NotFound("precon"))?;
            let cards: Vec<PreconCard> = serde_json::from_str(&cards).map_err(anyhow::Error::from)?;
            let source = json!({"kind": "precon", "id": id});
            let cards = sized(which, from_precon_cards(cards))?;
            Ok(Base { list: make_list(id_as, &name, source, cards), precon: Some(id.to_string()), deck: None, unknown: vec![] })
        }
        "list" => {
            let text = need(&b.text, "base.text")?;
            let (cards, unknown) = parse_text(pool, text, which).await?;
            let label: String = b.label.as_deref().map(str::trim).filter(|l| !l.is_empty()).map(|l| l.chars().take(MAX_NAME).collect()).unwrap_or_else(|| "Pasted list".into());
            let source = if label == "Pasted list" { json!({"kind": "list"}) } else { json!({"kind": "list", "label": label}) };
            Ok(Base { list: make_list(id_as, &label, source, cards), precon: None, deck: None, unknown })
        }
        other => Err(AppError::bad(format!("base.kind {other:?}: use deck_version, deck, precon or list"))),
    }
}

/// The changed list, the names Yama doesn't know, and problems applying the changes.
async fn variant_list(pool: &SqlitePool, base: &LabList, v: &VariantChoice) -> AppResult<(LabList, Vec<String>, Vec<String>)> {
    match (&v.text, v.add.is_empty() && v.cut.is_empty()) {
        (Some(_), false) => Err(AppError::bad("variant: give either text or add/cut, not both")),
        (Some(text), true) => {
            let (cards, unknown) = parse_text(pool, text, Which::Variant).await?;
            Ok((make_list(VARIANT_ID, "Changed list", json!({"kind": "list"}), cards), unknown, vec![]))
        }
        (None, true) => Err(AppError::bad("variant: give the changed list as text, or cards to add and cut")),
        (None, false) => {
            if v.add.len() + v.cut.len() > MAX_CHANGES {
                return Err(list_problem(Which::Variant, format!("{} cards to add and cut; at most {MAX_CHANGES}", v.add.len() + v.cut.len())));
            }
            let names: Vec<String> = v.add.iter().chain(&v.cut).map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
            let (found, unknown) = resolve(pool, &names).await?;
            let pick = |list: &[String]| -> Vec<(String, String)> { list.iter().filter_map(|n| found.get(n.trim()).cloned()).collect() };
            let (add, cut) = (pick(&v.add), pick(&v.cut));
            let (cards, problems) = match apply_change(&base.cards, &add, &cut) {
                Ok(cards) => (sized(Which::Variant, cards)?, vec![]),
                Err(p) => (base.cards.clone(), p),
            };
            let source = json!({"kind": "change", "add": v.add, "cut": v.cut});
            Ok((make_list(VARIANT_ID, "Changed list", source, cards), unknown, problems))
        }
    }
}

/// A precon in the catalog with its rating in the newest global run.
struct PreconEntry {
    slug: String,
    lab_id: String,
    name: String,
    commanders: Vec<String>,
    cards: Vec<LabCard>,
    strength: Option<f64>,
    rank: Option<i64>,
}

async fn load_precons(pool: &SqlitePool) -> AppResult<(Option<RunLabel>, Vec<PreconEntry>)> {
    let run = latest_global_ratings_run(pool).await?;
    let ratings = match &run {
        Some(r) => ratings_for(pool, &r.id).await?,
        None => HashMap::new(),
    };
    let rows: Vec<(String, String, String, String, String)> =
        sqlx::query_as("SELECT id, lab_id, name, commanders, cards FROM precons ORDER BY name, id").fetch_all(pool).await?;
    let mut out = Vec::with_capacity(rows.len());
    for (slug, lab_id, name, commanders, cards) in rows {
        let cards: Vec<PreconCard> = serde_json::from_str(&cards).map_err(anyhow::Error::from)?;
        let r = ratings.get(&lab_id);
        out.push(PreconEntry {
            slug,
            name,
            commanders: serde_json::from_str(&commanders).unwrap_or_default(),
            cards: normalize(from_precon_cards(cards)),
            strength: r.and_then(|r| r.strength),
            rank: r.and_then(|r| r.rank),
            lab_id,
        });
    }
    Ok((run, out))
}

struct Field {
    opponents: Vec<LabList>,
    info: FieldInfo,
    warnings: Vec<String>,
}

fn field_size(c: &FieldChoice) -> AppResult<usize> {
    let n = c.n.unwrap_or(DEFAULT_FIELD);
    if !(MIN_FIELD..=MAX_FIELD).contains(&n) {
        return Err(AppError::bad(format!("field.n must be {MIN_FIELD} to {MAX_FIELD}")));
    }
    Ok(n)
}

fn shown(names: &[String]) -> String {
    let first: Vec<&str> = names.iter().take(5).map(String::as_str).collect();
    if names.len() > first.len() { format!("{}, and {} more", first.join(", "), names.len() - first.len()) } else { first.join(", ") }
}

/// The opponents for `choice`, topped up when a pick of decks (my_decks, precons_ids) is too small
/// to fill a pod: the picked decks then sit in every pod (`FieldInfo::every_pod`) and precons fill
/// the other seats (nearest in strength, else the strongest, else any).
async fn field_for(pool: &SqlitePool, owner: &str, choice: &FieldChoice, base: &Base, others: &[&Base], base_commanders: &[String], sim: &dyn Simulator) -> AppResult<Field> {
    let field = build_field(pool, owner, choice, base, others, base_commanders, sim).await?;
    let picked = matches!(choice.kind.as_str(), "my_decks" | "precons_ids");
    if !picked || field.opponents.is_empty() || field.opponents.len() >= MIN_FIELD {
        return Ok(field);
    }
    let kinds: Vec<&str> = match choice.fill.as_deref() {
        Some("precons_top") => vec!["precons_top", "precons_all"],
        Some("precons_near") | None => vec!["precons_near", "precons_top", "precons_all"],
        Some(other) => return Err(AppError::bad(format!("field.fill {other:?}: use precons_near or precons_top"))),
    };
    let mut last_err = None;
    let mut fill = None;
    for kind in kinds {
        let c = FieldChoice { kind: kind.into(), n: Some(DEFAULT_FIELD), ids: vec![], fill: None };
        match build_field(pool, owner, &c, base, others, base_commanders, sim).await {
            Ok(f) => {
                fill = Some(f);
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let Some(fill) = fill else { return Err(last_err.unwrap_or_else(|| AppError::bad("No precons to fill the other seats"))) };
    let picked_ids: HashSet<String> = field.opponents.iter().map(|o| o.id.clone()).collect();
    let k = field.opponents.len();
    let names: Vec<String> = field.opponents.iter().map(|o| o.label.clone()).collect();
    let fillers: Vec<LabList> = fill.opponents.into_iter().filter(|o| !picked_ids.contains(&o.id)).collect();
    if k + fillers.len() < MIN_FIELD {
        return Err(AppError::bad(format!("The field needs at least {MIN_FIELD} decks to fill the pods; this one has {}", k + fillers.len())));
    }
    let fill_label = {
        let l = &fill.info.label;
        let mut c = l.chars();
        c.next().map(|f| f.to_lowercase().collect::<String>() + c.as_str()).unwrap_or_default()
    };
    let label = format!("{} in every pod, with {fill_label} filling the other seats", names.join(" and "));
    let mut warnings = field.warnings;
    warnings.extend(fill.warnings);
    let mut opponents = field.opponents;
    opponents.extend(fillers);
    let info = FieldInfo { every_pod: k, label, decks: opponents.len(), run: fill.info.run, ..field.info };
    Ok(Field { opponents, info, warnings })
}

/// The opponents for `choice`. `base` sets "similar strength"; it and `others` (the other lists
/// being tested) are never in the field.
async fn build_field(pool: &SqlitePool, owner: &str, choice: &FieldChoice, base: &Base, others: &[&Base], base_commanders: &[String], sim: &dyn Simulator) -> AppResult<Field> {
    if choice.ids.len() > MAX_FIELD {
        return Err(AppError::bad(format!("field.ids: at most {MAX_FIELD} decks")));
    }
    if choice.kind == "my_decks" {
        let tested: Vec<&str> = std::iter::once(base).chain(others.iter().copied()).filter_map(|b| b.deck.as_deref()).collect();
        return my_decks_field(pool, owner, choice, &tested, sim).await;
    }
    if !["precons_all", "precons_top", "precons_near", "precons_ids"].contains(&choice.kind.as_str()) {
        return Err(AppError::bad(format!("field.kind {:?}: use precons_all, precons_top, precons_near, precons_ids or my_decks", choice.kind)));
    }
    let (run, all) = load_precons(pool).await?;
    let mut warnings = Vec::new();
    let playable = |p: &PreconEntry| sim.unknown(&p.cards);
    let is_base = |p: &PreconEntry| std::iter::once(base).chain(others.iter().copied()).any(|b| b.precon.as_deref() == Some(p.slug.as_str()));
    let run_ref = run.as_ref().map(|r| RunRef { id: r.id.clone(), name: r.name.clone() });
    let need_run = || {
        run.as_ref().ok_or_else(|| AppError::bad("No precon ratings are imported on this server yet, so there's no strength to choose by. Pick precons, or play all of them."))
    };
    // Candidates in the order the field wants them, then the first n the engine can play.
    let (ordered, n, label, run_used): (Vec<&PreconEntry>, Option<usize>, Box<dyn Fn(usize) -> String>, Option<RunRef>) = match choice.kind.as_str() {
        "precons_all" => (all.iter().filter(|p| !is_base(p)).collect(), None, Box::new(|k| format!("All {k} precons")), None),
        "precons_top" => {
            let n = field_size(choice)?;
            let r = need_run()?;
            let mut rated: Vec<&PreconEntry> = all.iter().filter(|p| p.rank.is_some() && !is_base(p)).collect();
            rated.sort_by_key(|p| (p.rank, p.name.clone()));
            let name = r.name.clone();
            (rated, Some(n), Box::new(move |k| format!("Strongest {k} precons in rating run {name}")), run_ref.clone())
        }
        "precons_near" => {
            let n = field_size(choice)?;
            need_run()?;
            let anchor: &PreconEntry = if let Some(p) = base.precon.as_deref().and_then(|s| all.iter().find(|p| p.slug == s)).filter(|p| p.strength.is_some()) {
                p
            } else if let Some(id) = choice.ids.first() {
                let p = all.iter().find(|p| &p.slug == id).ok_or(AppError::NotFound("precon"))?;
                if p.strength.is_none() {
                    return Err(AppError::bad(format!("{} has no rating in the newest rating run; pick another precon to set the power level", p.name)));
                }
                p
            } else {
                // A precon with the same commanders as the base, if one is rated.
                let mine: HashSet<&str> = base_commanders.iter().map(String::as_str).collect();
                all.iter()
                    .find(|p| p.strength.is_some() && !mine.is_empty() && p.commanders.iter().map(String::as_str).collect::<HashSet<_>>() == mine)
                    .ok_or_else(|| AppError::bad("Pick a precon about as strong as your list to set the power level: the list you start from has no rating"))?
            };
            let a = anchor.strength.expect("checked").ln();
            let mut near: Vec<&PreconEntry> = all.iter().filter(|p| p.strength.is_some() && !is_base(p) && p.slug != anchor.slug).collect();
            near.sort_by(|x, y| {
                let d = |p: &PreconEntry| (p.strength.expect("filtered").ln() - a).abs();
                d(x).total_cmp(&d(y)).then_with(|| x.name.cmp(&y.name))
            });
            let anchor_name = anchor.name.clone();
            (near, Some(n), Box::new(move |k| format!("{k} precons nearest in strength to {anchor_name}")), run_ref.clone())
        }
        _ => {
            // precons_ids: exactly these, each playable.
            let mut picked: Vec<&PreconEntry> = Vec::new();
            let mut missing = Vec::new();
            for id in &choice.ids {
                match all.iter().find(|p| &p.slug == id || &p.lab_id == id) {
                    Some(p) if is_base(p) => warnings.push(format!("{} is one of the lists being tested, so it isn't in the field", p.name)),
                    Some(p) if !picked.iter().any(|q| q.slug == p.slug) => picked.push(p),
                    Some(_) => {}
                    None => missing.push(id.clone()),
                }
            }
            if !missing.is_empty() {
                return Err(AppError::Invalid { message: format!("Unknown precons: {}", shown(&missing)), details: json!({"unknown_precons": missing}) });
            }
            let mut bad = serde_json::Map::new();
            for p in &picked {
                let u = playable(p);
                if !u.is_empty() {
                    bad.insert(p.slug.clone(), json!(u));
                }
            }
            if !bad.is_empty() {
                return Err(AppError::Invalid {
                    message: "Some chosen precons have cards the simulator can't play".into(),
                    details: json!({"unplayable_precons": bad}),
                });
            }
            (picked, None, Box::new(|k| format!("{k} chosen precons")), None)
        }
    };
    let mut chosen: Vec<&PreconEntry> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    for p in ordered {
        if n.is_some_and(|n| chosen.len() >= n) {
            break;
        }
        if choice.kind != "precons_ids" && !playable(p).is_empty() {
            skipped.push(p.name.clone());
            continue;
        }
        chosen.push(p);
    }
    if !skipped.is_empty() {
        warnings.push(format!("Left out {} precons with cards the simulator can't play: {}", skipped.len(), shown(&skipped)));
    }
    if let Some(n) = n
        && chosen.len() < n
    {
        warnings.push(format!("Only {} precons fit, not {n}", chosen.len()));
    }
    let opponents: Vec<LabList> =
        chosen.iter().map(|p| make_list(&p.lab_id, &p.name, json!({"kind": "precon", "id": p.slug}), p.cards.clone())).collect();
    let info = FieldInfo {
        kind: choice.kind.clone(),
        n,
        ids: choice.ids.clone(),
        every_pod: 0,
        label: label(opponents.len()),
        run: run_used,
        decks: opponents.len(),
    };
    Ok(Field { opponents, info, warnings })
}

async fn my_decks_field(pool: &SqlitePool, owner: &str, choice: &FieldChoice, tested: &[&str], sim: &dyn Simulator) -> AppResult<Field> {
    let explicit = !choice.ids.is_empty();
    let mut rows: Vec<(String, String, String)> = Vec::new();
    let mut warnings = Vec::new();
    if explicit {
        for id in &choice.ids {
            let row: Option<(String, String, String)> = sqlx::query_as(
                "SELECT d.id, d.name, v.cards FROM decks d JOIN deck_versions v ON v.id = d.current_version_id
                 WHERE d.id = ? AND d.owner_id = ? AND d.archived = 0",
            )
            .bind(id)
            .bind(owner)
            .fetch_optional(pool)
            .await?;
            let row = row.ok_or(AppError::NotFound("deck"))?;
            if !rows.iter().any(|r| r.0 == row.0) {
                rows.push(row);
            }
        }
    } else {
        rows = sqlx::query_as(
            "SELECT d.id, d.name, v.cards FROM decks d JOIN deck_versions v ON v.id = d.current_version_id
             WHERE d.owner_id = ? AND d.archived = 0 ORDER BY IFNULL(d.folder, ''), d.name, d.id",
        )
        .bind(owner)
        .fetch_all(pool)
        .await?;
    }
    let lists: Vec<(String, String, Vec<LabCard>)> = rows
        .into_iter()
        .filter(|(id, name, _)| {
            let is_tested = tested.contains(&id.as_str());
            if is_tested && explicit {
                warnings.push(format!("{name} is one of the lists being tested, so it isn't in the field"));
            }
            !is_tested
        })
        .map(|(id, name, cards)| Ok((id, name, from_deck_cards(serde_json::from_str(&cards).map_err(anyhow::Error::from)?))))
        .collect::<AppResult<_>>()?;
    // A deck too big to work with is set aside before its cards are merged, looked up or checked.
    let mut oversized: Vec<(String, String, String)> = Vec::new();
    let lists: Vec<(String, String, Vec<LabCard>)> = lists
        .into_iter()
        .filter_map(|(id, name, cards)| match size_problem(cards.iter().map(|c| (c.name.as_str(), u64::from(c.qty)))) {
            Some(p) => {
                oversized.push((id, name, p));
                None
            }
            None => Some((id, name, normalize(cards))),
        })
        .collect();
    let all_cards: Vec<&[LabCard]> = lists.iter().map(|l| l.2.as_slice()).collect();
    let info = card_info(pool, &all_cards).await?;
    let mut opponents = Vec::new();
    let mut problems = serde_json::Map::new();
    let mut skipped = Vec::new();
    for (id, name, p) in oversized {
        if explicit {
            problems.insert(id, json!({"name": name, "problems": [p]}));
        } else {
            skipped.push(name);
        }
    }
    for (id, name, cards) in lists {
        let mut why = check_list(&cards, &info).blocking;
        // Only a deck that could be simulated is sent to the rules engine.
        if why.is_empty() {
            let unknown = sim.unknown(&cards);
            if !unknown.is_empty() {
                why.push(format!("cards the simulator can't play: {}", unknown.join(", ")));
            }
        }
        if why.is_empty() {
            opponents.push(make_list(&format!("deck/{id}"), &name, json!({"kind": "deck", "id": id}), cards));
        } else if explicit {
            problems.insert(id, json!({"name": name, "problems": why}));
        } else {
            skipped.push(name);
        }
    }
    if !problems.is_empty() {
        return Err(AppError::Invalid { message: "Some of the chosen decks can't be simulated".into(), details: json!({"unplayable_decks": problems}) });
    }
    if !skipped.is_empty() {
        warnings.push(format!("Left out {} of your decks that aren't 100 cards with a commander, or have cards the simulator can't play: {}", skipped.len(), shown(&skipped)));
    }
    let info = FieldInfo {
        kind: choice.kind.clone(),
        n: None,
        ids: choice.ids.clone(),
        every_pod: 0,
        label: format!("{} of your decks", opponents.len()),
        run: None,
        decks: opponents.len(),
    };
    Ok(Field { opponents, info, warnings })
}

fn default_name(base: &str, variant: &VariantDisplay, text_variant: bool) -> String {
    if text_variant {
        return format!("{base} vs a pasted list");
    }
    let line = |sign: &str, c: &LabCard| if c.qty > 1 { format!("{sign}{} {}", c.qty, c.name) } else { format!("{sign}{}", c.name) };
    let mut parts: Vec<String> = variant.cut.iter().map(|c| line("\u{2212}", c)).collect();
    parts.extend(variant.added.iter().map(|c| line("+", c)));
    let mut name = format!("{base}: ");
    for (i, p) in parts.iter().enumerate() {
        if name.chars().count() + p.chars().count() > MAX_NAME - 12 {
            name.push_str(&format!("and {} more", parts.len() - i));
            return name;
        }
        if i > 0 {
            name.push_str(", ");
        }
        name.push_str(p);
    }
    name
}

/// [`create_with`] under the default lab caps (tests; the server passes its configured caps).
#[cfg(test)]
pub async fn create(pool: &SqlitePool, user: &User, req: NewExperiment, sim: &dyn Simulator) -> AppResult<ExperimentDetail> {
    create_with(pool, user, req, sim, &LabQuota::default()).await
}

/// The experiment with this owner's op id, if a create already used it.
async fn by_op_id(pool: &SqlitePool, user: &User, op_id: Option<&str>) -> AppResult<Option<ExperimentDetail>> {
    let Some(op) = op_id else { return Ok(None) };
    if op.len() > 100 {
        return Err(AppError::bad("op_id is too long"));
    }
    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM lab_experiments WHERE owner_id = ? AND op_id = ?").bind(&user.id).bind(op).fetch_optional(pool).await?;
    match existing {
        Some(id) => Ok(Some(detail(pool, &user.id, &id).await?)),
        None => Ok(None),
    }
}

/// Whether `user` may ask for `games` games.
fn check_games(user: &User, games: u32) -> AppResult<()> {
    let ok = if user.is_admin { games >= 2 && games <= ADMIN_MAX_GAMES && games % 2 == 0 } else { game_choices(user).contains(&games) };
    if ok {
        return Ok(());
    }
    Err(AppError::bad(if user.is_admin {
        format!("games must be an even number from 2 to {ADMIN_MAX_GAMES}")
    } else if user.limited {
        "games must be 100 for an account that joined without an invite".to_string()
    } else {
        "games must be 100, 200 or 400".to_string()
    }))
}

/// Names per list as a 400's details: base and variant (and entrants by index, for versus).
fn per_list(per: &[(Which, Vec<String>)]) -> Value {
    let (mut base, mut variant, mut entrants) = (Vec::<String>::new(), Vec::<String>::new(), serde_json::Map::new());
    for (w, v) in per {
        match w {
            Which::Base | Which::DeckA => base.extend(v.iter().cloned()),
            Which::Variant | Which::DeckB => variant.extend(v.iter().cloned()),
            Which::Entrant(i) => {
                entrants.insert(i.to_string(), json!(v));
            }
        }
    }
    let mut out = json!({"base": base, "variant": variant});
    if !entrants.is_empty() {
        out["entrants"] = Value::Object(entrants);
    }
    out
}

/// Refuse lists with cards Yama or the rules engine doesn't know (`known` adds the names a pasted
/// list already couldn't find).
fn refuse_unknown(lists: &[(Which, &LabList, &[String])], sim: &dyn Simulator) -> AppResult<()> {
    let mut per: Vec<(Which, Vec<String>)> = Vec::new();
    for (w, list, known) in lists {
        let mut u: Vec<String> = known.to_vec();
        for n in sim.unknown(&list.cards) {
            if !u.contains(&n) {
                u.push(n);
            }
        }
        per.push((*w, u));
    }
    if per.iter().all(|(_, u)| u.is_empty()) {
        return Ok(());
    }
    let mut all: Vec<String> = Vec::new();
    for n in per.iter().flat_map(|(_, u)| u) {
        if !all.contains(n) {
            all.push(n.clone());
        }
    }
    Err(AppError::Invalid {
        message: format!("These cards can't be simulated (Yama or the rules engine doesn't know them): {}", shown(&all)),
        details: json!({"unknown": per_list(&per)}),
    })
}

/// Refuse lists a game can't be played with (size, commanders).
fn refuse_blocking(checked: &[(Which, &Checked)]) -> AppResult<()> {
    if checked.iter().all(|(_, c)| c.blocking.is_empty()) {
        return Ok(());
    }
    let first: Vec<String> = checked.iter().flat_map(|(w, c)| c.blocking.iter().map(move |e| format!("{}: {e}", w.label()))).collect();
    let per: Vec<(Which, Vec<String>)> = checked.iter().map(|(w, c)| (*w, c.blocking.clone())).collect();
    Err(AppError::Invalid {
        message: format!("A simulated game needs 100 cards and a valid commander. {}", first.join("; ")),
        details: json!({"problems": per_list(&per)}),
    })
}

fn list_display(list: &LabList, checked: &Checked, info: &HashMap<String, Card>) -> ListDisplay {
    let art = list.cards.iter().find(|c| c.commander).and_then(|c| info.get(c.oracle_id.as_deref()?)).and_then(|card| {
        Some(Art { url: card.image_art_crop.clone()?, artist: card.artist.clone(), card: card.name.clone() })
    });
    ListDisplay { label: list.label.clone(), commanders: checked.commanders.clone(), color_identity: checked.color_identity.clone(), art, source: list.source.clone() }
}

/// The opponents some game uses, with how many games (pods) each sits in.
fn used_opponents(field: Vec<LabList>, games: &[pairing::ScheduledGame], per_pod: bool) -> Vec<Opponent> {
    field
        .into_iter()
        .filter_map(|list| {
            let n = games.iter().filter(|g| (!per_pod || g.ord % 2 == 0) && g.spec.decks.contains(&list.id)).count();
            (n > 0).then_some(Opponent { list, pods: n })
        })
        .collect()
}

/// A name of at most MAX_NAME characters.
fn clip(name: &str) -> String {
    name.chars().take(MAX_NAME).collect()
}

/// The field a request asks for, required for every mode but versus with no empty seat.
fn field_choice(req: &NewExperiment) -> AppResult<&FieldChoice> {
    req.field.as_ref().ok_or_else(|| AppError::bad("field is required: choose who the lists play against"))
}

/// An experiment ready to store: its spec, name and games.
struct Built {
    spec: ExperimentSpec,
    name: String,
    games: Vec<pairing::ScheduledGame>,
}

/// Check the request, freeze the lists and the field, schedule the games and store it all. With an
/// `op_id` the owner already used, returns that experiment unchanged.
pub async fn create_with(pool: &SqlitePool, user: &User, req: NewExperiment, sim: &dyn Simulator, quota: &LabQuota) -> AppResult<ExperimentDetail> {
    let op_id = req.op_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    if let Some(d) = by_op_id(pool, user, op_id.as_deref()).await? {
        return Ok(d);
    }
    let mode = Mode::parse(req.mode.as_deref())?;
    check_games(user, req.games)?;
    let difficulty = canonical_difficulty(req.difficulty.as_deref().unwrap_or(DEFAULT_DIFFICULTY))?;
    if !user.is_admin && !USER_DIFFICULTIES.contains(&difficulty.as_str()) {
        return Err(AppError::bad("difficulty must be Easy or Medium"));
    }
    // Refuse a user at the limit before building anything; it is checked again where it counts,
    // in the transaction that stores the experiment.
    check_allowance(&mut *pool.acquire().await?, user, req.games, quota, false).await?;

    let id = new_id();
    let seed = u64::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().expect("8 bytes"));
    let built = match mode {
        Mode::Change => build_change(pool, user, &req, sim, &id, seed, &difficulty).await?,
        Mode::Solo => build_solo(pool, user, &req, sim, &id, seed, &difficulty).await?,
        Mode::Compare => build_compare(pool, user, &req, sim, &id, seed, &difficulty).await?,
        Mode::Versus => build_versus(pool, user, &req, sim, &id, seed, &difficulty).await?,
    };
    let name = req.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).map(clip).unwrap_or(built.name);
    store_new(pool, user, &id, op_id.as_deref(), &name, &built.spec, &built.games, req.games, sim, quota).await
}

async fn build_change(pool: &SqlitePool, user: &User, req: &NewExperiment, sim: &dyn Simulator, id: &str, seed: u64, difficulty: &str) -> AppResult<Built> {
    let base_choice = req.base.as_ref().ok_or_else(|| AppError::bad("base is required"))?;
    let base = base_list(pool, &user.id, base_choice).await?;
    let (variant, variant_unknown, change_problems) = variant_list(pool, &base.list, &req.variant).await?;
    refuse_unknown(&[(Which::Base, &base.list, &base.unknown), (Which::Variant, &variant, &variant_unknown)], sim)?;
    if !change_problems.is_empty() {
        return Err(AppError::Invalid { message: change_problems.join("; "), details: json!({"problems": {"base": [], "variant": change_problems}}) });
    }
    let info = card_info(pool, &[&base.list.cards, &variant.cards]).await?;
    let (cb, cv) = (check_list(&base.list.cards, &info), check_list(&variant.cards, &info));
    refuse_blocking(&[(Which::Base, &cb), (Which::Variant, &cv)])?;
    if base.list.sha256 == variant.sha256 {
        return Err(AppError::bad("The changed list is the same as the base list"));
    }
    let (added, cut) = diff(&base.list.cards, &variant.cards);
    let field = field_for(pool, &user.id, field_choice(req)?, &base, &[], &cb.commanders, sim).await?;
    if field.opponents.len() < MIN_FIELD {
        return Err(AppError::bad(format!("The field needs at least {MIN_FIELD} decks to fill the pods; this one has {}", field.opponents.len())));
    }
    let mut warnings = field.warnings.clone();
    warnings.extend(cb.warnings.iter().map(|w| format!("Base list: {w}")));
    warnings.extend(cv.warnings.iter().filter(|w| !cb.warnings.contains(w)).map(|w| format!("Changed list: {w}")));
    let text_variant = req.variant.text.is_some();
    let variant_display = VariantDisplay { label: variant.label.clone(), added, cut };
    let name = default_name(&base.list.label, &variant_display, text_variant);
    let pods = (req.games / 2) as usize;
    let templates = pairing::templates_with(field.opponents.len(), field.info.every_pod, pods, seed);
    let field_ids: Vec<String> = field.opponents.iter().map(|o| o.id.clone()).collect();
    let games = pairing::schedule(&id[..8], &templates, &field_ids, difficulty, &LIMITS);
    // Opponents no pod uses aren't stored (a big field with few pods).
    let opponents = used_opponents(field.opponents, &games, true);
    let spec = ExperimentSpec {
        version: 1,
        mode: Mode::Change,
        seed,
        pod: POD,
        pods,
        difficulty: difficulty.to_string(),
        limits: LIMITS,
        display: Display { mode: Mode::Change, base: list_display(&base.list, &cb, &info), variant: Some(variant_display), entrants: vec![], field: field.info },
        base: base.list,
        variant: Some(variant),
        entrants: vec![],
        opponents,
        warnings,
    };
    Ok(Built { spec, name, games })
}

async fn build_solo(pool: &SqlitePool, user: &User, req: &NewExperiment, sim: &dyn Simulator, id: &str, seed: u64, difficulty: &str) -> AppResult<Built> {
    let base_choice = req.base.as_ref().ok_or_else(|| AppError::bad("base is required"))?;
    let base = base_list(pool, &user.id, base_choice).await?;
    refuse_unknown(&[(Which::Base, &base.list, &base.unknown)], sim)?;
    let info = card_info(pool, &[&base.list.cards]).await?;
    let cb = check_list(&base.list.cards, &info);
    refuse_blocking(&[(Which::Base, &cb)])?;
    let field = field_for(pool, &user.id, field_choice(req)?, &base, &[], &cb.commanders, sim).await?;
    if field.opponents.len() < MIN_FIELD {
        return Err(AppError::bad(format!("The field needs at least {MIN_FIELD} decks to fill the pods; this one has {}", field.opponents.len())));
    }
    let mut warnings = field.warnings.clone();
    warnings.extend(cb.warnings.iter().map(|w| format!("The list: {w}")));
    let pods = req.games as usize;
    let templates = pairing::templates_with(field.opponents.len(), field.info.every_pod, pods, seed);
    let field_ids: Vec<String> = field.opponents.iter().map(|o| o.id.clone()).collect();
    let games = pairing::schedule_solo(&id[..8], &templates, &field_ids, difficulty, &LIMITS);
    let opponents = used_opponents(field.opponents, &games, false);
    let name = clip(&format!("{} as it is", base.list.label));
    let spec = ExperimentSpec {
        version: 1,
        mode: Mode::Solo,
        seed,
        pod: POD,
        pods,
        difficulty: difficulty.to_string(),
        limits: LIMITS,
        display: Display { mode: Mode::Solo, base: list_display(&base.list, &cb, &info), variant: None, entrants: vec![], field: field.info },
        base: base.list,
        variant: None,
        entrants: vec![],
        opponents,
        warnings,
    };
    Ok(Built { spec, name, games })
}

async fn build_compare(pool: &SqlitePool, user: &User, req: &NewExperiment, sim: &dyn Simulator, id: &str, seed: u64, difficulty: &str) -> AppResult<Built> {
    let a_choice = req.base.as_ref().ok_or_else(|| AppError::bad("base is required: the first deck"))?;
    let b_choice = req.other.as_ref().ok_or_else(|| AppError::bad("other is required: the second deck"))?;
    let a = pick_list(pool, &user.id, a_choice, BASE_ID, Which::DeckA).await?;
    let b = pick_list(pool, &user.id, b_choice, VARIANT_ID, Which::DeckB).await?;
    refuse_unknown(&[(Which::DeckA, &a.list, &a.unknown), (Which::DeckB, &b.list, &b.unknown)], sim)?;
    let info = card_info(pool, &[&a.list.cards, &b.list.cards]).await?;
    let (ca, cb) = (check_list(&a.list.cards, &info), check_list(&b.list.cards, &info));
    refuse_blocking(&[(Which::DeckA, &ca), (Which::DeckB, &cb)])?;
    if a.list.sha256 == b.list.sha256 {
        return Err(AppError::bad("The two decks are the same list; pick two different decks"));
    }
    let field = field_for(pool, &user.id, field_choice(req)?, &a, &[&b], &ca.commanders, sim).await?;
    if field.opponents.len() < MIN_FIELD {
        return Err(AppError::bad(format!("The field needs at least {MIN_FIELD} decks to fill the pods; this one has {}", field.opponents.len())));
    }
    let mut warnings = field.warnings.clone();
    warnings.extend(ca.warnings.iter().map(|w| format!("{}: {w}", a.list.label)));
    warnings.extend(cb.warnings.iter().map(|w| format!("{}: {w}", b.list.label)));
    let pods = (req.games / 2) as usize;
    let templates = pairing::templates_with(field.opponents.len(), field.info.every_pod, pods, seed);
    let field_ids: Vec<String> = field.opponents.iter().map(|o| o.id.clone()).collect();
    let games = pairing::schedule(&id[..8], &templates, &field_ids, difficulty, &LIMITS);
    let opponents = used_opponents(field.opponents, &games, true);
    let (da, db) = (list_display(&a.list, &ca, &info), list_display(&b.list, &cb, &info));
    let name = clip(&format!("{} vs {}", a.list.label, b.list.label));
    let spec = ExperimentSpec {
        version: 1,
        mode: Mode::Compare,
        seed,
        pod: POD,
        pods,
        difficulty: difficulty.to_string(),
        limits: LIMITS,
        display: Display {
            mode: Mode::Compare,
            base: da.clone(),
            variant: Some(VariantDisplay { label: b.list.label.clone(), added: vec![], cut: vec![] }),
            entrants: vec![da, db],
            field: field.info,
        },
        base: a.list,
        variant: Some(b.list),
        entrants: vec![],
        opponents,
        warnings,
    };
    Ok(Built { spec, name, games })
}

async fn build_versus(pool: &SqlitePool, user: &User, req: &NewExperiment, sim: &dyn Simulator, id: &str, seed: u64, difficulty: &str) -> AppResult<Built> {
    let n = req.entrants.len();
    if !(MIN_ENTRANTS..=MAX_ENTRANTS).contains(&n) {
        return Err(AppError::bad(format!("entrants: pick {MIN_ENTRANTS} to {MAX_ENTRANTS} decks to play each other")));
    }
    let pod = req.pod.unwrap_or(POD);
    if pod != POD && pod != 2 {
        return Err(AppError::bad("pod must be 4, or 2 for 1v1"));
    }
    if pod == 2 && n != 2 {
        return Err(AppError::bad("1v1 needs exactly two decks"));
    }
    let mut lists: Vec<Base> = Vec::with_capacity(n);
    for (i, c) in req.entrants.iter().enumerate() {
        lists.push(pick_list(pool, &user.id, c, &format!("e{i}"), Which::Entrant(i)).await?);
    }
    let unknown_input: Vec<(Which, &LabList, &[String])> = lists.iter().enumerate().map(|(i, b)| (Which::Entrant(i), &b.list, b.unknown.as_slice())).collect();
    refuse_unknown(&unknown_input, sim)?;
    let all_cards: Vec<&[LabCard]> = lists.iter().map(|b| b.list.cards.as_slice()).collect();
    let info = card_info(pool, &all_cards).await?;
    let checked: Vec<Checked> = lists.iter().map(|b| check_list(&b.list.cards, &info)).collect();
    let blocking_input: Vec<(Which, &Checked)> = checked.iter().enumerate().map(|(i, c)| (Which::Entrant(i), c)).collect();
    refuse_blocking(&blocking_input)?;
    for i in 0..n {
        for j in i + 1..n {
            if lists[i].list.sha256 == lists[j].list.sha256 {
                return Err(AppError::bad(format!("Deck {} and deck {} are the same list; pick different decks", i + 1, j + 1)));
            }
        }
    }
    let need = pod - n;
    let mut warnings = Vec::new();
    let (fillers, field_info) = if need > 0 {
        let choice = req.field.as_ref().ok_or_else(|| AppError::bad("field is required: choose the precons that fill the empty seats"))?;
        let others: Vec<&Base> = lists[1..].iter().collect();
        let field = build_field(pool, &user.id, choice, &lists[0], &others, &checked[0].commanders, sim).await?;
        if field.opponents.len() < need {
            return Err(AppError::bad(format!("The field needs at least {need} decks to fill the empty seats; this one has {}", field.opponents.len())));
        }
        warnings.extend(field.warnings.clone());
        (field.opponents, field.info)
    } else {
        (vec![], FieldInfo { kind: "none".into(), n: None, ids: vec![], every_pod: 0, label: "No other decks".into(), run: None, decks: 0 })
    };
    for (b, c) in lists.iter().zip(&checked) {
        warnings.extend(c.warnings.iter().map(|w| format!("{}: {w}", b.list.label)));
    }
    let entrant_ids: Vec<String> = lists.iter().map(|b| b.list.id.clone()).collect();
    let filler_ids: Vec<String> = fillers.iter().map(|o| o.id.clone()).collect();
    let games = pairing::schedule_versus(&id[..8], &entrant_ids, &filler_ids, pod, req.games as usize, seed, difficulty, &LIMITS);
    let opponents = used_opponents(fillers, &games, false);
    let displays: Vec<ListDisplay> = lists.iter().zip(&checked).map(|(b, c)| list_display(&b.list, c, &info)).collect();
    let labels: Vec<&str> = lists.iter().map(|b| b.list.label.as_str()).collect();
    let name = clip(&labels.join(" vs "));
    let entrants: Vec<LabList> = lists.into_iter().map(|b| b.list).collect();
    let spec = ExperimentSpec {
        version: 1,
        mode: Mode::Versus,
        seed,
        pod,
        pods: req.games as usize,
        difficulty: difficulty.to_string(),
        limits: LIMITS,
        display: Display { mode: Mode::Versus, base: displays[0].clone(), variant: None, entrants: displays, field: field_info },
        base: entrants[0].clone(),
        variant: None,
        entrants,
        opponents,
        warnings,
    };
    Ok(Built { spec, name, games })
}

/// Store a new experiment, its usage and its games in one transaction, after the op id and the
/// limits are checked again inside it.
#[allow(clippy::too_many_arguments)]
async fn store_new(
    pool: &SqlitePool,
    user: &User,
    id: &str,
    op_id: Option<&str>,
    name: &str,
    spec: &ExperimentSpec,
    games: &[pairing::ScheduledGame],
    total: u32,
    sim: &dyn Simulator,
    quota: &LabQuota,
) -> AppResult<ExperimentDetail> {
    debug_assert_eq!(games.len(), total as usize);
    let stamp = now();
    let mut tx = pool.begin().await?;
    // Writing first takes SQLite's write lock: a concurrent create by the same owner waits, so the
    // op id and the limit below are checked one request at a time.
    let inserted = sqlx::query(
        "INSERT INTO lab_experiments (id, owner_id, op_id, name, kind, status, spec, games_total, games_done, engine, card_data, runner, difficulty,
            created_at, updated_at)
         VALUES (?,?,?,?, 'paired', 'queued', ?,?, 0, ?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(&user.id)
    .bind(op_id)
    .bind(name)
    .bind(serde_json::to_string(spec).map_err(anyhow::Error::from)?)
    .bind(i64::from(total))
    .bind(ENGINE)
    .bind(sim.card_data())
    .bind(RUNNER)
    .bind(&spec.difficulty)
    .bind(&stamp)
    .bind(&stamp)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if inserted == 0 {
        // The same op id, committed by a concurrent request after the check above.
        drop(tx);
        let id: String = sqlx::query_scalar("SELECT id FROM lab_experiments WHERE owner_id = ? AND op_id = ?").bind(&user.id).bind(op_id).fetch_one(pool).await?;
        return detail(pool, &user.id, &id).await;
    }
    check_allowance(&mut tx, user, total, quota, true).await?;
    sqlx::query("INSERT INTO lab_usage (experiment_id, owner_id, games, created_at) VALUES (?,?,?,?)")
        .bind(id)
        .bind(&user.id)
        .bind(i64::from(total))
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
    const COLS: usize = 4;
    const CHUNK: usize = 200;
    for chunk in games.chunks(CHUNK) {
        let placeholders = vec!["(?,?,?,?)"; chunk.len()].join(",");
        debug_assert_eq!(placeholders.matches('?').count(), chunk.len() * COLS);
        let sql = format!("INSERT INTO lab_experiment_games (experiment_id, game, ord, spec) VALUES {placeholders}");
        // Only placeholders are interpolated; every value is bound.
        let mut q = sqlx::query(AssertSqlSafe(sql));
        for g in chunk {
            q = q.bind(id).bind(&g.game).bind(g.ord).bind(serde_json::to_string(&g.spec).map_err(anyhow::Error::from)?);
        }
        q.execute(&mut *tx).await?;
    }
    tx.commit().await?;
    detail(pool, &user.id, id).await
}

/// A run's name without a " (N games)" ending that an earlier "again" added.
fn without_games_suffix(name: &str) -> &str {
    if let Some(at) = name.rfind(" (")
        && let Some(n) = name[at + 2..].strip_suffix(" games)")
        && !n.is_empty()
        && n.chars().all(|c| c.is_ascii_digit())
    {
        return &name[..at];
    }
    name
}

/// [`again_with`] under the default lab caps (tests).
#[cfg(test)]
pub async fn again(pool: &SqlitePool, user: &User, id: &str, games: u32, op_id: Option<&str>, sim: &dyn Simulator) -> AppResult<ExperimentDetail> {
    again_with(pool, user, id, games, op_id, sim, &LabQuota::default()).await
}

/// Run one of the owner's experiments again with `games` games: the same frozen lists, opponents,
/// AI level and mode, a new seed. Anyone else's experiment is "not found".
pub async fn again_with(pool: &SqlitePool, user: &User, id: &str, games: u32, op_id: Option<&str>, sim: &dyn Simulator, quota: &LabQuota) -> AppResult<ExperimentDetail> {
    let op_id = op_id.map(str::trim).filter(|s| !s.is_empty());
    if let Some(d) = by_op_id(pool, user, op_id).await? {
        return Ok(d);
    }
    let (old_name, text): (String, String) = sqlx::query_as("SELECT name, spec FROM lab_experiments WHERE id = ? AND owner_id = ?")
        .bind(id)
        .bind(&user.id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("experiment"))?;
    check_games(user, games)?;
    let old: ExperimentSpec = serde_json::from_str(&text).map_err(anyhow::Error::from)?;
    if !user.is_admin && !USER_DIFFICULTIES.contains(&old.difficulty.as_str()) {
        return Err(AppError::bad("difficulty must be Easy or Medium"));
    }
    check_allowance(&mut *pool.acquire().await?, user, games, quota, false).await?;
    // The engine may have changed since: every list must still be playable.
    let mut tested: Vec<(Which, &LabList, &[String])> = vec![];
    match old.mode {
        Mode::Versus => tested.extend(old.entrants.iter().enumerate().map(|(i, l)| (Which::Entrant(i), l, &[][..]))),
        _ => {
            tested.push((Which::Base, &old.base, &[]));
            if let Some(v) = &old.variant {
                tested.push((Which::Variant, v, &[]));
            }
        }
    }
    refuse_unknown(&tested, sim)?;
    let field: Vec<LabList> = old.opponents.iter().map(|o| o.list.clone()).collect();
    let unplayable: Vec<String> = field.iter().filter(|l| !sim.unknown(&l.cards).is_empty()).map(|l| l.label.clone()).collect();
    if !unplayable.is_empty() {
        return Err(AppError::bad(format!("Some opponents now have cards the simulator can't play: {}", shown(&unplayable))));
    }
    let new_id = new_id();
    let seed = u64::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().expect("8 bytes"));
    let field_ids: Vec<String> = field.iter().map(|l| l.id.clone()).collect();
    // Decks kept in every pod are stored first, and every game uses them, so they're all still here.
    let every = old.display.field.every_pod.min(field.len()).min(POD - 1);
    let (pods, scheduled) = match old.mode {
        Mode::Change | Mode::Compare | Mode::Solo => {
            if field.len() < MIN_FIELD {
                return Err(AppError::bad("This run's field is too small to fill new pods; start a new run instead"));
            }
            if old.mode == Mode::Solo {
                let templates = pairing::templates_with(field.len(), every, games as usize, seed);
                (games as usize, pairing::schedule_solo(&new_id[..8], &templates, &field_ids, &old.difficulty, &LIMITS))
            } else {
                let pods = (games / 2) as usize;
                let templates = pairing::templates_with(field.len(), every, pods, seed);
                (pods, pairing::schedule(&new_id[..8], &templates, &field_ids, &old.difficulty, &LIMITS))
            }
        }
        Mode::Versus => {
            let entrant_ids: Vec<String> = old.entrants.iter().map(|l| l.id.clone()).collect();
            if field.len() < old.pod.saturating_sub(entrant_ids.len()) {
                return Err(AppError::bad("This run's field is too small to fill new pods; start a new run instead"));
            }
            (games as usize, pairing::schedule_versus(&new_id[..8], &entrant_ids, &field_ids, old.pod, games as usize, seed, &old.difficulty, &LIMITS))
        }
    };
    let per_pod = matches!(old.mode, Mode::Change | Mode::Compare);
    let spec = ExperimentSpec { seed, pods, opponents: used_opponents(field, &scheduled, per_pod), limits: LIMITS, ..old };
    let suffix = format!(" ({games} games)");
    let stem = without_games_suffix(&old_name);
    let name = format!("{}{suffix}", stem.chars().take(MAX_NAME.saturating_sub(suffix.chars().count())).collect::<String>());
    store_new(pool, user, &new_id, op_id, &name, &spec, &scheduled, games, sim, quota).await
}

/// The owner's queued and running experiments.
async fn unfinished<'c>(conn: impl sqlx::SqliteExecutor<'c>, owner: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiments WHERE owner_id = ? AND status IN ('queued','running')").bind(owner).fetch_one(conn).await?)
}

fn at_limit() -> AppError {
    AppError::Conflict("You can have one experiment playing and two waiting. Wait for one to finish, or cancel one.".into())
}

/// Games an account asked for in the last 24 hours, deleted experiments included.
async fn games_today(conn: &mut SqliteConnection, owner: &str) -> AppResult<i64> {
    let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    Ok(sqlx::query_scalar("SELECT COALESCE(SUM(games), 0) FROM lab_usage WHERE owner_id = ? AND created_at > ?")
        .bind(owner)
        .bind(since)
        .fetch_one(conn)
        .await?)
}

/// Refuse a new experiment of `games` that would take `user` past their allowance, or the lab past
/// its queue caps. `stored`: the experiment row is already written in this transaction (so it
/// counts as unfinished) but its games aren't yet.
async fn check_allowance(conn: &mut SqliteConnection, user: &User, games: u32, quota: &LabQuota, stored: bool) -> AppResult<()> {
    if user.is_admin {
        return Ok(());
    }
    let games = i64::from(games);
    let unfinished = unfinished(&mut *conn, &user.id).await? - i64::from(stored);
    if user.limited {
        if unfinished >= OPEN_MAX_UNFINISHED {
            return Err(AppError::Conflict(
                "Accounts that joined without an invite run one experiment at a time. Wait for yours to finish, or cancel it.".into(),
            ));
        }
        let used = games_today(&mut *conn, &user.id).await?;
        if used + games > quota.open_daily_games {
            return Err(AppError::Conflict(format!(
                "Accounts that joined without an invite can run {} games a day, and you've asked for {used} in the last 24 hours. Try again later.",
                quota.open_daily_games
            )));
        }
    } else if unfinished >= MAX_UNFINISHED {
        return Err(at_limit());
    }
    let (all, open): (i64, i64) = sqlx::query_as(concat!(
        "SELECT COUNT(*), COALESCE(SUM(limited), 0) FROM (SELECT ",
        crate::auth::limited_sql!(),
        " AS limited FROM lab_experiment_games g JOIN lab_experiments e ON e.id = g.experiment_id JOIN users u ON u.id = e.owner_id
           WHERE e.status IN ('queued','running') AND g.result IS NULL AND u.is_admin = 0)"
    ))
    .fetch_one(&mut *conn)
    .await?;
    let busy = || AppError::Conflict("The lab has too many games waiting right now. Try again later.".into());
    if user.limited && open + games > quota.open_queue_games {
        return Err(busy());
    }
    if all + games > quota.queue_games {
        return Err(busy());
    }
    Ok(())
}

/// The smaller allowance of an account that joined without an invite, as the Try page shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Allowance {
    /// Games in one experiment.
    pub games: u32,
    /// Experiments at once.
    pub at_a_time: i64,
    pub games_per_day: i64,
    /// Games asked for in the last 24 hours.
    pub used_today: i64,
}

pub async fn allowance(pool: &SqlitePool, user: &User, quota: &LabQuota) -> AppResult<Option<Allowance>> {
    if !user.limited || user.is_admin {
        return Ok(None);
    }
    let used_today = games_today(&mut *pool.acquire().await?, &user.id).await?;
    Ok(Some(Allowance { games: OPEN_GAME_CHOICES[0], at_a_time: OPEN_MAX_UNFINISHED, games_per_day: quota.open_daily_games, used_today }))
}

/// "easy" -> "Easy", as the engine names its levels; unknown levels are refused.
fn canonical_difficulty(label: &str) -> AppResult<String> {
    let probe = GameSpec {
        game: "probe".into(),
        seed: 0,
        decks: vec!["a".into(), "b".into()],
        difficulty: label.trim().to_string(),
        max_turns: 1,
        max_actions: 1,
        max_seconds: 1,
    };
    let d = probe.check().map_err(|_| AppError::bad(format!("unknown difficulty {label:?}")))?;
    Ok(format!("{d:?}"))
}

// ── reading ─────────────────────────────────────────────────────────────────

/// What every simulated number in an experiment is shown with.
#[derive(Debug, Clone, Serialize)]
pub struct SimLabel {
    pub simulated: bool,
    /// Engine, card data and runner of the games stored so far, from their result lines (each
    /// value once, in order of first use, joined with ", " when the server changed part way).
    /// Until a game is in: the build the experiment was created on.
    pub engine: String,
    pub card_data: String,
    pub runner: String,
    /// Every build that played a stored game, with its games (empty until a game is in).
    pub builds: Vec<BuildGames>,
    pub difficulty: String,
    pub games: i64,
    pub pod: usize,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub done: i64,
    pub total: i64,
    /// Seconds until this experiment's last game should be in, from the lab's recent pace: in
    /// whole minutes for admins, rounded up to ROUGH_SECONDS for anyone else (see `Pace`); null
    /// until a few games have finished, and once it's over.
    pub eta_seconds: Option<i64>,
    /// Games earlier experiments (anyone's) still have to play before this one's turn (FIFO).
    /// Admins only: for anyone else it is null, because it would show other users' queues.
    pub games_ahead: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExperimentItem {
    pub id: String,
    pub name: String,
    /// queued, running, done, failed or cancelled.
    pub status: String,
    pub error: Option<String>,
    pub label: SimLabel,
    pub progress: Progress,
    /// change, compare, solo or versus.
    pub mode: Mode,
    pub base: Option<ListDisplay>,
    pub variant: Option<VariantDisplay>,
    /// compare: the two decks; versus: every deck. Empty otherwise.
    pub entrants: Vec<ListDisplay>,
    pub field: Option<FieldInfo>,
    /// Results so far (null until the first game is in).
    pub summary: Option<Summary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExperimentDetail {
    #[serde(flatten)]
    pub item: ExperimentItem,
    pub lists: Lists,
    pub opponents: Vec<OpponentView>,
    pub warnings: Vec<String>,
    pub seed: u64,
    pub limits: Limits,
}

#[derive(Debug, Clone, Serialize)]
pub struct Lists {
    pub base: LabList,
    /// change and compare only.
    pub variant: Option<LabList>,
    /// versus: every list.
    pub entrants: Vec<LabList>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpponentView {
    pub id: String,
    pub label: String,
    pub source: Value,
    pub sha256: String,
    pub pods: usize,
}

#[derive(sqlx::FromRow)]
struct ExpRow {
    id: String,
    name: String,
    status: String,
    games_total: i64,
    games_done: i64,
    engine: String,
    card_data: String,
    runner: String,
    difficulty: String,
    summary: Option<String>,
    error: Option<String>,
    created_at: String,
    started_at: Option<String>,
    finished_at: Option<String>,
    updated_at: String,
    display: Option<String>,
}

const EXP_COLUMNS: &str = "e.id, e.name, e.status, e.games_total, e.games_done, e.engine, e.card_data, e.runner, e.difficulty, e.summary, \
    e.error, e.created_at, e.started_at, e.finished_at, e.updated_at, json_extract(e.spec, '$.display') AS display";

/// The lab's queue as `viewer` may see it: its recent pace and, per unfinished experiment, the
/// games ahead of it and its own.
struct Queue {
    /// Games per second over the last finished games, when recent.
    rate: Option<f64>,
    ahead: HashMap<String, (i64, i64)>,
    /// Whether the viewer may see games_ahead (it counts other users' games).
    admin: bool,
}

async fn queue(pool: &SqlitePool, viewer: &str) -> AppResult<Queue> {
    let admin: bool = sqlx::query_scalar("SELECT is_admin FROM users WHERE id = ?").bind(viewer).fetch_optional(pool).await?.unwrap_or(false);
    let (rate, _) = recent_rate(pool).await?;
    let pending: Vec<(String, i64)> = sqlx::query_as(
        "SELECT e.id, (SELECT COUNT(*) FROM lab_experiment_games g WHERE g.experiment_id = e.id AND g.result IS NULL)
         FROM lab_experiments e WHERE e.status IN ('queued','running') ORDER BY e.created_at, e.rowid",
    )
    .fetch_all(pool)
    .await?;
    let mut ahead = HashMap::new();
    let mut before = 0;
    for (id, own) in pending {
        ahead.insert(id, (before, own));
        before += own;
    }
    Ok(Queue { rate, ahead, admin })
}

/// The lab's games per second over its last finished games (all threads together), when at least
/// four finished and the newest within the last hour; and how many games it was measured on.
async fn recent_rate(pool: &SqlitePool) -> AppResult<(Option<f64>, usize)> {
    // Only experiments touched in the last hour can have recent games, so the pace never scans the
    // whole lab's history. Games they finished earlier (before a restart, say) don't count.
    let since = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let times: Vec<String> = sqlx::query_scalar(
        "SELECT g.finished_at FROM lab_experiment_games g
         WHERE g.experiment_id IN (SELECT id FROM lab_experiments WHERE updated_at >= ?) AND g.finished_at >= ?
         ORDER BY g.finished_at DESC LIMIT 40",
    )
    .bind(&since)
    .bind(&since)
    .fetch_all(pool)
    .await?;
    let parsed: Vec<chrono::DateTime<chrono::Utc>> =
        times.iter().filter_map(|t| chrono::DateTime::parse_from_rfc3339(t).ok().map(|d| d.with_timezone(&chrono::Utc))).collect();
    let rate = match (parsed.first(), parsed.last()) {
        (Some(newest), Some(oldest)) if parsed.len() >= 4 && chrono::Utc::now() - *newest < chrono::Duration::hours(1) => {
            let span = (*newest - *oldest).num_milliseconds() as f64 / 1000.0;
            (span > 0.0).then(|| (parsed.len() - 1) as f64 / span)
        }
        _ => None,
    };
    Ok((rate, if rate.is_some() { parsed.len() } else { 0 }))
}

/// Distinct values in order of first use, joined with ", ".
fn joined<'a>(values: impl Iterator<Item = &'a str>) -> String {
    let mut out: Vec<&str> = Vec::new();
    for v in values {
        if !out.contains(&v) {
            out.push(v);
        }
    }
    out.join(", ")
}

impl ExpRow {
    fn item(self, q: &Queue) -> ExperimentItem {
        let display: Option<Display> = self.display.as_deref().and_then(|d| serde_json::from_str(d).ok());
        let (games_ahead, eta) = match q.ahead.get(&self.id) {
            Some((before, own)) => {
                let eta = q.rate.map(|r| round_up((before + own) as f64 / r, time_step(q.admin)));
                (q.admin.then_some(*before), eta)
            }
            None => (None, None),
        };
        let summary: Option<Summary> = self.summary.as_deref().and_then(|s| serde_json::from_str(s).ok());
        let builds = summary.as_ref().map(|s| s.builds.clone()).unwrap_or_default();
        let (engine, card_data, runner) = if builds.is_empty() {
            (self.engine, self.card_data, self.runner)
        } else {
            (
                joined(builds.iter().map(|b| b.build.engine.as_str())),
                joined(builds.iter().map(|b| b.build.card_data.as_str())),
                joined(builds.iter().map(|b| b.build.runner.as_str())),
            )
        };
        ExperimentItem {
            label: SimLabel {
                simulated: true,
                engine,
                card_data,
                runner,
                builds,
                difficulty: self.difficulty,
                games: self.games_total,
                pod: POD,
                created_at: self.created_at,
                started_at: self.started_at,
                finished_at: self.finished_at,
                updated_at: self.updated_at,
            },
            progress: Progress { done: self.games_done, total: self.games_total, eta_seconds: eta, games_ahead },
            summary,
            mode: display.as_ref().map(|d| d.mode).unwrap_or_default(),
            base: display.as_ref().map(|d| d.base.clone()),
            variant: display.as_ref().and_then(|d| d.variant.clone()),
            entrants: display.as_ref().map(|d| d.entrants.clone()).unwrap_or_default(),
            field: display.map(|d| d.field),
            id: self.id,
            name: self.name,
            status: self.status,
            error: self.error,
        }
    }
}

/// The owner's experiments, newest first.
pub async fn list(pool: &SqlitePool, owner: &str) -> AppResult<Vec<ExperimentItem>> {
    let rows: Vec<ExpRow> = sqlx::query_as(AssertSqlSafe(format!("SELECT {EXP_COLUMNS} FROM lab_experiments e WHERE e.owner_id = ? ORDER BY e.created_at DESC, e.rowid DESC")))
        .bind(owner)
        .fetch_all(pool)
        .await?;
    let q = queue(pool, owner).await?;
    Ok(rows.into_iter().map(|r| r.item(&q)).collect())
}

/// One of the owner's experiments; anyone else's is "not found".
pub async fn detail(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<ExperimentDetail> {
    let row: ExpRow = sqlx::query_as(AssertSqlSafe(format!("SELECT {EXP_COLUMNS} FROM lab_experiments e WHERE e.id = ? AND e.owner_id = ?")))
        .bind(id)
        .bind(owner)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("experiment"))?;
    let spec: String = sqlx::query_scalar("SELECT spec FROM lab_experiments WHERE id = ? AND owner_id = ?").bind(id).bind(owner).fetch_one(pool).await?;
    let spec: ExperimentSpec = serde_json::from_str(&spec).map_err(anyhow::Error::from)?;
    let q = queue(pool, owner).await?;
    Ok(ExperimentDetail {
        item: row.item(&q),
        opponents: spec
            .opponents
            .iter()
            .map(|o| OpponentView { id: o.list.id.clone(), label: o.list.label.clone(), source: o.list.source.clone(), sha256: o.list.sha256.clone(), pods: o.pods })
            .collect(),
        lists: Lists { base: spec.base, variant: spec.variant, entrants: spec.entrants },
        warnings: spec.warnings,
        seed: spec.seed,
        limits: spec.limits,
    })
}

/// Stop an experiment's remaining games from starting. Games already playing finish and are kept.
/// Cancelling again, or cancelling a finished experiment, changes nothing. `playing` says whether
/// a game of an experiment is claimed or playing now (the worker's [`LabWorker::playing`]): the
/// summary is final at once when none is, and otherwise when the last one is in.
///
/// [`LabWorker::playing`]: super::worker::LabWorker::playing
pub async fn cancel(pool: &SqlitePool, owner: &str, id: &str, playing: &(dyn Fn(&str) -> bool + Sync)) -> AppResult<ExperimentDetail> {
    let stamp = now();
    // One immediate transaction: it waits for a result being stored and recounts with that result
    // in, and a result stored after it sees the cancel.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let changed = sqlx::query(
        "UPDATE lab_experiments SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status IN ('queued','running')",
    )
    .bind(&stamp)
    .bind(&stamp)
    .bind(id)
    .bind(owner)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if changed > 0 {
        super::worker::refresh(&mut tx, id, !playing(id)).await?;
    }
    tx.commit().await?;
    detail(pool, owner, id).await
}

/// Delete one of the owner's experiments and its games. Results of games still playing are dropped
/// when they come in.
pub async fn delete(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<()> {
    let n = sqlx::query("DELETE FROM lab_experiments WHERE id = ? AND owner_id = ?").bind(id).bind(owner).execute(pool).await?.rows_affected();
    if n == 0 { Err(AppError::NotFound("experiment")) } else { Ok(()) }
}

// ── games by pod, and the lab's pace ────────────────────────────────────────

/// One played game of a pod, as the run page lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GameView {
    pub game: String,
    /// win, draw, turn_cap, action_cap, time_cap, panic or error.
    pub end: String,
    /// Whether the game counts in the summary: false for time caps, panics and errors.
    pub scored: bool,
    /// Whether the tested list won.
    pub won: bool,
    /// The tested list's finishing place in a scored game (1 = first; tied players share the mean
    /// of their places).
    pub place: Option<f64>,
    pub turns: u32,
    pub seconds: f64,
    pub error: Option<String>,
    pub finished_at: Option<String>,
}

/// One pod: the same opponents, seats and shuffle for both lists.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PodView {
    /// 1-based, in play order.
    pub pod: usize,
    /// The tested list's seat (0 takes the first turn).
    pub seat: u8,
    /// Seat by seat: the opponent's label, or null for the tested list's seat.
    pub seats: Vec<Option<String>>,
    /// Null until that game is played.
    pub base: Option<GameView>,
    pub variant: Option<GameView>,
    /// Head to head (mode "versus"): the one game of this row, every seat named in `seats`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game: Option<VersusGame>,
}

/// One game of a head-to-head experiment.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VersusGame {
    pub game: String,
    pub end: String,
    pub scored: bool,
    /// The winner's label (an entrant's or a filler precon's); null for no winner or unplayed.
    pub winner: Option<String>,
    /// Finishing place per seat in a scored game (tied players share the mean of their places).
    pub places: Vec<Option<f64>>,
    pub turns: u32,
    pub seconds: f64,
    pub error: Option<String>,
    pub finished_at: Option<String>,
}

fn game_view(game: &str, seat: u8, result: &str, finished_at: Option<String>) -> GameView {
    match serde_json::from_str::<yama_play::lab::GameResult>(result) {
        Ok(r) => {
            let scored = matches!(r.end, yama_play::lab::End::Win | yama_play::lab::End::Draw | yama_play::lab::End::TurnCap | yama_play::lab::End::ActionCap);
            let place = if scored { super::stats::placement_ranks(&r.placements).get(&seat).copied() } else { None };
            GameView {
                game: game.into(),
                end: r.end.as_str().into(),
                // A scored end without the seat placed is malformed and isn't scored (as in stats).
                scored: scored && place.is_some(),
                won: place.is_some() && r.winner == Some(seat),
                place,
                turns: r.turns,
                seconds: r.ms as f64 / 1000.0,
                error: r.error,
                finished_at,
            }
        }
        Err(e) => GameView {
            game: game.into(),
            end: "error".into(),
            scored: false,
            won: false,
            place: None,
            turns: 0,
            seconds: 0.0,
            error: Some(format!("unreadable result line: {e}")),
            finished_at,
        },
    }
}

fn versus_game(game: &str, seats: &[Option<String>], result: &str, finished_at: Option<String>) -> VersusGame {
    match serde_json::from_str::<yama_play::lab::GameResult>(result) {
        Ok(r) => {
            let scored = matches!(r.end, yama_play::lab::End::Win | yama_play::lab::End::Draw | yama_play::lab::End::TurnCap | yama_play::lab::End::ActionCap);
            let ranks = super::stats::placement_ranks(&r.placements);
            VersusGame {
                game: game.into(),
                end: r.end.as_str().into(),
                scored,
                winner: r.winner.and_then(|w| seats.get(usize::from(w)).cloned().flatten()),
                places: (0..seats.len()).map(|s| if scored { ranks.get(&(s as u8)).copied() } else { None }).collect(),
                turns: r.turns,
                seconds: r.ms as f64 / 1000.0,
                error: r.error,
                finished_at,
            }
        }
        Err(e) => VersusGame {
            game: game.into(),
            end: "error".into(),
            scored: false,
            winner: None,
            places: vec![None; seats.len()],
            turns: 0,
            seconds: 0.0,
            error: Some(format!("unreadable result line: {e}")),
            finished_at,
        },
    }
}

/// The owner's experiment game by game, pod by pod (base and changed list side by side); anyone
/// else's is "not found".
pub async fn pods(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<Vec<PodView>> {
    let labels: Vec<(String, String)> = sqlx::query_as(
        "SELECT json_extract(o.value, '$.id'), json_extract(o.value, '$.label')
         FROM lab_experiments e, json_each(e.spec, '$.opponents') o WHERE e.id = ? AND e.owner_id = ?
         UNION ALL
         SELECT json_extract(o.value, '$.id'), json_extract(o.value, '$.label')
         FROM lab_experiments e, json_each(e.spec, '$.entrants') o WHERE e.id = ? AND e.owner_id = ?",
    )
    .bind(id)
    .bind(owner)
    .bind(id)
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let mode: Option<Option<String>> =
        sqlx::query_scalar("SELECT json_extract(spec, '$.mode') FROM lab_experiments WHERE id = ? AND owner_id = ?").bind(id).bind(owner).fetch_optional(pool).await?;
    let Some(mode) = mode else {
        return Err(AppError::NotFound("experiment"));
    };
    let versus = mode.as_deref() == Some("versus");
    let labels: HashMap<String, String> = labels.into_iter().collect();
    let rows: Vec<(String, i64, String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT game, ord, spec, result, finished_at FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord")
            .bind(id)
            .fetch_all(pool)
            .await?;
    let mut out: Vec<PodView> = Vec::new();
    for (game, ord, spec, result, finished_at) in rows {
        let Ok(spec) = serde_json::from_str::<GameSpec>(&spec) else { continue };
        if versus {
            let seats: Vec<Option<String>> = spec.decks.iter().map(|d| Some(labels.get(d).cloned().unwrap_or_else(|| d.clone()))).collect();
            let view = result.map(|r| versus_game(&game, &seats, &r, finished_at));
            out.push(PodView { pod: usize::try_from(ord / 2).unwrap_or(0) + 1, seat: 0, seats, base: None, variant: None, game: view });
            continue;
        }
        let Some((seat, is_variant)) = spec.decks.iter().enumerate().find_map(|(i, d)| match d.as_str() {
            BASE_ID => Some((i as u8, false)),
            VARIANT_ID => Some((i as u8, true)),
            _ => None,
        }) else {
            continue;
        };
        let pod = usize::try_from(ord / 2).unwrap_or(0) + 1;
        if out.last().is_none_or(|p| p.pod != pod) {
            let seats = spec
                .decks
                .iter()
                .map(|d| if d == BASE_ID || d == VARIANT_ID { None } else { Some(labels.get(d).cloned().unwrap_or_else(|| d.clone())) })
                .collect();
            out.push(PodView { pod, seat, seats, base: None, variant: None, game: None });
        }
        let view = result.map(|r| game_view(&game, seat, &r, finished_at));
        let p = out.last_mut().expect("pushed above");
        if is_variant {
            p.variant = view;
        } else {
            p.base = view;
        }
    }
    Ok(out)
}

/// How fast the lab is playing, for the "expected time" before an experiment is created.
///
/// The pace is measured on everyone's games, so only admins get it exactly. Anyone else gets
/// expected times rounded up to ROUGH_SECONDS, like their experiments' ETAs: with an exact pace,
/// an ETA (which counts the games queued ahead) and your own pending games would give away how
/// many games other people have queued, and the recent sample how many they played.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Pace {
    /// Whether a new experiment can start now; `message` says why not.
    pub available: bool,
    pub message: Option<String>,
    /// Games the lab plays at once.
    pub threads: usize,
    /// Lab time for a new experiment of each size anyone may choose, after your own unfinished
    /// games (other people's can add to it): whole minutes for admins, rounded up to
    /// ROUGH_SECONDS for anyone else. Empty with nothing to go on (no game stored yet, or no
    /// threads).
    pub estimates: Vec<Estimate>,
    /// Admins only (null for anyone else): seconds of lab time per game, all threads together;
    /// null with nothing to go on.
    pub seconds_per_game: Option<f64>,
    /// Admins only: "recent": games finished in the last hour; "average": the mean length of the
    /// lab's latest stored games, spread over its threads; null: no game stored yet.
    pub basis: Option<String>,
    /// Admins only: games that measure is based on.
    pub sample: Option<usize>,
    /// Games your own queued and running experiments still have to play; they go first.
    pub your_pending: i64,
    /// Game counts this account may choose.
    pub game_choices: Vec<u32>,
    /// The smaller allowance of an account that joined without an invite; null for anyone else.
    pub allowance: Option<Allowance>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Estimate {
    pub games: u32,
    pub seconds: i64,
}

/// Recent experiments whose games give the average game length.
const PACE_EXPERIMENTS: i64 = 10;
const PACE_GAMES: i64 = 400;

/// What a non-admin's expected times and ETAs are rounded up to.
pub const ROUGH_SECONDS: i64 = 5 * 60;

fn time_step(admin: bool) -> i64 {
    if admin { 60 } else { ROUGH_SECONDS }
}

/// Seconds rounded up to a whole number of `step`s.
fn round_up(seconds: f64, step: i64) -> i64 {
    (seconds / step as f64).ceil() as i64 * step
}

pub async fn pace(pool: &SqlitePool, viewer: &User, threads: usize, available: Result<(), String>) -> AppResult<Pace> {
    let (rate, recent) = recent_rate(pool).await?;
    let (seconds_per_game, basis, sample) = match rate {
        Some(r) => (Some(1.0 / r), Some("recent"), recent),
        None => {
            // Through the primary key of the newest few experiments only, never the whole history.
            // CASE, because SQLite may test the conditions in any order and json_extract fails on
            // an unreadable line.
            let ms: Vec<f64> = sqlx::query_scalar(
                "SELECT ms FROM (
                    SELECT CAST(CASE WHEN json_valid(g.result) THEN json_extract(g.result, '$.ms') END AS REAL) AS ms
                    FROM lab_experiment_games g
                    WHERE g.experiment_id IN (SELECT id FROM lab_experiments ORDER BY created_at DESC LIMIT ?) AND g.result IS NOT NULL
                 ) WHERE ms > 0 LIMIT ?",
            )
            .bind(PACE_EXPERIMENTS)
            .bind(PACE_GAMES)
            .fetch_all(pool)
            .await?;
            if ms.is_empty() || threads == 0 {
                (None, None, 0)
            } else {
                let mean = ms.iter().sum::<f64>() / ms.len() as f64 / 1000.0;
                (Some(mean / threads as f64), Some("average"), ms.len())
            }
        }
    };
    let your_pending: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM lab_experiment_games g JOIN lab_experiments e ON e.id = g.experiment_id
         WHERE e.owner_id = ? AND e.status IN ('queued','running') AND g.result IS NULL",
    )
    .bind(&viewer.id)
    .fetch_one(pool)
    .await?;
    let (available, message) = match available {
        Ok(()) => (true, None),
        Err(m) => (false, Some(m)),
    };
    let step = time_step(viewer.is_admin);
    let choices = game_choices(viewer);
    let estimates = match seconds_per_game {
        Some(spg) => choices.iter().map(|&games| Estimate { games, seconds: round_up((your_pending + i64::from(games)) as f64 * spg, step) }).collect(),
        None => Vec::new(),
    };
    let (seconds_per_game, basis, sample) = if viewer.is_admin { (seconds_per_game, basis.map(String::from), Some(sample)) } else { (None, None, None) };
    Ok(Pace { available, message, threads, estimates, seconds_per_game, basis, sample, your_pending, game_choices: choices.to_vec(), allowance: None })
}

// ── handlers ────────────────────────────────────────────────────────────────

async fn pods_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Vec<PodView>>> {
    st.lab.check_available()?;
    Ok(Json(pods(&st.pool, &user.id, &id).await?))
}

/// Never a 503: the page shows why experiments can't start instead.
async fn pace_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Pace>> {
    let available = st.lab.simulator().map(|_| ()).map_err(|e| e.to_string());
    let mut p = pace(&st.pool, &user, st.lab.threads(), available).await?;
    p.allowance = allowance(&st.pool, &user, &st.cfg.lab_quota).await?;
    Ok(Json(p))
}

async fn list_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<ExperimentItem>>> {
    st.lab.check_available()?;
    Ok(Json(list(&st.pool, &user.id).await?))
}

async fn create_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, body: Bytes) -> AppResult<Json<ExperimentDetail>> {
    let sim = st.lab.simulator()?;
    let req: NewExperiment = serde_json::from_slice(&body).map_err(|e| AppError::bad(format!("bad request body: {e}")))?;
    let created = create_with(&st.pool, &user, req, sim.as_ref(), &st.cfg.lab_quota).await?;
    st.lab.wake();
    Ok(Json(created))
}

#[derive(Debug, Deserialize)]
pub struct Again {
    pub games: u32,
    pub op_id: Option<String>,
}

async fn again_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, body: Bytes) -> AppResult<Json<ExperimentDetail>> {
    let sim = st.lab.simulator()?;
    let req: Again = serde_json::from_slice(&body).map_err(|e| AppError::bad(format!("bad request body: {e}")))?;
    let created = again_with(&st.pool, &user, &id, req.games, req.op_id.as_deref(), sim.as_ref(), &st.cfg.lab_quota).await?;
    st.lab.wake();
    Ok(Json(created))
}

async fn detail_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<ExperimentDetail>> {
    st.lab.check_available()?;
    Ok(Json(detail(&st.pool, &user.id, &id).await?))
}

async fn cancel_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<ExperimentDetail>> {
    st.lab.check_available()?;
    let d = cancel(&st.pool, &user.id, &id, &|e: &str| st.lab.playing(e)).await?;
    st.lab.wake();
    Ok(Json(d))
}

async fn delete_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    st.lab.check_available()?;
    delete(&st.pool, &user.id, &id).await?;
    st.lab.wake();
    Ok(StatusCode::NO_CONTENT)
}
