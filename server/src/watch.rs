//! Watch the AIs play: games where every seat is a computer, run on the server and shown live to
//! the person who started them, with pause, speed, single steps and hands face up if they like.
//!
//! These games live only in memory. They never touch `online_games` or `games`, so they don't
//! appear in anyone's stats, recent games or playgroup records, and a server restart ends them.
//!
//! Each game runs on its own large-stack thread (as online games do) and drives its [`Match`] one
//! AI action at a time. After every action that changes something you can see (a card moves, a
//! life total changes, a new turn, a log line) it shows the board, then waits as long as the
//! chosen speed says. "Skip to the end" plays without waiting and shows the board a few times a
//! second. Nothing here is written to the replay log's database row, so contests a headless host
//! settles itself are fine (`Match::settle_ai_contest`).
//!
//! Limits, because every game holds a thread that can keep a core busy:
//! - unfinished games per account ([`MAX_WATCH_GAMES`]; [`OPEN_MAX_WATCH_GAMES`] for accounts
//!   without an invite) and for everyone together ([`MAX_WATCH_GAMES_ALL`],
//!   [`OPEN_MAX_WATCH_GAMES_ALL`] for accounts without an invite); admins are left out, as for
//!   online games;
//! - new games are rate-limited per account (`limits.rs`);
//! - the lab's per-turn loop guard ([`MAX_TURN_ACTIONS`]) and turn, action and CPU-time caps end a
//!   game that would otherwise run for ever;
//! - a game nobody is watching pauses after [`Timing::idle_pause`] and ends after
//!   [`Timing::idle_stop`]; a finished game's last board is kept for [`Timing::keep_finished`].
//!
//! Only the owner can see a game; anyone else gets "not found", like the rest of Yama.
//!
//! Seats are phase's heuristic AI. [`ExternalPilot`] is the hook for a seat played by something
//! else (an LLM): the game asks it first whenever its seat must decide, and phase's AI (which
//! every seat also has) answers when it doesn't. Nothing implements it yet, so a request for an
//! "llm" seat is refused.

use crate::auth::{CurrentUser, User};
use crate::decks::Board;
use crate::error::{AppError, AppResult};
use crate::play::{SeatCfg, card_meta, commander_arts, deck_for_seat, seat_infos, view_names};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use yama_play::lab::{MAX_TURN_ACTIONS, thread_cpu_secs};
use yama_play::{CardView, DeckLine, Decision, Difficulty, Match, PlayerView, StackView, View};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/watch", get(list).post(create))
        .route("/api/watch/{id}", get(detail).delete(remove))
        .route("/api/watch/{id}/stop", post(stop))
        .route("/api/watch/{id}/again", post(again))
        .route("/api/watch/{id}/ws", get(connect))
}

/// Unfinished watched games (playing or paused) one account may have.
pub const MAX_WATCH_GAMES: usize = 3;
/// The same for an account that joined without an invite.
pub const OPEN_MAX_WATCH_GAMES: usize = 1;
/// Unfinished watched games everyone but admins may have together.
pub const MAX_WATCH_GAMES_ALL: usize = 8;
/// Unfinished watched games all accounts without an invite may have together.
pub const OPEN_MAX_WATCH_GAMES_ALL: usize = 3;
/// Seats in a watched game.
pub const WATCH_SEATS: std::ops::RangeInclusive<usize> = 2..=4;
/// AI levels a seat may have (phase's labels).
pub const LEVELS: [&str; 3] = ["Easy", "Medium", "Hard"];

/// How fast the game moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Speed {
    #[serde(rename = "1x")]
    X1,
    #[serde(rename = "2x")]
    X2,
    #[serde(rename = "4x")]
    X4,
    /// No waiting: play to the end, showing the board a few times a second.
    #[serde(rename = "end")]
    End,
}

