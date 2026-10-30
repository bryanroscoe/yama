//! How much does a simulation tell us about real tables? A time-split test (ARCHITECTURE.md,
//! "Precon evidence from datasets").
//!
//! Freeze what was known at a split date: each precon's real-game rate from the snapshots up to
//! then, and each simulation source's strengths. Then predict the rate each precon showed on the
//! games played after the split, which nothing at the split had seen. Four predictors are scored
//! on the same precons: real games alone, the simulation alone (its log strength mapped to a rate
//! by a regression fitted on pre-split data only), the current meta rank's even split of
//! percentiles (ranks only), and the candidate rating v2, which weights the real rate and the
//! mapped simulation by their precision. The gate: v2 ships only if it beats real games alone
//! on the held-out games with a bootstrap interval clear of zero.
use serde::Serialize;

/// Fewest held-out games a precon needs to be a test case.
pub const MIN_HOLDOUT_GAMES: u64 = 20;
/// Fewest test cases before any score is reported.
pub const MIN_CASES: usize = 8;
const BOOTSTRAP: usize = 1000;
/// Floor on the simulation's own error variance, in squared points, so a lucky fit never
/// claims a perfect simulation.
const MIN_SIM_VARIANCE: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Real {
    /// Percent.
    pub rate: f64,
    /// Games behind it, after recency weighting.
    pub effective_games: f64,
}
impl Real {
    /// Sampling variance of the rate in squared points.
    /// Sampling variance in squared points, with one pseudo-win and one pseudo-loss so a 0% or
    /// 100% rate on few games is never treated as exact. The source's rates are normalised, so
    /// this is a plug-in approximation, not measured precision.
    pub fn variance(&self) -> f64 {
        let n = self.effective_games.max(1.0);
        let p = (self.rate / 100.0 * n + 1.0) / (n + 2.0);
        1e4 * p * (1.0 - p) / n
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Case {
    pub precon: String,
    /// What the snapshots up to the split said.
    pub train: Option<Real>,
    /// Implied rate on the games after the split, and how many.
    pub holdout: Option<(f64, u64)>,
    /// The simulation's strength (1 = its field's geometric mean).
    pub sim: Option<f64>,
}

/// The simulation's log strength mapped to a real rate: rate ≈ intercept + slope · ln(strength).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Mapping {
    pub intercept: f64,
    pub slope: f64,
    /// The simulation's own error in squared points, after the real rates' sampling noise.
    pub sim_variance: f64,
    pub precons: usize,
}
impl Mapping {
    pub fn rate(&self, strength: f64) -> f64 {
        (self.intercept + self.slope * strength.ln()).clamp(0.0, 100.0)
    }
}

/// Real rate and mapped simulation, weighted by precision; the variance of the result.
pub fn combine(real: Option<Real>, sim: Option<f64>, m: Option<&Mapping>) -> Option<(f64, f64)> {
    let sim = sim.zip(m).map(|(s, m)| (m.rate(s), m.sim_variance));
    match (real, sim) {
        (Some(r), Some((s, vs))) => {
            let (wr, ws) = (1.0 / r.variance(), 1.0 / vs);
            Some(((wr * r.rate + ws * s) / (wr + ws), 1.0 / (wr + ws)))
        }
        (Some(r), None) => Some((r.rate, r.variance())),
        (None, Some((s, vs))) => Some((s, vs)),
        (None, None) => None,
    }
}

/// Weighted least squares of real rate on log strength, over precons with both.
pub fn mapping(cases: &[Case]) -> Option<Mapping> {
    let pts: Vec<(f64, f64, f64, f64)> = cases
        .iter()
        .filter_map(|c| {
            let (r, s) = (c.train?, c.sim?);
            (s > 0.0).then(|| (s.ln(), r.rate, 1.0 / (r.variance() + MIN_SIM_VARIANCE), r.variance()))
        })
        .collect();
    if pts.len() < MIN_CASES {
        return None;
    }
    let w: f64 = pts.iter().map(|p| p.2).sum();
    let mx = pts.iter().map(|p| p.0 * p.2).sum::<f64>() / w;
    let my = pts.iter().map(|p| p.1 * p.2).sum::<f64>() / w;
    let sxx: f64 = pts.iter().map(|p| p.2 * (p.0 - mx).powi(2)).sum();
    if sxx <= 0.0 {
        return None;
    }
    let slope = pts.iter().map(|p| p.2 * (p.0 - mx) * (p.1 - my)).sum::<f64>() / sxx;
    let intercept = my - slope * mx;
    // Residual spread beyond what the real rates' own sampling noise explains.
    let n = pts.len() as f64;
    let residual = pts.iter().map(|p| (p.1 - intercept - slope * p.0).powi(2)).sum::<f64>() / (n - 2.0).max(1.0);
    let noise = pts.iter().map(|p| p.3).sum::<f64>() / n;
    Some(Mapping {
        intercept,
        slope,
        sim_variance: (residual - noise).max(MIN_SIM_VARIANCE),
        precons: pts.len(),
    })
}

/// Average ranks (ties share the mean rank).
fn ranks(xs: &[f64]) -> Vec<f64> {
    let mut idx: Vec<usize> = (0..xs.len()).collect();
    idx.sort_by(|&a, &b| xs[a].total_cmp(&xs[b]));
    let mut out = vec![0.0; xs.len()];
    let mut i = 0;
    while i < idx.len() {
        let mut j = i + 1;
        while j < idx.len() && xs[idx[j]] == xs[idx[i]] {
            j += 1;
        }
        let r = (i + j - 1) as f64 / 2.0;
        for &k in &idx[i..j] {
            out[k] = r;
        }
        i = j;
    }
    out
}

pub fn spearman(a: &[f64], b: &[f64]) -> Option<f64> {
    if a.len() < 3 {
        return None;
    }
    let (ra, rb) = (ranks(a), ranks(b));
    let n = a.len() as f64;
    let (ma, mb) = (ra.iter().sum::<f64>() / n, rb.iter().sum::<f64>() / n);
    let cov: f64 = ra.iter().zip(&rb).map(|(x, y)| (x - ma) * (y - mb)).sum();
    let va: f64 = ra.iter().map(|x| (x - ma).powi(2)).sum();
    let vb: f64 = rb.iter().map(|y| (y - mb).powi(2)).sum();
    (va > 0.0 && vb > 0.0).then(|| cov / (va * vb).sqrt())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Score {
    pub predictor: &'static str,
    pub spearman: Option<f64>,
    /// 90% bootstrap interval over precons.
    pub spearman_ci: Option<[f64; 2]>,
    /// Held-out error, weighted by held-out games, in squared points; ranks-only predictors have none.
    pub mse: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Evaluation {
    /// Precons with a pre-split real rate, a simulated strength and enough held-out games.
    pub cases: usize,
    pub held_out_games: u64,
    pub mapping: Option<Mapping>,
    pub scores: Vec<Score>,
    /// v2's held-out error minus real-only's, with its 90% bootstrap interval; negative is better.
    pub v2_minus_real: Option<(f64, [f64; 2])>,
    pub gate_passed: bool,
    pub verdict: String,
}

/// A deterministic pseudo-random stream (xorshift), so reports reproduce exactly.
struct Rng(u64);
impl Rng {
    fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n as u64) as usize
    }
}

fn mse(pred: &[f64], y: &[f64], w: &[f64]) -> f64 {
    let total: f64 = w.iter().sum();
    pred.iter().zip(y).zip(w).map(|((p, y), w)| w * (p - y).powi(2)).sum::<f64>() / total
}

fn percentile(xs: &mut [f64], q: f64) -> f64 {
    xs.sort_by(f64::total_cmp);
    xs[((xs.len() - 1) as f64 * q).round() as usize]
}

/// Score every predictor on the precons that have all three pieces.
pub fn evaluate(all: &[Case]) -> Evaluation {
    let mapping = mapping(all);
    let cases: Vec<&Case> = all
        .iter()
        .filter(|c| c.train.is_some() && c.sim.is_some() && c.holdout.is_some_and(|h| h.1 >= MIN_HOLDOUT_GAMES))
        .collect();
    let held_out_games = cases.iter().map(|c| c.holdout.unwrap().1).sum();
    let empty = |verdict: String| Evaluation {
        cases: cases.len(),
        held_out_games,
        mapping,
        scores: vec![],
        v2_minus_real: None,
        gate_passed: false,
        verdict,
    };
    let Some(m) = mapping else {
        return empty(format!(
            "Too few precons have both a real rate and a simulated strength to map one onto the other (needs {MIN_CASES})."
        ));
    };
    if cases.len() < MIN_CASES {
        return empty(format!(
            "Only {} precons have held-out games after the split; the test needs {MIN_CASES}.",
            cases.len()
        ));
    }
    let y: Vec<f64> = cases.iter().map(|c| c.holdout.unwrap().0).collect();
    let w: Vec<f64> = cases.iter().map(|c| c.holdout.unwrap().1 as f64).collect();
    let real: Vec<f64> = cases.iter().map(|c| c.train.unwrap().rate).collect();
    let sim: Vec<f64> = cases.iter().map(|c| m.rate(c.sim.unwrap())).collect();
    let v2: Vec<f64> = cases.iter().map(|c| combine(c.train, c.sim, Some(&m)).unwrap().0).collect();
    // The meta rank's even split of percentiles, as ranks.
    // The meta rank ranks raw strength, whatever direction the mapping fits.
    let raw: Vec<f64> = cases.iter().map(|c| c.sim.unwrap()).collect();
    let (rr, rs) = (ranks(&real), ranks(&raw));
    let v1: Vec<f64> = rr.iter().zip(&rs).map(|(a, b)| a + b).collect();
    let preds: [(&'static str, &Vec<f64>, bool); 4] = [
        ("real games only", &real, true),
        ("simulation only", &sim, true),
        ("meta rank v1 (even split)", &v1, false),
        ("rating v2 candidate", &v2, true),
    ];

    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let n = cases.len();
    let mut boot_rho: Vec<Vec<f64>> = vec![Vec::with_capacity(BOOTSTRAP); 4];
    let mut boot_diff = Vec::with_capacity(BOOTSTRAP);
    for _ in 0..BOOTSTRAP {
        let pick: Vec<usize> = (0..n).map(|_| rng.below(n)).collect();
        let sub = |v: &Vec<f64>| pick.iter().map(|&i| v[i]).collect::<Vec<f64>>();
        let (ys, ws) = (sub(&y), sub(&w));
        // Refit the mapping on the resample, so the interval carries the mapping's own uncertainty.
        let resampled: Vec<Case> = pick.iter().map(|&i| cases[i].clone()).collect();
        let Some(mb) = crate::precon_evidence::calibration::mapping(&resampled) else {
            continue;
        };
        let v2b: Vec<f64> = resampled.iter().map(|c| combine(c.train, c.sim, Some(&mb)).unwrap().0).collect();
        for (k, (_, p, _)) in preds.iter().enumerate() {
            let p = if k == 3 { v2b.clone() } else { sub(p) };
            if let Some(r) = spearman(&p, &ys) {
                boot_rho[k].push(r);
            }
        }
        boot_diff.push(mse(&v2b, &ys, &ws) - mse(&sub(&real), &ys, &ws));
    }
    if boot_diff.len() < BOOTSTRAP / 2 {
        return empty(format!(
            "Too few resamples could refit the mapping ({} of {BOOTSTRAP}); the test needs more precons with all three pieces.",
            boot_diff.len()
        ));
    }
    let scores = preds
        .iter()
        .zip(boot_rho.iter_mut())
        .map(|((name, p, rates), boot)| Score {
            predictor: name,
            spearman: spearman(p, &y),
            spearman_ci: (boot.len() > 10).then(|| [percentile(boot, 0.05), percentile(boot, 0.95)]),
            mse: rates.then(|| mse(p, &y, &w)),
        })
        .collect();
    let diff = mse(&v2, &y, &w) - mse(&real, &y, &w);
    let ci = [percentile(&mut boot_diff, 0.05), percentile(&mut boot_diff, 0.95)];
    let gate_passed = ci[1] < 0.0;
    let verdict = if gate_passed {
        format!(
            "Rating v2 predicted the held-out games better than real games alone (error {diff:+.2} squared points, 90% interval {:+.2} to {:+.2}).",
            ci[0], ci[1]
        )
    } else if ci[0] > 0.0 {
        format!(
            "Adding the simulation made predictions worse than real games alone (error {diff:+.2} squared points, 90% interval {:+.2} to {:+.2}).",
            ci[0], ci[1]
        )
    } else {
        format!(
            "Adding the simulation made no clear difference to real games alone (error {diff:+.2} squared points, 90% interval {:+.2} to {:+.2}).",
            ci[0], ci[1]
        )
    };
    Evaluation {
        cases: n,
        held_out_games,
        mapping: Some(m),
        scores,
        v2_minus_real: Some((diff, ci)),
        gate_passed,
        verdict,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(i: usize, truth: f64, noise: f64, sim: f64) -> Case {
        Case {
            precon: format!("p{i}"),
            train: Some(Real {
                rate: truth + noise,
                effective_games: 300.0,
            }),
            holdout: Some((truth - noise, 200)),
            sim: Some(sim),
        }
    }

    #[test]
    fn spearman_handles_ties_and_order() {
        assert_eq!(spearman(&[1., 2., 3.], &[10., 20., 30.]), Some(1.0));
        assert_eq!(spearman(&[1., 2., 3.], &[30., 20., 10.]), Some(-1.0));
        assert!(spearman(&[1., 1., 1.], &[1., 2., 3.]).is_none());
        assert!(spearman(&[1., 2.], &[1., 2.]).is_none());
    }

    #[test]
    fn combine_weights_by_precision() {
        let m = Mapping {
            intercept: 25.0,
            slope: 10.0,
            sim_variance: 4.0,
            precons: 10,
        };
        let real = Real {
            rate: 20.0,
            effective_games: 400.0,
        }; // variance 4
        let (rate, var) = combine(Some(real), Some(1.0), Some(&m)).unwrap();
        assert!((rate - 22.5).abs() < 0.02 && (var - 2.0).abs() < 0.01, "{rate} {var}");
        assert_eq!(combine(None, Some(1.0), Some(&m)), Some((25.0, 4.0)));
        let (alone, v) = combine(Some(real), None, None).unwrap();
        assert!(alone == 20.0 && (v - 4.0).abs() < 0.03);
        assert!(combine(None, None, None).is_none());
    }

    #[test]
    fn a_boundary_rate_on_few_games_is_not_exact() {
        let zero = Real {
            rate: 0.0,
            effective_games: 40.0,
        };
        // About 2.3 points of standard error, not ~0.
        assert!(zero.variance().sqrt() > 2.0, "{}", zero.variance());
        let full = Real {
            rate: 100.0,
            effective_games: 40.0,
        };
        assert!((full.variance() - zero.variance()).abs() < 1e-9);
    }

    #[test]
    fn meta_rank_v1_ranks_raw_strength_even_when_the_mapping_is_negative() {
        // Real rates and simulated strengths run in opposite directions: v1's even split ties every deck.
        let cases: Vec<Case> = (0..10)
            .map(|i| Case {
                precon: format!("p{i}"),
                train: Some(Real {
                    rate: 15.0 + i as f64,
                    effective_games: 300.0,
                }),
                holdout: Some((15.0 + i as f64, 200)),
                sim: Some(((9 - i) as f64 / 4.0).exp()),
            })
            .collect();
        let e = evaluate(&cases);
        let v1 = e.scores.iter().find(|s| s.predictor.starts_with("meta rank v1")).unwrap();
        assert!(v1.spearman.is_none(), "every deck ties, so there's no ranking: {:?}", v1.spearman);
    }

    #[test]
    fn an_informative_simulation_passes_and_noise_does_not() {
        // Pre-split real rates are noisy; a simulation that tracks the truth should help.
        let noise = [
            3.0, -3.0, 2.5, -2.5, 3.5, -3.5, 2.0, -2.0, 3.0, -3.0, 2.5, -2.5, 3.5, -3.5, 2.0, -2.0,
        ];
        let good: Vec<Case> = (0..16)
            .map(|i| {
                let truth = 15.0 + i as f64;
                case(i, truth, noise[i], ((truth - 25.0) / 8.0).exp())
            })
            .collect();
        let e = evaluate(&good);
        assert_eq!(e.cases, 16);
        assert!(e.gate_passed, "{}", e.verdict);
        // The held-out rates are noisy, but the simulation ranks them better than the noisy early rates do.
        assert!(e.scores[1].spearman.unwrap() > e.scores[0].spearman.unwrap(), "{:?}", e.scores);

        // Exact pre-split rates and a simulation unrelated to them: nothing for v2 to add.
        let scrambled = [7, 2, 13, 0, 9, 15, 4, 11, 1, 14, 6, 3, 12, 8, 5, 10];
        let bad: Vec<Case> = (0..16)
            .map(|i| {
                let truth = 15.0 + i as f64;
                Case {
                    precon: format!("p{i}"),
                    train: Some(Real {
                        rate: truth,
                        effective_games: 300.0,
                    }),
                    holdout: Some((truth + noise[i], 200)),
                    sim: Some(((scrambled[i] as f64 - 8.0) / 8.0).exp()),
                }
            })
            .collect();
        let e = evaluate(&bad);
        assert!(!e.gate_passed, "{}", e.verdict);
    }

    #[test]
    fn too_few_cases_say_so() {
        let few: Vec<Case> = (0..5).map(|i| case(i, 20.0 + i as f64, 1.0, 1.0 + i as f64)).collect();
        let e = evaluate(&few);
        assert!(!e.gate_passed && e.scores.is_empty());
        assert!(e.verdict.contains("Too few"));
    }
}
