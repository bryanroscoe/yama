//! Stats from finished games: playgroup tables, rivalries, turn order, win conditions and results
//! per deck version. Loading is one pass over the games in scope; everything after that is pure
//! functions over `GameFacts`, so the rules below are unit-tested without a database.
//!
//! Honesty rules (the Group page shows them): every rate travels with its count, anything under
//! `PROVISIONAL_UNDER` games is marked provisional, a player's win rate sits next to the share
//! they'd win by chance (1/N averaged over their pods), and missing data is counted as missing
//! instead of being folded into a guess.
//!
//! Unlike things stay apart (2026-11-11):
//! - The computer isn't a player. Its seats take no row, and nobody's rivalry is with it. It can
//!   still win, so the share a person would win by chance stays 1/N over every seat at the
//!   table: at a table of two people and two computers that is one in four, and a game the
//!   computer wins is a loss for everyone. A game with fewer than two people (solo against the
//!   computer, or a table of one) is in nobody's record, and the playgroup's page leaves it out
//!   of every figure (`playgroups::stats_for`). A deck's games against only the computer are
//!   counted separately (`results_against_computer`).
//! - `games.turns` counts rounds at the table and every player's turn online (the engine's turn
//!   number), so the two are averaged separately (`average_turns`, `average_online_turns`).
//! - Commander stats come from Commander games only; a Constructed game has no commander.

use crate::error::AppResult;
use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap};

/// Rates from fewer games than this are shown faded and labelled provisional.
pub const PROVISIONAL_UNDER: i64 = 5;

/// Allowed `games.win_condition` values, in the order the app offers them.
pub const WIN_CONDITIONS: [&str; 8] = ["combat", "commander_damage", "combo", "alternate", "mill", "poison", "concession", "other"];

/// playgroup.gg's win rate by turn order in 4-player pods (single-winner games), shown beside a
/// playgroup's own numbers until it has `SEAT_REFERENCE_UNTIL` games of its own.
pub const SEAT_REFERENCE: SeatReference = SeatReference {
    players: 4,
    rates: [29.2, 25.7, 23.6, 21.5],
    games: 284_950,
    source: "playgroup.gg",
    url: "https://playgroup.gg/commander/turn-order",
    computed: "2026-10-19",
    show_until_games: 20,
};

#[derive(Serialize, Clone, Copy)]
pub struct SeatReference {
    pub players: usize,
    /// Percent, first player first.
    pub rates: [f64; 4],
    pub games: i64,
    pub source: &'static str,
    pub url: &'static str,
    /// The date playgroup.gg stamped on the numbers (read the same day).
    pub computed: &'static str,
    pub show_until_games: i64,
}

#[derive(Clone, Debug, Default)]
pub struct SeatFacts {
    pub seat: i64,
    /// Who this is across games: the account if there is one, else the playgroup member, else
    /// the typed name. Accounts come first so a friend picked as "me" or from the member list
    /// counts as one person.
    pub key: String,
    pub name: String,
    pub user_id: Option<String>,
    pub member_id: Option<String>,
    /// The computer played this seat (an online game's AI seat).
    pub ai: bool,
    pub deck_version_id: Option<String>,
    /// A person (not the computer) played this seat with a deck their own account owns. Only
    /// these seats count toward a deck version's results: online games put the host's decks in
    /// the AI's seats.
    pub own_deck: bool,
    pub deck_label: Option<String>,
    pub commander_name: Option<String>,
    pub final_life: Option<i64>,
    pub eliminated_turn: Option<i64>,
    pub eliminated_by_seat: Option<i64>,
    pub fun: Option<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct GameFacts {
    pub id: String,
    pub mode: String,
    /// `games.format`: "commander", "standard" (Constructed) or "other".
    pub format: String,
    pub starting_life: i64,
    pub playgroup_name: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub turns: Option<i64>,
    pub winner_seat: Option<i64>,
    pub first_seat: Option<i64>,
    pub win_condition: Option<String>,
    pub note: Option<String>,
    /// In turn order (clockwise): seat order, unless the table swapped places mid-game.
    pub seats: Vec<SeatFacts>,
}

/// Two players traded places at the table (the life counter's `swap_places` event): turn order
/// goes around their new places, so the seats move in the list. Seats not in the game are ignored.
fn swap_places(seats: &mut [SeatFacts], a: i64, b: i64) {
    if let (Some(i), Some(j)) = (seats.iter().position(|s| s.seat == a), seats.iter().position(|s| s.seat == b)) {
        seats.swap(i, j);
    }
}

impl GameFacts {
    pub fn seat(&self, seat: i64) -> Option<&SeatFacts> {
        self.seats.iter().find(|s| s.seat == seat)
    }

    /// The seats people played, in seat order: everyone but the computer.
    pub fn people(&self) -> impl Iterator<Item = &SeatFacts> {
        self.seats.iter().filter(|s| !s.ai)
    }

    /// Two or more people played, so the game belongs in their records. A game with one person
    /// (solo against the computer, or a table of one) has nobody to compare them with.
    pub fn between_people(&self) -> bool {
        self.people().count() >= 2
    }

    /// One person played and the computer had every other seat.
    pub fn against_computer(&self) -> bool {
        self.people().count() == 1 && self.seats.iter().any(|s| s.ai)
    }

    /// `turns` counts every player's turn (the engine's turn number) rather than rounds.
    pub fn counts_player_turns(&self) -> bool {
        self.mode == "online"
    }

