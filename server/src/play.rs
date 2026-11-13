//! Online games on the rules engine: lobby, one game thread per live match, per-seat views
//! over WebSocket, and the replay log saved after every change.
//!
//! The engine and its AI are CPU-heavy and recurse deeply, so each live match runs on its own
//! OS thread with a 32 MiB stack (as phase does) and talks to the async side over channels.
//!
//! Because every unfinished game can hold a thread and its match in memory, the games an account
//! hosts that haven't finished (lobbies and live games) are capped: [`OPEN_MAX_OPEN_GAMES`] for an
//! account with the standard allowance (`User::limited`: anyone who signed up with Google),
//! [`MAX_OPEN_GAMES`] for an invited one, one for a guest (`guests.rs`) and none for an admin;
//! standard accounts together hold at most [`OPEN_MAX_OPEN_GAMES_ALL`]. The refusal says the
//! limit. New games and join codes are rate-limited per account too (`limits.rs`).

use crate::auth::User;
use crate::guests::Player;
use crate::deck_checks::Estimated;
use crate::decks::{Board, DeckCard, load_version_cards};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, short_code};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use anyhow::Context as _;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, oneshot, watch};
mod board;
mod board_data;
mod results;

use yama_play::{Act, AttackAt, DeckLine, DeckSupport, Difficulty, Engine, Match, PassMode, PayMode, SeatDeck, Setup, Stops, View};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/play/status", get(status))
        .route("/api/play", get(list).post(create))
        .route("/api/play/join", post(join))
        .route("/api/play/{id}", get(detail).delete(remove))
        .route("/api/play/{id}/start", post(start))
        .route("/api/play/{id}/rematch", post(rematch))
        .route("/api/play/{id}/end", post(end_solo))
        .route("/api/play/{id}/result", post(record_result))
        .route("/api/play/{id}/ws", get(connect))
        .route("/api/play/{id}/board", get(board::connect))
        .route("/api/play/{id}/view", get(final_view))
        .route("/api/decks/{id}/online-support", get(online_support))
        .merge(board_data::router())
}

// ── engine and live games ──────────────────────────────────────────────────

enum EngineState {
    Disabled(String),
    Loading,
    Ready(Arc<Engine>),
    Failed(String),
}

#[path = "play_history.rs"]
mod history;

pub struct PlayHub {
    engine: Mutex<EngineState>,
    live: Mutex<HashMap<String, LiveGame>>,
    historical: Option<history::Config>,
    historical_v0119: Option<history::Config>,
    unavailable: Mutex<HashMap<String, String>>,
    setup_gate: Arc<tokio::sync::Semaphore>,
}

#[derive(Clone)]
struct LiveGame {
    cmds: std::sync::mpsc::Sender<Cmd>,
    views: watch::Receiver<Arc<Snapshot>>,
}

/// The latest views for every seat (and spectators, under `None`).
#[derive(Default)]
struct Snapshot {
    views: HashMap<Option<u8>, View>,
    historical_views: HashMap<Option<u8>, serde_json::Value>,
}

