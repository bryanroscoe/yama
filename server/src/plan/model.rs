//! The `yama-plan/1` document (docs/plan-format.md): typed structs, and the checks that turn an
//! upload into a 400 naming the JSON path. Readers ignore fields they don't know, every section
//! is optional, and a missing optional field means what it meant before the field existed.

use crate::error::{AppError, AppResult};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const FORMAT: &str = "yama-plan/1";

/// The outer object. `plan` stays raw so its exact bytes can be hashed.
#[derive(Deserialize)]
pub struct Envelope<'a> {
    #[serde(default)]
    pub format: Option<Value>,
    #[serde(default)]
    pub meta: Option<Value>,
    #[serde(borrow, default)]
    pub plan: Option<&'a RawValue>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Meta {
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub guide_version: Option<i64>,
    #[serde(default)]
    pub guide_date: Option<String>,
    #[serde(default)]
    pub git_sha: Option<String>,
    #[serde(default)]
    pub dirty: Option<bool>,
    #[serde(default)]
    pub generated_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Plan {
    #[serde(default, deserialize_with = "nd")]
    pub settings: Vec<Setting>,
    #[serde(default, deserialize_with = "nd")]
    pub stores: Vec<Store>,
    #[serde(default, deserialize_with = "nd")]
    pub decks: Vec<Deck>,
    #[serde(default, deserialize_with = "nd")]
    pub swaps: Vec<Swap>,
    #[serde(default, deserialize_with = "nd")]
    pub aliases: Vec<Alias>,
    #[serde(default, deserialize_with = "nd")]
    pub orders: Vec<Order>,
    #[serde(default, deserialize_with = "nd")]
    pub quotes: Vec<Quote>,
    #[serde(default, deserialize_with = "nd")]
    pub reviews: BTreeMap<String, Review>,
    #[serde(default, deserialize_with = "nd")]
    pub inbox_resolved: Vec<InboxResolved>,
    #[serde(default)]
    pub game_changers: Option<Value>,
    #[serde(default)]
    pub library: Option<Value>,
    /// Plan-wide notes and open questions: `[{kind, text, deck?}]`.
    #[serde(default, deserialize_with = "nd")]
    pub notes: Vec<Value>,
    /// The writer's own warnings, shown in the import report as given.
    #[serde(default, deserialize_with = "nd")]
    pub warnings: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Setting {
    pub effective_from: String,
    #[serde(default, deserialize_with = "nd")]
    pub rules: Map<String, Value>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Store {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub short: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub cart_url_template: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub print_tiers: Option<Vec<i64>>,
    #[serde(default)]
    pub sort: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Deck {
    pub key: String,
    pub name: String,
    #[serde(default, deserialize_with = "nd")]
    pub was: Vec<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub sort: Option<i64>,
    #[serde(default)]
    pub product: Option<String>,
    #[serde(default, deserialize_with = "nd")]
    pub commander: Vec<String>,
    #[serde(default)]
    pub color_identity: Option<String>,
    #[serde(default, deserialize_with = "nd")]
    pub owner_changes: Vec<Value>,
    #[serde(default, deserialize_with = "nd")]
    pub notes: Vec<Value>,
    #[serde(default)]
    pub bracket: Option<Value>,
    #[serde(default, deserialize_with = "nd")]
    pub groups: Vec<Value>,
    /// Who computed the lists, when every state shares it ('commander-decks library.py, guide v6').
    #[serde(default)]
    pub computed_by: Option<String>,
    #[serde(default, deserialize_with = "nd")]
    pub states: BTreeMap<String, State>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct State {
    #[serde(default, deserialize_with = "nd")]
    pub cards: Vec<Slot>,
    #[serde(default, deserialize_with = "nd")]
    pub log: Vec<LogEntry>,
    #[serde(default)]
    pub computed_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    #[serde(default)]
    pub swap: Option<String>,
    pub status: String,
}

/// One card in a list. Stored as written here (unknown fields dropped, empty fields left out),
/// with no card id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Slot {
    pub name: String,
    #[serde(default = "one")]
    pub qty: i64,
    #[serde(default = "main_board")]
    pub board: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub set: Option<String>,
    #[serde(default, deserialize_with = "lenient_string", skip_serializing_if = "Option::is_none")]
    pub num: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scryfall_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replaces: Option<String>,
    /// The swap that put it here. commander-decks' first exporter wrote `swap_key`.
    #[serde(default, alias = "swap_key", skip_serializing_if = "Option::is_none")]
    pub swap: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_deck: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub got: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_item: Option<ItemRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub print_order: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ItemRef {
    pub order: String,
    pub line: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Swap {
    pub key: String,
    pub deck: String,
    #[serde(default = "planned")]
    pub stage: String,
    #[serde(default = "swap_role")]
    pub role: String,
    #[serde(default)]
    pub parent: Option<String>,
    pub src: String,
    #[serde(default)]
    pub src_declared: Option<String>,
    #[serde(default)]
    pub store_label: Option<String>,
    #[serde(default)]
    pub out: Option<String>,
    #[serde(rename = "in")]
    pub inn: String,
    #[serde(default)]
    pub plan_card: Option<String>,
    #[serde(default)]
    pub later_out: Option<String>,
    #[serde(default, deserialize_with = "nd")]
    pub after_print: bool,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub band: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub sort: Option<i64>,
    #[serde(default)]
    pub game_changer: Option<bool>,
    #[serde(default)]
    pub got: Option<Value>,
    #[serde(default)]
    pub order_item: Option<ItemRef>,
    #[serde(default)]
    pub print_order: Option<String>,
    #[serde(default)]
    pub listing: Option<String>,
    #[serde(default)]
    pub when: Option<String>,
    #[serde(default)]
    pub advice: Option<String>,
    #[serde(default)]
    pub why: Option<String>,
    #[serde(default)]
    pub why_out: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default, deserialize_with = "nd")]
    pub was: Vec<String>,
    #[serde(default)]
    pub from_candidate: Option<String>,
    #[serde(default)]
    pub upgrade: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Alias {
    pub old: String,
    pub new: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub key: String,
    pub kind: String,
    pub status: String,
    pub vendor: String,
    #[serde(default)]
    pub store: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub order_number: Option<String>,
    #[serde(default)]
    pub date_ordered: Option<String>,
    #[serde(default)]
    pub placed_by: Option<String>,
    #[serde(default)]
    pub date_fulfilled: Option<String>,
    #[serde(default)]
    pub fulfillment: Option<String>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub subtotal: Option<f64>,
    #[serde(default)]
    pub subtotal_note: Option<String>,
    #[serde(default)]
    pub shipping: Option<f64>,
    #[serde(default)]
    pub tax: Option<f64>,
    #[serde(default)]
    pub total: Option<f64>,
    #[serde(default)]
    pub card_stock: Option<String>,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default, deserialize_with = "nd")]
    pub issues: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default, deserialize_with = "nd")]
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub line: i64,
    pub card: String,
    #[serde(default = "one")]
    pub qty: i64,
    #[serde(default)]
    pub listing: Option<String>,
    #[serde(default)]
    pub set: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub num: Option<String>,
    #[serde(default)]
    pub finish: Option<String>,
    #[serde(default)]
    pub scryfall_id: Option<String>,
    #[serde(default)]
    pub received: Option<Received>,
    #[serde(default)]
    pub arrived: Option<bool>,
    #[serde(default)]
    pub deck: Option<String>,
    #[serde(default)]
    pub replaces: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub unit_price: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Received {
    #[serde(default)]
    pub set: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub num: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quote {
    #[serde(default)]
    pub swap: Option<String>,
    pub card: String,
    pub kind: String,
    #[serde(default)]
    pub store: Option<String>,
    #[serde(default)]
    pub store_label: Option<String>,
    #[serde(default)]
    pub checked: Option<String>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub in_stock: Option<bool>,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default, deserialize_with = "nd")]
    pub price_from_text: bool,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub printing: Option<String>,
    #[serde(default)]
    pub set: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub num: Option<String>,
    #[serde(default, deserialize_with = "nd")]
    pub printing_from_text: bool,
    #[serde(default)]
    pub scryfall_id: Option<String>,
    /// A Shopify variant id. Always a string in the format; a number is converted.
    #[serde(default, deserialize_with = "lenient_string")]
    pub variant: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Review {
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub cut: Option<String>,
    #[serde(default)]
    pub deck: Option<String>,
    #[serde(default)]
    pub card: Option<String>,
    pub at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InboxResolved {
    pub op_id: String,
    pub outcome: String,
    #[serde(default)]
    pub at: Option<String>,
}

fn one() -> i64 {
    1
}
fn main_board() -> String {
    "main".into()
}
fn planned() -> String {
    "planned".into()
}
fn swap_role() -> String {
    "swap".into()
}

/// A present `null` reads as the default, the same as a missing field.
fn nd<'de, D: Deserializer<'de>, T: Deserialize<'de> + Default>(d: D) -> Result<T, D::Error> {
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

/// Collector numbers and cart variant ids are strings; writers sometimes send numbers.
fn lenient_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s),
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(other) => return Err(serde::de::Error::custom(format!("expected a string, got {other}"))),
    })
}