    /// 1 for the first player, counting clockwise; `None` without a recorded first seat.
    pub fn turn_position(&self, seat: i64) -> Option<usize> {
        let first = self.seats.iter().position(|s| Some(s.seat) == self.first_seat)?;
        let me = self.seats.iter().position(|s| s.seat == seat)?;
        Some((me + self.seats.len() - first) % self.seats.len() + 1)
    }

    pub fn result_for(&self, seat: i64) -> &'static str {
        match self.winner_seat {
            None => "draw",
            Some(w) if w == seat => "win",
            Some(_) => "loss",
        }
    }

    /// Minutes from start to end, when both are real. Games logged afterwards carry the same
    /// time for both, which says nothing about how long they took.
    pub fn minutes(&self) -> Option<f64> {
        let start = chrono::DateTime::parse_from_rfc3339(&self.started_at).ok()?;
        let end = chrono::DateTime::parse_from_rfc3339(self.ended_at.as_deref()?).ok()?;
        let mins = (end - start).num_seconds() as f64 / 60.0;
        (mins > 0.0).then_some(mins)
    }

    /// Seats knocked out first (the lowest recorded knockout turn; ties all count). Empty when
    /// no knockout was recorded.
    pub fn first_out(&self) -> Vec<i64> {
        let Some(min) = self.seats.iter().filter_map(|s| s.eliminated_turn).min() else { return vec![] };
        self.seats.iter().filter(|s| s.eliminated_turn == Some(min)).map(|s| s.seat).collect()
    }

    /// The last losers standing: those still in when the winner was recorded, or else the ones
    /// knocked out last. Only for games with a winner and at least one recorded knockout.
    pub fn last_out(&self) -> Vec<i64> {
        let Some(winner) = self.winner_seat else { return vec![] };
        if self.seats.iter().all(|s| s.eliminated_turn.is_none()) {
            return vec![];
        }
        let losers: Vec<&SeatFacts> = self.seats.iter().filter(|s| s.seat != winner).collect();
        let standing: Vec<i64> = losers.iter().filter(|s| s.eliminated_turn.is_none()).map(|s| s.seat).collect();
        if !standing.is_empty() {
            return standing;
        }
        let Some(max) = losers.iter().filter_map(|s| s.eliminated_turn).max() else { return vec![] };
        losers.iter().filter(|s| s.eliminated_turn == Some(max)).map(|s| s.seat).collect()
    }
}

// ── loading ────────────────────────────────────────────────────────────────

/// Which finished games to load. Each maps to a constant SQL condition on `games g`.
pub enum Scope<'a> {
    Playgroup(&'a str),
    /// Games the user recorded or sat in.
    User(&'a str),
    /// Games where the deck's owner played a version of it (not the computer with it).
    Deck(&'a str),
}

impl Scope<'_> {
    fn condition(&self) -> &'static str {
        match self {
            Scope::Playgroup(_) => "g.playgroup_id = ?1",
            Scope::User(_) => "(g.created_by = ?1 OR EXISTS (SELECT 1 FROM game_seats us WHERE us.game_id = g.id AND us.user_id = ?1))",
            Scope::Deck(_) => {
                "EXISTS (SELECT 1 FROM game_seats ds JOIN deck_versions dv ON dv.id = ds.deck_version_id JOIN decks dd ON dd.id = dv.deck_id
                         WHERE ds.game_id = g.id AND dv.deck_id = ?1 AND ds.ai_kind IS NULL AND ds.user_id = dd.owner_id)"
            }
        }
    }
    fn value(&self) -> &str {
        match self {
            Scope::Playgroup(v) | Scope::User(v) | Scope::Deck(v) => v,
        }
    }
}

type GameRow = (String, String, Option<String>, String, Option<String>, Option<i64>, Option<i64>, Option<i64>, Option<String>, Option<String>, String, i64);

#[derive(sqlx::FromRow)]
struct SeatRow {
    game_id: String,
    seat: i64,
    member_id: Option<String>,
    user_id: Option<String>,
    guest_name: Option<String>,
    ai_kind: Option<String>,
    deck_version_id: Option<String>,
    own_deck: bool,
    deck_label: Option<String>,
    commander_name: Option<String>,
    final_life: Option<i64>,
    eliminated_turn: Option<i64>,
    eliminated_by_seat: Option<i64>,
    fun: Option<i64>,
    name: String,
}

