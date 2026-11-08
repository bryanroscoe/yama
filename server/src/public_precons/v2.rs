//! Rating v2 on the public pages: real games from the enabled datasets and the operator's chosen
//! stock-precon tournament (`precon-evidence simulate`), through the same time-split gate as the Lab.
//! The published Phase benchmark doesn't feed it (Bryan, 31 Oct 2026: Forge tracks real results
//! better). Re-derived whenever a dataset revision, source, link, catalog import or the chosen
//! simulation changes, each day, and every 100 games of a chosen tournament still playing
//! (derived.rs keeps it until then).
use super::Precon;
use crate::error::AppResult;
use crate::precon_evidence;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::Arc;

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
    /// Whether a commander-only source (Mythic Tools) earned a place for precons without stock games.
    pub commander: Option<precon_evidence::CommanderTest>,
    pub note: &'static str,
}

/// A real-game source as the public sees it: its credit and licence only. The datasets behind it
/// (their ids, revisions and import times) belong to an account and stay private.
#[derive(Clone, Serialize)]
pub struct Source {
    pub name: String,
    pub attribution: String,
    pub license: String,
    /// Whether it rates stock lists, and so feeds the rating. A source that only has per-commander
    /// figures (Mythic Tools) never rates a stock list; v2 reads it only for precons without stock games.
    pub stock_lists: bool,
}

/// One source's figure for every list under a precon's commanders: wins over all reported games.
#[derive(Clone, Serialize)]
pub struct CommanderGames {
    pub source: String,
    pub commander: String,
    /// Percent; pods of every size, so 25% isn't the even share.
    pub rate: f64,
    pub games: u64,
    pub decks: Option<u64>,
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
    /// The commander-only source whose figure the estimate used, for a precon without stock games.
    pub commander_source: Option<String>,
    pub real: Option<Real>,
}

type Table = Arc<(Info, HashMap<String, Row>, HashMap<String, Vec<CommanderGames>>)>;
/// The rating, kept until its inputs change (derived.rs).
static TABLE: crate::derived::Kept<Table> = crate::derived::Kept::new("public precons rating rebuild");

/// Everything the rating reads, so any change is seen on the next request: the sources, their
/// datasets and links, the catalog, the chosen simulation and how far it has played (by 100
/// games), the global ratings runs it falls back to without one (the newest ten, as
/// `precon_evidence` reads them), card data imports (a commander record named by printing or name
/// may only resolve after one), and the day (recency weighting moves with the date).
async fn fingerprint(pool: &SqlitePool) -> AppResult<String> {
    let inputs: String = sqlx::query_scalar(
        "SELECT (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT owner_id || ':' || source_name || ':' || enabled_at AS k FROM precon_evidence_sources ORDER BY k))
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT id || ':' || IFNULL(current_revision_id, '') AS k FROM evidence_datasets
                    WHERE owner_id IN (SELECT owner_id FROM precon_evidence_sources) ORDER BY k))
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT source_name || ':' || precon_id || ':' || entity || ':' || rule || ':' || created_at AS k FROM precon_evidence_links ORDER BY k))
             || '#' || (SELECT IFNULL(max(imported_at), '') || ':' || count(*) FROM precons)
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT experiment_id || ':' || engine || ':' || build || ':' || card_data || ':' || chosen_at AS k FROM precon_evidence_simulation ORDER BY k))
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT id || ':' || status || ':' || (games_done / 100) AS k FROM lab_experiments
                    WHERE id IN (SELECT experiment_id FROM precon_evidence_simulation) ORDER BY k))
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT id || ':' || name || ':' || imported_at || ':' || IFNULL(analysed_at, '') AS k
                    FROM lab_runs WHERE owner_id IS NULL AND kind = 'precon-ratings' ORDER BY created_at DESC LIMIT 10))
             || '#' || (SELECT IFNULL(max(finished_at), '') FROM import_runs)",
    )
    .fetch_one(pool)
    .await?;
    Ok(format!("{}#{inputs}#{}", pool.connect_options().get_filename().display(), crate::derived::today()))
}

