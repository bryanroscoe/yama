//! Simulation lab runner: plays a schedule of all-AI Commander games and writes one JSON line
//! per game. Design: commander-decks docs/deck-lab-plan.md. The deck, schedule and result
//! formats are the lab's shared contract; keep them in step with the Python side
//! (commander-decks scripts/sim/).
//!
//! Usage:
//!   lab --card-data <card-data-HASH.json> --decks-root <dir> --schedule <file.jsonl>
//!       --out <results.jsonl> [--threads N] [--skip-done] [--retry-errors] [--no-restart]
//!
//! Deck ids in the schedule are paths under --decks-root without ".txt". Each game is built the
//! way Yama's play crate builds one (same name resolution, same setup), with phase's AI on every
//! seat in measurement mode: its search is bounded by node and depth budgets, never the clock.
//!
//! Limits. A game that ends by a win, a draw, max_turns, max_actions or the per-turn loop guard
//! depends only on its schedule line: replayed on any machine, under any load, it is the same
//! game. max_seconds caps the CPU time of the game's own thread (end "time_cap"). Time spent
//! waiting for a core doesn't count, so machine load doesn't move that cap, but a slower machine
//! still reaches it sooner, so the analysis doesn't score time_cap games. A wall-clock safety net
//! (WALL_FACTOR x max_seconds) ends a game as an error, never as a scored result.
//!
//! Failures. Every game runs panic-isolated on its own thread, named after the game, so a stack
//! overflow or abort (which nothing in the process can catch, and which ends the process) names
//! the game in the log. A game that makes no move for HANG_SECS is stuck inside one engine or AI
//! step: the watchdog writes it off as an error that says where it stuck, no new games start,
//! the games in progress finish, and the runner restarts itself in a clean process (same
//! arguments plus --skip-done), so the stuck thread stops burning a core. Games whose decks don't
//! load are neither played nor written: they are listed and the run exits with code 4, so a fixed
//! deck directory plus --skip-done plays them. --retry-errors also replays games whose earlier
//! result was a panic or an error (only lines already in the file when the run started, so a game
//! that hangs again isn't replayed forever).
//!
//! Exit codes: 0 every game written; 1 error; 2 bad arguments; 3 games remain after hung games
//! and no restart was possible (--no-restart, or MAX_RESTARTS reached): run again with
//! --skip-done; 4 some games not played because their decks didn't load.
//!
//! Three differences from live Yama games: seat 0 always takes the first turn (live games roll a
//! d20), so a schedule's seat rotation is a rotation of turn order; when the AI returns no
//! action, phase's own `fallback_action` answers from the engine-issued options; and a turn with
//! more than MAX_TURN_ACTIONS AI actions is treated as a loop and ends the game as an action cap.
//! The last two happen only where a live game would stop or loop, and are logged on stderr with
//! what caused them.

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use engine::ai_support::AiDecisionContract;
use engine::database::CardDatabase;
use engine::game::deck_loading::{DeckList, PlayerDeckList};
use engine::game::engine::{apply_interaction, apply_verified_ai_priority_pass, verified_ai_stack_pass_player};
use engine::game::replay::reconstruct_initial_state;
use engine::types::format::FormatConfig;
use engine::types::game_state::{GameState, WaitingFor};
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
use yama_play::{DeckLine, Engine, SeatDeck};

const ENGINE: &str = "phase-rs v0.113.0";
/// The source this runner was built from (see build.rs): a short SHA, or
/// "<sha>-dirty-<source hash>" for uncommitted changes.
const RUNNER: &str = env!("YAMA_LAB_RUNNER");
/// Deep AI search overflows the default stack; phase and soak.rs use 32 MiB too.
const STACK: usize = 32 << 20;
/// Wall-clock seconds without a single move (an AI action or a settled contest) after which a game
/// counts as stuck inside one engine or AI step. A normal step takes well under a second; the
/// limits between steps (turns, actions, CPU time) can't stop a step that never returns.
/// YAMA_LAB_HANG_SECS overrides it.
const HANG_SECS: u64 = 300;
/// The wall-clock safety net is this many times max_seconds. It only matters on a machine so
/// overloaded that a game gets well under a quarter of a core; a game it stops is an error.
const WALL_FACTOR: u64 = 4;
/// Restarts in a clean process (after hung games) before the runner gives up with exit code 3.
const MAX_RESTARTS: u32 = 25;
/// Counts restarts across exec; a fresh run starts at 0.
const RESTARTS_ENV: &str = "YAMA_LAB_RESTARTS";
/// Byte length of the results file when the first process of this run started, carried across
/// restarts so --retry-errors only replays failures written before the run began.
const RETRY_BEFORE_ENV: &str = "YAMA_LAB_RETRY_BEFORE";
/// Physical contests settled per game before giving up (phase's own driver caps each batch).
const MAX_SETTLEMENTS: usize = 1_000;
/// AI actions allowed within one turn before the game is written off as an action cap (a loop).
/// Real 4-player games average under 60 actions per turn and under 5,000 per game (pilots,
/// 2026-10-18). YAMA_LAB_MAX_TURN_ACTIONS overrides it; 0 turns the guard off.
const MAX_TURN_ACTIONS: usize = 3_000;