/// Finished games in scope, oldest first (by end, then start), each with its seats.
pub async fn finished_games(pool: &SqlitePool, scope: Scope<'_>) -> AppResult<Vec<GameFacts>> {
    let cond = scope.condition();
    let rows: Vec<GameRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT g.id, g.mode, p.name, g.started_at, g.ended_at, g.turns, g.winner_seat, g.first_seat,
                g.win_condition, g.note, g.format, g.starting_life
         FROM games g LEFT JOIN playgroups p ON p.id = g.playgroup_id
         WHERE g.status = 'finished' AND {cond}
         ORDER BY COALESCE(g.ended_at, g.started_at), g.started_at, g.id"
    )))
    .bind(scope.value())
    .fetch_all(pool)
    .await?;
    let seats: Vec<SeatRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT s.game_id, s.seat, s.member_id, s.user_id, s.guest_name, s.ai_kind, s.deck_version_id,
                COALESCE(s.ai_kind IS NULL AND sd.owner_id = s.user_id, 0) AS own_deck, s.deck_label,
                s.commander_name, s.final_life, s.eliminated_turn, s.eliminated_by_seat, s.fun,
                COALESCE(u.display_name, s.guest_name, m.guest_name, s.ai_kind, 'Unknown') AS name
         FROM game_seats s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN playgroup_members m ON m.id = s.member_id
              LEFT JOIN deck_versions sv ON sv.id = s.deck_version_id LEFT JOIN decks sd ON sd.id = sv.deck_id
         WHERE s.game_id IN (SELECT g.id FROM games g WHERE g.status = 'finished' AND {cond})
         ORDER BY s.game_id, s.seat"
    )))
    .bind(scope.value())
    .fetch_all(pool)
    .await?;
    let mut by_game: HashMap<String, Vec<SeatFacts>> = HashMap::new();
    for s in seats {
        // The computer's seat is its own in every game (an online game names it after its
        // commander, which must not read as a guest of that name).
        let key = match (&s.ai_kind, &s.user_id, &s.member_id, &s.guest_name) {
            (Some(_), ..) => format!("ai:{}:{}", s.game_id, s.seat),
            (None, Some(u), ..) => format!("u:{u}"),
            (None, None, Some(m), _) => format!("m:{m}"),
            (None, None, None, Some(g)) => format!("g:{g}"),
            _ => format!("seat:{}:{}", s.game_id, s.seat),
        };
        by_game.entry(s.game_id.clone()).or_default().push(SeatFacts {
            seat: s.seat,
            key,
            name: s.name,
            user_id: s.user_id,
            member_id: s.member_id,
            ai: s.ai_kind.is_some(),
            deck_version_id: s.deck_version_id,
            own_deck: s.own_deck,
            deck_label: s.deck_label,
            commander_name: s.commander_name,
            final_life: s.final_life,
            eliminated_turn: s.eliminated_turn,
            eliminated_by_seat: s.eliminated_by_seat,
            fun: s.fun,
        });
    }
    // Places swapped mid-game, in the order they happened.
    let swaps: Vec<(String, String)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT e.game_id, e.payload FROM game_events e
         WHERE e.kind = 'swap_places' AND e.game_id IN (SELECT g.id FROM games g WHERE g.status = 'finished' AND {cond})
         ORDER BY e.game_id, e.seq"
    )))
    .bind(scope.value())
    .fetch_all(pool)
    .await?;
    for (game_id, payload) in swaps {
        let Ok(e) = serde_json::from_str::<serde_json::Value>(&payload) else { continue };
        if let (Some(seats), Some(a), Some(b)) = (by_game.get_mut(&game_id), e["a"].as_i64(), e["b"].as_i64()) {
            swap_places(seats, a, b);
        }
    }
    Ok(rows
        .into_iter()
        .map(|(id, mode, playgroup_name, started_at, ended_at, turns, winner_seat, first_seat, win_condition, note, format, starting_life)| GameFacts {
            seats: by_game.remove(&id).unwrap_or_default(),
            id,
            mode,
            format,
            starting_life,
            playgroup_name,
            started_at,
            ended_at,
            turns,
            winner_seat,
            first_seat,
            win_condition,
            note,
        })
        .filter(|g| !g.seats.is_empty())
        .collect())
}

