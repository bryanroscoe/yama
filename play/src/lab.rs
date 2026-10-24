//! Simulation lab core: plays one all-AI Commander game from a schedule line and reports its
//! result line. The batch runner (`src/bin/lab.rs`) and the server's experiments both use it.
//! Design: commander-decks docs/deck-lab-plan.md.
//!
//! The schedule line ([`GameSpec`]), the result line ([`GameResult`]) and the deck file format
//! ([`parse_deck`]) are the lab's shared contract; keep them in step with the Python side
//! (commander-decks scripts/sim/). A result line for a given schedule line must not change when
//! this code is refactored (apart from `ms`, and `runner`, which names the build).
//!
//! Each game is built the way Yama's play crate builds one (same name resolution, same setup),
//! with phase's AI on every seat in measurement mode: its search is bounded by node and depth
//! budgets, never the clock.
//!
//! Limits. A game that ends by a win, a draw, max_turns, max_actions or the per-turn loop guard
//! depends only on its schedule line: replayed on any machine, under any load, it is the same
//! game. max_seconds caps the CPU time of the game's own thread (end "time_cap"). Time spent
//! waiting for a core doesn't count, so machine load doesn't move that cap, but a slower machine
//! still reaches it sooner, so the analysis doesn't score time_cap games. A wall-clock safety net
//! (WALL_FACTOR x max_seconds) ends a game as an error, never as a scored result.
//!
//! Failures. [`play_game_isolated`] runs a game panic-isolated on its own thread, named after the
//! game, so a stack overflow or abort (which nothing in the process can catch, and which ends the
//! process) names the game in the log. A game publishes where it is to a [`Live`] before every
//! step, so a watchdog can write off a game stuck inside one engine or AI step
//! ([`hung_result`]).
//!
//! Three differences from live Yama games: seat 0 always takes the first turn (live games roll a
//! d20), so a schedule's seat rotation is a rotation of turn order; when the AI returns no
//! action, phase's own `fallback_action` answers from the engine-issued options; and a turn with
//! more than MAX_TURN_ACTIONS AI actions is treated as a loop and ends the game as an action cap.
//! The last two happen only where a live game would stop or loop, and are reported in the game's
//! notes with what caused them.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use engine::ai_support::AiDecisionContract;
use engine::database::CardDatabase;
use engine::game::deck_loading::{DeckList, PlayerDeckList};
use engine::game::engine::{apply_interaction, apply_verified_ai_priority_pass, verified_ai_stack_pass_player};
use engine::game::replay::reconstruct_initial_state;
use engine::types::format::FormatConfig;
use engine::types::game_state::{GameState, WaitingFor};
use engine::types::log::GameLogEntry;
use engine::types::match_config::MatchConfig;
use engine::types::player::PlayerId;
use engine::types::replay::ReplayHeader;
use phase_ai::auto_play::eligible_ai_decision;
use phase_ai::config::{ACCEPTED_DIFFICULTY_LABELS, AiConfig, AiDifficulty, Platform, create_config_for_players};
use phase_ai::search::choose_action_with_session;
use phase_ai::session::AiSession;
use rand::SeedableRng;
use rand::rngs::StdRng;
use serde::{Deserialize, Serialize};

use crate::pilot::{LlmRequest, LlmSeatStats, LlmTransport, Pilot};
use crate::{DeckLine, Engine, SeatDeck};

/// The engine label every result line carries. Since 22 Oct 2026 the fork carries
/// patches/phase/0002-0008: the AI fixes ("+aifix": Omo's counters, man-lands, land
/// copies), the free-for-all tempo changes ("+tempo") and the two-player endgame
/// change ("+endgame"). Since 24 Oct 2026 it also carries 0010-0011, two fixes for AI
/// decisions that could run without end ("+stallfix"). Results under an earlier label are
/// another engine and must not be pooled with these.
pub const ENGINE: &str = "phase-rs v0.113.0+aifix+tempo+endgame+stallfix";
/// The source this crate was built from (see build.rs): a short SHA, or
/// "<sha>-dirty-<source hash>" for uncommitted changes.
pub const RUNNER: &str = env!("YAMA_LAB_RUNNER");
/// Deep AI search overflows the default stack; phase and soak.rs use 32 MiB too.
pub const STACK: usize = 32 << 20;
/// The wall-clock safety net is this many times max_seconds. It only matters on a machine so
/// overloaded that a game gets well under a quarter of a core; a game it stops is an error.
pub const WALL_FACTOR: u64 = 4;
/// Physical contests settled per game before giving up (phase's own driver caps each batch).
const MAX_SETTLEMENTS: usize = 1_000;
/// AI actions allowed within one turn before the game is written off as an action cap (a loop).
/// Real 4-player games average under 60 actions per turn and under 5,000 per game (pilots,
/// 2026-10-18). The batch runner's YAMA_LAB_MAX_TURN_ACTIONS overrides it; 0 turns the guard off.
pub const MAX_TURN_ACTIONS: usize = 3_000;
/// Result-file error text of games whose decks didn't load (older runners wrote such lines).
pub const DECK_ERRORS: &str = "deck errors:";
/// Labels for the last actions before the action cap, so a stall names the loop it was in.
const STALL_WINDOW: usize = 2_000;

/// Lock a mutex even if a panicking thread poisoned it (the data is plain bookkeeping).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// CPU time used so far by the calling thread, in seconds. Unlike wall-clock time it doesn't grow
/// while the thread waits for a core, so the load on the machine doesn't change where it runs out.
pub fn thread_cpu_secs() -> Option<f64> {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: clock_gettime only writes the timespec it is given.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    (rc == 0).then(|| ts.tv_sec as f64 + ts.tv_nsec as f64 * 1e-9)
}

/// "card-data-eb309108eb0df708.json" -> "eb309108eb0df708".
pub fn card_data_hash(path: &Path) -> String {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    match stem.strip_prefix("card-data-") {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => "unknown".into(),
    }
}

// ---------------------------------------------------------------------------------------------
// Schedule and result lines

/// One schedule line: a game to play. Deck ids name decks the caller resolves (the batch runner:
/// paths under its decks root without ".txt").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GameSpec {
    pub game: String,
    pub seed: u64,
    pub decks: Vec<String>,
    pub difficulty: String,
    pub max_turns: u32,
    pub max_actions: usize,
    pub max_seconds: u64,
    /// Who plays each seat, in seat order ([`Pilot::parse`] labels: "easy", "hard",
    /// "llm:claude-haiku-5-5", ...). Absent: every seat plays at `difficulty`. An LLM seat falls
    /// back to `difficulty` for any decision the model doesn't settle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pilots: Option<Vec<String>>,
}

impl GameSpec {
    /// Read and check one schedule line.
    pub fn parse(line: &str) -> Result<(GameSpec, AiDifficulty), String> {
        let spec: GameSpec = serde_json::from_str(line).map_err(|e| e.to_string())?;
        let difficulty = spec.check()?;
        Ok((spec, difficulty))
    }

    /// The checks a schedule line must pass; returns its AI level.
    pub fn check(&self) -> Result<AiDifficulty, String> {
        if !(2..=6).contains(&self.decks.len()) {
            return Err(format!("game {}: {} decks; a Commander game here has 2 to 6", self.game, self.decks.len()));
        }
        if !ACCEPTED_DIFFICULTY_LABELS.iter().any(|l| l.eq_ignore_ascii_case(self.difficulty.trim())) {
            return Err(format!("game {}: unknown difficulty {:?} (accepted: {})", self.game, self.difficulty, ACCEPTED_DIFFICULTY_LABELS.join(", ")));
        }
        if self.max_turns == 0 || self.max_actions == 0 || self.max_seconds == 0 {
            return Err(format!("game {}: max_turns, max_actions and max_seconds must be positive", self.game));
        }
        self.seat_pilots()?;
        Ok(AiDifficulty::from_label(&self.difficulty))
    }