fn main() {
    let handle = std::thread::Builder::new().name("lab-main".into()).stack_size(STACK).spawn(run).expect("spawn main thread");
    let code = handle.join().unwrap_or(101);
    std::process::exit(code);
}

/// Lock a mutex even if a panicking thread poisoned it (the data is plain bookkeeping).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// CPU time used so far by the calling thread, in seconds. Unlike wall-clock time it doesn't grow
/// while the thread waits for a core, so the load on the machine doesn't change where it runs out.
fn thread_cpu_secs() -> Option<f64> {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: clock_gettime only writes the timespec it is given.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    (rc == 0).then(|| ts.tv_sec as f64 + ts.tv_nsec as f64 * 1e-9)
}

// ---------------------------------------------------------------------------------------------
// Command line

struct Args {
    card_data: PathBuf,
    decks_root: PathBuf,
    schedule: PathBuf,
    out: PathBuf,
    threads: usize,
    skip_done: bool,
    retry_errors: bool,
    no_restart: bool,
}

const USAGE: &str = "usage: lab --card-data <card-data-HASH.json> --decks-root <dir> --schedule <file.jsonl> --out <results.jsonl> [--threads N] [--skip-done] [--retry-errors] [--no-restart]";

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut card_data = None;
    let mut decks_root = None;
    let mut schedule = None;
    let mut out = None;
    let mut threads = 1usize;
    let mut skip_done = false;
    let mut retry_errors = false;
    let mut no_restart = false;
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        let mut value = |flag: &str| it.next().cloned().ok_or_else(|| format!("{flag} needs a value\n{USAGE}"));
        match a.as_str() {
            "--card-data" => card_data = Some(PathBuf::from(value(a)?)),
            "--decks-root" => decks_root = Some(PathBuf::from(value(a)?)),
            "--schedule" => schedule = Some(PathBuf::from(value(a)?)),
            "--out" => out = Some(PathBuf::from(value(a)?)),
            "--threads" => {
                let v = value(a)?;
                threads = v.parse().ok().filter(|n| *n > 0).ok_or_else(|| format!("--threads {v:?} must be a positive integer"))?;
            }
            "--skip-done" => skip_done = true,
            "--retry-errors" => retry_errors = true,
            "--no-restart" => no_restart = true,
            "-h" | "--help" => return Err(USAGE.into()),
            other => return Err(format!("unknown argument {other:?}\n{USAGE}")),
        }
    }
    if retry_errors && !skip_done {
        return Err(format!("--retry-errors only makes sense with --skip-done\n{USAGE}"));
    }
    let need = |v: Option<PathBuf>, flag: &str| v.ok_or_else(|| format!("{flag} is required\n{USAGE}"));
    Ok(Args {
        card_data: need(card_data, "--card-data")?,
        decks_root: need(decks_root, "--decks-root")?,
        schedule: need(schedule, "--schedule")?,
        out: need(out, "--out")?,
        threads,
        skip_done,
        retry_errors,
        no_restart,
    })
}

/// "card-data-eb309108eb0df708.json" -> "eb309108eb0df708".
fn card_data_hash(path: &Path) -> String {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    match stem.strip_prefix("card-data-") {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => "unknown".into(),
    }
}

// ---------------------------------------------------------------------------------------------
// Schedule and results

#[derive(Debug, Clone, Deserialize)]
struct Job {
    game: String,
    seed: u64,
    decks: Vec<String>,
    difficulty: String,
    max_turns: u32,
    max_actions: usize,
    max_seconds: u64,
}

fn parse_job(line: &str) -> Result<(Job, AiDifficulty), String> {
    let job: Job = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if !(2..=6).contains(&job.decks.len()) {
        return Err(format!("game {}: {} decks; a Commander game here has 2 to 6", job.game, job.decks.len()));
    }
    if !ACCEPTED_DIFFICULTY_LABELS.iter().any(|l| l.eq_ignore_ascii_case(job.difficulty.trim())) {
        return Err(format!("game {}: unknown difficulty {:?} (accepted: {})", job.game, job.difficulty, ACCEPTED_DIFFICULTY_LABELS.join(", ")));
    }
    if job.max_turns == 0 || job.max_actions == 0 || job.max_seconds == 0 {
        return Err(format!("game {}: max_turns, max_actions and max_seconds must be positive", job.game));
    }
    let difficulty = AiDifficulty::from_label(&job.difficulty);
    Ok((job, difficulty))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
struct Elimination {
    seat: u8,
    turn: u32,
}

#[derive(Serialize)]
struct GameResult<'a> {
    game: &'a str,
    seed: u64,
    difficulty: &'a str,
    decks: &'a [String],
    first_seat: Option<u8>,
    winner: Option<u8>,
    placements: Vec<Vec<u8>>,
    eliminations: Vec<Elimination>,
    end: &'static str,
    turns: u32,
    actions: usize,
    ms: u64,
    final_life: Vec<i32>,
    engine: &'static str,
    card_data: &'a str,
    runner: &'static str,
    error: Option<String>,
}

