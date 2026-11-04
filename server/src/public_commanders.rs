//! Public observed commander win rates, derived from enabled owners' active dataset revisions.
//! Counts provide wins / all games; clean-room score records may carry a separately derived
//! observed rate. Scores never imply a win percentage. Combined rates weight each observation
//! by reported games; cross-service overlap is unknown. Raw Mythic responses stay outside Yama.
//! Existing cohort-adjusted score calculations remain available for legacy/operator evidence.
mod html;
#[cfg(test)]
mod tests;

use crate::admin::AdminUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::now;
use axum::extract::{Path, State};
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

/// Prior strength in games, at the source's average commander.
pub const PRIOR: f64 = 100.0;
/// Log-odds per logistic unit of the 0–100 score: 50 is average, about double the odds is 80.
pub const SCALE: f64 = 0.5;
/// A game record counts as half an independent game (four seats, repeat pilots), at most 2,000,
/// and no more than four per pilot.
const DESIGN_EFFECT: f64 = 2.0;
const PER_PILOT: f64 = 4.0;
const MAX_EFFECTIVE: f64 = 2000.0;
const Z95: f64 = 1.959_963_985;
pub const METHOD: &str = "observed-commander-win-rate-v1";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/commanders", get(html::index))
        .route("/commanders/", get(html::index))
        .route("/api/admin/commander-evidence", get(report_route))
        .route(
            "/api/admin/commander-evidence/sources/{source}",
            put(enable_route).delete(disable_route),
        )
}

/// One estimate in relative log-odds against its source's average commander.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Estimate {
    pub mu: f64,
    pub var: f64,
}

