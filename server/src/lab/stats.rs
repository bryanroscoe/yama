//! Summary maths for "Try a change": each list's win rate with a Wilson interval and its average
//! placement, and the paired difference between the base list and the changed list, which played
//! the same pods (same opponents in the same seats, same shuffles).
//!
//! Scoring follows commander-decks scripts/sim/analyze.py, so a number here means what it means
//! in a batch run:
//! - Wins count for the tested seat only. Placement is the seat's finishing place, with tied
//!   players sharing the mean of their places (1 = first).
//! - A game that ended by a win, a draw, the turn cap or the action cap is scored. At a cap or a
//!   draw nobody won, and everyone still in shares the top places.
//! - A game that ran out of CPU time (time_cap) isn't scored: where it runs out depends on the
//!   machine. A panic or an error isn't scored either. Both are reported as unscored.
//!
//! The paired difference uses only the pods where both lists finished a scored game. Its interval
//! is the Agresti-Min interval for matched pairs ([`matched_difference`]), not a bootstrap: it is
//! closed-form, so the same results always give the same interval with no random resampling,
//! and it stays sensible when few pods differ (a plain normal interval collapses to zero width
//! when no pod differs). A pod is a matched pair with four outcomes (both won, only the changed
//! list won, only the base won, neither won); the method adds half a pod to each outcome and
//! takes the normal interval of the difference. analyze.py's percentile bootstrap over templates
//! agrees with it to within about a point at these sizes (see the tests).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use yama_play::lab::{End, GameResult, GameSpec};

/// Interval level for every interval here.
pub const LEVEL: f64 = 0.90;
/// Two-sided standard normal quantile for [`LEVEL`].
pub const Z: f64 = 1.644_853_626_951_472_2;
/// Pods with both games scored before a verdict says more than "can't tell yet".
pub const MIN_PODS: u32 = 10;
/// Deck ids of the two lists in an experiment's game specs.
pub const BASE_ID: &str = "base";
pub const VARIANT_ID: &str = "variant";

pub const METHOD: &str = "Wins count for the tested seat only. The difference compares the two lists on the same pods \
(same opponents, seats and shuffles), using only pods where both games were scored: the share of pods the changed list \
won minus the share the base list won. Its 90% interval is the Agresti-Min interval for matched pairs (half a pod added \
to each of the four outcomes, then a normal interval), so the same results always give the same interval. Win rates \
carry Wilson 90% intervals. Games that ran out of CPU time, crashed or failed aren't scored; games that reached the turn \
or action cap count as games nobody won, as in the batch analysis.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Base,
    Variant,
}

/// One scheduled game of an experiment as the summary sees it.
#[derive(Debug, Clone)]
pub struct Outcome {
    /// The pod (template) the game belongs to; a pod's base and variant games share it.
    pub pod: usize,
    pub side: Side,
    /// The tested list's seat.
    pub seat: u8,
    /// `None` until the game is played.
    pub result: Option<GameResult>,
}