// ── parsing with JSON paths ────────────────────────────────────────────────

/// serde_json's message without its " at line 1 column 1234" tail: the path says where.
fn plain(e: &serde_json::Error) -> String {
    let s = e.to_string();
    match s.rfind(" at line ") {
        Some(i) if e.line() > 0 => s[..i].to_string(),
        _ => s,
    }
}

fn path_error(root: &str, e: serde_path_to_error::Error<serde_json::Error>) -> AppError {
    let path = e.path().to_string();
    let at = if path == "." { root.to_string() } else { format!("{root}.{path}") };
    AppError::bad(format!("{at}: {}", plain(e.inner())))
}

/// Parse JSON text into `T`, naming the JSON path (under `root`) of anything malformed.
pub fn parse_str<T: DeserializeOwned>(json: &str, root: &str) -> AppResult<T> {
    let de = &mut serde_json::Deserializer::from_str(json);
    serde_path_to_error::deserialize(de).map_err(|e| path_error(root, e))
}

pub fn parse_value<T: DeserializeOwned>(v: Value, root: &str) -> AppResult<T> {
    serde_path_to_error::deserialize(v).map_err(|e| {
        let path = e.path().to_string();
        let at = if path == "." { root.to_string() } else { format!("{root}.{path}") };
        AppError::bad(format!("{at}: {}", e.into_inner()))
    })
}