impl<'a> GameResult<'a> {
    /// A result with nothing known yet beyond the schedule line (end "error" until set).
    fn new(job: &'a Job, card_data: &'a str) -> Self {
        GameResult {
            game: &job.game,
            seed: job.seed,
            difficulty: &job.difficulty,
            decks: &job.decks,
            first_seat: None,
            winner: None,
            placements: Vec::new(),
            eliminations: Vec::new(),
            end: "error",
            turns: 0,
            actions: 0,
            ms: 0,
            final_life: Vec::new(),
            engine: ENGINE,
            card_data,
            runner: RUNNER,
            error: None,
        }
    }
}

/// Best to worst, ties grouped: the winner alone; then anyone still in the game who didn't win
/// (at a cap, or a draw, all survivors share the top group); then eliminated players, later
/// elimination better, players eliminated by the same action tied. Seats ascending in a group.
fn placements(players: u8, winner: Option<u8>, out_groups: &[Vec<u8>]) -> Vec<Vec<u8>> {
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

/// Result-file error text of games whose decks didn't load (older runners wrote such lines).
const DECK_ERRORS: &str = "deck errors:";

/// What a results file says is already played.
#[derive(Debug, Default)]
struct Done {
    /// Games with a result that counts as played.
    ids: HashSet<String>,
    /// Bytes of a partial last line that were dropped.
    dropped: usize,
    /// File length after dropping the partial line.
    len: u64,
    /// Games whose only results are lines that will be replayed (deck errors, and with
    /// --retry-errors the failures before `retry_before`).
    retried: HashSet<String>,
}

/// Reads the ids already in a results file and drops a partial last line left by a kill, so
/// appended lines start clean. Lines for games whose decks didn't load never count as played.
/// With `retry_before`, a panic or error line that starts before that byte offset doesn't count
/// either, so the game is played again.
fn done_games(path: &Path, retry_before: Option<u64>) -> std::io::Result<Done> {
    let mut done = Done::default();
    let Ok(bytes) = std::fs::read(path) else {
        return Ok(done);
    };
    let keep = match bytes.iter().rposition(|b| *b == b'\n') {
        Some(i) => i + 1,
        None => 0,
    };
    done.dropped = bytes.len() - keep;
    done.len = keep as u64;
    if done.dropped > 0 {
        let f = OpenOptions::new().write(true).open(path)?;
        f.set_len(keep as u64)?;
    }
    let mut offset = 0u64;
    let mut retry = HashSet::new();
    for raw in bytes[..keep].split(|b| *b == b'\n') {
        let start = offset;
        offset += raw.len() as u64 + 1;
        let line = String::from_utf8_lossy(raw);
        if line.trim().is_empty() {
            continue;
        }
        let Some(v) = serde_json::from_str::<serde_json::Value>(&line).ok() else {
            eprintln!("lab: warning: unreadable line in {} ignored", path.display());
            continue;
        };
        let Some(id) = v.get("game").and_then(|g| g.as_str()).map(String::from) else {
            eprintln!("lab: warning: line without a game id in {} ignored", path.display());
            continue;
        };
        let error = v.get("error").and_then(|e| e.as_str()).unwrap_or("");
        let failed = matches!(v.get("end").and_then(|e| e.as_str()), Some("error" | "panic"));
        let replay = error.starts_with(DECK_ERRORS) || (failed && retry_before.is_some_and(|limit| start < limit));
        if replay {
            retry.insert(id);
        } else {
            done.ids.insert(id);
        }
    }
    done.retried = retry.into_iter().filter(|id| !done.ids.contains(id)).collect();
    Ok(done)
}

// ---------------------------------------------------------------------------------------------
// Decks

#[derive(Debug, Default, PartialEq)]
struct DeckFile {
    commander: Vec<(u32, String)>,
    main: Vec<(u32, String)>,
}

impl DeckFile {
    fn count(&self) -> u32 {
        self.commander.iter().chain(&self.main).map(|(q, _)| q).sum()
    }
}

/// "Commander" and "Deck" sections of "qty name" lines. Lines before any header count as the
/// deck; sideboard-like sections are ignored; "#" and "//" lines are comments; "1x" is accepted.
fn parse_deck(text: &str) -> Result<DeckFile, String> {
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

/// Read and resolve one deck the way Yama's play crate does (`Engine::resolve_deck`). Unknown
/// names are an error, never silently dropped. Returns the deck and its card count.
fn load_deck(engine: &Engine, root: &Path, id: &str) -> Result<(SeatDeck, u32), String> {
    let path = root.join(format!("{id}.txt"));
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{id}: can't read {}: {e}", path.display()))?;
    let file = parse_deck(&text).map_err(|e| format!("{id}: {e}"))?;
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
    Ok((deck, file.count()))
}

// ---------------------------------------------------------------------------------------------
// One game

/// Labels for the last actions before the action cap, so a stall names the loop it was in.
const STALL_WINDOW: usize = 2_000;

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

/// A game in progress as the watchdog sees it, published by the game's thread before every step.
struct Live {
    started: Instant,
    last_step: Instant,
    first_seat: Option<u8>,
    turn: u32,
    actions: usize,
    life: Vec<i32>,
    eliminations: Vec<Elimination>,
    at: String,
}

impl Live {
    fn new() -> Self {
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

/// The limits a game runs under besides its schedule line's turn and action caps.
struct Limits {
    /// The game thread's CPU clock when the game started.
    cpu_start: f64,
    started: Instant,
    /// Wall-clock safety net (WALL_FACTOR x max_seconds).
    wall: Duration,
    turn_action_cap: usize,
    /// Test hooks (YAMA_LAB_TEST_FAULT): panic, or stop forever, at this action count.
    panic_after: Option<usize>,
    hang_after: Option<usize>,
}

/// Build the game as `yama_play::Engine::new_match` does (except that seat 0 goes first) and let
/// the AI play every seat.
fn play(db: &Arc<CardDatabase>, decks: Vec<SeatDeck>, job: &Job, difficulty: AiDifficulty, p: &mut Progress, live: &Mutex<Live>, lim: &Limits) -> Ending {
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
    // Measurement mode: search is bounded by node and depth budgets only, never the clock.
    let configs: HashMap<PlayerId, AiConfig> = (0..players)
        .map(|i| (PlayerId(i), create_config_for_players(difficulty, Platform::Native, players).into_measurement(job.seed)))
        .collect();
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
        let wall = lim.started.elapsed();
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
                // When the AI's specialist answers outside the engine-issued options and returns
                // nothing (seen with Dream Eater's surveil 4), use phase's own fallback_action,
                // which picks from those options. phase documents that a miss should fall
                // through to "a worse decision, never a stopped game"; a few prompts don't yet.
                // Live Yama games stop here instead. Games that never hit this are unchanged.
                let chosen = choose_action_with_session(&state, owner, &configs[&actor], &mut rng, &session).or_else(|| {
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
                let applied = if stack_pass {
                    apply_verified_ai_priority_pass(&mut state, actor, &contract, action)
                } else {
                    apply_interaction(&mut state, actor, owner, action)
                };
                if let Err(e) = applied {
                    return Ending::Error(format!("engine refused seat {}'s action {tried:?}: {e} ({})", actor.0, where_in(&state)));
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

// ---------------------------------------------------------------------------------------------
// Panic capture

thread_local! {
    static CURRENT_GAME: RefCell<String> = const { RefCell::new(String::new()) };
    static LAST_PANIC: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = payload_text(info.payload());
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let text = if at.is_empty() { msg } else { format!("{msg} (at {at})") };
        let game = CURRENT_GAME.with(|g| g.try_borrow().map(|g| g.clone()).unwrap_or_default());
        eprintln!("lab: panic in game {game}: {text}");
        LAST_PANIC.with(|p| {
            if let Ok(mut p) = p.try_borrow_mut() {
                *p = Some(text);
            }
        });
    }));
}

fn payload_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".into()
    }
}

// ---------------------------------------------------------------------------------------------
// Workers

struct Shared {
    db: Arc<CardDatabase>,
    jobs: Vec<(Job, AiDifficulty)>,
    decks: HashMap<String, Result<SeatDeck, String>>,
    card_data: String,
    next: AtomicUsize,
    /// Set after a hung game: workers start no new games, so the process can restart cleanly.
    draining: AtomicBool,
    watch: Mutex<Watch>,
    /// Seconds without a move before the watchdog writes a game off.
    hang_secs: u64,
    /// Test hook (YAMA_LAB_TEST_FAULT="panic:<game>" or "hang:<game>": a panic after 50 actions,
    /// or a step that never returns after 30): exercises panic isolation and the watchdog end to
    /// end. Unset in real runs.
    fault: Option<(Fault, String)>,
    /// Per-turn loop guard (MAX_TURN_ACTIONS unless overridden).
    turn_action_cap: usize,
}

#[derive(Clone, Copy, PartialEq)]
enum Fault {
    Panic,
    Hang,
}

fn read_fault() -> Option<(Fault, String)> {
    let v = std::env::var("YAMA_LAB_TEST_FAULT").ok()?;
    match v.split_once(':')? {
        ("panic", game) => Some((Fault::Panic, game.to_string())),
        ("hang", game) => Some((Fault::Hang, game.to_string())),
        _ => None,
    }
}

#[derive(Default)]
struct Watch {
    /// Job index -> the game's live progress.
    in_flight: HashMap<usize, Arc<Mutex<Live>>>,
    /// Jobs the watchdog wrote off; their results are dropped if they ever come back.
    abandoned: HashSet<usize>,
}

struct Finished {
    index: usize,
    line: String,
    end: &'static str,
    turns: u32,
    secs: f64,
}

fn spawn_worker(shared: Arc<Shared>, tx: Sender<Finished>, n: usize) -> std::io::Result<()> {
    std::thread::Builder::new().name(format!("lab-worker-{n}")).stack_size(STACK).spawn(move || worker(&shared, &tx)).map(|_| ())
}

fn worker(shared: &Shared, tx: &Sender<Finished>) {
    loop {
        if shared.draining.load(Ordering::SeqCst) {
            return;
        }
        let index = shared.next.fetch_add(1, Ordering::SeqCst);
        let Some((job, difficulty)) = shared.jobs.get(index) else { return };
        let live = Arc::new(Mutex::new(Live::new()));
        lock(&shared.watch).in_flight.insert(index, Arc::clone(&live));
        // A thread per game, named after it: a stack overflow names the game in the log.
        let finished = std::thread::scope(|s| {
            let game = std::thread::Builder::new()
                .name(format!("game {}", job.game))
                .stack_size(STACK)
                .spawn_scoped(s, || run_job(shared, index, job, *difficulty, &live));
            match game {
                Ok(h) => h.join().unwrap_or_else(|payload| failed(shared, index, job, "panic", payload_text(&*payload))),
                Err(e) => failed(shared, index, job, "error", format!("could not start the game's thread: {e}")),
            }
        });
        // Under the watch lock, so the watchdog never sees a game both in flight and finished.
        let mut w = lock(&shared.watch);
        w.in_flight.remove(&index);
        if w.abandoned.remove(&index) {
            continue; // already written off as hung; this late result is dropped
        }
        if tx.send(finished).is_err() {
            return;
        }
    }
}

/// A failure found outside the game itself (its thread didn't start, or a panic escaped).
fn failed(shared: &Shared, index: usize, job: &Job, end: &'static str, error: String) -> Finished {
    let mut r = GameResult::new(job, &shared.card_data);
    r.end = end;
    r.error = Some(error);
    Finished { index, line: result_line(&r), end, turns: 0, secs: 0.0 }
}

/// One result line, flushed at once so a killed run keeps every finished game.
fn write(out: &mut std::fs::File, line: &str) -> std::io::Result<()> {
    out.write_all(format!("{line}\n").as_bytes())?;
    out.flush()
}

fn result_line(r: &GameResult) -> String {
    serde_json::to_string(r).expect("result serializes")
}

fn run_job(shared: &Shared, index: usize, job: &Job, difficulty: AiDifficulty, live: &Mutex<Live>) -> Finished {
    let started = Instant::now();
    let cpu_start = thread_cpu_secs().unwrap_or(0.0);
    CURRENT_GAME.with(|g| *g.borrow_mut() = job.game.clone());
    LAST_PANIC.with(|p| *p.borrow_mut() = None);
    let players = job.decks.len();
    let mut result = GameResult::new(job, &shared.card_data);

    // Games whose decks didn't load are taken out before any game starts; this is a safeguard.
    let mut decks = Vec::with_capacity(players);
    let mut problems = Vec::new();
    for id in &job.decks {
        match shared.decks.get(id) {
            Some(Ok(d)) => decks.push(d.clone()),
            Some(Err(e)) => problems.push(e.clone()),
            None => problems.push(format!("{id}: not loaded")),
        }
    }
    if !problems.is_empty() {
        problems.dedup();
        result.error = Some(format!("{DECK_ERRORS} {}", problems.join(" | ")));
        result.ms = started.elapsed().as_millis() as u64;
        return Finished { index, line: result_line(&result), end: "error", turns: 0, secs: started.elapsed().as_secs_f64() };
    }

    let fault = shared.fault.as_ref().filter(|(_, g)| *g == job.game).map(|(f, _)| *f);
    let lim = Limits {
        cpu_start,
        started,
        wall: Duration::from_secs(job.max_seconds.saturating_mul(WALL_FACTOR)),
        turn_action_cap: shared.turn_action_cap,
        panic_after: (fault == Some(Fault::Panic)).then_some(50),
        hang_after: (fault == Some(Fault::Hang)).then_some(30),
    };
    let mut progress = Progress::new(players);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| play(&shared.db, decks, job, difficulty, &mut progress, live, &lim)));
    if progress.fallbacks > 0 {
        eprintln!(
            "lab: game {}: the AI found no action {} time(s); phase's fallback_action answered (first: {})",
            job.game,
            progress.fallbacks,
            progress.fallback_first.as_deref().unwrap_or("?")
        );
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
                Ending::Win(w) => ("win", Some(w), None),
                Ending::Draw => ("draw", None, None),
                Ending::TurnCap => ("turn_cap", None, None),
                Ending::ActionCap => ("action_cap", None, None),
                Ending::TimeCap => ("time_cap", None, None),
                Ending::Error(e) => ("error", None, Some(e)),
            };
            result.end = end;
            result.winner = winner;
            result.error = error;
            if end == "action_cap" {
                // Not a failure, so the result's error stays null; the log says what the loop was.
                let why = if progress.loop_guard {
                    format!("loop guard, {} actions without the turn ending", shared.turn_action_cap)
                } else {
                    format!("max_actions {}", job.max_actions)
                };
                eprintln!("lab: game {} hit the action cap at turn {} ({why}): {}", job.game, progress.turn, progress.stall_summary());
            }
            if end == "time_cap" {
                eprintln!(
                    "lab: game {} used its {}s of CPU time at turn {} after {} actions ({:.0}s wall clock); written as time_cap, \
                     which the analysis doesn't score",
                    job.game,
                    job.max_seconds,
                    progress.turn,
                    progress.actions,
                    started.elapsed().as_secs_f64()
                );
            }
            if end == "turn_cap" {
                // Stopped as turn max_turns + 1 began: max_turns turns were played.
                result.turns = job.max_turns;
            }
            if end != "error" {
                result.placements = placements(n, winner, &progress.out_groups);
            }
        }
        Err(payload) => {
            result.end = "panic";
            let text = LAST_PANIC.with(|p| p.borrow_mut().take()).unwrap_or_else(|| payload_text(&*payload));
            result.error = Some(text);
        }
    }
    result.ms = started.elapsed().as_millis() as u64;
    Finished { index, line: result_line(&result), end: result.end, turns: result.turns, secs: started.elapsed().as_secs_f64() }
}