/// The fingerprint, for pages that are built from this rating too.
pub(crate) async fn key(pool: &SqlitePool) -> AppResult<String> {
    fingerprint(pool).await
}

async fn derive(pool: &SqlitePool) -> AppResult<Table> {
    let as_of = Utc::now();
    let loaded = precon_evidence::load(pool, as_of).await?;
    let rating_sources: std::collections::HashSet<&str> = loaded
        .by_precon
        .values()
        .flat_map(|ev| ev.real.iter().chain(ev.also.iter()))
        .map(|r| r.source.name.as_str())
        .collect();
    let sources: Vec<Source> = loaded
        .report
        .source_labels
        .iter()
        .map(|s| Source {
            name: s.name.clone(),
            attribution: s.attribution.clone(),
            license: s.license.clone(),
            stock_lists: rating_sources.contains(s.name.as_str()),
        })
        .collect();
    let lists: HashMap<String, Vec<CommanderGames>> = loaded
        .by_precon
        .iter()
        .filter(|(_, ev)| !ev.all_lists.is_empty())
        .map(|(id, ev)| {
            let figures = ev
                .all_lists
                .iter()
                .map(|f| CommanderGames {
                    source: f.source.name.clone(),
                    commander: f.name.clone(),
                    rate: f.rate,
                    games: f.games,
                    decks: f.decks,
                })
                .collect();
            (id.clone(), figures)
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
            commander: None,
            note: "",
        };
        return Ok(Arc::new((info, HashMap::new(), lists)));
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
                    commander_source: e.commander_source.clone(),
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
        commander: v2.commander,
        note: v2.note,
    };
    Ok(Arc::new((info, table, lists)))
}

async fn table(pool: &SqlitePool) -> AppResult<Table> {
    let key = fingerprint(pool).await?;
    let t = TABLE.get(pool, key, |pool| async move { derive(&pool).await }).await?;
    Ok(Table::clone(&t))
}

/// Build the rating now if its inputs changed (derived.rs).
pub(super) async fn prewarm(pool: &SqlitePool) -> AppResult<()> {
    let key = fingerprint(pool).await?;
    TABLE.refresh(pool, key, |pool| async move { derive(&pool).await }).await
}

/// Each ranked precon's rating v2 rank and the number ranked, for links from other public pages.
/// Empty when the rating can't be derived: a link then shows no rank rather than fail the page.
pub(crate) async fn ranks(pool: &SqlitePool) -> (HashMap<String, usize>, usize) {
    match table(pool).await {
        Ok(t) => (t.1.iter().map(|(id, row)| (id.clone(), row.rank)).collect(), t.0.ranked),
        Err(e) => {
            tracing::warn!(error = ?e, "public rating v2 unavailable for precon links");
            (HashMap::new(), 0)
        }
    }
}

/// Attach rating v2 to every row it ranks, and each source's commander figures to every row.
/// The rating is `None` when no real-game source is enabled, when it ranks nothing, or when it can't
/// be derived: the pages then keep meta rank v1 rather than fail. The enabled real-game sources come
/// back either way, so their figures keep their credit and sort without a rating.
pub(super) async fn assign(pool: &SqlitePool, rows: &mut [Precon]) -> AppResult<(Option<Info>, Vec<Source>)> {
    let table = match table(pool).await {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!(error = ?e, "public rating v2 unavailable; showing meta rank v1");
            return Ok((None, Vec::new()));
        }
    };
    let (info, by_id, lists) = &*table;
    let active = info.ranked > 0;
    for row in rows.iter_mut() {
        row.v2 = by_id.get(&row.id).cloned();
        row.commander_games = lists.get(&row.id).cloned().unwrap_or_default();
        // One rank per page: while v2 is active, a deck it doesn't rank is unranked, not v1-ranked.
        if active {
            row.meta = None;
        }
    }
    Ok(((info.ranked > 0).then(|| info.clone()), info.sources.clone()))
}