pub fn parse_envelope(body: &[u8]) -> AppResult<Envelope<'_>> {
    serde_json::from_slice(body).map_err(|e| AppError::bad(format!("body: not a plan file ({})", plain(&e))))
}

// ── hashing ────────────────────────────────────────────────────────────────

/// A list's identity: its cards reduced to `[board, name, qty]`, repeated names summed, sorted,
/// as compact JSON. Printings, sources and card ids aren't part of it.
pub fn list_identity(cards: &[Slot]) -> String {
    let mut sums: BTreeMap<(String, String), i64> = BTreeMap::new();
    for c in cards {
        *sums.entry((c.board.clone(), c.name.trim().to_string())).or_insert(0) += c.qty;
    }
    let rows: Vec<(&str, &str, i64)> = sums.iter().map(|((b, n), q)| (b.as_str(), n.as_str(), *q)).collect();
    crate::util::sha256_hex(&serde_json::to_string(&rows).expect("list json"))
}

/// The hash of a row as imported: rows whose hash is unchanged aren't rewritten.
pub fn row_hash<T: Serialize>(row: &T) -> String {
    crate::util::sha256_hex(&serde_json::to_string(row).expect("row json"))
}

// ── validation ─────────────────────────────────────────────────────────────

pub const STATES: [&str; 6] = ["stock", "now", "after", "proposal", "bracket3", "bracket2"];
const SLOT_KINDS: [&str; 8] = ["stock", "owner", "bought", "standin", "fill", "print", "moved", "optional"];
const LOG_STATUSES: [&str; 8] = ["done", "standin", "fill", "waiting", "print", "moved", "waiting-move", "spare"];