/// Durations and caps for watched games. Tests shrink them.
#[derive(Debug, Clone)]
pub struct Timing {
    /// Nobody watching this long: the game pauses.
    pub idle_pause: Duration,
    /// Nobody watching this long: the game ends.
    pub idle_stop: Duration,
    /// A finished game's last board stays this long after its last viewer leaves.
    pub keep_finished: Duration,
    /// The wait after each visible change at 1x, 2x and 4x.
    pub delays: [Duration; 3],
    /// At "skip to the end", how often the board is shown.
    pub slice: Duration,
    /// Actions looked through for a visible change before the board is shown anyway.
    pub step_actions: usize,
    pub max_turns: u32,
    pub max_actions: usize,
    /// AI actions within one turn before the game counts as a loop (the lab's guard).
    pub turn_action_cap: usize,
    /// CPU time the game's thread may use.
    pub max_cpu_secs: f64,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            idle_pause: Duration::from_secs(45),
            idle_stop: Duration::from_secs(10 * 60),
            keep_finished: Duration::from_secs(30 * 60),
            delays: [Duration::from_millis(1000), Duration::from_millis(450), Duration::from_millis(180)],
            slice: Duration::from_millis(300),
            step_actions: 400,
            max_turns: 60,
            max_actions: 60_000,
            turn_action_cap: MAX_TURN_ACTIONS,
            max_cpu_secs: 15.0 * 60.0,
        }
    }
}

impl Timing {
    fn delay(&self, speed: Speed) -> Duration {
        match speed {
            Speed::X1 => self.delays[0],
            Speed::X2 => self.delays[1],
            Speed::X4 => self.delays[2],
            Speed::End => Duration::ZERO,
        }
    }
}

/// Where a watched game stands, sent with every board.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Status {
    /// Playing (true) or paused by the viewer.
    pub playing: bool,
    pub speed: Speed,
    /// Hands face up.
    pub reveal: bool,
    /// Paused because nobody has been watching.
    pub idle: bool,
    /// AI actions so far.
    pub actions: usize,
    /// Why the game ended before anyone won: a limit, an error, or the viewer stopping it.
    pub stopped: Option<String>,
    /// No more moves: won, drawn or stopped.
    pub finished: bool,
}

/// One board and the game's state, as the game thread last published it.
pub struct Frame {
    pub view: View,
    pub status: Status,
}

/// What the viewer asks the game thread to do.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WatchCmd {
    Play,
    Pause,
    /// Play until the next visible change, then pause.
    Step,
    Speed(Speed),
    Reveal(bool),
    Stop,
}

/// Who is watching, and since when nobody is.
#[derive(Default)]
pub struct Presence {
    viewers: AtomicUsize,
    /// When the last viewer left (or the game started).
    since: Mutex<Option<Instant>>,
    /// The game thread has ended.
    finished: AtomicBool,
}

impl Presence {
    fn new() -> Self {
        Self { since: Mutex::new(Some(Instant::now())), ..Default::default() }
    }
    /// How long nobody has been watching (zero while someone is).
    fn idle_for(&self) -> Duration {
        if self.viewers.load(Ordering::SeqCst) > 0 {
            return Duration::ZERO;
        }
        self.since.lock().unwrap().map(|t| t.elapsed()).unwrap_or_default()
    }
    fn finished(&self) -> bool {
        self.finished.load(Ordering::SeqCst)
    }
}

/// A viewer's connection; leaving starts the idle clock when it was the last one.
struct Viewer(Arc<Presence>);

impl Viewer {
    fn join(p: &Arc<Presence>) -> Self {
        p.viewers.fetch_add(1, Ordering::SeqCst);
        Self(p.clone())
    }
}

impl Drop for Viewer {
    fn drop(&mut self) {
        if self.0.viewers.fetch_sub(1, Ordering::SeqCst) == 1 {
            *self.0.since.lock().unwrap() = Some(Instant::now());
        }
    }
}

// ── seats played by something else ─────────────────────────────────────────

/// A seat played by something other than phase's heuristic AI, such as an LLM. Asked first
/// whenever its seat must decide, with that seat's options and its own view of the board; it
/// answers with an option index. `None` (or an index the engine refuses) lets phase's AI decide
/// instead, so a slow or confused pilot never stalls the game. Nothing implements this yet.
pub trait ExternalPilot: Send {
    fn choose(&mut self, decision: &Decision, view: &View) -> Option<usize>;
}