fn logit(p: f64) -> f64 {
    (p / (1.0 - p)).ln()
}
fn logistic(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// The variance in relative log-odds of a prior worth `strength` games at a source's average `p0`.
pub fn prior_var(p0: f64, strength: f64) -> f64 {
    1.0 / (strength * p0) + 1.0 / (strength * (1.0 - p0))
}

/// Posterior from raw wins and games against the source's average `p0`.
pub fn from_counts(wins: u64, games: u64, pilots: Option<u64>, p0: f64) -> Option<Estimate> {
    if games == 0 || wins > games || !(0.0..1.0).contains(&p0) || p0 <= 0.0 {
        return None;
    }
    let mut n = (games as f64 / DESIGN_EFFECT).min(MAX_EFFECTIVE);
    if let Some(p) = pilots.filter(|p| *p > 0) {
        n = n.min(PER_PILOT * p as f64);
    }
    let rate = wins as f64 / games as f64;
    let a = PRIOR * p0 + n * rate;
    let b = PRIOR * (1.0 - p0) + n * (1.0 - rate);
    Some(Estimate { mu: (a / b).ln() - logit(p0), var: 1.0 / a + 1.0 / b })
}

/// A source's own score on this scale, with its 95% interval, back to relative log-odds.
pub fn from_score(score: f64, lo: f64, hi: f64) -> Option<Estimate> {
    let ok = |s: f64| s.is_finite() && s > 0.0 && s < 100.0;
    if !(ok(score) && ok(lo) && ok(hi) && lo <= score && score <= hi && lo < hi) {
        return None;
    }
    let back = |s: f64| SCALE * logit(s / 100.0);
    let sd = (back(hi) - back(lo)) / (2.0 * Z95);
    let e = Estimate { mu: back(score), var: sd * sd };
    // Extreme figures (a bound that underflows to 0) would give an infinite or zero spread.
    (e.mu.is_finite() && e.var.is_finite() && e.var > 0.0).then_some(e)
}

/// Multiply the sources' posteriors, take each source's own prior back out and put one common
/// prior in: the average of their prior variances, so the order of the sources never matters.
/// `parts` pairs each estimate with its prior variance (infinite when unknown: nothing removed).
/// Every prior is centred on the source's average, 0 here, so it adds precision but no weight.
pub fn combine(parts: &[(Estimate, f64)]) -> Option<Estimate> {
    let known: Vec<f64> = parts.iter().map(|(_, p)| *p).filter(|p| p.is_finite() && *p > 0.0).collect();
    let mut precision = 0.0;
    let mut weighted = 0.0;
    let mut floor: f64 = 0.0;
    for (e, prior) in parts {
        if !(e.mu.is_finite() && e.var.is_finite() && e.var > 0.0) {
            return None;
        }
        precision += 1.0 / e.var;
        weighted += e.mu / e.var;
        floor = floor.max(1.0 / e.var);
        if prior.is_finite() && *prior > 0.0 {
            precision -= 1.0 / prior;
        }
    }
    if parts.is_empty() {
        return None;
    }
    if !known.is_empty() {
        precision += known.len() as f64 / known.iter().sum::<f64>();
    }
    // The data never makes a combination less certain than its surest source.
    let precision = precision.max(floor);
    let e = Estimate { mu: weighted / precision, var: 1.0 / precision };
    (e.mu.is_finite() && e.var.is_finite() && e.var > 0.0).then_some(e)
}

/// The 0–100 score of a relative log-odds value.
pub fn score(mu: f64) -> f64 {
    100.0 * logistic(mu / SCALE)
}

#[derive(Debug, Clone, Serialize)]
pub struct Art {
    pub url: String,
    pub artist: Option<String>,
}

/// What one source says about one commander.
#[derive(Debug, Clone, Serialize)]
pub struct Figure {
    pub source: String,
    pub games: u64,
    /// Raw win share, when the source reports wins.
    pub win_rate: Option<f64>,
    /// Decks or pilots behind the games, when reported.
    pub decks: Option<u64>,
    /// This source alone on the page's scale.
    pub score: f64,
    #[serde(skip)]
    estimate: Option<Estimate>,
    #[serde(skip)]
    prior_var: f64,
}

/// A descriptive game-weighted mean, using observed rates only. A legacy score never
/// becomes a win rate. Reported games may overlap between services; these are not unique games.
fn combined_win_rate(figures: &[Figure]) -> Option<(f64, u64, usize)> {
    let mut weighted = 0.0;
    let mut games = 0u64;
    let mut sources = 0;
    for f in figures {
        if let Some(rate) = f
            .win_rate
            .filter(|p| p.is_finite() && (0.0..=1.0).contains(p))
            .filter(|_| f.games > 0)
        {
            games = games.checked_add(f.games)?;
            weighted += rate * f.games as f64;
            sources += 1;
        }
    }
    (games > 0).then(|| ((weighted / games as f64).clamp(0.0, 1.0), games, sources))
}

/// A catalog precon the commander leads. Its rank is looked up when the page is shown, from
/// rating v2's own cache, so it never lags behind the precon pages.
#[derive(Debug, Clone, Serialize)]
pub struct PreconLink {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Commander {
    /// Sorted Oracle ids joined by `+`; partners are one commander.
    pub key: String,
    pub name: String,
    pub color_identity: String,
    pub art: Option<Art>,
    pub win_rate: Option<f64>,
    /// Reported games contributing to the observed rate; score-only imports are excluded.
    pub win_rate_games: u64,
    pub win_rate_sources: usize,
    pub score: f64,
    pub lo: f64,
    pub hi: f64,
    pub games: u64,
    pub evidence: &'static str,
    pub sources: Vec<Figure>,
    pub precons: Vec<PreconLink>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Source {
    pub name: String,
    pub url: Option<String>,
    pub attribution: String,
    pub license: String,
    pub commanders: usize,
    pub games: u64,
    /// The average commander's win share in this source, when it reports wins.
    pub baseline: Option<f64>,
}

/// How closely two sources agree on the commanders they share (Pearson, relative log-odds).
#[derive(Debug, Clone, Serialize)]
pub struct Agreement {
    pub a: String,
    pub b: String,
    pub commanders: usize,
    pub correlation: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Ranking {
    pub method: &'static str,
    pub as_of: DateTime<Utc>,
    pub sources: Vec<Source>,
    pub agreement: Option<Agreement>,
    /// Best first.
    pub commanders: Vec<Commander>,
}

fn evidence(lo: f64, hi: f64) -> &'static str {
    match hi - lo {
        w if w <= 12.0 => "moderate",
        w if w <= 25.0 => "low",
        _ => "very low",
    }
}

struct Enabled {
    revision_id: String,
    metadata: Value,
}

async fn enabled(pool: &SqlitePool) -> AppResult<Vec<Enabled>> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT r.id, r.metadata FROM commander_evidence_sources s
         JOIN evidence_datasets d ON d.owner_id = s.owner_id
         JOIN evidence_dataset_revisions r ON r.id = d.current_revision_id
         WHERE json_extract(r.metadata, '$.source.name') = s.source_name
         ORDER BY r.imported_at DESC, r.id",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|(revision_id, meta)| {
            Ok(Enabled { revision_id, metadata: serde_json::from_str(&meta).map_err(anyhow::Error::from)? })
        })
        .collect()
}

