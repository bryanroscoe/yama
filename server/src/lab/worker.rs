//! The lab worker: plays the games of "Try a change" experiments inside the server.
//!
//! - It uses the rules engine the play hub already loaded (one copy of the card data in memory),
//!   through [`EngineSim`]. Tests use a fake [`Simulator`] so they run in milliseconds.
//! - YAMA_LAB_THREADS games at a time (default 2), each on its own thread with a 32 MiB stack, with
//!   the lab core's limits: the turn, action and per-turn loop caps, and the per-game CPU cap. The
//!   limits are the ones frozen into the experiment when it was created.
//! - First in, first out across users, by experiment: every free thread takes the oldest
//!   experiment's next game. A user who isn't an admin has one experiment playing at a time; their
//!   next one waits even when a thread is free, and someone else's runs instead.
//! - Every game's result line is stored as it finishes, with the experiment's progress and summary,
//!   in one transaction. A game with no stored result is played (again) by the next pass, so after
//!   a restart the worker resumes queued and running experiments where they stopped, replaying only
//!   the games that were in flight. Storing is conditional (`result IS NULL`), so a game's result
//!   is never written twice, and a result for a deleted experiment is dropped.
//! - Every start is counted (`attempts`). A stack overflow or an abort inside a game ends the whole
//!   server, and nothing in the process can catch it. A game started [`MAX_ATTEMPTS`] times without
//!   a result is written off as an error instead of being played again, so one such game can't take
//!   the server down on every restart.
//! - A game that makes no move for HANG_SECS is stuck inside one engine or AI step. It is written
//!   off as an error (as the batch runner does). A thread can't be stopped from outside, so it stays
//!   behind, still busy, and the worker plays one game fewer at a time until that thread ends or the
//!   server restarts. The log says so.
//! - A phase game cut short by the machine (the CPU-time cap, a hang, the wall-clock safety net;
//!   [`GameResult::cut_short_by_machine`]) isn't stored the first time: it goes back in the queue,
//!   once, behind the run's other games. A game replays move for move from its schedule line, so
//!   on a healthy machine the retry gives the game's real result; a game that really is that long
//!   ends the same way again and is stored then. A retry of a hung game whose first thread has
//!   finished meanwhile keeps that thread's result instead of playing it again; one whose first
//!   thread is still busy isn't played again (it would only hang a second thread).
//! - Cancelling stops an experiment's remaining games from starting; games already running finish
//!   and are kept. Its summary is marked final only once none of its games is playing: by the
//!   cancel itself when none is, otherwise by the worker when the last one is stored
//!   ([`LabWorker::settle`]), and at startup for any a stopped server left open. A game is claimed
//!   (in memory) before the write that starts it, and that write skips experiments no longer
//!   queued or running, so a cancel never sees "nothing playing" while a game of it can still start.
//! - Every game plays on the build the server has now (engine, card data, runner), and its result
//!   line says so. A pod whose one game is stored from another build (the server was redeployed,
//!   or its card data changed, part way through) has that game cleared, so both of its games
//!   replay on this build: a pod is never split across builds. The summary lists every build with
//!   its games.

use super::experiments::{ExperimentSpec, LabCard, LabList, NO_CARD_DATA};
use super::forge::{self, ForgeCards, ForgeClient, ForgeLive, ForgePlay, ForgeView};
use super::pairing::{LIMITS, Limits};
use super::stats::{self, Build, Outcome, Summary};
use crate::error::{AppError, AppResult};
use crate::util::now;
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;
use tokio::sync::Notify;
use yama_play::lab::{self, DECK_ERRORS, ENGINE, End, GameOptions, GameReport, GameResult, GameSpec, Live, RUNNER, STACK};
use yama_play::{DeckLine, Engine};

/// Seconds without a move before a game counts as hung (the batch runner's default).
const HANG_SECS: u64 = 300;
/// Starts without a stored result before a game is written off instead of played again. Two
/// crashes, then the game is skipped. A game in flight during two ordinary restarts is written off
/// too (rare, and its error says why).
pub const MAX_ATTEMPTS: i64 = 2;
/// How often the worker looks for work when nothing wakes it.
const POLL: Duration = Duration::from_secs(10);
/// How often a waiting game is checked for a hang.
const WATCH_EVERY: Duration = Duration::from_secs(5);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What plays the games: the rules engine in the server, or a fake in tests.
pub trait Simulator: Send + Sync + 'static {
    /// The engine card data's hash, for labels.
    fn card_data(&self) -> String;
    /// Names in `cards` the engine doesn't know.
    fn unknown(&self, cards: &[LabCard]) -> Vec<String>;
    /// Play one game to its end. The schedule line carries the turn, action and CPU caps; `limits`
    /// (the experiment's, frozen when it was created) adds the per-turn loop guard. Blocking (run it
    /// off the async threads); never panics.
    fn play(&self, spec: &GameSpec, decks: &[Arc<LabList>], limits: &Limits) -> GameResult;
    /// Game threads written off as hung that are still running. Each keeps a core busy, so the
    /// worker starts that many fewer games at a time.
    fn stuck(&self) -> usize {
        0
    }
    /// What became of an earlier try of `game` that was written off as hung (in this process).
    fn earlier_try(&self, _game: &str) -> EarlierTry {
        EarlierTry::Unknown
    }
}

/// An earlier try of a game written off as hung.
pub enum EarlierTry {
    /// Never written off as hung in this process (or its result was taken already).
    Unknown,
    /// Its thread is still busy.
    Playing,
    /// Its thread finished after all, with this result.
    Finished(GameResult),
}

/// The build a simulator plays on: the engine and runner this server was built with, and the
/// simulator's card data (what every result line it writes carries).
pub fn current_build(sim: &dyn Simulator) -> Build {
    Build { engine: ENGINE.into(), card_data: sim.card_data(), runner: RUNNER.into() }
}

fn deck_lines(cards: &[LabCard]) -> Vec<DeckLine<'_>> {
    cards
        .iter()
        .map(|c| DeckLine { oracle_id: c.oracle_id.as_deref().unwrap_or(""), name: &c.name, qty: c.qty, commander: c.commander })
        .collect()
}

/// The real simulator: the play hub's engine and the lab core.
pub struct EngineSim {
    engine: Arc<Engine>,
    card_data: String,
    hang: Duration,
    /// Games written off as hung whose threads are still running.
    stuck: Arc<AtomicUsize>,
    /// Games written off as hung, by game id: None while the thread is busy, then its result.
    late: Arc<Mutex<HashMap<String, Option<GameResult>>>>,
}

impl EngineSim {
    pub fn new(engine: Arc<Engine>, card_data: String) -> Self {
        Self { engine, card_data, hang: Duration::from_secs(HANG_SECS), stuck: Arc::default(), late: Arc::default() }
    }
}