enum Cmd {
    GoBack {
        seat: u8,
        revision: u64,
        checkpoint: Option<u64>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    EndSolo {
        seat: u8,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Choose {
        seat: u8,
        revision: u64,
        index: usize,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Any legal set of attackers (the option list only holds the engine's sample).
    Attack {
        seat: u8,
        revision: u64,
        attacks: Vec<(u64, AttackAt)>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Any legal set of blocks, as (blocker, attacker) pairs.
    Block {
        seat: u8,
        revision: u64,
        blocks: Vec<(u64, u64)>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// A full answer to the seat's decision (cards picked, trigger order, X...; `yama_play::act`).
    Act {
        seat: u8,
        revision: u64,
        action: Act,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Concede {
        seat: u8,
    },
    /// The seat's saved settings (`play_prefs`): its stops and full control.
    Prefs {
        seat: u8,
        prefs: PlayPrefs,
    },
    /// Account defaults on connection; replay-restored game controls take precedence.
    AccountPrefs {
        seat: u8,
        prefs: PlayPrefs,
    },
    /// Older boards: full control alone, not saved.
    FullControl {
        seat: u8,
        on: bool,
    },
    /// Older boards: the seat's own stops alone, not saved.
    Stops {
        seat: u8,
        stops: Option<Stops>,
    },
    /// A way to pass (GPriority's menu), or `None` to stop one. Passes now if it's the seat's
    /// priority on the board it chose from.
    Passing {
        seat: u8,
        revision: u64,
        mode: Option<PassMode>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// "Hold priority" with your own spell on the stack (GButtons).
    Hold {
        seat: u8,
        on: bool,
    },
    /// The sources paying automatically would tap to cast `object` (GCast's "Will tap").
    Preview { seat: u8, object: u64, reply: oneshot::Sender<Result<Vec<u64>, String>>, },
    /// A move from phase's board (board.rs): an engine action or interaction answer.
    Board { seat: u8, mv: board::Move, reply: oneshot::Sender<Result<(), yama_play::board::Rejection>>, },
    /// The game thread captures the initial frame and subscribes to later updates atomically.
    BoardOpen { viewer: Option<u8>, reply: oneshot::Sender<Result<board::Opened, yama_play::board::Rejection>>, },
    /// One of a viewer's boards closed.
    BoardClosed { viewer: Option<u8>, },
    /// End the game thread now without saving (an account in it is being deleted).
    Stop,
}

pub(crate) const STACK: usize = 32 << 20;
const AI_BATCH: usize = 8;

impl PlayHub {
    /// Load the engine's card data in the background. Without it, online play is off.
    pub fn start(card_data: Option<std::path::PathBuf>, pool: SqlitePool) -> Arc<Self> {
        let hub = Arc::new(Self {
            engine: Mutex::new(EngineState::Loading),
            live: Mutex::new(HashMap::new()),
            historical: card_data.as_deref().map(history::Config::discover),
            historical_v0119: card_data.as_deref().map(history::Config::discover_v0119),
            setup_gate: Arc::new(tokio::sync::Semaphore::new(1)), unavailable: Mutex::new(HashMap::new()),
        });
        let Some(path) = card_data else {
            *hub.engine.lock().unwrap() =
                EngineState::Disabled("the engine's card data isn't installed (see docs/engine-integration.md)".into());
            return hub;
        };
        let h = hub.clone();
        let rt = tokio::runtime::Handle::current();
        std::thread::Builder::new()
            .name("engine-load".into())
            .stack_size(STACK)
            .spawn(move || {
                let started = std::time::Instant::now();
                match Engine::load_verified(&path, yama_play::CARD_DATA_SHA256) {
                    Ok(engine) => {
                        tracing::info!(cards = engine.card_count(), secs = started.elapsed().as_secs_f32(), "rules engine ready");
                        *h.engine.lock().unwrap() = EngineState::Ready(Arc::new(engine));
                    }
                    Err(e) => {
                        tracing::error!(error = %format!("{e:#}"), "rules engine failed to load");
                        *h.engine.lock().unwrap() = EngineState::Failed(format!("{e:#}"));
                    }
                }
                rt.block_on(h.resume_live(&pool));
            })
            .expect("engine loader thread");
        hub
    }

    pub(crate) fn engine(&self) -> AppResult<Arc<Engine>> {
        match &*self.engine.lock().unwrap() {
            EngineState::Ready(e) => Ok(e.clone()),
            EngineState::Loading => Err(AppError::Conflict("the rules engine is still starting; try again in a moment".into())),
            EngineState::Disabled(why) | EngineState::Failed(why) => Err(AppError::BadRequest(format!("online play is off: {why}"))),
        }
    }

    /// The loaded engine for the simulation lab, which shares this copy rather than loading a
    /// second. `Err(None)` while it is still loading; `Err(Some(why))` when it isn't available.
    pub fn engine_for_lab(&self) -> Result<Arc<Engine>, Option<String>> {
        match &*self.engine.lock().unwrap() {
            EngineState::Ready(e) => Ok(e.clone()),
            EngineState::Loading => Err(None),
            EngineState::Disabled(why) | EngineState::Failed(why) => Err(Some(why.clone())),
        }
    }

    /// Restart every game that was live when the server stopped, by replaying its log.
    async fn resume_live(self: &Arc<Self>, pool: &SqlitePool) {
        let mut rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT o.game_id, o.seats, o.replay, o.log, o.answers, g.engine_version FROM online_games o LEFT JOIN games g ON g.id=o.game_id WHERE o.stage = 'live'")
                .fetch_all(pool).await.unwrap_or_default();
        // Current games recover before any historical subprocess is contacted. A failed
        // historical startup is deadline-bound and cached for the remaining historical rows.
        rows.sort_by_key(|row| row.5.as_deref() != Some(yama_play::ENGINE_VERSION));
        for (game_id, seats, replay, log, answers, identity) in rows {
            // A game on an engine version this server can never run moves to the current engine
            // if it replays the same, and is closed if it doesn't: none is left that nobody can
            // play or finish (Bryan, 12 Nov 2026). Without a current engine it waits for one.
            if is_retired_runtime(identity.as_deref())
                && let Ok(engine) = self.engine()
            {
                self.upgrade_or_close(pool, &engine, game_id, identity, seats, replay, log, answers).await;
                continue;
            }
            // No replay or remembered-action parsing before the saved identity is routed.
            if let Some(error) = self.runtime_error(identity.as_deref()) {
                self.unavailable.lock().unwrap().insert(game_id, error);
                continue;
            }
            let (Ok(seats), Some(replay)) = (serde_json::from_str::<Vec<SeatCfg>>(&seats), replay) else { continue };
            if let Some(config) = self.historical_for(identity.as_deref()) {
                let resumed = loop {
                    let attempt = (|| -> anyhow::Result<_> {
                        let mut worker = history::Worker::start(config)?;
                        let saved = worker.open(config, replay.clone(), log.clone(), answers.clone(), &seats)?;
                        Ok((worker, saved))
                    })();
                    if attempt.as_ref().is_err_and(|e| e.is::<history::Busy>()) {
                        // Overload owns no replay execution and must not permanently strand
                        // recovery. Current games have already recovered before this pass.
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                        continue;
                    }
                    break attempt;
                };
                match resumed {
                    Ok((worker, saved)) => {
                        let prefs = seat_prefs(pool, &seats).await;
                        self.spawn_historical(game_id, worker, saved, prefs, pool.clone());
                    }
                    Err(e) => {
                        tracing::error!(game_id,error=%e,"historical recovery unavailable");
                        self.unavailable.lock().unwrap().insert(
                            game_id,
                            "The historical runtime could not recover this game. Its original records are preserved.".into(),
                        );
                    }
                }
                continue;
            }
            let Ok(engine) = self.engine() else { continue };
            let prefs = seat_prefs(pool, &seats).await;
            match engine.resume(&replay, &ai_seats(&seats)) {
                Ok(mut m) => {
                    if let Some(lines) = log.and_then(|l| serde_json::from_str(&l).ok()) {
                        m.set_log_lines(lines);
                    }
                    // The answers Yama remembers for people (yama_play's remember.rs).
                    if let Some(answers) = answers.and_then(|a| serde_json::from_str(&a).ok()) {
                        m.set_remembered(answers);
                    }
                    self.spawn_game(game_id.clone(), m, seats, prefs, pool.clone());
                    tracing::info!(game_id, "resumed online game");
                }
                Err(e) => {
                    tracing::error!(game_id, error = %format!("{e:#}"), "couldn't resume online game");
                    self.unavailable.lock().unwrap().insert(
                        game_id,
                        "This game could not be recovered with its matching runtime. Its original records are preserved.".into(),
                    );
                }
            }
        }
    }

    fn historical_for(&self, identity: Option<&str>) -> Option<&history::Config> {
        match identity {
            Some(history::IDENTITY) => self.historical.as_ref(),
            Some(history::V0119_IDENTITY) => self.historical_v0119.as_ref(),
            _ => None,
        }
    }

    /// Exact identities only. An unknown/absent identity never means "use current".
    /// Move a live game saved on a retired engine version to the current engine, if replaying it
    /// here checks out ([`Engine::resume_checked`]), and run it; otherwise close it without a
    /// winner. Either way its original record is kept (`online_game_originals`).
    #[allow(clippy::too_many_arguments)]
    async fn upgrade_or_close(
        self: &Arc<Self>,
        pool: &SqlitePool,
        engine: &Engine,
        game_id: String,
        identity: Option<String>,
        seats: String,
        replay: Option<String>,
        log: Option<String>,
        answers: Option<String>,
    ) {
        let lines: Option<Vec<yama_play::LogLine>> = log.as_deref().and_then(|l| serde_json::from_str(l).ok());
        let checked = (|| -> anyhow::Result<(Vec<SeatCfg>, Match)> {
            // Without the saved log there's nothing to check the replay against.
            let lines = lines.as_deref().context("no readable saved log")?;
            let seats: Vec<SeatCfg> = serde_json::from_str(&seats).context("reading the seats")?;
            let replay = replay.as_deref().context("no saved replay")?;
            let mut m = engine.resume_checked(replay, &ai_seats(&seats), lines)?;
            if let Some(answers) = answers.as_deref().and_then(|a| serde_json::from_str(a).ok()) {
                m.set_remembered(answers);
            }
            anyhow::ensure!(!m.is_over(), "the replay ends the game");
            Ok((seats, m))
        })();
        let old = identity.as_deref();
        match checked {
            Ok((seats, mut m)) => {
                m.note(format!("{}, picking up where it was.", yama_play::MOVED_NOTE));
                if let Err(e) = adopt_current_engine(pool, &game_id, old, &m).await {
                    tracing::error!(game_id, error = %format!("{e:#}"), "couldn't move an online game to the current engine");
                    self.unavailable.lock().unwrap().insert(game_id, "This game couldn't be moved to the current rules engine.".into());
                    return;
                }
                let prefs = seat_prefs(pool, &seats).await;
                tracing::info!(game_id, from = old.unwrap_or("unrecorded"), "moved online game to the current engine");
                self.spawn_game(game_id, m, seats, prefs, pool.clone());
            }
            Err(why) => {
                tracing::warn!(game_id, from = old.unwrap_or("unrecorded"), error = %format!("{why:#}"), "closing an online game the current engine can't continue");
                if let Err(e) = close_unrunnable(pool, &game_id, lines.unwrap_or_default()).await {
                    tracing::error!(game_id, error = %format!("{e:#}"), "couldn't close an online game");
                }
            }
        }
    }

    /// Exact identities only. An unknown/absent identity never means "use current".
    fn runtime_error(&self, identity: Option<&str>) -> Option<String> {
        match identity {
            Some(yama_play::ENGINE_VERSION) => self.engine().err().map(|e|e.to_string()),
            Some(history::IDENTITY | history::V0119_IDENTITY) if self.historical_for(identity).is_some_and(|c| c.available()) => None,
            Some(history::IDENTITY | history::V0119_IDENTITY) => Some("This game requires its preserved runtime and card data, which are not installed. Its records are unchanged.".into()),
            _ => Some("This game's saved runtime identity is unknown or unavailable. Its records are unchanged; a verified matching runtime is required.".into()),
        }
    }

    fn game_error(&self, r: &Row) -> Option<String> {
        if r.stage == "lobby" {
            return None;
        }
        if r.stage == "over" && is_retired_runtime(r.engine_version.as_deref()) {
            return Some("This game was played on an older version of Yama's rules engine, so its final board can't be shown. Its record is kept.".into());
        }
        self.unavailable.lock().unwrap().get(&r.game_id).cloned().or_else(|| self.runtime_error(r.engine_version.as_deref()))
    }

    /// A live game that can never run on this server: saved on a runtime identity that is neither
    /// the current engine nor either preserved historical runtime (identities are exact, so an unknown
    /// one never becomes runnable), with no thread. Its host may delete it, and it holds no place
    /// among the games anyone may have open. A game that is only waiting for its engine (loading,
    /// failed, or the historical runtime not installed or retrying) is not stranded.
    fn stranded(&self, r: &Row) -> bool {
        r.stage == "live" && is_retired_runtime(r.engine_version.as_deref()) && self.live(&r.game_id).is_none()
    }

    /// Run a live game on its own thread. `prefs` are the seated people's saved turn controls.
    fn spawn_game(self: &Arc<Self>, game_id: String, m: Match, seats: Vec<SeatCfg>, prefs: HashMap<u8, PlayPrefs>, pool: SqlitePool) {
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        let (view_tx, view_rx) = watch::channel(Arc::new(Snapshot::default()));
        let (board_tx, _) = broadcast::channel(16);
        self.live.lock().unwrap().insert(game_id.clone(), LiveGame { cmds: cmd_tx, views: view_rx });
        let hub = self.clone();
        let rt = tokio::runtime::Handle::current();
        std::thread::Builder::new()
            // An id shorter than eight bytes (only tests make them) names the thread whole.
            .name(format!("game-{}", game_id.get(..8).unwrap_or(&game_id)))
            .stack_size(STACK)
            .spawn(move || {
                run_game(&game_id, m, &seats, &prefs, cmd_rx, view_tx, board_tx, &pool, &rt);
                hub.live.lock().unwrap().remove(&game_id);
            })
            .expect("game thread");
    }

    fn live(&self, game_id: &str) -> Option<LiveGame> {
        self.live.lock().unwrap().get(game_id).cloned()
    }

    /// End a live game's thread without saving and forget it (admins deleting an account in it).
    pub(crate) fn stop(&self, game_id: &str) {
        if let Some(g) = self.live.lock().unwrap().remove(game_id) {
            let _ = g.cmds.send(Cmd::Stop);
        }
    }

    /// Live online games on this server now.
    pub(crate) fn live_count(&self) -> usize {
        self.live.lock().unwrap().len()
    }

    /// The engine's state for the admin area: the card count once loaded, or why it isn't.
    pub(crate) fn engine_status(&self) -> (&'static str, Option<usize>, Option<String>) {
        match &*self.engine.lock().unwrap() {
            EngineState::Ready(e) => ("ready", Some(e.card_count()), None),
            EngineState::Loading => ("loading", None, None),
            EngineState::Disabled(why) => ("off", None, Some(why.clone())),
            EngineState::Failed(why) => ("failed", None, Some(why.clone())),
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_game(
    game_id: &str,
    mut m: Match,
    seats: &[SeatCfg],
    prefs: &HashMap<u8, PlayPrefs>,
    cmds: std::sync::mpsc::Receiver<Cmd>,
    views: watch::Sender<Arc<Snapshot>>,
    board_updates: broadcast::Sender<Arc<board::Updates>>,
    pool: &SqlitePool,
    rt: &tokio::runtime::Handle,
) {
    // Viewers with phase's board open, and how many boards each (board.rs).
    let boards: std::cell::RefCell<HashMap<Option<u8>, usize>> = Default::default();
    let publish = |m: &mut Match| {
        // Phase's animations and logs need every publication, including a command's
        // update followed immediately by the end-of-loop update. A watch channel
        // intentionally coalesces these, so only the original board uses it.
        let tail = m.take_board_tail();
        let updates = boards.borrow().keys().map(|viewer| (*viewer, board::frames(game_id, m, *viewer, &tail))).collect();
        let _ = board_updates.send(Arc::new(updates));
        let _ = views.send(Arc::new(snapshot(m, seats)));
    };
    // Knockouts go to the game record when one happens or a rewind takes one back, and once more
    // when the game ends; the saves in between leave the seats alone.
    let recorded_outs = std::cell::Cell::new(None);
    let save = |m: &Match| {
        let outs = m.outs().len();
        match rt.block_on(persist(pool, game_id, m, recorded_outs.get() != Some(outs))) {
            Ok(()) => recorded_outs.set(Some(outs)),
            Err(e) => tracing::error!(game_id, error = %e, "saving online game failed"),
        }
    };
    let humans: Vec<u8> = seats.iter().filter(|s| s.kind == "human").map(|s| s.seat).collect();
    let queued = std::cell::RefCell::new(std::collections::VecDeque::new());
    let finish_solo = |m: &mut Match, seat: u8, reply: oneshot::Sender<Result<(), String>>| {
        if humans.as_slice() != [seat] {
            let _ = reply.send(Err("Only the sole human can end a solo game.".into()));
            return false;
        }
        let before = m.clone();
        m.abandon();
        match rt.block_on(persist(pool, game_id, m, true)) {
            Ok(()) => { publish(m); let _ = reply.send(Ok(())); true }
            Err(e) => { *m = before; let _ = reply.send(Err(format!("Could not save the ended game: {e}"))); false }
        }
    };
    let restore = |m: &mut Match, seat, revision, checkpoint, reply: oneshot::Sender<Result<(), String>>| {
        let before = m.clone();
        let result = m.go_back_to(seat, revision, checkpoint).map_err(|e| e.to_string());
        let result = match result {
            Ok(()) => match rt.block_on(persist(pool, game_id, m, true)) {
                Ok(()) => { recorded_outs.set(Some(m.outs().len())); Ok(()) }
                Err(e) => { *m = before; Err(format!("Could not save the restored game: {e}")) }
            },
            err => err,
        };
        let restored = result.is_ok();
        if restored { publish(m); }
        let _ = reply.send(result);
        restored
    };
    // Admit solo termination and rewind between batches, including after the human is out.
    // Other commands retain their FIFO order until the next human decision.
    let ai_turns = |m: &mut Match| loop {
        for _ in 0..32 {
            let Ok(cmd) = cmds.try_recv() else { break };
            match cmd {
                Cmd::EndSolo { seat, reply } => if finish_solo(m, seat, reply) { return },
                Cmd::GoBack { seat, revision, checkpoint, reply } => if restore(m, seat, revision, checkpoint, reply) { return },
                other => queued.borrow_mut().push_back(other),
            }
        }
        if m.is_over() { return; }
        let batch = ai_batch(m, &humans);
        if batch.moved > 0 { publish(m); save(m); }
        if let Some(e) = batch.fault {
            tracing::error!(game_id, error = %format!("{e:#}"), "AI driver fault; game paused");
            break;
        }
        if batch.settled { break; }
    };

    m.set_names(seats.iter().map(|s| s.name.clone()).collect());
    // Restore game-local controls before the first priority; account settings
    // are defaults only where the saved game has no value.
    for (seat, p) in prefs {
        if humans.contains(seat) {
            m.initialize_prefs(*seat, p.stops.clone(), p.full_control, p.tap_mana);
        }
    }
    publish(&mut m);
    ai_turns(&mut m);
    publish(&mut m);
    while !m.is_over() {
        let cmd = if let Some(cmd) = queued.borrow_mut().pop_front() { cmd } else { let Ok(cmd) = cmds.recv() else { return }; cmd };
        // A person's move: any refusal goes back to them and leaves the game as it was.
        let moved = |m: &mut Match, result: Result<(), yama_play::ChoiceError>, reply: oneshot::Sender<Result<(), String>>| {
            let ok = result.is_ok();
            let _ = reply.send(result.map_err(|e| e.to_string()));
            if ok {
                // Pass for people with nothing to do first, so the board sent out doesn't
                // flash a stop that would be passed a moment later.
                m.auto_pass(&humans);
                publish(m);
                save(m);
                ai_turns(m);
            }
        };
        match cmd {
            Cmd::GoBack {
                seat,
                revision,
                checkpoint,
                reply,
            } => {
                restore(&mut m, seat, revision, checkpoint, reply);
                // The restored decision stays put, without automatic passing or AI work.
                continue;
            }
            Cmd::EndSolo { seat, reply } => {
                if finish_solo(&mut m, seat, reply) { return; }
            }
            Cmd::Choose { seat, revision, index, reply, } => {
                let result = m.choose(seat, revision, index);
                moved(&mut m, result, reply);
            }
            Cmd::Attack { seat, revision, attacks, reply, } => {
                let result = m.declare_attackers(seat, revision, &attacks);
                moved(&mut m, result, reply);
            }
            Cmd::Block { seat, revision, blocks, reply, } => {
                let result = m.declare_blockers(seat, revision, &blocks);
                moved(&mut m, result, reply);
            }
            Cmd::Act { seat, revision, action, reply, } => {
                let result = m.act(seat, revision, &action);
                moved(&mut m, result, reply);
            }
            Cmd::Concede { seat } => {
                if m.concede(seat).is_ok() {
                    publish(&mut m);
                    save(&m);
                    ai_turns(&mut m);
                }
            }
            // New stops apply from the next priority; the decision on screen stays put. Turning
            // full control off may pass the window on screen now.
            Cmd::Prefs { seat, prefs } => {
                let was = m.controls(seat).full_control;
                m.set_prefs(seat, prefs.stops, prefs.full_control);
                m.set_tap_mana(seat, prefs.tap_mana);
                if was && !prefs.full_control {
                    ai_turns(&mut m);
                }
                save(&m);
            }
            Cmd::AccountPrefs { seat, prefs } => {
                let was = m.controls(seat).full_control;
                m.initialize_prefs(seat, prefs.stops, prefs.full_control, prefs.tap_mana);
                if was && !m.controls(seat).full_control {
                    ai_turns(&mut m);
                }
                save(&m);
            }
            Cmd::FullControl { seat, on } => {
                m.set_full_control(seat, on);
                if !on {
                    ai_turns(&mut m);
                }
                save(&m);
            }
            Cmd::Stops { seat, stops } => m.set_stops(seat, stops),
            Cmd::Passing { seat, revision, mode, reply, } => {
                let result = m.set_passing(seat, mode, revision);
                let ok = result.is_ok();
                let _ = reply.send(result.map_err(|e| e.to_string()));
                if ok && mode.is_some() {
                    m.auto_pass(&humans);
                    publish(&mut m);
                    save(&m);
                    ai_turns(&mut m);
                }
            }
            Cmd::Hold { seat, on } => {
                m.set_hold(seat, on);
                save(&m);
            }
            // Only reads the game: nothing to publish or save.
            Cmd::Preview { seat, object, reply, } => {
                let _ = reply.send(Ok(m.auto_tap_preview(seat, object)));
                continue;
            }
            Cmd::Board { seat, mv, reply } => {
                let result = board::apply(&mut m, seat, mv);
                if let Ok(Some(preference)) = &result
                    && let Some(user) = seats.iter().find(|s| s.seat == seat && s.kind == "human").and_then(|s| s.user_id.as_deref())
                    && let Err(e) = rt.block_on(preference.save(pool, user))
                {
                    // The engine already accepted the action. Keep its game-local
                    // effect rather than presenting it as a refused move to retry.
                    tracing::error!(game_id, seat, error = %e, "saving play settings failed");
                }
                let ok = result.is_ok();
                let _ = reply.send(result.map(|_| ()));
                if ok {
                    m.auto_pass(&humans);
                    publish(&mut m);
                    save(&m);
                    ai_turns(&mut m);
                }
            }
            Cmd::BoardOpen { viewer, reply } => {
                let first = match board::started(game_id, &mut m, viewer) {
                    Ok(first) => first,
                    Err(rejection) => {
                        let _ = reply.send(Err(rejection));
                        continue;
                    }
                };
                *boards.borrow_mut().entry(viewer).or_default() += 1;
                let opened = board::Opened { first, updates: board_updates.subscribe(), };
                if reply.send(Ok(opened)).is_err() {
                    let mut b = boards.borrow_mut();
                    if let Some(n) = b.get_mut(&viewer) {
                        *n -= 1;
                        if *n == 0 { b.remove(&viewer); }
                    }
                }
                continue;
            }
            Cmd::BoardClosed { viewer } => {
                let mut b = boards.borrow_mut();
                if let Some(n) = b.get_mut(&viewer) {
                    *n -= 1;
                    if *n == 0 {
                        b.remove(&viewer);
                    }
                }
                continue;
            }
            Cmd::Stop => return,
        }
        publish(&mut m);
    }
    save(&m);
}

/// What one batch of the computer's moves did ([`ai_batch`]).
struct Batch {
    /// Actions taken: the AI seats' moves and the passes made for people.
    moved: usize,
    /// A person has a real decision (or the game is over): nothing more happens until they answer.
    settled: bool,
    /// The AI stopped on a fault (it found no move, the engine refused one, or a turn never ends).
    fault: Option<anyhow::Error>,
}

/// AI seats act, and Yama passes for people where their turn controls say to, until a person has
/// a real decision or about AI_BATCH actions have gone by, whichever is first; the game thread
/// then shows the board and saves. Since every pass is its own engine action in games with loop
/// detection (`Match::plain_passes`), the computer and a pass made for a person hand over often;
/// showing the board at every hand-over cost a set of views and a save each time, which held up a
/// person's next decision behind the AI's turns (docs/play-performance.md).
fn ai_batch(m: &mut Match, humans: &[u8]) -> Batch {
    let mut moved = 0;
    loop {
        let passed = m.auto_pass(humans);
        moved += passed;
        let acted = match m.run_ai(AI_BATCH.saturating_sub(moved).max(1)) {
            Ok(n) => n,
            Err(fault) => return Batch { moved, settled: true, fault: Some(fault) },
        };
        moved += acted;
        let settled = passed + acted == 0 || m.is_over();
        if settled || moved >= AI_BATCH {
            // Pass for people (and give the answers Yama remembers for them) before the board goes
            // out, so it doesn't flash a decision answered a moment later.
            moved += m.auto_pass(humans);
            return Batch { moved, settled, fault: None };
        }
    }
}

/// The latest original-board view for a spectator and each person.
fn snapshot(m: &Match, seats: &[SeatCfg]) -> Snapshot {
    let mut snap = Snapshot::default();
    snap.views.insert(None, m.view(None));
    for s in seats {
        if s.kind == "human" {
            snap.views.insert(Some(s.seat), m.view(Some(s.seat)));
        }
    }
    snap
}

/// Store the game's knockouts on its seats, in the caller's transaction.
async fn write_knockouts(tx: &mut sqlx::SqliteConnection, game_id: &str, found: &[results::Knockout]) -> anyhow::Result<()> {
    // A rewind can take a knockout back: seats still in the game have none.
    sqlx::query(
        "UPDATE game_seats SET eliminated_turn = NULL, eliminated_by_seat = NULL
         WHERE game_id = ? AND eliminated_turn IS NOT NULL AND seat NOT IN (SELECT value FROM json_each(?))",
    )
    .bind(game_id)
    .bind(serde_json::to_string(&found.iter().map(|k| k.seat).collect::<Vec<_>>())?)
    .execute(&mut *tx)
    .await?;
    for k in found {
        // Read from the moment it happened while the feed holds it; a name stored for this same
        // knockout stays if the hit behind it has since left the feed. Once the feed has let the
        // knockout go, what was stored when it happened stands.
        let sql = if k.seen {
            "UPDATE game_seats SET eliminated_by_seat = COALESCE(?1, CASE WHEN eliminated_turn = ?2 THEN eliminated_by_seat END), eliminated_turn = ?2
             WHERE game_id = ?3 AND seat = ?4"
        } else {
            "UPDATE game_seats SET eliminated_by_seat = COALESCE(eliminated_by_seat, ?1), eliminated_turn = COALESCE(eliminated_turn, ?2)
             WHERE game_id = ?3 AND seat = ?4"
        };
        sqlx::query(sql).bind(k.by.map(i64::from)).bind(i64::from(k.turn)).bind(game_id).bind(i64::from(k.seat)).execute(&mut *tx).await?;
    }
    Ok(())
}

/// Save the game as it stands. `knockouts` also writes each seat's knockout to the game record
/// (always done once the game is over): the caller asks for it when the knockouts have changed.
/// Keep a game's record as it was before Yama changes it for the first time, whatever engine it
/// was saved on (`online_game_originals`; an unrecorded identity is kept as "unrecorded").
async fn keep_original(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, game_id: &str) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO online_game_originals(game_id, engine_version, replay, log, answers, revision, stage, saved_at)
         SELECT o.game_id, IFNULL(g.engine_version, 'unrecorded'), o.replay, o.log, o.answers, o.revision, o.stage, ?
         FROM online_games o JOIN games g ON g.id = o.game_id WHERE o.game_id = ?",
    )
    .bind(now())
    .bind(game_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Record that a game checked out on the current engine ([`PlayHub::upgrade_or_close`]) now runs
/// on it, then save it as the current engine writes it.
async fn adopt_current_engine(pool: &SqlitePool, game_id: &str, old: Option<&str>, m: &Match) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    keep_original(&mut tx, game_id).await?;
    let changed = sqlx::query("UPDATE games SET engine_version = ? WHERE id = ? AND engine_version IS ?")
        .bind(yama_play::ENGINE_VERSION)
        .bind(game_id)
        .bind(old)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    anyhow::ensure!(changed == 1, "the game's saved engine changed meanwhile");
    // The new identity and the game as the current engine saves it commit together: a failure
    // leaves the game on its old engine, to be tried again at the next start.
    persist_in(&mut tx, game_id, m, false).await?;
    tx.commit().await?;
    Ok(())
}

/// Close a live game no engine here can continue: it ends without a winner, as an ended solo
/// game does, and says why in its log.
async fn close_unrunnable(pool: &SqlitePool, game_id: &str, mut lines: Vec<yama_play::LogLine>) -> anyhow::Result<()> {
    let turn = lines.last().map(|l| l.turn).unwrap_or(0);
    lines.push(yama_play::LogLine::public(turn, CLOSED_NOTE.into()));
    let mut tx = pool.begin().await?;
    keep_original(&mut tx, game_id).await?;
    let at = now();
    let closed = sqlx::query("UPDATE online_games SET stage = 'over', log = ?, updated_at = ? WHERE game_id = ? AND stage = 'live'")
        .bind(serde_json::to_string(&lines)?)
        .bind(&at)
        .bind(game_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if closed == 1 {
        sqlx::query("UPDATE games SET status = 'abandoned', winner_seat = NULL, ended_at = ? WHERE id = ?").bind(&at).bind(game_id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// The last line of a game closed because the current engine couldn't continue it.
const CLOSED_NOTE: &str = "This game was closed without a winner: it was saved on an older version of Yama's rules engine, and couldn't be continued on this one.";

async fn persist(pool: &SqlitePool, game_id: &str, m: &Match, knockouts: bool) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    persist_in(&mut tx, game_id, m, knockouts).await?;
    tx.commit().await?;
    Ok(())
}

/// [`persist`] inside a transaction the caller commits.
async fn persist_in(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, game_id: &str, m: &Match, knockouts: bool) -> anyhow::Result<()> {
    let stage = if m.is_over() { "over" } else { "live" };
    history::archive_original(tx, game_id, yama_play::ENGINE_VERSION).await?;
    let changed=sqlx::query("UPDATE online_games SET replay = ?, log = ?, answers = ?, revision = ?, stage = ?, updated_at = ? WHERE game_id = ? AND EXISTS (SELECT 1 FROM games WHERE id=? AND engine_version=?)")
        .bind(m.replay_json())
        .bind(serde_json::to_string(m.log_lines())?)
        .bind((!m.remembered().is_empty()).then(|| serde_json::to_string(m.remembered())).transpose()?)
        .bind(m.revision as i64).bind(stage).bind(now()).bind(game_id).bind(game_id).bind(yama_play::ENGINE_VERSION)
        .execute(&mut **tx).await?.rows_affected();
    anyhow::ensure!(changed == 1, "saved game identity changed; refusing current-runtime write");
    // The spectator's feed says who dealt a knockout's damage; nobody is out in most saves.
    let events = if (knockouts || m.is_over()) && !m.outs().is_empty() { m.events(None) } else { vec![] };
    if knockouts || m.is_over() {
        write_knockouts(tx, game_id, &results::knockouts(m.outs(), &events)).await?;
    }
    if m.is_over() {
        let view = m.view(None);
        let winner = if m.abandoned() { None } else { m.winner() };
        sqlx::query("UPDATE games SET status = ?, winner_seat = ?, turns = ?, ended_at = ?, first_seat = ?, win_condition = ? WHERE id = ?")
            .bind(if m.abandoned() { "abandoned" } else { "finished" })
            .bind(winner.map(i64::from))
            .bind(i64::from(m.turn()))
            .bind(now())
            .bind(i64::from(m.starting_seat()))
            .bind(results::win_condition(m.outs(), &events, winner))
            .bind(game_id)
            .execute(&mut **tx)
            .await?;
        for p in &view.players {
            sqlx::query("UPDATE game_seats SET final_life = ? WHERE game_id = ? AND seat = ?")
                .bind(i64::from(p.life))
                .bind(game_id)
                .bind(i64::from(p.seat))
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(())
}

// ── lobby ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SeatCfg {
    pub(crate) seat: u8,
    /// "human" or "ai"
    pub(crate) kind: String,
    pub(crate) user_id: Option<String>,
    pub(crate) name: String,
    pub(crate) deck_id: Option<String>,
    pub(crate) deck_version_id: Option<String>,
    pub(crate) deck_name: Option<String>,
    pub(crate) color_identity: String,
    pub(crate) commander: Option<String>,
    pub(crate) difficulty: Option<String>,
    /// The deck's declared bracket when it took the seat. Older lobbies lack it.
    #[serde(default)]
    pub(crate) bracket: Option<i64>,
}

/// The stock precon a computer's seat plays (`deck_id` "precon:<id>", as Watch seats them),
/// if it plays one rather than one of the host's decks.
fn precon_of(s: &SeatCfg) -> Option<&str> {
    // A person's seat plays a precon only once someone sits in it (the host, or a guest player).
    s.deck_id.as_deref().filter(|_| s.kind == "ai" || s.user_id.is_some())?.strip_prefix("precon:")
}

/// The seat has a player and a deck: a saved deck version, or a precon (the computer's, or a
/// player's own seat playing one).
fn seated(s: &SeatCfg) -> bool {
    s.deck_version_id.is_some() || precon_of(s).is_some()
}

/// A stock precon in a computer's seat. Its list is read from the precon catalog when the game
/// starts; no deck version is involved, so the game is on no deck's record.
async fn precon_seat(pool: &SqlitePool, seat: u8, id: &str, difficulty: Option<&str>) -> AppResult<SeatCfg> {
    let (name, commanders, identity): (String, String, String) = sqlx::query_as("SELECT name, commanders, color_identity FROM precons WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("precon"))?;
    let commanders: Vec<String> = serde_json::from_str(&commanders).unwrap_or_default();
    let commander = (!commanders.is_empty()).then(|| commanders.join(" and "));
    Ok(SeatCfg {
        seat,
        kind: "ai".into(),
        user_id: None,
        name: commander.clone().unwrap_or_else(|| name.clone()),
        deck_id: Some(format!("precon:{id}")),
        deck_version_id: None,
        deck_name: Some(name),
        color_identity: identity,
        commander,
        difficulty: Some(difficulty.unwrap_or("Medium").into()),
        bracket: None,
    })
}

/// A precon's stock list as deck cards, for the engine.
async fn precon_cards(pool: &SqlitePool, id: &str) -> AppResult<Vec<DeckCard>> {
    let cards: String = sqlx::query_scalar("SELECT cards FROM precons WHERE id = ?").bind(id).fetch_optional(pool).await?.ok_or(AppError::NotFound("precon"))?;
    let cards: Vec<crate::lab::PreconCard> = serde_json::from_str(&cards).map_err(anyhow::Error::from)?;
    Ok(cards.into_iter().map(|c| DeckCard { oracle_id: c.oracle_id.unwrap_or_default(), name: c.name, qty: i64::from(c.qty), board: c.board }).collect())
}

/// The cards a seat brings to the game: its saved deck version, or its precon's stock list.
async fn seat_cards(pool: &SqlitePool, s: &SeatCfg) -> AppResult<Vec<DeckCard>> {
    match (precon_of(s), &s.deck_version_id) {
        (Some(precon), _) => precon_cards(pool, precon).await,
        (None, Some(version)) => load_version_cards(pool, version).await,
        (None, None) => Err(AppError::Conflict("every seat needs a player and a deck".into())),
    }
}

fn ai_seats(seats: &[SeatCfg]) -> Vec<(u8, Difficulty)> {
    seats
        .iter()
        .filter(|s| s.kind == "ai")
        .map(|s| (s.seat, Difficulty::from_label(s.difficulty.as_deref().unwrap_or("Medium"))))
        .collect()
}

#[derive(Serialize)]
pub(crate) struct SeatInfo {
    seat: u8,
    name: String,
    ai: Option<String>,
    deck_name: Option<String>,
    /// The deck's commander, so seats and boards can show its art.
    commander: Option<String>,
    /// The commander's art crop (Scryfall, loaded by the browser) and who painted it, so every
    /// seat's art is known from the lobby on, wherever the commander card is later.
    commander_art: Option<String>,
    commander_artist: Option<String>,
    color_identity: String,
    ready: bool,
    /// The bracket the deck's owner declared.
    bracket: Option<i64>,
    /// Commander Spellbook's estimate for the deck version in this seat, if it has answered.
    estimate: Option<Estimated>,
}

/// A commander's art crop and its artist.
pub(crate) type Art = (Option<String>, Option<String>);

pub(crate) fn seat_infos(seats: &[SeatCfg], estimates: &HashMap<String, Estimated>, arts: &HashMap<String, Art>) -> Vec<SeatInfo> {
    seats
        .iter()
        .map(|s| {
            let (commander_art, commander_artist) = s.commander.as_ref().and_then(|c| arts.get(c)).cloned().unwrap_or_default();
            SeatInfo {
                seat: s.seat,
                name: s.name.clone(),
                ai: (s.kind == "ai").then(|| s.difficulty.clone().unwrap_or_else(|| "Medium".into())),
                deck_name: s.deck_name.clone(),
                commander: s.commander.clone(),
                commander_art,
                commander_artist,
                color_identity: s.color_identity.clone(),
                ready: seated(s),
                bracket: s.bracket,
                estimate: s.deck_version_id.as_ref().and_then(|v| estimates.get(v)).cloned(),
            }
        })
        .collect()
}

/// Art for every commander seated in these games, by the seat's commander name. Partners
/// ("A and B") show the first one's art, unless a single card has the whole name.
pub(crate) async fn commander_arts<'a>(pool: &SqlitePool, seats: impl Iterator<Item = &'a SeatCfg>) -> sqlx::Result<HashMap<String, Art>> {
    let mut arts = HashMap::new();
    for name in seats.filter_map(|s| s.commander.as_ref()) {
        if arts.contains_key(name) {
            continue;
        }
        let mut found = None;
        for candidate in [Some(name.as_str()), name.split(" and ").next().filter(|first| *first != name)].into_iter().flatten() {
            found = sqlx::query_as::<_, Art>(
                "SELECT c.image_art_crop, c.artist FROM card_names n JOIN cards c ON c.oracle_id = n.oracle_id WHERE n.name = ?
                 ORDER BY IFNULL(c.layout,'') IN ('token','double_faced_token') LIMIT 1",
            )
            .bind(candidate)
            .fetch_optional(pool)
            .await?;
            if found.is_some() {
                break;
            }
        }
        arts.insert(name.clone(), found.unwrap_or_default());
    }
    Ok(arts)
}

/// Spellbook estimates for the deck versions seated in these games.
async fn seat_estimates(pool: &SqlitePool, rows: &[&Row]) -> sqlx::Result<HashMap<String, Estimated>> {
    let mut versions: Vec<String> = rows.iter().flat_map(|r| r.seats()).filter_map(|s| s.deck_version_id).collect();
    versions.sort();
    versions.dedup();
    crate::deck_checks::estimates(pool, &versions).await
}

#[derive(Serialize)]
struct OnlineGame {
    id: String,
    code: String,
    status: &'static str,
    host: String,
    seats: Vec<SeatInfo>,
    you: Option<u8>,
    created_at: String,
    /// When the game last changed (a move, a seat taken).
    updated_at: String,
    /// The winning seat of a finished game (none for a draw or an abandoned game).
    winner: Option<u8>,
    /// How many turns a finished game took.
    turns: Option<i64>,
    /// The playgroup whose stats the game counts toward.
    playgroup: Option<String>,
    /// A table that hasn't started: the seat the host chose to go first. None means the engine
    /// rolls for it when the game starts.
    #[serde(skip_serializing_if = "Option::is_none")]
    first: Option<u8>,
    /// How a finished game was won (`crate::stats::WIN_CONDITIONS`): read from the knockouts that
    /// ended it, or what a player said on the game-over screen.
    win_condition: Option<String>,
    /// Your own fun rating for a finished game, 1 to 5, if you gave one (game detail only).
    #[serde(skip_serializing_if = "Option::is_none")]
    fun: Option<i64>,
    /// What the host wrote about a finished game.
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    /// Deck name → cards the engine can't play yet (left out of the game).
    missing_cards: HashMap<String, Vec<String>>,
    /// When play started and, once it's over, when it ended (for the game's length).
    started_at: Option<String>,
    ended_at: Option<String>,
    /// The rematch the host started from this game, for the people in it (game detail only).
    #[serde(skip_serializing_if = "Option::is_none")]
    rematch: Option<Rematch>,
    runtime_error: Option<String>,
    /// You host this game and it can never run on this server ([`PlayHub::stranded`]): you may
    /// delete it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stranded: bool,
    /// The live game uses the exact runtime supported by the installed Phase board.
    phase_board: bool,
    /// For a game this server is playing, from your view of the board: its turn, whose turn it is,
    /// and whether you have a move other than passing (the Play headline, without the board).
    #[serde(skip_serializing_if = "Option::is_none")]
    turn: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    active: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    your_move: Option<bool>,
}

/// A live game's turn, active seat, and whether `you` have a move other than passing, from the
/// view `you` would get (a spectator's if none).
fn headline(snap: &Snapshot, you: Option<u8>) -> Option<(u32, u8, bool)> {
    let real_move = |options: &[&str]| !options.is_empty() && !(options.len() == 1 && options[0].starts_with("Pass"));
    if let Some(v) = snap.historical_views.get(&you).or_else(|| snap.historical_views.get(&None)) {
        let options: Vec<&str> = v["decision"]["options"].as_array().into_iter().flatten().filter_map(|o| o["label"].as_str()).collect();
        let decided = !v["decision"].is_null();
        return Some((v["turn"].as_u64()? as u32, v["active"].as_u64()? as u8, decided && real_move(&options)));
    }
    let v = snap.views.get(&you).or_else(|| snap.views.get(&None))?;
    let options: Vec<&str> = v.decision.iter().flat_map(|d| d.options.iter().map(|o| o.label.as_str())).collect();
    Some((v.turn, v.active, v.decision.is_some() && real_move(&options)))
}

/// A rematch lobby: its id, the code to join it, and the deck you played here, to join with.
#[derive(Serialize)]
struct Rematch {
    id: String,
    code: String,
    deck_id: Option<String>,
}

#[derive(sqlx::FromRow)]
struct Row {
    game_id: String,
    code: String,
    host_id: String,
    stage: String,
    seats: String,
    created_at: String,
    updated_at: String,
    winner_seat: Option<i64>,
    turns: Option<i64>,
    playgroup: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
    rematch_id: Option<String>,
    engine_version: Option<String>,
    game_status: Option<String>,
    win_condition: Option<String>,
    first_seat: Option<i64>,
    note: Option<String>,
}

/// The columns a [`Row`] reads; `o` is online_games, `g` games, `p` playgroups.
const ROW_SELECT: &str =
    "SELECT o.game_id, o.code, o.host_id, o.stage, o.seats, o.created_at, o.updated_at, g.winner_seat, g.turns, p.name AS playgroup,
     g.started_at, g.ended_at, o.rematch_id, g.engine_version, g.status AS game_status, g.win_condition, g.first_seat, g.note
     FROM online_games o LEFT JOIN games g ON g.id = o.game_id LEFT JOIN playgroups p ON p.id = g.playgroup_id";

impl Row {
    fn seats(&self) -> Vec<SeatCfg> {
        serde_json::from_str(&self.seats).unwrap_or_default()
    }
    fn status(&self) -> &'static str {
        if self.game_status.as_deref() == Some("abandoned") { return "abandoned"; }
        match self.stage.as_str() {
            "lobby" => "lobby",
            "live" => "in_progress",
            _ => "finished",
        }
    }
}

/// Host, seated players, and members of the game's playgroup may see a game. Everyone else
/// gets "not found", so game ids leak nothing.
async fn can_view(pool: &SqlitePool, r: &Row, user: &str) -> AppResult<bool> {
    if r.host_id == user || r.seats().iter().any(|s| s.user_id.as_deref() == Some(user)) {
        return Ok(true);
    }
    let group: Option<Option<String>> =
        sqlx::query_scalar("SELECT playgroup_id FROM games WHERE id = ?").bind(&r.game_id).fetch_optional(pool).await?;
    match group.flatten() {
        Some(g) => crate::playgroups::is_member(pool, &g, user).await,
        None => Ok(false),
    }
}

async fn load_visible(pool: &SqlitePool, id: &str, user: &str) -> AppResult<Row> {
    let r = load_row(pool, id).await?;
    if can_view(pool, &r, user).await? { Ok(r) } else { Err(AppError::NotFound("game")) }
}

async fn load_row(pool: &SqlitePool, id: &str) -> AppResult<Row> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{ROW_SELECT} WHERE o.game_id = ?")))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("game"))
}

#[derive(Serialize)]
struct Status {
    enabled: bool,
    reason: Option<String>,
    /// The matching current-runtime Phase client is installed.
    board: bool,
    unavailable_games: Vec<serde_json::Value>,
}

async fn status(State(st): State<AppState>, Player(user): Player,) -> AppResult<Json<Status>> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{ROW_SELECT} WHERE o.host_id=? OR o.seats LIKE ?")))
        .bind(&user.id)
        .bind(format!("%\"user_id\":\"{}\"%", user.id))
        .fetch_all(&st.pool)
        .await?;
    let unavailable_games =
        rows.iter().filter_map(|r| { st.play.game_error(r).map(|reason| serde_json::json!({"id":r.game_id,"reason":reason}))
        }).collect();
    let reason = st.play.engine().err().map(|e| e.to_string());
    let board = reason.is_none() && st.cfg.board_dist.is_some();
    Ok(Json(Status { enabled: reason.is_none(), reason, board, unavailable_games, }))
}

async fn list(State(st): State<AppState>, Player(user): Player) -> AppResult<Json<Vec<OnlineGame>>> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{ROW_SELECT} WHERE o.host_id = ? OR o.seats LIKE ? ORDER BY o.updated_at DESC LIMIT 50"
    )))
    .bind(&user.id)
    .bind(format!("%\"user_id\":\"{}\"%", user.id))
    .fetch_all(&st.pool)
    .await?;
    let estimates = seat_estimates(&st.pool, &rows.iter().collect::<Vec<_>>()).await?;
    let all_seats: Vec<SeatCfg> = rows.iter().flat_map(|r| r.seats()).collect();
    let arts = commander_arts(&st.pool, all_seats.iter()).await?;
    Ok(Json(
        rows.iter()
            .map(|r| {
                let mut game = summarize(r, &user.id, HashMap::new(), &estimates, &arts);
                game.runtime_error = st.play.game_error(r);
                game.stranded = r.host_id == user.id && st.play.stranded(r);
                game.phase_board = st.cfg.board_dist.is_some() && board::supports_runtime(&r.stage, r.engine_version.as_deref());
                if r.stage != "over"
                    && let Some(live) = st.play.live(&r.game_id)
                    && let Some((turn, active, your_move)) = headline(&live.views.borrow(), game.you)
                {
                    (game.turn, game.active, game.your_move) = (Some(turn), Some(active), Some(your_move));
                }
                game
            })
            .collect(),
    ))
}

fn summarize(
    r: &Row,
    user: &str,
    missing_cards: HashMap<String, Vec<String>>,
    estimates: &HashMap<String, Estimated>,
    arts: &HashMap<String, Art>,
) -> OnlineGame {
    let seats = r.seats();
    let participant = r.host_id == user || seats.iter().any(|s| s.user_id.as_deref() == Some(user));
    OnlineGame {
        id: r.game_id.clone(),
        // The join code is an invitation; only people already in the game hand it out.
        code: if participant { r.code.clone() } else { String::new() },
        status: r.status(),
        host: r.host_id.clone(),
        you: seats.iter().find(|s| s.user_id.as_deref() == Some(user)).map(|s| s.seat),
        seats: seat_infos(&seats, estimates, arts),
        created_at: r.created_at.clone(),
        updated_at: r.updated_at.clone(),
        winner: if r.stage == "over" { r.winner_seat.and_then(|w| u8::try_from(w).ok()) } else { None },
        turns: if r.stage == "over" { r.turns } else { None },
        playgroup: r.playgroup.clone(),
        first: if r.stage == "lobby" { r.first_seat.and_then(|f| u8::try_from(f).ok()) } else { None },
        win_condition: if r.stage == "over" { r.win_condition.clone() } else { None },
        fun: None,
        note: if r.stage == "over" { r.note.clone() } else { None },
        missing_cards,
        started_at: (r.stage != "lobby").then(|| r.started_at.clone()).flatten(),
        ended_at: if r.stage == "over" { r.ended_at.clone() } else { None },
        rematch: None,
        runtime_error: None,
        stranded: false,
        phase_board: false,
        turn: None,
        active: None,
        your_move: None,
    }
}

/// The rematch started from a finished game, for someone who played in it: the new lobby's code
/// is an invitation, so only the game's own players get it.
async fn rematch_for(pool: &SqlitePool, r: &Row, user: &str) -> AppResult<Option<Rematch>> {
    let seats = r.seats();
    let mine = seats.iter().find(|s| s.user_id.as_deref() == Some(user));
    let Some(id) = r.rematch_id.as_ref().filter(|_| mine.is_some() || r.host_id == user) else { return Ok(None) };
    let code: Option<String> = sqlx::query_scalar("SELECT code FROM online_games WHERE game_id = ?").bind(id).fetch_optional(pool).await?;
    Ok(code.map(|code| Rematch { id: id.clone(), code, deck_id: mine.and_then(|s| s.deck_id.clone()) }))
}

async fn detail(State(st): State<AppState>, Player(user): Player, Path(id): Path<String>) -> AppResult<Json<OnlineGame>> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    let mut missing = HashMap::new();
    if r.stage == "lobby" && let Ok(engine) = st.play.engine() {
        for s in r.seats() {
            // A precon dropped from the catalog while the table waits has no list to report on;
            // Start says so. The lobby page still loads.
            if let (true, Some(name)) = (seated(&s), &s.deck_name)
                && let Ok(cards) = seat_cards(&st.pool, &s).await
            {
                let (_, report) = resolve(&engine, &cards);
                if !report.missing.is_empty() {
                    missing.insert(name.clone(), report.missing);
                }
            }
        }
    }
    let estimates = seat_estimates(&st.pool, &[&r]).await?;
    let arts = commander_arts(&st.pool, r.seats().iter()).await?;
    let mut game = summarize(&r, &user.id, missing, &estimates, &arts);
    game.runtime_error = st.play.game_error(&r);
    game.stranded = r.host_id == user.id && st.play.stranded(&r);
    game.phase_board = st.cfg.board_dist.is_some() && board::supports_runtime(&r.stage, r.engine_version.as_deref());
    game.rematch = rematch_for(&st.pool, &r, &user.id).await?;
    if r.stage == "over" {
        game.fun = sqlx::query_scalar("SELECT fun FROM game_seats WHERE game_id = ? AND user_id = ?").bind(&id).bind(&user.id).fetch_optional(&st.pool).await?.flatten();
    }
    Ok(Json(game))
}

/// A field that tells "left out" (unchanged) from `null` (clear it).
fn present<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// What the game-over screen asks, as the table's finish sheet does. Every answer is optional;
/// a field left out stays as it is and `null` clears it.
#[derive(Deserialize)]
struct ResultRequest {
    /// How the game was won (`crate::stats::WIN_CONDITIONS`).
    #[serde(default, deserialize_with = "present")]
    win_condition: Option<Option<String>>,
    /// The caller's own fun rating, 1 to 5.
    #[serde(default, deserialize_with = "present")]
    fun: Option<Option<i64>>,
    /// A note about the game, from its host (whoever recorded a table game writes its note).
    #[serde(default, deserialize_with = "present")]
    note: Option<Option<String>>,
}

/// A seated player answers the end-of-game questions for a finished game: how it was won (for
/// the game, filled in already where the engine could tell) and how fun it was (for their own
/// seat only). The engine's result itself (the winner, the knockouts) is never theirs to change.
/// Any player may say how the game was won while nothing is recorded; once something is (the
/// engine's reading, or a player's answer), only the host changes or clears it, as whoever
/// recorded a table game is the one who writes its finish.
async fn record_result(
    State(st): State<AppState>,
    Player(user): Player,
    Path(id): Path<String>,
    Json(body): Json<ResultRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    let seat = r
        .seats()
        .iter()
        .find(|s| s.kind == "human" && s.user_id.as_deref() == Some(user.id.as_str()))
        .map(|s| i64::from(s.seat))
        .ok_or_else(|| AppError::Forbidden("Only someone who played in this game can answer for it.".into()))?;
    if r.stage != "over" || r.game_status.as_deref() != Some("finished") {
        return Err(AppError::Conflict("These questions are for a game that has finished.".into()));
    }
    if let Some(Some(how)) = &body.win_condition {
        if !crate::stats::WIN_CONDITIONS.contains(&how.as_str()) {
            return Err(AppError::bad(format!("unknown win condition {how:?}")));
        }
        if r.winner_seat.is_none() {
            return Err(AppError::bad("a drawn game has no win condition"));
        }
    }
    if let Some(how) = &body.win_condition
        && r.win_condition.is_some()
        && *how != r.win_condition
        && r.host_id != user.id
    {
        return Err(AppError::Forbidden("How this game was won is already recorded. Its host can change it.".into()));
    }
    if let Some(Some(fun)) = body.fun
        && !(1..=5).contains(&fun)
    {
        return Err(AppError::bad("fun ratings go from 1 to 5"));
    }
    if let Some(note) = &body.note {
        if r.host_id != user.id {
            return Err(AppError::Forbidden("Only the host writes the game's note.".into()));
        }
        crate::games::check_note(note.as_deref())?;
    }
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(how) = &body.win_condition {
        // Checked again inside the write: two players answering at once can't both fill it in.
        let written = sqlx::query(
            "UPDATE games SET win_condition = ?1 WHERE id = ?2 AND mode = 'online' AND status = 'finished'
               AND (?3 OR win_condition IS NULL OR win_condition IS ?1)",
        )
        .bind(how.as_deref())
        .bind(&id)
        .bind(r.host_id == user.id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if written == 0 {
            return Err(AppError::Forbidden("How this game was won is already recorded. Its host can change it.".into()));
        }
    }
    if let Some(fun) = body.fun {
        let written = sqlx::query("UPDATE game_seats SET fun = ? WHERE game_id = ? AND seat = ? AND user_id = ?")
            .bind(fun)
            .bind(&id)
            .bind(seat)
            .bind(&user.id)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if written == 0 {
            // The game record has no seat for this player (it should): say so, not "saved".
            return Err(AppError::Conflict("This game has no seat on record for you, so the rating wasn't saved.".into()));
        }
    }
    if let Some(note) = &body.note {
        // An empty note is no note.
        let text = note.as_deref().map(str::trim).filter(|n| !n.is_empty());
        sqlx::query("UPDATE games SET note = ? WHERE id = ? AND mode = 'online' AND status = 'finished'").bind(text).bind(&id).execute(&mut *tx).await?;
    }
    let saved: (Option<String>, Option<i64>, Option<String>) =
        // The game's own fields come back even if the caller's seat row is missing.
        sqlx::query_as("SELECT g.win_condition, s.fun, g.note FROM games g LEFT JOIN game_seats s ON s.game_id = g.id AND s.seat = ? WHERE g.id = ?")
            .bind(seat)
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or_default();
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "win_condition": saved.0, "fun": saved.1, "note": saved.2 })))
}

pub(crate) fn deck_lines(cards: &[DeckCard]) -> Vec<DeckLine<'_>> {
    cards
        .iter()
        .filter(|c| c.board != Board::Side)
        .map(|c| DeckLine { oracle_id: &c.oracle_id, name: &c.name, qty: c.qty.max(0) as u32, commander: c.board == Board::Commander })
        .collect()
}

pub(crate) fn resolve(engine: &Engine, cards: &[DeckCard]) -> (SeatDeck, yama_play::DeckReport) {
    let (mut deck, report) = engine.resolve_deck(&deck_lines(cards));
    // A companion waits on the sideboard (CR 702.139a): the first card there with the keyword.
    let side: Vec<DeckLine> = cards
        .iter()
        .filter(|c| c.board == Board::Side)
        .map(|c| DeckLine { oracle_id: &c.oracle_id, name: &c.name, qty: c.qty.max(0) as u32, commander: false })
        .collect();
    deck.companion = engine.companion_of(&side).into_iter().collect();
    (deck, report)
}

#[derive(Serialize)]
struct OnlineSupport {
    /// "ready", "starting" (the engine is still loading its card data) or "off".
    state: &'static str,
    /// Why it isn't ready.
    reason: Option<String>,
    engine_version: &'static str,
    version_id: Option<String>,
    support: Option<DeckSupport>,
}

/// How much of a deck's current version the rules engine can play: cards it doesn't know (left
/// out of games) and cards with abilities it hasn't implemented.
async fn online_support(
    State(st): State<AppState>,
    Player(user): Player,
    Path(id): Path<String>,
) -> AppResult<Json<OnlineSupport>> {
    let version: Option<String> = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ? AND owner_id = ?")
        .bind(&id)
        .bind(&user.id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or(AppError::NotFound("deck"))?;
    let engine = match st.play.engine() {
        Ok(e) => e,
        Err(e) => {
            return Ok(Json(OnlineSupport {
                state: if matches!(e, AppError::Conflict(_)) { "starting" } else { "off" },
                reason: Some(e.to_string()),
                engine_version: yama_play::ENGINE_VERSION,
                version_id: version,
                support: None,
            }));
        }
    };
    let cards = match &version {
        Some(v) => load_version_cards(&st.pool, v).await?,
        None => vec![],
    };
    Ok(Json(OnlineSupport {
        state: "ready",
        reason: None,
        engine_version: yama_play::ENGINE_VERSION,
        version_id: version,
        support: Some(engine.deck_support(&deck_lines(&cards))),
    }))
}

/// A deck the user owns, as it takes a seat.
pub(crate) struct SeatDeckInfo {
    pub(crate) version: String,
    pub(crate) name: String,
    pub(crate) commander: Option<String>,
    pub(crate) identity: String,
    pub(crate) bracket: Option<i64>,
}

/// A deck the user owns: its current version, name, commander, color identity and declared bracket.
pub(crate) async fn deck_for_seat(pool: &SqlitePool, owner: &str, deck_id: &str) -> AppResult<SeatDeckInfo> {
    let (name, version, bracket): (String, Option<String>, Option<i64>) =
        sqlx::query_as("SELECT name, current_version_id, bracket FROM decks WHERE id = ? AND owner_id = ? AND archived = 0")
            .bind(deck_id)
            .bind(owner)
            .fetch_optional(pool)
            .await?
            .ok_or(AppError::NotFound("deck"))?;
    let version = version.ok_or_else(|| AppError::bad("that deck has no cards yet"))?;
    let cards = load_version_cards(pool, &version).await?;
    let commanders: Vec<&DeckCard> = cards.iter().filter(|c| c.board == Board::Commander).collect();
    let mut identity = String::new();
    for c in &commanders {
        let ci: Option<String> = sqlx::query_scalar("SELECT color_identity FROM cards WHERE oracle_id = ?")
            .bind(&c.oracle_id)
            .fetch_optional(pool)
            .await?;
        identity.push_str(&ci.unwrap_or_default());
    }
    let identity = "WUBRG".chars().filter(|c| identity.contains(*c)).collect();
    let commander = (!commanders.is_empty()).then(|| commanders.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(" and "));
    Ok(SeatDeckInfo { version, name, commander, identity, bracket })
}

#[derive(Deserialize)]
struct SeatRequest {
    /// "me", "friend" or "ai"
    kind: String,
    deck_id: Option<String>,
    difficulty: Option<String>,
    /// A computer's seat, or the host's own: a stock precon (`precons.id`) to play, instead of
    /// one of the host's decks. A guest player's seat always plays one.
    #[serde(default)]
    precon_id: Option<String>,
}

#[derive(Deserialize)]
struct CreateRequest {
    seats: Vec<SeatRequest>,
    /// Count the game in this playgroup's stats.
    playgroup_id: Option<String>,
    /// The seat (from 0, in the order given) that takes the first turn. Left out, the engine rolls
    /// for it, as a table would.
    #[serde(default)]
    first: Option<u8>,
}

/// Unfinished games (lobbies and live ones) an invited account may host. Admins have no cap.
pub const MAX_OPEN_GAMES: i64 = 10;
/// The same for an account with the standard allowance (`User::limited`). It was 2 until
/// 12 Nov 2026 (Bryan: "We want logged-in users to be able to do more by default").
pub const OPEN_MAX_OPEN_GAMES: i64 = 3;
/// Unfinished games all accounts with the standard allowance may host together.
pub const OPEN_MAX_OPEN_GAMES_ALL: i64 = 20;

/// Whether a saved runtime identity is one this server can never run: not the current engine and
/// not either preserved historical runtime (`PlayHub::runtime_error`; identities are exact).
fn is_retired_runtime(identity: Option<&str>) -> bool {
    !matches!(identity, Some(yama_play::ENGINE_VERSION | history::IDENTITY | history::V0119_IDENTITY))
}

/// SQL true for an `online_games o` row whose `games g` row is a game this server can never run
/// ([`is_retired_runtime`]): such a game holds no thread or match and nobody can finish it, so it
/// takes no place among open games (an engine upgrade mustn't lock its host out of play). `?1`
/// through `?3` are the current and both historical identities. A current live game always has its
/// identity (start sets it in the same transaction), so this never matches one with a thread.
const NOT_STRANDED: &str = "NOT (o.stage = 'live' AND (g.engine_version IS NULL OR g.engine_version NOT IN (?1, ?2, ?3)))";

/// Refuse a new game that would take `user` past the limits on unfinished games they host.
async fn check_open_games(pool: &SqlitePool, user: &User) -> AppResult<()> {
    if user.is_admin {
        return Ok(());
    }
    let (waiting, playing): (i64, i64) = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT IFNULL(SUM(o.stage = 'lobby'), 0), IFNULL(SUM(o.stage = 'live'), 0) FROM online_games o LEFT JOIN games g ON g.id = o.game_id
         WHERE o.host_id = ?4 AND o.stage IN ('lobby','live') AND {NOT_STRANDED}"
    )))
    .bind(yama_play::ENGINE_VERSION)
    .bind(history::IDENTITY)
    .bind(history::V0119_IDENTITY)
    .bind(&user.id)
    .fetch_one(pool)
    .await?;
    let cap = if user.guest {
        crate::guests::GUEST_MAX_OPEN_GAMES
    } else if user.limited {
        OPEN_MAX_OPEN_GAMES
    } else {
        MAX_OPEN_GAMES
    };
    if waiting + playing >= cap {
        return Err(AppError::Conflict(open_games_message(waiting, playing, cap)));
    }
    if user.guest {
        let guests: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*) FROM online_games o JOIN users u ON u.id = o.host_id LEFT JOIN games g ON g.id = o.game_id
             WHERE o.stage IN ('lobby','live') AND u.guest = 1 AND {NOT_STRANDED}"
        )))
        .bind(yama_play::ENGINE_VERSION)
        .bind(history::IDENTITY)
        .bind(history::V0119_IDENTITY)
        .fetch_one(pool)
        .await?;
        if guests >= crate::guests::GUEST_MAX_OPEN_GAMES_ALL {
            return Err(AppError::Conflict("Lots of guests are playing right now. Sign in to play, or try again later.".into()));
        }
    }
    if user.limited {
        let all: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT COUNT(*) FROM online_games o JOIN users u ON u.id = o.host_id LEFT JOIN games g ON g.id = o.game_id
             WHERE o.stage IN ('lobby','live') AND {NOT_STRANDED} AND {}",
            crate::auth::limited_sql!()
        )))
        .bind(yama_play::ENGINE_VERSION)
        .bind(history::IDENTITY)
        .bind(history::V0119_IDENTITY)
        .fetch_one(pool)
        .await?;
        if all >= OPEN_MAX_OPEN_GAMES_ALL {
            return Err(AppError::Conflict("Online play is busy right now. Try again later.".into()));
        }
    }
    Ok(())
}

