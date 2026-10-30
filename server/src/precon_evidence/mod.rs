//! Shared precon evidence derived from imported datasets (ARCHITECTURE.md, "Precon evidence").
//!
//! An operator chooses which owners' datasets, by source name, feed the shared precon pages
//! (`precon_evidence_sources`). Everything else is derived on read from those datasets' active
//! revisions, so uploading a new revision, or another dataset from the same source, updates every
//! precon with nothing copied by hand: the link from each catalog precon to the source's entity,
//! its dated snapshots, the implied rates between them, the recent rate and the trend. Operator
//! corrections to the automatic match live in `precon_evidence_links`.
//!
//! Only derived per-precon figures leave the datasets, with the source's name, attribution,
//! licence and dataset revisions. The datasets themselves stay private to their owner.
pub mod calibration;
pub mod history;
#[cfg(test)]
mod tests;

use crate::admin::AdminUser;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::now;
use axum::extract::{Path, Query, State};
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use history::{History, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap, HashSet};

/// The accepted recency default for dataset evidence (Bryan, 28 Oct 2026).
pub const HALF_LIFE_DAYS: u32 = 180;
pub const METHOD: &str = "Implied rate between dated cumulative snapshots, (n2*r2 - n1*r1) / (n2 - n1), pooled to at least 40 new games, \
weighted by games and a 180-day recency half-life at each interval's midpoint. The source reports a normalised 4-player rate rather \
than raw wins, so these are approximations without binomial intervals.";
pub const COMMANDER_NOTE: &str = "Every list recorded under this commander: stock and upgraded lists, pod sizes and power levels mixed. \
Not a rating of this precon's list and never part of its real-game rate.";
const PRECON_PREFIX: &str = "playgroup:precon:";
const COMMANDER_PREFIX: &str = "playgroup:commander:";
/// Commander windows to show, in order of preference.
const COMMANDER_WINDOWS: [u32; 3] = [180, 365, 90];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/precon-evidence", get(report_route))
        .route("/api/admin/precon-evidence/sources/{source}", put(enable_route).delete(disable_route))
        .route("/api/admin/precon-calibration", get(calibration_route))
        .route("/api/precons/rating-v2", get(rating_v2_route))
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DatasetLabel {
    pub id: String,
    pub revision: i64,
    pub imported_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SourceLabel {
    pub name: String,
    pub attribution: String,
    pub license: String,
    pub datasets: Vec<DatasetLabel>,
}

/// A precon's real-game history from one source.
#[derive(Debug, Clone, Serialize)]
pub struct RealHistory {
    pub source: SourceLabel,
    pub entity: String,
    pub entity_name: String,
    pub url: Option<String>,
    /// How the catalog precon was linked: manual, url, name or slug.
    pub matched_by: &'static str,
    pub cohort: String,
    /// The newest snapshot used: the source's all-time figure.
    pub latest: Snapshot,
    #[serde(flatten)]
    pub history: History,
    pub as_of: DateTime<Utc>,
    pub method: &'static str,
}

/// The commander's own figure, for precons the source doesn't rate as a stock list.
#[derive(Debug, Clone, Serialize)]
pub struct CommanderObservation {
    pub source: String,
    pub entity: String,
    pub name: String,
    pub url: Option<String>,
    pub window_days: u32,
    pub rate: f64,
    pub games: u64,
    pub as_of: DateTime<Utc>,
    pub note: &'static str,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PreconEvidence {
    pub real: Option<RealHistory>,
    pub commander: Option<CommanderObservation>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Unmatched {
    pub entity: String,
    pub name: String,
    pub url: Option<String>,
    /// Why: no catalog precon matched, or several did.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Report {
    pub sources: Vec<Value>,
    pub source_label: Option<SourceLabel>,
    pub entities: usize,
    pub matched: BTreeMap<String, (String, &'static str)>,
    pub unmatched: Vec<Unmatched>,
    pub catalog_precons: usize,
    pub catalog_without_real_games: usize,
}

#[derive(Debug, Default)]
pub struct Evidence {
    pub by_precon: HashMap<String, PreconEvidence>,
    pub report: Report,
}

#[derive(Deserialize)]
struct Period {
    kind: String,
    lookback_days: Option<u32>,
    source_as_of: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct Observation {
    entity_id: String,
    entity_kind: String,
    #[serde(default)]
    entity_name: Option<String>,
    metric: String,
    value: f64,
    source_reported_games: u64,
    cohort: String,
    observation_period: Period,
    #[serde(default)]
    source_entity_url: Option<String>,
    #[serde(default)]
    quality_flags: Vec<String>,
}

#[derive(Default)]
struct Entity {
    name: String,
    url: Option<String>,
    /// Snapshots by cohort.
    cohorts: BTreeMap<String, Vec<Snapshot>>,
}

struct CatalogPrecon {
    id: String,
    name: String,
    playgroup_name: Option<String>,
    playgroup_url: Option<String>,
    playgroup_id: Option<i64>,
    reference_matches: bool,
}

fn norm_url(u: &str) -> String {
    let u = u.trim().to_ascii_lowercase();
    let u = u.strip_prefix("https://").or_else(|| u.strip_prefix("http://")).unwrap_or(&u);
    let u = u.strip_prefix("www.").unwrap_or(u);
    u.trim_end_matches('/').to_string()
}

fn norm_name(n: &str) -> String {
    n.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Is this a 4-player win-rate figure a precon history can use?
fn usable_rate(o: &Observation) -> bool {
    o.metric.contains("4p_win_rate") && o.value.is_finite() && (0.0..=100.0).contains(&o.value) && o.quality_flags.is_empty()
}

/// Which owners' datasets feed the shared evidence, with each one's active revision.
struct Enabled {
    revision_id: String,
    dataset: String,
    revision: i64,
    imported_at: String,
    metadata: Value,
}

async fn enabled_revisions(pool: &SqlitePool) -> AppResult<Vec<Enabled>> {
    let rows: Vec<(String, String, i64, String, String)> = sqlx::query_as(
        "SELECT r.id, d.external_id, r.revision, r.imported_at, r.metadata FROM precon_evidence_sources s
         JOIN evidence_datasets d ON d.owner_id = s.owner_id
         JOIN evidence_dataset_revisions r ON r.id = d.current_revision_id
         WHERE json_extract(r.metadata, '$.source.name') = s.source_name
         ORDER BY d.external_id, s.owner_id",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|(revision_id, dataset, revision, imported_at, meta)| {
            Ok(Enabled { revision_id, dataset, revision, imported_at, metadata: serde_json::from_str(&meta).map_err(anyhow::Error::from)? })
        })
        .collect()
}

/// Everything the shared precon pages show from datasets, as of `as_of`.
pub async fn load(pool: &SqlitePool, as_of: DateTime<Utc>) -> AppResult<Evidence> {
    let revisions = enabled_revisions(pool).await?;
    let sources: Vec<Value> = sqlx::query_as::<_, (String, String, String)>(
        "SELECT u.email, s.source_name, s.enabled_at FROM precon_evidence_sources s JOIN users u ON u.id = s.owner_id ORDER BY s.source_name, u.email",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(email, source, at)| json!({"owner": email, "source_name": source, "enabled_at": at}))
    .collect();
    let catalog: Vec<CatalogPrecon> = sqlx::query_as::<_, (String, String, Option<String>, Option<String>, Option<i64>, String)>(
        "SELECT id, name, playgroup_name, json_extract(playgroup, '$.url'), playgroup_id, cards FROM precons ORDER BY id",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, name, playgroup_name, playgroup_url, playgroup_id, cards)| {
        let reference_matches = serde_json::from_str::<Vec<crate::lab::PreconCard>>(&cards)
            .is_ok_and(|c| crate::upgradeability::allows_reference_results(&id, &c));
        CatalogPrecon { id, name, playgroup_name, playgroup_url, playgroup_id, reference_matches }
    })
    .collect();
    let mut report = Report { sources, catalog_precons: catalog.len(), ..Default::default() };
    if revisions.is_empty() {
        report.catalog_without_real_games = catalog.len();
        return Ok(Evidence { by_precon: HashMap::new(), report });
    }

    // One label for the whole source: the datasets feeding it, newest import first.
    let first = &revisions[0].metadata["source"];
    let mut datasets: Vec<DatasetLabel> =
        revisions.iter().map(|r| DatasetLabel { id: r.dataset.clone(), revision: r.revision, imported_at: r.imported_at.clone() }).collect();
    datasets.sort_by(|a, b| b.imported_at.cmp(&a.imported_at).then(a.id.cmp(&b.id)));
    let label = SourceLabel {
        name: first["name"].as_str().unwrap_or_default().into(),
        attribution: first["attribution"].as_str().unwrap_or_default().into(),
        license: first["license"].as_str().unwrap_or_default().into(),
        datasets,
    };

    let commander_entities: Vec<String> = catalog.iter().filter_map(|p| p.playgroup_id).map(|id| format!("{COMMANDER_PREFIX}{id}")).collect();
    let commander_json = serde_json::to_string(&commander_entities).map_err(anyhow::Error::from)?;
    let mut entities: BTreeMap<String, Entity> = BTreeMap::new();
    // Commander entity → window → (as_of, rate, games, name, url), newest per window.
    type Window = (DateTime<Utc>, f64, u64, String, Option<String>);
    let mut commanders: HashMap<String, HashMap<u32, Window>> = HashMap::new();
    for r in &revisions {
        let partial: HashSet<&str> = r.metadata["sources"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|s| s["flags"].as_array().is_some_and(|f| !f.is_empty()))
            .filter_map(|s| s["sha256"].as_str())
            .collect();
        let rows: Vec<String> = sqlx::query_scalar(
            "SELECT document FROM evidence_dataset_records WHERE revision_id = ? AND kind = 'performance'
               AND (json_extract(document, '$.data.entity_kind') = 'precon' OR entity IN (SELECT value FROM json_each(?)))
             ORDER BY id",
        )
        .bind(&r.revision_id)
        .bind(&commander_json)
        .fetch_all(pool)
        .await?;
        for row in rows {
            let record: Value = serde_json::from_str(&row).map_err(anyhow::Error::from)?;
            if record["sources"].as_array().into_iter().flatten().filter_map(Value::as_str).any(|s| partial.contains(s)) {
                continue;
            }
            let Ok(o) = serde_json::from_value::<Observation>(record["data"].clone()) else { continue };
            if !usable_rate(&o) {
                continue;
            }
            let Some(at) = o.observation_period.source_as_of else { continue };
            let name = o.entity_name.clone().unwrap_or_else(|| o.entity_id.clone());
            match (o.entity_kind.as_str(), o.observation_period.kind.as_str()) {
                ("precon", "cumulative_snapshot") => {
                    let e = entities.entry(o.entity_id.clone()).or_default();
                    e.name = name;
                    if o.source_entity_url.is_some() {
                        e.url = o.source_entity_url.clone();
                    }
                    e.cohorts.entry(o.cohort.clone()).or_default().push(Snapshot { as_of: at, games: o.source_reported_games, rate: o.value });
                }
                ("commander", "rolling_window") => {
                    let Some(days) = o.observation_period.lookback_days.filter(|d| COMMANDER_WINDOWS.contains(d)) else { continue };
                    if at > as_of || o.source_reported_games == 0 {
                        continue;
                    }
                    let slot = commanders.entry(o.entity_id.clone()).or_default().entry(days).or_insert((at, o.value, o.source_reported_games, name.clone(), o.source_entity_url.clone()));
                    if at > slot.0 {
                        *slot = (at, o.value, o.source_reported_games, name, o.source_entity_url);
                    }
                }
                _ => {}
            }
        }
    }
    report.entities = entities.len();
    report.source_label = Some(label.clone());

    let links: Vec<(String, String, String)> = sqlx::query_as("SELECT precon_id, entity, rule FROM precon_evidence_links").fetch_all(pool).await?;
    let manual: HashSet<(&str, &str)> = links.iter().filter(|l| l.2 == "manual").map(|l| (l.0.as_str(), l.1.as_str())).collect();
    let excluded: HashSet<(&str, &str)> = links.iter().filter(|l| l.2 == "exclude").map(|l| (l.0.as_str(), l.1.as_str())).collect();

    // Each entity's best rule and the precons it names; then each precon keeps its best entity.
    let rules: [&'static str; 4] = ["manual", "url", "name", "slug"];
    let mut claims: HashMap<&str, Vec<(usize, &str)>> = HashMap::new();
    for (entity_id, e) in &entities {
        let slug = entity_id.strip_prefix(PRECON_PREFIX).unwrap_or(entity_id);
        let test = |rule: &str, p: &CatalogPrecon| match rule {
            "manual" => manual.contains(&(p.id.as_str(), entity_id.as_str())),
            "url" => matches!((&p.playgroup_url, &e.url), (Some(a), Some(b)) if norm_url(a) == norm_url(b)),
            "name" => !e.name.is_empty() && norm_name(p.playgroup_name.as_deref().unwrap_or(&p.name)) == norm_name(&e.name),
            _ => p.id == slug,
        };
        let mut found = false;
        for (priority, rule) in rules.iter().enumerate() {
            let hits: Vec<&CatalogPrecon> =
                catalog.iter().filter(|p| !excluded.contains(&(p.id.as_str(), entity_id.as_str())) && test(rule, p)).collect();
            if hits.is_empty() {
                continue;
            }
            // A name or slug that fits several precons is ambiguous; a shared link or manual choice isn't.
            if hits.len() > 1 && priority >= 2 {
                report.unmatched.push(Unmatched {
                    entity: entity_id.clone(),
                    name: e.name.clone(),
                    url: e.url.clone(),
                    reason: format!("its {rule} fits {} catalog precons: {}", hits.len(), hits.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(", ")),
                });
                found = true;
                break;
            }
            for p in hits {
                claims.entry(p.id.as_str()).or_default().push((priority, entity_id.as_str()));
            }
            found = true;
            break;
        }
        if !found {
            report.unmatched.push(Unmatched { entity: entity_id.clone(), name: e.name.clone(), url: e.url.clone(), reason: "no catalog precon matched".into() });
        }
    }
    let mut by_precon: HashMap<String, PreconEvidence> = HashMap::new();
    for p in &catalog {
        let mut ev = PreconEvidence::default();
        if let Some(c) = claims.get(p.id.as_str()) {
            let best = c.iter().map(|x| x.0).min().unwrap();
            let top: Vec<&str> = c.iter().filter(|x| x.0 == best).map(|x| x.1).collect();
            if top.len() > 1 {
                for entity in &top {
                    let e = &entities[*entity];
                    report.unmatched.push(Unmatched {
                        entity: entity.to_string(),
                        name: e.name.clone(),
                        url: e.url.clone(),
                        reason: format!("{} is also claimed by {}", p.id, top.iter().filter(|x| x != &entity).copied().collect::<Vec<_>>().join(", ")),
                    });
                }
            } else if p.reference_matches {
                let entity_id = top[0];
                let e = &entities[entity_id];
                report.matched.insert(p.id.clone(), (entity_id.to_string(), rules[best]));
                // The cohort with the newest snapshot speaks for the precon.
                let (cohort, snaps) = e
                    .cohorts
                    .iter()
                    .max_by_key(|(_, s)| s.iter().map(|x| x.as_of).max())
                    .map(|(c, s)| (c.clone(), s.clone()))
                    .unwrap_or_default();
                let h = history::history(snaps, as_of, HALF_LIFE_DAYS);
                if let Some(latest) = h.snapshots.last().copied() {
                    ev.real = Some(RealHistory {
                        source: label.clone(),
                        entity: entity_id.to_string(),
                        entity_name: e.name.clone(),
                        url: e.url.clone(),
                        matched_by: rules[best],
                        cohort,
                        latest,
                        history: h,
                        as_of,
                        method: METHOD,
                    });
                }
            }
        }
        if ev.real.is_none() && p.reference_matches {
            let entity = p.playgroup_id.map(|id| format!("{COMMANDER_PREFIX}{id}"));
            if let Some((entity, windows)) = entity.as_ref().and_then(|e| commanders.get(e).map(|w| (e, w))) {
                if let Some((days, w)) = COMMANDER_WINDOWS.iter().find_map(|d| windows.get(d).map(|w| (*d, w))) {
                    ev.commander = Some(CommanderObservation {
                        source: label.name.clone(),
                        entity: entity.clone(),
                        name: w.3.clone(),
                        url: w.4.clone(),
                        window_days: days,
                        rate: w.1,
                        games: w.2,
                        as_of: w.0,
                        note: COMMANDER_NOTE,
                    });
                }
            }
        }
        if ev.real.is_none() {
            report.catalog_without_real_games += 1;
        }
        if ev.real.is_some() || ev.commander.is_some() {
            by_precon.insert(p.id.clone(), ev);
        }
    }
    report.unmatched.sort_by(|a, b| a.entity.cmp(&b.entity));
    report.unmatched.dedup();
    Ok(Evidence { by_precon, report })
}

/// A simulation source the calibration scores.
#[derive(Debug, Clone, Serialize)]
pub struct SimSource {
    /// "global run" (an imported precon-ratings run) or "tournament" (the caller's own experiment).
    pub kind: &'static str,
    pub id: String,
    pub name: String,
    pub engine: String,
    pub status: String,
    pub created_at: String,
    /// Catalog precons it gives a strength.
    pub precons: usize,
    /// Simulated strength by catalog precon.
    #[serde(skip)]
    pub strengths: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceCalibration {
    pub source: SimSource,
    pub evaluation: calibration::Evaluation,
    /// Descriptive: rank correlation with today's all-time real rates, over every precon with both.
    pub spearman_all_time: Option<f64>,
    pub all_time_precons: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalibrationReport {
    pub split: DateTime<Utc>,
    pub as_of: DateTime<Utc>,
    pub real_source: Option<SourceLabel>,
    /// Precons with a pre-split real rate and enough games after the split.
    pub precons_with_holdout: usize,
    pub sources: Vec<SourceCalibration>,
    pub method: &'static str,
}

pub const CALIBRATION_METHOD: &str = "Everything known at the split date predicts each precon's implied rate on the games played after it. \
Real games only uses the recent rate from snapshots up to the split. Simulation only maps the source's log strength to a rate with a \
regression fitted on pre-split real rates. Meta rank v1 adds the two percentile ranks (ranks only). Rating v2 weights the real rate and \
the mapped simulation by their precision. Scores: rank correlation with the held-out rates (90% bootstrap interval over precons) and \
the held-out error weighted by held-out games. Rating v2 passes only if its error beats real games alone with an interval clear of zero.";

/// Strengths from the newest global precon-ratings runs and the caller's own tournaments.
pub async fn sim_sources(pool: &SqlitePool, owner: Option<&str>) -> AppResult<Vec<SimSource>> {
    let catalog: Vec<(String, String, String)> = sqlx::query_as("SELECT id, lab_id, cards FROM precons").fetch_all(pool).await?;
    let by_lab: HashMap<&str, &str> = catalog.iter().map(|(id, lab, _)| (lab.as_str(), id.as_str())).collect();
    let mut by_sha: HashMap<String, Vec<String>> = HashMap::new();
    for (id, _, cards) in &catalog {
        if let Ok(cards) = serde_json::from_str::<Vec<crate::lab::PreconCard>>(cards) {
            if crate::upgradeability::allows_reference_results(id, &cards) {
                by_sha.entry(crate::lab::experiments::precon_list_sha(cards)).or_default().push(id.clone());
            }
        }
    }
    let mut out = Vec::new();
    let runs: Vec<(String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, name, engine, created_at FROM lab_runs WHERE owner_id IS NULL AND kind = 'precon-ratings' ORDER BY created_at DESC LIMIT 10",
    )
    .fetch_all(pool)
    .await?;
    for (id, name, engine, created_at) in runs {
        let strengths: HashMap<String, f64> = crate::lab::ratings_for(pool, &id)
            .await?
            .into_iter()
            .filter_map(|(deck, r)| Some((by_lab.get(deck.as_str())?.to_string(), r.strength.filter(|s| *s > 0.0)?)))
            .collect();
        out.push(SimSource { kind: "global run", id, name, engine: engine.unwrap_or_default(), status: "done".into(), created_at, precons: strengths.len(), strengths });
    }
    if let Some(owner) = owner {
        let rows: Vec<(String, String, String, String, String)> = sqlx::query_as(
            "SELECT id, name, status, created_at, spec FROM lab_experiments
             WHERE owner_id = ? AND json_extract(spec, '$.mode') = 'tournament' ORDER BY created_at DESC LIMIT 20",
        )
        .bind(owner)
        .fetch_all(pool)
        .await?;
        for (id, name, status, created_at, spec) in rows {
            let spec: crate::lab::experiments::ExperimentSpec = serde_json::from_str(&spec).map_err(anyhow::Error::from)?;
            let entrants: Vec<(String, String)> = spec.entrants.iter().map(|l| (l.id.clone(), l.label.clone())).collect();
            // Summarised afresh, so runs stored before fitted strengths existed still count.
            let games: Vec<(String, Option<String>, String)> =
                sqlx::query_as("SELECT spec, result, engine FROM lab_experiment_games WHERE experiment_id = ? AND result IS NOT NULL ORDER BY ord")
                    .bind(&id)
                    .fetch_all(pool)
                    .await?;
            let engines: BTreeMap<&str, Vec<(String, Option<String>)>> = games.iter().fold(BTreeMap::new(), |mut m, (g, r, e)| {
                m.entry(e.as_str()).or_insert_with(Vec::new).push((g.clone(), r.clone()));
                m
            });
            for (label, part) in engines {
                let summary = crate::lab::stats::summarize_versus(&part, &entrants, spec.pod, true);
                let label = label.to_string();
                let Some(v) = summary.versus else { continue };
                let mut strengths = HashMap::new();
                for e in &v.entrants {
                    let (Some(list), Some(f)) = (spec.entrants.iter().find(|l| l.id == e.id), e.strength) else { continue };
                    for precon in by_sha.get(&list.sha256).into_iter().flatten() {
                        strengths.insert(precon.clone(), f.strength);
                    }
                }
                if !strengths.is_empty() {
                    out.push(SimSource { kind: "tournament", id: id.clone(), name: name.clone(), engine: label, status: status.clone(), created_at: created_at.clone(), precons: strengths.len(), strengths });
                }
            }
        }
    }
    Ok(out)
}

/// The time-split test for every simulation source, as of `as_of` with the split at `split`.
pub async fn calibrate(pool: &SqlitePool, owner: Option<&str>, split: DateTime<Utc>, as_of: DateTime<Utc>) -> AppResult<CalibrationReport> {
    if split >= as_of {
        return Err(AppError::bad("the split must be before the evaluation date"));
    }
    let before = load(pool, split).await?.by_precon;
    let after = load(pool, as_of).await?;
    let mut cases: Vec<calibration::Case> = Vec::new();
    let mut all_time: HashMap<String, f64> = HashMap::new();
    for (id, ev) in &after.by_precon {
        let Some(now) = &ev.real else { continue };
        all_time.insert(id.clone(), now.latest.rate);
        let then = before.get(id).and_then(|e| e.real.as_ref());
        let train = then.map(|t| match &t.history.recent {
            Some(r) => calibration::Real { rate: r.rate, effective_games: r.effective_games },
            None => calibration::Real { rate: t.latest.rate, effective_games: t.latest.games as f64 },
        });
        // Held out: the games after the split's newest snapshot, on the same unbroken chain.
        let holdout = then.filter(|t| now.history.snapshots.contains(&t.latest) && now.latest.games > t.latest.games).and_then(|t| {
            let rate = history::implied(&t.latest, &now.latest);
            (0.0..=100.0).contains(&rate).then_some((rate, now.latest.games - t.latest.games))
        });
        cases.push(calibration::Case { precon: id.clone(), train, holdout, sim: None });
    }
    cases.sort_by(|a, b| a.precon.cmp(&b.precon));
    let precons_with_holdout = cases.iter().filter(|c| c.train.is_some() && c.holdout.is_some_and(|h| h.1 >= calibration::MIN_HOLDOUT_GAMES)).count();
    let mut sources = Vec::new();
    for source in sim_sources(pool, owner).await? {
        let with: Vec<calibration::Case> = cases.iter().map(|c| calibration::Case { sim: source.strengths.get(&c.precon).copied(), ..c.clone() }).collect();
        let pairs: Vec<(f64, f64)> = source.strengths.iter().filter_map(|(p, s)| Some((s.ln(), *all_time.get(p)?))).collect();
        let (xs, ys): (Vec<f64>, Vec<f64>) = pairs.iter().copied().unzip();
        sources.push(SourceCalibration {
            evaluation: calibration::evaluate(&with),
            spearman_all_time: calibration::spearman(&xs, &ys),
            all_time_precons: pairs.len(),
            source,
        });
    }
    Ok(CalibrationReport { split, as_of, real_source: after.report.source_label, precons_with_holdout, sources, method: CALIBRATION_METHOD })
}

#[derive(Deserialize)]
struct CalibrationQuery {
    split: Option<NaiveDate>,
}

/// Six weeks before `as_of`: the default split.
fn default_split(as_of: DateTime<Utc>) -> DateTime<Utc> {
    as_of - Duration::days(42)
}

async fn calibration_route(State(st): State<AppState>, AdminUser(user): AdminUser, Query(q): Query<CalibrationQuery>) -> AppResult<Json<CalibrationReport>> {
    let as_of = Utc::now();
    let split = q.split.map(|d| d.and_hms_opt(23, 59, 59).unwrap().and_utc()).unwrap_or_else(|| default_split(as_of));
    Ok(Json(calibrate(&st.pool, Some(&user.id), split, as_of).await?))
}

pub const V2_METHOD: &str = "evidence-weighted-v2";

/// One precon's combined estimate.
#[derive(Debug, Clone, Serialize)]
pub struct V2Estimate {
    pub precon: String,
    /// Estimated 4-player win rate, percent, with a 90% interval.
    pub rate: f64,
    pub lo: f64,
    pub hi: f64,
    /// Share of the estimate's precision that comes from real games (0–1).
    pub real_share: f64,
    pub rank: usize,
    /// 90% range of the rank, by simulation from each estimate's uncertainty.
    pub rank_lo: usize,
    pub rank_hi: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RatingV2 {
    pub method: &'static str,
    pub as_of: DateTime<Utc>,
    /// The simulation source it uses: the newest global precon-ratings run.
    pub simulation: Option<SimSource>,
    pub mapping: Option<calibration::Mapping>,
    /// Whether the simulation earned a place beside real games in the time-split test.
    pub gate_passed: bool,
    pub calibration: Option<calibration::Evaluation>,
    pub split: DateTime<Utc>,
    pub ranked: usize,
    pub precons: Vec<V2Estimate>,
    pub note: &'static str,
}

const V2_NOTE: &str = "Experimental. Real games and the simulation's strength on one scale, each weighted by how precise it has \
proved: the simulation counts beside real games only if it passed the time-split test, and otherwise ranks only precons without \
real games. Not a forecast for any particular table.";

/// Normal deviates from a deterministic stream (Box–Muller on xorshift).
struct Normal(u64);
impl Normal {
    fn uniform(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn next(&mut self) -> f64 {
        (-2.0 * self.uniform().ln()).sqrt() * (std::f64::consts::TAU * self.uniform()).cos()
    }
}

/// Rating v2 for every catalog precon with evidence, from the newest global run and the datasets.
pub async fn rating_v2(pool: &SqlitePool, as_of: DateTime<Utc>) -> AppResult<RatingV2> {
    let split = default_split(as_of);
    let evidence = load(pool, as_of).await?.by_precon;
    let simulation = sim_sources(pool, None).await?.into_iter().next();
    let report = calibrate(pool, None, split, as_of).await?;
    let calibration = simulation.as_ref().and_then(|s| report.sources.iter().find(|c| c.source.id == s.id)).map(|c| c.evaluation.clone());
    let gate_passed = calibration.as_ref().is_some_and(|c| c.gate_passed);
    // The mapping for today's estimates is fitted on today's real rates.
    let current: Vec<calibration::Case> = evidence
        .iter()
        .filter_map(|(id, ev)| {
            let real = ev.real.as_ref()?;
            let train = Some(match &real.history.recent {
                Some(r) => calibration::Real { rate: r.rate, effective_games: r.effective_games },
                None => calibration::Real { rate: real.latest.rate, effective_games: real.latest.games as f64 },
            });
            Some(calibration::Case { precon: id.clone(), train, holdout: None, sim: simulation.as_ref().and_then(|s| s.strengths.get(id).copied()) })
        })
        .collect();
    let mapping = calibration::mapping(&current);
    let reals: HashMap<&str, calibration::Real> = current.iter().filter_map(|c| Some((c.precon.as_str(), c.train?))).collect();
    let mut ids: Vec<&str> = reals.keys().copied().collect();
    if let Some(s) = &simulation {
        ids.extend(s.strengths.keys().map(String::as_str).filter(|id| !reals.contains_key(id)));
    }
    ids.sort();
    let mut rows: Vec<(String, f64, f64, f64)> = Vec::new();
    for id in ids {
        let real = reals.get(id).copied();
        let sim = simulation.as_ref().and_then(|s| s.strengths.get(id).copied());
        // Without a passed gate, the simulation only speaks for precons real games don't cover.
        let sim = if gate_passed || real.is_none() { sim } else { None };
        let Some((rate, var)) = calibration::combine(real, sim, mapping.as_ref()) else { continue };
        let real_share = match (real, sim.is_some() && mapping.is_some()) {
            (Some(r), true) => (1.0 / r.variance()) / (1.0 / var),
            (Some(_), false) => 1.0,
            (None, _) => 0.0,
        };
        rows.push((id.to_string(), rate, var, real_share));
    }
    // Rank ranges: redraw every estimate from its uncertainty and rank again.
    let n = rows.len();
    let mut draws: Vec<Vec<usize>> = vec![Vec::with_capacity(1000); n];
    let mut rng = Normal(0x9e37_79b9_7f4a_7c15);
    for _ in 0..1000 {
        let sample: Vec<f64> = rows.iter().map(|r| r.1 + r.2.sqrt() * rng.next()).collect();
        for i in 0..n {
            draws[i].push(1 + sample.iter().filter(|x| **x > sample[i]).count());
        }
    }
    let z = 1.644_853_626_951_472_2;
    let mut precons: Vec<V2Estimate> = rows
        .iter()
        .zip(draws.iter_mut())
        .map(|((id, rate, var, share), d)| {
            d.sort_unstable();
            V2Estimate {
                precon: id.clone(),
                rate: *rate,
                lo: (rate - z * var.sqrt()).max(0.0),
                hi: (rate + z * var.sqrt()).min(100.0),
                real_share: *share,
                rank: 1 + rows.iter().filter(|r| r.1 > *rate + 1e-9).count(),
                rank_lo: d[d.len() / 20],
                rank_hi: d[d.len() - 1 - d.len() / 20],
            }
        })
        .collect();
    precons.sort_by(|a, b| a.rank.cmp(&b.rank).then(a.precon.cmp(&b.precon)));
    Ok(RatingV2 { method: V2_METHOD, as_of, simulation, mapping, gate_passed, calibration, split, ranked: precons.len(), precons, note: V2_NOTE })
}

/// Let `owner`'s datasets from `source_name` feed the shared precon pages.
pub async fn enable(pool: &SqlitePool, owner: &str, source_name: &str) -> AppResult<()> {
    let name = source_name.trim();
    if name.is_empty() || name.len() > 240 {
        return Err(AppError::bad("source name must be 1–240 bytes"));
    }
    sqlx::query("INSERT INTO precon_evidence_sources(owner_id, source_name, enabled_at) VALUES (?,?,?) ON CONFLICT DO NOTHING")
        .bind(owner)
        .bind(name)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn disable(pool: &SqlitePool, owner: &str, source_name: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM precon_evidence_sources WHERE owner_id = ? AND source_name = ?").bind(owner).bind(source_name.trim()).execute(pool).await?;
    Ok(())
}

/// Record an operator's correction: `manual` links a precon to an entity, `exclude` forbids the pair.
pub async fn set_link(pool: &SqlitePool, precon: &str, entity: &str, rule: Option<&str>, note: Option<&str>) -> AppResult<()> {
    let known: Option<String> = sqlx::query_scalar("SELECT id FROM precons WHERE id = ?").bind(precon).fetch_optional(pool).await?;
    if known.is_none() {
        return Err(AppError::NotFound("precon"));
    }
    if entity.is_empty() || entity.len() > 160 {
        return Err(AppError::bad("entity must be 1–160 bytes"));
    }
    match rule {
        None => {
            sqlx::query("DELETE FROM precon_evidence_links WHERE precon_id = ? AND entity = ?").bind(precon).bind(entity).execute(pool).await?;
        }
        Some(rule @ ("manual" | "exclude")) => {
            sqlx::query(
                "INSERT INTO precon_evidence_links(precon_id, entity, rule, note, created_at) VALUES (?,?,?,?,?)
                 ON CONFLICT(precon_id, entity) DO UPDATE SET rule = excluded.rule, note = excluded.note, created_at = excluded.created_at",
            )
            .bind(precon)
            .bind(entity)
            .bind(rule)
            .bind(note)
            .bind(now())
            .execute(pool)
            .await?;
        }
        Some(_) => return Err(AppError::bad("rule must be manual or exclude")),
    }
    Ok(())
}

async fn rating_v2_route(State(st): State<AppState>, _u: CurrentUser) -> AppResult<Json<RatingV2>> {
    Ok(Json(rating_v2(&st.pool, Utc::now()).await?))
}

async fn report_route(State(st): State<AppState>, _a: AdminUser) -> AppResult<Json<Report>> {
    Ok(Json(load(&st.pool, Utc::now()).await?.report))
}

async fn enable_route(State(st): State<AppState>, AdminUser(user): AdminUser, Path(source): Path<String>) -> AppResult<Json<Report>> {
    enable(&st.pool, &user.id, &source).await?;
    Ok(Json(load(&st.pool, Utc::now()).await?.report))
}

async fn disable_route(State(st): State<AppState>, AdminUser(user): AdminUser, Path(source): Path<String>) -> AppResult<Json<Report>> {
    disable(&st.pool, &user.id, &source).await?;
    Ok(Json(load(&st.pool, Utc::now()).await?.report))
}

/// `yama-server precon-evidence report | use SOURCE --owner EMAIL | stop SOURCE --owner EMAIL |
/// link PRECON ENTITY [--note TEXT] | exclude PRECON ENTITY [--note TEXT] | unlink PRECON ENTITY`
pub async fn cli(pool: &SqlitePool, args: &[String]) -> anyhow::Result<()> {
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let positional: Vec<&String> = {
        let mut out = Vec::new();
        let mut skip = false;
        for a in args.iter().skip(1) {
            if skip {
                skip = false;
            } else if a.starts_with("--") {
                skip = true;
            } else {
                out.push(a);
            }
        }
        out
    };
    let err = |e: AppError| anyhow::anyhow!("{e}");
    const USAGE: &str = "usage: yama-server precon-evidence report | calibrate [--split YYYY-MM-DD] [--owner EMAIL] | use SOURCE --owner EMAIL | stop SOURCE --owner EMAIL | link PRECON ENTITY [--note TEXT] | exclude PRECON ENTITY [--note TEXT] | unlink PRECON ENTITY";
    match (args.first().map(String::as_str), positional.as_slice()) {
        (Some("report"), []) => {}
        (Some("calibrate"), []) => {
            let owner = match flag("--owner") {
                Some(email) => Some(crate::decks::cli::owner_id(pool, &email).await?),
                None => None,
            };
            let as_of = Utc::now();
            let split = match flag("--split") {
                Some(d) => d.parse::<NaiveDate>()?.and_hms_opt(23, 59, 59).unwrap().and_utc(),
                None => default_split(as_of),
            };
            let report = calibrate(pool, owner.as_deref(), split, as_of).await.map_err(err)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            return Ok(());
        }
        (Some(cmd @ ("use" | "stop")), [source]) => {
            let email = flag("--owner").ok_or_else(|| anyhow::anyhow!("--owner EMAIL is required"))?;
            let owner = crate::decks::cli::owner_id(pool, &email).await?;
            if cmd == "use" { enable(pool, &owner, source).await } else { disable(pool, &owner, source).await }.map_err(err)?;
        }
        (Some(cmd @ ("link" | "exclude" | "unlink")), [precon, entity]) => {
            let rule = match cmd {
                "link" => Some("manual"),
                "exclude" => Some("exclude"),
                _ => None,
            };
            set_link(pool, precon, entity, rule, flag("--note").as_deref()).await.map_err(err)?;
        }
        _ => anyhow::bail!(USAGE),
    }
    let report = load(pool, Utc::now()).await.map_err(err)?.report;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