/// A game thread's state, shared with the thread watching it.
const RUNNING: u8 = 0;
const FINISHED: u8 = 1;
const WRITTEN_OFF: u8 = 2;

/// Marks a game thread finished when it ends (even by a panic), and frees its place in the stuck
/// count if the watcher had already written it off.
struct ThreadExit {
    state: Arc<AtomicU8>,
    stuck: Arc<AtomicUsize>,
    game: String,
}

impl Drop for ThreadExit {
    fn drop(&mut self) {
        if self.state.swap(FINISHED, Ordering::SeqCst) == WRITTEN_OFF {
            let left = self.stuck.fetch_sub(1, Ordering::SeqCst) - 1;
            tracing::warn!(game = %self.game, stuck_threads = left, "a lab game written off as hung has ended after all; its thread is free again");
        }
    }
}

/// The watcher's side: write a running game off and count its thread as stuck. False when the game
/// finished first (its report is then waiting in the channel). Counted before the state changes,
/// so the thread can never uncount itself first.
fn write_off(state: &AtomicU8, stuck: &AtomicUsize) -> bool {
    stuck.fetch_add(1, Ordering::SeqCst);
    if state.compare_exchange(RUNNING, WRITTEN_OFF, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        true
    } else {
        stuck.fetch_sub(1, Ordering::SeqCst);
        false
    }
}

impl Simulator for EngineSim {
    fn card_data(&self) -> String {
        self.card_data.clone()
    }

    fn unknown(&self, cards: &[LabCard]) -> Vec<String> {
        // Name lookups only: quantities are never expanded here.
        self.engine.unknown_cards(&deck_lines(cards))
    }

    fn stuck(&self) -> usize {
        self.stuck.load(Ordering::SeqCst)
    }

    fn earlier_try(&self, game: &str) -> EarlierTry {
        let mut late = lock(&self.late);
        match late.get(game) {
            None => EarlierTry::Unknown,
            Some(None) => EarlierTry::Playing,
            Some(Some(_)) => late.remove(game).flatten().map_or(EarlierTry::Unknown, EarlierTry::Finished),
        }
    }

    fn play(&self, spec: &GameSpec, decks: &[Arc<LabList>], limits: &Limits) -> GameResult {
        let failed = |end: End, why: String| GameReport::failed(spec, &self.card_data, end, why).result;
        let difficulty = match spec.check() {
            Ok(d) => d,
            Err(e) => return failed(End::Error, e),
        };
        if decks.len() != spec.decks.len() {
            return failed(End::Error, format!("{DECK_ERRORS} {} decks for {} seats", decks.len(), spec.decks.len()));
        }
        let mut seats = Vec::with_capacity(decks.len());
        let mut problems = Vec::new();
        for (id, list) in spec.decks.iter().zip(decks) {
            let (deck, report) = self.engine.resolve_deck(&deck_lines(&list.cards));
            if !report.missing.is_empty() {
                problems.push(format!("{id}: unknown cards: {}", report.missing.join("; ")));
            }
            seats.push(deck);
        }
        if !problems.is_empty() {
            return failed(End::Error, format!("{DECK_ERRORS} {}", problems.join(" | ")));
        }
        let opts = GameOptions { turn_action_cap: limits.turn_action_cap, ..GameOptions::default() };
        let live = Arc::new(Mutex::new(Live::new()));
        let state = Arc::new(AtomicU8::new(RUNNING));
        let (tx, rx) = std::sync::mpsc::channel();
        let started = {
            let exit = ThreadExit { state: Arc::clone(&state), stuck: Arc::clone(&self.stuck), game: spec.game.clone() };
            let (engine, spec, card_data, live) = (Arc::clone(&self.engine), spec.clone(), self.card_data.clone(), Arc::clone(&live));
            let (state, late) = (Arc::clone(&state), Arc::clone(&self.late));
            std::thread::Builder::new().name(format!("game {}", spec.game)).stack_size(STACK).spawn(move || {
                let _exit = exit;
                let report = lab::play_game(&engine, &spec, difficulty, seats, &card_data, &opts, &live);
                // Marked finished before it is sent: a watcher that then fails to write it off waits
                // for the report. A game already written off keeps its result for its retry, and
                // `_exit` frees its place among the stuck threads.
                if state.compare_exchange(RUNNING, FINISHED, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
                    let _ = tx.send(report);
                } else {
                    lock(&late).insert(spec.game.clone(), Some(report.result));
                }
            })
        };
        if let Err(e) = started {
            return failed(End::Error, format!("could not start the game's thread: {e}"));
        }
        loop {
            match rx.recv_timeout(WATCH_EVERY) {
                Ok(report) => {
                    for note in &report.notes {
                        tracing::info!(game = %spec.game, "lab: {note}");
                    }
                    return report.result;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let l = lock(&live);
                    if l.last_step.elapsed() < self.hang {
                        continue;
                    }
                    if !write_off(&state, &self.stuck) {
                        // It finished just now: take its result.
                        continue;
                    }
                    // Unless the thread has already left its result here (it finished in between).
                    lock(&self.late).entry(spec.game.clone()).or_insert(None);
                    tracing::error!(
                        game = %spec.game,
                        at = %l.at,
                        stuck_threads = self.stuck.load(Ordering::SeqCst),
                        "lab game hung (no move for {}s); written off as an error. Its thread keeps a core busy, and the lab plays one game \
                         fewer at a time, until it ends or the server restarts",
                        self.hang.as_secs()
                    );
                    return lab::hung_result(spec, &self.card_data, &l, self.hang.as_secs());
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return failed(End::Panic, "the game's thread ended without a result".into());
                }
            }
        }
    }
}

/// Whether the worker can simulate.
pub enum SimState {
    /// The engine is still loading.
    Starting,
    Ready(Arc<dyn Simulator>),
    /// No engine card data (or it failed to load): experiments are unavailable.
    Missing(String),
}

/// An experiment's lists by deck id (its base, its changed list and its opponents) and its limits,
/// read once from its spec.
pub(crate) struct Frozen {
    lists: HashMap<String, Arc<LabList>>,
    limits: Limits,
    /// The Forge AI profile its Forge games play.
    profile: String,
}

#[derive(Default)]
struct Inner {
    /// (experiment, game) pairs claimed to play now: from just before the write that starts them
    /// until their result is stored (or the start is called off).
    in_flight: HashSet<(String, String)>,
    /// Each playing experiment's lists and limits.
    frozen: HashMap<String, Arc<Frozen>>,
    /// Experiments already checked for pods half played on another build (in this process).
    build_checked: HashSet<String>,
    /// Game tasks not finished yet (result stored and the experiment settled).
    tasks: usize,
    /// Of `in_flight`, the games handed to the Forge worker (they don't use a lab thread).
    forge_busy: usize,
}