/// Why a new game is refused at the limit: what is open, how many the account may have open at
/// once, and the way out of each kind (a table that hasn't started is closed, a game being played
/// is finished).
fn open_games_message(waiting: i64, playing: i64, cap: i64) -> String {
    let tables = |n: i64| if n == 1 { "1 table waiting for players".to_string() } else { format!("{n} tables waiting for players") };
    let games = |n: i64| if n == 1 { "1 game being played".to_string() } else { format!("{n} games being played") };
    let one = |n: i64| if n == 1 { "it" } else { "one" };
    let limit = if cap == 1 { "the limit is 1 open game at a time".to_string() } else { format!("the limit is {cap} open games at a time") };
    match (waiting, playing) {
        (w, 0) => format!("You have {}, and {limit}. Close {} from its page before opening another.", tables(w), one(w)),
        (0, p) => format!("You have {}, and {limit}. Finish {} before starting another.", games(p), one(p)),
        (w, p) => format!("You have {} and {}, and {limit}. Close a waiting table from its page, or finish a game, before starting another.", tables(w), games(p)),
    }
}

async fn create(
    State(st): State<AppState>,
    Player(user): Player,
    Json(body): Json<CreateRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let id = create_game(&st, &user, &body, true).await?;
    Ok(Json(serde_json::json!({ "id": id })))
}