// ── driving one game ───────────────────────────────────────────────────────

/// What one step did.
#[derive(Debug, PartialEq)]
pub enum Advance {
    Acted,
    /// Nobody can act and the game isn't over.
    Stuck(String),
}

/// A game the watch loop drives one action at a time; the engine in real games, a script in
/// tests.
pub trait Driver: Send {
    /// One action by whoever must act.
    fn advance(&mut self) -> Result<Advance, String>;
    /// The board for spectators, with every hand when `reveal`.
    fn view(&self, reveal: bool) -> View;
    fn turn(&self) -> u32;
    fn over(&self) -> bool;
}

struct EngineDriver {
    m: Match,
    pilots: HashMap<u8, Box<dyn ExternalPilot>>,
}

impl Driver for EngineDriver {
    fn advance(&mut self) -> Result<Advance, String> {
        for seat in self.m.waiting_on() {
            let Some(pilot) = self.pilots.get_mut(&seat) else { continue };
            let Some(d) = self.m.decision(seat) else { continue };
            let view = self.m.view(Some(seat));
            if let Some(i) = pilot.choose(&d, &view)
                && self.m.choose(seat, d.revision, i).is_ok()
            {
                return Ok(Advance::Acted);
            }
        }
        match self.m.run_ai(1) {
            Ok(n) if n > 0 => Ok(Advance::Acted),
            Ok(_) if self.m.settle_ai_contest() => Ok(Advance::Acted),
            Ok(_) => Ok(Advance::Stuck("no seat could act".into())),
            Err(e) => Err(format!("{e:#}")),
        }
    }
    fn view(&self, reveal: bool) -> View {
        if reveal { self.m.view_revealed() } else { self.m.view(None) }
    }
    fn turn(&self) -> u32 {
        self.m.turn()
    }
    fn over(&self) -> bool {
        self.m.is_over()
    }
}

/// What makes two boards look different to a viewer: cards, life, hands, the stack, the log and
/// the turn. Whose priority it is and the step alone don't count, so empty steps and rounds of
/// passing go by without a pause.
fn signature(v: &View) -> u64 {
    #[derive(Serialize)]
    struct Sig<'a> {
        turn: u32,
        players: &'a [PlayerView],
        battlefield: &'a [CardView],
        stack: &'a [StackView],
        command_zone: &'a [CardView],
        exile: &'a [CardView],
        hands: &'a BTreeMap<u8, Vec<CardView>>,
        log: usize,
        over: bool,
    }
    let sig = Sig {
        turn: v.turn,
        players: &v.players,
        battlefield: &v.battlefield,
        stack: &v.stack,
        command_zone: &v.command_zone,
        exile: &v.exile,
        hands: &v.hands,
        log: v.log.len(),
        over: v.over,
    };
    let mut h = DefaultHasher::new();
    serde_json::to_vec(&sig).unwrap_or_default().hash(&mut h);
    h.finish()
}

fn publish(out: &watch::Sender<Arc<Frame>>, view: View, status: &Status) {
    out.send_replace(Arc::new(Frame { view, status: status.clone() }));
}