/// One game handed to a thread.
pub(crate) struct Job {
    pub experiment: String,
    pub game: String,
    pub spec: GameSpec,
    pub limits: Limits,
    /// The seats' lists, or why the game can't be played (stored as its error, unplayed).
    pub decks: Result<Vec<Arc<LabList>>, String>,
    /// The Forge AI profile (Forge games only; phase games use the schedule line's difficulty).
    pub profile: String,
    /// Put back in the queue once already, after the machine cut its first try short.
    pub retried: bool,
}

pub struct LabWorker {
    pool: SqlitePool,
    threads: usize,
    sim: RwLock<SimState>,
    wake: Notify,
    inner: Mutex<Inner>,
    /// The Forge worker, when YAMA_FORGE_URL and YAMA_FORGE_SECRET are set (`forge.rs`).
    forge: Option<Arc<dyn ForgeClient>>,
    forge_live: Mutex<ForgeLive>,
    forge_wake: Notify,
}

impl LabWorker {
    #[cfg(test)]
    pub fn new(pool: SqlitePool, threads: usize, state: SimState) -> Arc<Self> {
        Self::new_with_forge(pool, threads, state, None)
    }

    pub fn new_with_forge(pool: SqlitePool, threads: usize, state: SimState, forge: Option<Arc<dyn ForgeClient>>) -> Arc<Self> {
        Arc::new(Self {
            pool,
            threads,
            sim: RwLock::new(state),
            wake: Notify::new(),
            inner: Mutex::new(Inner::default()),
            forge,
            forge_live: Mutex::default(),
            forge_wake: Notify::new(),
        })
    }

    /// The server's worker: waits for the play hub's engine, then plays experiments until the
    /// server stops. With `threads` 0 the lab is off: experiments can be read but not started.
    pub fn start(
        pool: SqlitePool,
        threads: usize,
        hub: Arc<crate::play::PlayHub>,
        card_data: Option<std::path::PathBuf>,
        forge: Option<Arc<dyn ForgeClient>>,
    ) -> Arc<Self> {
        let Some(path) = card_data.filter(|p| p.exists()) else {
            let worker = Self::new_with_forge(pool, threads, SimState::Missing(NO_CARD_DATA.into()), None);
            worker.spawn_settle_left_over();
            return worker;
        };
        let worker = Self::new_with_forge(pool, threads, SimState::Starting, forge);
        worker.spawn_settle_left_over();
        if worker.forge.is_some() {
            let w = Arc::clone(&worker);
            tokio::spawn(async move { w.run_forge().await });
        }
        let w = Arc::clone(&worker);
        let hash = lab::card_data_hash(&path);
        tokio::spawn(async move {
            loop {
                match hub.engine_for_lab() {
                    Ok(engine) => {
                        *w.sim.write().unwrap_or_else(|e| e.into_inner()) = SimState::Ready(Arc::new(EngineSim::new(engine, hash)));
                        break;
                    }
                    Err(None) => tokio::time::sleep(Duration::from_secs(2)).await,
                    Err(Some(why)) => {
                        *w.sim.write().unwrap_or_else(|e| e.into_inner()) = SimState::Missing(format!("{NO_CARD_DATA} ({why})"));
                        return;
                    }
                }
            }
            if w.threads == 0 {
                tracing::info!("simulation lab off (YAMA_LAB_THREADS=0): experiments wait until it's turned on");
                return;
            }
            // Lab games' panics are reported with the game's id; others go to the previous hook.
            lab::install_panic_hook();
            tracing::info!(threads = w.threads, "simulation lab worker ready");
            w.run().await;
        });
        worker
    }

    /// Games the lab plays at once (YAMA_LAB_THREADS; 0 = the lab is off).
    pub fn threads(&self) -> usize {
        self.threads
    }

    /// For reading experiments: refused only when this server has no engine card data.
    pub fn check_available(&self) -> AppResult<()> {
        match &*self.sim.read().unwrap_or_else(|e| e.into_inner()) {
            SimState::Missing(why) => Err(AppError::Unavailable(why.clone())),
            _ => Ok(()),
        }
    }

    /// For starting an experiment: the simulator, once the engine is loaded and the lab is on.
    pub fn simulator(&self) -> AppResult<Arc<dyn Simulator>> {
        match &*self.sim.read().unwrap_or_else(|e| e.into_inner()) {
            SimState::Missing(why) => Err(AppError::Unavailable(why.clone())),
            SimState::Starting => Err(AppError::Unavailable("The rules engine is still starting; try again in a minute".into())),
            SimState::Ready(_) if self.threads == 0 => Err(AppError::Unavailable("Simulations are turned off on this server (YAMA_LAB_THREADS is 0)".into())),
            SimState::Ready(sim) => Ok(Arc::clone(sim)),
        }
    }

    fn ready(&self) -> Option<Arc<dyn Simulator>> {
        match &*self.sim.read().unwrap_or_else(|e| e.into_inner()) {
            SimState::Ready(sim) => Some(Arc::clone(sim)),
            _ => None,
        }
    }

    /// Look for work now (after an experiment is created or cancelled).
    pub fn wake(&self) {
        self.wake.notify_one();
    }

    /// Whether a game of `experiment` is claimed or playing now.
    pub fn playing(&self, experiment: &str) -> bool {
        lock(&self.inner).in_flight.iter().any(|(e, _)| e == experiment)
    }

    /// After an experiment's last game in flight is stored or called off: a cancelled experiment
    /// whose games are all in gets its final summary. Other experiments are left alone. The
    /// immediate transaction waits for a cancel being written, so it sees that cancel.
    pub(crate) async fn settle(&self, experiment: &str) -> AppResult<()> {
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let status: Option<String> = sqlx::query_scalar("SELECT status FROM lab_experiments WHERE id = ?").bind(experiment).fetch_optional(&mut *tx).await?;
        if status.as_deref() == Some("cancelled") && !self.playing(experiment) {
            refresh(&mut tx, experiment, true).await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Settle every cancelled experiment whose summary is still open. At startup a stopped server
    /// may have left some, cancelled while a game was in flight. Returns how many it looked at.
    pub async fn settle_left_over(&self) -> AppResult<usize> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM lab_experiments WHERE status = 'cancelled' AND (summary IS NULL OR json_extract(summary, '$.verdict.final') IS NOT 1)",
        )
        .fetch_all(&self.pool)
        .await?;
        for id in &ids {
            self.settle(id).await?;
        }
        Ok(ids.len())
    }