/// The host closes a table that hasn't started, or deletes a game that's over: it comes out of
/// everyone's history and stats, as deleting a table game does (`games::remove`). A game being
/// played isn't deleted from under its players: it ends first (a concession, or End game for a
/// solo game). A live game whose saved runtime can't run here can never end, so its host may
/// delete it as it stands.
async fn remove(State(st): State<AppState>, Player(user): Player, Path(id): Path<String>) -> AppResult<Json<serde_json::Value>> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    if r.host_id != user.id {
        return Err(AppError::Forbidden(if r.stage == "lobby" { "Only the host can close this table." } else { "Only the host can delete this game." }.into()));
    }
    let playing = || AppError::Conflict("This game is being played. Finish it before deleting it.".into());
    let stranded = st.play.stranded(&r);
    if r.stage == "live" && !stranded {
        return Err(playing());
    }
    // The stage, and for a live game its retired engine, are checked again in the delete: Start
    // may have won the race, or startup may have moved the game to the current engine meanwhile.
    let deleted = sqlx::query(
        "DELETE FROM games WHERE id = ?1 AND created_by = ?2 AND mode = 'online'
           AND EXISTS (SELECT 1 FROM online_games o WHERE o.game_id = ?1 AND o.host_id = ?2
             AND (o.stage != 'live' OR (?3 AND (games.engine_version IS NULL OR games.engine_version NOT IN (?4, ?5, ?6)))))",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(stranded)
    .bind(yama_play::ENGINE_VERSION)
    .bind(history::IDENTITY)
    .bind(history::V0119_IDENTITY)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if deleted == 0 {
        return Err(playing());
    }
    st.play.stop(&id);
    st.play.unavailable.lock().unwrap().remove(&id);
    Ok(Json(serde_json::json!({ "deleted": true, "was": if r.stage == "lobby" { "lobby" } else { "game" } })))
}

