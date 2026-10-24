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
//! Every result line names the build that played it (engine, card data, runner). The summary lists
//! each build with its games, and a pod counts in the paired difference only when its two games
//! ran on the same build (the worker replays a pod half played on an older build, so this only
//! leaves out pods stored before that rule).
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
or action cap count as games nobody won, as in the batch analysis. A pod whose two games ran on different builds (engine, \
card data or runner) is left out of the difference. The verdict goes by the interval as shown, in whole points: better \
only when its low end is at least +1, worse only when its high end is at most \u{2212}1.";

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
        // What played it is unknown too.
        let result = result.map(|r| {
            serde_json::from_str::<GameResult>(r).unwrap_or_else(|e| {
                let mut g = GameResult::new(&spec, UNKNOWN);
                g.engine = UNKNOWN.into();
                g.runner = UNKNOWN.into();
                g.error = Some(format!("unreadable result line: {e}"));
                g
            })
        });
        Some(Outcome { pod: usize::try_from(ord / 2).ok()?, side, seat: seat as u8, result })
    }
}

const UNKNOWN: &str = "unknown";

/// What played a game, from its result line: the rules engine, its card data and the build of
/// Yama's lab code.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Build {
    pub engine: String,
    pub card_data: String,
    pub runner: String,
}

impl Build {
    pub fn of(r: &GameResult) -> Build {
        Build { engine: r.engine.clone(), card_data: r.card_data.clone(), runner: r.runner.clone() }
    }
}

/// A build and how many of the experiment's stored games it played.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BuildGames {
    #[serde(flatten)]
    pub build: Build,
    pub games: u32,
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
    /// Pods where both lists finished a scored game on the same build; the difference uses these
    /// only.
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
    /// Pods where both games were scored but on different builds: left out of the difference.
    #[serde(default)]
    pub split_builds: u32,
    /// While the verdict can't tell: about how many paired pods in all would settle it if the
    /// difference stayed where it is ([`pods_to_settle`]). None when it is settled, too close to
    /// zero for any sensible number of games, or too early to say.
    #[serde(default)]
    pub settle_pods: Option<u32>,
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
    /// Every build that played a stored game, in play order of first use, with its games.
    #[serde(default)]
    pub builds: Vec<BuildGames>,
    pub verdict: Verdict,
    pub method: String,
    /// Head to head (mode "versus"): every deck's results against the others. Missing for the
    /// other modes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub versus: Option<Versus>,
}

impl Summary {
    /// Games that count in any number here.
    pub fn scored_games(&self) -> u32 {
        match &self.versus {
            Some(v) => v.games,
            None => self.base.games + self.variant.games,
        }
    }
}

/// A difference in whole percentage points, as it is shown.
fn whole_points(x: f64) -> i64 {
    (x * 100.0).round() as i64
}

/// "+4", "−3" (U+2212 minus) or "0": a difference in whole percentage points.
pub fn points(x: f64) -> String {
    match whole_points(x) {
        0 => "0".into(),
        p if p > 0 => format!("+{p}"),
        p => format!("\u{2212}{}", -p),
    }
}

fn points_word(x: f64) -> String {
    let n = whole_points(x).abs();
    format!("{} {}", points(x), if n == 1 { "point" } else { "points" })
}

/// The plain-language verdict on a paired difference and its interval. It goes by the interval as
/// shown, in whole points, so the words never disagree with the numbers beside them: "better" only
/// when the low end reads +1 or more, "worse" only when the high end reads −1 or less. An interval
/// that rounds to 0 at either end can't tell yet.
pub fn verdict(paired: &Paired, is_final: bool) -> Verdict {
    let level = format!("{:.0}%", LEVEL * 100.0);
    let unclear = Verdict { kind: VerdictKind::Unclear, text: "Can't tell yet: run more games".into(), is_final };
    let (Some(d), Some([lo, hi])) = (paired.delta_win_rate, paired.delta_ci) else { return unclear };
    if paired.pods < MIN_PODS {
        return unclear;
    }
    let detail = format!("{}, {level} interval {} to {}", points_word(d), points(lo), points(hi));
    if whole_points(lo) >= 1 {
        Verdict { kind: VerdictKind::Better, text: format!("Probably better ({detail})"), is_final }
    } else if whole_points(hi) <= -1 {
        Verdict { kind: VerdictKind::Worse, text: format!("Probably worse ({detail})"), is_final }
    } else {
        unclear
    }
}

