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
#[cfg(test)]
pub fn templates(field: usize, count: usize, seed: u64) -> Vec<Template> {
    templates_with(field, 0, count, seed)
}

/// `count` templates over a field of `field` decks (at least POD - 1) whose first `every` decks
/// (at most POD - 1) sit in every pod; the other seats are picked as [`templates`] picks them.
/// With `every` = 0 the schedule is exactly [`templates`]'s.
pub fn templates_with(field: usize, every: usize, count: usize, seed: u64) -> Vec<Template> {
    assert!(field >= POD - 1, "the field needs at least {} decks", POD - 1);
    assert!(every < POD, "at most {} decks in every pod", POD - 1);
    let mut rng = Mix::new(seed ^ 0x5EED_0F_7E57_u64);
    let mut seeds = Mix::new(seed);
    let mut used = vec![0usize; field];
    let mut seat_count = vec![[0usize; POD]; field];
    let mut pairs: std::collections::HashMap<(usize, usize), usize> = std::collections::HashMap::new();
    let mut out = Vec::with_capacity(count);
    for t in 0..count {
        let open = t % POD;
        let mut members: Vec<usize> = (0..every).collect();
        for _ in every..POD - 1 {
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

/// One list played as it is: the base list alone plays every template in the open seat. Play
/// order 2t, as a paired schedule's base games, so nothing ever pairs a solo game with another.
pub fn schedule_solo(prefix: &str, templates: &[Template], field_ids: &[String], difficulty: &str, limits: &Limits) -> Vec<ScheduledGame> {
    templates
        .iter()
        .map(|t| {
            let decks = t.seats.iter().map(|s| s.map_or_else(|| BASE_ID.to_string(), |d| field_ids[d].clone())).collect();
            let game = format!("{prefix}-{}-solo", t.index);
            ScheduledGame {
                game: game.clone(),
                ord: (t.index * 2) as i64,
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
            }
        })
        .collect()
}

/// Head-to-head games: `entrants` (their deck ids, 2 to `pod`) all sit in every game, with
/// `pod - entrants.len()` seats filled from `fillers`. Games come in blocks of `pod`: a block keeps
/// one seating order and one set of fillers and rotates it a seat at a time, so each player sits
/// in every seat (seat 0 goes first) once per block. Each block takes the next ordering of the
/// entrants (all orderings in turn, from a seeded shuffle) and the least-used fillers (seeded
/// tie-break). Play order 2g, so no two games are ever treated as a pair. Everything comes from
/// `seed`.
#[allow(clippy::too_many_arguments)]
pub fn schedule_versus(
    prefix: &str,
    entrants: &[String],
    fillers: &[String],
    pod: usize,
    games: usize,
    seed: u64,
    difficulty: &str,
    limits: &Limits,
) -> Vec<ScheduledGame> {
    let need = pod.saturating_sub(entrants.len());
    assert!(entrants.len() >= 2 && entrants.len() <= pod, "2 to {pod} entrants");
    assert!(fillers.len() >= need, "the field needs {need} decks");
    let mut rng = Mix::new(seed ^ 0x7E25_05_0F_u64);
    let mut seeds = Mix::new(seed);
    let idx: Vec<usize> = (0..entrants.len()).collect();
    let mut orders = permutations(&idx);
    // A seeded shuffle of the orderings, so a short run doesn't always start the same way.
    for i in (1..orders.len()).rev() {
        let j = rng.below(i + 1);
        orders.swap(i, j);
    }
    let mut used = vec![0usize; fillers.len()];
    let mut out = Vec::with_capacity(games);
    let mut g = 0usize;
    let mut block = 0usize;
    while g < games {
        let order = &orders[block % orders.len()];
        let mut picked: Vec<usize> = Vec::with_capacity(need);
        for _ in 0..need {
            let best = (0..fillers.len())
                .filter(|f| !picked.contains(f))
                .map(|f| (used[f] as f64 + rng.unit() * 0.5, f))
                .min_by(|a, b| a.0.total_cmp(&b.0))
                .expect("enough fillers")
                .1;
            used[best] += 1;
            picked.push(best);
        }
        // The block's seating: entrants in this ordering, fillers spread between them.
        let mut ring: Vec<String> = Vec::with_capacity(pod);
        let mut fill = picked.iter();
        for (k, e) in order.iter().enumerate() {
            ring.push(entrants[*e].clone());
            if k < need {
                if let Some(f) = fill.next() {
                    ring.push(fillers[*f].clone());
                }
            }
        }
        for f in fill {
            ring.push(fillers[*f].clone());
        }
        for r in 0..pod {
            if g >= games {
                break;
            }
            let decks: Vec<String> = (0..pod).map(|s| ring[(s + r) % pod].clone()).collect();
            let game = format!("{prefix}-{g}-vs");
            out.push(ScheduledGame {
                game: game.clone(),
                ord: (g * 2) as i64,
                spec: GameSpec {
                    game,
                    seed: seeds.next_u64(),
                    decks,
                    difficulty: difficulty.to_string(),
                    max_turns: limits.max_turns,
                    max_actions: limits.max_actions,
                    max_seconds: limits.max_seconds,
                    pilots: None,
                },
            });
            g += 1;
        }
        block += 1;
    }
    out
}

/// A shared field: least-used entrants first, then least-met opponents, with seeded tie breaks.
/// Each chosen quartet plays four fresh-seed games, once in every seat. Appearances are rounded
/// up to a multiple of four; a non-multiple-of-four field can overshoot a target by four games.
/// `families` gives each entrant a group (versions of one deck share one): among the least-used
/// entrants, one from a group already at the table is taken only when nobody else is left.
#[allow(clippy::too_many_arguments)]
pub fn schedule_tournament(run: &str, entrants: &[String], families: &[usize], target: usize, seed: u64, difficulty: &str, limits: &Limits) -> Vec<ScheduledGame> {
    assert!(entrants.len() >= POD && target > 0);
    assert_eq!(families.len(), entrants.len(), "a family per entrant");
    let n = entrants.len();
    let mut rng = Mix::new(seed);
    let mut used = vec![0usize; n];
    let mut meetings = vec![vec![0usize; n]; n];
    let mut games = Vec::new();
    while used.iter().any(|u| *u < target) {
        let mut group = Vec::with_capacity(POD);
        for _ in 0..POD {
            let kin = |i: usize| group.iter().any(|j: &usize| families[*j] == families[i]);
            let best = (0..n).filter(|i| !group.contains(i)).map(|i| {
                let met: usize = group.iter().map(|j: &usize| meetings[i][*j]).sum();
                ((used[i], kin(i), met, rng.next_u64()), i)
            }).min_by_key(|(cost, _)| *cost).expect("four distinct entrants").1;
            group.push(best);
        }
        for &i in &group { used[i] += POD; }
        for a in 0..POD { for b in a + 1..POD {
            meetings[group[a]][group[b]] += POD;
            meetings[group[b]][group[a]] += POD;
        }}
        for rotation in 0..POD {
            let decks = (0..POD).map(|seat| entrants[group[(seat + rotation) % POD]].clone()).collect();
            let game = format!("{run}-{}-t", games.len());
            games.push(ScheduledGame { game: game.clone(), ord: (games.len() * 2) as i64, spec: GameSpec {
                game, seed: rng.next_u64() & ((1u64 << 53) - 1), decks,
                difficulty: difficulty.into(), max_turns: limits.max_turns, max_actions: limits.max_actions,
                max_seconds: limits.max_seconds, pilots: None,
            }});
        }
    }
    games
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

    #[test]
    fn solo_games_play_each_template_once_in_the_open_seat() {
        let field: Vec<String> = (0..10).map(|i| format!("precons/p{i}")).collect();
        let ts = templates(field.len(), 12, 7);
        let games = schedule_solo("abcd1234", &ts, &field, "Easy", &LIMITS);
        assert_eq!(games.len(), 12);
        for (g, t) in games.iter().zip(&ts) {
            assert_eq!(g.ord, (t.index * 2) as i64);
            assert_eq!(g.spec.decks[t.seat], BASE_ID);
            assert_eq!(g.spec.decks.iter().filter(|d| *d == BASE_ID).count(), 1);
            assert!(!g.spec.decks.iter().any(|d| d == VARIANT_ID));
        }
    }

    #[test]
    fn versus_rotates_every_entrant_through_every_seat() {
        let entrants: Vec<String> = (0..3).map(|i| format!("e{i}")).collect();
        let fillers: Vec<String> = (0..6).map(|i| format!("precons/p{i}")).collect();
        let games = schedule_versus("abcd1234", &entrants, &fillers, 4, 96, 9, "Easy", &LIMITS);
        assert_eq!(games.len(), 96);
        let mut seat_count: HashMap<(String, usize), usize> = HashMap::new();
        for g in &games {
            assert_eq!(g.spec.decks.len(), 4);
            for e in &entrants {
                assert_eq!(g.spec.decks.iter().filter(|d| *d == e).count(), 1, "every entrant in every game");
            }
            assert_eq!(g.spec.decks.iter().filter(|d| d.starts_with("precons/")).count(), 1, "one filler seat");
            for (s, d) in g.spec.decks.iter().enumerate() {
                *seat_count.entry((d.clone(), s)).or_default() += 1;
            }
            assert_eq!(g.ord % 2, 0, "never paired");
        }
        for e in &entrants {
            for s in 0..4 {
                assert_eq!(seat_count[&(e.clone(), s)], 24, "{e} sits in seat {s} once per block");
            }
        }
        // Fillers are spread out: 24 blocks over 6 precons, 4 each.
        for f in &fillers {
            let blocks = games.iter().filter(|g| g.spec.decks.contains(f)).count() / 4;
            assert_eq!(blocks, 4, "{f}");
        }
        // Same seed, same schedule.
        assert_eq!(games, schedule_versus("abcd1234", &entrants, &fillers, 4, 96, 9, "Easy", &LIMITS));
    }

    #[test]
    fn versus_one_on_one_and_four_entrants_need_no_fillers() {
        let two = vec!["e0".to_string(), "e1".to_string()];
        let games = schedule_versus("x", &two, &[], 2, 10, 3, "Easy", &LIMITS);
        assert_eq!(games.len(), 10);
        assert_eq!(games.iter().filter(|g| g.spec.decks[0] == "e0").count(), 5, "each goes first half the time");
        let four: Vec<String> = (0..4).map(|i| format!("e{i}")).collect();
        let games = schedule_versus("x", &four, &[], 4, 100, 3, "Easy", &LIMITS);
        assert_eq!(games.len(), 100);
        for e in &four {
            assert_eq!(games.iter().filter(|g| g.spec.decks[0] == *e).count(), 25, "{e} goes first a quarter of the time");
        }
    }

    #[test]
    fn decks_kept_in_every_pod_sit_in_every_pod_and_rotate_seats() {
        let ts = templates_with(12, 1, 40, 5);
        assert_eq!(ts.len(), 40);
        let mut seats = [0usize; POD];
        for t in &ts {
            assert!(t.seats.contains(&Some(0)), "deck 0 is in every pod");
            let s = t.seats.iter().position(|d| *d == Some(0)).unwrap();
            seats[s] += 1;
            let others: HashSet<usize> = t.seats.iter().flatten().copied().collect();
            assert_eq!(others.len(), POD - 1, "three different opponents");
        }
        assert!(seats.iter().filter(|n| **n > 0).count() >= 3, "it moves around the table: {seats:?}");
        // every = 0 is the plain schedule.
        assert_eq!(templates_with(12, 0, 40, 5), templates(12, 40, 5));
    }
}

#[cfg(test)]
mod tournament_tests {
    use super::*;
    #[test]
    fn tournament_balances_large_and_uneven_fields_and_is_reproducible() {
        for n in [4, 5, 7, 14, 193] {
            let ids: Vec<String> = (0..n).map(|i| format!("e{i}")).collect();
            let own: Vec<usize> = (0..n).collect();
            let a = schedule_tournament("test", &ids, &own, 100, 42, "Easy", &LIMITS);
            assert_eq!(a, schedule_tournament("test", &ids, &own, 100, 42, "Easy", &LIMITS));
            assert_ne!(a, schedule_tournament("test", &ids, &own, 100, 43, "Easy", &LIMITS));
            let mut seats = vec![[0usize; 4]; n];
            let mut unique = std::collections::HashSet::new();
            for g in &a {
                assert!(unique.insert(g.game.clone()));
                assert_eq!(g.spec.decks.iter().collect::<std::collections::HashSet<_>>().len(), 4);
                for (seat, id) in g.spec.decks.iter().enumerate() {
                    seats[id[1..].parse::<usize>().unwrap()][seat] += 1;
                }
            }
            for counts in seats {
                assert!(counts.iter().all(|x| *x == counts[0]), "each deck has exactly equal seats");
                assert!((100..=104).contains(&counts.iter().sum::<usize>()));
            }
            assert!(a.len() <= (n * 104).div_ceil(4), "no wasteful repeated whole-field tests");
        }
    }

    #[test]
    fn versions_of_one_deck_keep_apart_and_the_field_stays_balanced() {
        // A field like Bryan's 2026-10-27 run: eight decks in three versions each, among 170 others.
        let n = 194;
        let ids: Vec<String> = (0..n).map(|i| format!("e{i}")).collect();
        let families: Vec<usize> = (0..n).map(|i| if i < 24 { i % 8 } else { i }).collect();
        let a = schedule_tournament("test", &ids, &families, 100, 42, "Easy", &LIMITS);
        let mut used = vec![0usize; n];
        for g in &a {
            let fam: std::collections::HashSet<usize> = g.spec.decks.iter().map(|d| families[d[1..].parse::<usize>().unwrap()]).collect();
            assert_eq!(fam.len(), 4, "two versions of one deck at a table: {:?}", g.spec.decks);
            for d in &g.spec.decks {
                used[d[1..].parse::<usize>().unwrap()] += 1;
            }
        }
        assert!(used.iter().all(|u| (100..=104).contains(u)), "appearances stay balanced: {used:?}");
        // A field that is all one deck still plays: the rule gives way when nobody else is left.
        let same = vec![0usize; 5];
        let five: Vec<String> = (0..5).map(|i| format!("e{i}")).collect();
        assert!(!schedule_tournament("test", &five, &same, 8, 1, "Easy", &LIMITS).is_empty());
    }
}