    /// Each seat's pilot: the schedule's `pilots`, or `difficulty` on every seat.
    pub fn seat_pilots(&self) -> Result<Vec<Pilot>, String> {
        match &self.pilots {
            None => Ok(vec![Pilot::Heuristic(AiDifficulty::from_label(&self.difficulty)); self.decks.len()]),
            Some(labels) => {
                if labels.len() != self.decks.len() {
                    return Err(format!("game {}: {} pilots for {} decks", self.game, labels.len(), self.decks.len()));
                }
                labels.iter().map(|l| Pilot::parse(l).map_err(|e| format!("game {}: {e}", self.game))).collect()
            }
        }
    }

    /// Whether any seat is played by a language model (such games don't replay identically).
    pub fn has_llm(&self) -> bool {
        self.seat_pilots().is_ok_and(|p| p.iter().any(Pilot::is_llm))
    }
}

/// How a game ended. `Panic` and `Error` are failures, never scored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum End {
    Win,
    Draw,
    TurnCap,
    ActionCap,
    TimeCap,
    Panic,
    Error,
}

impl End {
    pub fn as_str(self) -> &'static str {
        match self {
            End::Win => "win",
            End::Draw => "draw",
            End::TurnCap => "turn_cap",
            End::ActionCap => "action_cap",
            End::TimeCap => "time_cap",
            End::Panic => "panic",
            End::Error => "error",
        }
    }

    pub fn failed(self) -> bool {
        matches!(self, End::Panic | End::Error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Elimination {
    pub seat: u8,
    pub turn: u32,
}

/// One result line. Field order is the line's byte order; don't reorder.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GameResult {
    pub game: String,
    pub seed: u64,
    pub difficulty: String,
    pub decks: Vec<String>,
    pub first_seat: Option<u8>,
    pub winner: Option<u8>,
    /// Seats best to worst, ties grouped (see [`placements`]); empty for failures.
    pub placements: Vec<Vec<u8>>,
    pub eliminations: Vec<Elimination>,
    pub end: End,
    pub turns: u32,
    pub actions: usize,
    pub ms: u64,
    pub final_life: Vec<i32>,
    pub engine: String,
    pub card_data: String,
    pub runner: String,
    pub error: Option<String>,
    /// The schedule line's `pilots`, when it had them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pilots: Option<Vec<String>>,
    /// What each LLM seat did (games with an LLM pilot only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm: Option<Vec<LlmSeatStats>>,
}

impl GameResult {
    /// A result with nothing known yet beyond the schedule line (end "error" until set).
    pub fn new(spec: &GameSpec, card_data: &str) -> Self {
        GameResult {
            game: spec.game.clone(),
            seed: spec.seed,
            difficulty: spec.difficulty.clone(),
            decks: spec.decks.clone(),
            first_seat: None,
            winner: None,
            placements: Vec::new(),
            eliminations: Vec::new(),
            end: End::Error,
            turns: 0,
            actions: 0,
            ms: 0,
            final_life: Vec::new(),
            engine: ENGINE.into(),
            card_data: card_data.into(),
            runner: RUNNER.into(),
            error: None,
            pilots: spec.pilots.clone(),
            llm: None,
        }
    }

    /// The JSON line, without a newline.
    pub fn to_line(&self) -> String {
        serde_json::to_string(self).expect("result serializes")
    }

    /// Whether the machine, not the game, may have ended it: the CPU-time cap, a hang (no move
    /// for a while) or the wall-clock safety net. On a starved machine each comes far sooner than
    /// it would on a healthy one. Without an LLM seat a game replays move for move from its
    /// schedule line, so playing it again on a healthy machine gives its real result.
    pub fn cut_short_by_machine(&self) -> bool {
        if self.pilots.iter().flatten().any(|p| p.starts_with("llm:")) {
            return false;
        }
        match self.end {
            End::TimeCap => true,
            End::Error => self.error.as_deref().is_some_and(|e| e.starts_with("hung:") || e.starts_with("wall-clock safety limit:")),
            _ => false,
        }
    }
}

/// Best to worst, ties grouped: the winner alone; then anyone still in the game who didn't win
/// (at a cap, or a draw, all survivors share the top group); then eliminated players, later
/// elimination better, players eliminated by the same action tied. Seats ascending in a group.
pub fn placements(players: u8, winner: Option<u8>, out_groups: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let out: HashSet<u8> = out_groups.iter().flatten().copied().collect();
    let alive: Vec<u8> = (0..players).filter(|s| !out.contains(s)).collect();
    let mut groups = Vec::new();
    if let Some(w) = winner {
        groups.push(vec![w]);
    }
    let rest: Vec<u8> = alive.into_iter().filter(|s| Some(*s) != winner).collect();
    if !rest.is_empty() {
        groups.push(rest);
    }
    for g in out_groups.iter().rev() {
        let mut g: Vec<u8> = g.iter().copied().filter(|s| Some(*s) != winner).collect();
        g.sort_unstable();
        if !g.is_empty() {
            groups.push(g);
        }
    }
    groups
}

// ---------------------------------------------------------------------------------------------
// Decks

#[derive(Debug, Default, PartialEq)]
pub struct DeckFile {
    pub commander: Vec<(u32, String)>,
    pub main: Vec<(u32, String)>,
}

impl DeckFile {
    pub fn count(&self) -> u32 {
        self.commander.iter().chain(&self.main).map(|(q, _)| q).sum()
    }
}

/// "Commander" and "Deck" sections of "qty name" lines. Lines before any header count as the
/// deck; sideboard-like sections are ignored; "#" and "//" lines are comments; "1x" is accepted.
pub fn parse_deck(text: &str) -> Result<DeckFile, String> {
    #[derive(PartialEq)]
    enum Section {
        Commander,
        Main,
        Ignored,
    }
    let mut deck = DeckFile::default();
    let mut section = Section::Main;
    for raw in text.lines() {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") {
            continue;
        }
        let header = line.trim_end_matches(':').to_ascii_lowercase();
        match header.as_str() {
            "commander" | "commanders" => {
                section = Section::Commander;
                continue;
            }
            "deck" | "main" | "mainboard" | "maindeck" => {
                section = Section::Main;
                continue;
            }
            "sideboard" | "maybeboard" | "considering" | "tokens" => {
                section = Section::Ignored;
                continue;
            }
            _ => {}
        }
        if section == Section::Ignored {
            continue;
        }
        let (qty, name) = match line.split_once(char::is_whitespace) {
            Some((q, rest)) => match q.trim_end_matches(['x', 'X']).parse::<u32>() {
                Ok(n) => (n, rest.trim()),
                Err(_) => (1, line),
            },
            None => (1, line),
        };
        if name.is_empty() || qty == 0 {
            return Err(format!("bad line {raw:?}"));
        }
        let target = if section == Section::Commander { &mut deck.commander } else { &mut deck.main };
        target.push((qty, name.to_string()));
    }
    if deck.commander.is_empty() {
        return Err("no Commander section".into());
    }
    Ok(deck)
}

/// Resolve a parsed deck the way Yama's play crate does (`Engine::resolve_deck`). Unknown names
/// are an error, never silently dropped.
pub fn resolve_deck_file(engine: &Engine, id: &str, file: &DeckFile) -> Result<SeatDeck, String> {
    let lines: Vec<DeckLine> = file
        .commander
        .iter()
        .map(|(qty, name)| DeckLine { oracle_id: "", name, qty: *qty, commander: true })
        .chain(file.main.iter().map(|(qty, name)| DeckLine { oracle_id: "", name, qty: *qty, commander: false }))
        .collect();
    let (deck, report) = engine.resolve_deck(&lines);
    if !report.missing.is_empty() {
        return Err(format!("{id}: unknown cards: {}", report.missing.join("; ")));
    }
    Ok(deck)
}