/// Play a watched game until it ends, following the viewer's commands. Runs on the game's thread.
pub fn run(d: &mut dyn Driver, cmds: &Receiver<WatchCmd>, out: &watch::Sender<Arc<Frame>>, presence: &Presence, t: &Timing, mut status: Status) {
    let cpu_start = thread_cpu_secs();
    let mut last = signature(&d.view(status.reveal));
    let mut turn_seen = d.turn();
    let mut turn_actions = 0usize;
    let mut step = false;
    let mut due = Instant::now();
    publish(out, d.view(status.reveal), &status);
    let end = |status: &mut Status, why: Option<String>| {
        status.finished = true;
        status.playing = false;
        status.stopped = why;
    };
    'game: loop {
        // Commands: wait until the next move is due, or a while when nothing is moving.
        let moving = (status.playing && !status.idle) || step;
        let wait = if moving { due.saturating_duration_since(Instant::now()) } else { Duration::from_millis(250) };
        let mut got = Vec::new();
        match cmds.recv_timeout(wait) {
            Ok(c) => got.push(c),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                end(&mut status, Some("Stopped".into()));
                break 'game;
            }
        }
        got.extend(cmds.try_iter());
        let mut changed = false;
        for c in got {
            changed = true;
            match c {
                WatchCmd::Play => status.playing = true,
                WatchCmd::Pause => {
                    status.playing = false;
                    step = false;
                }
                WatchCmd::Step => {
                    status.playing = false;
                    step = true;
                }
                WatchCmd::Speed(s) => {
                    status.speed = s;
                    status.playing = true;
                }
                WatchCmd::Reveal(on) => status.reveal = on,
                WatchCmd::Stop => {
                    end(&mut status, Some("Stopped by you".into()));
                    break 'game;
                }
            }
            due = Instant::now();
        }

        let idle_for = presence.idle_for();
        if idle_for >= t.idle_stop {
            end(&mut status, Some(format!("Stopped after {} minutes with nobody watching", t.idle_stop.as_secs().div_ceil(60))));
            break 'game;
        }
        let idle = idle_for >= t.idle_pause;
        if idle != status.idle {
            status.idle = idle;
            changed = true;
        }
        // Show a command's effect at once (a paused game, hands face up), not after the next
        // move, which can take the AI a while.
        if changed {
            publish(out, d.view(status.reveal), &status);
        }
        let moving = (status.playing && !status.idle) || step;
        if !moving || Instant::now() < due {
            continue;
        }

        // Play until something visible changes, or for one slice at "skip to the end".
        let started = Instant::now();
        let mut looked = 0usize;
        let skipping = status.speed == Speed::End && !step;
        loop {
            if d.over() {
                end(&mut status, None);
                break 'game;
            }
            match d.advance() {
                Ok(Advance::Acted) => {}
                Ok(Advance::Stuck(why)) => {
                    end(&mut status, Some(format!("Stopped: {why}")));
                    break 'game;
                }
                Err(e) => {
                    end(&mut status, Some(format!("Stopped: the rules engine refused a move ({e})")));
                    break 'game;
                }
            }
            status.actions += 1;
            looked += 1;
            if d.turn() != turn_seen {
                turn_seen = d.turn();
                turn_actions = 0;
            }
            turn_actions += 1;
            if t.turn_action_cap > 0 && turn_actions >= t.turn_action_cap {
                end(&mut status, Some(format!("Stopped: one turn passed {} actions, so the AI or the rules engine is going round in circles", t.turn_action_cap)));
                break 'game;
            }
            if d.turn() > t.max_turns {
                end(&mut status, Some(format!("Stopped at turn {}, the limit for a watched game", t.max_turns)));
                break 'game;
            }
            if status.actions >= t.max_actions {
                end(&mut status, Some(format!("Stopped after {} actions, the limit for a watched game", t.max_actions)));
                break 'game;
            }
            if status.actions % 50 == 0
                && let (Some(start), Some(cpu)) = (cpu_start, thread_cpu_secs())
                && cpu - start >= t.max_cpu_secs
            {
                end(&mut status, Some(format!("Stopped: it used its {} minutes of computer time", (t.max_cpu_secs / 60.0).round())));
                break 'game;
            }
            if d.over() {
                end(&mut status, None);
                break 'game;
            }
            if skipping {
                if started.elapsed() >= t.slice {
                    break;
                }
                continue;
            }
            if signature(&d.view(status.reveal)) != last {
                break;
            }
            if looked >= t.step_actions {
                break;
            }
        }
        if step {
            step = false;
        }
        let view = d.view(status.reveal);
        last = signature(&view);
        publish(out, view, &status);
        due = Instant::now() + t.delay(status.speed);
    }
    publish(out, d.view(status.reveal), &status);
}

// ── the hub ────────────────────────────────────────────────────────────────

/// Every watched game on this server, in memory.
pub struct WatchHub {
    games: Mutex<HashMap<String, Arc<WatchGame>>>,
    timing: Timing,
}

impl Default for WatchHub {
    fn default() -> Self {
        Self::with_timing(Timing::default())
    }
}

