//! Rating v2 on the public pages: real games from the enabled datasets and the operator's chosen
//! stock-precon tournament (`precon-evidence simulate`), through the same time-split gate as the Lab.
//! The published Phase benchmark doesn't feed it (Bryan, 31 Oct 2026: Forge tracks real results
//! better). Re-derived whenever a dataset revision, source, link, catalog import or the chosen
//! simulation changes, and at least every few minutes, which also takes in a tournament's new games.
use super::Precon;
use crate::error::AppResult;
use crate::precon_evidence;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Recency weighting moves with the date, so even unchanged inputs are re-derived this often.
const FRESH: Duration = Duration::from_secs(600);

#[derive(Clone, Serialize)]
pub struct Info {
    pub method: &'static str,
    pub as_of: DateTime<Utc>,
    pub split: DateTime<Utc>,
    /// Whether the chosen simulation earned weight beside real games in the time-split test.
    pub gate_passed: bool,
    /// The simulation it reads, when one is chosen.
    pub simulation: Option<String>,
    pub ranked: usize,
    pub sources: Vec<Source>,
    pub note: &'static str,
}

/// A real-game source as the public sees it: its credit and licence only. The datasets behind it
/// (their ids, revisions and import times) belong to an account and stay private.
#[derive(Clone, Serialize)]
pub struct Source {
    pub name: String,
    pub attribution: String,
    pub license: String,
}

#[derive(Clone, Serialize)]
pub struct Real {
    pub source: String,
    pub url: Option<String>,
    /// The source's all-time figure and its games.
    pub all_time: f64,
    pub games: u64,
    /// Recency-weighted rate from the games between snapshots, when there are enough.
    pub recent: Option<f64>,
    pub recent_games: Option<u64>,
    pub trend_points_per_30_days: Option<f64>,
    pub as_of: DateTime<Utc>,
}

#[derive(Clone, Serialize)]
pub struct Row {
    pub rank: usize,
    pub rank_lo: usize,
    pub rank_hi: usize,
    /// Estimated four-player win rate, percent, with its 90% interval.
    pub rate: f64,
    pub lo: f64,
    pub hi: f64,
    /// Share of the estimate's precision from real games (0–1).
    pub real_share: f64,
    pub real: Option<Real>,
}

type Table = Arc<(Info, HashMap<String, Row>)>;
static CACHE: Mutex<Option<(Instant, String, Table)>> = Mutex::new(None);
/// One rebuild at a time: requests arriving during it wait for its result rather than repeat it.
static REBUILD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Everything the rating reads, so any change is seen on the next request.
async fn fingerprint(pool: &SqlitePool) -> AppResult<String> {
    let inputs: String = sqlx::query_scalar(
        "SELECT (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT owner_id || ':' || source_name || ':' || enabled_at AS k FROM precon_evidence_sources ORDER BY k))
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT id || ':' || IFNULL(current_revision_id, '') AS k FROM evidence_datasets
                    WHERE owner_id IN (SELECT owner_id FROM precon_evidence_sources) ORDER BY k))
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT source_name || ':' || precon_id || ':' || entity || ':' || rule || ':' || created_at AS k FROM precon_evidence_links ORDER BY k))
             || '#' || (SELECT IFNULL(max(imported_at), '') || ':' || count(*) FROM precons)
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT experiment_id || ':' || engine || ':' || build || ':' || chosen_at AS k FROM precon_evidence_simulation ORDER BY k))",
    )
    .fetch_one(pool)
    .await?;
    Ok(format!("{}#{inputs}", pool.connect_options().get_filename().display()))
}

async fn derive(pool: &SqlitePool) -> AppResult<Table> {
    let as_of = Utc::now();
    let loaded = precon_evidence::load(pool, as_of).await?;
    let sources: Vec<Source> = loaded
        .report
        .source_labels
        .iter()
        .map(|s| Source {
            name: s.name.clone(),
            attribution: s.attribution.clone(),
            license: s.license.clone(),
        })
        .collect();
    let real: HashMap<String, Real> = loaded
        .by_precon
        .iter()
        .filter_map(|(id, ev)| {
            let r = ev.real.as_ref()?;
            Some((
                id.clone(),
                Real {
                    source: r.source.name.clone(),
                    url: r.url.clone(),
                    all_time: r.latest.rate,
                    games: r.latest.games,
                    recent: r.history.recent.as_ref().map(|x| x.rate),
                    recent_games: r.history.recent.as_ref().map(|x| x.games),
                    trend_points_per_30_days: r.history.trend_points_per_30_days,
                    as_of: r.latest.as_of,
                },
            ))
        })
        .collect();
    // Without an enabled real-game source there is nothing for v2 to add to the published ranks.
    if sources.is_empty() {
        let info = Info {
            method: precon_evidence::V2_METHOD,
            as_of,
            split: as_of,
            gate_passed: false,
            simulation: None,
            ranked: 0,
            sources,
            note: "",
        };
        return Ok(Arc::new((info, HashMap::new())));
    }
    // A choice that no longer qualifies (a list changed) drops the simulation, not the rating.
    let simulation = precon_evidence::chosen_simulation(pool).await.unwrap_or_else(|e| {
        tracing::warn!(error = ?e, "chosen precon simulation unusable; rating v2 uses real games alone");
        None
    });
    let v2 = precon_evidence::rating_v2_from(pool, as_of, loaded, simulation).await?;
    let table = v2
        .precons
        .iter()
        .map(|e| {
            (
                e.precon.clone(),
                Row {
                    rank: e.rank,
                    rank_lo: e.rank_lo,
                    rank_hi: e.rank_hi,
                    rate: e.rate,
                    lo: e.lo,
                    hi: e.hi,
                    real_share: e.real_share,
                    real: real.get(&e.precon).cloned(),
                },
            )
        })
        .collect();
    let info = Info {
        method: v2.method,
        as_of,
        split: v2.split,
        gate_passed: v2.gate_passed,
        simulation: v2.simulation.map(|s| s.name),
        ranked: v2.ranked,
        sources,
        note: v2.note,
    };
    Ok(Arc::new((info, table)))
}

fn cached(key: &str) -> Option<Table> {
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .filter(|(at, k, _)| k == key && at.elapsed() < FRESH)
        .map(|(_, _, t)| t.clone())
}

async fn table(pool: &SqlitePool) -> AppResult<Table> {
    let key = fingerprint(pool).await?;
    if let Some(t) = cached(&key) {
        return Ok(t);
    }
    let _rebuilding = REBUILD.lock().await;
    if let Some(t) = cached(&key) {
        return Ok(t);
    }
    let t = derive(pool).await?;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), key, t.clone()));
    Ok(t)
}

/// Attach rating v2 to every row it ranks. `None` when no real-game source is enabled, or when
/// the rating can't be derived: the pages then keep meta rank v1 rather than fail.
pub(super) async fn assign(pool: &SqlitePool, rows: &mut [Precon]) -> AppResult<Option<Info>> {
    let table = match table(pool).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = ?e, "public rating v2 unavailable; showing meta rank v1");
            return Ok(None);
        }
    };
    let (info, by_id) = &*table;
    let active = info.ranked > 0;
    for row in rows.iter_mut() {
        row.v2 = by_id.get(&row.id).cloned();
        // One rank per page: while v2 is active, a deck it doesn't rank is unranked, not v1-ranked.
        if active {
            row.meta = None;
        }
    }
    Ok((info.ranked > 0).then(|| info.clone()))
}
