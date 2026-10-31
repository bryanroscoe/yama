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
        .route(
            "/api/admin/precon-evidence/sources/{source}",
            put(enable_route).delete(disable_route),
        )
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
    /// The entity's other cohorts as of the same date, for calibration across a cohort change.
    #[serde(skip)]
    pub other_cohorts: Vec<(String, History)>,
    pub as_of: DateTime<Utc>,
    pub method: &'static str,
}

/// The commander's own figure, for precons the source doesn't rate as a stock list.
#[derive(Debug, Clone, Serialize)]
pub struct CommanderObservation {
    pub source: SourceLabel,
    pub entity: String,
    pub name: String,
    pub url: Option<String>,
    pub window_days: u32,
    pub rate: f64,
    pub games: u64,
    pub as_of: DateTime<Utc>,
    pub note: &'static str,
}

impl PreconEvidence {
    /// The same evidence without each history's snapshots, intervals and notes, for lists.
    pub fn summary(mut self) -> Self {
        for r in self.real.iter_mut().chain(self.also.iter_mut()) {
            r.history.snapshots.clear();
            r.history.intervals.clear();
            r.history.notes.clear();
            r.other_cohorts.clear();
        }
        self
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PreconEvidence {
    /// The source with the newest snapshot; any other enabled source's history is in `also`.
    pub real: Option<RealHistory>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also: Vec<RealHistory>,
    pub commander: Option<CommanderObservation>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Unmatched {
    pub source: String,
    pub entity: String,
    pub name: String,
    pub url: Option<String>,
    /// Why: no catalog precon matched, or several did.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Report {
    pub sources: Vec<Value>,
    /// One per enabled source name, each with its own datasets, attribution and licence.
    pub source_labels: Vec<SourceLabel>,
    pub entities: usize,
    /// Catalog precon → (source, entity, rule) for each source that links it.
    pub matched: BTreeMap<String, Vec<(String, String, &'static str)>>,
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
            Ok(Enabled {
                revision_id,
                dataset,
                revision,
                imported_at,
                metadata: serde_json::from_str(&meta).map_err(anyhow::Error::from)?,
            })
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
        CatalogPrecon {
            id,
            name,
            playgroup_name,
            playgroup_url,
            playgroup_id,
            reference_matches,
        }
    })
    .collect();
    let mut report = Report {
        sources,
        catalog_precons: catalog.len(),
        ..Default::default()
    };
    if revisions.is_empty() {
        report.catalog_without_real_games = catalog.len();
        return Ok(Evidence {
            by_precon: HashMap::new(),
            report,
        });
    }

    // (source, precon, entity); an empty source applies to every source.
    let links: Vec<(String, String, String, String)> =
        sqlx::query_as("SELECT source_name, precon_id, entity, rule FROM precon_evidence_links")
            .fetch_all(pool)
            .await?;
    let manual: HashSet<(&str, &str, &str)> = links
        .iter()
        .filter(|l| l.3 == "manual")
        .map(|l| (l.0.as_str(), l.1.as_str(), l.2.as_str()))
        .collect();
    let excluded: HashSet<(&str, &str, &str)> = links
        .iter()
        .filter(|l| l.3 == "exclude")
        .map(|l| (l.0.as_str(), l.1.as_str(), l.2.as_str()))
        .collect();
    let has = |set: &HashSet<(&str, &str, &str)>, source: &str, precon: &str, entity: &str| {
        set.contains(&("", precon, entity)) || set.contains(&(source, precon, entity))
    };
    let commander_entities: Vec<String> = catalog
        .iter()
        .filter_map(|p| p.playgroup_id)
        .map(|id| format!("{COMMANDER_PREFIX}{id}"))
        .collect();
    let commander_json = serde_json::to_string(&commander_entities).map_err(anyhow::Error::from)?;
    // Each source name is derived on its own: its datasets merge, other sources never do.
    let mut groups: BTreeMap<String, Vec<&Enabled>> = BTreeMap::new();
    for r in &revisions {
        groups
            .entry(r.metadata["source"]["name"].as_str().unwrap_or_default().to_string())
            .or_default()
            .push(r);
    }
    let mut by_precon: HashMap<String, PreconEvidence> = HashMap::new();
    for revisions in groups.values() {
        // One label per source: the datasets feeding it, newest import first.
        let first = &revisions[0].metadata["source"];
        let mut datasets: Vec<DatasetLabel> = revisions
            .iter()
            .map(|r| DatasetLabel {
                id: r.dataset.clone(),
                revision: r.revision,
                imported_at: r.imported_at.clone(),
            })
            .collect();
        datasets.sort_by(|a, b| b.imported_at.cmp(&a.imported_at).then(a.id.cmp(&b.id)));
        // Every distinct attribution and licence the merged datasets declare, in dataset order.
        let distinct = |key: &str| {
            let mut seen: Vec<&str> = Vec::new();
            for r in revisions {
                let v = r.metadata["source"][key].as_str().unwrap_or_default().trim();
                if !v.is_empty() && !seen.contains(&v) {
                    seen.push(v);
                }
            }
            seen.join("; ")
        };
        let label = SourceLabel {
            name: first["name"].as_str().unwrap_or_default().into(),
            attribution: distinct("attribution"),
            license: distinct("license"),
            datasets,
        };

        let mut entities: BTreeMap<String, Entity> = BTreeMap::new();
        // Commander entity → window → (as_of, rate, games, name, url), newest per window.
        type Window = (DateTime<Utc>, f64, u64, String, Option<String>);
        // Every observation per commander and window; the newest undisputed one is chosen below.
        let mut observed: HashMap<String, HashMap<u32, Vec<Window>>> = HashMap::new();
        for r in revisions {
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
                if record["sources"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .any(|s| partial.contains(s))
                {
                    continue;
                }
                let Ok(o) = serde_json::from_value::<Observation>(record["data"].clone()) else {
                    continue;
                };
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
                        e.cohorts.entry(o.cohort.clone()).or_default().push(Snapshot {
                            as_of: at,
                            games: o.source_reported_games,
                            rate: o.value,
                        });
                    }
                    ("commander", "rolling_window") => {
                        let Some(days) = o.observation_period.lookback_days.filter(|d| COMMANDER_WINDOWS.contains(d)) else {
                            continue;
                        };
                        if at > as_of || o.source_reported_games == 0 {
                            continue;
                        }
                        observed.entry(o.entity_id.clone()).or_default().entry(days).or_default().push((
                            at,
                            o.value,
                            o.source_reported_games,
                            name,
                            o.source_entity_url.clone(),
                        ));
                    }
                    _ => {}
                }
            }
        }
        // Per window: the newest date whose observations agree. Disagreeing datasets set that date
        // aside, like conflicting snapshots, and an earlier agreed figure stands instead.
        let mut commanders: HashMap<String, HashMap<u32, Window>> = HashMap::new();
        for (entity, windows) in observed {
            for (days, mut obs) in windows {
                obs.sort_by(|a, b| b.0.cmp(&a.0));
                let chosen = obs
                    .chunk_by(|a, b| a.0 == b.0)
                    .find(|same| same.iter().all(|w| (w.1 - same[0].1).abs() < 0.005 && w.2 == same[0].2));
                if let Some(same) = chosen {
                    commanders.entry(entity.clone()).or_default().insert(days, same[0].clone());
                }
            }
        }
        report.entities += entities.len();
        report.source_labels.push(label.clone());

        // Each entity's best rule and the precons it names; then each precon keeps its best entity.
        let rules: [&'static str; 4] = ["manual", "url", "name", "slug"];
        let mut claims: HashMap<&str, Vec<(usize, &str)>> = HashMap::new();
        for (entity_id, e) in &entities {
            let slug = entity_id.strip_prefix(PRECON_PREFIX).unwrap_or(entity_id);
            let test = |rule: &str, p: &CatalogPrecon| match rule {
                "manual" => has(&manual, &label.name, &p.id, entity_id),
                "url" => matches!((&p.playgroup_url, &e.url), (Some(a), Some(b)) if norm_url(a) == norm_url(b)),
                "name" => !e.name.is_empty() && norm_name(p.playgroup_name.as_deref().unwrap_or(&p.name)) == norm_name(&e.name),
                _ => p.id == slug,
            };
            let mut found = false;
            for (priority, rule) in rules.iter().enumerate() {
                let hits: Vec<&CatalogPrecon> = catalog
                    .iter()
                    .filter(|p| !has(&excluded, &label.name, &p.id, entity_id) && test(rule, p))
                    .collect();
                if hits.is_empty() {
                    continue;
                }
                // A name or slug that fits several precons is ambiguous; a shared link or manual choice isn't.
                if hits.len() > 1 && priority >= 2 {
                    report.unmatched.push(Unmatched {
                        source: label.name.clone(),
                        entity: entity_id.clone(),
                        name: e.name.clone(),
                        url: e.url.clone(),
                        reason: format!(
                            "its {rule} fits {} catalog precons: {}",
                            hits.len(),
                            hits.iter().map(|p| p.id.as_str()).collect::<Vec<_>>().join(", ")
                        ),
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
                report.unmatched.push(Unmatched {
                    source: label.name.clone(),
                    entity: entity_id.clone(),
                    name: e.name.clone(),
                    url: e.url.clone(),
                    reason: "no catalog precon matched".into(),
                });
            }
        }
        for p in &catalog {
            let mut ev = PreconEvidence::default();
            if let Some(c) = claims.get(p.id.as_str()) {
                let best = c.iter().map(|x| x.0).min().unwrap();
                let top: Vec<&str> = c.iter().filter(|x| x.0 == best).map(|x| x.1).collect();
                if top.len() > 1 {
                    for entity in &top {
                        let e = &entities[*entity];
                        report.unmatched.push(Unmatched {
                            source: label.name.clone(),
                            entity: entity.to_string(),
                            name: e.name.clone(),
                            url: e.url.clone(),
                            reason: format!(
                                "{} is also claimed by {}",
                                p.id,
                                top.iter().filter(|x| x != &entity).copied().collect::<Vec<_>>().join(", ")
                            ),
                        });
                    }
                } else if p.reference_matches {
                    let entity_id = top[0];
                    let e = &entities[entity_id];
                    report
                        .matched
                        .entry(p.id.clone())
                        .or_default()
                        .push((label.name.clone(), entity_id.to_string(), rules[best]));
                    // Each cohort is read as of the evaluation date; the one with the newest usable
                    // snapshot then speaks for the precon.
                    let mut readable: Vec<(DateTime<Utc>, String, History)> = e
                        .cohorts
                        .iter()
                        .map(|(c, s)| (c.clone(), history::history(s.clone(), as_of, HALF_LIFE_DAYS)))
                        .filter_map(|(c, h)| Some((h.snapshots.last()?.as_of, c, h)))
                        .collect();
                    readable.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
                    let mut readable = readable.into_iter();
                    if let Some((_, cohort, h)) = readable.next() {
                        let other_cohorts = readable.map(|(_, c, h)| (c, h)).collect();
                        let latest = *h.snapshots.last().unwrap();
                        ev.real = Some(RealHistory {
                            source: label.clone(),
                            entity: entity_id.to_string(),
                            entity_name: e.name.clone(),
                            url: e.url.clone(),
                            matched_by: rules[best],
                            cohort,
                            latest,
                            history: h,
                            other_cohorts,
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
                            source: label.clone(),
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
            if ev.real.is_none() && ev.commander.is_none() {
                continue;
            }
            let merged = by_precon.entry(p.id.clone()).or_default();
            if let Some(real) = ev.real {
                match merged.real.take() {
                    Some(old) if old.latest.as_of >= real.latest.as_of => {
                        merged.real = Some(old);
                        merged.also.push(real);
                    }
                    Some(old) => {
                        merged.also.push(old);
                        merged.real = Some(real);
                    }
                    None => merged.real = Some(real),
                }
            }
            // The newest commander figure across sources stands in.
            if let Some(c) = ev.commander {
                if merged.commander.as_ref().is_none_or(|m| c.as_of > m.as_of) {
                    merged.commander = Some(c);
                }
            }
        }
    }
    // A commander's figure only stands in when no source rates the precon itself.
    for ev in by_precon.values_mut() {
        if ev.real.is_some() {
            ev.commander = None;
        }
    }
    report.catalog_without_real_games = catalog
        .iter()
        .filter(|p| by_precon.get(&p.id).is_none_or(|e| e.real.is_none()))
        .count();
    report.unmatched.sort_by(|a, b| (&a.source, &a.entity).cmp(&(&b.source, &b.entity)));
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
    /// When its results existed: a global run's analysis date (else its schedule date), a tournament's creation.
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
    /// Whether the source was made before the split. One made later could reflect what was learnt
    /// after it, so it's scored for description but can't pass the gate.
    pub predates_split: bool,
    pub evaluation: calibration::Evaluation,
    /// Descriptive: rank correlation with today's all-time real rates, over every precon with both.
    pub spearman_all_time: Option<f64>,
    pub all_time_precons: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CalibrationReport {
    pub split: DateTime<Utc>,
    pub as_of: DateTime<Utc>,
    pub real_sources: Vec<SourceLabel>,
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

/// Strengths from the newest global precon-ratings runs and the caller's own tournaments. With a
/// `cutoff`, a tournament counts only the games finished by then, so its strengths are frozen there.
pub async fn sim_sources(pool: &SqlitePool, owner: Option<&str>, cutoff: Option<DateTime<Utc>>) -> AppResult<Vec<SimSource>> {
    let catalog: Vec<(String, String, String)> = sqlx::query_as("SELECT id, lab_id, cards FROM precons").fetch_all(pool).await?;
    // Only stock lists the catalog still matches take a stock list's simulated result.
    let mut by_lab: HashMap<&str, &str> = HashMap::new();
    let mut by_sha: HashMap<String, Vec<String>> = HashMap::new();
    for (id, lab, cards) in &catalog {
        if let Ok(cards) = serde_json::from_str::<Vec<crate::lab::PreconCard>>(cards) {
            if crate::upgradeability::allows_reference_results(id, &cards) {
                by_lab.insert(lab.as_str(), id.as_str());
                by_sha
                    .entry(crate::lab::experiments::precon_list_sha(cards))
                    .or_default()
                    .push(id.clone());
            }
        }
    }
    let mut out = Vec::new();
    // The engine label carries the card data, as tournament partitions do, so each build is named exactly.
    type RunRow = (String, String, Option<String>, Option<String>, Option<String>, String);
    let runs: Vec<RunRow> = sqlx::query_as(
        "SELECT id, name, engine, card_data, difficulty, COALESCE(analysed_at, created_at) FROM lab_runs WHERE owner_id IS NULL AND kind = 'precon-ratings'
         ORDER BY created_at DESC LIMIT 10",
    )
    .fetch_all(pool)
    .await?;
    for (id, name, engine, card_data, difficulty, created_at) in runs {
        let engine = format!(
            "{}, card data {}, {} AI",
            engine.as_deref().unwrap_or("unknown"),
            card_data.as_deref().map(|c| c.get(..16).unwrap_or(c)).unwrap_or("unknown"),
            difficulty.as_deref().unwrap_or("unknown")
        );
        let strengths: HashMap<String, f64> = crate::lab::ratings_for(pool, &id)
            .await?
            .into_iter()
            .filter_map(|(deck, r)| Some((by_lab.get(deck.as_str())?.to_string(), r.strength.filter(|s| *s > 0.0)?)))
            .collect();
        out.push(SimSource {
            kind: "global run",
            id,
            name,
            engine,
            status: "done".into(),
            created_at,
            precons: strengths.len(),
            strengths,
        });
    }
    if let Some(owner) = owner {
        let rows: Vec<Tournament> = sqlx::query_as(
            "SELECT id, name, status, created_at, spec FROM lab_experiments
             WHERE owner_id = ? AND json_extract(spec, '$.mode') = 'tournament' ORDER BY created_at DESC LIMIT 20",
        )
        .bind(owner)
        .fetch_all(pool)
        .await?;
        for row in rows {
            out.extend(tournament_sources(pool, &by_sha, row, None, cutoff).await?);
        }
    }
    Ok(out)
}

/// A tournament's id, name, status, creation and spec.
type Tournament = (String, String, String, String, String);

/// One tournament's strengths: one source per engine and exact build (engine version and card
/// data), so a run that spans a deployment never pools two builds' games into one strength.
/// `engine` limits it to one engine's games; `cutoff` to the games finished by then.
async fn tournament_sources(
    pool: &SqlitePool,
    by_sha: &HashMap<String, Vec<String>>,
    (id, name, status, created_at, spec): Tournament,
    engine: Option<&str>,
    cutoff: Option<DateTime<Utc>>,
) -> AppResult<Vec<SimSource>> {
    let spec: crate::lab::experiments::ExperimentSpec = serde_json::from_str(&spec).map_err(anyhow::Error::from)?;
    let entrants: Vec<(String, String)> = spec.entrants.iter().map(|l| (l.id.clone(), l.label.clone())).collect();
    // Summarised afresh, so runs stored before fitted strengths existed still count.
    let cutoff = cutoff.map(|c| c.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    let games: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "SELECT spec, result, engine || ' ' || IFNULL(json_extract(result, '$.engine'), 'unknown') || ', card data ' || IFNULL(substr(json_extract(result, '$.card_data'), 1, 16), 'unknown')
         FROM lab_experiment_games
         WHERE experiment_id = ? AND result IS NOT NULL AND (? IS NULL OR finished_at <= ?) AND (? IS NULL OR engine = ?) ORDER BY ord",
    )
    .bind(&id)
    .bind(&cutoff)
    .bind(&cutoff)
    .bind(engine)
    .bind(engine)
    .fetch_all(pool)
    .await?;
    let builds: BTreeMap<&str, Vec<(String, Option<String>)>> = games.iter().fold(BTreeMap::new(), |mut m, (g, r, e)| {
        m.entry(e.as_str()).or_insert_with(Vec::new).push((g.clone(), r.clone()));
        m
    });
    let mut out = Vec::new();
    for (label, part) in builds {
        let summary = crate::lab::stats::summarize_versus(&part, &entrants, spec.pod, true);
        let label = format!("{label}, {} AI", spec.difficulty);
        let Some(v) = summary.versus else { continue };
        let mut strengths = HashMap::new();
        for e in &v.entrants {
            let (Some(list), Some(f)) = (spec.entrants.iter().find(|l| l.id == e.id), e.strength) else {
                continue;
            };
            for precon in by_sha.get(&list.sha256).into_iter().flatten() {
                strengths.insert(precon.clone(), f.strength);
            }
        }
        if !strengths.is_empty() {
            out.push(SimSource {
                kind: "tournament",
                id: id.clone(),
                name: name.clone(),
                engine: label,
                status: status.clone(),
                created_at: created_at.clone(),
                precons: strengths.len(),
                strengths,
            });
        }
    }
    Ok(out)
}

/// Every catalog list's hash, and the precons by hash still allowed a stock list's simulated result.
async fn catalog_by_sha(pool: &SqlitePool) -> AppResult<(HashSet<String>, HashMap<String, Vec<String>>)> {
    let catalog: Vec<(String, String)> = sqlx::query_as("SELECT id, cards FROM precons").fetch_all(pool).await?;
    let mut all = HashSet::new();
    let mut allowed: HashMap<String, Vec<String>> = HashMap::new();
    for (id, cards) in catalog {
        if let Ok(cards) = serde_json::from_str::<Vec<crate::lab::PreconCard>>(&cards) {
            let sha = crate::lab::experiments::precon_list_sha(&cards);
            if crate::upgradeability::allows_reference_results(&id, &cards) {
                allowed.entry(sha.clone()).or_default().push(id);
            }
            all.insert(sha);
        }
    }
    Ok((all, allowed))
}

/// Check that `id` is a tournament whose every entrant is a current catalog stock list, so its
/// strengths can't depend on anyone's own lists.
async fn stock_tournament(pool: &SqlitePool, id: &str) -> AppResult<(Tournament, HashMap<String, Vec<String>>)> {
    let row: Option<Tournament> = sqlx::query_as("SELECT id, name, status, created_at, spec FROM lab_experiments WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    let row = row.ok_or(AppError::NotFound("experiment"))?;
    let spec: crate::lab::experiments::ExperimentSpec = serde_json::from_str(&row.4).map_err(anyhow::Error::from)?;
    if spec.mode != crate::lab::experiments::Mode::Tournament || !spec.opponents.is_empty() || spec.entrants.is_empty() {
        return Err(AppError::bad("the simulation must be a tournament of stock precons with no other opponents"));
    }
    let (all, allowed) = catalog_by_sha(pool).await?;
    if let Some(l) = spec.entrants.iter().find(|l| !all.contains(&l.sha256)) {
        return Err(AppError::bad(format!("entrant {:?} is not a current stock precon list", l.label)));
    }
    Ok((row, allowed))
}

/// The operator's chosen simulation (`precon-evidence simulate`): its engine's strengths for the
/// stock precons in it, re-read as it plays. `None` when nothing is chosen.
pub async fn chosen_simulation(pool: &SqlitePool) -> AppResult<Option<SimSource>> {
    let chosen: Option<(String, String)> = sqlx::query_as("SELECT experiment_id, engine FROM precon_evidence_simulation")
        .fetch_optional(pool)
        .await?;
    let Some((id, engine)) = chosen else { return Ok(None) };
    let (row, by_sha) = stock_tournament(pool, &id).await?;
    let (date, done) = (row.3.get(..10).unwrap_or(&row.3).to_string(), row.2 == "done");
    // A run spanning a deployment has a source per build: the one rating the most precons speaks.
    let best = tournament_sources(pool, &by_sha, row, Some(&engine), None)
        .await?
        .into_iter()
        .max_by_key(|s| s.precons);
    // The experiment's own name is its owner's; the public sees what it is.
    Ok(best.map(|mut s| {
        s.name = format!(
            "Stock precon tournament, {} ({date}{})",
            if engine == "forge" { "Forge" } else { "Phase" },
            if done { "" } else { ", still playing" }
        );
        s
    }))
}

/// Choose `experiment`'s `engine` games as the simulation rating v2 reads.
pub async fn choose_simulation(pool: &SqlitePool, experiment: &str, engine: &str) -> AppResult<()> {
    if !matches!(engine, "phase" | "forge") {
        return Err(AppError::bad("engine must be phase or forge"));
    }
    stock_tournament(pool, experiment).await?;
    sqlx::query(
        "INSERT INTO precon_evidence_simulation(id, experiment_id, engine, chosen_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET experiment_id = excluded.experiment_id, engine = excluded.engine, chosen_at = excluded.chosen_at",
    )
    .bind(experiment)
    .bind(engine)
    .bind(now())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn clear_simulation(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query("DELETE FROM precon_evidence_simulation").execute(pool).await?;
    Ok(())
}

/// The time-split test for every simulation source, as of `as_of` with the split at `split`.
pub async fn calibrate(pool: &SqlitePool, owner: Option<&str>, split: DateTime<Utc>, as_of: DateTime<Utc>) -> AppResult<CalibrationReport> {
    if split >= as_of {
        return Err(AppError::bad("the split must be before the evaluation date"));
    }
    let after = load(pool, as_of).await?;
    let sims = sim_sources(pool, owner, Some(split)).await?;
    calibrate_with(pool, split, as_of, &after, sims).await
}

/// The time-split test with today's evidence and the simulation sources already loaded.
async fn calibrate_with(
    pool: &SqlitePool,
    split: DateTime<Utc>,
    as_of: DateTime<Utc>,
    after: &Evidence,
    sims: Vec<SimSource>,
) -> AppResult<CalibrationReport> {
    let before = load(pool, split).await?.by_precon;
    let mut cases: Vec<calibration::Case> = Vec::new();
    let mut all_time: HashMap<String, f64> = HashMap::new();
    for (id, ev) in &after.by_precon {
        let Some(primary) = &ev.real else { continue };
        all_time.insert(id.clone(), primary.latest.rate);
        // Train and held-out games come from one source: the first of today's histories (newest
        // first) that the split also had from the same source and entity.
        // Every (source, entity, cohort) history on each side, so a chain is found whichever cohort
        // each side happened to show first.
        let cohorts = |e: &'_ PreconEvidence| -> Vec<(String, String, String, History)> {
            e.real
                .iter()
                .chain(e.also.iter())
                .flat_map(|r| {
                    std::iter::once((r.source.name.clone(), r.entity.clone(), r.cohort.clone(), r.history.clone())).chain(
                        r.other_cohorts
                            .iter()
                            .map(|(c, h)| (r.source.name.clone(), r.entity.clone(), c.clone(), h.clone())),
                    )
                })
                .filter(|c| !c.3.snapshots.is_empty())
                .collect()
        };
        let earlier = before.get(id).map(cohorts).unwrap_or_default();
        let today = cohorts(ev);
        let matches: Vec<(&History, &History)> = today
            .iter()
            .filter_map(|(s, e, c, h)| earlier.iter().find(|t| &t.0 == s && &t.1 == e && &t.2 == c).map(|t| (h, &t.3)))
            .collect();
        // Prefer a chain that runs unbroken across the split with later games on it.
        // The newest snapshot on today's chain through the split's newest snapshot, if later games
        // followed it. A count that fell after the split ended that chain; it's kept for this.
        let after_split = |now: &'_ History, then: &History| -> Option<Snapshot> {
            let split_latest = then.snapshots.last()?;
            std::iter::once(&now.snapshots)
                .chain(now.earlier_chains.iter())
                .find(|chain| chain.contains(split_latest))
                .and_then(|chain| chain.last().copied())
                .filter(|last| last.games > split_latest.games)
        };
        let spans = |now: &History, then: &History| after_split(now, then).is_some();
        let pair = matches.iter().find(|(h, t)| spans(h, t)).or_else(|| matches.first()).copied();
        let (now, then): (&History, Option<&History>) = match pair {
            Some((h, t)) => (h, Some(t)),
            None => (&primary.history, None),
        };
        let train = then.map(|t| match &t.recent {
            Some(r) => calibration::Real {
                rate: r.rate,
                effective_games: r.effective_games,
            },
            None => {
                let last = t.snapshots.last().unwrap();
                calibration::Real {
                    rate: last.rate,
                    effective_games: last.games as f64,
                }
            }
        });
        // Held out: the games after the split's newest snapshot, on the same unbroken chain.
        let holdout = then.and_then(|t| {
            let (first, last) = (t.snapshots.last()?, after_split(now, t)?);
            let rate = history::implied(first, &last);
            (0.0..=100.0).contains(&rate).then_some((rate, last.games - first.games))
        });
        cases.push(calibration::Case {
            precon: id.clone(),
            train,
            holdout,
            sim: None,
        });
    }
    cases.sort_by(|a, b| a.precon.cmp(&b.precon));
    let precons_with_holdout = cases
        .iter()
        .filter(|c| c.train.is_some() && c.holdout.is_some_and(|h| h.1 >= calibration::MIN_HOLDOUT_GAMES))
        .count();
    let mut sources = Vec::new();
    for source in sims {
        let with: Vec<calibration::Case> = cases
            .iter()
            .map(|c| calibration::Case {
                sim: source.strengths.get(&c.precon).copied(),
                ..c.clone()
            })
            .collect();
        let pairs: Vec<(f64, f64)> = source
            .strengths
            .iter()
            .filter_map(|(p, s)| Some((s.ln(), *all_time.get(p)?)))
            .collect();
        let (xs, ys): (Vec<f64>, Vec<f64>) = pairs.iter().copied().unzip();
        let predates_split = DateTime::parse_from_rfc3339(&source.created_at).is_ok_and(|t| t.with_timezone(&Utc) <= split);
        let mut evaluation = calibration::evaluate(&with);
        if !predates_split {
            evaluation.gate_passed = false;
            evaluation.verdict = format!(
                "Made after the split ({}), so this is descriptive only and can't pass the gate. {}",
                source.created_at.get(..10).unwrap_or(&source.created_at),
                evaluation.verdict
            );
        }
        sources.push(SourceCalibration {
            predates_split,
            evaluation,
            spearman_all_time: calibration::spearman(&xs, &ys),
            all_time_precons: pairs.len(),
            source,
        });
    }
    Ok(CalibrationReport {
        split,
        as_of,
        real_sources: after.report.source_labels.clone(),
        precons_with_holdout,
        sources,
        method: CALIBRATION_METHOD,
    })
}

#[derive(Deserialize)]
struct CalibrationQuery {
    split: Option<NaiveDate>,
}

/// Six weeks before `as_of`: the default split.
fn default_split(as_of: DateTime<Utc>) -> DateTime<Utc> {
    as_of - Duration::days(42)
}

async fn calibration_route(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    Query(q): Query<CalibrationQuery>,
) -> AppResult<Json<CalibrationReport>> {
    let as_of = Utc::now();
    let split = q
        .split
        .map(|d| d.and_hms_opt(23, 59, 59).unwrap().and_utc())
        .unwrap_or_else(|| default_split(as_of));
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
    let loaded = load(pool, as_of).await?;
    rating_v2_with(pool, as_of, loaded).await
}

/// Rating v2 from evidence already loaded as of `as_of`.
pub async fn rating_v2_with(pool: &SqlitePool, as_of: DateTime<Utc>, loaded: Evidence) -> AppResult<RatingV2> {
    // The operator's chosen simulation, else the newest global run.
    let chosen = chosen_simulation(pool).await.unwrap_or_else(|e| {
        tracing::warn!(error = ?e, "chosen precon simulation unusable; using the newest global run");
        None
    });
    let simulation = match chosen {
        Some(s) => Some(s),
        None => sim_sources(pool, None, None).await?.into_iter().next(),
    };
    rating_v2_from(pool, as_of, loaded, simulation).await
}

/// Rating v2 with a chosen simulation source, or none. The public pages pass the operator's chosen tournament.
pub async fn rating_v2_from(
    pool: &SqlitePool,
    as_of: DateTime<Utc>,
    loaded: Evidence,
    simulation: Option<SimSource>,
) -> AppResult<RatingV2> {
    let split = default_split(as_of);
    let sims: Vec<SimSource> = simulation.iter().cloned().collect();
    let report = calibrate_with(pool, split, as_of, &loaded, sims).await?;
    let evidence = loaded.by_precon;
    let calibration = simulation
        .as_ref()
        .and_then(|s| report.sources.iter().find(|c| c.source.id == s.id))
        .map(|c| c.evaluation.clone());
    let gate_passed = calibration.as_ref().is_some_and(|c| c.gate_passed);
    // The mapping for today's estimates is fitted on today's real rates.
    let current: Vec<calibration::Case> = evidence
        .iter()
        .filter_map(|(id, ev)| {
            let real = ev.real.as_ref()?;
            let train = Some(match &real.history.recent {
                Some(r) => calibration::Real {
                    rate: r.rate,
                    effective_games: r.effective_games,
                },
                None => calibration::Real {
                    rate: real.latest.rate,
                    effective_games: real.latest.games as f64,
                },
            });
            Some(calibration::Case {
                precon: id.clone(),
                train,
                holdout: None,
                sim: simulation.as_ref().and_then(|s| s.strengths.get(id).copied()),
            })
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
        let Some((rate, var)) = calibration::combine(real, sim, mapping.as_ref()) else {
            continue;
        };
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
    Ok(RatingV2 {
        method: V2_METHOD,
        as_of,
        simulation,
        mapping,
        gate_passed,
        calibration,
        split,
        ranked: precons.len(),
        precons,
        note: V2_NOTE,
    })
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
    sqlx::query("DELETE FROM precon_evidence_sources WHERE owner_id = ? AND source_name = ?")
        .bind(owner)
        .bind(source_name.trim())
        .execute(pool)
        .await?;
    Ok(())
}

/// Record an operator's correction: `manual` links a precon to an entity, `exclude` forbids the pair.
/// `source` limits it to one source name; `None` applies it to every source.
pub async fn set_link(
    pool: &SqlitePool,
    source: Option<&str>,
    precon: &str,
    entity: &str,
    rule: Option<&str>,
    note: Option<&str>,
) -> AppResult<()> {
    let source = source.map(str::trim).unwrap_or_default();
    if source.len() > 240 {
        return Err(AppError::bad("source name must be at most 240 bytes"));
    }
    let known: Option<String> = sqlx::query_scalar("SELECT id FROM precons WHERE id = ?")
        .bind(precon)
        .fetch_optional(pool)
        .await?;
    if known.is_none() {
        return Err(AppError::NotFound("precon"));
    }
    if entity.is_empty() || entity.len() > 160 {
        return Err(AppError::bad("entity must be 1–160 bytes"));
    }
    match rule {
        None => {
            sqlx::query("DELETE FROM precon_evidence_links WHERE source_name = ? AND precon_id = ? AND entity = ?")
                .bind(source)
                .bind(precon)
                .bind(entity)
                .execute(pool)
                .await?;
        }
        Some(rule @ ("manual" | "exclude")) => {
            sqlx::query(
                "INSERT INTO precon_evidence_links(source_name, precon_id, entity, rule, note, created_at) VALUES (?,?,?,?,?,?)
                 ON CONFLICT(source_name, precon_id, entity) DO UPDATE SET rule = excluded.rule, note = excluded.note, created_at = excluded.created_at",
            )
            .bind(source)
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
/// simulate EXPERIMENT [--engine forge|phase] | simulate --none |
/// link PRECON ENTITY [--source NAME] [--note TEXT] | exclude PRECON ENTITY [--source NAME] [--note TEXT] | unlink PRECON ENTITY [--source NAME]`
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
    const USAGE: &str = "usage: yama-server precon-evidence report | calibrate [--split YYYY-MM-DD] [--owner EMAIL] | use SOURCE --owner EMAIL | stop SOURCE --owner EMAIL | simulate EXPERIMENT [--engine forge|phase] | simulate --none | link PRECON ENTITY [--source NAME] [--note TEXT] | exclude PRECON ENTITY [--source NAME] [--note TEXT] | unlink PRECON ENTITY [--source NAME]";
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
            if cmd == "use" {
                enable(pool, &owner, source).await
            } else {
                disable(pool, &owner, source).await
            }
            .map_err(err)?;
        }
        (Some("simulate"), [experiment]) => {
            let engine = flag("--engine").unwrap_or_else(|| "forge".into());
            choose_simulation(pool, experiment, &engine).await.map_err(err)?;
            let chosen = chosen_simulation(pool).await.map_err(err)?;
            println!("{}", serde_json::to_string_pretty(&chosen)?);
            return Ok(());
        }
        (Some("simulate"), []) if args.iter().any(|a| a == "--none") => {
            clear_simulation(pool).await.map_err(err)?;
            println!("No simulation: rating v2 ranks with real games alone on the public pages.");
            return Ok(());
        }
        (Some(cmd @ ("link" | "exclude" | "unlink")), [precon, entity]) => {
            let rule = match cmd {
                "link" => Some("manual"),
                "exclude" => Some("exclude"),
                _ => None,
            };
            set_link(pool, flag("--source").as_deref(), precon, entity, rule, flag("--note").as_deref())
                .await
                .map_err(err)?;
        }
        _ => anyhow::bail!(USAGE),
    }
    let report = load(pool, Utc::now()).await.map_err(err)?.report;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
