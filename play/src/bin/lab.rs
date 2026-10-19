//! Simulation lab runner: plays a schedule of all-AI Commander games and writes one JSON line
//! per game. Design: commander-decks docs/deck-lab-plan.md. The deck, schedule and result
//! formats are the lab's shared contract; keep them in step with the Python side
//! (commander-decks scripts/sim/). Playing one game, the limits it runs under and the result
//! line live in the library (`yama_play::lab`); this is the batch around it.
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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use phase_ai::config::AiDifficulty;
use yama_play::lab::{
    self, DECK_ERRORS, ENGINE, GameOptions, GameResult, GameSpec, Live, MAX_TURN_ACTIONS, RUNNER, STACK, card_data_hash, load_deck,
    thread_cpu_secs,
};
use yama_play::{Engine, SeatDeck};

/// Wall-clock seconds without a single move (an AI action or a settled contest) after which a game
/// counts as stuck inside one engine or AI step. A normal step takes well under a second; the
/// limits between steps (turns, actions, CPU time) can't stop a step that never returns.
/// YAMA_LAB_HANG_SECS overrides it.
const HANG_SECS: u64 = 300;
/// Restarts in a clean process (after hung games) before the runner gives up with exit code 3.
const MAX_RESTARTS: u32 = 25;
/// Counts restarts across exec; a fresh run starts at 0.
const RESTARTS_ENV: &str = "YAMA_LAB_RESTARTS";
/// Byte length of the results file when the first process of this run started, carried across
/// restarts so --retry-errors only replays failures written before the run began.
const RETRY_BEFORE_ENV: &str = "YAMA_LAB_RETRY_BEFORE";

fn main() {
    let handle = std::thread::Builder::new().name("lab-main".into()).stack_size(STACK).spawn(run).expect("spawn main thread");
    let code = handle.join().unwrap_or(101);
    std::process::exit(code);
}

/// Lock a mutex even if a panicking thread poisoned it (the data is plain bookkeeping).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
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

// ---------------------------------------------------------------------------------------------
// Schedule

type Job = GameSpec;

fn parse_job(line: &str) -> Result<(Job, AiDifficulty), String> {
    GameSpec::parse(line)
}

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
// Workers

struct Shared {
    engine: Engine,
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
        let finished = run_job(shared, index, job, *difficulty, &live);
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

/// One result line, flushed at once so a killed run keeps every finished game.
fn write(out: &mut std::fs::File, line: &str) -> std::io::Result<()> {
    out.write_all(format!("{line}\n").as_bytes())?;
    out.flush()
}

/// Play one scheduled game on a thread of its own (named after it: a stack overflow names the
/// game in the log) and print its notes.
fn run_job(shared: &Shared, index: usize, job: &Job, difficulty: AiDifficulty, live: &Mutex<Live>) -> Finished {
    let started = Instant::now();
    // Games whose decks didn't load are taken out before any game starts; this is a safeguard.
    let mut decks = Vec::with_capacity(job.decks.len());
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
        let mut result = GameResult::new(job, &shared.card_data);
        result.error = Some(format!("{DECK_ERRORS} {}", problems.join(" | ")));
        result.ms = started.elapsed().as_millis() as u64;
        return Finished { index, line: result.to_line(), end: result.end.as_str(), turns: 0, secs: started.elapsed().as_secs_f64() };
    }

    let fault = shared.fault.as_ref().filter(|(_, g)| *g == job.game).map(|(f, _)| *f);
    let opts = GameOptions {
        turn_action_cap: shared.turn_action_cap,
        panic_after: (fault == Some(Fault::Panic)).then_some(50),
        hang_after: (fault == Some(Fault::Hang)).then_some(30),
    };
    let report = lab::play_game_isolated(&shared.engine, job, difficulty, decks, &shared.card_data, &opts, live);
    for note in &report.notes {
        eprintln!("lab: {note}");
    }
    let r = &report.result;
    Finished { index, line: r.to_line(), end: r.end.as_str(), turns: r.turns, secs: report.secs }
}

/// The line written for a game the watchdog gave up on, with everything its thread had shown.
fn hung_line(job: &Job, card_data: &str, live: &Live, hang_secs: u64) -> String {
    lab::hung_result(job, card_data, live, hang_secs).to_line()
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
        engine,
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

    lab::install_panic_hook();
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
    fn restart_keeps_arguments_and_adds_skip_done() {
        let argv: Vec<String> = ["lab", "--out", "r.jsonl", "--threads", "6"].iter().map(|s| s.to_string()).collect();
        assert_eq!(restart_args(&argv), ["--out", "r.jsonl", "--threads", "6", "--skip-done"]);
        let argv: Vec<String> = ["lab", "--skip-done", "--retry-errors"].iter().map(|s| s.to_string()).collect();
        assert_eq!(restart_args(&argv), ["--skip-done", "--retry-errors"]);
    }
}