/// One parsed commander record, before identities are resolved.
enum Shape {
    Counts { wins: u64, games: u64, pilots: Option<u64> },
    Score { score: f64, lo: f64, hi: f64, games: u64, decks: Option<u64>, baseline: Option<f64>, prior: Option<f64>, win_rate: Option<f64> },
}
struct Parsed {
    oracle_ids: Vec<String>,
    scryfall_id: Option<String>,
    name: String,
    shape: Shape,
}

fn u64_of(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}
fn f64_of(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).filter(|x| x.is_finite())
}

fn parse(data: &Value) -> Option<Parsed> {
    let mut oracle_ids: Vec<String> = match (&data["oracle_ids"], &data["oracle_id"]) {
        (Value::Array(ids), _) => ids.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        (_, Value::String(id)) => vec![id.clone()],
        _ => Vec::new(),
    };
    oracle_ids.retain(|s| !s.is_empty() && s.len() <= 64);
    oracle_ids.sort();
    oracle_ids.dedup();
    let name = data["name"].as_str().unwrap_or_default().trim().to_string();
    let shape = if let (Some(games), Some(wins)) = (u64_of(&data["game_played_count"]), u64_of(&data["game_win_count"])) {
        if games == 0 || wins > games {
            return None;
        }
        Shape::Counts { wins, games, pilots: u64_of(&data["pilot_count"]) }
    } else if let Some(score) = f64_of(&data["score_0_100"]) {
        Shape::Score {
            score,
            win_rate: f64_of(&data["win_rate"]).filter(|p| (0.0..=1.0).contains(p)),
            lo: f64_of(&data["interval_low"])?,
            hi: f64_of(&data["interval_high"])?,
            games: u64_of(&data["games"]).unwrap_or(0),
            decks: u64_of(&data["decks"]),
            baseline: f64_of(&data["baseline"]).filter(|p| *p > 0.0 && *p < 1.0),
            prior: f64_of(&data["prior_strength"]).filter(|s| *s > 0.0),
        }
    } else {
        return None;
    };
    Some(Parsed {
        oracle_ids,
        scryfall_id: data["scryfall_id"].as_str().filter(|s| s.len() <= 64).map(str::to_string),
        name,
        shape,
    })
}

/// Oracle ids for printings and names the records give instead.
async fn resolve(pool: &SqlitePool, parsed: &[Parsed]) -> AppResult<(HashMap<String, String>, HashMap<String, String>)> {
    let printings: Vec<&str> = parsed
        .iter()
        .filter(|p| p.oracle_ids.is_empty())
        .filter_map(|p| p.scryfall_id.as_deref())
        .collect();
    let by_printing: HashMap<String, String> = sqlx::query_as::<_, (String, String)>(
        "SELECT scryfall_id, oracle_id FROM printings WHERE scryfall_id IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(&printings).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect();
    let names: Vec<&str> = parsed
        .iter()
        .filter(|p| p.oracle_ids.is_empty() && p.scryfall_id.as_ref().is_none_or(|s| !by_printing.contains_key(s)))
        .map(|p| p.name.as_str())
        .filter(|n| !n.is_empty())
        .collect();
    // card_names compares without ASCII case; both sides are then folded the same way in Rust
    // (SQLite's lower() leaves "É" alone, Rust's doesn't).
    let mut candidates: HashMap<String, BTreeSet<String>> = HashMap::new();
    for (name, oracle) in sqlx::query_as::<_, (String, String)>("SELECT name, oracle_id FROM card_names WHERE name IN (SELECT value FROM json_each(?))")
        .bind(serde_json::to_string(&names).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?
    {
        candidates.entry(name.to_lowercase()).or_default().insert(oracle);
    }
    // A name shared by several cards is ambiguous: leave it out rather than guess.
    let by_name = candidates
        .into_iter()
        .filter(|(_, ids)| ids.len() == 1)
        .filter_map(|(name, ids)| ids.into_iter().next().map(|id| (name, id)))
        .collect();
    Ok((by_printing, by_name))
}

struct Card {
    name: String,
    color_identity: String,
    art: Option<Art>,
}

async fn cards(pool: &SqlitePool, ids: &BTreeSet<String>) -> AppResult<HashMap<String, Card>> {
    let rows: Vec<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT oracle_id, name, color_identity, image_art_crop, artist FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(ids).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, color_identity, art, artist)| {
            (id, Card { name, color_identity, art: art.filter(|u| u.starts_with("https://cards.scryfall.io/")).map(|url| Art { url, artist }) })
        })
        .collect())
}

