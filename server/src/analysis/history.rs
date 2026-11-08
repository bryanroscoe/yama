//! `GET /api/decks/{id}/analysis`: the current list's full analysis, then a line per saved
//! version (newest first) and per configuration of the deck, so the page can show how its
//! power and vectors moved. Computed on request from the stored lists and their Spellbook
//! checks; reading never starts a check.

use super::{Cache, DeckAnalysis, Entry, METHOD, analyze, facts_for};
use crate::auth::CurrentUser;
use crate::decks::DeckCard;
use crate::error::AppResult;
use crate::routes::AppState;
use axum::extract::{Path, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap};

/// Versions summarized at most, newest kept.
const MAX_VERSIONS: usize = 60;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/decks/{id}/analysis", get(deck_analysis))
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Summary {
    pub power: f64,
    pub margin: f64,
    /// Vector key to 0-100.
    pub scores: BTreeMap<&'static str, f64>,
    /// Whether a Commander Spellbook check was there (combos count only then).
    pub checked: bool,
}

impl From<&DeckAnalysis> for Summary {
    fn from(a: &DeckAnalysis) -> Self {
        Summary {
            power: a.power,
            margin: a.margin,
            scores: a.vectors.iter().map(|v| (vector_key(v.key), v.score)).collect(),
            checked: a.combos.checked,
        }
    }
}

fn vector_key(v: super::classify::Vector) -> &'static str {
    use super::classify::Vector::*;
    match v {
        Speed => "speed",
        Consistency => "consistency",
        Interaction => "interaction",
        Mana => "mana",
        Threats => "threats",
    }
}

#[derive(Serialize)]
struct VersionPoint {
    id: String,
    /// 1 for the first save, counting up.
    number: i64,
    note: Option<String>,
    created_at: String,
    current: bool,
    history_only: bool,
    #[serde(flatten)]
    summary: Summary,
}

#[derive(Serialize)]
struct ConfigurationPoint {
    id: String,
    name: String,
    configuration: Option<String>,
    /// The deck this page is for.
    this: bool,
    version_id: Option<String>,
    #[serde(flatten)]
    summary: Option<Summary>,
}

#[derive(Serialize)]
struct Response {
    method: &'static str,
    /// The current list's analysis; null while the deck has no cards.
    current: Option<DeckAnalysis>,
    versions: Vec<VersionPoint>,
    configurations: Vec<ConfigurationPoint>,
    computed_at: String,
}

#[derive(sqlx::FromRow)]
struct VersionRow {
    id: String,
    note: Option<String>,
    created_at: String,
    history_only: bool,
}

async fn deck_analysis(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Response>> {
    let (_, current, _) = crate::decks::owned_deck(&st.pool, &user.id, &id).await?;
    let rows: Vec<VersionRow> =
        sqlx::query_as("SELECT id, note, created_at, history_only FROM deck_versions WHERE deck_id = ? ORDER BY created_at, rowid").bind(&id).fetch_all(&st.pool).await?;
    let configs = crate::decks::configuration_group(&st.pool, &user.id, &id).await?;
    let config_versions: HashMap<String, Option<String>> = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, current_version_id FROM decks WHERE owner_id = ? AND id IN (SELECT value FROM json_each(?))",
    )
    .bind(&user.id)
    .bind(serde_json::to_string(&configs.iter().map(|c| c.id.as_str()).collect::<Vec<_>>()).map_err(anyhow::Error::from)?)
    .fetch_all(&st.pool)
    .await?
    .into_iter()
    .collect();

    let skip = rows.len().saturating_sub(MAX_VERSIONS);
    let mut wanted: Vec<String> = rows.iter().skip(skip).map(|r| r.id.clone()).collect();
    wanted.extend(current.iter().cloned());
    wanted.extend(config_versions.values().flatten().cloned());
    wanted.sort();
    wanted.dedup();
    let lists = crate::decks::load_versions_cards(&st.pool, &wanted).await?;
    let results = summarize(&st.pool, &lists).await?;

    let mut versions: Vec<VersionPoint> = rows
        .iter()
        .enumerate()
        .skip(skip)
        .filter_map(|(i, r)| {
            let (summary, _) = results.get(&r.id)?;
            Some(VersionPoint {
                id: r.id.clone(),
                number: i as i64 + 1,
                note: r.note.clone(),
                created_at: r.created_at.clone(),
                current: current.as_deref() == Some(r.id.as_str()),
                history_only: r.history_only,
                summary: summary.clone(),
            })
        })
        .collect();
    versions.reverse();
    let configurations = configs
        .into_iter()
        .map(|c| {
            let version_id = config_versions.get(&c.id).cloned().flatten();
            let summary = version_id.as_ref().and_then(|v| results.get(v)).map(|(s, _)| s.clone());
            ConfigurationPoint { this: c.id == id, id: c.id, name: c.name, configuration: c.configuration, version_id, summary }
        })
        .collect();
    let current = current.and_then(|v| results.get(&v).map(|(_, a)| a.clone()));
    Ok(Json(Response { method: METHOD, current, versions, configurations, computed_at: crate::util::now() }))
}

/// Every list's analysis (and its summary), card data loaded once for all of them.
async fn summarize(pool: &SqlitePool, lists: &HashMap<String, Vec<DeckCard>>) -> AppResult<HashMap<String, (Summary, DeckAnalysis)>> {
    let mut all: Vec<DeckCard> = lists.values().flatten().cloned().collect();
    all.sort_by(|a, b| a.oracle_id.cmp(&b.oracle_id));
    all.dedup_by(|a, b| a.oracle_id == b.oracle_id);
    let info = crate::decks::card_info(pool, &all).await?;
    let produced = crate::decks::produced_mana(pool, &all.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    let facts = facts_for(&all, &info, &produced);
    let mut cache = Cache::default();
    let mut out = HashMap::new();
    for (version, cards) in lists {
        if cards.iter().all(|c| c.qty <= 0) {
            continue;
        }
        let check = crate::deck_checks::view(pool, Some(version.as_str()), false).await?.result;
        let entries: Vec<Entry> = cards.iter().map(|c| Entry { card: c, facts: facts.get(&c.oracle_id) }).collect();
        let a = analyze(&entries, check.as_ref(), &mut cache);
        out.insert(version.clone(), (Summary::from(&a), a));
    }
    Ok(out)
}