/// What a valid document gives the importer besides itself.
#[derive(Debug, Default)]
pub struct Checked {
    /// Every alias the document implies (from `aliases`, swap `was` and `from_candidate`, and deck
    /// `was`), old key to new key.
    pub aliases: BTreeMap<String, String>,
    /// Reviews with `at` normalized to UTC whole seconds.
    pub reviews: BTreeMap<String, NormalReview>,
    /// `inbox_resolved` with `at` normalized.
    pub resolved: Vec<(String, String, Option<String>)>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct NormalReview {
    pub decision: Option<String>,
    pub note: Option<String>,
    pub cut: Option<String>,
    pub deck: Option<String>,
    pub card: Option<String>,
    pub at: String,
}

fn bad(path: String, msg: impl std::fmt::Display) -> AppError {
    AppError::bad(format!("{path}: {msg}"))
}

fn one_of(path: impl Fn() -> String, v: &str, allowed: &[&str]) -> AppResult<()> {
    if allowed.contains(&v) {
        Ok(())
    } else {
        Err(bad(path(), format!("\"{v}\" isn't one of {}", allowed.join(", "))))
    }
}

fn nonempty(path: impl Fn() -> String, v: &str) -> AppResult<()> {
    if v.trim().is_empty() { Err(bad(path(), "must not be empty")) } else { Ok(()) }
}

pub fn is_date(s: &str) -> bool {
    s.len() == 10 && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn date(path: impl Fn() -> String, v: &Option<String>) -> AppResult<()> {
    match v {
        Some(s) if !is_date(s) => Err(bad(path(), format!("\"{s}\" isn't a YYYY-MM-DD date"))),
        _ => Ok(()),
    }
}

fn money(path: impl Fn() -> String, v: Option<f64>) -> AppResult<()> {
    match v {
        Some(x) if x < 0.0 || !x.is_finite() => Err(bad(path(), format!("{x} isn't a price; money is a number ≥ 0, or null when unknown"))),
        _ => Ok(()),
    }
}

/// An RFC 3339 time as UTC with whole seconds (`2026-10-19T01:00:00Z`). A time with no zone is refused.
pub fn utc_time(path: impl Fn() -> String, s: &str) -> AppResult<String> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .map_err(|_| bad(path(), format!("\"{s}\" isn't an RFC 3339 time with a zone (UTC: 2026-10-19T01:00:00Z)")))
}

fn blank(s: &Option<String>) -> bool {
    s.as_deref().is_none_or(|v| v.trim().is_empty())
}

/// Check the parts of the document a database constraint or a later page relies on. The first
/// problem is a 400 naming its JSON path; softer problems become warnings.
pub fn check(plan: &Plan) -> AppResult<Checked> {
    let mut out = Checked::default();

    // settings
    let mut dates = HashSet::new();
    for (i, s) in plan.settings.iter().enumerate() {
        let p = || format!("plan.settings[{i}].effective_from");
        if !is_date(&s.effective_from) {
            return Err(bad(p(), format!("\"{}\" isn't a YYYY-MM-DD date", s.effective_from)));
        }
        if !dates.insert(s.effective_from.as_str()) {
            return Err(bad(p(), format!("{} appears twice; each date has one complete rule set", s.effective_from)));
        }
    }

    // stores
    let mut stores = HashSet::new();
    for (i, s) in plan.stores.iter().enumerate() {
        nonempty(|| format!("plan.stores[{i}].key"), &s.key)?;
        nonempty(|| format!("plan.stores[{i}].name"), &s.name)?;
        if !stores.insert(s.key.as_str()) {
            return Err(bad(format!("plan.stores[{i}].key"), format!("\"{}\" appears twice", s.key)));
        }
        one_of(|| format!("plan.stores[{i}].kind"), &s.kind, &["local", "online", "printer"])?;
        if let Some(t) = &s.cart_url_template
            && (!t.starts_with("https://") || !t.contains("{items}"))
        {
            return Err(bad(format!("plan.stores[{i}].cart_url_template"), "must be an https:// URL containing {items}"));
        }
        if let Some(tiers) = &s.print_tiers
            && tiers.iter().any(|n| *n <= 0)
        {
            return Err(bad(format!("plan.stores[{i}].print_tiers"), "tiers are card counts above 0"));
        }
    }

    // decks and their lists
    let mut decks: HashMap<&str, &Deck> = HashMap::new();
    for (i, d) in plan.decks.iter().enumerate() {
        nonempty(|| format!("plan.decks[{i}].key"), &d.key)?;
        nonempty(|| format!("plan.decks[{i}].name"), &d.name)?;
        if decks.insert(d.key.as_str(), d).is_some() {
            return Err(bad(format!("plan.decks[{i}].key"), format!("\"{}\" appears twice", d.key)));
        }
        if let Some(s) = &d.source {
            one_of(|| format!("plan.decks[{i}].source"), s, &["import", "yama"])?;
        }
        if let Some(s) = &d.status {
            one_of(|| format!("plan.decks[{i}].status"), s, &["active", "proposals_only"])?;
        }
        if d.commander.is_empty() || d.commander.len() > 2 {
            return Err(bad(format!("plan.decks[{i}].commander"), "needs one commander name, or two for partners"));
        }
        if let Some(ci) = &d.color_identity
            && !ci.chars().all(|c| "WUBRG".contains(c))
        {
            return Err(bad(format!("plan.decks[{i}].color_identity"), format!("\"{ci}\" isn't written in WUBRG letters")));
        }
        for (j, n) in d.notes.iter().enumerate() {
            check_note(|| format!("plan.decks[{i}].notes[{j}]"), n)?;
        }
        if let Some(b) = d.bracket.as_ref().filter(|b| !b.is_null()) {
            check_bracket(i, b)?;
        }
        for (name, st) in &d.states {
            let sp = || format!("plan.decks[{i}].states.{name}");
            one_of(sp, name, &STATES)?;
            for (j, c) in st.cards.iter().enumerate() {
                nonempty(|| format!("plan.decks[{i}].states.{name}.cards[{j}].name"), &c.name)?;
                if c.qty < 1 {
                    return Err(bad(format!("plan.decks[{i}].states.{name}.cards[{j}].qty"), "must be at least 1"));
                }
                one_of(|| format!("plan.decks[{i}].states.{name}.cards[{j}].board"), &c.board, &["commander", "main"])?;
                if let Some(k) = &c.kind {
                    one_of(|| format!("plan.decks[{i}].states.{name}.cards[{j}].kind"), k, &SLOT_KINDS)?;
                }
            }
            for (j, l) in st.log.iter().enumerate() {
                one_of(|| format!("plan.decks[{i}].states.{name}.log[{j}].status"), &l.status, &LOG_STATUSES)?;
            }
        }
    }
    let deck_names: HashMap<&str, &str> = plan.decks.iter().map(|d| (d.name.as_str(), d.key.as_str())).collect();

    // orders
    let mut orders: HashMap<&str, &Order> = HashMap::new();
    for (i, o) in plan.orders.iter().enumerate() {
        nonempty(|| format!("plan.orders[{i}].key"), &o.key)?;
        if orders.insert(o.key.as_str(), o).is_some() {
            return Err(bad(format!("plan.orders[{i}].key"), format!("\"{}\" appears twice", o.key)));
        }
        one_of(|| format!("plan.orders[{i}].kind"), &o.kind, &["real", "proxy"])?;
        one_of(|| format!("plan.orders[{i}].status"), &o.status, &["draft", "placed", "received", "cancelled"])?;
        nonempty(|| format!("plan.orders[{i}].vendor"), &o.vendor)?;
        if let Some(s) = &o.store
            && !stores.contains(s.as_str())
        {
            return Err(bad(format!("plan.orders[{i}].store"), format!("no store \"{s}\" in plan.stores")));
        }
        date(|| format!("plan.orders[{i}].date_ordered"), &o.date_ordered)?;
        date(|| format!("plan.orders[{i}].placed_by"), &o.placed_by)?;
        date(|| format!("plan.orders[{i}].date_fulfilled"), &o.date_fulfilled)?;
        money(|| format!("plan.orders[{i}].subtotal"), o.subtotal)?;
        money(|| format!("plan.orders[{i}].shipping"), o.shipping)?;
        money(|| format!("plan.orders[{i}].tax"), o.tax)?;
        money(|| format!("plan.orders[{i}].total"), o.total)?;
        let mut lines = HashSet::new();
        for (j, it) in o.items.iter().enumerate() {
            if !lines.insert(it.line) {
                return Err(bad(format!("plan.orders[{i}].items[{j}].line"), format!("line {} appears twice", it.line)));
            }
            nonempty(|| format!("plan.orders[{i}].items[{j}].card"), &it.card)?;
            if it.qty < 1 {
                return Err(bad(format!("plan.orders[{i}].items[{j}].qty"), "must be at least 1"));
            }
            money(|| format!("plan.orders[{i}].items[{j}].unit_price"), it.unit_price)?;
        }
    }

    // swaps
    let mut swaps: HashMap<&str, &Swap> = HashMap::new();
    for (i, s) in plan.swaps.iter().enumerate() {
        nonempty(|| format!("plan.swaps[{i}].key"), &s.key)?;
        if swaps.insert(s.key.as_str(), s).is_some() {
            return Err(bad(format!("plan.swaps[{i}].key"), format!("\"{}\" appears twice", s.key)));
        }
    }
    for (i, s) in plan.swaps.iter().enumerate() {
        if !decks.contains_key(s.deck.as_str()) {
            return Err(bad(format!("plan.swaps[{i}].deck"), format!("no deck \"{}\" in plan.decks", s.deck)));
        }
        one_of(|| format!("plan.swaps[{i}].stage"), &s.stage, &["planned", "proposed"])?;
        one_of(|| format!("plan.swaps[{i}].role"), &s.role, &["swap", "standin", "optional"])?;
        one_of(|| format!("plan.swaps[{i}].src"), &s.src, &["buy", "print", "owned"])?;
        nonempty(|| format!("plan.swaps[{i}].in"), &s.inn)?;
        if let Some(b) = &s.band {
            one_of(|| format!("plan.swaps[{i}].band"), b, &["B2", "B3", "B4"])?;
        }
        if s.role == "standin" {
            let Some(pk) = &s.parent else {
                return Err(bad(format!("plan.swaps[{i}].parent"), "a stand-in needs the key of the print swap it holds"));
            };
            match swaps.get(pk.as_str()) {
                None => return Err(bad(format!("plan.swaps[{i}].parent"), format!("no swap \"{pk}\" in plan.swaps"))),
                Some(p) if p.src != "print" || p.deck != s.deck || p.out != s.out => {
                    return Err(bad(
                        format!("plan.swaps[{i}].parent"),
                        format!("\"{pk}\" must be a print swap in the same deck that takes out the same card"),
                    ));
                }
                Some(_) => {}
            }
        } else if let Some(pk) = &s.parent
            && !swaps.contains_key(pk.as_str())
        {
            return Err(bad(format!("plan.swaps[{i}].parent"), format!("no swap \"{pk}\" in plan.swaps")));
        }
        match &s.got {
            None if s.src == "owned" => {
                return Err(bad(format!("plan.swaps[{i}].got"), "an owned card needs got: where it comes from"));
            }
            None => {}
            Some(g) => check_got(|| format!("plan.swaps[{i}].got"), g, &orders, &decks, &deck_names, &mut out.warnings, &s.key)?,
        }
        if let Some(r) = &s.order_item {
            match orders.get(r.order.as_str()) {
                None => return Err(bad(format!("plan.swaps[{i}].order_item.order"), format!("no order \"{}\" in plan.orders", r.order))),
                Some(o) if !o.items.iter().any(|it| it.line == r.line) => {
                    return Err(bad(format!("plan.swaps[{i}].order_item.line"), format!("order \"{}\" has no line {}", r.order, r.line)));
                }
                Some(_) => {}
            }
        }
        if let Some(po) = &s.print_order {
            match orders.get(po.as_str()) {
                None => return Err(bad(format!("plan.swaps[{i}].print_order"), format!("no order \"{po}\" in plan.orders"))),
                Some(o) if o.kind != "proxy" => {
                    out.warnings.push(format!("{}: print_order names {po}, which isn't a print order", s.key));
                }
                Some(_) => {}
            }
        }
        if let Some(d) = &s.src_declared
            && d != &s.src
        {
            out.warnings.push(format!("{}: the source data says {d}; the export made it {}", s.key, s.src));
        }
    }
    // A bracket bag entry's optional `got` has a swap's shapes. Shared pages build their sentence
    // from it, because the entry's `from` text can name a store and an order date.
    for (i, d) in plan.decks.iter().enumerate() {
        let Some(Value::Object(bags)) = d.bracket.as_ref().and_then(|b| b.get("bags")) else { continue };
        for (k, list) in bags {
            for (j, bag) in list.as_array().into_iter().flatten().enumerate() {
                if let Some(g) = bag.get("got").filter(|g| !g.is_null()) {
                    let key = format!("{} bracket {k} bag", d.key);
                    check_got(|| format!("plan.decks[{i}].bracket.bags.{k}[{j}].got"), g, &orders, &decks, &deck_names, &mut out.warnings, &key)?;
                }
            }
        }
    }
    claims_warnings(plan, &decks, &mut out.warnings);
    print_order_warnings(plan, &orders, &mut out.warnings);

    // quotes
    for (i, q) in plan.quotes.iter().enumerate() {
        nonempty(|| format!("plan.quotes[{i}].card"), &q.card)?;
        one_of(|| format!("plan.quotes[{i}].kind"), &q.kind, &["stock_check", "market_benchmark"])?;
        match &q.checked {
            None => return Err(bad(format!("plan.quotes[{i}].checked"), "every quote needs the date it was checked")),
            Some(_) => date(|| format!("plan.quotes[{i}].checked"), &q.checked)?,
        }
        if blank(&q.source) {
            return Err(bad(format!("plan.quotes[{i}].source"), "every quote needs its source"));
        }
        money(|| format!("plan.quotes[{i}].price"), q.price)?;
        if let Some(s) = &q.store
            && !stores.contains(s.as_str())
        {
            return Err(bad(format!("plan.quotes[{i}].store"), format!("no store \"{s}\" in plan.stores")));
        }
        if let Some(s) = &q.swap
            && !swaps.contains_key(s.as_str())
        {
            return Err(bad(format!("plan.quotes[{i}].swap"), format!("no swap \"{s}\" in plan.swaps")));
        }
    }

    // aliases: from the list, swap was/from_candidate, and deck was
    let live: HashSet<&str> = swaps.keys().copied().collect();
    let add = |path: String, old: &str, new: &str, out: &mut Checked| -> AppResult<()> {
        if old == new {
            return Ok(());
        }
        if live.contains(old) {
            return Err(bad(path, format!("\"{old}\" is a live key, so it can't also be an old one")));
        }
        match out.aliases.get(old) {
            Some(existing) if existing != new => {
                Err(bad(path, format!("\"{old}\" already points at \"{existing}\"; it can't also point at \"{new}\"")))
            }
            _ => {
                out.aliases.insert(old.to_string(), new.to_string());
                Ok(())
            }
        }
    };
    for (i, a) in plan.aliases.iter().enumerate() {
        add(format!("plan.aliases[{i}].old"), &a.old, &a.new, &mut out)?;
    }
    for (i, s) in plan.swaps.iter().enumerate() {
        for (j, w) in s.was.iter().enumerate() {
            add(format!("plan.swaps[{i}].was[{j}]"), w, &s.key, &mut out)?;
        }
        if let Some(c) = &s.from_candidate {
            add(format!("plan.swaps[{i}].from_candidate"), c, &s.key, &mut out)?;
        }
    }
    for (i, d) in plan.decks.iter().enumerate() {
        for (j, old_name) in d.was.iter().enumerate() {
            for s in plan.swaps.iter().filter(|s| s.deck == d.key) {
                if let Some(old_key) = renamed_key(&s.key, &d.name, old_name) {
                    add(format!("plan.decks[{i}].was[{j}]"), &old_key, &s.key, &mut out)?;
                }
            }
        }
    }
    for old in out.aliases.keys() {
        let mut seen = HashSet::from([old.as_str()]);
        let mut k = old.as_str();
        while let Some(next) = out.aliases.get(k) {
            if !seen.insert(next.as_str()) {
                return Err(bad("plan.aliases".into(), format!("aliases form a cycle through \"{old}\"")));
            }
            k = next;
        }
    }

    // reviews
    for (key, r) in &plan.reviews {
        let p = |f: &str| format!("plan.reviews[{}].{f}", serde_json::to_string(key).unwrap_or_default());
        if let Some(d) = &r.decision {
            one_of(|| p("decision"), d, &["want", "unsure", "no"])?;
        }
        if r.note.as_deref().is_some_and(|n| n.chars().count() > 2000) {
            return Err(bad(p("note"), "a note can be at most 2000 characters"));
        }
        let at = utc_time(|| p("at"), &r.at)?;
        out.reviews.insert(
            key.clone(),
            NormalReview {
                decision: r.decision.clone(),
                note: r.note.clone().filter(|n| !n.is_empty()),
                cut: r.cut.clone().filter(|c| !c.is_empty()),
                deck: r.deck.clone(),
                card: r.card.clone(),
                at,
            },
        );
    }

    for (i, r) in plan.inbox_resolved.iter().enumerate() {
        nonempty(|| format!("plan.inbox_resolved[{i}].op_id"), &r.op_id)?;
        let at = match &r.at {
            Some(a) => Some(utc_time(|| format!("plan.inbox_resolved[{i}].at"), a)?),
            None => None,
        };
        out.resolved.push((r.op_id.clone(), r.outcome.clone(), at));
    }

    for (i, n) in plan.notes.iter().enumerate() {
        check_note(|| format!("plan.notes[{i}]"), n)?;
    }
    Ok(out)
}

/// The optional parts of a deck's `bracket` that the swap card reads: `box`, the bracket the deck
/// is kept at (1 to 5), and `extras`, cards kept for Bracket 4 that are in no build.
fn check_bracket(i: usize, b: &Value) -> AppResult<()> {
    if let Some(v) = b.get("box").filter(|v| !v.is_null())
        && !v.as_i64().is_some_and(|n| (1..=5).contains(&n))
    {
        return Err(bad(format!("plan.decks[{i}].bracket.box"), "must be a bracket from 1 to 5"));
    }
    match b.get("extras") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            for (j, n) in list.iter().enumerate() {
                if !n.as_str().is_some_and(|n| !n.trim().is_empty()) {
                    return Err(bad(format!("plan.decks[{i}].bracket.extras[{j}]"), "must be a card name"));
                }
            }
        }
        Some(_) => return Err(bad(format!("plan.decks[{i}].bracket.extras"), "must be a list of card names")),
    }
    Ok(())
}