/// Read and resolve the deck `id` (a path under `root` without ".txt"). Returns the deck and its
/// card count.
pub fn load_deck(engine: &Engine, root: &Path, id: &str) -> Result<(SeatDeck, u32), String> {
    let path = root.join(format!("{id}.txt"));
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{id}: can't read {}: {e}", path.display()))?;
    let file = parse_deck(&text).map_err(|e| format!("{id}: {e}"))?;
    let deck = resolve_deck_file(engine, id, &file)?;
    Ok((deck, file.count()))
}

// ---------------------------------------------------------------------------------------------
// One game

/// What is known about a game so far; kept outside the panic boundary so a panicking game
/// still reports how far it got.
struct Progress {
    first_seat: Option<u8>,
    turn: u32,
    actions: usize,
    life: Vec<i32>,
    out: Vec<bool>,
    eliminations: Vec<Elimination>,
    /// Eliminated seats in order, one group per action that eliminated them.
    out_groups: Vec<Vec<u8>>,
    /// (action number, turn, label) for up to STALL_WINDOW actions, recorded only near a cap:
    /// the last actions before max_actions (across turns) or the loop guard (within the turn).
    stall: VecDeque<(usize, u32, String)>,
    /// Decisions where the AI returned nothing and phase's fallback_action answered instead.
    fallbacks: usize,
    fallback_first: Option<String>,
    /// The action cap came from the per-turn loop guard, not max_actions.
    loop_guard: bool,
    /// LLM seats' bookkeeping, in seat order (empty in games without one).
    llm: Vec<LlmSeatStats>,
    /// Wall-clock time spent waiting for LLM replies, which the wall-clock safety net leaves out.
    llm_wait: Duration,
    /// The first model choice the engine refused after offering it.
    llm_refused_first: Option<String>,
}

impl Progress {
    fn new(players: usize) -> Self {
        Self {
            first_seat: None,
            turn: 0,
            actions: 0,
            life: Vec::new(),
            out: vec![false; players],
            eliminations: Vec::new(),
            out_groups: Vec::new(),
            stall: VecDeque::new(),
            fallbacks: 0,
            fallback_first: None,
            loop_guard: false,
            llm: Vec::new(),
            llm_wait: Duration::ZERO,
            llm_refused_first: None,
        }
    }

    /// Note the action about to be taken as action number `self.actions`.
    fn record_stall(&mut self, turn: u32, label: String) {
        if self.stall.len() >= STALL_WINDOW {
            self.stall.pop_front();
        }
        self.stall.push_back((self.actions, turn, label));
    }

    /// The most repeated actions before an action cap, most frequent first: this turn's actions
    /// for the loop guard, the last STALL_WINDOW actions (whatever their turn) for max_actions.
    fn stall_summary(&self) -> String {
        let from = self.actions.saturating_sub(STALL_WINDOW);
        let mut counts: HashMap<&str, usize> = HashMap::new();
        let (mut first_turn, mut last_turn) = (u32::MAX, 0u32);
        for (n, turn, label) in &self.stall {
            if *n < from || (self.loop_guard && *turn != self.turn) {
                continue;
            }
            *counts.entry(label.as_str()).or_default() += 1;
            first_turn = first_turn.min(*turn);
            last_turn = last_turn.max(*turn);
        }
        let total: usize = counts.values().sum();
        if total == 0 {
            return "no actions recorded".into();
        }
        let mut top: Vec<(&str, usize)> = counts.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        let parts: Vec<String> = top.iter().take(4).map(|(k, v)| format!("{v}x {k}")).collect();
        let span = if first_turn == last_turn { format!("turn {first_turn}") } else { format!("turns {first_turn}-{last_turn}") };
        format!("last {total} actions ({span}): {}", parts.join(" | "))
    }

    fn observe(&mut self, s: &GameState) {
        self.turn = s.turn_number;
        self.life.clear();
        self.life.extend(s.players.iter().map(|p| p.life));
        let mut newly: Vec<u8> = Vec::new();
        for p in &s.players {
            let seat = p.id.0 as usize;
            if p.is_eliminated && seat < self.out.len() && !self.out[seat] {
                self.out[seat] = true;
                newly.push(p.id.0);
            }
        }
        if !newly.is_empty() {
            // Engine elimination order within the group, for a stable list.
            let pos = |seat: u8| s.eliminated_players.iter().position(|p| p.0 == seat).unwrap_or(usize::MAX);
            newly.sort_by_key(|seat| (pos(*seat), *seat));
            self.eliminations.extend(newly.iter().map(|&seat| Elimination { seat, turn: s.turn_number }));
            self.out_groups.push(newly);
        }
    }

    fn alive(&self) -> Vec<u8> {
        (0..self.out.len() as u8).filter(|s| !self.out[*s as usize]).collect()
    }

    /// Show the watchdog where the game is, just before its next step: if that step never
    /// returns, the hung game's result line says what it was doing.
    fn publish(&self, live: &Mutex<Live>, s: &GameState) {
        let at = format!("{}, stack source {}", where_in(s), stack_source(s));
        let mut l = lock(live);
        l.last_step = Instant::now();
        l.first_seat = self.first_seat;
        l.turn = self.turn;
        l.actions = self.actions;
        l.life.clone_from(&self.life);
        l.eliminations.clone_from(&self.eliminations);
        l.at = at;
    }
}

/// A game in progress as a watchdog sees it, published by the game's thread before every step.
#[derive(Debug, Clone)]
pub struct Live {
    pub started: Instant,
    /// When the game last made a move (an AI action or a settled contest).
    pub last_step: Instant,
    pub first_seat: Option<u8>,
    pub turn: u32,
    pub actions: usize,
    pub life: Vec<i32>,
    pub eliminations: Vec<Elimination>,
    /// Where the game is, e.g. "turn 3, active seat 1, waiting for Priority, stack source ...".
    pub at: String,
}

impl Live {
    pub fn new() -> Self {
        let now = Instant::now();
        Self {
            started: now,
            last_step: now,
            first_seat: None,
            turn: 0,
            actions: 0,
            life: Vec::new(),
            eliminations: Vec::new(),
            at: "setting up the game".into(),
        }
    }
}

impl Default for Live {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, PartialEq)]
enum Ending {
    Win(u8),
    Draw,
    TurnCap,
    ActionCap,
    TimeCap,
    Error(String),
}

fn where_in(s: &GameState) -> String {
    format!("turn {}, active seat {}, waiting for {}", s.turn_number, s.active_player.0, s.waiting_for.variant_name())
}

fn object_name(s: &GameState, id: engine::types::identifiers::ObjectId) -> String {
    match s.objects.get(&id) {
        Some(o) if !o.name.is_empty() => o.name.clone(),
        Some(_) => "unnamed object".into(),
        None => format!("object {}", id.0),
    }
}

/// The card whose spell or ability is resolving (or on top of the stack), for diagnostics.
fn stack_source(s: &GameState) -> String {
    match s.resolving_stack_entry.as_ref().or_else(|| s.stack.last()) {
        Some(e) => object_name(s, e.source_id),
        None => "empty stack".into(),
    }
}

/// Why the AI may have had nothing to say: the prompt, its source card and how many options the
/// engine issued. Goes into the error text so an upstream bug report has something to start from.
fn no_action_detail(s: &GameState, contract: &AiDecisionContract) -> String {
    let mut prompt = format!("{:?}", s.waiting_for);
    if prompt.len() > 240 {
        let mut cut = 240;
        while !prompt.is_char_boundary(cut) {
            cut -= 1;
        }
        prompt.truncate(cut);
        prompt.push('…');
    }
    format!("source {}; {} engine-issued options; prompt {prompt}", stack_source(s), contract.candidates.len())
}