/// Stop a host-owned solo table, preserving an abandoned result without a winner.
async fn end_solo(
    State(st): State<AppState>,
    Player(user): Player,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    if r.host_id != user.id {
        return Err(AppError::Forbidden(
            "Only the host can end a solo game.".into(),
        ));
    }
    let seats = r.seats();
    let humans: Vec<_> = seats.iter().filter(|s| s.kind == "human").collect();
    if humans.len() != 1 || humans[0].user_id.as_deref() != Some(user.id.as_str()) {
        return Err(AppError::Forbidden(
            "Other human players are at this table. You may concede your own seat.".into(),
        ));
    }
    if r.stage == "over" {
        return Ok(Json(serde_json::json!({"ended": true})));
    }
    if !matches!(r.engine_version.as_deref(), Some(yama_play::ENGINE_VERSION | history::V0119_IDENTITY)) {
        return Err(AppError::Conflict(
            "This saved game's runtime does not support ending a solo table.".into(),
        ));
    }
    let live = st
        .play
        .live(&id)
        .ok_or_else(|| AppError::Conflict("The game is not running.".into()))?;
    let (tx, rx) = oneshot::channel();
    live.cmds
        .send(Cmd::EndSolo {
            seat: humans[0].seat,
            reply: tx,
        })
        .map_err(|_| AppError::Conflict("The game stopped.".into()))?;
    match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
        Ok(Ok(Ok(()))) => Ok(Json(serde_json::json!({"ended": true}))),
        Ok(Ok(Err(e))) => Err(AppError::Conflict(e)),
        _ => Err(AppError::Conflict(
            "Ending the game is still being processed; reload to check its status.".into(),
        )),
    }
}