    /// Rewrite the summaries of finished experiments summarized before `settle_pods` (2026-10-23),
    /// so an unclear run says how many pods would settle it. The games aren't touched. Returns how
    /// many it rewrote.
    pub async fn resummarize_old(&self) -> AppResult<usize> {
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM lab_experiments WHERE status IN ('done','failed') AND summary IS NOT NULL
               AND json_valid(summary) AND json_type(summary, '$.paired.settle_pods') IS NULL",
        )
        .fetch_all(&self.pool)
        .await?;
        for id in &ids {
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
            refresh(&mut tx, id, true).await?;
            tx.commit().await?;
        }
        Ok(ids.len())
    }

    fn spawn_settle_left_over(self: &Arc<Self>) {
        let w = Arc::clone(self);
        tokio::spawn(async move {
            if let Err(e) = w.settle_left_over().await {
                tracing::error!(error = %e, "lab: settling cancelled experiments failed");
            }
            match w.resummarize_old().await {
                Ok(0) => {}
                Ok(n) => tracing::info!(experiments = n, "lab: summaries of finished experiments rewritten"),
                Err(e) => tracing::error!(error = %e, "lab: rewriting old summaries failed"),
            }
        });
    }

    /// Drop claims on games that won't play, then settle their experiments if nothing else of
    /// theirs is playing.
    async fn release(&self, jobs: &[Job]) {
        let mut idle = Vec::new();
        {
            let mut inner = lock(&self.inner);
            for j in jobs {
                inner.in_flight.remove(&(j.experiment.clone(), j.game.clone()));
            }
            for j in jobs {
                if !idle.contains(&j.experiment) && !inner.in_flight.iter().any(|(e, _)| *e == j.experiment) {
                    idle.push(j.experiment.clone());
                }
            }
        }
        for experiment in idle {
            if let Err(e) = self.settle(&experiment).await {
                tracing::error!(experiment = %experiment, error = %e, "lab: settling an experiment failed");
            }
        }
    }

    pub async fn run(self: Arc<Self>) {
        loop {
            if let Err(e) = self.tick().await {
                tracing::error!(error = %e, "lab worker pass failed; trying again shortly");
            }
            tokio::select! {
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(POLL) => {}
            }
        }
    }

    /// Hand Forge games to the Forge worker until the server stops (`forge.rs`).
    pub async fn run_forge(self: Arc<Self>) {
        loop {
            if let Err(e) = self.forge_tick().await {
                tracing::error!(error = %e, "lab: Forge pass failed; trying again shortly");
            }
            tokio::select! {
                _ = self.forge_wake.notified() => {}
                _ = tokio::time::sleep(forge::POLL) => {}
            }
        }
    }

    /// Ask the Forge worker how it is, then hand it games for its free slots. Returns how many
    /// it was handed (written-off games included). Nothing is claimed while it doesn't answer, so
    /// its games wait.
    pub(crate) async fn forge_tick(self: &Arc<Self>) -> AppResult<usize> {
        let Some(client) = self.forge.clone() else { return Ok(0) };
        let status = match client.status().await {
            Ok(s) => s,
            Err(e) => {
                let mut live = lock(&self.forge_live);
                if live.error.as_deref() != Some(e.as_str()) {
                    tracing::warn!(error = %e, "lab: the Forge worker didn't answer; its games wait");
                }
                live.error = Some(e);
                return Ok(0);
            }
        };
        {
            let mut live = lock(&self.forge_live);
            if live.cards.as_ref().is_none_or(|c| c.engine() != status.engine) {
                live.cards = Some(Arc::new(ForgeCards::new(&status.engine)));
            }
            if !live.online() {
                tracing::info!(engine = %status.engine, slots = status.slots, "lab: the Forge worker is online");
            }
            live.status = Some(status.clone());
            live.last_ok = Some(std::time::Instant::now());
            live.last_seen = Some(now());
            live.error = None;
        }
        let busy = lock(&self.inner).forge_busy;
        let free = status.slots.saturating_sub(busy);
        if free == 0 {
            return Ok(0);
        }
        let jobs = self.next_jobs_for("forge", free).await?;
        if jobs.is_empty() {
            return Ok(0);
        }
        {
            let mut inner = lock(&self.inner);
            for job in &jobs {
                inner.in_flight.insert((job.experiment.clone(), job.game.clone()));
            }
            inner.forge_busy += jobs.len();
        }
        let active = match self.mark_started(&jobs).await {
            Ok(active) => active,
            Err(e) => {
                self.release_forge(&jobs).await;
                return Err(e);
            }
        };
        let (go, stopped): (Vec<Job>, Vec<Job>) = jobs.into_iter().partition(|j| active.contains(&j.experiment));
        if !stopped.is_empty() {
            self.release_forge(&stopped).await;
        }
        let started = go.len();
        lock(&self.inner).tasks += started;
        for job in go {
            let me = Arc::clone(self);
            let (client, status) = (Arc::clone(&client), status.clone());
            tokio::spawn(async move { me.play_forge_one(client, status, job).await });
        }
        Ok(started)
    }

    async fn release_forge(&self, jobs: &[Job]) {
        {
            let mut inner = lock(&self.inner);
            inner.forge_busy = inner.forge_busy.saturating_sub(jobs.len());
        }
        self.release(jobs).await;
    }

    async fn play_forge_one(self: Arc<Self>, client: Arc<dyn ForgeClient>, status: forge::ForgeStatus, job: Job) {
        let result = match &job.decks {
            Err(why) => Some(forge::failed_result(&job.spec, Some(&status), &job.profile, why.clone())),
            Ok(decks) => match client.play(ForgePlay::new(&job.experiment, &job.spec, &job.profile, decks)).await {
                Ok(r) => Some(forge::checked_result(&job.spec, Some(&status), &job.profile, r)),
                Err(e) => {
                    // It stays unplayed and goes back in the queue; its attempts are counted, so
                    // one that never comes back is written off after FORGE_MAX_ATTEMPTS.
                    tracing::warn!(experiment = %job.experiment, game = %job.game, error = %e, "lab: a Forge game didn't come back; it goes back in the queue");
                    None
                }
            },
        };
        if let Some(result) = result
            && let Err(e) = store(&self.pool, &job.experiment, &job.game, &result).await
        {
            tracing::error!(experiment = %job.experiment, game = %job.game, error = %e, "storing a Forge lab result failed");
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        let last = {
            let mut inner = lock(&self.inner);
            inner.in_flight.remove(&(job.experiment.clone(), job.game.clone()));
            inner.forge_busy = inner.forge_busy.saturating_sub(1);
            !inner.in_flight.iter().any(|(e, _)| *e == job.experiment)
        };
        if last && let Err(e) = self.settle(&job.experiment).await {
            tracing::error!(experiment = %job.experiment, error = %e, "lab: settling an experiment failed");
        }
        lock(&self.inner).tasks -= 1;
        self.forge_wake.notify_one();
    }

    /// The Forge worker as the Lab and admin pages show it.
    pub fn forge_view(&self) -> ForgeView {
        let playing = lock(&self.inner).forge_busy;
        lock(&self.forge_live).view(self.forge.is_some(), playing)
    }

    /// The Forge worker, when this server has one.
    pub fn forge_client(&self) -> Option<Arc<dyn ForgeClient>> {
        self.forge.clone()
    }

    /// What the online Forge worker has said about card names so far (none while it is offline).
    pub fn forge_cards(&self) -> Option<Arc<ForgeCards>> {
        let live = lock(&self.forge_live);
        if live.online() { live.cards.clone() } else { None }
    }

    /// The online Forge worker's engine label ("forge 2.0.15").
    pub fn forge_engine(&self) -> Option<String> {
        let live = lock(&self.forge_live);
        if live.online() { live.status.as_ref().map(|s| s.engine.clone()) } else { None }
    }

    /// What creating a run needs to know about Forge.
    pub fn forge_access(&self) -> forge::ForgeAccess {
        forge::ForgeAccess { client: self.forge_client(), cards: self.forge_cards(), engine: self.forge_engine() }
    }

    /// Wake the Forge dispatcher (after an experiment with Forge games is created).
    pub fn wake_forge(&self) {
        self.forge_wake.notify_one();
    }

    /// Start games on free threads. Returns how many started (written-off games included).
    pub(crate) async fn tick(self: &Arc<Self>) -> AppResult<usize> {
        let Some(sim) = self.ready() else { return Ok(0) };
        let busy = {
            let inner = lock(&self.inner);
            inner.in_flight.len().saturating_sub(inner.forge_busy) + sim.stuck()
        };
        let free = self.threads.saturating_sub(busy);
        if free == 0 {
            return Ok(0);
        }
        self.replay_split_pods(&current_build(sim.as_ref())).await?;
        let jobs = self.next_jobs(free).await?;
        if jobs.is_empty() {
            return Ok(0);
        }
        // Claim the games before the write that starts them: a cancel written after that write
        // sees them as playing, and leaves its summary open until they're in.
        {
            let mut inner = lock(&self.inner);
            for job in &jobs {
                inner.in_flight.insert((job.experiment.clone(), job.game.clone()));
            }
        }
        let active = match self.mark_started(&jobs).await {
            Ok(active) => active,
            Err(e) => {
                // Nothing was written: the next pass tries again.
                self.release(&jobs).await;
                return Err(e);
            }
        };
        // Experiments cancelled, finished or deleted since the games were picked start nothing.
        let (go, stopped): (Vec<Job>, Vec<Job>) = jobs.into_iter().partition(|j| active.contains(&j.experiment));
        if !stopped.is_empty() {
            self.release(&stopped).await;
        }
        let started = go.len();
        lock(&self.inner).tasks += started;
        for job in go {
            let me = Arc::clone(self);
            let sim = Arc::clone(&sim);
            tokio::spawn(async move { me.play_one(sim, job).await });
        }
        Ok(started)
    }

    /// Mark the jobs' experiments running and count each game's start, in one transaction, before
    /// any game starts. Returns the experiments still queued or running; jobs of any other are
    /// not counted and must not start.
    pub(crate) async fn mark_started(&self, jobs: &[Job]) -> AppResult<HashSet<String>> {
        let stamp = now();
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let mut active = HashSet::new();
        for experiment in jobs.iter().map(|j| j.experiment.as_str()).collect::<HashSet<_>>() {
            let n = sqlx::query(
                "UPDATE lab_experiments SET status = 'running', started_at = IFNULL(started_at, ?),
                    updated_at = CASE WHEN status = 'queued' THEN ? ELSE updated_at END
                 WHERE id = ? AND status IN ('queued','running')",
            )
            .bind(&stamp)
            .bind(&stamp)
            .bind(experiment)
            .execute(&mut *tx)
            .await?
            .rows_affected();
            if n > 0 {
                active.insert(experiment.to_string());
            }
        }
        for job in jobs.iter().filter(|j| j.decks.is_ok() && active.contains(&j.experiment)) {
            sqlx::query("UPDATE lab_experiment_games SET attempts = attempts + 1 WHERE experiment_id = ? AND game = ? AND result IS NULL")
                .bind(&job.experiment)
                .bind(&job.game)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(active)
    }

    /// Pods half played on another build: the stored game is cleared, so both games of the pod
    /// replay on `build` and no pod is split across builds. A pod already split (stored by a
    /// server without this check) has its games from other builds cleared too. Each queued or
    /// running experiment is checked once per process: everything this process stores is on its
    /// own build.
    async fn replay_split_pods(&self, build: &Build) -> AppResult<()> {
        let active: HashSet<String> =
            sqlx::query_scalar("SELECT id FROM lab_experiments WHERE status IN ('queued','running')").fetch_all(&self.pool).await?.into_iter().collect();
        let todo: Vec<String> = {
            let mut inner = lock(&self.inner);
            inner.build_checked.retain(|id| active.contains(id));
            active.iter().filter(|id| !inner.build_checked.contains(*id)).cloned().collect()
        };
        for id in todo {
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
            let cleared = sqlx::query(SPLIT_PODS)
                .bind(&id)
                .bind(MAX_ATTEMPTS)
                .bind(&id)
                .bind(&build.engine)
                .bind(&build.card_data)
                .bind(&build.runner)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            if cleared > 0 {
                refresh(&mut tx, &id, false).await?;
            }
            tx.commit().await?;
            if cleared > 0 {
                tracing::warn!(
                    experiment = %id,
                    games = cleared,
                    engine = %build.engine,
                    card_data = %build.card_data,
                    runner = %build.runner,
                    "lab: games stored from another build cleared, so their pods replay on this one"
                );
            }
            lock(&self.inner).build_checked.insert(id);
        }
        Ok(())
    }

    async fn play_one(self: Arc<Self>, sim: Arc<dyn Simulator>, job: Job) {
        let earlier = if job.retried { sim.earlier_try(&job.game) } else { EarlierTry::Unknown };
        let result = match (earlier, job.decks) {
            (EarlierTry::Finished(r), _) => {
                tracing::info!(experiment = %job.experiment, game = %job.game, end = r.end.as_str(), "lab: a game written off as hung finished after all; its result is kept");
                r
            }
            (EarlierTry::Playing, _) => GameReport::failed(&job.spec, &sim.card_data(), End::Error, STILL_HUNG.into()).result,
            (EarlierTry::Unknown, Err(why)) => GameReport::failed(&job.spec, &sim.card_data(), End::Error, why).result,
            (EarlierTry::Unknown, Ok(decks)) => {
                let (spec, limits) = (job.spec.clone(), job.limits);
                let s = Arc::clone(&sim);
                tokio::task::spawn_blocking(move || s.play(&spec, &decks, &limits))
                    .await
                    .unwrap_or_else(|e| GameReport::failed(&job.spec, &sim.card_data(), End::Panic, format!("the game's runner stopped: {e}")).result)
            }
        };
        let deferred = !job.retried
            && result.cut_short_by_machine()
            && defer(&self.pool, &job.experiment, &job.game).await.unwrap_or_else(|e| {
                tracing::error!(experiment = %job.experiment, game = %job.game, error = %e, "lab: putting a game back in the queue failed; its result is stored");
                false
            });
        if deferred {
            tracing::info!(
                experiment = %job.experiment,
                game = %job.game,
                end = result.end.as_str(),
                turn = result.turns,
                actions = result.actions,
                "lab: the machine cut this game short; it plays once more after the run's other games"
            );
        } else if let Err(e) = store(&self.pool, &job.experiment, &job.game, &result).await {
            // The game stays unplayed in the database and is played again on a later pass.
            tracing::error!(experiment = %job.experiment, game = %job.game, error = %e, "storing a lab result failed");
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        let last = {
            let mut inner = lock(&self.inner);
            inner.in_flight.remove(&(job.experiment.clone(), job.game.clone()));
            !inner.in_flight.iter().any(|(e, _)| *e == job.experiment)
        };
        if last && let Err(e) = self.settle(&job.experiment).await {
            tracing::error!(experiment = %job.experiment, error = %e, "lab: settling an experiment failed");
        }
        lock(&self.inner).tasks -= 1;
        self.wake.notify_one();
    }

    /// The next phase games to play (see [`Self::next_jobs_for`]).
    pub(crate) async fn next_jobs(&self, free: usize) -> AppResult<Vec<Job>> {
        self.next_jobs_for("phase", free).await
    }

    /// The next games of `engine` ("phase" or "forge") to play, oldest experiment first, at most
    /// `free`, skipping games in flight. A disabled account's experiments wait until it is enabled
    /// again.
    pub(crate) async fn next_jobs_for(&self, engine: &str, free: usize) -> AppResult<Vec<Job>> {
        let max_attempts = if engine == "forge" { forge::FORGE_MAX_ATTEMPTS } else { MAX_ATTEMPTS };
        let experiments: Vec<(String, String, bool)> = sqlx::query_as(
            "SELECT e.id, e.owner_id, u.is_admin FROM lab_experiments e JOIN users u ON u.id = e.owner_id
             WHERE e.status IN ('queued','running') AND u.disabled_at IS NULL ORDER BY e.created_at, e.rowid",
        )
        .fetch_all(&self.pool)
        .await?;
        let in_flight = lock(&self.inner).in_flight.clone();
        let mut owners = HashSet::new();
        let mut eligible = HashSet::new();
        let mut jobs = Vec::new();
        for (id, owner, admin) in experiments {
            // One experiment at a time for anyone but an admin: their oldest unfinished one.
            if !admin && !owners.insert(owner) {
                continue;
            }
            eligible.insert(id.clone());
            if jobs.len() >= free {
                continue;
            }
            let busy = in_flight.iter().filter(|(e, _)| *e == id).count();
            // Games put back after the machine cut them short come after the rest.
            let rows: Vec<(String, String, i64, bool)> = sqlx::query_as(
                "SELECT game, spec, attempts, retried FROM lab_experiment_games WHERE experiment_id = ? AND engine = ? AND result IS NULL ORDER BY retried, ord LIMIT ?",
            )
            .bind(&id)
            .bind(engine)
            .bind((free - jobs.len() + busy) as i64)
            .fetch_all(&self.pool)
            .await?;
            let mut frozen: Option<Result<Arc<Frozen>, String>> = None;
            for (game, spec, attempts, retried) in rows {
                if jobs.len() >= free {
                    break;
                }
                if in_flight.contains(&(id.clone(), game.clone())) {
                    continue;
                }
                if frozen.is_none() {
                    frozen = Some(self.frozen_for(&id).await?);
                }
                let frozen = frozen.as_ref().expect("just loaded");
                let spec = match serde_json::from_str::<GameSpec>(&spec) {
                    Ok(spec) => spec,
                    Err(e) => {
                        // Store it as failed rather than retrying a line that can't be read.
                        let g = GameSpec { game: game.clone(), seed: 0, decks: vec![], difficulty: String::new(), max_turns: 0, max_actions: 0, max_seconds: 0, pilots: None };
                        let profile = frozen.as_ref().map_or_else(|_| forge::DEFAULT_PROFILE.to_string(), |f| f.profile.clone());
                        jobs.push(Job { experiment: id.clone(), game, spec: g, limits: LIMITS, decks: Err(format!("unreadable schedule line: {e}")), profile, retried });
                        continue;
                    }
                };
                let limits = frozen.as_ref().map_or(LIMITS, |f| f.limits);
                let profile = frozen.as_ref().map_or_else(|_| forge::DEFAULT_PROFILE.to_string(), |f| f.profile.clone());
                let decks = if attempts >= max_attempts && engine == "forge" {
                    Err(format!(
                        "written off: handed to the Forge worker {attempts} times without a result coming back (it restarted, or the network \
                         failed each time)"
                    ))
                } else if attempts >= max_attempts {
                    Err(format!(
                        "written off without playing it again: started {attempts} times and the server stopped each time before its result \
                         was stored. A crash inside a game (a stack overflow, say) ends the whole server, so a game isn't replayed after \
                         {MAX_ATTEMPTS} such stops"
                    ))
                } else {
                    match frozen {
                        Err(why) => Err(format!("{DECK_ERRORS} {why}")),
                        Ok(f) => spec.decks.iter().map(|d| f.lists.get(d).cloned().ok_or_else(|| format!("{DECK_ERRORS} {d}: not in the experiment"))).collect(),
                    }
                };
                jobs.push(Job { experiment: id.clone(), game, spec, limits, decks, profile, retried });
            }
        }
        // Forget the lists of experiments that are finished, cancelled or deleted.
        let mut inner = lock(&self.inner);
        let playing: HashSet<String> = inner.in_flight.iter().map(|(e, _)| e.clone()).collect();
        inner.frozen.retain(|id, _| eligible.contains(id) || playing.contains(id));
        Ok(jobs)
    }

    /// An experiment's frozen lists and limits, or why they can't be read.
    async fn frozen_for(&self, id: &str) -> AppResult<Result<Arc<Frozen>, String>> {
        if let Some(f) = lock(&self.inner).frozen.get(id) {
            return Ok(Ok(Arc::clone(f)));
        }
        let Some(text): Option<String> = sqlx::query_scalar("SELECT spec FROM lab_experiments WHERE id = ?").bind(id).fetch_optional(&self.pool).await? else {
            return Ok(Err("the experiment is gone".into()));
        };
        let spec: ExperimentSpec = match serde_json::from_str(&text) {
            Ok(s) => s,
            Err(e) => return Ok(Err(format!("unreadable experiment: {e}"))),
        };
        let mut lists = HashMap::new();
        let profile = spec.engines.profile().to_string();
        for list in std::iter::once(spec.base).chain(spec.variant).chain(spec.entrants).chain(spec.opponents.into_iter().map(|o| o.list)) {
            lists.insert(list.id.clone(), Arc::new(list));
        }
        let frozen = Arc::new(Frozen { lists, limits: spec.limits, profile });
        lock(&self.inner).frozen.insert(id.to_string(), Arc::clone(&frozen));
        Ok(Ok(frozen))
    }

    /// Hand Forge games out until none is left to start or playing (tests).
    #[cfg(test)]
    pub(crate) async fn drain_forge(self: &Arc<Self>) {
        loop {
            self.forge_tick().await.unwrap();
            let idle = {
                let inner = lock(&self.inner);
                inner.forge_busy == 0 && inner.tasks == 0
            };
            if idle && self.next_jobs_for("forge", 1).await.unwrap().is_empty() {
                return;
            }
            let _ = tokio::time::timeout(Duration::from_millis(50), self.forge_wake.notified()).await;
        }
    }

    /// Play until nothing is left to start or running (tests).
    #[cfg(test)]
    pub(crate) async fn drain(self: &Arc<Self>) {
        loop {
            self.tick().await.unwrap();
            let idle = {
                let inner = lock(&self.inner);
                inner.in_flight.is_empty() && inner.tasks == 0
            };
            if idle && self.next_jobs(1).await.unwrap().is_empty() {
                return;
            }
            let _ = tokio::time::timeout(Duration::from_millis(100), self.wake.notified()).await;
        }
    }
}

/// The error of a hung game's retry while its first thread is still busy.
const STILL_HUNG: &str = "hung: stuck inside one engine or AI step, and still stuck after the run's other games had played, so it wasn't played \
     again (a second try would only hang a second thread)";

/// Put a game the machine cut short back in the queue, once: it plays again after the experiment's
/// other games. Its attempts start again (the first try did end, so it isn't a crash). Only while
/// the experiment is queued or running, and only a game not put back before: false otherwise (then
/// store its result).
pub async fn defer(pool: &SqlitePool, experiment: &str, game: &str) -> AppResult<bool> {
    let n = sqlx::query(
        "UPDATE lab_experiment_games SET retried = 1, attempts = 0
         WHERE experiment_id = ? AND game = ? AND result IS NULL AND retried = 0
           AND EXISTS (SELECT 1 FROM lab_experiments e WHERE e.id = ? AND e.status IN ('queued','running'))",
    )
    .bind(experiment)
    .bind(game)
    .bind(experiment)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n > 0)
}

/// Store one game's result line, then the experiment's progress and summary, and finish the
/// experiment with its last game. One transaction; only a game with no result yet is written, so
/// a repeat is a no-op. Returns whether anything was written (false: stored before, or the
/// experiment was deleted).
pub async fn store(pool: &SqlitePool, experiment: &str, game: &str, result: &GameResult) -> AppResult<bool> {
    let mut tx = pool.begin().await?;
    let written = sqlx::query("UPDATE lab_experiment_games SET result = ?, end_kind = ?, finished_at = ? WHERE experiment_id = ? AND game = ? AND result IS NULL")
        .bind(result.to_line())
        .bind(result.end.as_str())
        .bind(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .bind(experiment)
        .bind(game)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if written == 0 {
        return Ok(false);
    }
    // A large tournament must not parse its whole history after every single result. Progress
    // remains exact; rank summaries refresh in batches, at either engine's finish, and on cancel.
    let progress: Option<(i64, i64, String)> = sqlx::query_as(
        "UPDATE lab_experiments SET games_done=games_done+1, updated_at=?
         WHERE id=? AND json_extract(spec, '$.mode')='tournament'
         RETURNING games_done, games_total, status",
    ).bind(now()).bind(experiment).fetch_optional(&mut *tx).await?;
    if let Some((done, total, status)) = progress
        && done < total && done % 25 != 0 && matches!(status.as_str(), "queued" | "running")
    {
        let engine_pending: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM lab_experiment_games WHERE experiment_id=? AND result IS NULL
             AND engine=(SELECT engine FROM lab_experiment_games WHERE experiment_id=? AND game=?))",
        ).bind(experiment).bind(experiment).bind(game).fetch_one(&mut *tx).await?;
        if engine_pending { tx.commit().await?; return Ok(true); }
    }
    // The game being stored is still claimed, so a cancelled experiment's summary stays open
    // here; the worker settles it once the claim is dropped.
    refresh(&mut tx, experiment, false).await?;
    tx.commit().await?;
    Ok(true)
}

