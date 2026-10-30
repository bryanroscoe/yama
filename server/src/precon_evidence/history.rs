//! Recent real-game rates from dated cumulative snapshots (pure functions, unit tested).
//!
//! A source such as playgroup.gg republishes each precon's all-time rate and game count. Two
//! snapshots n₁ < n₂ games apart imply the rate over the games played between them:
//! (n₂·r₂ − n₁·r₁) / (n₂ − n₁). The source reports a normalised 4-player rate, not raw wins, so
//! the implied rate is an approximation and carries no binomial interval of its own; its weight
//! comes from the games alone. Short gaps are pooled until they reach `MIN_INTERVAL_GAMES`, and
//! the recent rate weights each interval by its games and by exponential recency at its midpoint.
use chrono::{DateTime, Utc};
use serde::Serialize;

/// Fewest new games an interval may rest on; shorter gaps are pooled with the next snapshot.
pub const MIN_INTERVAL_GAMES: u64 = 40;
/// Intervals needed before a trend is shown.
pub const MIN_TREND_INTERVALS: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Snapshot {
    pub as_of: DateTime<Utc>,
    pub games: u64,
    /// Percent, 0–100.
    pub rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Interval {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub games: u64,
    /// Implied percent over the interval's games.
    pub rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Recent {
    /// Percent, recency- and games-weighted over `intervals`.
    pub rate: f64,
    /// New games across the intervals used.
    pub games: u64,
    /// Games after recency weighting: the measure's precision for later use.
    pub effective_games: f64,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub half_life_days: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct History {
    /// Snapshots used, oldest first, after removing duplicates, conflicts and future dates.
    pub snapshots: Vec<Snapshot>,
    /// Oldest first.
    pub intervals: Vec<Interval>,
    pub recent: Option<Recent>,
    /// Change in the interval rate, percentage points per 30 days (games-weighted least squares).
    pub trend_points_per_30_days: Option<f64>,
    /// What was set aside and why, in plain words.
    pub notes: Vec<String>,
}

fn days(a: DateTime<Utc>, b: DateTime<Utc>) -> f64 {
    (b - a).num_seconds() as f64 / 86_400.0
}

fn midpoint(a: DateTime<Utc>, b: DateTime<Utc>) -> DateTime<Utc> {
    a + (b - a) / 2
}

/// The rate over the games between two snapshots of one chain (`a` has fewer games).
pub fn implied(a: &Snapshot, b: &Snapshot) -> f64 {
    (b.games as f64 * b.rate - a.games as f64 * a.rate) / (b.games - a.games) as f64
}

/// Snapshots in time order, cleaned. Two records at the same time that agree count once; ones
/// that disagree are both set aside. A falling game count means the source redefined the list or
/// reset its counts, so earlier snapshots can't be differenced against later ones: start again.
/// A changed rate on the same games is a revision of the earlier number: keep the later one.
pub fn clean(mut snaps: Vec<Snapshot>, as_of: DateTime<Utc>, notes: &mut Vec<String>) -> Vec<Snapshot> {
    let before = snaps.len();
    snaps.retain(|s| s.as_of <= as_of && s.games > 0 && s.rate.is_finite() && (0.0..=100.0).contains(&s.rate));
    if snaps.len() < before {
        notes.push(format!(
            "{} snapshot(s) dated after the evaluation date or out of range were left out",
            before - snaps.len()
        ));
    }
    snaps.sort_by(|a, b| a.as_of.cmp(&b.as_of).then(a.games.cmp(&b.games)));
    let mut same_time: Vec<Snapshot> = Vec::new();
    let mut i = 0;
    while i < snaps.len() {
        let mut j = i + 1;
        while j < snaps.len() && snaps[j].as_of == snaps[i].as_of {
            j += 1;
        }
        let group = &snaps[i..j];
        if group
            .iter()
            .all(|s| s.games == group[0].games && (s.rate - group[0].rate).abs() < 0.005)
        {
            same_time.push(group[0]);
        } else {
            notes.push(format!(
                "{} conflicting snapshots at {} were left out",
                group.len(),
                group[0].as_of.date_naive()
            ));
        }
        i = j;
    }
    let mut out: Vec<Snapshot> = Vec::new();
    for s in same_time {
        match out.last() {
            Some(last) if s.games < last.games => {
                notes.push(format!(
                    "the game count fell on {} ({} to {}), so history before it isn't compared with later snapshots",
                    s.as_of.date_naive(),
                    last.games,
                    s.games
                ));
                out.clear();
                out.push(s);
            }
            Some(last) if s.games == last.games => {
                *out.last_mut().unwrap() = s;
            }
            _ => out.push(s),
        }
    }
    out
}

/// Breakpoints so every interval rests on at least `min_games` new games. A short tail joins the
/// interval before it; with no interval before it, it stands alone and a note says so.
pub fn intervals(snaps: &[Snapshot], min_games: u64, notes: &mut Vec<String>) -> Vec<Interval> {
    if snaps.len() < 2 {
        return Vec::new();
    }
    let mut cuts = vec![0usize];
    for (k, s) in snaps.iter().enumerate().skip(1) {
        if s.games - snaps[*cuts.last().unwrap()].games >= min_games {
            cuts.push(k);
        }
    }
    let last = snaps.len() - 1;
    if *cuts.last().unwrap() != last {
        if cuts.len() > 1 {
            *cuts.last_mut().unwrap() = last;
        } else {
            cuts.push(last);
            notes.push(format!(
                "only {} new games across the snapshots, under the {min_games} an interval normally needs",
                snaps[last].games - snaps[0].games
            ));
        }
    }
    let mut out = Vec::new();
    for w in cuts.windows(2) {
        let (a, b) = (&snaps[w[0]], &snaps[w[1]]);
        let rate = implied(a, b);
        if !(0.0..=100.0).contains(&rate) {
            notes.push(format!(
                "the implied rate from {} to {} was out of range ({rate:.1}%) and was left out",
                a.as_of.date_naive(),
                b.as_of.date_naive()
            ));
            continue;
        }
        out.push(Interval {
            from: a.as_of,
            to: b.as_of,
            games: b.games - a.games,
            rate,
        });
    }
    out
}

pub fn recent(intervals: &[Interval], as_of: DateTime<Utc>, half_life_days: u32) -> Option<Recent> {
    let (first, last) = (intervals.first()?, intervals.last()?);
    let (mut weight, mut sum, mut games) = (0.0, 0.0, 0);
    for i in intervals {
        let age = days(midpoint(i.from, i.to), as_of).max(0.0);
        let w = 2f64.powf(-age / half_life_days as f64) * i.games as f64;
        weight += w;
        sum += w * i.rate;
        games += i.games;
    }
    (weight > 0.0).then(|| Recent {
        rate: sum / weight,
        games,
        effective_games: weight,
        from: first.from,
        to: last.to,
        half_life_days,
    })
}

/// Games-weighted least-squares slope of the interval rates against their midpoints.
pub fn trend(intervals: &[Interval]) -> Option<f64> {
    if intervals.len() < MIN_TREND_INTERVALS {
        return None;
    }
    let origin = intervals[0].from;
    let pts: Vec<(f64, f64, f64)> = intervals
        .iter()
        .map(|i| (days(origin, midpoint(i.from, i.to)), i.rate, i.games as f64))
        .collect();
    let w: f64 = pts.iter().map(|p| p.2).sum();
    let mx = pts.iter().map(|p| p.0 * p.2).sum::<f64>() / w;
    let my = pts.iter().map(|p| p.1 * p.2).sum::<f64>() / w;
    let sxx: f64 = pts.iter().map(|p| p.2 * (p.0 - mx).powi(2)).sum();
    let sxy: f64 = pts.iter().map(|p| p.2 * (p.0 - mx) * (p.1 - my)).sum();
    (sxx > 0.0).then(|| 30.0 * sxy / sxx)
}

pub fn history(snaps: Vec<Snapshot>, as_of: DateTime<Utc>, half_life_days: u32) -> History {
    let mut notes = Vec::new();
    let snapshots = clean(snaps, as_of, &mut notes);
    let intervals = intervals(&snapshots, MIN_INTERVAL_GAMES, &mut notes);
    History {
        recent: recent(&intervals, as_of, half_life_days),
        trend_points_per_30_days: trend(&intervals),
        snapshots,
        intervals,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(day: &str) -> DateTime<Utc> {
        format!("{day}T16:00:00Z").parse().unwrap()
    }
    fn snap(day: &str, games: u64, rate: f64) -> Snapshot {
        Snapshot {
            as_of: at(day),
            games,
            rate,
        }
    }
    /// Riders of Rohan's recorded playgroup.gg snapshots (dataset playgroup-history-20261028).
    fn rohan() -> Vec<Snapshot> {
        vec![
            snap("2026-10-28", 477, 19.81),
            snap("2026-10-20", 459, 20.37),
            snap("2026-10-17", 447, 20.47),
            snap("2026-09-06", 331, 22.02),
            snap("2026-08-06", 263, 23.81),
        ]
    }

    #[test]
    fn implied_rates_match_the_proposal_example() {
        let h = history(rohan(), at("2026-10-29"), 180);
        // 6 Aug → 6 Sep: 68 games; 6 Sep → 17 Oct: 116; the 12- and 18-game tail joins the last interval.
        let rates: Vec<(u64, String)> = h.intervals.iter().map(|i| (i.games, format!("{:.1}", i.rate))).collect();
        assert_eq!(rates, vec![(68, "15.1".to_string()), (146, "14.8".to_string())]);
        let r = h.recent.unwrap();
        assert_eq!(r.games, 214);
        assert!((r.rate - 14.9).abs() < 0.1, "{}", r.rate);
        assert!(r.effective_games < 214.0 && r.effective_games > 150.0);
        assert!(h.trend_points_per_30_days.is_none(), "two intervals aren't a trend");
        assert!(h.notes.is_empty(), "{:?}", h.notes);
    }

    #[test]
    fn duplicates_count_once_and_conflicts_are_dropped() {
        let mut s = rohan();
        s.push(snap("2026-09-06", 331, 22.02));
        s.push(snap("2026-08-06", 270, 23.0));
        let h = history(s, at("2026-10-29"), 180);
        assert_eq!(h.snapshots.len(), 4);
        assert_eq!(h.snapshots[0].as_of, at("2026-09-06"));
        assert!(h.notes.iter().any(|n| n.contains("conflicting")));
    }

    #[test]
    fn a_falling_count_restarts_the_chain_and_future_snapshots_wait() {
        let s = vec![
            snap("2026-06-01", 500, 25.0),
            snap("2026-07-01", 100, 20.0),
            snap("2026-08-01", 200, 22.0),
            snap("2026-12-01", 300, 30.0),
        ];
        let h = history(s, at("2026-10-29"), 180);
        assert_eq!(h.snapshots.len(), 2);
        assert_eq!(h.intervals.len(), 1);
        assert!((h.intervals[0].rate - 24.0).abs() < 1e-9);
        assert_eq!(h.notes.len(), 2, "{:?}", h.notes);
    }

    #[test]
    fn same_games_with_a_new_rate_is_a_revision() {
        let s = vec![
            snap("2026-08-01", 100, 20.0),
            snap("2026-08-02", 100, 21.0),
            snap("2026-09-01", 200, 22.0),
        ];
        let h = history(s, at("2026-10-29"), 180);
        assert_eq!(h.snapshots.len(), 2);
        assert!((h.intervals[0].rate - 23.0).abs() < 1e-9);
    }

    #[test]
    fn too_few_new_games_stand_alone_with_a_note() {
        let h = history(
            vec![snap("2026-08-01", 100, 20.0), snap("2026-09-01", 110, 20.5)],
            at("2026-10-29"),
            180,
        );
        assert_eq!(h.intervals.len(), 1);
        assert_eq!(h.intervals[0].games, 10);
        assert!(h.notes[0].contains("only 10 new games"));
        assert!(history(vec![snap("2026-08-01", 100, 20.0)], at("2026-10-29"), 180).recent.is_none());
    }

    #[test]
    fn out_of_range_intervals_are_left_out() {
        // 100 games at 50% then 140 at 10%: the 40 new games would imply −90%.
        let h = history(
            vec![snap("2026-08-01", 100, 50.0), snap("2026-09-01", 140, 10.0)],
            at("2026-10-29"),
            180,
        );
        assert!(h.intervals.is_empty());
        assert!(h.recent.is_none());
        assert!(h.notes[0].contains("out of range"));
    }

    #[test]
    fn recency_favours_newer_intervals_and_trend_has_a_sign() {
        let s = vec![
            snap("2026-01-01", 100, 30.0),
            snap("2026-03-01", 200, 30.0),
            snap("2026-05-01", 300, 26.666_666_666_666_668),
            snap("2026-07-01", 400, 25.0),
        ];
        // Intervals: 30%, then 20%, then 20%.
        let h = history(s, at("2026-07-01"), 180);
        let rates: Vec<String> = h.intervals.iter().map(|i| format!("{:.1}", i.rate)).collect();
        assert_eq!(rates, vec!["30.0", "20.0", "20.0"]);
        let r = h.recent.unwrap();
        assert!(r.rate < 100.0 * 70.0 / 300.0 && r.rate > 20.0, "{}", r.rate);
        assert!(h.trend_points_per_30_days.unwrap() < 0.0);
        let long = recent(&h.intervals, at("2026-07-01"), 3650).unwrap();
        assert!(
            (long.rate - 70.0 / 3.0).abs() < 0.2,
            "a long half-life is close to the plain games-weighted mean"
        );
    }
}
