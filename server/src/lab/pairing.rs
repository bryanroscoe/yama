//! Paired schedules for "Try a change", as commander-decks' `schedule.py --mode paired` builds
//! them: a number of pod templates, each three opponents from the field in fixed seats, one open
//! seat for the list being tested, and a seed. The base list and the changed list each play every
//! template in the open seat with the same seed, so only the list differs between a pair's games.
//!
//! The open seat cycles through the four seats (template t uses seat t % 4). Seat 0 takes the first
//! turn (the lab core's rule, as in the batch runner), so each list goes first in a quarter of
//! the pods. Opponents are picked least-used first (then fewest meetings with the pod's others)
//! with a seeded random tie-break, and seated so each uses each seat about equally. Everything is
//! derived from the experiment's seed, so the same seed gives the same schedule.

use yama_play::lab::{GameSpec, MAX_TURN_ACTIONS};

use super::stats::{BASE_ID, VARIANT_ID};

/// Players per pod.
pub const POD: usize = 4;
/// Candidates looked at per pick when the field is large (schedule.py's default).
const CANDIDATES: usize = 64;

/// Per-game limits, the batch schedules' defaults for 4-player pods (schedule.py), so an
/// experiment's games are played like a rating run's.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Limits {
    pub max_turns: u32,
    pub max_actions: usize,
    /// CPU seconds of the game's own thread.
    pub max_seconds: u64,
    /// The lab core's per-turn loop guard.
    pub turn_action_cap: usize,
}

pub const LIMITS: Limits = Limits { max_turns: 120, max_actions: 200_000, max_seconds: 600, turn_action_cap: MAX_TURN_ACTIONS };

/// SplitMix64: a small, well-mixed generator; stable across platforms and releases.
#[derive(Debug, Clone)]
pub struct Mix(u64);

impl Mix {
    pub fn new(seed: u64) -> Self {
        Mix(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in 0..n (n > 0).
    pub fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }
}

/// One pod template: who sits where, and the seed both lists play it with.
#[derive(Debug, Clone, PartialEq)]
pub struct Template {
    pub index: usize,
    pub seed: u64,
    /// The tested list's seat.
    pub seat: usize,
    /// Field deck (index into the field) per seat; `None` at the tested list's seat.
    pub seats: Vec<Option<usize>>,
}

fn pair_key(a: usize, b: usize) -> (usize, usize) {
    (a.min(b), a.max(b))
}

/// `count` templates over a field of `field` decks (at least POD - 1).
pub fn templates(field: usize, count: usize, seed: u64) -> Vec<Template> {
    assert!(field >= POD - 1, "the field needs at least {} decks", POD - 1);
    let mut rng = Mix::new(seed ^ 0x5EED_0F_7E57_u64);
    let mut seeds = Mix::new(seed);
    let mut used = vec![0usize; field];
    let mut seat_count = vec![[0usize; POD]; field];
    let mut pairs: std::collections::HashMap<(usize, usize), usize> = std::collections::HashMap::new();
    let mut out = Vec::with_capacity(count);
    for t in 0..count {
        let open = t % POD;
        let mut members: Vec<usize> = Vec::with_capacity(POD - 1);
        for _ in 0..POD - 1 {
            let mut pool: Vec<usize> = (0..field).filter(|c| !members.contains(c)).collect();
            if pool.len() > CANDIDATES {
                // A seeded partial shuffle: the first CANDIDATES are a random sample.
                for i in 0..CANDIDATES {
                    let j = i + rng.below(pool.len() - i);
                    pool.swap(i, j);
                }
                pool.truncate(CANDIDATES);
            }
            let mut best: Option<(f64, usize)> = None;
            for c in pool {
                let meetings: usize = members.iter().map(|m| pairs.get(&pair_key(*m, c)).copied().unwrap_or(0)).sum();
                let cost = (used[c] * 100 + meetings) as f64 + rng.unit() * 0.5;
                if best.is_none_or(|(b, _)| cost < b) {
                    best = Some((cost, c));
                }
            }
            members.push(best.expect("the pool is never empty").1);
        }
        let seats: Vec<usize> = (0..POD).filter(|s| *s != open).collect();
        let mut best: Option<(f64, Vec<usize>)> = None;
        for perm in permutations(&members) {
            let cost = perm.iter().zip(&seats).map(|(d, s)| seat_count[*d][*s]).sum::<usize>() as f64 + rng.unit() * 0.5;
            if best.as_ref().is_none_or(|(b, _)| cost < *b) {
                best = Some((cost, perm));
            }
        }
        let order = best.expect("three members have permutations").1;
        let mut row = vec![None; POD];
        for (d, s) in order.iter().zip(&seats) {
            row[*s] = Some(*d);
            seat_count[*d][*s] += 1;
            used[*d] += 1;
        }
        for i in 0..members.len() {
            for j in i + 1..members.len() {
                *pairs.entry(pair_key(members[i], members[j])).or_default() += 1;
            }
        }
        out.push(Template { index: t, seed: seeds.next_u64(), seat: open, seats: row });
    }
    out
}

fn permutations(items: &[usize]) -> Vec<Vec<usize>> {
    if items.len() <= 1 {
        return vec![items.to_vec()];
    }
    let mut out = Vec::new();
    for i in 0..items.len() {
        let mut rest = items.to_vec();
        let first = rest.remove(i);
        for mut p in permutations(&rest) {
            p.insert(0, first);
            out.push(p);
        }
    }
    out
}

/// One game to store: its id, its play order and its schedule line.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduledGame {
    pub game: String,
    /// 2t for the base list's game of template t, 2t + 1 for the changed list's: a pod's two games
    /// are adjacent, so a part-played experiment's games stay paired.
    pub ord: i64,
    pub spec: GameSpec,
}

