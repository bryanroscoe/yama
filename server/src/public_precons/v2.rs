//! Rating v2 on the public pages: real games from the enabled datasets and the published benchmark,
//! through the same time-split gate as the Lab. Re-derived whenever a dataset revision, source,
//! link, catalog import or publication changes, and at least every few minutes for recency.
use super::{Precon, Publication};
use crate::error::AppResult;
use crate::precon_evidence::{self, SimSource, SourceLabel};
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
    /// Whether the published simulation earned weight beside real games in the time-split test.
    pub gate_passed: bool,
    /// The simulation it reads, when one is published.
    pub simulation: Option<String>,
    pub ranked: usize,
    pub sources: Vec<SourceLabel>,
    pub note: &'static str,
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

/// Everything the rating reads, so any change is seen on the next request.
async fn fingerprint(pool: &SqlitePool, publication: Option<&Publication>) -> AppResult<String> {
    let inputs: String = sqlx::query_scalar(
        "SELECT (SELECT IFNULL(group_concat(owner_id || ':' || source_name || ':' || enabled_at, '|'), '') FROM precon_evidence_sources)
             || '#' || (SELECT IFNULL(group_concat(id || ':' || IFNULL(current_revision_id, ''), '|'), '') FROM evidence_datasets)
             || '#' || (SELECT IFNULL(group_concat(source_name || ':' || precon_id || ':' || entity || ':' || rule || ':' || created_at, '|'), '') FROM precon_evidence_links)
             || '#' || (SELECT IFNULL(max(imported_at), '') || ':' || count(*) FROM precons)",
    )
    .fetch_one(pool)
    .await?;
    Ok(format!(
        "{}#{}#{inputs}",
        pool.connect_options().get_filename().display(),
        publication.map(|p| p.id.as_str()).unwrap_or("")
    ))
}

/// The published benchmark as a simulation source: strengths of the stock lists it still matches.
fn published(rows: &[Precon], publication: Option<&Publication>) -> Option<SimSource> {
    let p = publication?;
    let strengths: HashMap<String, f64> = rows
        .iter()
        .filter_map(|r| Some((r.id.clone(), r.rating.as_ref()?.strength.filter(|s| *s > 0.0)?)))
        .collect();
    // A date alone could be any time that day; only the day's end can't predate the split wrongly.
    let created_at = if p.analysed_at.len() == 10 {
        format!("{}T23:59:59Z", p.analysed_at)
    } else {
        p.analysed_at.clone()
    };
    Some(SimSource {
        kind: "publication",
        id: p.id.clone(),
        name: p.title.clone(),
        engine: format!("{}, card data {}, {} AI", p.engine, p.card_data, p.difficulty),
        status: "done".into(),
        created_at,
        precons: strengths.len(),
        strengths,
    })
}

async fn derive(pool: &SqlitePool, rows: &[Precon], publication: Option<&Publication>) -> AppResult<Table> {
    let as_of = Utc::now();
    let loaded = precon_evidence::load(pool, as_of).await?;
    let sources = loaded.report.source_labels.clone();
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
    let simulation = published(rows, publication);
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

/// Attach rating v2 to every row it ranks. `None` when no real-game source is enabled.
pub(super) async fn assign(
    pool: &SqlitePool,
    rows: &mut [Precon],
    publication: Option<&Publication>,
) -> AppResult<Option<Info>> {
    let key = fingerprint(pool, publication).await?;
    let cached = CACHE
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(at, k, _)| *k == key && at.elapsed() < FRESH)
        .map(|(_, _, t)| t.clone());
    let table = match cached {
        Some(t) => t,
        None => {
            let t = derive(pool, rows, publication).await?;
            *CACHE.lock().unwrap() = Some((Instant::now(), key, t.clone()));
            t
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
