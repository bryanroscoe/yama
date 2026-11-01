//! Experimental ordinal consensus, not a calibrated probability of winning.
//! Compute before display filters, on the intersection of explicitly published sources.
use super::Precon;
use serde::Serialize;

pub(super) const METHOD: &str = "common-cohort-percentiles-v1";
#[derive(Clone, Serialize)]
pub struct Component {
    pub source: String,
    pub percentile: f64,
}
#[derive(Clone, Serialize)]
pub struct Meta {
    pub method: &'static str,
    pub rank: usize,
    pub cohort: usize,
    pub score: f64,
    pub real_percentile: f64,
    pub simulation_percentile: f64,
    pub components: Vec<Component>,
    pub flagged: bool,
}

pub(super) fn engine_family(engine: &str) -> &'static str {
    if engine.starts_with("phase") {
        "Phase"
    } else if engine.starts_with("forge") {
        "Forge"
    } else {
        "Other"
    }
}

// Average-rank percentile: ties receive identical scores, higher is better.
fn percentile(values: &[f64], value: f64) -> f64 {
    let below = values.iter().filter(|v| **v < value).count() as f64;
    let equal = values.iter().filter(|v| **v == value).count() as f64;
    100.0 * (below + (equal - 1.0) / 2.0) / (values.len() - 1) as f64
}

pub(super) fn assign(rows: &mut [Precon], source_count: usize) -> usize {
    for row in rows.iter_mut() {
        row.meta = None;
    }
    if source_count == 0 {
        return 0;
    }
    let eligible: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, p)| {
            p.real_games.as_ref().is_some_and(|r| r.games >= 20)
                && p.simulations.len() == source_count
                && p.simulations
                    .iter()
                    .all(|s| s.rating.games >= 20 && s.rating.strength.is_some())
        })
        .map(|(i, _)| i)
        .collect();
    let n = eligible.len();
    // A tiny cohort gives misleadingly extreme percentiles.
    if n < 4 {
        return 0;
    }
    let real: Vec<f64> = eligible
        .iter()
        .map(|&i| rows[i].real_games.as_ref().unwrap().win_rate_4p)
        .collect();
    let simulated: Vec<Vec<f64>> = (0..source_count)
        .map(|j| {
            eligible
                .iter()
                .map(|&i| rows[i].simulations[j].rating.strength.unwrap())
                .collect()
        })
        .collect();
    for (k, &i) in eligible.iter().enumerate() {
        let p = &mut rows[i];
        let real_percentile = percentile(&real, real[k]);
        let components: Vec<Component> = p
            .simulations
            .iter()
            .enumerate()
            .map(|(j, s)| Component {
                source: engine_family(&s.engine).into(),
                percentile: percentile(&simulated[j], simulated[j][k]),
            })
            .collect();
        let simulation_percentile =
            components.iter().map(|c| c.percentile).sum::<f64>() / source_count as f64;
        p.meta = Some(Meta {
            method: METHOD,
            rank: 0,
            cohort: n,
            score: (real_percentile + simulation_percentile) / 2.0,
            real_percentile,
            simulation_percentile,
            components,
            // Confidence can already use real-game residuals. Do not use it to select
            // the cohort or alter weights and then claim independent validation.
            flagged: p.simulations.iter().any(|s| s.rating.confidence != "ok"),
        });
    }
    let scores: Vec<f64> = eligible
        .iter()
        .map(|&i| rows[i].meta.as_ref().unwrap().score)
        .collect();
    for &i in &eligible {
        let meta = rows[i].meta.as_mut().unwrap();
        meta.rank = 1 + scores.iter().filter(|s| **s > meta.score + 1e-9).count();
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ties_share_the_midrank_and_scale_endpoints() {
        let values = [1., 2., 2., 3.];
        assert_eq!(percentile(&values, 1.), 0.);
        assert_eq!(percentile(&values, 2.), 50.);
        assert_eq!(percentile(&values, 3.), 100.);
    }
}
