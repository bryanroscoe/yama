//! Fitted strength for a shared field (tournaments): who wins a pod, given who sat in it.
//!
//! Win shares mislead in an uneven field: 30% against weak tables and 30% against strong ones
//! are different results. This fits the multiplayer Bradley–Terry (Luce choice) model: in a pod
//! S, deck i wins with probability s_i / Σ_{j∈S} s_j. Strength 1 is the field's geometric mean,
//! the same scale the imported precon-ratings runs use. Each deck also plays one pseudo-game
//! against a virtual deck of strength 1 and wins half of it, a weak prior that keeps a deck with
//! no wins (or no losses) finite. Games without a winner tell this model nothing.
//!
//! The interval is a normal interval on log strength from the observed information (the
//! likelihood's curvature), for the deck's log strength minus the field's mean: closed form, so
//! it can refresh with the summary every 25 games. It treats games as independent; the seat
//! rotations of one quartet share decks, so it is somewhat narrow when rotations are few.
use serde::{Deserialize, Serialize};

const ITERATIONS: usize = 1_000;
const TOLERANCE: f64 = 1e-8;
/// The normal quantile for the 90% level the lab reports.
const Z90: f64 = 1.644_853_626_951_472_2;

/// One scored pod: the decks in it (indexes into the field) and the winner.
#[derive(Debug, Clone, PartialEq)]
pub struct Pod {
    pub decks: Vec<usize>,
    pub winner: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Strength {
    /// 1 = the field's geometric mean.
    pub strength: f64,
    /// 90% interval.
    pub lo: f64,
    pub hi: f64,
}

/// Strengths for decks 0..n, or `None` for a deck that sat in no scored pod.
pub fn fit(n: usize, pods: &[Pod]) -> Vec<Option<Strength>> {
    let mut played = vec![false; n];
    let mut wins = vec![0.5f64; n];
    for p in pods {
        for &d in &p.decks {
            played[d] = true;
        }
        wins[p.winner] += 1.0;
    }
    if !played.iter().any(|x| *x) {
        return vec![None; n];
    }
    // Minorize–maximize (Hunter 2004): s_i ← W_i / Σ_g [i∈g] / Σ_{j∈g} s_j, with the pseudo-game.
    let mut s = vec![1.0f64; n];
    for _ in 0..ITERATIONS {
        let mut denom: Vec<f64> = s.iter().map(|x| 1.0 / (x + 1.0)).collect();
        for p in pods {
            let total: f64 = p.decks.iter().map(|&d| s[d]).sum();
            for &d in &p.decks {
                denom[d] += 1.0 / total;
            }
        }
        let mut change = 0.0f64;
        for i in 0..n {
            let next = wins[i] / denom[i];
            change = change.max((next.ln() - s[i].ln()).abs());
            s[i] = next;
        }
        if change < TOLERANCE {
            break;
        }
    }
    // Observed information on θ = ln s: Σ_pods (diag(p) − p pᵀ) over the pod, plus each pseudo-game.
    let mut info = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        let p = s[i] / (s[i] + 1.0);
        info[i][i] += p * (1.0 - p);
    }
    for pod in pods {
        let total: f64 = pod.decks.iter().map(|&d| s[d]).sum();
        for &a in &pod.decks {
            let pa = s[a] / total;
            info[a][a] += pa;
            for &b in &pod.decks {
                info[a][b] -= pa * s[b] / total;
            }
        }
    }
    let cov = invert(info);
    let included: Vec<usize> = (0..n).filter(|&i| played[i]).collect();
    let m = included.len() as f64;
    let mean_log = included.iter().map(|&i| s[i].ln()).sum::<f64>() / m;
    let all: f64 = included.iter().map(|&j| included.iter().map(|&k| cov[j][k]).sum::<f64>()).sum();
    (0..n)
        .map(|i| {
            if !played[i] {
                return None;
            }
            // Var(θ_i − mean θ) over the decks that played.
            let row: f64 = included.iter().map(|&j| cov[i][j]).sum();
            let var = (cov[i][i] - 2.0 * row / m + all / (m * m)).max(0.0);
            let centre = s[i].ln() - mean_log;
            let half = Z90 * var.sqrt();
            Some(Strength { strength: centre.exp(), lo: (centre - half).exp(), hi: (centre + half).exp() })
        })
        .collect()
}

