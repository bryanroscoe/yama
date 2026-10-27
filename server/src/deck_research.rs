//! Private research documents and review preferences, independent of installed decks and plans.
//! Importing research never approves a swap. Decisions survive document refreshes; fingerprints
//! flag changed or removed targets. Browser writes are version-checked, idempotent operations.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{now, sha256_hex};
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::routing::{get, post};
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
        .route("/api/research/{id}", get(get_route))
        .route("/api/research/{id}/reviews", post(review_route))
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
#[derive(Deserialize)]
struct Scenario {
    id: String,
    label: String,
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
}

pub async fn list(pool: &SqlitePool, owner: &str) -> AppResult<Value> {
    let rows: Vec<Summary> = sqlx::query_as("SELECT id,title,revision,updated_at FROM research_reports WHERE owner_id=? ORDER BY updated_at DESC,id")
        .bind(owner).fetch_all(pool).await?;
    Ok(json!(rows))
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
    tx.commit().await?;
    Ok(
        json!({"id":id,"revision":revision,"content_hash":hash,"changed":changed,"link":format!("/decks/research/{id}"),"effect":"Research saved. No decks, plans, collection, orders or games changed."}),
    )
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
    let row: Option<(String, i64, String)> = sqlx::query_as(
        "SELECT document,revision,updated_at FROM research_reports WHERE owner_id=? AND id=?",
    )
    .bind(owner)
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let (text, revision, updated_at) = row.ok_or(AppError::NotFound("research"))?;
    let doc: Value = serde_json::from_str(&text).map_err(anyhow::Error::from)?;
    let hashes = targets(&doc)?;
    let reviews: Vec<Review> = sqlx::query_as("SELECT target,decision,note,target_hash,version,updated_at FROM research_reviews WHERE owner_id=? AND report_id=? ORDER BY target").bind(owner).bind(id).fetch_all(pool).await?;
    Ok(
        json!({"document":doc,"revision":revision,"updated_at":updated_at,"target_hashes":hashes,"reviews":reviews}),
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

async fn list_route(
    State(st): State<AppState>,
    CurrentUser(u): CurrentUser,
) -> AppResult<Json<Value>> {
    Ok(Json(list(&st.pool, &u.id).await?))
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

#[cfg(test)]
mod tests;
