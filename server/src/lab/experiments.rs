//! "Try a change": a user's own paired experiments, played by the server's lab worker.
//!
//! An experiment compares a base list with a changed list. Both play the same pods (see
//! [`super::pairing`]): `games` = 2 x pods. The lists are frozen into the experiment when it is
//! created (cards, and the opponents' cards too), so a later edit to a deck or a re-imported
//! precon catalog never changes an experiment part way through.
//!
//! Isolation: every query binds the owner; another user's experiment is "not found". Limits for
//! anyone but an admin: 100, 200 or 400 games, Easy or Medium, and one experiment playing plus two
//! waiting. Admins may ask for any even number of games up to 2,000 and any AI level.

use super::pairing::{self, LIMITS, Limits, POD};
use super::stats::{BASE_ID, Summary, VARIANT_ID};
use super::worker::Simulator;
use super::{Art, PreconCard, RunLabel, latest_global_ratings_run, ratings_for};
use crate::auth::{CurrentUser, User};
use crate::cards::{CARD_COLUMNS, Card};
use crate::decks::{self, Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, sha256_hex};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::{BTreeMap, HashMap, HashSet};
use yama_play::lab::{ENGINE, GameSpec, RUNNER};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/lab/experiments", get(list_handler).post(create_handler))
        .route("/api/lab/experiments/{id}", get(detail_handler).delete(delete_handler))
        .route("/api/lab/experiments/{id}/cancel", post(cancel_handler))
}

/// The 503 message when this server has no engine card data.
pub const NO_CARD_DATA: &str = "Simulations need the engine card data on this server";
/// Games an experiment may have, for anyone but an admin.
pub const GAME_CHOICES: [u32; 3] = [100, 200, 400];
/// Most games an admin's experiment may have.
pub const ADMIN_MAX_GAMES: u32 = 2_000;
/// Unfinished experiments (one playing plus two waiting) a user who isn't an admin may have.
pub const MAX_UNFINISHED: i64 = 3;
/// AI levels anyone may choose; admins may choose any level the engine has.
const USER_DIFFICULTIES: [&str; 2] = ["Easy", "Medium"];
const DEFAULT_DIFFICULTY: &str = "Easy";
/// Field size for the "strongest" and "nearest in strength" precon fields when none is given.
pub const DEFAULT_FIELD: usize = 20;
pub const MIN_FIELD: usize = 3;
const MAX_FIELD: usize = 200;
const MAX_NAME: usize = 120;

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