/// The paired games for `templates`: the base list then the changed list, per template. Field
/// decks are named by `field_ids` (their deck ids in the experiment). Game ids start with
/// `prefix` so log lines name the experiment.
pub fn schedule(prefix: &str, templates: &[Template], field_ids: &[String], difficulty: &str, limits: &Limits) -> Vec<ScheduledGame> {
    let mut out = Vec::with_capacity(templates.len() * 2);
    for t in templates {
        for (k, (list, label)) in [(BASE_ID, "base"), (VARIANT_ID, "variant")].into_iter().enumerate() {
            let decks = t.seats.iter().map(|s| s.map_or_else(|| list.to_string(), |d| field_ids[d].clone())).collect();
            let game = format!("{prefix}-{}-{label}", t.index);
            out.push(ScheduledGame {
                game: game.clone(),
                ord: (t.index * 2 + k) as i64,
                spec: GameSpec {
                    game,
                    seed: t.seed,
                    decks,
                    difficulty: difficulty.to_string(),
                    max_turns: limits.max_turns,
                    max_actions: limits.max_actions,
                    max_seconds: limits.max_seconds,
                    pilots: None,
                },
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn base_and_variant_play_the_same_pod_with_the_same_seed() {
        let field: Vec<String> = (0..20).map(|i| format!("precons/p{i}")).collect();
        let ts = templates(field.len(), 50, 42);
        let games = schedule("abcd1234", &ts, &field, "Easy", &LIMITS);
        assert_eq!(games.len(), 100);
        let seeds: HashSet<u64> = ts.iter().map(|t| t.seed).collect();
        assert_eq!(seeds.len(), 50, "every pod has its own seed");
        for pair in games.chunks(2) {
            let (b, v) = (&pair[0], &pair[1]);
            let t = &ts[(b.ord / 2) as usize];
            assert_eq!((b.ord % 2, v.ord), (0, b.ord + 1));
            assert_eq!(b.spec.seed, v.spec.seed);
            assert_eq!(b.spec.seed, t.seed);
            assert_eq!(b.spec.decks[t.seat], "base");
            assert_eq!(v.spec.decks[t.seat], "variant");
            for s in 0..POD {
                if s != t.seat {
                    assert_eq!(b.spec.decks[s], v.spec.decks[s], "same opponent in seat {s}");
                    assert!(b.spec.decks[s].starts_with("precons/"));
                }
            }
            let opponents: HashSet<&String> = b.spec.decks.iter().filter(|d| d.starts_with("precons/")).collect();
            assert_eq!(opponents.len(), 3, "three different opponents");
            assert_eq!((b.spec.max_turns, b.spec.max_actions, b.spec.max_seconds), (120, 200_000, 600));
            assert_eq!(b.spec.difficulty, "Easy");
            assert!(b.game.starts_with("abcd1234-") && b.game.ends_with("-base") && v.game.ends_with("-variant"));
        }
    }

    #[test]
    fn the_open_seat_rotates_and_the_field_is_used_evenly() {
        let ts = templates(12, 120, 7);
        for t in &ts {
            assert_eq!(t.seat, t.index % POD);
            assert_eq!(t.seats[t.seat], None);
            assert_eq!(t.seats.iter().flatten().count(), 3);
        }
        // 120 pods x 3 opponents over 12 decks: 30 each.
        let mut used: HashMap<usize, usize> = HashMap::new();
        let mut seat_use: HashMap<(usize, usize), usize> = HashMap::new();
        for t in &ts {
            for (s, d) in t.seats.iter().enumerate() {
                if let Some(d) = d {
                    *used.entry(*d).or_default() += 1;
                    *seat_use.entry((*d, s)).or_default() += 1;
                }
            }
        }
        assert!(used.values().all(|n| *n == 30), "{used:?}");
        // Each deck sits in each seat about a quarter of the time.
        for d in 0..12 {
            let per_seat: Vec<usize> = (0..POD).map(|s| seat_use.get(&(d, s)).copied().unwrap_or(0)).collect();
            assert!(per_seat.iter().max().unwrap() - per_seat.iter().min().unwrap() <= 3, "deck {d}: {per_seat:?}");
        }
    }

    #[test]
    fn same_seed_same_schedule_and_a_large_field_works() {
        assert_eq!(templates(174, 200, 99), templates(174, 200, 99));
        assert_ne!(templates(174, 200, 99), templates(174, 200, 100));
        let ts = templates(174, 200, 99);
        let distinct: HashSet<usize> = ts.iter().flat_map(|t| t.seats.iter().flatten().copied()).collect();
        assert!(distinct.len() > 150, "a large field is spread out: {} decks used", distinct.len());
        // The smallest field: the same three every time, in rotating seats.
        let small = templates(3, 8, 1);
        assert!(small.iter().all(|t| t.seats.iter().flatten().copied().collect::<HashSet<_>>() == HashSet::from([0, 1, 2])));
    }
}