/// Inverse of a symmetric positive-definite matrix by Cholesky factorisation.
fn invert(a: Vec<Vec<f64>>) -> Vec<Vec<f64>> {
    let n = a.len();
    let mut l = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for j in 0..=i {
            let mut sum = a[i][j];
            for k in 0..j {
                sum -= l[i][k] * l[j][k];
            }
            if i == j {
                l[i][i] = sum.max(1e-12).sqrt();
            } else {
                l[i][j] = sum / l[j][j];
            }
        }
    }
    // L⁻¹ by forward substitution, then A⁻¹ = L⁻ᵀ L⁻¹.
    let mut inv_l = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        inv_l[i][i] = 1.0 / l[i][i];
        for j in 0..i {
            let mut sum = 0.0;
            for k in j..i {
                sum -= l[i][k] * inv_l[k][j];
            }
            inv_l[i][j] = sum / l[i][i];
        }
    }
    let mut out = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for j in 0..=i {
            let v: f64 = (i..n).map(|k| inv_l[k][i] * inv_l[k][j]).sum();
            out[i][j] = v;
            out[j][i] = v;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic pseudo-random stream (xorshift), so the test needs no extra crate.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 >> 11) as f64 / (1u64 << 53) as f64
        }
    }

    #[test]
    fn invert_recovers_the_identity() {
        let a = vec![vec![4.0, 1.0, 0.5], vec![1.0, 3.0, 0.2], vec![0.5, 0.2, 2.0]];
        let inv = invert(a.clone());
        for i in 0..3 {
            for j in 0..3 {
                let v: f64 = (0..3).map(|k| a[i][k] * inv[k][j]).sum();
                assert!((v - if i == j { 1.0 } else { 0.0 }).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn recovers_known_strengths_in_an_uneven_field() {
        // Eight decks of known strength; pods drawn unevenly so raw win shares mislead.
        let truth = [4.0, 2.0, 2.0, 1.0, 1.0, 0.5, 0.5, 0.25];
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let mut pods = Vec::new();
        for g in 0..6000 {
            // Deck 0 meets the strong half more often.
            let mut decks: Vec<usize> = if g % 3 == 0 { vec![0, 1, 2, 3] } else { (0..4).map(|k| (g + k * 3) % 8).collect() };
            decks.sort();
            decks.dedup();
            let total: f64 = decks.iter().map(|&d| truth[d]).sum();
            let mut pick = rng.next() * total;
            let mut winner = decks[0];
            for &d in &decks {
                pick -= truth[d];
                if pick <= 0.0 {
                    winner = d;
                    break;
                }
            }
            pods.push(Pod { decks, winner });
        }
        let fit = fit(8, &pods);
        let geo = truth.iter().map(|x: &f64| x.ln()).sum::<f64>() / 8.0;
        for (i, f) in fit.iter().enumerate() {
            let f = f.unwrap();
            let want = (truth[i].ln() - geo).exp();
            assert!((f.strength.ln() - want.ln()).abs() < 0.15, "deck {i}: {} vs {want}", f.strength);
            assert!(f.lo < f.strength && f.strength < f.hi);
        }
        let mean: f64 = fit.iter().map(|f| f.unwrap().strength.ln()).sum::<f64>() / 8.0;
        assert!(mean.abs() < 1e-9, "the field's geometric mean is 1");
    }

    #[test]
    fn a_deck_that_never_wins_stays_finite_and_unplayed_decks_are_none() {
        let pods: Vec<Pod> = (0..40).map(|g| Pod { decks: vec![0, 1, 2], winner: g % 2 }).collect();
        let fit = fit(4, &pods);
        let never = fit[2].unwrap();
        assert!(never.strength > 0.0 && never.strength < fit[0].unwrap().strength);
        assert!(never.hi.is_finite());
        assert!(fit[3].is_none());
        assert!(super::fit(2, &[]).iter().all(Option::is_none));
    }

    #[test]
    fn more_games_narrow_the_interval() {
        let pods = |k: usize| -> Vec<Pod> { (0..k).map(|g| Pod { decks: vec![0, 1, 2, 3], winner: [0, 0, 1, 2, 3][g % 5] }).collect() };
        let small = fit(4, &pods(50))[0].unwrap();
        let large = fit(4, &pods(2000))[0].unwrap();
        assert!(large.hi / large.lo < small.hi / small.lo);
        assert!(large.strength > 1.0);
    }
}