/// A watched game: who owns it, its seats, and its line to the game thread.
pub struct WatchGame {
    pub id: String,
    owner: String,
    /// The owner had the smaller allowance when the game started.
    limited: bool,
    /// The owner was an admin (their games don't count toward the caps).
    admin: bool,
    created_at: String,
    seats: Vec<SeatCfg>,
    /// Cards each deck lost because the engine doesn't know them, by deck name.
    missing_cards: HashMap<String, Vec<String>>,
    /// The request that made it, for "Watch again".
    request: CreateRequest,
    cmds: Mutex<Sender<WatchCmd>>,
    frames: watch::Receiver<Arc<Frame>>,
    presence: Arc<Presence>,
}

impl WatchGame {
    fn send(&self, c: WatchCmd) {
        let _ = self.cmds.lock().unwrap().send(c);
    }
    fn unfinished(&self) -> bool {
        !self.presence.finished()
    }
}

impl WatchHub {
    pub fn with_timing(timing: Timing) -> Self {
        Self { games: Mutex::new(HashMap::new()), timing }
    }

    /// The game if `user` owns it; "not found" otherwise, so ids leak nothing.
    fn get(&self, id: &str, user: &str) -> AppResult<Arc<WatchGame>> {
        self.sweep();
        match self.games.lock().unwrap().get(id) {
            Some(g) if g.owner == user => Ok(g.clone()),
            _ => Err(AppError::NotFound("game")),
        }
    }

    fn mine(&self, user: &str) -> Vec<Arc<WatchGame>> {
        self.sweep();
        let mut out: Vec<Arc<WatchGame>> = self.games.lock().unwrap().values().filter(|g| g.owner == user).cloned().collect();
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        out
    }

    /// Refuse a new game that would take `user`, or everyone, past the caps on unfinished games.
    fn check_caps(&self, user: &User) -> AppResult<()> {
        if user.is_admin {
            return Ok(());
        }
        self.sweep();
        let games = self.games.lock().unwrap();
        let live = || games.values().filter(|g| g.unfinished() && !g.admin);
        let mine = live().filter(|g| g.owner == user.id).count();
        let cap = if user.limited { OPEN_MAX_WATCH_GAMES } else { MAX_WATCH_GAMES };
        if mine >= cap {
            return Err(AppError::Conflict(if cap == 1 {
                "You already have a game playing. Stop it or let it finish before starting another.".into()
            } else {
                format!("You have {mine} games playing. Stop one or let it finish before starting another.")
            }));
        }
        if live().count() >= MAX_WATCH_GAMES_ALL || (user.limited && live().filter(|g| g.limited).count() >= OPEN_MAX_WATCH_GAMES_ALL) {
            return Err(AppError::Conflict("The server is busy with other games right now. Try again later.".into()));
        }
        Ok(())
    }

    /// Forget finished games nobody has looked at for a while.
    fn sweep(&self) {
        let keep = self.timing.keep_finished;
        self.games.lock().unwrap().retain(|_, g| !g.presence.finished() || g.presence.idle_for() < keep);
    }

    fn remove(&self, id: &str) {
        self.games.lock().unwrap().remove(id);
    }