/// Clears an experiment's stored phase games (bind 2, and again bind 3) that came from a build other
/// than the current one (engine, card data, runner: binds 4 to 6) and whose pod partner is
/// unplayed or from yet another build, while the experiment is queued or running. A cleared game
/// starts its attempts again, unless it was written off for them (bind 1). A result line that
/// isn't valid JSON is never read as JSON (CASE evaluates in order; WHERE terms needn't) and is
/// left alone: it is an unscored error from an unknown build. Forge games are never cleared: their
/// build is the Forge worker's, and a "both" experiment's Forge half is a separate summary.
const SPLIT_PODS: &str = "WITH b AS (
        SELECT ord, result IS NULL AS pending, result IS NOT NULL AND json_valid(result) AS readable,
               CASE WHEN json_valid(result) THEN json_extract(result, '$.engine') END AS engine,
               CASE WHEN json_valid(result) THEN json_extract(result, '$.card_data') END AS card_data,
               CASE WHEN json_valid(result) THEN json_extract(result, '$.runner') END AS runner
        FROM lab_experiment_games WHERE experiment_id = ? AND engine = 'phase'
    )
    UPDATE lab_experiment_games
    SET result = NULL, end_kind = NULL, finished_at = NULL, attempts = CASE WHEN attempts >= ? THEN attempts ELSE 0 END
    WHERE experiment_id = ? AND engine = 'phase'
      AND EXISTS (SELECT 1 FROM lab_experiments e WHERE e.id = lab_experiment_games.experiment_id AND e.status IN ('queued','running'))
      AND ord IN (
        SELECT x.ord FROM b x JOIN b p ON p.ord / 2 = x.ord / 2 AND p.ord != x.ord
        WHERE x.readable AND (x.engine IS NOT ? OR x.card_data IS NOT ? OR x.runner IS NOT ?)
          AND (p.pending OR (p.readable AND (p.engine IS NOT x.engine OR p.card_data IS NOT x.card_data OR p.runner IS NOT x.runner)))
      )";