fn stall_label(s: &GameState, actor: PlayerId, action: &engine::types::actions::GameAction) -> String {
    let mut a = format!("{action:?}");
    if a.len() > 120 {
        let mut cut = 120;
        while !a.is_char_boundary(cut) {
            cut -= 1;
        }
        a.truncate(cut);
        a.push('…');
    }
    // Stack bottom to top with entry ids: a loop that keeps adding fresh entries shows rising ids.
    let stack: Vec<String> = s.stack.iter().map(|e| format!("{} #{}", object_name(s, e.source_id), e.id.0)).collect();
    format!("seat {} {} at {} (stack: {})", actor.0, a, s.waiting_for.variant_name(), if stack.is_empty() { "empty".into() } else { stack.join(" < ") })
}

/// Limits and test hooks for one game, besides its schedule line's own caps.
#[derive(Debug, Clone)]
pub struct GameOptions {
    /// Per-turn loop guard: AI actions within one turn before the game ends as an action cap.
    /// 0 turns it off.
    pub turn_action_cap: usize,
    /// Test hooks: panic, or stop forever, at this action count. `None` in real runs.
    pub panic_after: Option<usize>,
    pub hang_after: Option<usize>,
    /// How LLM seats reach their model. A game with an LLM pilot and no setup is an error.
    pub llm: Option<Arc<LlmSetup>>,
}

impl Default for GameOptions {
    fn default() -> Self {
        Self { turn_action_cap: MAX_TURN_ACTIONS, panic_after: None, hang_after: None, llm: None }
    }
}

/// How LLM seats reach their model, shared by every game of a run.
pub struct LlmSetup {
    pub transport: Arc<dyn LlmTransport>,
    /// Requests per LLM seat per game; later decisions fall back to the heuristic AI (counted as
    /// "cap").
    pub max_calls_per_seat: usize,
    /// Transport or service failures in a row after which the game ends as an error (not scored,
    /// replayable with --retry-errors), so a dead service or a spent usage limit can't quietly
    /// turn LLM games into heuristic ones.
    pub max_failure_streak: usize,
    /// JSON-lines log of every request: game, seat, turn, the options, the reply and its outcome.
    pub log: Option<Mutex<std::fs::File>>,
    /// Add an object key to each prompt: what each object number in the options is (name, zone,
    /// controller), from the seat's own view. phase-llm names an action's main object but prints
    /// targets and attackers as bare numbers ("Choose Target (Target: Object 77)").
    pub object_key: bool,
}

impl std::fmt::Debug for LlmSetup {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LlmSetup")
            .field("max_calls_per_seat", &self.max_calls_per_seat)
            .field("max_failure_streak", &self.max_failure_streak)
            .field("log", &self.log.is_some())
            .field("object_key", &self.object_key)
            .finish_non_exhaustive()
    }
}

/// History kept for LLM prompts (phase-llm renders a bounded window of it).
const LLM_HISTORY: usize = 3_000;

/// One LLM seat's state during a game.
struct LlmSeat {
    model: String,
    persona: AiDifficulty,
    streak: usize,
}

/// What asking the model produced for one decision.
enum Asked {
    /// The model's choice, already bound to an engine-issued option.
    Chosen(engine::types::actions::GameAction),
    /// Use the heuristic AI for this decision.
    Fallback,
    /// Too many transport failures in a row: end the game as an error.
    Abort(String),
}