/// The card names in a deck's `bracket.extras`.
pub fn bracket_extras(bracket: Option<&Value>) -> impl Iterator<Item = &str> {
    bracket.and_then(|b| b.get("extras")).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
}

fn check_note(path: impl Fn() -> String, n: &Value) -> AppResult<()> {
    let kind = n.get("kind").and_then(Value::as_str);
    let text = n.get("text").and_then(Value::as_str);
    match (kind, text) {
        (Some(k), Some(_)) => one_of(|| format!("{}.kind", path()), k, &["open_question", "warning", "note"]),
        _ => Err(bad(path(), "a note is {kind, text}")),
    }
}

/// `got` is one of three shapes (docs/plan-format.md, swaps).
#[allow(clippy::too_many_arguments)]
fn check_got(
    path: impl Fn() -> String,
    g: &Value,
    orders: &HashMap<&str, &Order>,
    decks: &HashMap<&str, &Deck>,
    deck_names: &HashMap<&str, &str>,
    warnings: &mut Vec<String>,
    key: &str,
) -> AppResult<()> {
    let s = |f: &str| g.get(f).and_then(Value::as_str);
    let nullable_str = |f: &str| g.get(f).is_none_or(|v| v.is_null() || v.is_string());
    let Some(how) = s("how") else {
        return Err(bad(path(), "got needs how: bought, pulled, deck or owned"));
    };
    match how {
        "bought" => match s("order") {
            None => Err(bad(format!("{}.order", path()), "a bought card needs the key of its order")),
            Some(o) if !orders.contains_key(o) => Err(bad(format!("{}.order", path()), format!("no order \"{o}\" in plan.orders"))),
            Some(_) => Ok(()),
        },
        // A card a note's build says you own (plans made from a note, plan/notes.rs).
        "owned" => match g.get("detail") {
            None | Some(Value::Null) | Some(Value::String(_)) => Ok(()),
            Some(_) => Err(bad(format!("{}.detail", path()), "detail is text or null")),
        },
        "pulled" => {
            if s("product").is_none_or(|p| p.trim().is_empty()) {
                return Err(bad(format!("{}.product", path()), "a pulled card needs the product it came from"));
            }
            match g.get("date") {
                None | Some(Value::Null) => Ok(()),
                Some(Value::String(d)) if is_date(d) => Ok(()),
                Some(other) => Err(bad(format!("{}.date", path()), format!("{other} isn't a YYYY-MM-DD date"))),
            }
        }
        "deck" => {
            if !nullable_str("deck") || !nullable_str("deck_name") {
                return Err(bad(path(), "deck and deck_name are strings or null"));
            }
            let (deck, name) = (s("deck"), s("deck_name"));
            if deck.is_none() && name.is_none() {
                return Err(bad(path(), "a card from another deck needs deck or deck_name"));
            }
            let Some(origin) = s("origin").filter(|o| !o.trim().is_empty()) else {
                return Err(bad(format!("{}.origin", path()), "say whether it came in that precon (\"precon\") or which order bought it"));
            };
            if let Some(d) = deck
                && !decks.contains_key(d)
                && !deck_names.contains_key(d)
            {
                warnings.push(format!("{key}: got names deck \"{d}\", which isn't in this plan"));
            }
            // "note": a plan made from a note, which records no purchase for the move.
            if origin != "precon" && origin != "note" && !orders.contains_key(origin) {
                warnings.push(format!("{key}: got.origin \"{origin}\" is neither \"precon\" nor an order in this plan"));
            }
            Ok(())
        }
        other => Err(bad(format!("{}.how", path()), format!("unknown how \"{other}\"; expected bought, pulled, deck or owned"))),
    }
}