/// Most pods [`pods_to_settle`] will name; beyond that it says nothing.
const SETTLE_MAX: f64 = 20_000.0;

/// About how many paired pods in all an unclear difference needs before its interval clears zero by
/// the verdict's whole point, if the difference and the share of pods where only one list won stay
/// as they are: n >= Z^2 (p - d^2) / (|d| - 0.0075)^2, where p is that share and d the difference
/// (the normal interval for matched pairs, aiming a quarter point past the half point that rounds
/// to +1, so Agresti-Min's half pods don't keep it just short). A projection, not a
/// promise: a real difference smaller than this one needs more games. None while the verdict
/// can't tell for fewer than [`MIN_PODS`] pods, for a difference under 2 points, or past
/// [`SETTLE_MAX`].
pub fn pods_to_settle(paired: &Paired) -> Option<u32> {
    let d = paired.delta_win_rate?;
    if paired.pods < MIN_PODS || d.abs() < 0.02 {
        return None;
    }
    let n = f64::from(paired.pods);
    let p = f64::from(paired.variant_only + paired.base_only) / n;
    let need = (Z * Z * (p - d * d).max(0.0) / (d.abs() - 0.0075).powi(2)).ceil();
    // The half pods the interval adds can keep it unclear a little past the plain formula.
    let need = need.max(n + 10.0);
    (need <= SETTLE_MAX).then_some(need as u32)
}