/// Catalog precons by their commanders' Oracle ids.
async fn precons(pool: &SqlitePool) -> AppResult<Vec<(BTreeSet<String>, PreconLink)>> {
    let rows: Vec<(String, String, String)> = sqlx::query_as("SELECT id, name, cards FROM precons ORDER BY id").fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .filter_map(|(id, name, cards)| {
            let cards: Vec<Value> = serde_json::from_str(&cards).ok()?;
            let commanders: BTreeSet<String> = cards
                .iter()
                .filter(|c| c["board"] == "commander")
                .filter_map(|c| c["oracle_id"].as_str().map(str::to_string))
                .collect();
            (!commanders.is_empty()).then_some((commanders, PreconLink { id, name }))
        })
        .collect())
}

fn pearson(pairs: &[(f64, f64)]) -> Option<f64> {
    let n = pairs.len() as f64;
    if pairs.len() < 10 {
        return None;
    }
    let (mx, my) = pairs.iter().fold((0.0, 0.0), |(a, b), (x, y)| (a + x / n, b + y / n));
    let (mut sxy, mut sxx, mut syy) = (0.0, 0.0, 0.0);
    for (x, y) in pairs {
        sxy += (x - mx) * (y - my);
        sxx += (x - mx) * (x - mx);
        syy += (y - my) * (y - my);
    }
    (sxx > 0.0 && syy > 0.0).then(|| sxy / (sxx * syy).sqrt())
}