/// The line written for a game the watchdog gave up on, with everything its thread had shown.
fn hung_line(job: &Job, card_data: &str, live: &Live, hang_secs: u64) -> String {
    let mut r = GameResult::new(job, card_data);
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
    result_line(&r)
}

// ---------------------------------------------------------------------------------------------
// Main

fn run() -> i32 {
    let argv: Vec<String> = std::env::args().collect();
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    match run_batch(&args) {
        Ok(Exit::Code(code)) => code,
        Ok(Exit::Restart) => restart(&argv, args.no_restart),
        Err(e) => {
            eprintln!("lab: {e}");
            1
        }
    }
}

enum Exit {
    Code(i32),
    /// Games remain after hung games: continue in a clean process.
    Restart,
}

/// Arguments for the restarted process: the same, plus --skip-done. --retry-errors stays, and
/// RETRY_BEFORE_ENV keeps it to the failures that were in the file before the run began.
fn restart_args(argv: &[String]) -> Vec<String> {
    let mut args: Vec<String> = argv.iter().skip(1).cloned().collect();
    if !args.iter().any(|a| a == "--skip-done") {
        args.push("--skip-done".into());
    }
    args
}

/// Replace this process with a fresh copy of the runner (exec), which drops the hung game's
/// thread and resumes with --skip-done. Returns an exit code only if that can't happen.
fn restart(argv: &[String], no_restart: bool) -> i32 {
    if no_restart {
        eprintln!("lab: games remain after a hung game; exit code 3 (--no-restart). Run again with --skip-done to continue.");
        return 3;
    }
    let done: u32 = std::env::var(RESTARTS_ENV).ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    if done >= MAX_RESTARTS {
        eprintln!("lab: {done} restarts after hung games already; exit code 3. Run again with --skip-done to continue.");
        return 3;
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("lab: can't find this program to restart it ({e}); exit code 3. Run again with --skip-done to continue.");
            return 3;
        }
    };
    eprintln!("lab: restarting in a clean process to free the hung game's thread (restart {} of at most {MAX_RESTARTS})", done + 1);
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(exe).args(restart_args(argv)).env(RESTARTS_ENV, (done + 1).to_string()).exec();
    eprintln!("lab: restart failed ({err}); exit code 3. Run again with --skip-done to continue.");
    3
}