/// "Object 77 = Corsair Captain (in your graveyard)" for every object the options name, as the
/// seat may see them (hidden cards stay hidden). `None` when the options name no object.
pub fn object_key(state: &GameState, contract: &AiDecisionContract) -> Option<String> {
    let viewer = contract.semantic_owner;
    let mut ids: Vec<engine::types::identifiers::ObjectId> = Vec::new();
    for c in &contract.candidates {
        for id in c.action.related_object_ids() {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    if ids.is_empty() {
        return None;
    }
    let visible = engine::game::filter_state_for_viewer(state, viewer);
    let who = |p: PlayerId| if p == viewer { "your".to_string() } else { format!("Player {}'s", p.0) };
    let mut lines = Vec::new();
    for id in ids.iter().take(60) {
        let Some(o) = visible.objects.get(id) else { continue };
        let name = if o.name.is_empty() || (o.face_down && o.controller != viewer) { "a hidden card".to_string() } else { o.name.clone() };
        use engine::types::zones::Zone;
        let place = match o.zone {
            Zone::Battlefield => format!("on the battlefield, {} permanent{}", who(o.controller), if o.tapped { ", tapped" } else { "" }),
            Zone::Hand => format!("in {} hand", who(o.owner)),
            Zone::Graveyard => format!("in {} graveyard", who(o.owner)),
            Zone::Library => format!("in {} library", who(o.owner)),
            Zone::Exile => format!("in exile ({})", who(o.owner)),
            Zone::Stack => format!("on the stack, {} spell or ability", who(o.controller)),
            Zone::Command => format!("in the command zone ({})", who(o.owner)),
        };
        lines.push(format!("Object {} = {name} ({place})", id.0));
    }
    if lines.is_empty() {
        return None;
    }
    Some(format!("OBJECT KEY: what the object numbers in the options refer to.\n{}", lines.join("\n")))
}

/// Put one decision to an LLM seat's model and bind the reply, or say why not.
#[allow(clippy::too_many_arguments)]
fn ask_llm(
    db: &Arc<CardDatabase>,
    setup: &LlmSetup,
    seat: &mut LlmSeat,
    stats: &mut LlmSeatStats,
    wait: &mut Duration,
    state: &GameState,
    contract: &AiDecisionContract,
    history: &[GameLogEntry],
    game: &str,
) -> Asked {
    let request = match phase_llm::build_game_decision_prompt(state, contract, seat.persona, Some(db), history) {
        Ok(r) => r,
        Err(phase_llm::LlmError::UnsupportedDecision { .. }) => {
            stats.forced += 1;
            return Asked::Fallback;
        }
        Err(_) => {
            stats.decisions += 1;
            stats.fallback("prompt");
            return Asked::Fallback;
        }
    };
    stats.decisions += 1;
    if stats.calls >= setup.max_calls_per_seat {
        stats.fallback("cap");
        return Asked::Fallback;
    }
    stats.calls += 1;
    let mut user = request.prompt.user.clone();
    if setup.object_key {
        if let Some(key) = object_key(state, contract) {
            let block = phase_llm::prompt::untrusted_block(&key);
            let marker = "\n\n--- DECISION ---\n";
            user = match user.find(marker) {
                Some(at) => format!("{}\n\n{block}{}", &user[..at], &user[at..]),
                None => format!("{user}\n\n{block}"),
            };
        }
    }
    let t = Instant::now();
    let reply = setup.transport.complete(&LlmRequest { model: &seat.model, system: &request.prompt.system, user: &user });
    let ms = t.elapsed();
    *wait += ms;
    stats.wait_ms += ms.as_millis() as u64;
    let mut chosen = None;
    let (outcome, choice, reason, text) = match &reply {
        Err(f) => {
            seat.streak += 1;
            stats.fallback(f.kind());
            (f.kind().to_string(), None, None, Some(f.detail()))
        }
        Ok(t) => {
            seat.streak = 0;
            stats.input_tokens += t.input_tokens;
            stats.cache_read_tokens += t.cache_read_tokens;
            stats.cache_write_tokens += t.cache_write_tokens;
            stats.output_tokens += t.output_tokens;
            let decoded = phase_llm::prompt::decode_choice(&t.text, request.option_count, 1);
            match phase_llm::select_action(state, contract, &request.fingerprint, &t.text) {
                Ok(sel) => {
                    stats.chosen += 1;
                    chosen = Some(sel.action);
                    ("chosen".to_string(), decoded.ok().and_then(|c| c.indices.first().copied()), sel.reasoning, None)
                }
                Err(e) => {
                    let why = match e {
                        phase_llm::LlmError::ChoiceOutOfRange { .. } => "out_of_range",
                        phase_llm::LlmError::StaleDecision => "stale",
                        _ => "undecodable",
                    };
                    stats.fallback(why);
                    (why.to_string(), None, None, Some(t.text.clone()))
                }
            }
        }
    };
    if let Some(log) = &setup.log {
        let line = serde_json::json!({
            "game": game,
            "seat": contract.authorized_actor.0,
            "turn": state.turn_number,
            "model": seat.model,
            "waiting": phase_llm::render::action::describe_waiting_for(&state.waiting_for),
            "options": request.prompt.frame.options,
            "outcome": outcome,
            "choice": choice,
            "reason": reason,
            "reply": text,
            "ms": ms.as_millis() as u64,
        });
        let mut f = lock(log);
        let _ = std::io::Write::write_all(&mut *f, format!("{line}\n").as_bytes());
    }
    match reply {
        Err(f) if seat.streak >= setup.max_failure_streak => {
            Asked::Abort(format!("LLM seat {} ({}): {} failures in a row, last: {} ({})", contract.authorized_actor.0, seat.model, seat.streak, f.kind(), f.detail()))
        }
        Err(_) => Asked::Fallback,
        Ok(_) => chosen.map_or(Asked::Fallback, Asked::Chosen),
    }
}

/// The limits a game runs under besides its schedule line's turn and action caps.
struct Limits {
    /// The game thread's CPU clock when the game started.
    cpu_start: f64,
    started: Instant,
    /// Wall-clock safety net (WALL_FACTOR x max_seconds).
    wall: Duration,
    turn_action_cap: usize,
    panic_after: Option<usize>,
    hang_after: Option<usize>,
}

/// Build the game as `Engine::new_match` does (except that seat 0 goes first) and let the AI
/// play every seat.
#[allow(clippy::too_many_arguments)]
fn play(
    db: &Arc<CardDatabase>,
    decks: Vec<SeatDeck>,
    job: &GameSpec,
    difficulty: AiDifficulty,
    llm: Option<&LlmSetup>,
    p: &mut Progress,
    live: &Mutex<Live>,
    lim: &Limits,
) -> Ending {
    let pilots = match job.seat_pilots() {
        Ok(p) => p,
        Err(e) => return Ending::Error(e),
    };
    if pilots.iter().any(Pilot::is_llm) && llm.is_none() {
        return Ending::Error("this game has an LLM pilot but the runner has no LLM transport (lab --llm)".into());
    }
    let lists: Vec<PlayerDeckList> =
        decks.into_iter().map(|d| PlayerDeckList { main_deck: d.main, commander: d.commander, ..Default::default() }).collect();
    let players = lists.len() as u8;
    let mut it = lists.into_iter();
    let deck_list = DeckList { player: it.next().unwrap(), opponent: it.next().unwrap(), ai_decks: it.collect(), ..Default::default() };
    let header = ReplayHeader {
        format_config: FormatConfig::commander(),
        match_config: MatchConfig::default(),
        player_count: players,
        // Seat 0 takes the first turn (no d20 roll), so the schedule's seat order is the turn
        // order and its seat rotation balances who goes first.
        first_player: Some(0),
        seed: job.seed,
        deck_data: Some(deck_list),
    };
    let mut state = match reconstruct_initial_state(&header, Some(db)) {
        Ok(s) => s,
        Err(e) => return Ending::Error(format!("game setup failed: {e:?}")),
    };
    // Replays are reconstructed in debug mode; a played game never is (as in the play crate).
    state.debug_mode = false;

    let seats: HashSet<PlayerId> = (0..players).map(PlayerId).collect();
    // Measurement mode: search is bounded by node and depth budgets only, never the clock. An
    // LLM seat's heuristic (its fallback) plays at the line's difficulty.
    let configs: HashMap<PlayerId, AiConfig> = (0..players)
        .map(|i| {
            let level = match &pilots[i as usize] {
                Pilot::Heuristic(d) => *d,
                Pilot::Llm(_) => difficulty,
            };
            (PlayerId(i), create_config_for_players(level, Platform::Native, players).into_measurement(job.seed))
        })
        .collect();
    let mut llm_seats: HashMap<PlayerId, (LlmSeat, usize)> = HashMap::new();
    for (i, pilot) in pilots.iter().enumerate() {
        if let Pilot::Llm(l) = pilot {
            llm_seats.insert(PlayerId(i as u8), (LlmSeat { model: l.model.clone(), persona: l.persona, streak: 0 }, p.llm.len()));
            p.llm.push(LlmSeatStats {
                seat: i as u8,
                pilot: job.pilots.as_ref().map_or_else(String::new, |v| v[i].clone()),
                prompt: if llm.is_some_and(|l| l.object_key) { "phase-llm+object-key" } else { "phase-llm" }.into(),
                ..Default::default()
            });
        }
    }
    let mut history: Vec<GameLogEntry> = Vec::new();
    // Set when the engine refused a model's choice: the next decision goes to the heuristic AI.
    let mut skip_llm_once = false;
    let session = AiSession::arc_from_game(&state);
    // Same AI seed derivation as the play crate's matches.
    let mut rng = StdRng::seed_from_u64(job.seed ^ 0x9e37_79b9_7f4a_7c15);

    // Turn 1 is underway: record who has it.
    p.first_seat = Some(state.active_player.0);
    p.observe(&state);
    let mut settlements = 0usize;
    // Loop guard: where the current turn began, in actions.
    let mut turn_seen = state.turn_number;
    let mut turn_start = 0usize;
    loop {
        if state.turn_number != turn_seen {
            turn_seen = state.turn_number;
            turn_start = p.actions;
        }
        if let WaitingFor::GameOver { winner } = &state.waiting_for {
            return match winner {
                Some(w) => Ending::Win(w.0),
                None => Ending::Draw,
            };
        }
        match p.alive().as_slice() {
            [] => return Ending::Draw,
            [w] => return Ending::Win(*w),
            _ => {}
        }
        if state.turn_number > job.max_turns {
            return Ending::TurnCap;
        }
        if p.actions >= job.max_actions {
            return Ending::ActionCap;
        }
        // A turn that never ends is an engine or AI loop (Zaffai, Thunder Conductor re-triggering
        // forever, seen 2026-10-18), not play: written as an action cap at once instead of
        // burning max_actions. Nothing changes during such a loop, so the placements are the same.
        if lim.turn_action_cap > 0 && p.actions - turn_start >= lim.turn_action_cap {
            p.loop_guard = true;
            return Ending::ActionCap;
        }
        if let Some(cpu) = thread_cpu_secs() {
            if cpu - lim.cpu_start >= job.max_seconds as f64 {
                return Ending::TimeCap;
            }
        }
        let wall = lim.started.elapsed().saturating_sub(p.llm_wait);
        if wall >= lim.wall {
            return Ending::Error(format!(
                "wall-clock safety limit: {}s elapsed ({WALL_FACTOR} x max_seconds) at turn {} after {} actions, with {:.0}s of CPU time; \
                 not scored, the machine was too busy",
                wall.as_secs(),
                p.turn,
                p.actions,
                thread_cpu_secs().map_or(f64::NAN, |c| c - lim.cpu_start)
            ));
        }
        p.publish(live, &state);
        if lim.hang_after == Some(p.actions) {
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
        match eligible_ai_decision(&state, &seats) {
            Some((owner, actor)) => {
                // Same choose/verify/apply boundary as phase's run_ai_action and the play crate.
                let contract = AiDecisionContract::issue(&state, owner);
                let mut asked = None;
                let ask = !std::mem::take(&mut skip_llm_once);
                if let (true, Some(setup), Some((seat, idx))) = (ask, llm, llm_seats.get_mut(&actor)) {
                    let stats = &mut p.llm[*idx];
                    match ask_llm(db, setup, seat, stats, &mut p.llm_wait, &state, &contract, &history, &job.game) {
                        Asked::Chosen(a) => asked = Some(a),
                        Asked::Fallback => {}
                        Asked::Abort(e) => return Ending::Error(e),
                    }
                    // The model's wait isn't an engine step: tell the watchdog the game moved.
                    p.publish(live, &state);
                }
                // When the AI's specialist answers outside the engine-issued options and returns
                // nothing (seen with Dream Eater's surveil 4), use phase's own fallback_action,
                // which picks from those options. phase documents that a miss should fall
                // through to "a worse decision, never a stopped game"; a few prompts don't yet.
                // Live Yama games stop here instead. Games that never hit this are unchanged.
                let from_llm = asked.is_some();
                let chosen = asked.or_else(|| choose_action_with_session(&state, owner, &configs[&actor], &mut rng, &session)).or_else(|| {
                    let fallback = phase_ai::search::fallback_action(&state, &configs[&actor], &contract);
                    if fallback.is_some() {
                        p.fallbacks += 1;
                        if p.fallback_first.is_none() {
                            p.fallback_first = Some(format!("seat {} at {}: {}", actor.0, where_in(&state), no_action_detail(&state, &contract)));
                        }
                    }
                    fallback
                });
                let Some(action) = chosen else {
                    return Ending::Error(format!(
                        "AI for seat {} found no action ({}; {})",
                        actor.0,
                        where_in(&state),
                        no_action_detail(&state, &contract)
                    ));
                };
                let near_turn_cap = lim.turn_action_cap > 0 && p.actions - turn_start + STALL_WINDOW >= lim.turn_action_cap;
                if near_turn_cap || p.actions + STALL_WINDOW >= job.max_actions {
                    p.record_stall(state.turn_number, stall_label(&state, actor, &action));
                }
                let stack_pass = verified_ai_stack_pass_player(&state, &action).is_some();
                if !stack_pass && !contract.permits(&state, actor, &action) {
                    return Ending::Error(format!("AI for seat {} chose an action outside its options: {action:?} ({})", actor.0, where_in(&state)));
                }
                let tried = action.clone();
                // An engine-issued option the engine then refuses (seen once: CrewVehicle with no
                // creatures) is an engine bug the heuristic never walks into; for a model's
                // choice, undo and let the heuristic decide instead of losing the game.
                let backup = from_llm.then(|| state.clone());
                let applied = if stack_pass {
                    apply_verified_ai_priority_pass(&mut state, actor, &contract, action)
                } else {
                    apply_interaction(&mut state, actor, owner, action)
                };
                match applied {
                    Err(e) if backup.is_some() => {
                        state = backup.expect("checked");
                        if let Some((_, idx)) = llm_seats.get(&actor) {
                            let st = &mut p.llm[*idx];
                            st.chosen = st.chosen.saturating_sub(1);
                            st.fallback("refused");
                        }
                        if p.llm_refused_first.is_none() {
                            p.llm_refused_first = Some(format!("seat {} {tried:?}: {e} ({})", actor.0, where_in(&state)));
                        }
                        skip_llm_once = true;
                        continue;
                    }
                    Err(e) => return Ending::Error(format!("engine refused seat {}'s action {tried:?}: {e} ({})", actor.0, where_in(&state))),
                    Ok(r) if !llm_seats.is_empty() => {
                        history.extend(r.log_entries);
                        if history.len() > LLM_HISTORY {
                            history.drain(..history.len() - LLM_HISTORY / 2);
                        }
                    }
                    Ok(_) => {}
                }
                p.actions += 1;
                if lim.panic_after == Some(p.actions) {
                    panic!("deliberate test panic after {} actions (YAMA_LAB_TEST_FAULT)", p.actions);
                }
            }
            None if matches!(state.waiting_for, WaitingFor::PhysicalContest { .. }) && settlements < MAX_SETTLEMENTS => {
                // No seat acts on a physical contest; a headless host settles it (phase's
                // run_ai_actions_headless does the same).
                if !phase_ai::contest::settle_headless_contest(&mut state, &seats, &mut rng) {
                    return Ending::Error(format!("could not settle a physical contest ({})", where_in(&state)));
                }
                settlements += 1;
            }
            None => return Ending::Error(format!("stalled: no seat can act ({})", where_in(&state))),
        }
        p.observe(&state);
    }
}

/// What playing one game produced.
#[derive(Debug, Clone)]
pub struct GameReport {
    pub result: GameResult,
    /// Log lines about the game: phase's fallback answering for the AI, what an action cap's loop
    /// was, a time cap. Not failures; the batch runner prints them to stderr after "lab: ".
    pub notes: Vec<String>,
    /// Wall-clock seconds the game took (0 when it never started).
    pub secs: f64,
}

impl GameReport {
    /// A failure found outside the game itself (its thread didn't start, or a panic escaped).
    pub fn failed(spec: &GameSpec, card_data: &str, end: End, error: String) -> Self {
        let mut result = GameResult::new(spec, card_data);
        result.end = end;
        result.error = Some(error);
        GameReport { result, notes: Vec::new(), secs: 0.0 }
    }
}

/// Clears the thread's current game when the game is over, so a later panic on the same thread
/// (a server thread that plays games one after another) isn't blamed on it.
struct CurrentGame;

impl CurrentGame {
    fn set(game: &str) -> Self {
        CURRENT_GAME.with(|g| *g.borrow_mut() = game.to_string());
        LAST_PANIC.with(|p| *p.borrow_mut() = None);
        CurrentGame
    }
}

impl Drop for CurrentGame {
    fn drop(&mut self) {
        CURRENT_GAME.with(|g| {
            if let Ok(mut g) = g.try_borrow_mut() {
                g.clear();
            }
        });
    }
}

/// Play one game on the calling thread, which needs a deep stack ([`STACK`]); panics inside the
/// game are caught and written as end "panic". `decks` are in seat order and already resolved;
/// `card_data` is the card data's hash ([`card_data_hash`]). The game publishes its progress to
/// `live` before every step.
pub fn play_game(
    engine: &Engine,
    spec: &GameSpec,
    difficulty: AiDifficulty,
    decks: Vec<SeatDeck>,
    card_data: &str,
    opts: &GameOptions,
    live: &Mutex<Live>,
) -> GameReport {
    let started = Instant::now();
    let cpu_start = thread_cpu_secs().unwrap_or(0.0);
    let _current = CurrentGame::set(&spec.game);
    let players = spec.decks.len();
    let mut result = GameResult::new(spec, card_data);
    let mut notes = Vec::new();

    let lim = Limits {
        cpu_start,
        started,
        wall: Duration::from_secs(spec.max_seconds.saturating_mul(WALL_FACTOR)),
        turn_action_cap: opts.turn_action_cap,
        panic_after: opts.panic_after,
        hang_after: opts.hang_after,
    };
    let mut progress = Progress::new(players);
    let llm = opts.llm.as_deref();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| play(engine.database(), decks, spec, difficulty, llm, &mut progress, live, &lim)));
    if !progress.llm.is_empty() {
        for s in &progress.llm {
            if s.fallback_count() > 0 {
                notes.push(format!(
                    "game {}: LLM seat {} ({}) fell back to the heuristic AI on {} of {} decisions: {:?}",
                    spec.game,
                    s.seat,
                    s.pilot,
                    s.fallback_count(),
                    s.decisions,
                    s.fallbacks
                ));
            }
        }
        if let Some(first) = &progress.llm_refused_first {
            notes.push(format!("game {}: the engine refused an option it had offered an LLM seat; the heuristic decided instead (first: {first})", spec.game));
        }
        result.llm = Some(progress.llm.clone());
    }
    if progress.fallbacks > 0 {
        notes.push(format!(
            "game {}: the AI found no action {} time(s); phase's fallback_action answered (first: {})",
            spec.game,
            progress.fallbacks,
            progress.fallback_first.as_deref().unwrap_or("?")
        ));
    }
    result.first_seat = progress.first_seat;
    result.turns = progress.turn;
    result.actions = progress.actions;
    result.final_life = progress.life.clone();
    result.eliminations = progress.eliminations.clone();
    let n = players as u8;
    match outcome {
        Ok(ending) => {
            let (end, winner, error) = match ending {
                Ending::Win(w) => (End::Win, Some(w), None),
                Ending::Draw => (End::Draw, None, None),
                Ending::TurnCap => (End::TurnCap, None, None),
                Ending::ActionCap => (End::ActionCap, None, None),
                Ending::TimeCap => (End::TimeCap, None, None),
                Ending::Error(e) => (End::Error, None, Some(e)),
            };
            result.end = end;
            result.winner = winner;
            result.error = error;
            if end == End::ActionCap {
                // Not a failure, so the result's error stays null; the notes say what the loop was.
                let why = if progress.loop_guard {
                    format!("loop guard, {} actions without the turn ending", opts.turn_action_cap)
                } else {
                    format!("max_actions {}", spec.max_actions)
                };
                notes.push(format!("game {} hit the action cap at turn {} ({why}): {}", spec.game, progress.turn, progress.stall_summary()));
            }
            if end == End::TimeCap {
                notes.push(format!(
                    "game {} used its {}s of CPU time at turn {} after {} actions ({:.0}s wall clock); written as time_cap, \
                     which the analysis doesn't score",
                    spec.game,
                    spec.max_seconds,
                    progress.turn,
                    progress.actions,
                    started.elapsed().as_secs_f64()
                ));
            }
            if end == End::TurnCap {
                // Stopped as turn max_turns + 1 began: max_turns turns were played.
                result.turns = spec.max_turns;
            }
            if end != End::Error {
                result.placements = placements(n, winner, &progress.out_groups);
            }
        }
        Err(payload) => {
            result.end = End::Panic;
            let text = LAST_PANIC.with(|p| p.borrow_mut().take()).unwrap_or_else(|| payload_text(&*payload));
            result.error = Some(text);
        }
    }
    result.ms = started.elapsed().as_millis() as u64;
    GameReport { result, notes, secs: started.elapsed().as_secs_f64() }
}

/// [`play_game`] on a thread of its own, named "game <id>" and with a [`STACK`]-sized stack, so a
/// panic that escapes the game, or a thread that can't start, still gives a result line.
pub fn play_game_isolated(
    engine: &Engine,
    spec: &GameSpec,
    difficulty: AiDifficulty,
    decks: Vec<SeatDeck>,
    card_data: &str,
    opts: &GameOptions,
    live: &Mutex<Live>,
) -> GameReport {
    std::thread::scope(|s| {
        let game = std::thread::Builder::new()
            .name(format!("game {}", spec.game))
            .stack_size(STACK)
            .spawn_scoped(s, || play_game(engine, spec, difficulty, decks, card_data, opts, live));
        match game {
            Ok(h) => h.join().unwrap_or_else(|payload| GameReport::failed(spec, card_data, End::Panic, payload_text(&*payload))),
            Err(e) => GameReport::failed(spec, card_data, End::Error, format!("could not start the game's thread: {e}")),
        }
    })
}

/// The result for a game a watchdog gave up on, with everything its thread had shown.
pub fn hung_result(spec: &GameSpec, card_data: &str, live: &Live, hang_secs: u64) -> GameResult {
    let mut r = GameResult::new(spec, card_data);
    r.first_seat = live.first_seat;
    r.turns = live.turn;
    r.actions = live.actions;
    r.final_life = live.life.clone();
    r.eliminations = live.eliminations.clone();
    r.ms = live.started.elapsed().as_millis() as u64;
    r.error = Some(format!(
        "hung: no move for {hang_secs}s, stuck inside one engine or AI step; last seen at {} after {} actions; written off {}s after the game started",
        live.at,
        live.actions,
        live.started.elapsed().as_secs()
    ));
    r
}

// ---------------------------------------------------------------------------------------------
// Panic capture

thread_local! {
    static CURRENT_GAME: RefCell<String> = const { RefCell::new(String::new()) };
    static LAST_PANIC: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Install a process-wide panic hook that records a lab game's panic message with its location
/// (for the result line) and prints "lab: panic in game <id>: ..." to stderr. Panics outside a
/// lab game go to the hook that was installed before. Without it, a game's panic is still
/// caught, with the payload text only.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let game = CURRENT_GAME.with(|g| g.try_borrow().map(|g| g.clone()).unwrap_or_default());
        if game.is_empty() {
            previous(info);
            return;
        }
        let msg = payload_text(info.payload());
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let text = if at.is_empty() { msg } else { format!("{msg} (at {at})") };
        eprintln!("lab: panic in game {game}: {text}");
        LAST_PANIC.with(|p| {
            if let Ok(mut p) = p.try_borrow_mut() {
                *p = Some(text);
            }
        });
    }));
}