/// Start a rematch of a finished game (GGameOver): a new lobby with the same seats, the host's
/// deck and the computer's decks and levels, and the same playgroup. Other people's seats are open
/// for them to join, from their own game-over screen or with the code. Only the host may; asking
/// again returns the rematch already made.
async fn rematch(State(st): State<AppState>, Player(user): Player, Path(id): Path<String>,) -> AppResult<Json<serde_json::Value>> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    if r.host_id != user.id {
        return Err(AppError::Forbidden("only the host starts a rematch".into()));
    }
    if r.stage != "over" {
        return Err(AppError::Conflict("that game isn't over yet".into()));
    }
    if let Some(existing) = &r.rematch_id {
        return Ok(Json(serde_json::json!({ "id": existing })));
    }
    // A game whose host chose who goes first was seated from that player on (`start_game`): the
    // new table starts from the host again, in the same order round the table.
    let mut old = r.seats();
    if let Some(mine) = old.iter().position(|s| s.user_id.as_deref() == Some(user.id.as_str())) {
        old.rotate_left(mine);
    }
    let seats = old
        .into_iter()
        .map(|s| {
            let precon = precon_of(&s).map(str::to_string);
            SeatRequest {
                kind: if s.kind == "ai" {
                    "ai".into()
                } else if s.user_id.as_deref() == Some(user.id.as_str()) {
                    "me".into()
                } else {
                    "friend".into()
                },
                deck_id: (precon.is_none() && (s.kind == "ai" || s.user_id.as_deref() == Some(user.id.as_str()))).then_some(s.deck_id).flatten(),
                difficulty: s.difficulty,
                precon_id: precon,
            }
        })
        .collect();
    let playgroup_id: Option<String> =
        sqlx::query_scalar("SELECT playgroup_id FROM games WHERE id = ?").bind(&id).fetch_optional(&st.pool).await?.flatten();
    // Who goes first is rolled again unless the host says otherwise.
    let new = create_game(&st, &user, &CreateRequest { seats, playgroup_id, first: None }, false).await?;
    // Two quick taps make one rematch: the first one recorded wins.
    let set = sqlx::query("UPDATE online_games SET rematch_id = ? WHERE game_id = ? AND rematch_id IS NULL",)
        .bind(&new)
        .bind(&id)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if set == 0 {
        let first: Option<String> = sqlx::query_scalar("SELECT rematch_id FROM online_games WHERE game_id = ?").bind(&id).fetch_one(&st.pool).await?;
        return Ok(Json(serde_json::json!({ "id": first.unwrap_or(new) })));
    }
    Ok(Json(serde_json::json!({ "id": new })))
}

/// Guests' new games one at a time, from the open-game check to the insert, so requests sent
/// together can't all pass the guest caps before any is counted.
static GUEST_CREATES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A guest's game with no move or change for this long is over: its player has gone.
pub const GUEST_IDLE_MINUTES: i64 = 60;