    /// Start a game on its own thread and keep it.
    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &self,
        user: &User,
        seats: Vec<SeatCfg>,
        missing_cards: HashMap<String, Vec<String>>,
        request: CreateRequest,
        mut driver: Box<dyn Driver>,
    ) -> Arc<WatchGame> {
        let id = new_id();
        let status = Status {
            playing: true,
            speed: request.speed.unwrap_or(Speed::X1),
            reveal: request.reveal.unwrap_or(false),
            idle: false,
            actions: 0,
            stopped: None,
            finished: false,
        };
        let first = Arc::new(Frame { view: driver.view(status.reveal), status: status.clone() });
        let (frame_tx, frame_rx) = watch::channel(first);
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        let presence = Arc::new(Presence::new());
        let game = Arc::new(WatchGame {
            id: id.clone(),
            owner: user.id.clone(),
            limited: user.limited,
            admin: user.is_admin,
            created_at: now(),
            seats,
            missing_cards,
            request,
            cmds: Mutex::new(cmd_tx),
            frames: frame_rx,
            presence: presence.clone(),
        });
        self.games.lock().unwrap().insert(id.clone(), game.clone());
        let timing = self.timing.clone();
        std::thread::Builder::new()
            .name(format!("watch-{}", &id[..8.min(id.len())]))
            .stack_size(crate::play::STACK)
            .spawn(move || {
                /// Marks the game finished however the thread ends.
                struct Done(Arc<Presence>);
                impl Drop for Done {
                    fn drop(&mut self) {
                        self.0.finished.store(true, Ordering::SeqCst);
                    }
                }
                let _done = Done(presence.clone());
                let played = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    run(driver.as_mut(), &cmd_rx, &frame_tx, &presence, &timing, status);
                }));
                if played.is_err() {
                    tracing::error!(game = %id, "watched game panicked");
                    let last = frame_tx.borrow().clone();
                    let status = Status {
                        finished: true,
                        playing: false,
                        stopped: Some("Stopped: the rules engine hit an error".into()),
                        ..last.status.clone()
                    };
                    frame_tx.send_replace(Arc::new(Frame { view: last.view.clone(), status }));
                }
            })
            .expect("watch thread");
        game
    }
}

