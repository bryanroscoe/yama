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
    /// The commander's public record over every list recorded under it (/commanders); null
    /// with no commander or no recorded games. Beside the analysis, never part of the score.
    commander: Option<crate::public_commanders::Record>,
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

    // Numbered as History numbers them (every save counts), but a scan kept for History only
    // was never the deck's list, so it isn't scored; the newest MAX_VERSIONS lists are.
    let numbered: Vec<(i64, &VersionRow)> = rows.iter().enumerate().map(|(i, r)| (i as i64 + 1, r)).filter(|(_, r)| !r.history_only).collect();
    let kept = &numbered[numbered.len().saturating_sub(MAX_VERSIONS)..];
    let mut wanted: Vec<String> = kept.iter().map(|(_, r)| r.id.clone()).collect();
    wanted.extend(current.iter().cloned());
    wanted.extend(config_versions.values().flatten().cloned());
    wanted.sort();
    wanted.dedup();
    let lists = crate::decks::load_versions_cards(&st.pool, &wanted).await?;
    let commander = match current.as_ref().and_then(|v| lists.get(v)) {
        Some(cards) => crate::public_commanders::record_for(&st.pool, cards).await,
        None => None,
    };
    let results = summarize(&st.pool, lists, current.clone()).await?;

    let mut versions: Vec<VersionPoint> = kept
        .iter()
        .filter_map(|(number, r)| {
            let (summary, _) = results.get(&r.id)?;
            Some(VersionPoint {
                id: r.id.clone(),
                number: *number,
                note: r.note.clone(),
                created_at: r.created_at.clone(),
                current: current.as_deref() == Some(r.id.as_str()),
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
    Ok(Json(Response { method: METHOD, current, commander, versions, configurations, computed_at: crate::util::now() }))
}

/// Every list's analysis (and its summary): card data and Spellbook answers loaded in one go
/// for all of them, the scoring off the async runtime. Only the `current` list names themes.
async fn summarize(pool: &SqlitePool, lists: HashMap<String, Vec<DeckCard>>, current: Option<String>) -> AppResult<HashMap<String, (Summary, DeckAnalysis)>> {
    let mut all: Vec<DeckCard> = lists.values().flatten().cloned().collect();
    all.sort_by(|a, b| a.oracle_id.cmp(&b.oracle_id));
    all.dedup_by(|a, b| a.oracle_id == b.oracle_id);
    let info = crate::decks::card_info(pool, &all).await?;
    let produced = crate::decks::produced_mana(pool, &all.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    let facts = facts_for(&all, &info, &produced);
    let checks = crate::deck_checks::results(pool, &lists.keys().cloned().collect::<Vec<_>>()).await?;
    let out = tokio::task::spawn_blocking(move || {
        let mut cache = Cache::default();
        let mut out = HashMap::new();
        for (version, cards) in &lists {
            if cards.iter().all(|c| c.qty <= 0) {
                continue;
            }
            let entries: Vec<Entry> = cards.iter().map(|c| Entry { card: c, facts: facts.get(&c.oracle_id) }).collect();
            cache.skip_themes = current.as_deref() != Some(version.as_str());
            let a = analyze(&entries, checks.get(version), &mut cache);
            out.insert(version.clone(), (Summary::from(&a), a));
        }
        out
    })
    .await
    .map_err(anyhow::Error::from)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use crate::testutil::{app, deck, send, user};
    use axum::http::{Method, StatusCode};
    use serde_json::json;
    use sqlx::SqlitePool;

    /// Saves another version of `deck` at an hour of 2027-01-01 (later than any made now) and
    /// makes it current unless it's a History-only scan.
    async fn version(pool: &SqlitePool, deck: &str, n: i64, history_only: bool) -> String {
        let id = format!("{deck}-v{n}");
        let cards = json!([{ "oracle_id": "o-commander", "name": "Test Commander", "qty": 1, "board": "commander" }]).to_string();
        sqlx::query("INSERT INTO deck_versions (id, deck_id, cards, note, created_at, history_only) VALUES (?, ?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(deck)
            .bind(cards)
            .bind(format!("save {n}"))
            .bind(format!("2027-01-01T{:02}:{:02}:00Z", n / 60, n % 60))
            .bind(history_only)
            .execute(pool)
            .await
            .unwrap();
        if !history_only {
            sqlx::query("UPDATE decks SET current_version_id = ? WHERE id = ?").bind(&id).bind(deck).execute(pool).await.unwrap();
        }
        id
    }

    #[tokio::test]
    async fn only_the_owner_reads_a_decks_analysis() {
        let (app, pool) = app().await;
        let (owner, owner_token) = user(&pool, "owner@example.com").await;
        let (_, other_token) = user(&pool, "other@example.com").await;
        let (id, _) = deck(&pool, &owner, "Mine").await;
        let (status, body) = send(&app, Method::GET, &format!("/api/decks/{id}/analysis"), Some(&owner_token), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["current"]["power"].as_f64().unwrap() >= 1.0, "{body}");
        let (status, _) = send(&app, Method::GET, &format!("/api/decks/{id}/analysis"), Some(&other_token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&app, Method::GET, &format!("/api/decks/{id}/analysis"), None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn versions_are_numbered_as_history_numbers_them_without_scans() {
        let (app, pool) = app().await;
        let (owner, token) = user(&pool, "owner@example.com").await;
        let (id, first) = deck(&pool, &owner, "Mine").await;
        version(&pool, &id, 2, true).await;
        let third = version(&pool, &id, 3, false).await;
        let (status, body) = send(&app, Method::GET, &format!("/api/decks/{id}/analysis"), Some(&token), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let versions = body["versions"].as_array().unwrap();
        let seen: Vec<(&str, i64, bool)> = versions.iter().map(|v| (v["id"].as_str().unwrap(), v["number"].as_i64().unwrap(), v["current"].as_bool().unwrap())).collect();
        assert_eq!(seen, [(third.as_str(), 3, true), (first.as_str(), 1, false)], "newest first, the scan left out");
        for v in versions {
            for key in ["speed", "consistency", "interaction", "mana", "threats"] {
                assert!(v["scores"][key].is_number(), "{v}");
            }
            assert_eq!(v["checked"], false);
        }
    }

    #[tokio::test]
    async fn keeps_the_newest_sixty_versions() {
        let (app, pool) = app().await;
        let (owner, token) = user(&pool, "owner@example.com").await;
        let (id, _) = deck(&pool, &owner, "Mine").await;
        for n in 2..=62 {
            version(&pool, &id, n, false).await;
        }
        let (_, body) = send(&app, Method::GET, &format!("/api/decks/{id}/analysis"), Some(&token), None).await;
        let numbers: Vec<i64> = body["versions"].as_array().unwrap().iter().map(|v| v["number"].as_i64().unwrap()).collect();
        assert_eq!(numbers.len(), super::MAX_VERSIONS);
        assert_eq!((numbers[0], numbers[numbers.len() - 1]), (62, 3));
    }

    #[tokio::test]
    async fn configurations_sit_side_by_side() {
        let (app, pool) = app().await;
        let (owner, token) = user(&pool, "owner@example.com").await;
        let (id, _) = deck(&pool, &owner, "Mine").await;
        let (status, made) = send(&app, Method::POST, &format!("/api/decks/{id}/configurations"), Some(&token), Some(json!({ "configuration": "stock", "op_id": "c1" }))).await;
        assert_eq!(status, StatusCode::OK, "{made}");
        let (_, body) = send(&app, Method::GET, &format!("/api/decks/{id}/analysis"), Some(&token), None).await;
        let configs = body["configurations"].as_array().unwrap();
        assert_eq!(configs.len(), 2, "{body}");
        assert_eq!(configs[0]["id"], id.as_str());
        assert_eq!(configs[0]["this"], true);
        assert_eq!(configs[1]["configuration"], "stock");
        assert!(configs.iter().all(|c| c["power"].is_number()), "{body}");
    }
}