/// `plan|<deck name>|...` keys (and standin|, opt|) under a deck's old name.
pub fn renamed_key(key: &str, name: &str, old_name: &str) -> Option<String> {
    let mut parts = key.splitn(3, '|');
    let (prefix, deck, rest) = (parts.next()?, parts.next()?, parts.next());
    if !matches!(prefix, "plan" | "standin" | "opt") || deck != name {
        return None;
    }
    Some(match rest {
        Some(r) => format!("{prefix}|{old_name}|{r}"),
        None => format!("{prefix}|{old_name}"),
    })
}

/// Two planned rows in one deck naming the same cut (as `out`, or as a stand-in's `later_out`).
fn claims_warnings(plan: &Plan, decks: &HashMap<&str, &Deck>, warnings: &mut Vec<String>) {
    let mut claims: BTreeMap<(&str, &str), Vec<String>> = BTreeMap::new();
    for s in plan.swaps.iter().filter(|s| s.stage == "planned") {
        if s.role != "standin"
            && let Some(o) = &s.out
        {
            claims.entry((s.deck.as_str(), o.as_str())).or_default().push(format!("{} takes it out", s.inn));
        }
        if let Some(l) = &s.later_out {
            claims.entry((s.deck.as_str(), l.as_str())).or_default().push(format!("{} names it as its later cut", s.inn));
        }
    }
    for ((deck, card), who) in claims {
        if who.len() > 1 {
            let name = decks.get(deck).map_or(deck, |d| d.name.as_str());
            warnings.push(format!("{name}: {card} is claimed {} times ({})", who.len(), who.join("; ")));
        }
    }
}