/// Recount an experiment's games and rewrite its summary; a queued or running experiment whose
/// last game is in becomes done (or failed, when no game could be scored). `settled`: no game of
/// the experiment is claimed or playing, so a cancelled experiment's summary is final. A summary
/// is final only when no later game can change it.
pub async fn refresh(conn: &mut SqliteConnection, experiment: &str, settled: bool) -> AppResult<()> {
    let Some((total, status)): Option<(i64, String)> =
        sqlx::query_as("SELECT games_total, status FROM lab_experiments WHERE id = ?").bind(experiment).fetch_optional(&mut *conn).await?
    else {
        return Ok(());
    };
    let rows: Vec<(i64, String, Option<String>, String)> =
        sqlx::query_as("SELECT ord, spec, result, engine FROM lab_experiment_games WHERE experiment_id = ? ORDER BY ord")
            .bind(experiment)
            .fetch_all(&mut *conn)
            .await?;
    let done = rows.iter().filter(|r| r.2.is_some()).count() as i64;
    let complete = done >= total;
    let cancelled_settled = status == "cancelled" && settled;
    let (mode, pod, engines): (Option<String>, Option<i64>, Option<String>) =
        sqlx::query_as("SELECT json_extract(spec, '$.mode'), json_extract(spec, '$.pod'), json_extract(spec, '$.engines.mode') FROM lab_experiments WHERE id = ?")
            .bind(experiment)
            .fetch_one(&mut *conn)
            .await?;
    let pod = usize::try_from(pod.unwrap_or(4)).unwrap_or(4);
    let entrants: Vec<(String, String)> = if matches!(mode.as_deref(), Some("versus" | "tournament")) {
        sqlx::query_as(
            "SELECT json_extract(value, '$.id'), json_extract(value, '$.label') FROM lab_experiments, json_each(lab_experiments.spec, '$.entrants')
             WHERE lab_experiments.id = ? ORDER BY CAST(key AS INTEGER)",
        )
        .bind(experiment)
        .fetch_all(&mut *conn)
        .await?
    } else {
        vec![]
    };
    // One engine's games, summarized as the mode wants; final when none of them can still change.
    let summarize_part = |part: &[&(i64, String, Option<String>, String)]| -> Summary {
        let part_final = part.iter().all(|r| r.2.is_some()) || cancelled_settled;
        match mode.as_deref() {
            Some("versus" | "tournament") => {
                let games: Vec<(String, Option<String>)> = part.iter().map(|(_, spec, result, _)| (spec.clone(), result.clone())).collect();
                let mut summary = stats::summarize_versus(&games, &entrants, pod, part_final);
                if mode.as_deref() == Some("tournament") { summary.method = stats::TOURNAMENT_METHOD.into(); }
                summary
            }
            other => {
                let outcomes: Vec<Outcome> = part.iter().filter_map(|(ord, spec, result, _)| Outcome::from_row(*ord, spec, result.as_deref())).collect();
                let mut s = stats::summarize(&outcomes, part_final);
                if other == Some("solo") {
                    s.verdict = stats::solo_verdict(&s.base, pod, part_final);
                    s.method = stats::SOLO_METHOD.into();
                }
                s
            }
        }
    };
    let all: Vec<&(i64, String, Option<String>, String)> = rows.iter().collect();
    // A "both" experiment keeps its phase half in `summary` and its Forge half in `summary_forge`;
    // any other keeps its one engine's games in `summary`.
    let (summary, summary_forge) = if engines.as_deref() == Some("both") {
        let phase: Vec<_> = all.iter().copied().filter(|r| r.3 == "phase").collect();
        let forge: Vec<_> = all.iter().copied().filter(|r| r.3 == "forge").collect();
        (summarize_part(&phase), Some(summarize_part(&forge)))
    } else {
        (summarize_part(&all), None)
    };
    let scored = summary.scored_games() + summary_forge.as_ref().map_or(0, Summary::scored_games);
    let active = status == "queued" || status == "running";
    let (status, error) = if active && complete {
        if scored == 0 {
            let first = rows.iter().filter_map(|(_, _, r, _)| serde_json::from_str::<yama_play::lab::GameResult>(r.as_deref()?).ok()?.error).next();
            ("failed".to_string(), Some(format!("No game ended with a scored result{}", first.map(|e| format!(". First error: {e}")).unwrap_or_default())))
        } else {
            ("done".to_string(), None)
        }
    } else {
        (status, None)
    };
    let stamp = now();
    let forge_text = match &summary_forge {
        Some(s) => Some(serde_json::to_string(s).map_err(anyhow::Error::from)?),
        None => None,
    };
    sqlx::query(
        "UPDATE lab_experiments SET games_done = ?, summary = ?, summary_forge = ?, status = ?, error = IFNULL(?, error), updated_at = ?,
            finished_at = CASE WHEN ? AND finished_at IS NULL THEN ? ELSE finished_at END
         WHERE id = ?",
    )
    .bind(done)
    .bind(serde_json::to_string(&summary).map_err(anyhow::Error::from)?)
    .bind(forge_text)
    .bind(&status)
    .bind(error)
    .bind(&stamp)
    .bind(active && complete)
    .bind(&stamp)
    .bind(experiment)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit(state: &Arc<AtomicU8>, stuck: &Arc<AtomicUsize>) -> ThreadExit {
        ThreadExit { state: Arc::clone(state), stuck: Arc::clone(stuck), game: "g".into() }
    }

    #[test]
    fn a_written_off_thread_frees_its_place_when_it_ends() {
        let (state, stuck) = (Arc::new(AtomicU8::new(RUNNING)), Arc::new(AtomicUsize::new(0)));
        let thread = exit(&state, &stuck);
        assert!(write_off(&state, &stuck));
        assert_eq!(stuck.load(Ordering::SeqCst), 1, "a hung thread holds a place");
        drop(thread);
        assert_eq!(stuck.load(Ordering::SeqCst), 0);
        assert_eq!(state.load(Ordering::SeqCst), FINISHED);
    }

    #[test]
    fn a_game_that_finishes_first_is_never_counted_as_stuck() {
        let (state, stuck) = (Arc::new(AtomicU8::new(RUNNING)), Arc::new(AtomicUsize::new(0)));
        drop(exit(&state, &stuck));
        assert!(!write_off(&state, &stuck));
        assert_eq!(stuck.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn racing_ends_and_write_offs_always_balance() {
        for _ in 0..2_000 {
            let (state, stuck) = (Arc::new(AtomicU8::new(RUNNING)), Arc::new(AtomicUsize::new(0)));
            let thread = exit(&state, &stuck);
            let ender = std::thread::spawn(move || drop(thread));
            let (s, k) = (Arc::clone(&state), Arc::clone(&stuck));
            let watcher = std::thread::spawn(move || write_off(&s, &k));
            ender.join().unwrap();
            watcher.join().unwrap();
            assert_eq!(stuck.load(Ordering::SeqCst), 0);
        }
    }
}