/// The text of a panic payload.
pub fn payload_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".into()
    }
}

// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deck_sections_and_quantities() {
        let text = "Commander\n1 Éowyn, Shieldmaiden\n\nDeck\n1 Arcane Signet\n10x Plains\n# comment\nForest\n\nSideboard\n1 Ignored Card\n";
        let d = parse_deck(text).unwrap();
        assert_eq!(d.commander, vec![(1, "Éowyn, Shieldmaiden".to_string())]);
        assert_eq!(d.main, vec![(1, "Arcane Signet".into()), (10, "Plains".into()), (1, "Forest".into())]);
        assert_eq!(d.count(), 13);
    }

    #[test]
    fn deck_with_partner_and_split_name() {
        let d = parse_deck("Commander\n1 A\n1 B\nDeck:\n1 Fire // Ice\n").unwrap();
        assert_eq!(d.commander.len(), 2);
        assert_eq!(d.main, vec![(1, "Fire // Ice".into())]);
    }

    #[test]
    fn deck_needs_a_commander() {
        assert!(parse_deck("Deck\n1 Sol Ring\n").is_err());
    }

    #[test]
    fn placements_for_a_win() {
        // 4 players: seat 1 out first, then 3, seat 0 wins, seat 2 left alive by an alt-win.
        let p = placements(4, Some(0), &[vec![1], vec![3]]);
        assert_eq!(p, vec![vec![0], vec![2], vec![3], vec![1]]);
        let p = placements(4, Some(2), &[vec![1], vec![0, 3]]);
        assert_eq!(p, vec![vec![2], vec![0, 3], vec![1]]);
    }

    #[test]
    fn placements_at_a_cap_or_draw() {
        assert_eq!(placements(4, None, &[vec![2]]), vec![vec![0, 1, 3], vec![2]]);
        assert_eq!(placements(2, None, &[]), vec![vec![0, 1]]);
        // Everyone gone at once: the last group is the top.
        assert_eq!(placements(3, None, &[vec![0], vec![1, 2]]), vec![vec![1, 2], vec![0]]);
    }

    #[test]
    fn schedule_line_parses_and_validates() {
        let line = r#"{"game":"r-1","seed":18446744073709551615,"decks":["a","b","c","d"],"difficulty":"Medium","max_turns":40,"max_actions":30000,"max_seconds":600}"#;
        let (spec, d) = GameSpec::parse(line).unwrap();
        assert_eq!(spec.seed, u64::MAX);
        assert_eq!(d, AiDifficulty::Medium);
        assert!(GameSpec::parse(&line.replace("Medium", "Mediu")).is_err());
        assert!(GameSpec::parse(&line.replace(r#","b","c","d""#, "")).is_err());
        // Written back, a schedule line is the same line.
        assert_eq!(serde_json::to_string(&spec).unwrap(), line);
    }

    #[test]
    fn result_line_keeps_its_field_order_and_round_trips() {
        let spec = GameSpec {
            game: "g".into(),
            seed: 7,
            decks: vec!["a".into(), "b".into()],
            difficulty: "Easy".into(),
            max_turns: 40,
            max_actions: 100,
            max_seconds: 60,
            pilots: None,
        };
        let mut r = GameResult::new(&spec, "eb309108eb0df708");
        r.end = End::TurnCap;
        r.placements = vec![vec![0, 1]];
        r.eliminations = vec![Elimination { seat: 1, turn: 3 }];
        let line = r.to_line();
        let expected = format!(
            r#"{{"game":"g","seed":7,"difficulty":"Easy","decks":["a","b"],"first_seat":null,"winner":null,"placements":[[0,1]],"eliminations":[{{"seat":1,"turn":3}}],"end":"turn_cap","turns":0,"actions":0,"ms":0,"final_life":[],"engine":"phase-rs v0.113.0+aifix+tempo+endgame+stallfix","card_data":"eb309108eb0df708","runner":"{RUNNER}","error":null}}"#
        );
        assert_eq!(line, expected);
        assert_eq!(serde_json::from_str::<GameResult>(&line).unwrap(), r);
        for end in [End::Win, End::Draw, End::TurnCap, End::ActionCap, End::TimeCap, End::Panic, End::Error] {
            assert_eq!(serde_json::to_string(&end).unwrap(), format!("\"{}\"", end.as_str()));
        }
    }

    #[test]
    fn only_the_machine_s_limits_count_as_cut_short_by_it() {
        let spec = GameSpec {
            game: "g".into(),
            seed: 7,
            decks: vec!["a".into(), "b".into()],
            difficulty: "Easy".into(),
            max_turns: 40,
            max_actions: 100,
            max_seconds: 60,
            pilots: None,
        };
        let with = |end: End, error: Option<&str>| {
            let mut r = GameResult::new(&spec, "x");
            r.end = end;
            r.error = error.map(String::from);
            r
        };
        assert!(with(End::TimeCap, None).cut_short_by_machine());
        assert!(with(End::Error, Some("hung: no move for 300s, stuck inside one engine or AI step")).cut_short_by_machine());
        assert!(with(End::Error, Some("wall-clock safety limit: 2400s elapsed")).cut_short_by_machine());
        for (end, error) in [(End::Win, None), (End::TurnCap, None), (End::ActionCap, None), (End::Panic, Some("boom")), (End::Error, Some("deck errors: x")), (End::Error, Some("AI for seat 1 found no action"))] {
            assert!(!with(end, error).cut_short_by_machine(), "{end:?} {error:?}");
        }
        // A game with an LLM seat doesn't replay move for move.
        let mut r = with(End::TimeCap, None);
        r.pilots = Some(vec!["llm:m".into(), "easy".into()]);
        assert!(!r.cut_short_by_machine());
    }

    #[test]
    fn pilots_are_optional_and_checked() {
        let base = r#"{"game":"g","seed":1,"decks":["a","b","c"],"difficulty":"Easy","max_turns":40,"max_actions":100,"max_seconds":60}"#;
        let (spec, _) = GameSpec::parse(base).unwrap();
        assert_eq!(spec.pilots, None);
        assert_eq!(spec.seat_pilots().unwrap(), vec![Pilot::Heuristic(AiDifficulty::Easy); 3]);
        assert!(!spec.has_llm());
        let with = base.replace(r#""max_seconds":60}"#, r#""max_seconds":60,"pilots":["hard","llm:claude-haiku-5-5","veryeasy"]}"#);
        let (spec, _) = GameSpec::parse(&with).unwrap();
        assert!(spec.has_llm());
        assert_eq!(spec.seat_pilots().unwrap()[0], Pilot::Heuristic(AiDifficulty::Hard));
        // Written back, it's the same line, and a line without pilots stays without them.
        assert_eq!(serde_json::to_string(&spec).unwrap(), with);
        assert!(GameSpec::parse(&base.replace(r#""max_seconds":60}"#, r#""max_seconds":60,"pilots":["hard","easy"]}"#)).is_err());
        assert!(GameSpec::parse(&base.replace(r#""max_seconds":60}"#, r#""max_seconds":60,"pilots":["hard","easy","genius"]}"#)).is_err());
    }

    #[test]
    fn result_line_adds_pilots_and_llm_at_the_end() {
        let spec = GameSpec {
            game: "g".into(),
            seed: 7,
            decks: vec!["a".into(), "b".into()],
            difficulty: "Easy".into(),
            max_turns: 40,
            max_actions: 100,
            max_seconds: 60,
            pilots: Some(vec!["llm:m".into(), "easy".into()]),
        };
        let mut r = GameResult::new(&spec, "eb309108eb0df708");
        r.llm = Some(vec![LlmSeatStats { seat: 0, pilot: "llm:m".into(), prompt: "phase-llm".into(), decisions: 3, calls: 2, chosen: 2, forced: 1, ..Default::default() }]);
        let line = r.to_line();
        assert!(line.contains(r#""error":null,"pilots":["llm:m","easy"],"llm":[{"seat":0,"pilot":"llm:m","prompt":"phase-llm","decisions":3"#), "{line}");
        assert_eq!(serde_json::from_str::<GameResult>(&line).unwrap(), r);
    }

    #[test]
    fn card_data_hash_from_file_name() {
        assert_eq!(card_data_hash(Path::new("/x/card-data-eb309108eb0df708.json")), "eb309108eb0df708");
        assert_eq!(card_data_hash(Path::new("/x/cards.json")), "unknown");
    }

    #[test]
    fn stall_summary_covers_the_last_window_across_turns() {
        let mut p = Progress::new(4);
        // 30 actions over 3 turns, as before a max_actions cap.
        for n in 0..30usize {
            let turn = 10 + (n / 10) as u32;
            p.turn = turn;
            p.record_stall(turn, format!("seat {} PassPriority", n % 2));
            p.actions += 1;
        }
        assert_eq!(p.stall_summary(), "last 30 actions (turns 10-12): 15x seat 0 PassPriority | 15x seat 1 PassPriority");
        // The loop guard only describes the turn it stopped in.
        p.loop_guard = true;
        assert_eq!(p.stall_summary(), "last 10 actions (turn 12): 5x seat 0 PassPriority | 5x seat 1 PassPriority");
    }

    #[test]
    fn stall_window_keeps_only_the_last_actions() {
        let mut p = Progress::new(2);
        for _ in 0..STALL_WINDOW + 50 {
            p.record_stall(1, "x".into());
            p.actions += 1;
        }
        assert_eq!(p.stall.len(), STALL_WINDOW);
        assert_eq!(p.stall_summary(), format!("last {STALL_WINDOW} actions (turn 1): {STALL_WINDOW}x x"));
    }

    #[test]
    fn thread_cpu_clock_ignores_sleep_and_counts_work() {
        let a = thread_cpu_secs().expect("per-thread CPU clock");
        std::thread::sleep(Duration::from_millis(200));
        let b = thread_cpu_secs().unwrap();
        assert!(b - a < 0.1, "sleeping used {}s of CPU", b - a);
        let t = Instant::now();
        let mut x = 0u64;
        while t.elapsed() < Duration::from_millis(200) {
            x = std::hint::black_box(x.wrapping_mul(6364136223846793005).wrapping_add(1));
        }
        let c = thread_cpu_secs().unwrap();
        assert!(c - b > 0.05, "busy work used only {}s of CPU", c - b);
    }
}
