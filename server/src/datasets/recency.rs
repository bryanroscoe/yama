//! Descriptive weighted averages of compatible, disjoint monthly source aggregates.
//! No pooled win probability or binomial confidence interval is implied.
use super::model::{Observation, PeriodKind};
use chrono::NaiveDate;
use serde::Serialize;
use std::collections::BTreeMap;

pub const DEFAULT_HALF_LIFE_DAYS: u32 = 180;

#[derive(Serialize)]
pub struct Summary {
    pub entity_kind: String,
    pub cohort: String,
    pub metric: String,
    pub half_life_days: u32,
    pub as_of: NaiveDate,
    pub months: usize,
    pub excluded_months: usize,
    pub source_reported_games: u64,
    pub weighted_source_rate_percent: Option<f64>,
    pub method: &'static str,
    pub interpretation: &'static str,
}

pub fn summaries(rows: &[Observation], as_of: NaiveDate, half_life: u32) -> Vec<Summary> {
    let mut groups: BTreeMap<(&str, &str, &str), BTreeMap<NaiveDate, Vec<&Observation>>> =
        BTreeMap::new();
    for o in rows {
        if o.observation_period.kind != PeriodKind::CalendarMonth {
            continue;
        }
        let Some(start) = o.observation_period.start else {
            continue;
        };
        groups
            .entry((&o.entity_kind, &o.cohort, &o.metric))
            .or_default()
            .entry(start)
            .or_default()
            .push(o);
    }
    groups
        .into_iter()
        .map(|((entity_kind, cohort, metric), months)| {
            let (mut sum, mut weights, mut included, mut excluded, mut games) =
                (0.0, 0.0, 0, 0, 0);
            for versions in months.values() {
                let first = versions[0];
                // Duplicate source representations count once; conflicting revisions count neither.
                let conflict = versions.iter().any(|o| {
                    o.value != first.value
                        || o.source_reported_games != first.source_reported_games
                        || o.observation_period.end != first.observation_period.end
                        || o.quality_flags != first.quality_flags
                });
                let Some((start, end)) = first.observation_period.start.zip(first.observation_period.end)
                else {
                    excluded += 1;
                    continue;
                };
                if conflict || !first.quality_flags.is_empty() || end > as_of || first.source_reported_games == 0 {
                    excluded += 1;
                    continue;
                }
                let midpoint = start + (end - start) / 2;
                let age = (as_of - midpoint).num_days() as f64;
                let weight = first.source_reported_games as f64 * 2.0_f64.powf(-age / half_life as f64);
                weights += weight;
                sum += weight * first.value;
                included += 1;
                games += first.source_reported_games;
            }
            Summary {
                entity_kind: entity_kind.into(),
                cohort: cohort.into(),
                metric: metric.into(),
                half_life_days: half_life,
                as_of,
                months: included,
                excluded_months: excluded,
                source_reported_games: games,
                weighted_source_rate_percent: (weights > 0.0).then(|| sum / weights),
                method: "monthly-midpoint-sample-and-recency-v1",
                interpretation: "Descriptive average of source-reported normalized rates, weighted by their reported samples and exponential recency at month midpoints. Not a pooled win probability, causal upgrade effect, or confidence interval. Cumulative snapshots and rolling windows are excluded.",
            }
        })
        .collect()
}