// ── playgroup stats ────────────────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
pub struct Streak {
    /// "win" (won the last `games` in a row) or "no_win" (no win in the last `games`).
    pub kind: &'static str,
    pub games: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Nemesis {
    /// Everyone tied for the most knockouts of this player.
    pub names: Vec<String>,
    pub knockouts: i64,
    /// Knockouts of this player with a recorded knocker.
    pub of: i64,
}

#[derive(Serialize, Debug)]
pub struct PlayerStat {
    pub key: String,
    pub name: String,
    pub member_id: Option<String>,
    pub games: i64,
    pub wins: i64,
    pub draws: i64,
    /// The share of games they'd win by chance: 1/N averaged over their pods.
    pub expected: f64,
    pub streak: Option<Streak>,
    /// Games where they went out first, out of `knockout_games`: their games with at least one
    /// recorded knockout.
    pub first_out: i64,
    pub knockout_games: i64,
    /// Games where they were among the last losers standing, out of `last_out_games`: their
    /// games with a recorded knockout and a winner.
    pub last_out: i64,
    pub last_out_games: i64,
    pub knockouts: i64,
    pub archnemesis: Option<Nemesis>,
    /// Average fun rating and how many ratings it's from.
    pub fun: Option<f64>,
    pub fun_ratings: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct CommanderStat {
    pub commander: String,
    pub games: i64,
    pub wins: i64,
    pub expected: f64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct PositionStat {
    /// 1 = took the first turn.
    pub position: usize,
    pub wins: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct PodSeats {
    pub players: usize,
    /// Games of this size with a recorded first seat and a single winner.
    pub games: i64,
    pub positions: Vec<PositionStat>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ConditionCount {
    pub condition: &'static str,
    pub games: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct WinConditions {
    /// Games with a winner.
    pub decided: i64,
    pub recorded: Vec<ConditionCount>,
    pub not_recorded: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct HeadToHead {
    pub a: String,
    pub a_name: String,
    pub b: String,
    pub b_name: String,
    /// Times `a` knocked out `b`, and the other way round.
    pub a_over_b: i64,
    pub b_over_a: i64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Average {
    pub value: f64,
    pub games: i64,
}

fn average(values: impl Iterator<Item = f64>) -> Option<Average> {
    let (sum, n) = values.fold((0.0, 0i64), |(s, n), v| (s + v, n + 1));
    (n > 0).then(|| Average { value: sum / n as f64, games: n })
}

/// Average length in rounds, from games at the table and logged ones.
pub fn average_turns(games: &[GameFacts]) -> Option<Average> {
    average(games.iter().filter(|g| !g.counts_player_turns()).filter_map(|g| g.turns).map(|t| t as f64))
}

/// Average length of online games, counting every player's turn (the engine's turn number).
pub fn average_online_turns(games: &[GameFacts]) -> Option<Average> {
    average(games.iter().filter(|g| g.counts_player_turns()).filter_map(|g| g.turns).map(|t| t as f64))
}

pub fn average_minutes(games: &[GameFacts]) -> Option<Average> {
    average(games.iter().filter_map(GameFacts::minutes))
}

/// Who knocked out whom, by player key: (knocker, knocked) → times. Self-knockouts, knockouts
/// with no recorded knocker and knockouts by or of the computer are left out.
fn knockouts(games: &[GameFacts]) -> BTreeMap<(String, String), i64> {
    let mut out = BTreeMap::new();
    for g in games {
        for s in g.people() {
            let Some(by) = s.eliminated_by_seat.and_then(|b| g.seat(b)).filter(|by| !by.ai) else { continue };
            if by.key == s.key {
                continue;
            }
            *out.entry((by.key.clone(), s.key.clone())).or_insert(0) += 1;
        }
    }
    out
}

fn names(games: &[GameFacts]) -> HashMap<String, String> {
    // The newest name wins (people rename themselves; removed members keep their last name).
    let mut names = HashMap::new();
    for g in games {
        for s in g.people() {
            names.insert(s.key.clone(), s.name.clone());
        }
    }
    names
}

pub fn players(games: &[GameFacts]) -> Vec<PlayerStat> {
    let names = names(games);
    let kos = knockouts(games);
    let mut order: Vec<String> = Vec::new();
    let mut stats: HashMap<String, PlayerStat> = HashMap::new();
    let mut history: HashMap<String, Vec<bool>> = HashMap::new();
    let mut expected_sum: HashMap<String, f64> = HashMap::new();
    let mut fun: HashMap<String, (i64, i64)> = HashMap::new();
    for g in games.iter().filter(|g| g.between_people()) {
        // The chance of winning if every seat were equally likely to: the computer has no row
        // here, but it can win the game.
        let n = g.seats.len() as f64;
        let first_out = g.first_out();
        let last_out = g.last_out();
        let knockout_game = g.seats.iter().any(|s| s.eliminated_turn.is_some());
        for s in g.people() {
            let p = stats.entry(s.key.clone()).or_insert_with(|| {
                order.push(s.key.clone());
                PlayerStat {
                    key: s.key.clone(),
                    name: names[&s.key].clone(),
                    member_id: None,
                    games: 0,
                    wins: 0,
                    draws: 0,
                    expected: 0.0,
                    streak: None,
                    first_out: 0,
                    knockout_games: 0,
                    last_out: 0,
                    last_out_games: 0,
                    knockouts: 0,
                    archnemesis: None,
                    fun: None,
                    fun_ratings: 0,
                }
            });
            if s.member_id.is_some() {
                p.member_id = s.member_id.clone();
            }
            p.games += 1;
            let won = g.winner_seat == Some(s.seat);
            p.wins += i64::from(won);
            p.draws += i64::from(g.winner_seat.is_none());
            p.first_out += i64::from(first_out.contains(&s.seat));
            p.knockout_games += i64::from(knockout_game);
            p.last_out += i64::from(last_out.contains(&s.seat));
            p.last_out_games += i64::from(knockout_game && g.winner_seat.is_some());
            *expected_sum.entry(s.key.clone()).or_default() += 1.0 / n;
            history.entry(s.key.clone()).or_default().push(won);
            if let Some(f) = s.fun {
                let e = fun.entry(s.key.clone()).or_default();
                e.0 += f;
                e.1 += 1;
            }
        }
    }
    let mut out: Vec<PlayerStat> = order.into_iter().filter_map(|k| stats.remove(&k)).collect();
    for p in &mut out {
        p.expected = expected_sum[&p.key] / p.games as f64;
        p.streak = streak(&history[&p.key]);
        p.knockouts = kos.iter().filter(|((by, _), _)| *by == p.key).map(|(_, n)| n).sum();
        p.archnemesis = archnemesis(&kos, &p.key, &names);
        if let Some((sum, n)) = fun.get(&p.key) {
            p.fun = Some(*sum as f64 / *n as f64);
            p.fun_ratings = *n;
        }
    }
    out.sort_by(|a, b| b.wins.cmp(&a.wins).then(b.games.cmp(&a.games)).then(a.name.cmp(&b.name)));
    out
}

/// The current run, from the newest game back: wins in a row, or games without a win (draws
/// aren't wins).
pub fn streak(results: &[bool]) -> Option<Streak> {
    let last = *results.last()?;
    let games = results.iter().rev().take_while(|w| **w == last).count() as i64;
    Some(Streak { kind: if last { "win" } else { "no_win" }, games })
}

fn archnemesis(kos: &BTreeMap<(String, String), i64>, player: &str, names: &HashMap<String, String>) -> Option<Nemesis> {
    let against: Vec<(&String, i64)> = kos.iter().filter(|((_, knocked), _)| knocked == player).map(|((by, _), n)| (by, *n)).collect();
    let best = against.iter().map(|(_, n)| *n).max()?;
    let mut tied: Vec<String> = against.iter().filter(|(_, n)| *n == best).map(|(by, _)| names[*by].clone()).collect();
    tied.sort();
    Some(Nemesis { names: tied, knockouts: best, of: against.iter().map(|(_, n)| n).sum() })
}

pub fn head_to_head(games: &[GameFacts]) -> Vec<HeadToHead> {
    let names = names(games);
    let kos = knockouts(games);
    let mut pairs: BTreeMap<(String, String), (i64, i64)> = BTreeMap::new();
    for ((by, knocked), n) in &kos {
        // One entry per pair, keyed in sorted order; count which way each knockout went.
        if by < knocked {
            pairs.entry((by.clone(), knocked.clone())).or_default().0 += n;
        } else {
            pairs.entry((knocked.clone(), by.clone())).or_default().1 += n;
        }
    }
    let mut out: Vec<HeadToHead> = pairs
        .into_iter()
        .map(|((x, y), (x_over_y, y_over_x))| {
            // The one with more knockouts reads first.
            let (a, b, a_over_b, b_over_a) = if y_over_x > x_over_y { (y, x, y_over_x, x_over_y) } else { (x, y, x_over_y, y_over_x) };
            HeadToHead { a_name: names[&a].clone(), b_name: names[&b].clone(), a, b, a_over_b, b_over_a }
        })
        .collect();
    out.sort_by(|p, q| (q.a_over_b + q.b_over_a).cmp(&(p.a_over_b + p.b_over_a)).then(p.a_name.cmp(&q.a_name)));
    out
}

/// Games with at least one recorded knockout: the count first-out and last-out are out of.
pub fn knockout_games(games: &[GameFacts]) -> i64 {
    games.iter().filter(|g| g.seats.iter().any(|s| s.eliminated_turn.is_some())).count() as i64
}

/// Each commander's record across the people who played it, from Commander games between
/// people. A game in another format has no commander (not one called "Unknown"), and the
/// computer piloting a deck isn't the playgroup playing that commander.
pub fn commanders(games: &[GameFacts]) -> Vec<CommanderStat> {
    let mut map: BTreeMap<String, (i64, i64, f64)> = BTreeMap::new();
    for g in games.iter().filter(|g| g.format == "commander" && g.between_people()) {
        let n = g.seats.len() as f64;
        for s in g.people() {
            let name = s.commander_name.clone().or(s.deck_label.clone()).unwrap_or_else(|| "Unknown".into());
            let e = map.entry(name).or_default();
            e.0 += 1;
            e.1 += i64::from(g.winner_seat == Some(s.seat));
            e.2 += 1.0 / n;
        }
    }
    let mut out: Vec<CommanderStat> =
        map.into_iter().map(|(commander, (games, wins, exp))| CommanderStat { commander, games, wins, expected: exp / games as f64 }).collect();
    out.sort_by(|a, b| b.wins.cmp(&a.wins).then(b.games.cmp(&a.games)).then(a.commander.cmp(&b.commander)));
    out
}

/// Win rate by place in turn order, per pod size, from games with a first seat and a winner.
pub fn seats(games: &[GameFacts]) -> Vec<PodSeats> {
    let mut pods: BTreeMap<usize, (i64, Vec<i64>)> = BTreeMap::new();
    for g in games {
        let (Some(_), Some(winner)) = (g.first_seat, g.winner_seat) else { continue };
        let Some(pos) = g.turn_position(winner) else { continue };
        let n = g.seats.len();
        let e = pods.entry(n).or_insert_with(|| (0, vec![0; n]));
        e.0 += 1;
        e.1[pos - 1] += 1;
    }
    pods.into_iter()
        .map(|(players, (games, wins))| PodSeats {
            players,
            games,
            positions: wins.into_iter().enumerate().map(|(i, wins)| PositionStat { position: i + 1, wins }).collect(),
        })
        .collect()
}

/// Games with a winner but no recorded first seat (left out of `seats`).
pub fn seats_unknown(games: &[GameFacts]) -> i64 {
    games.iter().filter(|g| g.winner_seat.is_some() && g.turn_position(g.winner_seat.unwrap()).is_none()).count() as i64
}

pub fn win_conditions(games: &[GameFacts]) -> WinConditions {
    let decided: Vec<&GameFacts> = games.iter().filter(|g| g.winner_seat.is_some()).collect();
    let recorded = WIN_CONDITIONS
        .iter()
        .map(|c| ConditionCount { condition: c, games: decided.iter().filter(|g| g.win_condition.as_deref() == Some(*c)).count() as i64 })
        .filter(|c| c.games > 0)
        .collect::<Vec<_>>();
    let counted: i64 = recorded.iter().map(|c| c.games).sum();
    WinConditions { decided: decided.len() as i64, not_recorded: decided.len() as i64 - counted, recorded }
}

// ── results per deck version ───────────────────────────────────────────────

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Record {
    pub games: i64,
    pub wins: i64,
    pub losses: i64,
    pub draws: i64,
}

/// Wins, losses and draws for each deck version that played against other people, by version
/// id. Only seats where a person played their own deck count (`SeatFacts::own_deck`), so the
/// computer piloting your deck online isn't your deck's record, and a mirror match counts once.
/// Games against only the computer are apart, in `results_against_computer`.
pub fn results_by_version(games: &[GameFacts]) -> HashMap<String, Record> {
    version_results(games.iter().filter(|g| g.between_people()))
}

/// The same for games one person played against the computer alone (solo online games).
pub fn results_against_computer(games: &[GameFacts]) -> HashMap<String, Record> {
    version_results(games.iter().filter(|g| g.against_computer()))
}

fn version_results<'a>(games: impl Iterator<Item = &'a GameFacts>) -> HashMap<String, Record> {
    let mut out: HashMap<String, Record> = HashMap::new();
    for g in games {
        for s in &g.seats {
            let Some(v) = s.deck_version_id.as_ref().filter(|_| s.own_deck) else { continue };
            let r = out.entry(v.clone()).or_default();
            r.games += 1;
            match g.result_for(s.seat) {
                "win" => r.wins += 1,
                "draw" => r.draws += 1,
                _ => r.losses += 1,
            }
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn seat(seat: i64, key: &str) -> SeatFacts {
        SeatFacts { seat, key: key.into(), name: key.to_uppercase(), ..Default::default() }
    }

    pub fn game(id: &str, keys: &[&str], winner: Option<i64>) -> GameFacts {
        GameFacts {
            id: id.into(),
            mode: "in_person".into(),
            format: "commander".into(),
            starting_life: 40,
            started_at: format!("2026-10-{:02}T19:00:00Z", 1 + id.len() % 28),
            seats: keys.iter().enumerate().map(|(i, k)| seat(i as i64, k)).collect(),
            winner_seat: winner,
            ..Default::default()
        }
    }

    fn out(g: &mut GameFacts, seat: i64, turn: i64, by: Option<i64>) {
        let s = g.seats.iter_mut().find(|s| s.seat == seat).unwrap();
        s.eliminated_turn = Some(turn);
        s.eliminated_by_seat = by;
    }

    #[test]
    fn turn_position_counts_clockwise_from_the_first_seat() {
        let mut g = game("g", &["a", "b", "c", "d"], Some(0));
        assert_eq!(g.turn_position(0), None);
        g.first_seat = Some(2);
        assert_eq!([0, 1, 2, 3].map(|s| g.turn_position(s)), [Some(3), Some(4), Some(1), Some(2)]);
    }

    #[test]
    fn turn_position_follows_places_swapped_mid_game() {
        let mut g = game("g", &["a", "b", "c", "d"], Some(2));
        g.first_seat = Some(0);
        // Seats 0 and 2 traded places: clockwise is now 2, 1, 0, 3.
        swap_places(&mut g.seats, 0, 2);
        swap_places(&mut g.seats, 0, 9);
        assert_eq!([0, 1, 2, 3].map(|s| g.turn_position(s)), [Some(1), Some(4), Some(3), Some(2)]);
    }

    #[test]
    fn seat_stats_need_a_first_seat_and_a_winner() {
        let mut a = game("a", &["a", "b", "c", "d"], Some(2));
        a.first_seat = Some(2); // first player won
        let mut b = game("bb", &["a", "b", "c", "d"], Some(0));
        b.first_seat = Some(1); // fourth player won
        let mut draw = game("ccc", &["a", "b", "c", "d"], None);
        draw.first_seat = Some(0);
        let unknown = game("dddd", &["a", "b", "c", "d"], Some(1));
        let mut three = game("eeeee", &["a", "b", "c"], Some(1));
        three.first_seat = Some(0);
        let games = vec![a, b, draw, unknown, three];
        let pods = seats(&games);
        assert_eq!(pods.len(), 2);
        assert_eq!(pods[0], PodSeats { players: 3, games: 1, positions: vec![
            PositionStat { position: 1, wins: 0 }, PositionStat { position: 2, wins: 1 }, PositionStat { position: 3, wins: 0 },
        ] });
        assert_eq!(pods[1].games, 2);
        assert_eq!(pods[1].positions.iter().map(|p| p.wins).collect::<Vec<_>>(), vec![1, 0, 0, 1]);
        assert_eq!(seats_unknown(&games), 1);
    }

    #[test]
    fn players_get_expected_share_streaks_and_draws() {
        let games = vec![
            game("1", &["a", "b", "c", "d"], Some(0)),
            game("22", &["a", "b"], Some(0)),
            game("333", &["a", "b", "c"], None),
            game("4444", &["a", "b", "c"], Some(1)),
            game("55555", &["a", "b", "c"], Some(1)),
        ];
        let ps = players(&games);
        let a = ps.iter().find(|p| p.key == "a").unwrap();
        assert_eq!((a.games, a.wins, a.draws), (5, 2, 1));
        assert!((a.expected - (0.25 + 0.5 + 3.0 / 3.0) / 5.0).abs() < 1e-9);
        assert_eq!(a.streak, Some(Streak { kind: "no_win", games: 3 }));
        let b = ps.iter().find(|p| p.key == "b").unwrap();
        assert_eq!(b.streak, Some(Streak { kind: "win", games: 2 }));
        let d = ps.iter().find(|p| p.key == "d").unwrap();
        assert_eq!((d.games, d.expected), (1, 0.25));
        // Most wins first.
        assert_eq!(ps[0].wins, 2);
    }

    #[test]
    fn knockouts_feed_head_to_head_archnemesis_and_first_and_last_out() {
        let mut g1 = game("1", &["a", "b", "c", "d"], Some(0));
        out(&mut g1, 3, 4, Some(0)); // a knocks out d first
        out(&mut g1, 2, 6, Some(1)); // b knocks out c
        out(&mut g1, 1, 7, Some(0)); // a knocks out b last
        let mut g2 = game("22", &["a", "b", "c", "d"], Some(1));
        out(&mut g2, 0, 5, Some(1)); // b knocks out a; c and d still in at the end
        out(&mut g2, 3, 5, Some(3)); // d knocks themselves out: not a rivalry
        let g3 = game("333", &["a", "b", "c", "d"], Some(2)); // no knockouts recorded
        let games = vec![g1, g2, g3];

        assert_eq!(knockout_games(&games), 2);
        assert_eq!(games[0].first_out(), vec![3]);
        assert_eq!(games[0].last_out(), vec![1]);
        assert_eq!(games[1].first_out(), vec![0, 3]); // tied on turn 5
        assert_eq!(games[1].last_out(), vec![2]); // still standing when b won
        assert!(games[2].first_out().is_empty() && games[2].last_out().is_empty());

        let h = head_to_head(&games);
        let ab = h.iter().find(|p| [&p.a, &p.b] == [&"a".to_string(), &"b".to_string()] || [&p.a, &p.b] == [&"b".to_string(), &"a".to_string()]).unwrap();
        assert_eq!((ab.a.as_str(), ab.a_over_b, ab.b_over_a), ("a", 1, 1));
        assert!(h.iter().all(|p| p.a != p.b));

        let ps = players(&games);
        let get = |k: &str| ps.iter().find(|p| p.key == k).unwrap();
        assert_eq!(get("a").knockouts, 2);
        assert_eq!(get("b").archnemesis, Some(Nemesis { names: vec!["A".into()], knockouts: 1, of: 1 }));
        assert_eq!(get("d").archnemesis, Some(Nemesis { names: vec!["A".into()], knockouts: 1, of: 1 }));
        assert_eq!(get("c").archnemesis, Some(Nemesis { names: vec!["B".into()], knockouts: 1, of: 1 }));
        assert_eq!((get("d").first_out, get("d").last_out), (2, 0));
        assert_eq!(get("c").last_out, 1);
        // Each count is out of that player's own games with a knockout recorded.
        assert_eq!((get("a").knockout_games, get("a").last_out_games), (2, 2));
        let mut g4 = game("4444", &["a", "z"], Some(0)); // z's only game: no knockout recorded
        g4.turns = Some(5);
        let mut g5 = game("55555", &["a", "b"], None); // a draw with a knockout: no last out
        out(&mut g5, 1, 3, Some(0));
        let ps = players(&[games, vec![g4, g5]].concat());
        let get = |k: &str| ps.iter().find(|p| p.key == k).unwrap();
        assert_eq!((get("z").knockout_games, get("z").last_out_games), (0, 0));
        assert_eq!((get("b").first_out, get("b").knockout_games, get("b").last_out_games), (1, 3, 2));
    }

    #[test]
    fn archnemesis_lists_ties() {
        let mut g1 = game("1", &["a", "b", "c"], Some(1));
        out(&mut g1, 0, 3, Some(1));
        let mut g2 = game("22", &["a", "b", "c"], Some(2));
        out(&mut g2, 0, 3, Some(2));
        let ps = players(&[g1, g2]);
        let a = ps.iter().find(|p| p.key == "a").unwrap();
        assert_eq!(a.archnemesis, Some(Nemesis { names: vec!["B".into(), "C".into()], knockouts: 1, of: 2 }));
    }

    #[test]
    fn win_conditions_count_missing_answers_separately() {
        let mut a = game("1", &["a", "b"], Some(0));
        a.win_condition = Some("combat".into());
        let mut b = game("22", &["a", "b"], Some(1));
        b.win_condition = Some("combo".into());
        let mut c = game("333", &["a", "b"], Some(1));
        c.win_condition = Some("combat".into());
        let d = game("4444", &["a", "b"], Some(1));
        let draw = game("55555", &["a", "b"], None);
        let w = win_conditions(&[a, b, c, d, draw]);
        assert_eq!(w.decided, 4);
        assert_eq!(w.not_recorded, 1);
        assert_eq!(w.recorded, vec![ConditionCount { condition: "combat", games: 2 }, ConditionCount { condition: "combo", games: 1 }]);
    }

    #[test]
    fn averages_skip_missing_turns_and_logged_games_without_a_length() {
        let mut a = game("1", &["a", "b"], Some(0));
        a.turns = Some(8);
        a.ended_at = Some("2026-10-02T20:30:00Z".into());
        a.started_at = "2026-10-02T19:00:00Z".into();
        let mut logged = game("22", &["a", "b"], Some(0));
        logged.ended_at = Some(logged.started_at.clone()); // logged afterwards: no length
        let games = vec![a, logged];
        assert_eq!(average_turns(&games), Some(Average { value: 8.0, games: 1 }));
        assert_eq!(average_minutes(&games), Some(Average { value: 90.0, games: 1 }));
    }

    /// Seats `ai` are the computer's, as an online game stores them: named after their commander.
    fn online(id: &str, keys: &[&str], ai: &[i64], winner: Option<i64>) -> GameFacts {
        let mut g = game(id, keys, winner);
        g.mode = "online".into();
        for s in g.seats.iter_mut().filter(|s| ai.contains(&s.seat)) {
            s.ai = true;
            s.key = format!("ai:{id}:{}", s.seat);
            s.name = "Atraxa, Praetors' Voice".into();
            s.commander_name = Some(s.name.clone());
        }
        g
    }

    #[test]
    fn the_computer_is_not_a_player_but_can_still_win() {
        // Two people and two computers: four seats could win, so an even share is one in four.
        let mut mixed = online("1", &["a", "b", "x", "y"], &[2, 3], Some(2));
        out(&mut mixed, 0, 6, Some(2)); // the computer knocks a out
        out(&mut mixed, 1, 8, Some(0)); // a (already out, but recorded so) knocks b out
        // Solo against three computers: nobody to compare with.
        let solo = online("22", &["a", "x", "y", "z"], &[1, 2, 3], Some(0));
        let table = game("333", &["a", "b"], Some(0));
        let games = vec![mixed, solo, table];
        let ps = players(&games);
        assert_eq!(ps.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        let a = ps.iter().find(|p| p.key == "a").unwrap();
        assert_eq!((a.games, a.wins), (2, 1), "the solo win isn't in the record");
        assert!((a.expected - (0.25 + 0.5) / 2.0).abs() < 1e-9);
        // The game the computer won is a loss for both people.
        assert_eq!(ps.iter().map(|p| p.wins).sum::<i64>(), 1);
        // The computer's knockout of a is nobody's rivalry; a's knockout of b is.
        assert_eq!(a.archnemesis, None);
        assert_eq!(a.knockouts, 1);
        assert_eq!(head_to_head(&games).len(), 1);
        // A person can still be first out of a game the computer played in.
        assert_eq!((a.first_out, a.knockout_games), (1, 1));
        // The computer's commanders aren't the playgroup's.
        assert!(commanders(&games).iter().all(|c| c.commander != "Atraxa, Praetors' Voice"));
    }

    #[test]
    fn commander_stats_come_from_commander_games_only() {
        let mut edh = game("1", &["a", "b"], Some(0));
        edh.seats[0].commander_name = Some("Éowyn, Shieldmaiden".into());
        let mut constructed = game("22", &["a", "b"], Some(1));
        constructed.format = "standard".into();
        let cs = commanders(&[edh, constructed.clone()]);
        // Only the Commander game: one named commander and one seat that didn't say.
        assert_eq!(cs.iter().map(|c| (c.commander.as_str(), c.games)).collect::<Vec<_>>(), vec![("Éowyn, Shieldmaiden", 1), ("Unknown", 1)]);
        assert!(commanders(&[constructed.clone()]).is_empty());
        // The players' records still count every format.
        assert_eq!(players(&[constructed])[0].games, 1);
    }

    #[test]
    fn rounds_and_player_turns_are_averaged_apart() {
        let mut table = game("1", &["a", "b", "c", "d"], Some(0));
        table.turns = Some(9); // rounds
        let mut net = online("22", &["a", "b", "c", "d"], &[], Some(0));
        net.turns = Some(33); // every player's turn
        let games = vec![table, net];
        assert_eq!(average_turns(&games), Some(Average { value: 9.0, games: 1 }));
        assert_eq!(average_online_turns(&games), Some(Average { value: 33.0, games: 1 }));
    }

    #[test]
    fn a_decks_games_against_the_computer_are_counted_apart() {
        let mut real = game("1", &["a", "b"], Some(1));
        let mut solo = online("22", &["a", "x", "y"], &[1, 2], Some(0));
        let mut mixed = online("333", &["a", "b", "x"], &[2], Some(0));
        // A table of one isn't a result of either kind.
        let mut alone = game("4444", &["a"], Some(0));
        for g in [&mut real, &mut solo, &mut mixed, &mut alone] {
            g.seats[0].deck_version_id = Some("v1".into());
            g.seats[0].own_deck = true;
        }
        // The computer piloting the same list is never the deck's record.
        solo.seats[1].deck_version_id = Some("v1".into());
        let games = [real, solo, mixed, alone];
        assert_eq!(results_by_version(&games)["v1"], Record { games: 2, wins: 1, losses: 1, draws: 0 });
        assert_eq!(results_against_computer(&games)["v1"], Record { games: 1, wins: 1, losses: 0, draws: 0 });
    }

    #[test]
    fn results_by_version_count_wins_losses_and_draws() {
        let played = |g: &mut GameFacts, seat: usize, v: &str, own: bool| {
            g.seats[seat].deck_version_id = Some(v.into());
            g.seats[seat].own_deck = own;
        };
        let mut g1 = game("1", &["a", "b"], Some(0));
        played(&mut g1, 0, "v1", true);
        let mut g2 = game("22", &["a", "b"], Some(1));
        played(&mut g2, 0, "v1", true);
        played(&mut g2, 1, "v1", false); // the computer with the same deck: not the deck's record
        let mut g3 = game("333", &["a", "b"], None);
        played(&mut g3, 0, "v2", true);
        let r = results_by_version(&[g1, g2, g3]);
        assert_eq!(r["v1"], Record { games: 2, wins: 1, losses: 1, draws: 0 });
        assert_eq!(r["v2"], Record { games: 1, wins: 0, losses: 0, draws: 1 });
    }
}