/// The ranking from the enabled sources' active dataset revisions.
pub async fn derive(pool: &SqlitePool) -> AppResult<Ranking> {
    let as_of = Utc::now();
    let revisions = enabled(pool).await?;
    // Source name → its revisions, newest import first.
    let mut groups: BTreeMap<String, Vec<&Enabled>> = BTreeMap::new();
    for r in &revisions {
        if let Some(name) = r.metadata["source"]["name"].as_str() {
            groups.entry(name.to_string()).or_default().push(r);
        }
    }
    // Source → identity → (display name, the newest revision's merged figure).
    let mut per_source: Vec<(Source, BTreeMap<String, (String, Shape)>)> = Vec::new();
    for (name, revisions) in &groups {
        let mut chosen: BTreeMap<String, (String, Shape)> = BTreeMap::new();
        for r in revisions {
            let rows: Vec<String> = sqlx::query_scalar(
                "SELECT document FROM evidence_dataset_records WHERE revision_id = ? AND kind = 'commander' ORDER BY id",
            )
            .bind(&r.revision_id)
            .fetch_all(pool)
            .await?;
            let parsed: Vec<Parsed> = rows
                .iter()
                .filter_map(|row| serde_json::from_str::<Value>(row).ok())
                .filter_map(|record| parse(&record["data"]))
                .collect();
            let (by_printing, by_name) = resolve(pool, &parsed).await?;
            // Records for the same card in one revision (an Alchemy twin, a reprint) merge.
            let mut here: BTreeMap<String, (String, Shape)> = BTreeMap::new();
            for p in parsed {
                let ids = if !p.oracle_ids.is_empty() {
                    p.oracle_ids
                } else if let Some(id) = p.scryfall_id.as_ref().and_then(|s| by_printing.get(s)).or_else(|| by_name.get(&p.name.to_lowercase())) {
                    vec![id.clone()]
                } else {
                    continue;
                };
                let key = ids.join("+");
                // Whether the record is already accounted for; otherwise it replaces what's there.
                let kept = match (here.get_mut(&key), &p.shape) {
                    (Some((_, Shape::Counts { wins, games, pilots })), Shape::Counts { wins: w, games: g, pilots: pl }) => {
                        *wins += w;
                        *games += g;
                        *pilots = match (*pilots, *pl) {
                            (Some(a), Some(b)) => Some(a + b),
                            (a, b) => a.or(b),
                        };
                        true
                    }
                    // Two scores for one commander: the one with more games stands.
                    (Some((_, Shape::Score { games, .. })), Shape::Score { games: g, .. }) => *g <= *games,
                    (Some(_), _) => true,
                    (None, _) => false,
                };
                if !kept {
                    here.insert(key, (p.name, p.shape));
                }
            }
            // Datasets from one source overlap: the newest revision that has a commander wins.
            for (key, v) in here {
                chosen.entry(key).or_insert(v);
            }
        }
        let first = &revisions[0].metadata["source"];
        let distinct = |field: &str| {
            let mut seen: Vec<&str> = Vec::new();
            for r in revisions {
                let v = r.metadata["source"][field].as_str().unwrap_or_default().trim();
                if !v.is_empty() && !seen.contains(&v) {
                    seen.push(v);
                }
            }
            seen.join("; ")
        };
        let (wins, games) = chosen.values().fold((0u64, 0u64), |(w, g), (_, s)| match s {
            Shape::Counts { wins, games, .. } => (w + wins, g + games),
            Shape::Score { .. } => (w, g),
        });
        let total_games = chosen
            .values()
            .map(|(_, s)| match s {
                Shape::Counts { games, .. } | Shape::Score { games, .. } => *games,
            })
            .sum();
        let source = Source {
            name: name.clone(),
            url: first["url"].as_str().filter(|u| u.starts_with("https://")).map(str::to_string),
            attribution: distinct("attribution"),
            license: distinct("license"),
            commanders: chosen.len(),
            games: total_games,
            baseline: (games > 0).then(|| wins as f64 / games as f64),
        };
        per_source.push((source, chosen));
    }

    // Identity → each source's figure.
    let mut figures: BTreeMap<String, Vec<(String, Figure)>> = BTreeMap::new();
    for (source, chosen) in &per_source {
        for (key, (name, shape)) in chosen {
            let figure = match *shape {
                Shape::Counts { wins, games, pilots } => {
                    let p0 = source.baseline.unwrap_or(0.25);
                    let estimate = from_counts(wins, games, pilots, p0);
                    Figure {
                        source: source.name.clone(),
                        games,
                        win_rate: Some(wins as f64 / games as f64),
                        decks: pilots,
                        score: estimate.map(|e| score(e.mu)).unwrap_or(50.0),
                        estimate,
                        prior_var: prior_var(p0, PRIOR),
                    }
                }
                Shape::Score { score: s, lo, hi, games, decks, baseline, prior, win_rate } => Figure {
                    source: source.name.clone(),
                    games,
                    win_rate: win_rate.filter(|_| games > 0),
                    decks,
                    score: s,
                    estimate: from_score(s, lo, hi),
                    // The prior the source's own score used; without both figures nothing is divided out.
                    prior_var: baseline.zip(prior).map(|(p0, s)| prior_var(p0, s)).unwrap_or(f64::INFINITY),
                },
            };
            if figure.estimate.is_some() || (figure.win_rate.is_some() && figure.games > 0) {
                figures.entry(key.clone()).or_default().push((name.clone(), figure));
            }
        }
    }

    let ids: BTreeSet<String> = figures.keys().flat_map(|k| k.split('+').map(str::to_string)).collect();
    let cards = cards(pool, &ids).await?;
    let precons = precons(pool).await?;
    let mut commanders: Vec<Commander> = figures
        .into_iter()
        .filter_map(|(key, figures)| {
            let parts: Vec<(Estimate, f64)> = figures.iter().filter_map(|(_, f)| f.estimate.map(|e| (e, f.prior_var))).collect();
            let source_figures: Vec<Figure> = figures.iter().map(|(_, f)| f.clone()).collect();
            let observed = combined_win_rate(&source_figures);
            // A source with all wins or no wins has a valid observed rate even when its
            // cohort baseline cannot support log-odds. Its internal score remains prior-only.
            let combined = combine(&parts).or_else(|| observed.map(|_| Estimate { mu: 0.0, var: prior_var(0.25, PRIOR) }))?;
            let sd = combined.var.sqrt();
            let ids: Vec<&str> = key.split('+').collect();
            let known: Vec<&Card> = ids.iter().filter_map(|id| cards.get(*id)).collect();
            let name = if known.len() == ids.len() {
                known.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(" + ")
            } else {
                figures[0].0.clone()
            };
            if name.is_empty() {
                return None;
            }
            let colors: BTreeSet<char> = known.iter().flat_map(|c| c.color_identity.chars()).collect();
            let color_identity = "WUBRG".chars().filter(|c| colors.contains(c)).collect();
            let set: BTreeSet<String> = ids.iter().map(|s| s.to_string()).collect();
            let (lo, hi) = (score(combined.mu - Z95 * sd), score(combined.mu + Z95 * sd));
            Some(Commander {
                art: known.first().and_then(|c| c.art.clone()),
                name,
                color_identity,
                win_rate: observed.map(|(r, _, _)| r),
                win_rate_games: observed.map(|(_, g, _)| g).unwrap_or(0),
                win_rate_sources: observed.map(|(_, _, n)| n).unwrap_or(0),
                score: score(combined.mu),
                lo,
                hi,
                games: source_figures.iter().map(|f| f.games).sum(),
                evidence: evidence(lo, hi),
                sources: source_figures,
                precons: precons.iter().filter(|(c, _)| set.is_subset(c)).map(|(_, p)| p.clone()).collect(),
                key,
            })
        })
        .collect();
    commanders.sort_by(|a, b| b.win_rate.partial_cmp(&a.win_rate).unwrap_or(std::cmp::Ordering::Equal).then(b.win_rate_games.cmp(&a.win_rate_games)).then(a.name.cmp(&b.name)));

    let agreement = match per_source.as_slice() {
        [(a, _), (b, _), ..] => {
            let pairs: Vec<(f64, f64)> = commanders
                .iter()
                .filter_map(|c| {
                    let get = |n: &str| c.sources.iter().find(|f| f.source == n).and_then(|f| f.estimate).map(|e| e.mu);
                    get(&a.name).zip(get(&b.name))
                })
                .collect();
            pearson(&pairs).map(|correlation| Agreement { a: a.name.clone(), b: b.name.clone(), commanders: pairs.len(), correlation })
        }
        _ => None,
    };
    Ok(Ranking { method: METHOD, as_of, sources: per_source.into_iter().map(|(s, _)| s).collect(), agreement, commanders })
}