/// The experiment's summary from its games so far, in play order. `is_final` marks a summary no
/// later game can change.
pub fn summarize(outcomes: &[Outcome], is_final: bool) -> Summary {
    let mut lists: HashMap<Side, ListStats> = HashMap::from([(Side::Base, ListStats::default()), (Side::Variant, ListStats::default())]);
    let mut place_sum: HashMap<Side, f64> = HashMap::new();
    let mut pods: BTreeMap<usize, [Option<(Score, Option<Build>)>; 2]> = BTreeMap::new();
    let mut builds: Vec<BuildGames> = Vec::new();
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
        let build = o.result.as_ref().map(Build::of);
        if let Some(b) = &build {
            match builds.iter_mut().find(|g| &g.build == b) {
                Some(g) => g.games += 1,
                None => builds.push(BuildGames { build: b.clone(), games: 1 }),
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
        *slot = Some((s, build));
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
        let [Some((Score::Played { win: bw, place: bp }, base_build)), Some((Score::Played { win: vw, place: vp }, variant_build))] = slots else { continue };
        let (bw, bp, vw, vp) = (*bw, *bp, *vw, *vp);
        if base_build != variant_build {
            paired.split_builds += 1;
            continue;
        }
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
    if verdict.kind == VerdictKind::Unclear {
        paired.settle_pods = pods_to_settle(&paired);
    }
    Summary {
        level: LEVEL,
        pods: pods.len() as u32,
        base: lists.remove(&Side::Base).unwrap_or_default(),
        variant: lists.remove(&Side::Variant).unwrap_or_default(),
        paired,
        unscored,
        no_winner,
        builds,
        verdict,
        method: METHOD.into(),
        versus: None,
    }
}

// ── one deck as it is (mode "solo") ─────────────────────────────────────────

pub const SOLO_METHOD: &str = "Wins count for the tested seat only, with a Wilson 90% interval. The list plays every pod once \
(no changed copy), so the number is its win rate against this field: in a pod of four, a list with no edge over the others \
would win about one game in four. Games that ran out of CPU time, crashed or failed aren't scored; games that reached the \
turn or action cap count as games nobody won. The verdict goes by the interval as shown, in whole points: above the \
no-edge share only when its low end is at least a point above it, below only when its high end is at least a point under.";

/// The verdict on one list played as it is: its win rate against the share a list with no edge
/// would win (`1 / pod`), by the interval as shown in whole points.
pub fn solo_verdict(stats: &ListStats, pod: usize, is_final: bool) -> Verdict {
    let even = 1.0 / pod.max(1) as f64;
    let pct = |x: f64| (x * 100.0).round() as i64;
    let unclear = |text: String| Verdict { kind: VerdictKind::Unclear, text, is_final };
    let (Some(rate), Some([lo, hi])) = (stats.win_rate, stats.wilson) else { return unclear("Can't tell yet: run more games".into()) };
    if stats.games < MIN_PODS {
        return unclear("Can't tell yet: run more games".into());
    }
    let detail = format!("wins {}%, {:.0}% interval {} to {}%; no edge would be {}%", pct(rate), LEVEL * 100.0, pct(lo), pct(hi), pct(even));
    if pct(lo) > pct(even) {
        Verdict { kind: VerdictKind::Better, text: format!("Probably stronger than this field ({detail})"), is_final }
    } else if pct(hi) < pct(even) {
        Verdict { kind: VerdictKind::Worse, text: format!("Probably weaker than this field ({detail})"), is_final }
    } else {
        unclear(format!("About even with this field so far ({detail})"))
    }
}

// ── head to head (mode "versus") ─────────────────────────────────────────────

pub const VERSUS_METHOD: &str = "Each of your decks plays the others directly, every deck rotated through every seat so \
going first evens out. Win share: the games each deck won, with a Wilson 90% interval; in a pod of four a deck with no \
edge wins about one in four (one in two in 1v1). Head to head: of the games two decks both played, how often each finished \
ahead of the other (ties left out). With two decks, the verdict goes by that head-to-head share and its Wilson 90% \
interval: a deck is ahead only when the interval is clear of 50% by a whole point. Precons filling empty seats count as \
opponents, not as entrants. Games that ran out of CPU time, crashed or failed aren't scored; games that reached the turn \
or action cap count as games nobody won.";

/// One deck in a head-to-head experiment.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Entrant {
    /// Its deck id in the games ("e0".."e3").
    pub id: String,
    pub label: String,
    pub games: u32,
    pub wins: u32,
    pub win_rate: Option<f64>,
    pub wilson: Option<[f64; 2]>,
    pub avg_place: Option<f64>,
    /// Games it went first in (seat 0), scored or not.
    pub first: u32,
}

/// Two entrants who sat in the same scored games.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Meeting {
    /// Indexes into `entrants`, a < b.
    pub a: usize,
    pub b: usize,
    pub games: u32,
    /// Games `a` finished ahead of `b`, and the other way round; ties are the rest.
    pub a_ahead: u32,
    pub b_ahead: u32,
    pub ties: u32,
    /// Share of the untied games `a` finished ahead, with its Wilson interval.
    pub a_share: Option<f64>,
    pub a_share_ci: Option<[f64; 2]>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Versus {
    pub pod: usize,
    /// Scored games.
    pub games: u32,
    pub pending: u32,
    pub entrants: Vec<Entrant>,
    pub meetings: Vec<Meeting>,
    /// Games won by a precon filling an empty seat.
    pub filler_wins: u32,
    /// Mean turns of the scored games (every player's turn counted; rounds are about turns / pod).
    pub avg_turns: Option<f64>,
}

/// The head-to-head summary from an experiment's games (stored rows: schedule line and result),
/// `entrants` as (deck id, label) in order.
pub fn summarize_versus(rows: &[(String, Option<String>)], entrants: &[(String, String)], pod: usize, is_final: bool) -> Summary {
    let mut v = Versus {
        pod,
        entrants: entrants.iter().map(|(id, label)| Entrant { id: id.clone(), label: label.clone(), ..Default::default() }).collect(),
        ..Default::default()
    };
    let n = entrants.len();
    let mut meetings: Vec<Meeting> = Vec::new();
    for a in 0..n {
        for b in a + 1..n {
            meetings.push(Meeting { a, b, ..Default::default() });
        }
    }
    let mut place_sum = vec![0.0f64; n];
    let mut turns = Vec::new();
    let mut builds: Vec<BuildGames> = Vec::new();
    let mut unscored = Unscored::default();
    let mut no_winner = NoWinner::default();
    for (spec, result) in rows {
        let Ok(spec) = serde_json::from_str::<GameSpec>(spec) else { continue };
        // Entrant index -> seat in this game.
        let seats: Vec<Option<u8>> = entrants.iter().map(|(id, _)| spec.decks.iter().position(|d| d == id).map(|s| s as u8)).collect();
        for (i, s) in seats.iter().enumerate() {
            if *s == Some(0) {
                v.entrants[i].first += 1;
            }
        }
        let Some(result) = result else {
            v.pending += 1;
            continue;
        };
        let r = match serde_json::from_str::<GameResult>(result) {
            Ok(r) => r,
            Err(_) => {
                unscored.error += 1;
                continue;
            }
        };
        let b = Build::of(&r);
        match builds.iter_mut().find(|g| g.build == b) {
            Some(g) => g.games += 1,
            None => builds.push(BuildGames { build: b, games: 1 }),
        }
        match r.end {
            End::TimeCap => {
                unscored.time_cap += 1;
                continue;
            }
            End::Panic => {
                unscored.panic += 1;
                continue;
            }
            End::Error => {
                unscored.error += 1;
                continue;
            }
            End::Draw => no_winner.draw += 1,
            End::TurnCap => no_winner.turn_cap += 1,
            End::ActionCap => no_winner.action_cap += 1,
            End::Win => {}
        }
        let places = placement_ranks(&r.placements);
        let place: Vec<Option<f64>> = seats.iter().map(|s| s.and_then(|s| places.get(&s).copied())).collect();
        if seats.iter().any(|s| s.is_some()) && seats.iter().zip(&place).any(|(s, p)| s.is_some() && p.is_none()) {
            // A scored end without every entrant placed: malformed, not scored.
            unscored.error += 1;
            continue;
        }
        v.games += 1;
        turns.push(f64::from(r.turns));
        let winner_is_entrant = r.winner.is_some_and(|w| seats.contains(&Some(w)));
        if r.end == End::Win && !winner_is_entrant {
            v.filler_wins += 1;
        }
        for i in 0..n {
            if let (Some(s), Some(p)) = (seats[i], place[i]) {
                let e = &mut v.entrants[i];
                e.games += 1;
                e.wins += u32::from(r.winner == Some(s));
                place_sum[i] += p;
            }
        }
        for m in meetings.iter_mut() {
            if let (Some(pa), Some(pb)) = (place[m.a], place[m.b]) {
                m.games += 1;
                if pa < pb {
                    m.a_ahead += 1;
                } else if pb < pa {
                    m.b_ahead += 1;
                } else {
                    m.ties += 1;
                }
            }
        }
    }
    unscored.total = unscored.time_cap + unscored.panic + unscored.error;
    no_winner.total = no_winner.draw + no_winner.turn_cap + no_winner.action_cap;
    for (i, e) in v.entrants.iter_mut().enumerate() {
        if e.games > 0 {
            e.win_rate = Some(f64::from(e.wins) / f64::from(e.games));
            e.wilson = wilson(e.wins, e.games);
            e.avg_place = Some(place_sum[i] / f64::from(e.games));
        }
    }
    for m in meetings.iter_mut() {
        let decided = m.a_ahead + m.b_ahead;
        if decided > 0 {
            m.a_share = Some(f64::from(m.a_ahead) / f64::from(decided));
            m.a_share_ci = wilson(m.a_ahead, decided);
        }
    }
    v.meetings = meetings;
    v.avg_turns = (!turns.is_empty()).then(|| turns.iter().sum::<f64>() / turns.len() as f64);
    let verdict = versus_verdict(&v, is_final);
    Summary {
        level: LEVEL,
        pods: u32::try_from(rows.len()).unwrap_or(u32::MAX),
        base: ListStats::default(),
        variant: ListStats::default(),
        paired: Paired::default(),
        unscored,
        no_winner,
        builds,
        verdict,
        method: VERSUS_METHOD.into(),
        versus: Some(v),
    }
}

/// With two decks: which one finishes ahead, by the head-to-head share's interval in whole points.
/// With more: the deck winning most often, and whether its win share is clear of every other's.
pub fn versus_verdict(v: &Versus, is_final: bool) -> Verdict {
    let pct = |x: f64| (x * 100.0).round() as i64;
    let level = format!("{:.0}%", LEVEL * 100.0);
    let unclear = |text: String| Verdict { kind: VerdictKind::Unclear, text, is_final };
    if v.entrants.len() == 2 {
        let Some(m) = v.meetings.first() else { return unclear("Can't tell yet: run more games".into()) };
        let (Some(share), Some([lo, hi])) = (m.a_share, m.a_share_ci) else { return unclear("Can't tell yet: run more games".into()) };
        if m.a_ahead + m.b_ahead < MIN_PODS {
            return unclear("Can't tell yet: run more games".into());
        }
        let (a, b) = (&v.entrants[0].label, &v.entrants[1].label);
        if pct(lo) > 50 {
            let detail = format!("ahead in {}% of games, {level} interval {} to {}%", pct(share), pct(lo), pct(hi));
            return Verdict { kind: VerdictKind::Better, text: format!("{a} probably finishes ahead of {b} ({detail})"), is_final };
        }
        if pct(hi) < 50 {
            let detail = format!("ahead in {}% of games, {level} interval {} to {}%", pct(1.0 - share), pct(1.0 - hi), pct(1.0 - lo));
            return Verdict { kind: VerdictKind::Better, text: format!("{b} probably finishes ahead of {a} ({detail})"), is_final };
        }
        return unclear(format!("Too close to call so far ({a} ahead in {}% of games, {level} interval {} to {}%)", pct(share), pct(lo), pct(hi)));
    }
    let scored: Vec<&Entrant> = v.entrants.iter().filter(|e| e.win_rate.is_some()).collect();
    if scored.len() < v.entrants.len() || v.games < MIN_PODS {
        return unclear("Can't tell yet: run more games".into());
    }
    let best = scored.iter().max_by(|x, y| x.win_rate.partial_cmp(&y.win_rate).unwrap_or(std::cmp::Ordering::Equal)).expect("non-empty");
    let lo = best.wilson.map(|w| pct(w[0])).unwrap_or(0);
    let clear = scored.iter().filter(|e| e.id != best.id).all(|e| e.wilson.is_some_and(|w| pct(w[1]) < lo));
    let detail = format!("wins {}%, {level} interval {} to {}%", pct(best.win_rate.unwrap_or(0.0)), lo, best.wilson.map(|w| pct(w[1])).unwrap_or(0));
    if clear {
        Verdict { kind: VerdictKind::Better, text: format!("{} wins most often, clear of the others ({detail})", best.label), is_final }
    } else {
        unclear(format!("{} wins most often so far, but the others are within the margin ({detail})", best.label))
    }
}

// ── two engines side by side ────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgreementKind {
    /// Not enough scored games on one engine or both yet.
    Waiting,
    /// The engines point the same way.
    Agree,
    /// Beyond noise: opposite verdicts, or intervals that don't overlap.
    Disagree,
    /// No contradiction, but at least one engine can't tell yet.
    Unclear,
}

