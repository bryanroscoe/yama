//! Private research documents and review preferences, independent of installed decks and plans.
//! Importing research never approves a swap. Decisions survive document refreshes; fingerprints
//! flag changed or removed targets. Browser writes are version-checked, idempotent operations.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{now, sha256_hex};
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashSet};

pub const MAX_BYTES: usize = 4 << 20;

pub fn validate(document: &Value) -> AppResult<usize> {
    Ok(targets(document)?.len())
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/research",
            get(list_route)
                .post(save_route)
                .layer(DefaultBodyLimit::max(MAX_BYTES)),
        )
        // Outside /api/research/{id}, where a note could be called "builds".
        .route("/api/research-builds", get(builds_route))
        .route("/api/research/{id}", get(get_route))
        .route("/api/research/{id}/reviews", post(review_route))
        .route("/api/research/{id}/sharing", put(sharing_route))
        .route("/api/research/{id}/share-link", post(reset_link_route))
        .route("/api/research/copy", post(copy_route))
}

// Deserialize the fields consumed by the UI. The original JSON, including additional fields,
// is retained untouched. These types prevent malformed imports crashing the reading page.
#[allow(dead_code)]
#[derive(Deserialize)]
struct Document {
    schema: String,
    id: String,
    title: String,
    generated_at: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    method: Vec<String>,
    #[serde(default)]
    scenarios: Vec<Scenario>,
    decks: Vec<Deck>,
    #[serde(default)]
    power_scale: Vec<PowerScale>,
    #[serde(default)]
    local_checks: BTreeMap<String, LocalCheck>,
    #[serde(default)]
    default_scenario_id: Option<String>,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct PowerScale {
    range: String,
    meaning: String,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct LocalCheck {
    #[serde(default)]
    reason: String,
    #[serde(default)]
    coverage: String,
    #[serde(default)]
    checked: String,
    #[serde(default)]
    local_checks: Vec<StoreCheck>,
    #[serde(default)]
    rejected_offers: Vec<Item>,
    #[serde(default)]
    market_reference: Option<MarketReference>,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct StoreCheck {
    store: String,
    #[serde(default)]
    checked: String,
    #[serde(default)]
    errors: Vec<String>,
    #[serde(default)]
    search_may_be_truncated: bool,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct MarketReference {
    #[serde(default)]
    market: Option<f64>,
    #[serde(default)]
    set: String,
    #[serde(default)]
    num: String,
    #[serde(default)]
    url: String,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct Deck {
    key: String,
    name: String,
    commander: String,
    #[serde(default)]
    ownership: String,
    #[serde(default)]
    installed_state: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    recommended_build: String,
    #[serde(default)]
    pilot: String,
    #[serde(default)]
    sources: Vec<Source>,
    builds: Vec<Build>,
    #[serde(default)]
    guide_comparison: String,
    #[serde(default)]
    mechanics: Vec<String>,
    #[serde(default)]
    warnings: Vec<String>,
    #[serde(default)]
    combo_limits: Vec<String>,
    #[serde(default)]
    existing_swap_audit: Vec<SwapAudit>,
    #[serde(default)]
    combo_playbook: Vec<Combo>,
    #[serde(default)]
    competitive_path: Option<CompetitivePath>,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct CompetitivePath {
    status: String,
    summary: String,
    #[serde(default)]
    commander_change: String,
    #[serde(default)]
    sources: Vec<Source>,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct GameplayProfile {
    plan: String,
    #[serde(default)]
    setup: Vec<String>,
    pressure: String,
    #[serde(default)]
    finishers: Vec<String>,
    interaction: String,
    consistency: String,
    recovery: String,
    #[serde(default)]
    weaknesses: Vec<String>,
    pace: String,
    ceiling: String,
    confidence: String,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct GcChoice {
    card: String,
    reason: String,
    cut: String,
}
#[derive(Deserialize)]
struct Accounting {
    total: u32,
    commander: u32,
    main: u32,
    basics: u32,
    nonbasic: u32,
    unchanged: u32,
    added: u32,
    removed: u32,
    owned: u32,
    local_buys: u32,
    prints: u32,
    #[serde(default)]
    projected_stock: u32,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct SwapAudit {
    #[serde(default)]
    inn: Option<String>,
    #[serde(default)]
    out: Option<String>,
    #[serde(default)]
    verdict: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct Build {
    id: String,
    label: String,
    #[serde(default)]
    bracket: Option<u8>,
    #[serde(default)]
    prospective: bool,
    #[serde(default)]
    power: Power,
    #[serde(default)]
    why: String,
    #[serde(default)]
    risks: Vec<String>,
    #[serde(default)]
    game_changers: Vec<String>,
    #[serde(default)]
    stats: BTreeMap<String, Value>,
    list: String,
    #[serde(default)]
    swaps: Vec<Swap>,
    #[serde(default)]
    acquisition: Acquisition,
    #[serde(default)]
    combos: Vec<Combo>,
    #[serde(default)]
    option_swap: Option<OptionSwap>,
    #[serde(default)]
    gameplay_profile: Option<GameplayProfile>,
    #[serde(default)]
    gc_choices: Vec<GcChoice>,
    #[serde(default)]
    accounting: Option<Accounting>,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct OptionSwap {
    #[serde(default)]
    card_in: Option<String>,
    #[serde(default)]
    card_out: Option<String>,
    #[serde(default)]
    inn: Option<String>,
    #[serde(default)]
    out: Option<String>,
}
#[allow(dead_code)]
#[derive(Default, Deserialize)]
struct Power {
    #[serde(default)]
    range: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    confidence: String,
    #[serde(default)]
    rationale: String,
    #[serde(default)]
    speed: String,
    #[serde(default)]
    vulnerabilities: Vec<String>,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct Swap {
    id: String,
    card_in: String,
    #[serde(default)]
    card_out: String,
    #[serde(default)]
    why: String,
    #[serde(default)]
    why_out: String,
    #[serde(default)]
    acquisition: Item,
    #[serde(default)]
    pairing_note: Option<String>,
}
#[allow(dead_code)]
#[derive(Default, Deserialize)]
struct Acquisition {
    #[serde(default)]
    scenario: String,
    #[serde(default)]
    owned: Vec<Item>,
    #[serde(default)]
    buys: Vec<Item>,
    #[serde(default)]
    prints: Vec<Item>,
    #[serde(default)]
    sealed_purchases: Vec<Item>,
    #[serde(default)]
    basics: Vec<Item>,
    #[serde(default)]
    note: Option<String>,
}
#[allow(dead_code)]
#[derive(Default, Deserialize)]
struct Item {
    #[serde(default)]
    card: String,
    #[serde(default)]
    deck: String,
    #[serde(default)]
    qty: Option<u32>,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    detail: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    store: String,
    #[serde(default)]
    price: Option<f64>,
    #[serde(default)]
    market: Option<f64>,
    #[serde(default)]
    printing: String,
    #[serde(default)]
    condition: String,
    #[serde(default)]
    checked: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    local_check: Option<String>,
    #[serde(default)]
    source_deck: Option<String>,
    #[serde(default)]
    provenance: Option<String>,
    #[serde(default)]
    quote: Option<Box<Item>>,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct Combo {
    id: String,
    name: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    cards: Vec<String>,
    #[serde(default)]
    setup: Vec<String>,
    #[serde(default)]
    steps: Vec<String>,
    #[serde(default)]
    outcome: String,
    #[serde(default)]
    stop_points: Vec<String>,
    #[serde(default)]
    bracket_fit: String,
    #[serde(default)]
    sources: Vec<Source>,
    #[serde(default)]
    present: Option<bool>,
    #[serde(default)]
    is_caution: Option<bool>,
    #[serde(default)]
    missing_cards: Vec<String>,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct Source {
    title: String,
    url: String,
    #[serde(default)]
    accessed: String,
}
#[allow(dead_code)]
#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ScenarioPurpose {
    #[default]
    Acquisition,
    PermanentRealWishlist,
}
#[allow(dead_code)]
#[derive(Deserialize)]
struct Scenario {
    id: String,
    label: String,
    #[serde(default)]
    purpose: ScenarioPurpose,
    #[serde(default)]
    deck_count: usize,
    #[serde(default)]
    note: String,
    #[serde(default)]
    buys: Vec<Item>,
    #[serde(default)]
    prints: Vec<Item>,
    #[serde(default)]
    buy_total: Option<f64>,
    #[serde(default)]
    print_count: usize,
    #[serde(default)]
    sealed_purchases: Vec<Item>,
}

fn key_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

fn bounded(v: &Value, depth: usize) -> bool {
    if depth > 24 {
        return false;
    }
    match v {
        Value::String(s) => s.len() <= 200_000,
        Value::Array(a) => a.len() <= 10_000 && a.iter().all(|x| bounded(x, depth + 1)),
        Value::Object(o) => {
            o.len() <= 10_000
                && o.iter()
                    .all(|(k, x)| k.len() <= 200 && bounded(x, depth + 1))
        }
        _ => true,
    }
}

fn check_accounting(build: &Build) -> AppResult<()> {
    let Some(a) = &build.accounting else {
        return Ok(());
    };
    let cards = crate::decks::parse_list(&build.list, true);
    let basic = |name: &str| {
        matches!(
            name,
            "Plains"
                | "Island"
                | "Swamp"
                | "Mountain"
                | "Forest"
                | "Wastes"
                | "Snow-Covered Plains"
                | "Snow-Covered Island"
                | "Snow-Covered Swamp"
                | "Snow-Covered Mountain"
                | "Snow-Covered Forest"
        )
    };
    let count = |board| {
        cards
            .iter()
            .filter(|c| c.board == board)
            .map(|c| c.qty as u64)
            .sum::<u64>()
    };
    let total = count(crate::decks::Board::Commander) + count(crate::decks::Board::Main);
    let basics = cards
        .iter()
        .filter(|c| basic(&c.name) && c.board != crate::decks::Board::Side)
        .map(|c| c.qty as u64)
        .sum::<u64>();
    let supply = u64::from(a.owned)
        + u64::from(a.projected_stock)
        + u64::from(a.local_buys)
        + u64::from(a.prints)
        + u64::from(a.basics);
    if total != 100
        || a.total != 100
        || a.commander != 1
        || a.main != 99
        || count(crate::decks::Board::Commander) != 1
        || count(crate::decks::Board::Main) != 99
        || count(crate::decks::Board::Side) != 0
        || basics != u64::from(a.basics)
        || u64::from(a.nonbasic) + basics != total
        || supply != total
        || u64::from(a.unchanged) + u64::from(a.added) != total
        || a.added != a.removed
    {
        return Err(AppError::bad(
            "Build accounting must match its full 100-card list, supply and swap counts.",
        ));
    }
    Ok(())
}

/// Validate, then return a fingerprint for every decision target. A changed target remains
/// readable with its old answer, but the UI asks for another review instead of silently approving.
fn targets(doc: &Value) -> AppResult<BTreeMap<String, String>> {
    let bytes = serde_json::to_vec(doc).map_err(anyhow::Error::from)?;
    if bytes.len() > MAX_BYTES || !bounded(doc, 0) {
        return Err(AppError::bad("Research is too large or deeply nested."));
    }
    let d: Document = serde_json::from_value(doc.clone())
        .map_err(|e| AppError::bad(format!("Invalid research document: {e}")))?;
    if d.schema != "yama-research/1"
        || !key_ok(&d.id)
        || d.title.trim().is_empty()
        || d.decks.is_empty()
        || d.decks.len() > 100
    {
        return Err(AppError::bad(
            "Research needs schema yama-research/1, an id, title and 1–100 decks.",
        ));
    }
    let mut result = BTreeMap::new();
    let mut keys = HashSet::new();
    let mut scenarios = HashSet::new();
    for s in &d.scenarios {
        if !key_ok(&s.id) || !scenarios.insert(&s.id) {
            return Err(AppError::bad("Scenario ids must be unique keys."));
        }
        if s.buy_total.is_some_and(|n| !n.is_finite() || n < 0.0) {
            return Err(AppError::bad("Invalid buy total."));
        }
    }
    if d.default_scenario_id
        .as_ref()
        .is_some_and(|id| !scenarios.contains(id))
    {
        return Err(AppError::bad("Default shopping scenario does not exist."));
    }
    for (i, deck) in d.decks.iter().enumerate() {
        if !key_ok(&deck.key)
            || !keys.insert(&deck.key)
            || deck.name.trim().is_empty()
            || deck.commander.trim().is_empty()
            || deck.builds.is_empty()
            || deck.builds.len() > 12
        {
            return Err(AppError::bad(
                "Decks need unique keys, names, commanders and 1–12 builds.",
            ));
        }
        let mut builds = HashSet::new();
        for (j, build) in deck.builds.iter().enumerate() {
            check_accounting(build)?;
            if !key_ok(&build.id)
                || !builds.insert(&build.id)
                || build.list.trim().is_empty()
                || build.bracket.is_some_and(|b| !(1..=5).contains(&b))
            {
                return Err(AppError::bad(
                    "Builds need unique ids, a list and a valid optional bracket.",
                ));
            }
            let mut swaps = HashSet::new();
            for (k, swap) in build.swaps.iter().enumerate() {
                if !key_ok(&swap.id) || !swaps.insert(&swap.id) || swap.card_in.trim().is_empty() {
                    return Err(AppError::bad("Swaps need unique ids and an added card."));
                }
                result.insert(
                    format!("swap:{}:{}:{}", deck.key, build.id, swap.id),
                    sha256_hex(&doc["decks"][i]["builds"][j]["swaps"][k].to_string()),
                );
            }
        }
        if !deck.recommended_build.is_empty() && !builds.contains(&deck.recommended_build) {
            return Err(AppError::bad("Recommended build does not exist."));
        }
        result.insert(
            format!("deck:{}", deck.key),
            sha256_hex(&doc["decks"][i]["builds"].to_string()),
        );
    }
    Ok(result)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub revision: i64,
    pub updated_at: String,
    /// private, link or public (`sharing::VISIBILITIES`).
    pub visibility: String,
    /// Made the first time the note is shared; `/r/<token>` while it isn't private.
    pub share_token: Option<String>,
}

pub async fn list(pool: &SqlitePool, owner: &str) -> AppResult<Value> {
    let rows: Vec<Summary> = sqlx::query_as("SELECT id,title,revision,updated_at,visibility,share_token FROM research_reports WHERE owner_id=? ORDER BY updated_at DESC,id")
        .bind(owner).fetch_all(pool).await?;
    Ok(json!(rows))
}

/// Only these of an object's fields.
fn pick(v: &Value, keys: &[&str]) -> Value {
    Value::Object(keys.iter().filter_map(|k| v.get(*k).map(|x| (k.to_string(), x.clone()))).collect())
}

/// Copies an acquisition lists, as the ownership check counts them (card, kind and quantity).
fn rows(v: &Value) -> Value {
    Value::Array(v.as_array().into_iter().flatten().map(|r| pick(r, &["card", "kind", "qty"])).collect())
}

/// What the build choices and the deck check read from a build (web/src/decks/buildCatalog.ts,
/// web/src/research/availability.ts): a page that reads another field adds it here.
fn build_summary(b: &Value) -> Value {
    let mut out = pick(b, &["id", "label", "bracket", "prospective", "list", "risks", "accounting"]);
    if let Some(swaps) = b["swaps"].as_array() {
        out["swaps"] = swaps
            .iter()
            .map(|s| {
                let mut s2 = pick(s, &["id", "card_out", "card_in", "qty", "why"]);
                if s.get("acquisition").is_some() {
                    s2["acquisition"] = pick(&s["acquisition"], &["transfer", "source_deck", "detail", "kind", "store"]);
                }
                s2
            })
            .collect();
    }
    if let Some(a) = b.get("acquisition").filter(|a| a.is_object()) {
        let mut a2 = pick(a, &["track", "scenario"]);
        for list in ["owned", "basics", "buys", "prints", "sealed_purchases"] {
            if a.get(list).is_some() {
                a2[list] = rows(&a[list]);
            }
        }
        out["acquisition"] = a2;
    }
    out
}

/// Every note's builds in one response, for the build choices and the deck check: each note's
/// id, title, revision and date, and its decks' keys, names and builds, as much of each build as
/// those pages read ([`build_summary`]), without the rest of a note (up to 4 MiB each). A note
/// that doesn't read as JSON is left out, as the page would.
pub async fn builds(pool: &SqlitePool, owner: &str) -> AppResult<Value> {
    let rows: Vec<(String, i64, String)> =
        sqlx::query_as("SELECT document,revision,updated_at FROM research_reports WHERE owner_id=? ORDER BY updated_at DESC,id")
            .bind(owner)
            .fetch_all(pool)
            .await?;
    let notes: Vec<Value> = rows
        .into_iter()
        .filter_map(|(text, revision, updated_at)| {
            let doc: Value = serde_json::from_str(&text).ok()?;
            let decks: Vec<Value> = doc["decks"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|d| json!({"key": d["key"], "name": d["name"], "builds": d["builds"].as_array().into_iter().flatten().map(build_summary).collect::<Vec<_>>()}))
                .collect();
            Some(json!({"document": {"id": doc["id"], "title": doc["title"], "decks": decks}, "revision": revision, "updated_at": updated_at}))
        })
        .collect();
    Ok(json!(notes))
}

pub async fn save(pool: &SqlitePool, owner: &str, document: &Value) -> AppResult<Value> {
    targets(document)?;
    let id = document["id"].as_str().unwrap();
    let encoded = serde_json::to_string(document).map_err(anyhow::Error::from)?;
    let hash = sha256_hex(&encoded);
    let mut tx = pool.begin().await?;
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM research_reports WHERE owner_id=? AND id!=?")
            .bind(owner)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if count >= 20 {
        return Err(AppError::bad(
            "Keep at most 20 research reports per account.",
        ));
    }
    let changed = sqlx::query("INSERT INTO research_reports(owner_id,id,title,content_hash,document,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,id) DO UPDATE SET title=excluded.title,content_hash=excluded.content_hash,document=excluded.document,updated_at=excluded.updated_at,revision=research_reports.revision+1 WHERE research_reports.content_hash!=excluded.content_hash")
        .bind(owner).bind(id).bind(document["title"].as_str().unwrap()).bind(&hash).bind(&encoded).bind(now()).execute(&mut *tx).await?.rows_affected() > 0;
    let revision: i64 =
        sqlx::query_scalar("SELECT revision FROM research_reports WHERE owner_id=? AND id=?")
            .bind(owner)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    // Plans tracking one of this note's builds follow the note (plan/notes.rs).
    let followed = if changed { crate::plan::notes::rederive(&mut tx, owner, id, document).await? } else { 0 };
    tx.commit().await?;
    let mut out = saved(id, revision, &hash, changed);
    if followed > 0 {
        out["effect"] = json!(format!(
            "Research saved. {followed} plan{} tracking this note's builds now follow{} it; no decks, collection, orders or games changed.",
            if followed == 1 { "" } else { "s" },
            if followed == 1 { "s" } else { "" }
        ));
        out["plans_updated"] = json!(followed);
    }
    Ok(out)
}

fn saved(id: &str, revision: i64, hash: &str, changed: bool) -> Value {
    json!({"id":id,"revision":revision,"content_hash":hash,"changed":changed,"link":format!("/decks/research/{id}"),"effect":"Research saved. No decks, plans, collection, orders or games changed."})
}

/// Saves `document` as a new note only: `None` when `owner` already has one with its id, which
/// stays as it was. The insert itself decides, so two saves at once can't both take an id. With
/// `op`, a note already saved by that operation (`copied_from.op`) is the answer instead: a
/// retried copy returns the first one.
pub(crate) async fn save_new(pool: &SqlitePool, owner: &str, document: &Value, op: Option<&str>) -> AppResult<Option<Value>> {
    targets(document)?;
    let id = document["id"].as_str().unwrap();
    let encoded = serde_json::to_string(document).map_err(anyhow::Error::from)?;
    let hash = sha256_hex(&encoded);
    // Write lock first: two copies at once then wait in turn (busy timeout) rather than one
    // failing when its read snapshot goes stale at the insert.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(op) = op {
        let done: Option<(String, i64, String)> = sqlx::query_as("SELECT id, revision, content_hash FROM research_reports WHERE owner_id=? AND json_extract(document, '$.copied_from.op')=?")
            .bind(owner)
            .bind(op)
            .fetch_optional(&mut *tx)
            .await?;
        if let Some((id, revision, hash)) = done {
            return Ok(Some(saved(&id, revision, &hash, false)));
        }
    }
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM research_reports WHERE owner_id=?").bind(owner).fetch_one(&mut *tx).await?;
    if count >= 20 {
        return Err(AppError::bad("Keep at most 20 research reports per account."));
    }
    let inserted = sqlx::query("INSERT INTO research_reports(owner_id,id,title,content_hash,document,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(owner_id,id) DO NOTHING")
        .bind(owner).bind(id).bind(document["title"].as_str().unwrap()).bind(&hash).bind(&encoded).bind(now()).execute(&mut *tx).await?.rows_affected() > 0;
    if !inserted {
        return Ok(None);
    }
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM research_reports WHERE owner_id=? AND id=?").bind(owner).bind(id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(saved(id, revision, &hash, true)))
}

#[derive(Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Review {
    pub target: String,
    pub decision: Option<String>,
    pub note: Option<String>,
    pub target_hash: String,
    pub version: i64,
    pub updated_at: String,
}

pub async fn load(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<Value> {
    let row: Option<(String, i64, String, String, Option<String>)> = sqlx::query_as(
        "SELECT document,revision,updated_at,visibility,share_token FROM research_reports WHERE owner_id=? AND id=?",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let (text, revision, updated_at, visibility, share_token) = row.ok_or(AppError::NotFound("research"))?;
    let doc: Value = serde_json::from_str(&text).map_err(anyhow::Error::from)?;
    let hashes = targets(&doc)?;
    let reviews: Vec<Review> = sqlx::query_as("SELECT target,decision,note,target_hash,version,updated_at FROM research_reviews WHERE owner_id=? AND report_id=? ORDER BY target").bind(owner).bind(id).fetch_all(pool).await?;
    Ok(
        json!({"document":doc,"revision":revision,"updated_at":updated_at,"target_hashes":hashes,"reviews":reviews,"visibility":visibility,"share_token":share_token}),
    )
}

#[derive(Deserialize, Serialize)]
pub struct ReviewOp {
    pub op_id: String,
    pub target: String,
    pub decision: Option<String>,
    pub note: Option<String>,
    pub expected_version: i64,
    pub target_hash: String,
}

pub async fn review(pool: &SqlitePool, owner: &str, id: &str, op: &ReviewOp) -> AppResult<Review> {
    if !key_ok(&op.op_id)
        || op.target.len() > 500
        || op.note.as_ref().is_some_and(|s| s.len() > 6000)
        || op.expected_version < 0
    {
        return Err(AppError::bad("Invalid research review operation."));
    }
    let payload_hash = sha256_hex(&format!(
        "{id}|{}",
        serde_json::to_string(op).map_err(anyhow::Error::from)?
    ));
    let mut tx = pool.begin().await?;
    let prior: Option<(String, String)> = sqlx::query_as(
        "SELECT payload_hash,receipt FROM research_review_ops WHERE owner_id=? AND op_id=?",
    )
    .bind(owner)
    .bind(&op.op_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((hash, receipt)) = prior {
        if hash != payload_hash {
            return Err(AppError::Conflict(
                "That operation id was already used for a different review.".into(),
            ));
        }
        return serde_json::from_str(&receipt).map_err(|e| anyhow::Error::from(e).into());
    }
    let text: String =
        sqlx::query_scalar("SELECT document FROM research_reports WHERE owner_id=? AND id=?")
            .bind(owner)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(AppError::NotFound("research"))?;
    let doc: Value = serde_json::from_str(&text).map_err(anyhow::Error::from)?;
    let hashes = targets(&doc)?;
    let hash = hashes
        .get(&op.target)
        .ok_or_else(|| AppError::bad("This research target no longer exists."))?;
    if hash != &op.target_hash {
        return Err(AppError::Conflict(
            "This research changed. Reload before reviewing it.".into(),
        ));
    }
    let allowed = if let Some(key) = op.target.strip_prefix("deck:") {
        doc["decks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|d| d["key"] == key)
            .unwrap()["builds"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|b| b["id"].as_str())
            .collect::<Vec<_>>()
    } else {
        vec!["want", "unsure", "no"]
    };
    if op
        .decision
        .as_deref()
        .is_some_and(|d| !allowed.contains(&d))
    {
        return Err(AppError::bad("Invalid choice for this research target."));
    }
    let version: Option<i64> = sqlx::query_scalar(
        "SELECT version FROM research_reviews WHERE owner_id=? AND report_id=? AND target=?",
    )
    .bind(owner)
    .bind(id)
    .bind(&op.target)
    .fetch_optional(&mut *tx)
    .await?;
    if version.unwrap_or(0) != op.expected_version {
        return Err(AppError::Conflict(
            "A newer answer is saved. Reload to review it before replacing it.".into(),
        ));
    }
    let result = Review {
        target: op.target.clone(),
        decision: op.decision.clone(),
        note: op.note.clone(),
        target_hash: hash.clone(),
        version: op.expected_version + 1,
        updated_at: now(),
    };
    sqlx::query("INSERT INTO research_reviews(owner_id,report_id,target,decision,note,target_hash,version,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,report_id,target) DO UPDATE SET decision=excluded.decision,note=excluded.note,target_hash=excluded.target_hash,version=excluded.version,updated_at=excluded.updated_at")
        .bind(owner).bind(id).bind(&result.target).bind(&result.decision).bind(&result.note).bind(&result.target_hash).bind(result.version).bind(&result.updated_at).execute(&mut *tx).await?;
    sqlx::query(
        "INSERT INTO research_review_ops(owner_id,op_id,payload_hash,receipt) VALUES(?,?,?,?)",
    )
    .bind(owner)
    .bind(&op.op_id)
    .bind(&payload_hash)
    .bind(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(result)
}

/// Who can see a note: `private`, `link` or `public`. Sharing it the first time makes its link;
/// the link stays the same through later visibility changes and refreshes of the note.
pub async fn set_visibility(pool: &SqlitePool, owner: &str, id: &str, visibility: &str) -> AppResult<Value> {
    let v = crate::sharing::visibility(visibility)?;
    let done = sqlx::query("UPDATE research_reports SET visibility=?, share_token=COALESCE(share_token, ?) WHERE owner_id=? AND id=?")
        .bind(v)
        .bind(crate::sharing::new_token())
        .bind(owner)
        .bind(id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("research"));
    }
    sharing_state(pool, owner, id).await
}

/// A new link for a note: every old link stops working.
pub async fn reset_link(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<Value> {
    let done = sqlx::query("UPDATE research_reports SET share_token=? WHERE owner_id=? AND id=?")
        .bind(crate::sharing::new_token())
        .bind(owner)
        .bind(id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("research"));
    }
    sharing_state(pool, owner, id).await
}

async fn sharing_state(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<Value> {
    let (visibility, token): (String, Option<String>) =
        sqlx::query_as("SELECT visibility, share_token FROM research_reports WHERE owner_id=? AND id=?").bind(owner).bind(id).fetch_one(pool).await?;
    let link = token.as_ref().filter(|_| visibility != "private").map(|t| format!("/r/{t}"));
    Ok(json!({"id":id,"visibility":visibility,"share_token":token,"link":link}))
}

/// What a shared note shows the public: an allow-list of the guide fields, so a field added to
/// the format later stays private until it is added here. Never review answers or notes,
/// ownership or installed state, acquisition evidence (store quotes, owned copies, prints),
/// shopping scenarios, accounting, local checks, `method` (where notes keep acquisition rules,
/// price ceilings and print preferences) or anything else the format carries. Free text in the
/// fields shown (summaries, reasons) is published as written; the Share panel says so.
pub fn public_view(doc: &Value) -> Value {
    fn pick(v: &Value, keys: &[&str]) -> Value {
        let mut out = serde_json::Map::new();
        for k in keys {
            if let Some(x) = v.get(*k).filter(|x| !x.is_null()) {
                out.insert((*k).to_string(), x.clone());
            }
        }
        Value::Object(out)
    }
    fn each(v: &Value, f: impl Fn(&Value) -> Value) -> Value {
        Value::Array(v.as_array().map(|a| a.iter().map(f).collect()).unwrap_or_default())
    }
    let mut out = pick(doc, &["id", "title", "generated_at", "summary"]);
    out["decks"] = each(&doc["decks"], |d| {
        let mut deck = pick(d, &["key", "name", "commander", "summary", "recommended_build", "pilot", "warnings", "mechanics", "sources"]);
        deck["builds"] = each(&d["builds"], |b| {
            let mut build = pick(b, &["id", "label", "bracket", "why", "risks", "game_changers", "gameplay_profile", "list"]);
            build["swaps"] = each(&b["swaps"], |s| pick(s, &["id", "card_in", "card_out", "qty", "why", "why_out", "pairing_note"]));
            build["gc_choices"] = each(&b["gc_choices"], |g| pick(g, &["card", "reason", "cut"]));
            build
        });
        deck
    });
    out
}

/// A shared note by its link: (the sharer's handle, the public view, when it was saved). Private
/// and unknown notes, and notes of disabled accounts, are all the same "not found".
pub async fn shared(pool: &SqlitePool, token: &str) -> AppResult<(Option<String>, Value, String)> {
    if !crate::sharing::valid_token(token) {
        return Err(AppError::NotFound("research"));
    }
    let row: Option<(Option<String>, String, String)> = sqlx::query_as(
        "SELECT u.handle, r.document, r.updated_at FROM research_reports r JOIN users u ON u.id = r.owner_id
         WHERE r.share_token = ? AND r.visibility IN ('link', 'public') AND u.disabled_at IS NULL",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?;
    let (handle, text, updated_at) = row.ok_or(AppError::NotFound("research"))?;
    let doc: Value = serde_json::from_str(&text).map_err(anyhow::Error::from)?;
    Ok((handle, public_view(&doc), updated_at))
}

/// Copies a shared note into `owner`'s notes: only what its page shows (`public_view`), never
/// the sharer's answers or evidence. A copy never replaces a note of theirs: when the id is
/// taken it is saved as `<id>-copy`, `<id>-copy-2` and so on. Returns `save`'s answer.
pub async fn copy_shared(pool: &SqlitePool, owner: &str, token: &str, op: Option<&str>) -> AppResult<Value> {
    if op.is_some_and(|o| !key_ok(o) || o.len() > 64) {
        return Err(AppError::bad("Invalid copy operation id."));
    }
    let (handle, mut doc, _) = shared(pool, token).await?;
    let taken: HashSet<String> = sqlx::query_scalar::<_, String>("SELECT id FROM research_reports WHERE owner_id = ?").bind(owner).fetch_all(pool).await?.into_iter().collect();
    // Room for the suffix within key_ok's 160 bytes; ids are ASCII.
    let base: String = doc["id"].as_str().unwrap_or("note").chars().take(140).collect();
    doc["schema"] = json!("yama-research/1");
    doc["copied_from"] = json!({"link": format!("/r/{token}"), "by": handle, "op": op});
    // `taken` skips the ids already there; one taken since (another copy at the same moment) is
    // refused by the insert, and the next id is tried. An account holds at most 20 notes.
    let ids = std::iter::once(base.clone()).chain((1..).map(|n| if n == 1 { format!("{base}-copy") } else { format!("{base}-copy-{n}") }));
    for id in ids.filter(|id| !taken.contains(id)).take(25) {
        doc["id"] = json!(id);
        if let Some(saved) = save_new(pool, owner, &doc, op).await? {
            return Ok(saved);
        }
    }
    Err(AppError::bad("Couldn't find a free name for the copy. Try again."))
}

#[derive(Deserialize)]
struct CopyRequest {
    token: String,
    /// One id per Save-a-copy action, so a retry returns the copy it already made.
    #[serde(default)]
    op: Option<String>,
}

async fn copy_route(State(st): State<AppState>, CurrentUser(u): CurrentUser, Json(r): Json<CopyRequest>) -> AppResult<Json<Value>> {
    Ok(Json(copy_shared(&st.pool, &u.id, &r.token, r.op.as_deref()).await?))
}

async fn list_route(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
) -> AppResult<Json<Value>> {
    Ok(Json(list(&st.pool, &u.id).await?))
}
async fn builds_route(State(st): State<AppState>, CurrentUser(u): CurrentUser) -> AppResult<Json<Value>> {
    Ok(Json(builds(&st.pool, &u.id).await?))
}
async fn save_route(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
    Json(doc): Json<Value>,
) -> AppResult<Json<Value>> {
    Ok(Json(save(&st.pool, &u.id, &doc).await?))
}
async fn get_route(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(load(&st.pool, &u.id, &id).await?))
}
async fn review_route(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<String>,
    Json(op): Json<ReviewOp>,
) -> AppResult<Json<Review>> {
    Ok(Json(review(&st.pool, &u.id, &id, &op).await?))
}

#[derive(Deserialize)]
struct SharingBody {
    visibility: String,
}
async fn sharing_route(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<SharingBody>,
) -> AppResult<Json<Value>> {
    Ok(Json(set_visibility(&st.pool, &u.id, &id, &body.visibility).await?))
}
async fn reset_link_route(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(reset_link(&st.pool, &u.id, &id).await?))
}

#[cfg(test)]
mod tests;