/// Merge repeated lines and order the list: commanders first, then by name.
pub fn normalize(cards: Vec<LabCard>) -> Vec<LabCard> {
    let mut out: Vec<LabCard> = Vec::new();
    for c in cards {
        if c.qty == 0 {
            continue;
        }
        match out.iter_mut().find(|o| key(o) == key(&c)) {
            Some(o) => o.qty += c.qty,
            None => out.push(c),
        }
    }
    out.sort_by(|a, b| b.commander.cmp(&a.commander).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
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
        .map(|c| LabCard { name: c.name, oracle_id: Some(c.oracle_id), qty: c.qty as u32, commander: c.board == Board::Commander })
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
async fn resolve(pool: &SqlitePool, names: &[String]) -> AppResult<(HashMap<String, (String, String)>, Vec<String>)> {
    let ids = crate::cards::resolve_names(pool, names).await?;
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
        match ids.get(n).and_then(|oid| canonical.get(oid).map(|c| (oid.clone(), c.clone()))) {
            Some(hit) => {
                found.insert(n.clone(), hit);
            }
            None if !unknown.contains(n) => unknown.push(n.clone()),
            None => {}
        }
    }
    Ok((found, unknown))
}

/// A pasted list: lines as the deck editor reads them (first card is the commander when there's
/// no Commander section), sideboards ignored. Names Yama doesn't know come back apart.
async fn parse_text(pool: &SqlitePool, text: &str) -> AppResult<(Vec<LabCard>, Vec<String>)> {
    let lines: Vec<decks::ParsedLine> = decks::parse_list(text, true).into_iter().filter(|l| l.board != Board::Side).collect();
    let names: Vec<String> = lines.iter().map(|l| l.name.clone()).collect();
    let (found, unknown) = resolve(pool, &names).await?;
    let cards = lines
        .into_iter()
        .filter_map(|l| {
            let (oid, name) = found.get(&l.name)?.clone();
            Some(LabCard { name, oracle_id: Some(oid), qty: l.qty as u32, commander: l.board == Board::Commander })
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
    pub base: BaseChoice,
    pub variant: VariantChoice,
    pub field: FieldChoice,
    pub games: u32,
    pub difficulty: Option<String>,
}

/// kind: "deck_version" (id: a version of one of your decks), "deck" (id: one of your decks, its
/// current version), "precon" (id: a precon slug) or "list" (text: a pasted list).
#[derive(Debug, Deserialize)]
pub struct BaseChoice {
    pub kind: String,
    pub id: Option<String>,
    pub text: Option<String>,
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
    pub base: ListDisplay,
    pub variant: VariantDisplay,
    pub field: FieldInfo,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExperimentSpec {
    pub version: u32,
    pub seed: u64,
    pub pod: usize,
    pub pods: usize,
    pub difficulty: String,
    pub limits: Limits,
    pub display: Display,
    pub base: LabList,
    pub variant: LabList,
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
            Ok(Base { list: make_list(BASE_ID, &name, source, from_deck_cards(cards)), precon: None, deck: Some(deck_id), unknown: vec![] })
        }
        "precon" => {
            let id = need(&b.id, "base.id")?;
            let (name, cards): (String, String) =
                sqlx::query_as("SELECT name, cards FROM precons WHERE id = ?").bind(id).fetch_optional(pool).await?.ok_or(AppError::NotFound("precon"))?;
            let cards: Vec<PreconCard> = serde_json::from_str(&cards).map_err(anyhow::Error::from)?;
            let source = json!({"kind": "precon", "id": id});
            Ok(Base { list: make_list(BASE_ID, &name, source, from_precon_cards(cards)), precon: Some(id.to_string()), deck: None, unknown: vec![] })
        }
        "list" => {
            let text = need(&b.text, "base.text")?;
            let (cards, unknown) = parse_text(pool, text).await?;
            Ok(Base { list: make_list(BASE_ID, "Pasted list", json!({"kind": "list"}), cards), precon: None, deck: None, unknown })
        }
        other => Err(AppError::bad(format!("base.kind {other:?}: use deck_version, deck, precon or list"))),
    }
}

/// The changed list, the names Yama doesn't know, and problems applying the changes.
async fn variant_list(pool: &SqlitePool, base: &LabList, v: &VariantChoice) -> AppResult<(LabList, Vec<String>, Vec<String>)> {
    match (&v.text, v.add.is_empty() && v.cut.is_empty()) {
        (Some(_), false) => Err(AppError::bad("variant: give either text or add/cut, not both")),
        (Some(text), true) => {
            let (cards, unknown) = parse_text(pool, text).await?;
            Ok((make_list(VARIANT_ID, "Changed list", json!({"kind": "list"}), cards), unknown, vec![]))
        }
        (None, true) => Err(AppError::bad("variant: give the changed list as text, or cards to add and cut")),
        (None, false) => {
            let names: Vec<String> = v.add.iter().chain(&v.cut).map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect();
            let (found, unknown) = resolve(pool, &names).await?;
            let pick = |list: &[String]| -> Vec<(String, String)> { list.iter().filter_map(|n| found.get(n.trim()).cloned()).collect() };
            let (add, cut) = (pick(&v.add), pick(&v.cut));
            let (cards, problems) = match apply_change(&base.cards, &add, &cut) {
                Ok(cards) => (cards, vec![]),
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

async fn build_field(pool: &SqlitePool, owner: &str, choice: &FieldChoice, base: &Base, base_commanders: &[String], sim: &dyn Simulator) -> AppResult<Field> {
    if choice.ids.len() > MAX_FIELD {
        return Err(AppError::bad(format!("field.ids: at most {MAX_FIELD} decks")));
    }
    if choice.kind == "my_decks" {
        return my_decks_field(pool, owner, choice, base.deck.as_deref(), sim).await;
    }
    if !["precons_all", "precons_top", "precons_near", "precons_ids"].contains(&choice.kind.as_str()) {
        return Err(AppError::bad(format!("field.kind {:?}: use precons_all, precons_top, precons_near, precons_ids or my_decks", choice.kind)));
    }
    let (run, all) = load_precons(pool).await?;
    let mut warnings = Vec::new();
    let playable = |p: &PreconEntry| sim.unknown(&p.cards);
    let is_base = |p: &PreconEntry| base.precon.as_deref() == Some(p.slug.as_str());
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
                    .ok_or_else(|| AppError::bad("Pick a precon to set the power level (field.ids: [a precon id]); the base isn't a rated precon"))?
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
                    Some(p) if is_base(p) => warnings.push(format!("{} is the base list, so it isn't in the field", p.name)),
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
        label: label(opponents.len()),
        run: run_used,
        decks: opponents.len(),
    };
    Ok(Field { opponents, info, warnings })
}

async fn my_decks_field(pool: &SqlitePool, owner: &str, choice: &FieldChoice, base_deck: Option<&str>, sim: &dyn Simulator) -> AppResult<Field> {
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
            let is_base = base_deck == Some(id.as_str());
            if is_base && explicit {
                warnings.push(format!("{name} is the base list, so it isn't in the field"));
            }
            !is_base
        })
        .map(|(id, name, cards)| Ok((id, name, normalize(from_deck_cards(serde_json::from_str(&cards).map_err(anyhow::Error::from)?)))))
        .collect::<AppResult<_>>()?;
    let all_cards: Vec<&[LabCard]> = lists.iter().map(|l| l.2.as_slice()).collect();
    let info = card_info(pool, &all_cards).await?;
    let mut opponents = Vec::new();
    let mut problems = serde_json::Map::new();
    let mut skipped = Vec::new();
    for (id, name, cards) in lists {
        let mut why = check_list(&cards, &info).blocking;
        let unknown = sim.unknown(&cards);
        if !unknown.is_empty() {
            why.push(format!("cards the simulator can't play: {}", unknown.join(", ")));
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

/// Check the request, freeze the lists and the field, schedule the paired games and store it all.
/// With an `op_id` the owner already used, returns that experiment unchanged.
pub async fn create(pool: &SqlitePool, user: &User, req: NewExperiment, sim: &dyn Simulator) -> AppResult<ExperimentDetail> {
    let op_id = req.op_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(op) = op_id {
        if op.len() > 100 {
            return Err(AppError::bad("op_id is too long"));
        }
        let existing: Option<String> =
            sqlx::query_scalar("SELECT id FROM lab_experiments WHERE owner_id = ? AND op_id = ?").bind(&user.id).bind(op).fetch_optional(pool).await?;
        if let Some(id) = existing {
            return detail(pool, &user.id, &id).await;
        }
    }
    let games_ok = if user.is_admin { req.games >= 2 && req.games <= ADMIN_MAX_GAMES && req.games % 2 == 0 } else { GAME_CHOICES.contains(&req.games) };
    if !games_ok {
        return Err(AppError::bad(if user.is_admin {
            format!("games must be an even number from 2 to {ADMIN_MAX_GAMES}")
        } else {
            "games must be 100, 200 or 400".to_string()
        }));
    }
    let difficulty = canonical_difficulty(req.difficulty.as_deref().unwrap_or(DEFAULT_DIFFICULTY))?;
    if !user.is_admin && !USER_DIFFICULTIES.contains(&difficulty.as_str()) {
        return Err(AppError::bad("difficulty must be Easy or Medium"));
    }

    let base = base_list(pool, &user.id, &req.base).await?;
    let (variant, variant_unknown, change_problems) = variant_list(pool, &base.list, &req.variant).await?;
    let mut unknown_base = base.unknown.clone();
    let mut unknown_variant = variant_unknown;
    for (into, list) in [(&mut unknown_base, &base.list), (&mut unknown_variant, &variant)] {
        for n in sim.unknown(&list.cards) {
            if !into.contains(&n) {
                into.push(n);
            }
        }
    }
    if !unknown_base.is_empty() || !unknown_variant.is_empty() {
        let mut all: Vec<String> = Vec::new();
        for n in unknown_base.iter().chain(&unknown_variant) {
            if !all.contains(n) {
                all.push(n.clone());
            }
        }
        return Err(AppError::Invalid {
            message: format!("These cards can't be simulated (Yama or the rules engine doesn't know them): {}", shown(&all)),
            details: json!({"unknown": {"base": unknown_base, "variant": unknown_variant}}),
        });
    }
    if !change_problems.is_empty() {
        return Err(AppError::Invalid { message: change_problems.join("; "), details: json!({"problems": {"base": [], "variant": change_problems}}) });
    }
    let info = card_info(pool, &[&base.list.cards, &variant.cards]).await?;
    let (cb, cv) = (check_list(&base.list.cards, &info), check_list(&variant.cards, &info));
    if !cb.blocking.is_empty() || !cv.blocking.is_empty() {
        let first = cb.blocking.iter().map(|e| format!("base list: {e}")).chain(cv.blocking.iter().map(|e| format!("changed list: {e}"))).collect::<Vec<_>>();
        return Err(AppError::Invalid {
            message: format!("A simulated game needs 100 cards and a valid commander. {}", first.join("; ")),
            details: json!({"problems": {"base": cb.blocking, "variant": cv.blocking}}),
        });
    }
    if base.list.sha256 == variant.sha256 {
        return Err(AppError::bad("The changed list is the same as the base list"));
    }
    let (added, cut) = diff(&base.list.cards, &variant.cards);
    let field = build_field(pool, &user.id, &req.field, &base, &cb.commanders, sim).await?;
    if field.opponents.len() < MIN_FIELD {
        return Err(AppError::bad(format!("The field needs at least {MIN_FIELD} decks to fill the pods; this one has {}", field.opponents.len())));
    }

    let mut warnings = field.warnings.clone();
    warnings.extend(cb.warnings.iter().map(|w| format!("Base list: {w}")));
    warnings.extend(cv.warnings.iter().filter(|w| !cb.warnings.contains(w)).map(|w| format!("Changed list: {w}")));
    let art = base.list.cards.iter().find(|c| c.commander).and_then(|c| info.get(c.oracle_id.as_deref()?)).and_then(|card| {
        Some(Art { url: card.image_art_crop.clone()?, artist: card.artist.clone(), card: card.name.clone() })
    });
    let text_variant = req.variant.text.is_some();
    let variant_display = VariantDisplay { label: variant.label.clone(), added, cut };
    let name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(|n| n.chars().take(MAX_NAME).collect())
        .unwrap_or_else(|| default_name(&base.list.label, &variant_display, text_variant));

    let id = new_id();
    let seed = u64::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().expect("8 bytes"));
    let pods = (req.games / 2) as usize;
    let templates = pairing::templates(field.opponents.len(), pods, seed);
    let field_ids: Vec<String> = field.opponents.iter().map(|o| o.id.clone()).collect();
    let games = pairing::schedule(&id[..8], &templates, &field_ids, &difficulty, &LIMITS);
    let mut pods_of = vec![0usize; field.opponents.len()];
    for t in &templates {
        for d in t.seats.iter().flatten() {
            pods_of[*d] += 1;
        }
    }
    // Opponents no pod uses aren't stored (a big field with few pods).
    let opponents: Vec<Opponent> =
        field.opponents.into_iter().zip(pods_of).filter(|(_, p)| *p > 0).map(|(list, pods)| Opponent { list, pods }).collect();
    let spec = ExperimentSpec {
        version: 1,
        seed,
        pod: POD,
        pods,
        difficulty: difficulty.clone(),
        limits: LIMITS,
        display: Display {
            base: ListDisplay { label: base.list.label.clone(), commanders: cb.commanders, color_identity: cb.color_identity, art, source: base.list.source.clone() },
            variant: variant_display,
            field: field.info,
        },
        base: base.list,
        variant,
        opponents,
        warnings,
    };

    let stamp = now();
    let mut tx = pool.begin().await?;
    // Writing first takes SQLite's write lock: a concurrent create by the same owner waits, so the
    // op id and the limit below are checked one request at a time.
    let inserted = sqlx::query(
        "INSERT INTO lab_experiments (id, owner_id, op_id, name, kind, status, spec, games_total, games_done, engine, card_data, runner, difficulty,
            created_at, updated_at)
         VALUES (?,?,?,?, 'paired', 'queued', ?,?, 0, ?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(op_id)
    .bind(&name)
    .bind(serde_json::to_string(&spec).map_err(anyhow::Error::from)?)
    .bind(i64::from(req.games))
    .bind(ENGINE)
    .bind(sim.card_data())
    .bind(RUNNER)
    .bind(&difficulty)
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
    if !user.is_admin {
        let unfinished: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiments WHERE owner_id = ? AND status IN ('queued','running')")
            .bind(&user.id)
            .fetch_one(&mut *tx)
            .await?;
        if unfinished > MAX_UNFINISHED {
            return Err(AppError::Conflict(
                "You can have one experiment playing and two waiting. Wait for one to finish, or cancel one.".into(),
            ));
        }
    }
    const COLS: usize = 4;
    const CHUNK: usize = 200;
    for chunk in games.chunks(CHUNK) {
        let placeholders = vec!["(?,?,?,?)"; chunk.len()].join(",");
        debug_assert_eq!(placeholders.matches('?').count(), chunk.len() * COLS);
        let sql = format!("INSERT INTO lab_experiment_games (experiment_id, game, ord, spec) VALUES {placeholders}");
        // Only placeholders are interpolated; every value is bound.
        let mut q = sqlx::query(AssertSqlSafe(sql));
        for g in chunk {
            q = q.bind(&id).bind(&g.game).bind(g.ord).bind(serde_json::to_string(&g.spec).map_err(anyhow::Error::from)?);
        }
        q.execute(&mut *tx).await?;
    }
    tx.commit().await?;
    detail(pool, &user.id, &id).await
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
    pub engine: String,
    pub card_data: String,
    pub runner: String,
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
    /// Seconds until this experiment's last game should be in, from the lab's recent pace; null
    /// until a few games have finished, and once it's over.
    pub eta_seconds: Option<i64>,
    /// Games other experiments still have to play before this one's turn (FIFO).
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
    pub base: Option<ListDisplay>,
    pub variant: Option<VariantDisplay>,
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
    pub variant: LabList,
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

/// The lab's queue: its recent pace and, per unfinished experiment, the games ahead of it and its own.
struct Queue {
    /// Games per second over the last finished games, when recent.
    rate: Option<f64>,
    ahead: HashMap<String, (i64, i64)>,
}

async fn queue(pool: &SqlitePool) -> AppResult<Queue> {
    // Only experiments touched in the last hour can have recent games, so the pace never scans the
    // whole lab's history.
    let since = (chrono::Utc::now() - chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let times: Vec<String> = sqlx::query_scalar(
        "SELECT g.finished_at FROM lab_experiment_games g
         WHERE g.experiment_id IN (SELECT id FROM lab_experiments WHERE updated_at >= ?) AND g.finished_at IS NOT NULL
         ORDER BY g.finished_at DESC LIMIT 40",
    )
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
    Ok(Queue { rate, ahead })
}

impl ExpRow {
    fn item(self, q: &Queue) -> ExperimentItem {
        let display: Option<Display> = self.display.as_deref().and_then(|d| serde_json::from_str(d).ok());
        let (games_ahead, eta) = match q.ahead.get(&self.id) {
            Some((before, own)) => (Some(*before), q.rate.map(|r| ((before + own) as f64 / r).round() as i64)),
            None => (None, None),
        };
        ExperimentItem {
            label: SimLabel {
                simulated: true,
                engine: self.engine,
                card_data: self.card_data,
                runner: self.runner,
                difficulty: self.difficulty,
                games: self.games_total,
                pod: POD,
                created_at: self.created_at,
                started_at: self.started_at,
                finished_at: self.finished_at,
                updated_at: self.updated_at,
            },
            progress: Progress { done: self.games_done, total: self.games_total, eta_seconds: eta, games_ahead },
            summary: self.summary.as_deref().and_then(|s| serde_json::from_str(s).ok()),
            base: display.as_ref().map(|d| d.base.clone()),
            variant: display.as_ref().map(|d| d.variant.clone()),
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
    let q = queue(pool).await?;
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
    let q = queue(pool).await?;
    Ok(ExperimentDetail {
        item: row.item(&q),
        opponents: spec
            .opponents
            .iter()
            .map(|o| OpponentView { id: o.list.id.clone(), label: o.list.label.clone(), source: o.list.source.clone(), sha256: o.list.sha256.clone(), pods: o.pods })
            .collect(),
        lists: Lists { base: spec.base, variant: spec.variant },
        warnings: spec.warnings,
        seed: spec.seed,
        limits: spec.limits,
    })
}

/// Stop an experiment's remaining games from starting. Games already playing finish and are kept.
/// Cancelling again, or cancelling a finished experiment, changes nothing.
pub async fn cancel(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<ExperimentDetail> {
    let stamp = now();
    let changed = sqlx::query(
        "UPDATE lab_experiments SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status IN ('queued','running')",
    )
    .bind(&stamp)
    .bind(&stamp)
    .bind(id)
    .bind(owner)
    .execute(pool)
    .await?
    .rows_affected();
    if changed > 0 {
        // Mark the summary final: no more games will start.
        let mut conn = pool.acquire().await?;
        super::worker::refresh(&mut conn, id).await?;
    }
    detail(pool, owner, id).await
}

/// Delete one of the owner's experiments and its games. Results of games still playing are dropped
/// when they come in.
pub async fn delete(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<()> {
    let n = sqlx::query("DELETE FROM lab_experiments WHERE id = ? AND owner_id = ?").bind(id).bind(owner).execute(pool).await?.rows_affected();
    if n == 0 { Err(AppError::NotFound("experiment")) } else { Ok(()) }
}

// ── handlers ────────────────────────────────────────────────────────────────

async fn list_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<ExperimentItem>>> {
    st.lab.check_available()?;
    Ok(Json(list(&st.pool, &user.id).await?))
}

async fn create_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, body: Bytes) -> AppResult<Json<ExperimentDetail>> {
    let sim = st.lab.simulator()?;
    let req: NewExperiment = serde_json::from_slice(&body).map_err(|e| AppError::bad(format!("bad request body: {e}")))?;
    let created = create(&st.pool, &user, req, sim.as_ref()).await?;
    st.lab.wake();
    Ok(Json(created))
}

async fn detail_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<ExperimentDetail>> {
    st.lab.check_available()?;
    Ok(Json(detail(&st.pool, &user.id, &id).await?))
}

async fn cancel_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<ExperimentDetail>> {
    st.lab.check_available()?;
    let d = cancel(&st.pool, &user.id, &id).await?;
    st.lab.wake();
    Ok(Json(d))
}

async fn delete_handler(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    st.lab.check_available()?;
    delete(&st.pool, &user.id, &id).await?;
    st.lab.wake();
    Ok(StatusCode::NO_CONTENT)
}