// ── requests ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DeckRef {
    /// One of your decks (its current version).
    Deck { id: String },
    /// A precon from the lab's catalog.
    Precon { id: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum PilotRef {
    /// phase's heuristic AI at a level.
    Ai { difficulty: Option<String> },
    /// A seat played by an LLM ([`ExternalPilot`]); not available yet.
    Llm {},
}

#[derive(Debug, Clone, Deserialize)]
struct SeatRequest {
    deck: DeckRef,
    pilot: PilotRef,
}

#[derive(Debug, Clone, Deserialize)]
struct CreateRequest {
    seats: Vec<SeatRequest>,
    /// The seat (from 0, in the order given) that takes the first turn; the engine rolls when
    /// it's missing. The game numbers seats from the first player.
    first: Option<u8>,
    reveal: Option<bool>,
    speed: Option<Speed>,
}

/// A seat's deck, ready for the engine: its seat config and deck lines.
struct SeatDeck {
    cfg: SeatCfg,
    lines: Vec<(String, String, u32, bool)>,
}

async fn precon_seat(pool: &SqlitePool, seat: u8, id: &str, level: &str) -> AppResult<SeatDeck> {
    let (name, commanders, identity, cards): (String, String, String, String) =
        sqlx::query_as("SELECT name, commanders, color_identity, cards FROM precons WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?
            .ok_or(AppError::NotFound("precon"))?;
    let commanders: Vec<String> = serde_json::from_str(&commanders).unwrap_or_default();
    let cards: Vec<crate::lab::PreconCard> = serde_json::from_str(&cards).map_err(anyhow::Error::from)?;
    let commander = (!commanders.is_empty()).then(|| commanders.join(" and "));
    let lines = cards
        .into_iter()
        .filter(|c| c.board != Board::Side)
        .map(|c| (c.oracle_id.unwrap_or_default(), c.name, c.qty, c.board == Board::Commander))
        .collect();
    Ok(SeatDeck {
        cfg: SeatCfg {
            seat,
            kind: "ai".into(),
            user_id: None,
            name: commander.clone().unwrap_or_else(|| name.clone()),
            deck_id: Some(format!("precon:{id}")),
            deck_version_id: None,
            deck_name: Some(name),
            color_identity: identity,
            commander,
            difficulty: Some(level.into()),
            bracket: None,
        },
        lines,
    })
}

async fn own_seat(pool: &SqlitePool, user: &str, seat: u8, id: &str, level: &str) -> AppResult<SeatDeck> {
    let d = deck_for_seat(pool, user, id).await?;
    let cards = crate::decks::load_version_cards(pool, &d.version).await?;
    let lines = cards
        .into_iter()
        .filter(|c| c.board != Board::Side && c.qty > 0)
        .map(|c| (c.oracle_id, c.name, c.qty as u32, c.board == Board::Commander))
        .collect();
    Ok(SeatDeck {
        cfg: SeatCfg {
            seat,
            kind: "ai".into(),
            user_id: None,
            name: d.commander.clone().unwrap_or_else(|| "Computer".into()),
            deck_id: Some(id.into()),
            deck_version_id: Some(d.version),
            deck_name: Some(d.name),
            color_identity: d.identity,
            commander: d.commander,
            difficulty: Some(level.into()),
            bracket: d.bracket,
        },
        lines,
    })
}

/// Check a request, load its decks and start the game.
async fn start(st: &AppState, user: &User, body: CreateRequest) -> AppResult<Arc<WatchGame>> {
    st.limits.watch_creates.check_user(user)?;
    st.watch.check_caps(user)?;
    if !WATCH_SEATS.contains(&body.seats.len()) {
        return Err(AppError::bad("a watched game has 2 to 4 seats"));
    }
    if let Some(f) = body.first
        && usize::from(f) >= body.seats.len()
    {
        return Err(AppError::bad("the first player must be one of the seats"));
    }
    let mut seats = Vec::new();
    for (i, s) in body.seats.iter().enumerate() {
        let level = match &s.pilot {
            PilotRef::Ai { difficulty } => {
                let d = difficulty.as_deref().unwrap_or("Medium");
                *LEVELS.iter().find(|l| l.eq_ignore_ascii_case(d)).ok_or_else(|| AppError::bad(format!("seat {}: AI level {d:?}; use Easy, Medium or Hard", i + 1)))?
            }
            PilotRef::Llm {} => return Err(AppError::bad("LLM seats aren't available on this server yet")),
        };
        let seat = i as u8;
        seats.push(match &s.deck {
            DeckRef::Deck { id } => own_seat(&st.pool, &user.id, seat, id, level).await?,
            DeckRef::Precon { id } => precon_seat(&st.pool, seat, id, level).await?,
        });
    }
    // phase starts only seat 0 or 1 on request, so the first player becomes seat 0: the turn
    // order around the table is the same cycle.
    let first = body.first.map(|f| {
        seats.rotate_left(usize::from(f));
        for (i, s) in seats.iter_mut().enumerate() {
            s.cfg.seat = i as u8;
        }
        0
    });
    let engine = st.play.engine()?;
    let mut decks = Vec::new();
    let mut missing = HashMap::new();
    for s in &seats {
        let lines: Vec<DeckLine> = s.lines.iter().map(|(o, n, q, c)| DeckLine { oracle_id: o, name: n, qty: *q, commander: *c }).collect();
        let (deck, report) = engine.resolve_deck(&lines);
        if !report.missing.is_empty() {
            missing.insert(s.cfg.deck_name.clone().unwrap_or_default(), report.missing);
        }
        decks.push(deck);
    }
    let ai: Vec<(u8, Difficulty)> = seats.iter().map(|s| (s.cfg.seat, Difficulty::from_label(s.cfg.difficulty.as_deref().unwrap_or("Medium")))).collect();
    let seed: u64 = u64::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().unwrap());
    let mut m = engine.new_match_first(seed, decks, &ai, first).map_err(AppError::Other)?;
    m.set_names(seats.iter().map(|s| s.cfg.name.clone()).collect());
    // Nobody is playing, so a prompt the AI can't answer gets phase's fallback (as in the lab)
    // instead of stopping the game.
    m.set_ai_fallback(true);
    let cfgs = seats.into_iter().map(|s| s.cfg).collect();
    Ok(st.watch.spawn(user, cfgs, missing, body, Box::new(EngineDriver { m, pilots: HashMap::new() })))
}

// ── routes ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct Summary {
    id: String,
    created_at: String,
    seats: Vec<crate::play::SeatInfo>,
    status: Status,
    turn: u32,
    winner: Option<u8>,
    missing_cards: HashMap<String, Vec<String>>,
}

async fn summary(pool: &SqlitePool, g: &WatchGame) -> AppResult<Summary> {
    let frame = g.frames.borrow().clone();
    let arts = commander_arts(pool, g.seats.iter()).await?;
    Ok(Summary {
        id: g.id.clone(),
        created_at: g.created_at.clone(),
        seats: seat_infos(&g.seats, &HashMap::new(), &arts),
        status: status_of(g, &frame),
        turn: frame.view.turn,
        winner: frame.view.winner,
        missing_cards: g.missing_cards.clone(),
    })
}