/// Counts and logs finished games as the main thread writes them.
struct Tally {
    out: std::fs::File,
    started: Instant,
    written: usize,
    skipped: usize,
    scheduled: usize,
    ends: BTreeMap<&'static str, usize>,
}

impl Tally {
    fn take(&mut self, f: &Finished, game: &str) -> std::io::Result<()> {
        write(&mut self.out, &f.line)?;
        self.count(f.end);
        eprintln!(
            "lab: {}/{} done ({} skipped) | {:.1} games/h | {game} {} turn {} in {:.1}s | {}",
            self.written + self.skipped,
            self.scheduled,
            self.skipped,
            self.rate(),
            f.end,
            f.turns,
            f.secs,
            self.ends_text()
        );
        Ok(())
    }

    fn count(&mut self, end: &'static str) {
        self.written += 1;
        *self.ends.entry(end).or_default() += 1;
    }

    fn rate(&self) -> f64 {
        self.written as f64 / (self.started.elapsed().as_secs_f64() / 3600.0).max(1e-9)
    }

    fn ends_text(&self) -> String {
        self.ends.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ")
    }
}

fn run_batch(args: &Args) -> anyhow::Result<Exit> {
    if thread_cpu_secs().is_none() {
        anyhow::bail!("this system has no per-thread CPU clock (clock_gettime CLOCK_THREAD_CPUTIME_ID); max_seconds can't be applied");
    }
    // Schedule first: a bad line fails before the slow card-data load.
    let text = std::fs::read_to_string(&args.schedule).map_err(|e| anyhow::anyhow!("reading {}: {e}", args.schedule.display()))?;
    let mut jobs = Vec::new();
    let mut seen = HashSet::new();
    for (n, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let (job, difficulty) = parse_job(line).map_err(|e| anyhow::anyhow!("{} line {}: {e}", args.schedule.display(), n + 1))?;
        if !seen.insert(job.game.clone()) {
            anyhow::bail!("{} line {}: game id {:?} appears twice", args.schedule.display(), n + 1, job.game);
        }
        jobs.push((job, difficulty));
    }
    let scheduled = jobs.len();
    let restarts: u32 = std::env::var(RESTARTS_ENV).ok().and_then(|v| v.parse().ok()).unwrap_or(0);

    let mut skipped = 0;
    let mut replays = 0;
    if args.skip_done {
        let retry_before = if args.retry_errors {
            // The first process of the run fixes the limit; restarts inherit it.
            match std::env::var(RETRY_BEFORE_ENV).ok().and_then(|v| v.parse().ok()) {
                Some(limit) => Some(limit),
                None => {
                    let len = std::fs::metadata(&args.out).map(|m| m.len()).unwrap_or(0);
                    // SAFETY: only this thread touches the environment, before any worker starts.
                    unsafe { std::env::set_var(RETRY_BEFORE_ENV, len.to_string()) };
                    Some(len)
                }
            }
        } else {
            None
        };
        let done = done_games(&args.out, retry_before)?;
        if done.dropped > 0 {
            eprintln!("lab: dropped a partial last line ({} bytes) from {}", done.dropped, args.out.display());
        }
        jobs.retain(|(j, _)| !done.ids.contains(&j.game));
        skipped = scheduled - jobs.len();
        replays = jobs.iter().filter(|(j, _)| done.retried.contains(&j.game)).count();
    } else if std::fs::metadata(&args.out).map(|m| m.len() > 0).unwrap_or(false) {
        anyhow::bail!("{} already has results; pass --skip-done to resume it, or choose a new --out", args.out.display());
    }
    let restarted = if restarts > 0 { format!(" (restart {restarts} after hung games)") } else { String::new() };
    eprintln!(
        "lab: runner {RUNNER}, {ENGINE}{restarted}; {scheduled} games scheduled, {skipped} already done, {} to play on {} threads",
        jobs.len(),
        args.threads
    );
    if replays > 0 {
        eprintln!("lab: {replays} of them have only a failed result so far (deck errors, or --retry-errors) and are played again");
    }
    if jobs.is_empty() {
        return Ok(Exit::Code(0));
    }

    let t = Instant::now();
    let engine = Engine::load(&args.card_data)?;
    eprintln!("lab: card data {} ({} cards) loaded in {:.1}s", args.card_data.display(), engine.card_count(), t.elapsed().as_secs_f64());

    let ids: std::collections::BTreeSet<&String> = jobs.iter().flat_map(|(j, _)| &j.decks).collect();
    let mut decks = HashMap::new();
    let mut bad = 0;
    for id in ids {
        let loaded = load_deck(&engine, &args.decks_root, id);
        match &loaded {
            Ok((_, count)) if *count != 100 => eprintln!("lab: warning: {id} has {count} cards, not 100"),
            Ok(_) => {}
            Err(e) => {
                bad += 1;
                eprintln!("lab: deck error: {e}");
            }
        }
        decks.insert(id.clone(), loaded.map(|(d, _)| d));
    }
    eprintln!("lab: {} decks loaded, {bad} with errors", decks.len());
    if bad == decks.len() {
        // Almost always a wrong --decks-root or mount.
        anyhow::bail!(
            "no deck loaded; check --decks-root {} (deck ids are paths under it without .txt); nothing was written",
            args.decks_root.display()
        );
    }
    // Games with a deck that didn't load are neither played nor written, so once the deck is
    // fixed, --skip-done plays them.
    let before = jobs.len();
    let mut unplayable: Vec<String> = Vec::new();
    jobs.retain(|(j, _)| {
        let ok = j.decks.iter().all(|id| matches!(decks.get(id), Some(Ok(_))));
        if !ok {
            unplayable.push(j.game.clone());
        }
        ok
    });
    if !unplayable.is_empty() {
        let shown: Vec<&str> = unplayable.iter().take(10).map(String::as_str).collect();
        eprintln!(
            "lab: {} of {before} games not played because a deck didn't load (not written; fix the decks and rerun with --skip-done): {}{}",
            unplayable.len(),
            shown.join(", "),
            if unplayable.len() > shown.len() { ", …" } else { "" }
        );
    }
    let deck_code = if unplayable.is_empty() { 0 } else { 4 };
    if jobs.is_empty() {
        return Ok(Exit::Code(deck_code));
    }

    let out = OpenOptions::new().create(true).append(true).open(&args.out).map_err(|e| anyhow::anyhow!("opening {}: {e}", args.out.display()))?;
    let total = jobs.len();
    let threads = args.threads.min(total);
    let shared = Arc::new(Shared {
        db: Arc::clone(engine.database()),
        jobs,
        decks,
        card_data: card_data_hash(&args.card_data),
        next: AtomicUsize::new(0),
        draining: AtomicBool::new(false),
        watch: Mutex::new(Watch::default()),
        hang_secs: std::env::var("YAMA_LAB_HANG_SECS").ok().and_then(|v| v.parse().ok()).filter(|s| *s > 0).unwrap_or(HANG_SECS),
        fault: read_fault(),
        turn_action_cap: std::env::var("YAMA_LAB_MAX_TURN_ACTIONS").ok().and_then(|v| v.parse().ok()).unwrap_or(MAX_TURN_ACTIONS),
    });
    drop(engine);

    install_panic_hook();
    let (tx, rx) = mpsc::channel::<Finished>();
    for n in 0..threads {
        spawn_worker(Arc::clone(&shared), tx.clone(), n)?;
    }
    // Only workers hold senders now: the channel disconnects once they have all stopped.
    drop(tx);

    let mut tally = Tally { out, started: Instant::now(), written: 0, skipped, scheduled, ends: BTreeMap::new() };
    let hang = Duration::from_secs(shared.hang_secs);
    loop {
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(f) => tally.take(&f, &shared.jobs[f.index].0.game)?,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                if tally.written < total && !shared.draining.load(Ordering::SeqCst) {
                    anyhow::bail!("all workers stopped with {} games unwritten", total - tally.written);
                }
                break;
            }
        }
        // Watchdog: write off games stuck inside one step, with what their threads last showed.
        let hung: Vec<(usize, Arc<Mutex<Live>>)> = {
            let mut w = lock(&shared.watch);
            let now = Instant::now();
            let ids: Vec<usize> = w.in_flight.iter().filter(|(_, l)| now.duration_since(lock(l).last_step) >= hang).map(|(i, _)| *i).collect();
            ids.into_iter()
                .filter_map(|i| {
                    let l = w.in_flight.remove(&i)?;
                    w.abandoned.insert(i);
                    Some((i, l))
                })
                .collect()
        };
        for (i, live) in hung {
            let job = &shared.jobs[i].0;
            let line = hung_line(job, &shared.card_data, &lock(&live), shared.hang_secs);
            write(&mut tally.out, &line)?;
            tally.count("error");
            let first = !shared.draining.swap(true, Ordering::SeqCst);
            eprintln!(
                "lab: game {} hung (no move for {}s at {}); written off as an error{}",
                job.game,
                shared.hang_secs,
                lock(&live).at,
                if first { "; starting no new games, finishing the ones in progress, then restarting cleanly" } else { "" }
            );
        }
        if tally.written == total {
            break;
        }
        if shared.draining.load(Ordering::SeqCst) && lock(&shared.watch).in_flight.is_empty() {
            // Every game still running has finished; pick up any result sent just now.
            while let Ok(f) = rx.try_recv() {
                tally.take(&f, &shared.jobs[f.index].0.game)?;
            }
            break;
        }
    }
    eprintln!(
        "lab: finished {} of {total} games in {:.1} min ({:.1} games/h): {}",
        tally.written,
        tally.started.elapsed().as_secs_f64() / 60.0,
        tally.rate(),
        tally.ends_text()
    );
    if tally.written < total {
        return Ok(Exit::Restart);
    }
    if deck_code != 0 {
        eprintln!("lab: exit code 4: {} games still need decks that didn't load", unplayable.len());
    }
    Ok(Exit::Code(deck_code))
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
        let (job, d) = parse_job(line).unwrap();
        assert_eq!(job.seed, u64::MAX);
        assert_eq!(d, AiDifficulty::Medium);
        assert!(parse_job(&line.replace("Medium", "Mediu")).is_err());
        assert!(parse_job(&line.replace(r#","b","c","d""#, "")).is_err());
    }

    #[test]
    fn card_data_hash_from_file_name() {
        assert_eq!(card_data_hash(Path::new("/x/card-data-eb309108eb0df708.json")), "eb309108eb0df708");
        assert_eq!(card_data_hash(Path::new("/x/cards.json")), "unknown");
    }

    fn temp_results(name: &str, text: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("lab-{name}-{}.jsonl", std::process::id()));
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn resume_drops_a_partial_line() {
        let path = temp_results("resume", "{\"game\":\"a\"}\n{\"game\":\"b\"}\n{\"game\":\"c\",\"se");
        let done = done_games(&path, None).unwrap();
        assert_eq!(done.ids, HashSet::from(["a".to_string(), "b".to_string()]));
        assert!(done.dropped > 0);
        assert!(std::fs::read_to_string(&path).unwrap().ends_with("\"b\"}\n"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn resume_replays_deck_errors_and_with_retry_only_older_failures() {
        let old = concat!(
            r#"{"game":"ok","end":"win","error":null}"#,
            "\n",
            r#"{"game":"deck","end":"error","error":"deck errors: precons/x: can't read"}"#,
            "\n",
            r#"{"game":"hung","end":"error","error":"hung: no move"}"#,
            "\n",
            r#"{"game":"boom","end":"panic","error":"x"}"#,
            "\n",
            r#"{"game":"fixed","end":"error","error":"deck errors: y"}"#,
            "\n",
        );
        let newer = concat!(r#"{"game":"fixed","end":"win","error":null}"#, "\n", r#"{"game":"late","end":"error","error":"hung: again"}"#, "\n");
        let path = temp_results("retry", &format!("{old}{newer}"));
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<HashSet<String>>();

        let done = done_games(&path, None).unwrap();
        assert_eq!(done.ids, ids(&["ok", "hung", "boom", "fixed", "late"]));
        assert_eq!(done.retried, ids(&["deck"]));

        // --retry-errors: failures before the run's starting length are replayed, later ones not.
        let done = done_games(&path, Some(old.len() as u64)).unwrap();
        assert_eq!(done.ids, ids(&["ok", "fixed", "late"]));
        assert_eq!(done.retried, ids(&["deck", "hung", "boom"]));
        std::fs::remove_file(&path).ok();
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

    #[test]
    fn restart_keeps_arguments_and_adds_skip_done() {
        let argv: Vec<String> = ["lab", "--out", "r.jsonl", "--threads", "6"].iter().map(|s| s.to_string()).collect();
        assert_eq!(restart_args(&argv), ["--out", "r.jsonl", "--threads", "6", "--skip-done"]);
        let argv: Vec<String> = ["lab", "--skip-done", "--retry-errors"].iter().map(|s| s.to_string()).collect();
        assert_eq!(restart_args(&argv), ["--skip-done", "--retry-errors"]);
    }
}