/// End and delete guests' games nobody has touched for [`GUEST_IDLE_MINUTES`]: a guest who closes
/// the tab never comes back to finish, and its game would hold an engine thread and one of the
/// guests' places (`guests::GUEST_MAX_OPEN_GAMES_ALL`) until the guest itself goes.
pub async fn reap_idle_guest_games(st: &AppState) -> AppResult<usize> {
    let before = (chrono::Utc::now() - chrono::Duration::minutes(GUEST_IDLE_MINUTES)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let idle: Vec<String> = sqlx::query_scalar(
        "SELECT o.game_id FROM online_games o JOIN users u ON u.id = o.host_id
         WHERE u.guest = 1 AND o.stage IN ('lobby','live') AND o.updated_at < ?",
    )
    .bind(before)
    .fetch_all(&st.pool)
    .await?;
    for id in &idle {
        st.play.stop(id);
        // online_games and the seats go with the game (ON DELETE CASCADE).
        sqlx::query("DELETE FROM games WHERE id = ? AND mode = 'online'").bind(id).execute(&st.pool).await?;
        st.play.unavailable.lock().unwrap().remove(id);
    }
    Ok(idle.len())
}

/// Make a game from the lobby's seats; it starts at once when there's no friend to wait for.
async fn create_game(st: &AppState, user: &User, body: &CreateRequest,
    auto_start: bool,) -> AppResult<String> {
    st.limits.play_creates.check_user(user)?;
    let guest_gate = if user.guest { Some(GUEST_CREATES.lock().await) } else { None };
    check_open_games(&st.pool, user).await?;
    st.play.engine()?;
    if !(2..=6).contains(&body.seats.len()) {
        return Err(AppError::bad("a game has 2 to 6 seats"));
    }
    if body.seats.first().map(|s| s.kind.as_str()) != Some("me") || body.seats.iter().filter(|s| s.kind == "me").count() != 1 {
        return Err(AppError::bad("seat 1 is you"));
    }
    if let Some(pg) = &body.playgroup_id
        && !crate::playgroups::is_member(&st.pool, pg, &user.id).await?
    {
        return Err(AppError::NotFound("playgroup"));
    }
    if user.guest && body.seats.iter().any(|s| s.kind == "friend") {
        return Err(AppError::Forbidden("Sign in to play with friends. Guests play the computer.".into()));
    }
    if body.first.is_some_and(|f| usize::from(f) >= body.seats.len()) {
        return Err(AppError::bad("the first player must be one of the seats"));
    }
    let mut seats = Vec::new();
    for (i, s) in body.seats.iter().enumerate() {
        let seat = i as u8;
        let cfg = match s.kind.as_str() {
            "friend" => SeatCfg {
                seat,
                kind: "human".into(),
                user_id: None,
                name: format!("Seat {}", i + 1),
                deck_id: None,
                deck_version_id: None,
                deck_name: None,
                color_identity: String::new(),
                commander: None,
                difficulty: None,
                bracket: None,
            },
            "ai" if s.precon_id.is_some() => precon_seat(&st.pool, seat, s.precon_id.as_deref().unwrap(), s.difficulty.as_deref()).await?,
            // Your own seat on a precon: how a guest plays, and anyone without a deck yet.
            "me" if s.precon_id.is_some() => SeatCfg {
                kind: "human".into(),
                user_id: Some(user.id.clone()),
                name: user.display_name.clone(),
                difficulty: None,
                ..precon_seat(&st.pool, seat, s.precon_id.as_deref().unwrap(), None).await?
            },
            "me" | "ai" => {
                let deck_id = s.deck_id.as_deref().ok_or_else(|| AppError::bad(format!("seat {} needs a deck", i + 1)))?;
                let d = deck_for_seat(&st.pool, &user.id, deck_id).await?;
                let ai = s.kind == "ai";
                SeatCfg {
                    seat,
                    kind: if ai { "ai" } else { "human" }.into(),
                    user_id: (!ai).then(|| user.id.clone()),
                    name: if ai { d.commander.clone().unwrap_or_else(|| "Computer".into()) } else { user.display_name.clone() },
                    deck_id: Some(deck_id.into()),
                    deck_version_id: Some(d.version),
                    deck_name: Some(d.name),
                    color_identity: d.identity,
                    commander: d.commander,
                    difficulty: ai.then(|| s.difficulty.clone().unwrap_or_else(|| "Medium".into())),
                    bracket: d.bracket,
                }
            }
            other => return Err(AppError::bad(format!("unknown seat kind {other}"))),
        };
        seats.push(cfg);
    }
    let id = new_id();
    let stamp = now();
    let mut tx = st.pool.begin().await?;
    // Until the game starts, `first_seat` is the host's choice of who goes first (none: roll).
    sqlx::query("INSERT INTO games (id, mode, playgroup_id, created_by, format, status, starting_life, started_at, first_seat) VALUES (?, 'online', ?, ?, 'commander', 'in_progress', 40, ?, ?)")
        .bind(&id)
        .bind(&body.playgroup_id)
        .bind(&user.id)
        .bind(&stamp)
        .bind(body.first.map(i64::from))
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO online_games (game_id, code, host_id, stage, seats, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(short_code(6))
        .bind(&user.id)
        .bind("lobby")
        .bind(serde_json::to_string(&seats).map_err(anyhow::Error::from)?)
        .bind(&stamp)
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    // Counted now: the next guest's check sees this game.
    drop(guest_gate);
    // With no friends to wait for, start right away.
    if auto_start
        && !seats.iter().any(|s| s.kind == "human" && s.user_id.is_none()) {
        start_detached(st, &id, &user.id).await?;
    }
    Ok(id)
}

#[derive(Deserialize)]
struct JoinRequest {
    code: String,
    deck_id: String,
}

async fn join(
    State(st): State<AppState>,
    Player(user): Player,
    Json(body): Json<JoinRequest>,
) -> AppResult<Json<serde_json::Value>> {
    if user.guest {
        return Err(AppError::Forbidden(crate::guests::SIGN_IN_TO_JOIN.into()));
    }
    st.limits.join_codes.check_user(&user)?;
    let id: String = sqlx::query_scalar("SELECT game_id FROM online_games WHERE code = ?")
        .bind(body.code.trim().to_uppercase())
        .fetch_optional(&st.pool)
        .await?
        .ok_or(AppError::NotFound("game with that code"))?;
    let d = deck_for_seat(&st.pool, &user.id, &body.deck_id).await?;
    // Seats are one JSON value: take a seat with compare-and-set, retrying if someone else
    // joined at the same moment, so two joins can't overwrite each other.
    for _ in 0..5 {
        let r = load_row(&st.pool, &id).await?;
        let mut seats = r.seats();
        if seats.iter().any(|s| s.user_id.as_deref() == Some(user.id.as_str())) {
            return Ok(Json(serde_json::json!({ "id": id }))); // already seated
        }
        if r.stage != "lobby" {
            return Err(AppError::Conflict("that game has already started".into()));
        }
        let seat = seats
            .iter_mut()
            .find(|s| s.kind == "human" && s.user_id.is_none())
            .ok_or_else(|| AppError::Conflict("that game is full".into()))?;
        seat.user_id = Some(user.id.clone());
        seat.name = user.display_name.clone();
        seat.deck_id = Some(body.deck_id.clone());
        seat.deck_version_id = Some(d.version.clone());
        seat.deck_name = Some(d.name.clone());
        seat.commander = d.commander.clone();
        seat.color_identity = d.identity.clone();
        seat.bracket = d.bracket;
        let updated = sqlx::query("UPDATE online_games SET seats = ?, updated_at = ? WHERE game_id = ? AND stage = 'lobby' AND seats = ?")
            .bind(serde_json::to_string(&seats).map_err(anyhow::Error::from)?)
            .bind(now())
            .bind(&id)
            .bind(&r.seats)
            .execute(&st.pool)
            .await?
            .rows_affected();
        if updated == 1 {
            return Ok(Json(serde_json::json!({ "id": id })));
        }
    }
    Err(AppError::Conflict("the table changed while you were joining; try again".into()))
}

async fn start(State(st): State<AppState>, Player(user): Player, Path(id): Path<String>) -> AppResult<()> {
    start_detached(&st, &id, &user.id).await
}

/// `start_game` in a task of its own, so a request that disconnects doesn't throw the setup away.
/// On 13 Nov 2026 a phone gave up on a start that took over 28 s (the engine paging back in from
/// disk swap) and the table was left in its lobby; now the game goes live anyway and the player
/// finds it under Continue.
async fn start_detached(st: &AppState, id: &str, user: &str) -> AppResult<()> {
    let (st, id, user) = (st.clone(), id.to_string(), user.to_string());
    tokio::spawn(async move {
        let result = start_game(&st, &id, &user).await;
        if let Err(error) = &result {
            tracing::info!(game_id = id.as_str(), %error, "online game didn't start");
        }
        result
    })
    .await
    .map_err(|error| AppError::Other(error.into()))?
}

async fn start_game(st: &AppState, id: &str, user: &str) -> AppResult<()> {
    // Serialize setup without occupying SQLite. Duplicate starts re-read the lobby
    // after the first commit; cancellation cannot free a still-running worker's slot.
    let permit = tokio::time::timeout(std::time::Duration::from_secs(10), st.play.setup_gate.clone().acquire_owned())
        .await.map_err(|_| AppError::Unavailable("A game is still starting. Try again in a moment.".into()))?
        .map_err(|e| AppError::Other(e.into()))?;
    // Timed from the slot: reading the decks below touches engine card data as much as setup does.
    let began = std::time::Instant::now();
    let r = load_row(&st.pool, id).await?;
    if r.host_id != user {
        return Err(AppError::Forbidden("only the host starts the game".into()));
    }
    if r.stage != "lobby" {
        return Ok(());
    }
    let mut seats = r.seats();
    if seats.iter().any(|s| !seated(s)) {
        return Err(AppError::Conflict("every seat needs a player and a deck".into()));
    }
    // The host's choice of who goes first. phase starts only seat 0 or 1 on request, so (as Watch
    // does) the table is numbered from that player: the order round the table is the same cycle.
    let first = r.first_seat.and_then(|f| usize::try_from(f).ok()).filter(|f| *f < seats.len()).map(|f| {
        seats.rotate_left(f);
        for (i, s) in seats.iter_mut().enumerate() {
            s.seat = i as u8;
        }
        0u8
    });
    let engine = st.play.engine()?;
    let mut decks = Vec::new();
    for s in &seats {
        decks.push(resolve(&engine, &seat_cards(&st.pool, s).await?).0);
    }
    let prefs = seat_prefs(&st.pool, &seats).await;
    let seed: u64 = u64::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().unwrap());
    let ai = ai_seats(&seats);
    // Setup can fault cold engine pages in from disk. It must neither block an async
    // worker nor hold SQLite's one writer while constructing the match and replay.
    let (m, replay, permit) = prepare_match(move || {
        let m = engine.new_match_with(seed, decks, &ai, Setup { first, loops: yama_play::PLAY_LOOPS })?;
        let replay = m.replay_json();
        Ok((m, replay, permit))
    }).await?;
    let secs = began.elapsed().as_secs_f32();
    if secs > 3.0 {
        tracing::warn!(game_id = id, secs, "online game setup was slow");
    }
    // Claim and save atomically after preparation. A concurrent start or join can
    // invalidate this candidate; only the request still owning these seats publishes it.
    let mut tx = st.pool.begin().await?;
    let claimed = sqlx::query("UPDATE online_games SET stage = 'live', seats = ?, updated_at = ? WHERE game_id = ? AND stage = 'lobby' AND seats = ?")
        .bind(serde_json::to_string(&seats).map_err(anyhow::Error::from)?)
        .bind(now())
        .bind(id)
        .bind(&r.seats)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if claimed == 0 {
        return Ok(());
    }
    // From here `first_seat` is who took the first turn: the host's choice or the engine's roll.
    sqlx::query("UPDATE games SET engine_version = ?, seed = ?, started_at = ?, first_seat = ? WHERE id = ?")
        .bind(yama_play::ENGINE_VERSION)
        .bind(seed as i64) // u64 stored bit-for-bit
        .bind(now())
        .bind(i64::from(m.starting_seat()))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for s in &seats {
        sqlx::query(
            // A seated person who belongs to the game's playgroup sits there as that member, as at
            // the table, so the group's pages count the game as theirs.
            "INSERT OR REPLACE INTO game_seats (game_id, seat, member_id, user_id, guest_name, ai_kind, deck_version_id, deck_label, commander_name)
             VALUES (?1, ?2, (SELECT m.id FROM playgroup_members m JOIN games g ON g.playgroup_id = m.playgroup_id WHERE g.id = ?1 AND m.user_id = ?3),
                     ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .bind(id)
        .bind(i64::from(s.seat))
        .bind(&s.user_id)
        .bind((s.kind == "ai").then(|| s.name.clone()))
        .bind(s.difficulty.as_ref().map(|d| format!("phase-ai {d}")))
        .bind(&s.deck_version_id)
        .bind(&s.deck_name)
        .bind(&s.commander)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE online_games SET replay = ?, updated_at = ? WHERE game_id = ?")
        .bind(replay)
        .bind(now())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    let hub = st.play.clone();
    let pool = st.pool.clone();
    let game_id = id.to_string();
    // Once SQLite is asked to commit, publishing the live game must finish even if
    // the HTTP request disconnects. Dropping this join handle does not abort its task.
    tokio::spawn(async move {
        let _permit = permit; // publication owns the slot even if the HTTP future disconnects
        tx.commit().await?;
        hub.spawn_game(game_id, m, seats, prefs, pool);
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|error| AppError::Other(error.into()))?
}

/// Engine setup uses the same large stack as live games. No database connection
/// travels into this worker; cancelling the request drops its uncommitted candidate.
async fn prepare_match<T: Send + 'static>(build: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> AppResult<T> {
    let (tx, rx) = oneshot::channel();
    std::thread::Builder::new()
        .name("game-setup".into())
        .stack_size(STACK)
        .spawn(move || { let _ = tx.send(build()); })
        .map_err(anyhow::Error::from)?;
    rx.await.map_err(|_| anyhow::anyhow!("game setup worker stopped"))?.map_err(AppError::from)
}

// ── WebSocket ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    GoBack {
        revision: u64,
        checkpoint: Option<u64>,
    },
    Choose {
        revision: u64,
        index: usize,
    },
    Attack {
        revision: u64,
        attacks: Vec<(u64, AttackAt)>,
    },
    Block {
        revision: u64,
        blocks: Vec<(u64, u64)>,
    },
    /// A full answer to your decision. Only the kinds `Act` spells can be sent; anything else
    /// (a debug action, a made-up kind) doesn't parse and is dropped.
    Act {
        revision: u64,
        action: Act,
    },
    Concede,
    /// Your stops (`null` for the usual ones) and full control, saved to your account and applied
    /// to this game; and "Tap mana for me", which older boards leave out (the saved one stays).
    Prefs {
        stops: Option<Stops>,
        full_control: bool,
        #[serde(default)]
        tap_mana: Option<PayMode>,
    },
    /// Older boards: full control for this game only.
    FullControl {
        on: bool,
    },
    /// Older boards: your own stops by step for this game only; `null` for the usual ones.
    Stops {
        stops: Option<Stops>,
    },
    /// A way to pass (`until`, `turn`, `end`, `mine`), or `null` to stop one.
    Pass {
        revision: u64,
        mode: Option<PassMode>,
    },
    /// Hold priority while your own spell is on the stack, or stop holding it.
    Hold {
        on: bool,
    },
    /// Which sources paying automatically would tap to cast `object` (GCast's "Will tap"), while
    /// you drag or point at it. Answered with a `preview` message; asked at most every 100 ms.
    Preview {
        revision: u64,
        object: u64,
    },
}

async fn connect(
    State(st): State<AppState>,
    Player(user): Player,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    let seats = r.seats();
    let you = seats.iter().find(|s| s.user_id.as_deref() == Some(user.id.as_str())).map(|s| s.seat);
    if let Some(error) = st.play.game_error(&r) {
        return Err(AppError::Conflict(error));
    }
    let live = st.play.live(&id).ok_or_else(|| AppError::Conflict("that game isn't running".into()))?;
    Ok(ws.on_upgrade(move |socket| watch_game(socket, st.pool.clone(), live, you, seats, user.id)))
}

/// What the board needs to show a card readably: full-size image and rules text, by name.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub(crate) struct CardMeta {
    /// For loading rulings in the card inspector.
    oracle_id: String,
    image: Option<String>,
    back_image: Option<String>,
    /// The art crop, for square battlefield tiles, and who painted it.
    art: Option<String>,
    artist: Option<String>,
    mana_cost: Option<String>,
    type_line: String,
    oracle_text: String,
    /// A two-faced or adventurer card's faces (Scryfall's, as imported): each one's name, mana
    /// cost, type line and Oracle text, for choosing which face or half to cast.
    #[serde(serialize_with = "face_list", skip_serializing_if = "Option::is_none")]
    faces: Option<String>,
}

/// The faces column as the board reads it: only the words, not Scryfall's other fields.
fn face_list<S: serde::Serializer>(faces: &Option<String>, s: S) -> Result<S::Ok, S::Error> {
    #[derive(Serialize, Deserialize)]
    struct Face {
        name: String,
        #[serde(default)]
        mana_cost: Option<String>,
        #[serde(default)]
        type_line: Option<String>,
        #[serde(default)]
        oracle_text: Option<String>,
    }
    let list: Vec<Face> = faces.as_deref().and_then(|f| serde_json::from_str(f).ok()).unwrap_or_default();
    list.serialize(s)
}

/// Every card name the view shows (board, hand, stack, graveyards, exile, command zone), the
/// cards in the viewer's own decision (library cards they scry or search, triggers to order) and
/// the cards in what they were told happened.
/// A view only carries its own seat's decision, read from that seat's view of the game, so
/// nobody else's library card is ever named here.
pub(crate) fn view_names(view: &View) -> Vec<String> {
    let mut names: Vec<String> = view
        .battlefield
        .iter()
        .chain(&view.hand)
        .chain(&view.command_zone)
        .chain(&view.exile)
        .chain(view.players.iter().flat_map(|p| p.graveyard.iter()))
        .chain(view.hands.values().flatten())
        .map(|c| c.name.clone())
        .chain(view.stack.iter().map(|s| s.name.clone()))
        // The card under a face-down card, in the view of a seat that may look at it (its
        // controller), so that seat can read it; nobody else's view names it.
        .chain(view.battlefield.iter().chain(&view.exile).filter_map(|c| c.under.clone()))
        .chain(view.stack.iter().filter_map(|s| s.under.clone()))
        // Revealed companions are public.
        .chain(view.players.iter().filter_map(|p| p.companion.as_ref().map(|c| c.name.clone())))
        .chain(view.decision.iter().filter_map(|d| d.pending.as_ref()).flat_map(|p| p.card_names()))
        // A table-wide decision's public cards (votes for permanents, piles), as this viewer sees them.
        .chain(view.together.iter().flat_map(|t| t.card_names()))
        // Cards named in what this viewer was told happened (already filtered for them), for the
        // log's art and the reveal panel's images.
        .chain(view.events.iter().flat_map(|h| h.card_names()))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Fill in the deciding seat's decision with Yama's card details, as the design's decision
/// widgets read them: the source card's art, image, artist and Oracle text, and each card
/// option's image, art and artist.
pub(crate) fn dress_pending(view: &mut View, cards: &BTreeMap<String, CardMeta>) {
    let Some(p) = view.decision.as_mut().and_then(|d| d.pending.as_mut()) else { return };
    if let Some(src) = p.source.as_mut()
        && let Some(m) = cards.get(&src.name)
    {
        src.art = m.art.clone();
        src.image = m.image.clone();
        src.artist = m.artist.clone();
        p.oracle = Some(m.oracle_text.clone()).filter(|t| !t.is_empty());
    }
    for o in p.options.iter_mut().chain(p.shown.iter_mut()).filter(|o| o.card) {
        if let Some(m) = cards.get(&o.name) {
            o.img = m.image.clone();
            o.art = m.art.clone();
            o.artist = m.artist.clone();
        }
    }
}

/// Look up card details by name, remembering answers (including "unknown") for this connection.
/// Sorted by name, so the message comes out the same every time.
pub(crate) async fn card_meta(
    pool: &SqlitePool,
    names: &[String],
    cache: &mut HashMap<String, Option<CardMeta>>,
) -> BTreeMap<String, CardMeta> {
    for name in names {
        if cache.contains_key(name) {
            continue;
        }
        let meta: Option<CardMeta> = sqlx::query_as(
            "SELECT c.oracle_id, c.image_normal AS image, c.back_image_normal AS back_image, c.image_art_crop AS art, c.artist, c.mana_cost, c.type_line, c.oracle_text, c.faces
             FROM card_names n JOIN cards c ON c.oracle_id = n.oracle_id WHERE n.name = ?
             ORDER BY IFNULL(c.layout,'') IN ('token','double_faced_token') LIMIT 1",
        )
        .bind(name)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
        cache.insert(name.clone(), meta);
    }
    names.iter().filter_map(|n| cache.get(n).cloned().flatten().map(|m| (n.clone(), m))).collect()
}

/// The `view` message as it goes on the wire.
#[derive(Serialize)]
struct ViewMessage<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    you: Option<u8>,
    seats: &'a serde_json::Value,
    cards: &'a BTreeMap<String, CardMeta>,
    view: &'a View,
}

/// The `view` message one connection is sent: the board with the card details it names (looked up
/// through this connection's cache), and the deciding seat's decision dressed with them. Written
/// straight to text: building it as a JSON value first, and copying the whole view to dress a
/// decision most views don't have, cost more than the rest of the message (docs/play-performance.md).
async fn view_message(
    pool: &SqlitePool,
    view: &View,
    you: Option<u8>,
    infos: &serde_json::Value,
    cache: &mut HashMap<String, Option<CardMeta>>,
) -> String {
    let cards = card_meta(pool, &view_names(view), cache).await;
    let dressed;
    let view = if view.decision.as_ref().is_some_and(|d| d.pending.is_some()) {
        let mut copy = view.clone();
        dress_pending(&mut copy, &cards);
        dressed = copy;
        &dressed
    } else {
        view
    };
    serde_json::to_string(&ViewMessage { kind: "view", you, seats: infos, cards: &cards, view }).expect("a view serializes")
}

async fn watch_game(socket: WebSocket, pool: SqlitePool, live: LiveGame, you: Option<u8>, seats: Vec<SeatCfg>, user: String,) {
    let (mut sink, mut stream) = socket.split();
    // Account settings fill defaults on connection, preserving controls recovered
    // from this game's replay. Explicit preference messages remain authoritative.
    // The board learns whether any account settings exist to import older device settings once.
    if let Some(seat) = you {
        let saved = load_prefs(&pool, &user).await.ok().flatten();
        if let Some(prefs) = saved.clone() {
            let _ = live.cmds.send(Cmd::AccountPrefs { seat, prefs });
        }
        let msg = serde_json::json!({ "type": "prefs", "saved": saved.is_some() }).to_string();
        if sink.send(Message::Text(msg.into())).await.is_err() {
            return;
        }
    }
    let reader_pool = pool.clone();
    let mut views = live.views.clone();
    let mut meta_cache: HashMap<String, Option<CardMeta>> = HashMap::new();
    let arts = commander_arts(&pool, seats.iter()).await.unwrap_or_default();
    let infos = serde_json::to_value(seat_infos(&seats, &HashMap::new(), &arts)).unwrap_or_default();
    let (err_tx, mut err_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // Answers to the board's own questions (the auto-tap preview).
    let (note_tx, mut note_rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();

    // Incoming choices go to the game thread; refusals come back as error messages.
    let cmds = live.cmds.clone();
    let reader = tokio::spawn(async move {
        let mut last_preview: Option<std::time::Instant> = None;
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(text) = msg else { continue };
            let (Some(seat), Ok(m)) = (you, serde_json::from_str::<ClientMessage>(&text)) else { continue; };
            match m {
                ClientMessage::GoBack { revision, checkpoint } => {
                    let (tx, rx) = oneshot::channel();
                    if cmds
                        .send(Cmd::GoBack {
                            seat,
                            revision,
                            checkpoint,
                            reply: tx,
                        })
                        .is_ok()
                    {
                        if let Ok(Err(error)) = rx.await {
                            let _ = note_tx
                                .send(serde_json::json!({"type": "error", "message": error}));
                        }
                    }
                }
                ClientMessage::Choose { revision, index } => {
                    let (tx, rx) = oneshot::channel();
                    if cmds.send(Cmd::Choose { seat, revision, index, reply: tx, }).is_err() {
                        break;
                    }
                    if let Ok(Err(e)) = rx.await {
                        let _ = err_tx.send(e);
                    }
                }
                ClientMessage::Attack { revision, attacks } => {
                    let (tx, rx) = oneshot::channel();
                    if cmds.send(Cmd::Attack { seat, revision, attacks, reply: tx, }).is_err() {
                        break;
                    }
                    if let Ok(Err(e)) = rx.await {
                        let _ = err_tx.send(e);
                    }
                }
                ClientMessage::Block { revision, blocks } => {
                    let (tx, rx) = oneshot::channel();
                    if cmds.send(Cmd::Block { seat, revision, blocks, reply: tx, }).is_err() {
                        break;
                    }
                    if let Ok(Err(e)) = rx.await {
                        let _ = err_tx.send(e);
                    }
                }
                ClientMessage::Act { revision, action } => {
                    let (tx, rx) = oneshot::channel();
                    if cmds.send(Cmd::Act { seat, revision, action, reply: tx, }).is_err() {
                        break;
                    }
                    if let Ok(Err(e)) = rx.await {
                        let _ = err_tx.send(e);
                    }
                }
                ClientMessage::Concede => {
                    let _ = cmds.send(Cmd::Concede { seat });
                }
                ClientMessage::Prefs { stops, full_control, tap_mana, } => {
                    // An older board doesn't send "Tap mana for me": keep the saved one.
                    let tap_mana = match tap_mana {
                        Some(t) => t,
                        None => load_prefs(&reader_pool, &user).await.ok().flatten().map(|p| p.tap_mana).unwrap_or_default(),
                    };
                    let prefs = PlayPrefs { stops: stops.map(clean_stops), full_control, tap_mana, };
                    if let Err(e) = save_prefs(&reader_pool, &user, &prefs).await {
                        tracing::error!(error = %e, "saving play settings failed");
                        let _ = err_tx.send("Your settings couldn't be saved; they apply to this game only.".into(),);
                    }
                    let _ = cmds.send(Cmd::Prefs { seat, prefs });
                }
                ClientMessage::Pass { revision, mode } => {
                    let (tx, rx) = oneshot::channel();
                    if cmds.send(Cmd::Passing { seat, revision, mode, reply: tx, }).is_err() {
                        break;
                    }
                    if let Ok(Err(e)) = rx.await {
                        let _ = err_tx.send(e);
                    }
                }
                ClientMessage::Hold { on } => {
                    let _ = cmds.send(Cmd::Hold { seat, on });
                }
                ClientMessage::Preview { revision, object } => {
                    // A preview is a convenience: one every 100 ms at most, the rest dropped.
                    let now = std::time::Instant::now();
                    if last_preview.is_some_and(|t| { now.duration_since(t) < std::time::Duration::from_millis(100)
                    }) {
                        continue;
                    }
                    last_preview = Some(now);
                    let (tx, rx) = oneshot::channel();
                    if cmds.send(Cmd::Preview { seat, object, reply: tx, }).is_err() {
                        break;
                    }
                    match rx.await {
                        Ok(Ok(sources)) => { let _ = note_tx.send(serde_json::json!({ "type": "preview", "revision": revision, "object": object, "sources": sources })); }
                        Ok(Err(error)) => { let _ = note_tx.send(serde_json::json!({ "type": "error", "message": error })); }
                        Err(_) => {}
                    }
                }
                ClientMessage::FullControl { on } => {
                    let _ = cmds.send(Cmd::FullControl { seat, on });
                }
                ClientMessage::Stops { stops } => {
                    let _ = cmds.send(Cmd::Stops { seat, stops: stops.map(clean_stops), });
                }
            }
        }
    });

    let mut first = true;
    loop {
        if !first {
            tokio::select! {
                changed = views.changed() => if changed.is_err() { break },
                Some(e) = err_rx.recv() => {
                    let msg = serde_json::json!({ "type": "error", "message": e }).to_string();
                    if sink.send(Message::Text(msg.into())).await.is_err() { break }
                    continue;
                }
                Some(note) = note_rx.recv() => {
                    if sink.send(Message::Text(note.to_string().into())).await.is_err() { break }
                    continue;
                }
            }
        }
        first = false;
        let snap = views.borrow_and_update().clone();
        let msg = if let Some(view) = snap.views.get(&you).or_else(|| snap.views.get(&None)) {
            view_message(&pool, view, you, &infos, &mut meta_cache).await
        } else if let Some(view) = snap.historical_views.get(&you).or_else(|| snap.historical_views.get(&None)) {
            history::view_message(&pool, view.clone(), you, &infos, &mut meta_cache).await.to_string()
        } else {
            continue;
        };
        if sink.send(Message::Text(msg.into())).await.is_err() {
            break;
        }
    }
    reader.abort();
}

// ── saved turn controls ────────────────────────────────────────────────────

/// A person's saved turn controls (`play_prefs`): their stops, full control and "Tap mana for me",
/// for every game.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PlayPrefs {
    pub(crate) stops: Option<Stops>,
    pub(crate) full_control: bool,
    #[serde(default)]
    pub(crate) tap_mana: PayMode,
}

/// The steps a stop can name (phase's names). Anything else a client sends is dropped.
const STEPS: &[&str] = &[
    "Untap", "Upkeep", "Draw", "PreCombatMain", "BeginCombat", "DeclareAttackers", "DeclareBlockers", "FirstStrikeDamage", "CombatDamage",
    "EndCombat", "PostCombatMain", "End", "Cleanup",
];

/// Stops with only the steps phase has.
fn clean_stops(mut s: Stops) -> Stops {
    s.own.retain(|p| STEPS.contains(&p.as_str()));
    s.others.retain(|p| STEPS.contains(&p.as_str()));
    s
}

pub(crate) async fn load_prefs(pool: &SqlitePool, user: &str) -> sqlx::Result<Option<PlayPrefs>> {
    let row: Option<(Option<String>, i64, Option<String>)> =
        sqlx::query_as("SELECT stops, full_control, tap_mana FROM play_prefs WHERE user_id = ?").bind(user).fetch_optional(pool).await?;
    Ok(row.map(|(stops, full, tap_mana)| PlayPrefs {
        // Unreadable stops fall back to the usual ones rather than failing the game.
        stops: stops.and_then(|s| serde_json::from_str::<Stops>(&s).ok()).map(clean_stops),
        full_control: full != 0,
        tap_mana: tap_mana.as_deref().and_then(PayMode::parse).unwrap_or_default(),
    }))
}

pub(crate) async fn save_prefs(pool: &SqlitePool, user: &str, prefs: &PlayPrefs) -> sqlx::Result<()> {
    let stops = prefs.stops.as_ref().map(|s| serde_json::to_string(s).unwrap_or_default());
    sqlx::query(
        "INSERT INTO play_prefs (user_id, stops, full_control, tap_mana, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET stops = excluded.stops, full_control = excluded.full_control, tap_mana = excluded.tap_mana,
           updated_at = excluded.updated_at",
    )
    .bind(user)
    .bind(stops)
    .bind(i64::from(prefs.full_control))
    // The usual setting is stored as NULL.
    .bind((prefs.tap_mana != PayMode::Ask).then(|| prefs.tap_mana.as_str()))
    .bind(now())
    .execute(pool)
    .await?;
    Ok(())
}

/// The seated people's saved turn controls, by seat. A seat whose settings can't be read gets
/// the usual ones.
async fn seat_prefs(pool: &SqlitePool, seats: &[SeatCfg]) -> HashMap<u8, PlayPrefs> {
    let mut out = HashMap::new();
    for s in seats.iter().filter(|s| s.kind == "human") {
        if let Some(user) = &s.user_id
            && let Ok(Some(p)) = load_prefs(pool, user).await
        {
            out.insert(s.seat, p);
        }
    }
    out
}

/// The board as it stands, over HTTP: for finished games (rebuilt from the replay log) and
/// anyone who can't hold a socket open. Same payload as a socket message.
async fn final_view(
    State(st): State<AppState>,
    Player(user): Player,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    if let Some(error) = st.play.game_error(&r) {
        return Err(AppError::Conflict(error));
    }
    let seats = r.seats();
    let you = seats.iter().find(|s| s.user_id.as_deref() == Some(user.id.as_str())).map(|s| s.seat);
    if let Some(live) = st.play.live(&id) {
        let snap = live.views.borrow().clone();
        if let Some(view) = snap.historical_views.get(&you).or_else(|| snap.historical_views.get(&None)) {
            let arts = commander_arts(&st.pool, seats.iter()).await?;
            let infos = serde_json::to_value(seat_infos(&seats, &HashMap::new(), &arts)).map_err(anyhow::Error::from)?;
            return Ok(Json(history::view_message(&st.pool, view.clone(), you, &infos, &mut HashMap::new()).await));
        }
    }
    let view = if let Some(live) = st.play.live(&id) {
        let snap = live.views.borrow().clone();
        snap.views.get(&you).or_else(|| snap.views.get(&None)).cloned().ok_or(AppError::NotFound("view"))?
    } else {
        let (replay, log): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT replay, log FROM online_games WHERE game_id = ?").bind(&id).fetch_one(&st.pool).await?;
        let replay = replay.ok_or(AppError::NotFound("game record"))?;
        if let Some(config) = st.play.historical_for(r.engine_version.as_deref()).cloned() {
            let child_seats = seats.clone();
            let view = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
                let mut worker = history::Worker::start(&config)?;
                worker.open(&config, replay, log, None, &child_seats)?;
                let v = worker.call(serde_json::json!({"op":"view","viewer":you}))?;
                Ok(v["view"].clone())
            })
            .await
            .map_err(anyhow::Error::from)?
            .map_err(|e| {
                if e.is::<history::Busy>() || e.is::<history::Retryable>() {
                    return AppError::Unavailable(e.to_string());
                }
                tracing::error!(game_id=%id,error=%e,"historical final board unavailable");
                let reason =
                    "The verified historical runtime or its data is unavailable for this final board. The game record is unchanged."
                        .to_string();
                st.play.unavailable.lock().unwrap().insert(id.clone(), reason.clone());
                AppError::Conflict(reason)
            })?;
            let arts = commander_arts(&st.pool, seats.iter()).await?;
            let infos = serde_json::to_value(seat_infos(&seats, &HashMap::new(), &arts)).map_err(anyhow::Error::from)?;
            return Ok(Json(history::view_message(&st.pool, view, you, &infos, &mut HashMap::new()).await));
        }
        let lines: Vec<yama_play::LogLine> = log.and_then(|l| serde_json::from_str(&l).ok()).unwrap_or_default();
        let engine = st.play.engine()?;
        let names: Vec<String> = seats.iter().map(|s| s.name.clone()).collect();
        let ai = ai_seats(&seats);
        // Rebuilding replays the whole game; keep it off the async threads and give it the big stack.
        let view = tokio::task::spawn_blocking(move || {
            std::thread::Builder::new()
                .stack_size(STACK)
                .spawn(move || -> anyhow::Result<View> {
                    let mut m = engine.resume(&replay, &ai)?;
                    m.set_names(names);
                    m.set_log_lines(lines);
                    // Finished games show everything; there's nothing left to hide.
                    Ok(m.view(you))
                })
                .expect("replay thread")
                .join()
                .map_err(|_| anyhow::anyhow!("replay thread panicked"))?
        })
        .await
        .map_err(anyhow::Error::from)??;
        view
    };
    let cards = card_meta(&st.pool, &view_names(&view), &mut HashMap::new()).await;
    let mut view = view;
    dress_pending(&mut view, &cards);
    let arts = commander_arts(&st.pool, seats.iter()).await?;
    Ok(Json(
        serde_json::json!({ "type": "view", "you": you, "seats": seat_infos(&seats, &HashMap::new(), &arts), "cards": cards, "view": view }),
    ))
}

#[cfg(test)]
#[path = "play_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "play_bench.rs"]
mod bench;