/// The frame's status, marked finished if the game thread has ended without saying so.
fn status_of(g: &WatchGame, frame: &Frame) -> Status {
    let mut s = frame.status.clone();
    if g.presence.finished() && !s.finished {
        s.finished = true;
        s.playing = false;
        s.stopped.get_or_insert_with(|| "Stopped".into());
    }
    s
}

async fn list(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<Summary>>> {
    let mut out = Vec::new();
    for g in st.watch.mine(&user.id) {
        out.push(summary(&st.pool, &g).await?);
    }
    Ok(Json(out))
}

async fn create(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<CreateRequest>) -> AppResult<Json<serde_json::Value>> {
    let g = start(&st, &user, body).await?;
    Ok(Json(serde_json::json!({ "id": g.id })))
}

async fn again(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<serde_json::Value>> {
    let old = st.watch.get(&id, &user.id)?;
    let g = start(&st, &user, old.request.clone()).await?;
    Ok(Json(serde_json::json!({ "id": g.id })))
}

async fn detail(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Summary>> {
    let g = st.watch.get(&id, &user.id)?;
    Ok(Json(summary(&st.pool, &g).await?))
}

async fn stop(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    st.watch.get(&id, &user.id)?.send(WatchCmd::Stop);
    Ok(())
}

async fn remove(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    let g = st.watch.get(&id, &user.id)?;
    g.send(WatchCmd::Stop);
    st.watch.remove(&g.id);
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Play,
    Pause,
    Step,
    Speed { speed: Speed },
    Reveal { on: bool },
    Stop,
}

impl From<ClientMessage> for WatchCmd {
    fn from(m: ClientMessage) -> Self {
        match m {
            ClientMessage::Play => WatchCmd::Play,
            ClientMessage::Pause => WatchCmd::Pause,
            ClientMessage::Step => WatchCmd::Step,
            ClientMessage::Speed { speed } => WatchCmd::Speed(speed),
            ClientMessage::Reveal { on } => WatchCmd::Reveal(on),
            ClientMessage::Stop => WatchCmd::Stop,
        }
    }
}

async fn connect(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, ws: WebSocketUpgrade) -> AppResult<Response> {
    let g = st.watch.get(&id, &user.id)?;
    Ok(ws.on_upgrade(move |socket| stream(socket, st.pool.clone(), g)))
}

/// Send every new frame (the play socket's "view" message, with the game's status under
/// "watch") and pass the viewer's commands to the game thread.
async fn stream(socket: WebSocket, pool: SqlitePool, g: Arc<WatchGame>) {
    let _viewer = Viewer::join(&g.presence);
    let (mut sink, mut incoming) = socket.split();
    let mut frames = g.frames.clone();
    let arts = commander_arts(&pool, g.seats.iter()).await.unwrap_or_default();
    let infos = serde_json::to_value(seat_infos(&g.seats, &HashMap::new(), &arts)).unwrap_or_default();
    let mut cache = HashMap::new();
    let reader = {
        let g = g.clone();
        tokio::spawn(async move {
            while let Some(Ok(msg)) = incoming.next().await {
                let Message::Text(text) = msg else { continue };
                if let Ok(m) = serde_json::from_str::<ClientMessage>(&text) {
                    g.send(m.into());
                }
            }
        })
    };
    let mut first = true;
    loop {
        if !first && frames.changed().await.is_err() {
            break;
        }
        first = false;
        let frame = frames.borrow_and_update().clone();
        let cards = card_meta(&pool, &view_names(&frame.view), &mut cache).await;
        let msg = serde_json::json!({
            "type": "view",
            "you": null,
            "seats": infos,
            "cards": cards,
            "view": frame.view,
            "watch": status_of(&g, &frame),
        });
        if sink.send(Message::Text(msg.to_string().into())).await.is_err() {
            break;
        }
    }
    reader.abort();
}

#[cfg(test)]
#[path = "watch_tests.rs"]
mod tests;