impl Outcome {
    /// From a stored game row: its play order (pod = ord / 2), schedule line and result line.
    /// `None` for a row that isn't a game of either list (never written by this server).
    pub fn from_row(ord: i64, spec: &str, result: Option<&str>) -> Option<Outcome> {
        let spec: GameSpec = serde_json::from_str(spec).ok()?;
        let (seat, side) = spec.decks.iter().enumerate().find_map(|(i, d)| match d.as_str() {
            BASE_ID => Some((i, Side::Base)),
            VARIANT_ID => Some((i, Side::Variant)),
            _ => None,
        })?;
        // An unreadable result line counts as an error, never as pending (it would replay forever).
        let result = result.map(|r| {
            serde_json::from_str::<GameResult>(r).unwrap_or_else(|e| {
                let mut g = GameResult::new(&spec, "unknown");
                g.error = Some(format!("unreadable result line: {e}"));
                g
            })
        });
        Some(Outcome { pod: usize::try_from(ord / 2).ok()?, side, seat: seat as u8, result })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Score {
    Pending,
    Unscored,
    Played { win: bool, place: f64 },
}

fn score(o: &Outcome) -> Score {
    let Some(r) = &o.result else { return Score::Pending };
    match r.end {
        End::Win | End::Draw | End::TurnCap | End::ActionCap => match placement_ranks(&r.placements).get(&o.seat) {
            Some(place) => Score::Played { win: r.winner == Some(o.seat), place: *place },
            None => Score::Unscored, // a scored end without the seat placed: malformed, not scored
        },
        End::TimeCap | End::Panic | End::Error => Score::Unscored,
    }
}

/// Seat -> average finishing place (1 = best); a tied group shares the mean of its places.
pub fn placement_ranks(groups: &[Vec<u8>]) -> HashMap<u8, f64> {
    let mut out = HashMap::new();
    let mut pos = 1.0;
    for g in groups {
        let mean = pos + (g.len() as f64 - 1.0) / 2.0;
        for s in g {
            out.insert(*s, mean);
        }
        pos += g.len() as f64;
    }
    out
}

/// Wilson score interval for k successes in n trials at [`LEVEL`].
pub fn wilson(k: u32, n: u32) -> Option<[f64; 2]> {
    if n == 0 {
        return None;
    }
    let (k, n) = (f64::from(k), f64::from(n));
    let p = k / n;
    let z2 = Z * Z;
    let den = 1.0 + z2 / n;
    let centre = (p + z2 / (2.0 * n)) / den;
    let half = Z * (p * (1.0 - p) / n + z2 / (4.0 * n * n)).sqrt() / den;
    Some([(centre - half).max(0.0), (centre + half).min(1.0)])
}

/// Difference of matched proportions with the Agresti-Min interval at [`LEVEL`]: `b` pods only the
/// changed list won, `c` pods only the base won, `n` pods in all. Returns (b - c) / n and its
/// interval: half a pod is added to each of the four cells (n + 2 pods), then the Wald interval for
/// the difference, clamped to [-1, 1]. Agresti and Min, "Simple improved confidence intervals for
/// comparing matched proportions", Statistics in Medicine 24 (2005).
pub fn matched_difference(b: u32, c: u32, n: u32) -> Option<(f64, [f64; 2])> {
    if n == 0 || b + c > n {
        return None;
    }
    let d = (f64::from(b) - f64::from(c)) / f64::from(n);
    let (b1, c1, n1) = (f64::from(b) + 0.5, f64::from(c) + 0.5, f64::from(n) + 2.0);
    let d1 = (b1 - c1) / n1;
    let se = ((b1 + c1) - (b1 - c1).powi(2) / n1).max(0.0).sqrt() / n1;
    Some((d, [(d1 - Z * se).max(-1.0), (d1 + Z * se).min(1.0)]))
}

/// Mean and normal interval of paired differences (for placement, where the values aren't 0/1).
fn mean_interval(xs: &[f64]) -> Option<(f64, Option<[f64; 2]>)> {
    if xs.is_empty() {
        return None;
    }
    let n = xs.len() as f64;
    let mean = xs.iter().sum::<f64>() / n;
    if xs.len() < 2 {
        return Some((mean, None));
    }
    let var = xs.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (n - 1.0);
    let half = Z * (var / n).sqrt();
    Some((mean, Some([mean - half, mean + half])))
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ListStats {
    /// Games that finished with a scored end (win, draw, turn cap, action cap).
    pub games: u32,
    pub wins: u32,
    pub win_rate: Option<f64>,
    /// Wilson interval on the win rate.
    pub wilson: Option<[f64; 2]>,
    /// Mean finishing place (1 = first; tied players share the mean of their places).
    pub avg_place: Option<f64>,
    /// Every finished game by how it ended, scored or not.
    pub ends: BTreeMap<String, u32>,
    /// Games not played yet.
    pub pending: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Paired {
    /// Pods where both lists finished a scored game; the difference uses these only.
    pub pods: u32,
    pub both_won: u32,
    pub variant_only: u32,
    pub base_only: u32,
    pub neither: u32,
    /// The changed list's win rate minus the base's over those pods (-1 to 1).
    pub delta_win_rate: Option<f64>,
    pub delta_ci: Option<[f64; 2]>,
    /// The changed list's average place minus the base's (negative: it finishes higher).
    pub delta_avg_place: Option<f64>,
    pub delta_avg_place_ci: Option<[f64; 2]>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Unscored {
    pub time_cap: u32,
    pub panic: u32,
    pub error: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NoWinner {
    pub draw: u32,
    pub turn_cap: u32,
    pub action_cap: u32,
    pub total: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictKind {
    Better,
    Worse,
    Unclear,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Verdict {
    pub kind: VerdictKind,
    /// e.g. "Probably better (+4 points, 90% interval +1 to +7)".
    pub text: String,
    /// False while games are still to come (the verdict is about the games so far).
    #[serde(rename = "final")]
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Summary {
    pub level: f64,
    /// Pods scheduled (each is played once by each list).
    pub pods: u32,
    pub base: ListStats,
    pub variant: ListStats,
    pub paired: Paired,
    /// Games left out of every number: out of CPU time, panics, errors.
    pub unscored: Unscored,
    /// Scored games nobody won: draws and caps.
    pub no_winner: NoWinner,
    pub verdict: Verdict,
    pub method: String,
}

/// "+4", "−3" (U+2212 minus) or "0": a difference in whole percentage points.
pub fn points(x: f64) -> String {
    let p = (x * 100.0).round() as i64;
    match p {
        0 => "0".into(),
        p if p > 0 => format!("+{p}"),
        p => format!("\u{2212}{}", -p),
    }
}

fn points_word(x: f64) -> String {
    let n = (x * 100.0).round().abs() as i64;
    format!("{} {}", points(x), if n == 1 { "point" } else { "points" })
}

/// The plain-language verdict on a paired difference and its interval.
pub fn verdict(paired: &Paired, is_final: bool) -> Verdict {
    let level = format!("{:.0}%", LEVEL * 100.0);
    let unclear = Verdict { kind: VerdictKind::Unclear, text: "Can't tell yet: run more games".into(), is_final };
    let (Some(d), Some([lo, hi])) = (paired.delta_win_rate, paired.delta_ci) else { return unclear };
    if paired.pods < MIN_PODS {
        return unclear;
    }
    let detail = format!("{}, {level} interval {} to {}", points_word(d), points(lo), points(hi));
    if lo > 0.0 {
        Verdict { kind: VerdictKind::Better, text: format!("Probably better ({detail})"), is_final }
    } else if hi < 0.0 {
        Verdict { kind: VerdictKind::Worse, text: format!("Probably worse ({detail})"), is_final }
    } else {
        unclear
    }
}

/// The experiment's summary from its games so far. `is_final` marks a finished experiment.
pub fn summarize(outcomes: &[Outcome], is_final: bool) -> Summary {
    let mut lists: HashMap<Side, ListStats> = HashMap::from([(Side::Base, ListStats::default()), (Side::Variant, ListStats::default())]);
    let mut place_sum: HashMap<Side, f64> = HashMap::new();
    let mut pods: BTreeMap<usize, [Option<Score>; 2]> = BTreeMap::new();
    let mut unscored = Unscored::default();
    let mut no_winner = NoWinner::default();
    for o in outcomes {
        let s = score(o);
        let l = lists.get_mut(&o.side).expect("both sides present");
        match s {
            Score::Pending => l.pending += 1,
            Score::Unscored => {}
            Score::Played { win, place } => {
                l.games += 1;
                l.wins += u32::from(win);
                *place_sum.entry(o.side).or_default() += place;
            }
        }
        if let Some(r) = &o.result {
            *l.ends.entry(r.end.as_str().to_string()).or_default() += 1;
            match (s, r.end) {
                (Score::Unscored, End::TimeCap) => unscored.time_cap += 1,
                (Score::Unscored, End::Panic) => unscored.panic += 1,
                (Score::Unscored, _) => unscored.error += 1,
                (_, End::Draw) => no_winner.draw += 1,
                (_, End::TurnCap) => no_winner.turn_cap += 1,
                (_, End::ActionCap) => no_winner.action_cap += 1,
                _ => {}
            }
        }
        let slot = &mut pods.entry(o.pod).or_default()[usize::from(o.side == Side::Variant)];
        *slot = Some(s);
    }
    unscored.total = unscored.time_cap + unscored.panic + unscored.error;
    no_winner.total = no_winner.draw + no_winner.turn_cap + no_winner.action_cap;
    for (side, l) in lists.iter_mut() {
        if l.games > 0 {
            l.win_rate = Some(f64::from(l.wins) / f64::from(l.games));
            l.wilson = wilson(l.wins, l.games);
            l.avg_place = place_sum.get(side).map(|s| s / f64::from(l.games));
        }
    }

    let mut paired = Paired::default();
    let mut place_diffs = Vec::new();
    for slots in pods.values() {
        let [Some(Score::Played { win: bw, place: bp }), Some(Score::Played { win: vw, place: vp })] = *slots else { continue };
        paired.pods += 1;
        match (bw, vw) {
            (true, true) => paired.both_won += 1,
            (false, true) => paired.variant_only += 1,
            (true, false) => paired.base_only += 1,
            (false, false) => paired.neither += 1,
        }
        place_diffs.push(vp - bp);
    }
    if let Some((d, ci)) = matched_difference(paired.variant_only, paired.base_only, paired.pods) {
        paired.delta_win_rate = Some(d);
        paired.delta_ci = Some(ci);
    }
    if let Some((d, ci)) = mean_interval(&place_diffs) {
        paired.delta_avg_place = Some(d);
        paired.delta_avg_place_ci = ci;
    }
    let verdict = verdict(&paired, is_final);
    Summary {
        level: LEVEL,
        pods: pods.len() as u32,
        base: lists.remove(&Side::Base).unwrap_or_default(),
        variant: lists.remove(&Side::Variant).unwrap_or_default(),
        paired,
        unscored,
        no_winner,
        verdict,
        method: METHOD.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yama_play::lab::GameSpec;

    fn spec(decks: &[&str]) -> GameSpec {
        GameSpec {
            game: "g".into(),
            seed: 1,
            decks: decks.iter().map(|d| d.to_string()).collect(),
            difficulty: "Easy".into(),
            max_turns: 120,
            max_actions: 200_000,
            max_seconds: 600,
        }
    }

    /// A finished 4-player game: `winner` wins, everyone else is tied behind (as at the end of a
    /// game where the rest were knocked out by the same blow), or at a cap all share first.
    fn result(end: End, winner: Option<u8>) -> GameResult {
        let mut r = GameResult::new(&spec(&["a", "b", "c", "d"]), "eb309108eb0df708");
        r.end = end;
        r.winner = winner;
        r.placements = match (end, winner) {
            (End::Win, Some(w)) => vec![vec![w], (0..4).filter(|s| *s != w).collect()],
            (End::Draw | End::TurnCap | End::ActionCap, _) => vec![vec![0, 1, 2, 3]],
            _ => vec![],
        };
        r
    }

    fn game(pod: usize, side: Side, seat: u8, r: Option<GameResult>) -> Outcome {
        Outcome { pod, side, seat, result: r }
    }

    /// `n` pods with given counts of (base won, variant won) outcomes; the rest neither won.
    fn pods(both: usize, variant_only: usize, base_only: usize, neither: usize) -> Vec<Outcome> {
        let mut out = Vec::new();
        let kinds = [(true, true)].repeat(both).into_iter().chain([(false, true)].repeat(variant_only)).chain([(true, false)].repeat(base_only)).chain([(false, false)].repeat(neither));
        for (t, (bw, vw)) in kinds.enumerate() {
            let seat = (t % 4) as u8;
            let other = (seat + 1) % 4;
            out.push(game(t, Side::Base, seat, Some(result(End::Win, Some(if bw { seat } else { other })))));
            out.push(game(t, Side::Variant, seat, Some(result(End::Win, Some(if vw { seat } else { other })))));
        }
        out
    }

    #[test]
    fn wilson_matches_the_python_analysis() {
        // commander-decks scripts/sim/common.py wilson(5, 10, 0.90) and wilson(0, 20, 0.90).
        let [lo, hi] = wilson(5, 10).unwrap();
        assert!((lo - 0.269_27).abs() < 1e-4 && (hi - 0.730_73).abs() < 1e-4, "{lo} {hi}");
        let [lo, hi] = wilson(0, 20).unwrap();
        assert_eq!(lo, 0.0);
        assert!((hi - 0.1191).abs() < 1e-4, "{hi}");
        assert_eq!(wilson(0, 0), None);
    }

    #[test]
    fn tied_players_share_their_places() {
        let r = placement_ranks(&[vec![2], vec![0, 3], vec![1]]);
        assert_eq!((r[&2], r[&0], r[&3], r[&1]), (1.0, 2.5, 2.5, 4.0));
    }

    #[test]
    fn matched_difference_by_hand() {
        // 100 pods: 14 only the changed list won, 6 only the base won.
        let (d, [lo, hi]) = matched_difference(14, 6, 100).unwrap();
        assert!((d - 0.08).abs() < 1e-12);
        // b' = 14.5, c' = 6.5, n' = 102: d' = 8/102, se = sqrt(21 - 64/102) / 102.
        let d1 = 8.0 / 102.0;
        let se = (21.0f64 - 64.0 / 102.0).sqrt() / 102.0;
        assert!((lo - (d1 - Z * se)).abs() < 1e-12 && (hi - (d1 + Z * se)).abs() < 1e-12);
        assert!(lo > 0.0, "{lo}");
        // No pod differs: the interval still has width, centred on 0.
        let (d, [lo, hi]) = matched_difference(0, 0, 50).unwrap();
        assert_eq!(d, 0.0);
        assert!(lo < -0.01 && hi > 0.01 && (lo + hi).abs() < 1e-12);
        assert_eq!(matched_difference(0, 0, 0), None);
        assert_eq!(matched_difference(3, 3, 5), None);
    }

    /// The closed-form interval against analyze.py's method (percentile bootstrap over pods, 2000
    /// draws) on the same pods: within about a point at the sizes experiments use.
    #[test]
    fn agrees_with_a_bootstrap_over_pods() {
        let mut state = 0x1234_5678_u64;
        let mut next = move || {
            state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = state;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        };
        for (b, c, n) in [(14u32, 6u32, 100u32), (30, 22, 200), (9, 13, 50), (60, 40, 400)] {
            let diffs: Vec<f64> = (0..n).map(|i| if i < b { 1.0 } else if i < b + c { -1.0 } else { 0.0 }).collect();
            let mut means: Vec<f64> = (0..2000)
                .map(|_| (0..n).map(|_| diffs[(next() % u64::from(n)) as usize]).sum::<f64>() / f64::from(n))
                .collect();
            means.sort_by(f64::total_cmp);
            let (blo, bhi) = (means[100], means[1899]);
            let (_, [lo, hi]) = matched_difference(b, c, n).unwrap();
            assert!((lo - blo).abs() < 0.015 && (hi - bhi).abs() < 0.015, "{b} {c} {n}: [{lo}, {hi}] vs bootstrap [{blo}, {bhi}]");
        }
    }

    #[test]
    fn a_clear_improvement() {
        let s = summarize(&pods(10, 20, 4, 66), true);
        assert_eq!(s.pods, 100);
        assert_eq!((s.paired.pods, s.paired.both_won, s.paired.variant_only, s.paired.base_only, s.paired.neither), (100, 10, 20, 4, 66));
        assert_eq!((s.base.games, s.base.wins, s.variant.games, s.variant.wins), (100, 14, 100, 30));
        assert!((s.paired.delta_win_rate.unwrap() - 0.16).abs() < 1e-12);
        assert_eq!(s.verdict.kind, VerdictKind::Better);
        assert_eq!(s.verdict.text, "Probably better (+16 points, 90% interval +8 to +23)");
        assert!(s.verdict.is_final);
        // Winners place first; the rest share 2nd to 4th (mean 3).
        assert!((s.base.avg_place.unwrap() - (14.0 * 1.0 + 86.0 * 3.0) / 100.0).abs() < 1e-12);
        assert!(s.paired.delta_avg_place.unwrap() < 0.0);
        let [lo, hi] = s.base.wilson.unwrap();
        assert!(lo < 0.14 && hi > 0.14);
        assert_eq!(s.base.ends.get("win"), Some(&100));
    }

    #[test]
    fn worse_and_unclear_and_too_few() {
        let worse = summarize(&pods(5, 3, 15, 77), true);
        assert_eq!(worse.verdict.kind, VerdictKind::Worse);
        assert!(worse.verdict.text.starts_with("Probably worse (\u{2212}12 points, 90% interval \u{2212}"), "{}", worse.verdict.text);
        let unclear = summarize(&pods(10, 8, 7, 75), true);
        assert_eq!(unclear.verdict.kind, VerdictKind::Unclear);
        assert_eq!(unclear.verdict.text, "Can't tell yet: run more games");
        // Nine pods, all to the changed list: still too few to say.
        let few = summarize(&pods(0, 9, 0, 0), false);
        assert_eq!((few.paired.pods, few.verdict.kind, few.verdict.is_final), (9, VerdictKind::Unclear, false));
        let none = summarize(&[], false);
        assert_eq!((none.pods, none.verdict.kind), (0, VerdictKind::Unclear));
        assert_eq!(none.base.win_rate, None);
    }

    #[test]
    fn unscored_games_leave_their_pod_out_of_the_difference() {
        let mut games = pods(0, 12, 0, 0);
        // Pod 0: the base game ran out of CPU time; pod 1: the changed list's game failed;
        // pod 2: the changed list's game isn't played yet; pod 3 ended at the turn cap for both.
        games[0].result = Some(result(End::TimeCap, None));
        games[3].result = Some(result(End::Error, None));
        games[5].result = None;
        games[6].result = Some(result(End::TurnCap, None));
        games[7].result = Some(result(End::TurnCap, None));
        let s = summarize(&games, false);
        assert_eq!(s.paired.pods, 9);
        assert_eq!((s.paired.variant_only, s.paired.neither), (8, 1));
        assert_eq!(s.unscored, Unscored { time_cap: 1, panic: 0, error: 1, total: 2 });
        assert_eq!(s.no_winner, NoWinner { draw: 0, turn_cap: 2, action_cap: 0, total: 2 });
        // Each list still counts its own scored games: the base lost one game to the time cap,
        // the changed list one to the error and one still to play.
        assert_eq!((s.base.games, s.variant.games, s.variant.pending), (11, 10, 1));
        assert_eq!(s.base.ends.get("time_cap"), Some(&1));
        assert_eq!(s.variant.ends.get("turn_cap"), Some(&1));
        // At the cap all four share first: place 2.5.
        assert!(s.variant.avg_place.unwrap() < 2.5);
    }

    #[test]
    fn points_read_naturally() {
        assert_eq!(points(0.04), "+4");
        assert_eq!(points(-0.031), "\u{2212}3");
        assert_eq!(points(0.004), "0");
        assert_eq!(points_word(0.01), "+1 point");
        assert_eq!(points_word(-0.2), "\u{2212}20 points");
    }

    #[test]
    fn rows_become_outcomes() {
        let line = serde_json::to_string(&spec(&["precons/a", "variant", "precons/b", "precons/c"])).unwrap();
        let mut r = result(End::Win, Some(1));
        r.decks = vec!["precons/a".into(), "variant".into(), "precons/b".into(), "precons/c".into()];
        let o = Outcome::from_row(7, &line, Some(&serde_json::to_string(&r).unwrap())).unwrap();
        assert_eq!((o.pod, o.side, o.seat), (3, Side::Variant, 1));
        assert_eq!(score(&o), Score::Played { win: true, place: 1.0 });
        let pending = Outcome::from_row(6, &line.replace("variant", "base"), None).unwrap();
        assert_eq!((pending.pod, pending.side, score(&pending)), (3, Side::Base, Score::Pending));
        // A garbled result line is an error, not a game still to play.
        let bad = Outcome::from_row(0, &line, Some("{nope")).unwrap();
        assert_eq!(score(&bad), Score::Unscored);
        assert!(Outcome::from_row(0, &line.replace("variant", "precons/z"), None).is_none());
    }
}