/// A print swap is on a print order only if the order lists its card, counted as a multiset.
fn print_order_warnings(plan: &Plan, orders: &HashMap<&str, &Order>, warnings: &mut Vec<String>) {
    let mut wanted: BTreeMap<(&str, &str), i64> = BTreeMap::new();
    for s in plan.swaps.iter().filter(|s| s.src == "print") {
        if let Some(po) = &s.print_order {
            *wanted.entry((po.as_str(), s.inn.as_str())).or_insert(0) += 1;
        }
    }
    for ((order, card), n) in wanted {
        let Some(o) = orders.get(order) else { continue };
        let listed: i64 = o.items.iter().filter(|it| it.card == card).map(|it| it.qty).sum();
        if n > listed {
            warnings.push(format!("{n} print swaps for {card} name order {order}, which lists {listed}"));
        }
    }
}

/// Every card name the document mentions, with where (up to five places each), for name
/// resolution and the report.
pub fn card_names(plan: &Plan) -> BTreeMap<String, Vec<String>> {
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut add = |name: &str, place: String| {
        let n = name.trim();
        if n.is_empty() {
            return;
        }
        let places = out.entry(n.to_string()).or_default();
        if places.len() < 5 && !places.contains(&place) {
            places.push(place);
        }
    };
    for d in &plan.decks {
        for c in &d.commander {
            add(c, format!("{}: commander", d.name));
        }
        for oc in &d.owner_changes {
            for f in ["in", "out"] {
                if let Some(n) = oc.get(f).and_then(Value::as_str) {
                    add(n, format!("{}: owner change", d.name));
                }
            }
        }
        for (bracket, bag) in bracket_bags(d.bracket.as_ref()) {
            for f in ["in", "out"] {
                if let Some(n) = bag.get(f).and_then(Value::as_str) {
                    add(n, format!("{}: bracket {bracket} bag", d.name));
                }
            }
        }
        for n in bracket_extras(d.bracket.as_ref()) {
            add(n, format!("{}: Bracket 4 extras", d.name));
        }
        for (state, st) in &d.states {
            for c in &st.cards {
                add(&c.name, format!("{}: {state} list", d.name));
            }
        }
    }
    for s in &plan.swaps {
        add(&s.inn, format!("swap {}", s.key));
        for n in [&s.out, &s.plan_card, &s.later_out].into_iter().flatten() {
            add(n, format!("swap {}", s.key));
        }
    }
    for o in &plan.orders {
        for it in &o.items {
            add(&it.card, format!("order {} line {}", o.key, it.line));
        }
    }
    for q in &plan.quotes {
        add(&q.card, format!("quote for {}", q.swap.as_deref().unwrap_or(&q.card)));
    }
    out
}

/// The `{out, in, from, got}` entries of a deck's bracket bags, with the bracket they belong to.
pub fn bracket_bags(bracket: Option<&Value>) -> Vec<(String, &Value)> {
    let mut out = Vec::new();
    if let Some(Value::Object(bags)) = bracket.and_then(|b| b.get("bags")) {
        for (k, list) in bags {
            for bag in list.as_array().into_iter().flatten() {
                out.push((k.clone(), bag));
            }
        }
    }
    out
}