/// How a "both" run's two engines compare.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Agreement {
    pub kind: AgreementKind,
    pub text: String,
}

fn overlap(a: [f64; 2], b: [f64; 2]) -> bool {
    a[0] <= b[1] && b[0] <= a[1]
}

fn range_text(x: f64, ci: [f64; 2]) -> String {
    format!("{} ({} to {})", points(x), points(ci[0]), points(ci[1]))
}

fn share_text(x: f64, ci: [f64; 2]) -> String {
    format!("{:.0}% ({:.0} to {:.0})", x * 100.0, ci[0] * 100.0, ci[1] * 100.0)
}

/// Whether a run's phase and Forge summaries agree beyond noise: the paired difference for a
/// change or a comparison, the win rate for an "as it is" run, and each deck's win share for a
/// head to head.
pub fn agreement(versus: bool, solo: bool, phase: &Summary, forge: &Summary) -> Agreement {
    let waiting = Agreement { kind: AgreementKind::Waiting, text: "Waiting for both engines' results".into() };
    if phase.scored_games() == 0 || forge.scored_games() == 0 {
        return waiting;
    }
    if versus {
        let (Some(pv), Some(fv)) = (&phase.versus, &forge.versus) else { return waiting };
        let mut apart = Vec::new();
        for (p, f) in pv.entrants.iter().zip(&fv.entrants) {
            if let (Some(pr), Some(pc), Some(fr), Some(fc)) = (p.win_rate, p.wilson, f.win_rate, f.wilson)
                && !overlap(pc, fc)
            {
                apart.push(format!("{}: {} on phase, {} on Forge", p.label, share_text(pr, pc), share_text(fr, fc)));
            }
        }
        if !apart.is_empty() {
            return Agreement { kind: AgreementKind::Disagree, text: format!("The engines disagree. {}", apart.join("; ")) };
        }
        let leader = |v: &Versus| v.entrants.iter().filter(|e| e.win_rate.is_some()).max_by(|a, b| a.win_rate.partial_cmp(&b.win_rate).unwrap_or(std::cmp::Ordering::Equal)).map(|e| e.label.clone());
        return match (leader(pv), leader(fv)) {
            (Some(a), Some(b)) if a == b => Agreement { kind: AgreementKind::Agree, text: format!("Both engines put {a} first") },
            _ => Agreement { kind: AgreementKind::Unclear, text: "The engines order the decks differently, but within noise".into() },
        };
    }
    if solo {
        return match (phase.base.win_rate, phase.base.wilson, forge.base.win_rate, forge.base.wilson) {
            (Some(pr), Some(pc), Some(fr), Some(fc)) if !overlap(pc, fc) => Agreement {
                kind: AgreementKind::Disagree,
                text: format!("The engines disagree: {} on phase, {} on Forge", share_text(pr, pc), share_text(fr, fc)),
            },
            (Some(_), Some(_), Some(_), Some(_)) => Agreement { kind: AgreementKind::Agree, text: "The engines' win rates overlap".into() },
            _ => waiting,
        };
    }
    let (pk, fk) = (phase.verdict.kind, forge.verdict.kind);
    if let (Some(pd), Some(pc), Some(fd), Some(fc)) = (phase.paired.delta_win_rate, phase.paired.delta_ci, forge.paired.delta_win_rate, forge.paired.delta_ci) {
        let opposite = matches!((pk, fk), (VerdictKind::Better, VerdictKind::Worse) | (VerdictKind::Worse, VerdictKind::Better));
        if opposite || !overlap(pc, fc) {
            return Agreement {
                kind: AgreementKind::Disagree,
                text: format!("The engines disagree: {} on phase, {} on Forge. Treat this result with caution", range_text(pd, pc), range_text(fd, fc)),
            };
        }
    }
    match (pk, fk) {
        (VerdictKind::Better, VerdictKind::Better) => Agreement { kind: AgreementKind::Agree, text: "Both engines say probably better".into() },
        (VerdictKind::Worse, VerdictKind::Worse) => Agreement { kind: AgreementKind::Agree, text: "Both engines say probably worse".into() },
        (VerdictKind::Unclear, VerdictKind::Unclear) => Agreement { kind: AgreementKind::Unclear, text: "Neither engine can tell yet".into() },
        _ => Agreement { kind: AgreementKind::Unclear, text: "One engine sees a difference and the other can't tell yet; they don't contradict each other".into() },
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
            pilots: None,
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

    #[test]
    fn pods_to_settle_projects_the_difference_as_it_is() {
        let paired = |pods, variant_only, base_only| {
            let mut p = Paired { pods, variant_only, base_only, ..Paired::default() };
            p.delta_win_rate = matched_difference(variant_only, base_only, pods).map(|(d, _)| d);
            p
        };
        // Run 7cc7910c (2026-10-23): +6 points on 83 phase pods and on 94 Forge pods, both unclear.
        assert_eq!(pods_to_settle(&paired(83, 14, 9)), Some(267));
        assert_eq!(pods_to_settle(&paired(94, 22, 16)), Some(342));
        // At that size, with the same shares, the interval clears zero by the verdict's point.
        for (n, b, c) in [(83u32, 14u32, 9u32), (94, 22, 16)] {
            let need = pods_to_settle(&paired(n, b, c)).unwrap();
            let scale = |x: u32| (f64::from(x) * f64::from(need) / f64::from(n)).round() as u32;
            let (_, [lo, _]) = matched_difference(scale(b), scale(c), need).unwrap();
            assert!(whole_points(lo) >= 1, "{need} pods: low end {lo}");
        }
        // Too early, or too close to zero to name a number.
        assert_eq!(pods_to_settle(&paired(8, 3, 1)), None);
        assert_eq!(pods_to_settle(&paired(100, 11, 10)), None);
        assert_eq!(pods_to_settle(&Paired::default()), None);
        // A summary names it only while the verdict can't tell.
        let unclear = summarize(&[], true);
        assert_eq!(unclear.paired.settle_pods, None);
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

    /// Every possible result at 50, 100 and 200 pods: "better" always prints a low end of +1 or
    /// more, "worse" a high end of −1 or less, and an interval that reads 0 at either end can't
    /// tell. (Deciding on the unrounded bounds gave "Probably better (+12 points, 90% interval 0
    /// to +23)" in 264 such cases.)
    #[test]
    fn the_verdict_goes_by_the_interval_as_shown() {
        let paired = |b: u32, c: u32, n: u32| {
            let (d, ci) = matched_difference(b, c, n).unwrap();
            Paired { pods: n, variant_only: b, base_only: c, neither: n - b - c, delta_win_rate: Some(d), delta_ci: Some(ci), ..Default::default() }
        };
        let mut decided = 0;
        for n in [50u32, 100, 200] {
            for b in 0..=n {
                for c in 0..=(n - b) {
                    let p = paired(b, c, n);
                    let [lo, hi] = p.delta_ci.unwrap();
                    let v = verdict(&p, true);
                    match v.kind {
                        VerdictKind::Better => assert!(whole_points(lo) >= 1, "{b} {c} {n}: {}", v.text),
                        VerdictKind::Worse => assert!(whole_points(hi) <= -1, "{b} {c} {n}: {}", v.text),
                        VerdictKind::Unclear => assert!(whole_points(lo) < 1 && whole_points(hi) > -1, "{b} {c} {n}: {}", v.text),
                    }
                    if v.kind != VerdictKind::Unclear {
                        decided += 1;
                        assert!(!v.text.contains("interval 0 ") && !v.text.ends_with(" 0)"), "{}", v.text);
                    }
                }
            }
        }
        assert!(decided > 1000, "{decided}");
        // The two cases the review found.
        assert_eq!(verdict(&paired(9, 3, 50), true).kind, VerdictKind::Unclear);
        assert_eq!(verdict(&paired(0, 4, 100), true).kind, VerdictKind::Unclear);
    }

    #[test]
    fn pods_split_across_builds_are_left_out_and_every_build_is_listed() {
        let mut games = pods(0, 12, 0, 0);
        // Pod 0's changed-list game ran on newer card data; pod 1's base game on another runner.
        games[1].result.as_mut().unwrap().card_data = "newer".into();
        games[2].result.as_mut().unwrap().runner = "other".into();
        let s = summarize(&games, true);
        assert_eq!((s.paired.pods, s.paired.split_builds, s.paired.variant_only), (10, 2, 10));
        // Each list still counts its own games.
        assert_eq!((s.base.games, s.variant.games), (12, 12));
        let builds: Vec<(&str, &str, u32)> = s.builds.iter().map(|b| (b.build.card_data.as_str(), b.build.runner.as_str(), b.games)).collect();
        let runner = yama_play::lab::RUNNER;
        assert_eq!(builds, vec![("eb309108eb0df708", runner, 22), ("newer", runner, 1), ("eb309108eb0df708", "other", 1)]);
        // A summary stored before builds were listed still reads.
        let mut old = serde_json::to_value(&s).unwrap();
        old.as_object_mut().unwrap().remove("builds");
        old["paired"].as_object_mut().unwrap().remove("split_builds");
        let back: Summary = serde_json::from_value(old).unwrap();
        assert!(back.builds.is_empty() && back.paired.split_builds == 0);
        // An unreadable line names no build it didn't run on.
        let line = serde_json::to_string(&spec(&["base", "a", "b", "c"])).unwrap();
        let bad = Outcome::from_row(0, &line, Some("{nope")).unwrap();
        let r = bad.result.unwrap();
        assert_eq!((r.engine.as_str(), r.card_data.as_str(), r.runner.as_str()), ("unknown", "unknown", "unknown"));
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

    #[test]
    fn two_engines_agree_disagree_or_cant_tell() {
        let better = summarize(&pods(10, 20, 4, 66), true);
        let worse = summarize(&pods(5, 3, 15, 77), true);
        let unclear = summarize(&pods(10, 8, 7, 75), true);
        let none = summarize(&[], false);
        assert_eq!(agreement(false, false, &better, &none).kind, AgreementKind::Waiting);
        assert_eq!(agreement(false, false, &better, &better).kind, AgreementKind::Agree);
        let d = agreement(false, false, &better, &worse);
        assert_eq!(d.kind, AgreementKind::Disagree, "{}", d.text);
        assert!(d.text.contains("on phase") && d.text.contains("on Forge"), "{}", d.text);
        assert_eq!(agreement(false, false, &unclear, &unclear).kind, AgreementKind::Unclear);
        // Intervals that don't overlap are a disagreement even when one engine can't tell...
        assert_eq!(agreement(false, false, &better, &unclear).kind, AgreementKind::Disagree);
        // ...but a smaller difference that overlaps "can't tell" isn't.
        let slightly = summarize(&pods(10, 12, 4, 74), true);
        assert_eq!(slightly.verdict.kind, VerdictKind::Better, "{}", slightly.verdict.text);
        assert_eq!(agreement(false, false, &slightly, &unclear).kind, AgreementKind::Unclear);
    }
}