type Shared = Arc<Ranking>;
/// The ranking, kept until its inputs change (derived.rs).
static RANKING: crate::derived::Kept<Ranking> = crate::derived::Kept::new("public commanders rebuild");

/// Everything the ranking reads, so any change shows on the next request, and the day (its
/// windows end today).
async fn fingerprint(pool: &SqlitePool) -> AppResult<String> {
    let inputs: String = sqlx::query_scalar(
        "SELECT (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT owner_id || ':' || source_name || ':' || enabled_at AS k FROM commander_evidence_sources ORDER BY k))
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT id || ':' || IFNULL(current_revision_id, '') AS k FROM evidence_datasets
                    WHERE owner_id IN (SELECT owner_id FROM commander_evidence_sources) ORDER BY k))
             || '#' || (SELECT IFNULL(max(imported_at), '') || ':' || count(*) FROM precons)
             || '#' || (SELECT IFNULL(max(finished_at), '') FROM import_runs)",
    )
    .fetch_one(pool)
    .await?;
    Ok(format!("{}#{inputs}#{}", pool.connect_options().get_filename().display(), crate::derived::today()))
}

pub async fn ranking(pool: &SqlitePool) -> AppResult<Shared> {
    let key = fingerprint(pool).await?;
    RANKING.get(pool, key, |pool| async move { derive(&pool).await }).await
}

/// Build the ranking now if its inputs changed (derived.rs).
pub async fn prewarm(pool: &SqlitePool) -> AppResult<()> {
    let key = fingerprint(pool).await?;
    RANKING.refresh(pool, key, |pool| async move { derive(&pool).await }).await
}

/// Let `owner`'s datasets from `source_name` feed the public commander ranking.
pub async fn enable(pool: &SqlitePool, owner: &str, source_name: &str) -> AppResult<()> {
    let name = source_name.trim();
    if name.is_empty() || name.len() > 240 {
        return Err(AppError::bad("source name must be 1–240 bytes"));
    }
    sqlx::query("INSERT INTO commander_evidence_sources(owner_id, source_name, enabled_at) VALUES (?,?,?) ON CONFLICT DO NOTHING")
        .bind(owner)
        .bind(name)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn disable(pool: &SqlitePool, owner: &str, source_name: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM commander_evidence_sources WHERE owner_id = ? AND source_name = ?")
        .bind(owner)
        .bind(source_name.trim())
        .execute(pool)
        .await?;
    Ok(())
}

/// The operator's view: enabled sources, coverage, agreement and the top of the ranking.
pub async fn report(pool: &SqlitePool) -> AppResult<Value> {
    let enabled: Vec<Value> = sqlx::query_as::<_, (String, String, String)>(
        "SELECT u.email, s.source_name, s.enabled_at FROM commander_evidence_sources s JOIN users u ON u.id = s.owner_id ORDER BY s.source_name, u.email",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(owner, source, at)| json!({"owner": owner, "source_name": source, "enabled_at": at}))
    .collect();
    let r = derive(pool).await?;
    let top: Vec<Value> = r
        .commanders
        .iter()
        .filter(|c| c.games >= 100)
        .take(15)
        .map(|c| json!({"name": c.name, "win_rate": c.win_rate, "win_rate_games": c.win_rate_games, "score": (c.score * 10.0).round() / 10.0, "interval": [(c.lo * 10.0).round() / 10.0, (c.hi * 10.0).round() / 10.0], "games": c.games, "sources": c.sources.len()}))
        .collect();
    Ok(json!({"enabled": enabled, "method": r.method, "sources": r.sources, "agreement": r.agreement, "commanders": r.commanders.len(), "top_with_100_games": top}))
}

async fn report_route(State(st): State<AppState>, _a: AdminUser) -> AppResult<Json<Value>> {
    Ok(Json(report(&st.pool).await?))
}

async fn enable_route(State(st): State<AppState>, AdminUser(user): AdminUser, Path(source): Path<String>) -> AppResult<Json<Value>> {
    enable(&st.pool, &user.id, &source).await?;
    Ok(Json(report(&st.pool).await?))
}

async fn disable_route(State(st): State<AppState>, AdminUser(user): AdminUser, Path(source): Path<String>) -> AppResult<Json<Value>> {
    disable(&st.pool, &user.id, &source).await?;
    Ok(Json(report(&st.pool).await?))
}

/// `yama-server commander-evidence report | use SOURCE --owner EMAIL | stop SOURCE --owner EMAIL`
pub async fn cli(pool: &SqlitePool, args: &[String]) -> anyhow::Result<()> {
    const USAGE: &str = "usage: yama-server commander-evidence report | use SOURCE --owner EMAIL | stop SOURCE --owner EMAIL";
    let err = |e: AppError| anyhow::anyhow!("{e}");
    let owner = args.iter().position(|a| a == "--owner").and_then(|i| args.get(i + 1)).cloned();
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("report"), None) => {}
        (Some(cmd @ ("use" | "stop")), Some(source)) if !source.starts_with("--") => {
            let email = owner.ok_or_else(|| anyhow::anyhow!("--owner EMAIL is required"))?;
            let owner = crate::decks::cli::owner_id(pool, &email).await?;
            let done = if cmd == "use" { enable(pool, &owner, source).await } else { disable(pool, &owner, source).await };
            done.map_err(err)?;
        }
        _ => anyhow::bail!(USAGE),
    }
    println!("{}", serde_json::to_string_pretty(&report(pool).await.map_err(err)?)?);
    Ok(())
}
