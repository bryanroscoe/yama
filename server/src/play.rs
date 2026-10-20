//! Online games on the rules engine: lobby, one game thread per live match, per-seat views
//! over WebSocket, and the replay log saved after every change.
//!
//! The engine and its AI are CPU-heavy and recurse deeply, so each live match runs on its own
//! OS thread with a 32 MiB stack (as phase does) and talks to the async side over channels.
//!
//! Because every unfinished game can hold a thread and its match in memory, anyone but an admin
//! may host at most [`MAX_OPEN_GAMES`] games that haven't finished (lobbies and live games), an
//! account that joined without an invite [`OPEN_MAX_OPEN_GAMES`], and such accounts together
//! [`OPEN_MAX_OPEN_GAMES_ALL`]. New games and join codes are rate-limited per account too
//! (`limits.rs`).

use crate::auth::{CurrentUser, User};
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
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{oneshot, watch};
use yama_play::{AttackAt, DeckLine, DeckSupport, Difficulty, Engine, Match, SeatDeck, Stops, View};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/play/status", get(status))
        .route("/api/play", get(list).post(create))
        .route("/api/play/join", post(join))
        .route("/api/play/{id}", get(detail))
        .route("/api/play/{id}/start", post(start))
        .route("/api/play/{id}/ws", get(connect))
        .route("/api/play/{id}/view", get(final_view))
        .route("/api/decks/{id}/online-support", get(online_support))
}

// ── engine and live games ──────────────────────────────────────────────────

enum EngineState {
    Disabled(String),
    Loading,
    Ready(Arc<Engine>),
    Failed(String),
}

pub struct PlayHub {
    engine: Mutex<EngineState>,
    live: Mutex<HashMap<String, LiveGame>>,
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
}

enum Cmd {
    Choose { seat: u8, revision: u64, index: usize, reply: oneshot::Sender<Result<(), String>> },
    /// Any legal set of attackers (the option list only holds the engine's sample).
    Attack { seat: u8, revision: u64, attacks: Vec<(u64, AttackAt)>, reply: oneshot::Sender<Result<(), String>> },
    /// Any legal set of blocks, as (blocker, attacker) pairs.
    Block { seat: u8, revision: u64, blocks: Vec<(u64, u64)>, reply: oneshot::Sender<Result<(), String>> },
    Concede { seat: u8 },
    /// Stop at every priority instead of only where it matters.
    FullControl { seat: u8, on: bool },
    /// The seat's own stops by step, or `None` for the default smart stops.
    Stops { seat: u8, stops: Option<Stops> },
}

const STACK: usize = 32 << 20;
const AI_BATCH: usize = 40;

impl PlayHub {
    /// Load the engine's card data in the background. Without it, online play is off.
    pub fn start(card_data: Option<std::path::PathBuf>, pool: SqlitePool) -> Arc<Self> {
        let hub = Arc::new(Self {
            engine: Mutex::new(EngineState::Loading),
            live: Mutex::new(HashMap::new()),
        });
        let Some(path) = card_data.filter(|p| p.exists()) else {
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
                match Engine::load(&path) {
                    Ok(engine) => {
                        tracing::info!(cards = engine.card_count(), secs = started.elapsed().as_secs_f32(), "rules engine ready");
                        *h.engine.lock().unwrap() = EngineState::Ready(Arc::new(engine));
                        rt.block_on(h.resume_live(&pool));
                    }
                    Err(e) => {
                        tracing::error!(error = %format!("{e:#}"), "rules engine failed to load");
                        *h.engine.lock().unwrap() = EngineState::Failed(format!("{e:#}"));
                    }
                }
            })
            .expect("engine loader thread");
        hub
    }

    fn engine(&self) -> AppResult<Arc<Engine>> {
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
        let rows: Vec<(String, String, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT game_id, seats, replay, log FROM online_games WHERE stage = 'live'")
                .fetch_all(pool)
                .await
                .unwrap_or_default();
        for (game_id, seats, replay, log) in rows {
            let (Ok(seats), Some(replay)) = (serde_json::from_str::<Vec<SeatCfg>>(&seats), replay) else { continue };
            let Ok(engine) = self.engine() else { return };
            match engine.resume(&replay, &ai_seats(&seats)) {
                Ok(mut m) => {
                    if let Some(lines) = log.and_then(|l| serde_json::from_str(&l).ok()) {
                        m.set_log_lines(lines);
                    }
                    self.spawn_game(game_id.clone(), m, seats, pool.clone());
                    tracing::info!(game_id, "resumed online game");
                }
                Err(e) => tracing::error!(game_id, error = %format!("{e:#}"), "couldn't resume online game"),
            }
        }
    }

    fn spawn_game(self: &Arc<Self>, game_id: String, m: Match, seats: Vec<SeatCfg>, pool: SqlitePool) {
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        let (view_tx, view_rx) = watch::channel(Arc::new(Snapshot::default()));
        self.live.lock().unwrap().insert(game_id.clone(), LiveGame { cmds: cmd_tx, views: view_rx });
        let hub = self.clone();
        let rt = tokio::runtime::Handle::current();
        std::thread::Builder::new()
            .name(format!("game-{}", &game_id[..8]))
            .stack_size(STACK)
            .spawn(move || {
                run_game(&game_id, m, &seats, cmd_rx, view_tx, &pool, &rt);
                hub.live.lock().unwrap().remove(&game_id);
            })
            .expect("game thread");
    }

    fn live(&self, game_id: &str) -> Option<LiveGame> {
        self.live.lock().unwrap().get(game_id).cloned()
    }
}

fn run_game(
    game_id: &str,
    mut m: Match,
    seats: &[SeatCfg],
    cmds: std::sync::mpsc::Receiver<Cmd>,
    views: watch::Sender<Arc<Snapshot>>,
    pool: &SqlitePool,
    rt: &tokio::runtime::Handle,
) {
    let publish = |m: &Match| {
        let mut snap = Snapshot::default();
        snap.views.insert(None, m.view(None));
        for s in seats {
            if s.kind == "human" {
                snap.views.insert(Some(s.seat), m.view(Some(s.seat)));
            }
        }
        let _ = views.send(Arc::new(snap));
    };
    let save = |m: &Match| {
        if let Err(e) = rt.block_on(persist(pool, game_id, m)) {
            tracing::error!(game_id, error = %e, "saving online game failed");
        }
    };
    let humans: Vec<u8> = seats.iter().filter(|s| s.kind == "human").map(|s| s.seat).collect();
    // Let the computer act, and pass for people who have nothing else they could do, until a
    // person has a real decision. Publish as it goes so the table can follow along.
    let mut full_control: std::collections::HashSet<u8> = std::collections::HashSet::new();
    let mut stops: HashMap<u8, Stops> = HashMap::new();
    let ai_turns = |m: &mut Match, full_control: &std::collections::HashSet<u8>, stops: &HashMap<u8, Stops>| loop {
        let passed = m.auto_pass(&humans, full_control, stops);
        match m.run_ai(AI_BATCH) {
            Ok(0) if passed == 0 => break,
            Ok(_) => {
                publish(m);
                save(m);
            }
            Err(e) => {
                tracing::error!(game_id, error = %format!("{e:#}"), "AI driver fault; game paused");
                break;
            }
        }
    };

    m.set_names(seats.iter().map(|s| s.name.clone()).collect());
    publish(&m);
    ai_turns(&mut m, &full_control, &stops);
    publish(&m);
    while !m.is_over() {
        let Ok(cmd) = cmds.recv() else { return };
        match cmd {
            Cmd::Choose { seat, revision, index, reply } => {
                let result = m.choose(seat, revision, index).map_err(|e| e.to_string());
                let ok = result.is_ok();
                let _ = reply.send(result);
                if ok {
                    // Pass for people with nothing to do first, so the board sent out doesn't
                    // flash a stop that would be passed a moment later.
                    m.auto_pass(&humans, &full_control, &stops);
                    publish(&m);
                    save(&m);
                    ai_turns(&mut m, &full_control, &stops);
                }
            }
            Cmd::Attack { seat, revision, attacks, reply } => {
                let result = m.declare_attackers(seat, revision, &attacks).map_err(|e| e.to_string());
                let ok = result.is_ok();
                let _ = reply.send(result);
                if ok {
                    // Pass for people with nothing to do first, so the board sent out doesn't
                    // flash a stop that would be passed a moment later.
                    m.auto_pass(&humans, &full_control, &stops);
                    publish(&m);
                    save(&m);
                    ai_turns(&mut m, &full_control, &stops);
                }
            }
            Cmd::Block { seat, revision, blocks, reply } => {
                let result = m.declare_blockers(seat, revision, &blocks).map_err(|e| e.to_string());
                let ok = result.is_ok();
                let _ = reply.send(result);
                if ok {
                    // Pass for people with nothing to do first, so the board sent out doesn't
                    // flash a stop that would be passed a moment later.
                    m.auto_pass(&humans, &full_control, &stops);
                    publish(&m);
                    save(&m);
                    ai_turns(&mut m, &full_control, &stops);
                }
            }
            Cmd::Concede { seat } => {
                if m.concede(seat).is_ok() {
                    publish(&m);
                    save(&m);
                    ai_turns(&mut m, &full_control, &stops);
                }
            }
            Cmd::FullControl { seat, on } => {
                if on {
                    full_control.insert(seat);
                } else {
                    full_control.remove(&seat);
                    ai_turns(&mut m, &full_control, &stops);
                }
            }
            // New stops apply from the next priority; the decision on screen stays put.
            Cmd::Stops { seat, stops: Some(s) } => {
                stops.insert(seat, s);
            }
            Cmd::Stops { seat, stops: None } => {
                stops.remove(&seat);
            }
        }
        publish(&m);
    }
    save(&m);
}

async fn persist(pool: &SqlitePool, game_id: &str, m: &Match) -> anyhow::Result<()> {
    let stage = if m.is_over() { "over" } else { "live" };
    sqlx::query("UPDATE online_games SET replay = ?, log = ?, revision = ?, stage = ?, updated_at = ? WHERE game_id = ?")
        .bind(m.replay_json())
        .bind(serde_json::to_string(m.log_lines())?)
        .bind(m.revision as i64)
        .bind(stage)
        .bind(now())
        .bind(game_id)
        .execute(pool)
        .await?;
    if m.is_over() {
        let view = m.view(None);
        let mut tx = pool.begin().await?;
        sqlx::query("UPDATE games SET status = 'finished', winner_seat = ?, turns = ?, ended_at = ?, first_seat = ? WHERE id = ?")
            .bind(m.winner().map(i64::from))
            .bind(i64::from(m.turn()))
            .bind(now())
            .bind(i64::from(m.starting_seat()))
            .bind(game_id)
            .execute(&mut *tx)
            .await?;
        for p in &view.players {
            sqlx::query("UPDATE game_seats SET final_life = ? WHERE game_id = ? AND seat = ?")
                .bind(i64::from(p.life))
                .bind(game_id)
                .bind(i64::from(p.seat))
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
    }
    Ok(())
}

// ── lobby ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SeatCfg {
    seat: u8,
    /// "human" or "ai"
    kind: String,
    user_id: Option<String>,
    name: String,
    deck_id: Option<String>,
    deck_version_id: Option<String>,
    deck_name: Option<String>,
    color_identity: String,
    commander: Option<String>,
    difficulty: Option<String>,
    /// The deck's declared bracket when it took the seat. Older lobbies lack it.
    #[serde(default)]
    bracket: Option<i64>,
}

fn ai_seats(seats: &[SeatCfg]) -> Vec<(u8, Difficulty)> {
    seats
        .iter()
        .filter(|s| s.kind == "ai")
        .map(|s| (s.seat, Difficulty::from_label(s.difficulty.as_deref().unwrap_or("Medium"))))
        .collect()
}

#[derive(Serialize)]
struct SeatInfo {
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
type Art = (Option<String>, Option<String>);

fn seat_infos(seats: &[SeatCfg], estimates: &HashMap<String, Estimated>, arts: &HashMap<String, Art>) -> Vec<SeatInfo> {
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
                ready: s.deck_version_id.is_some(),
                bracket: s.bracket,
                estimate: s.deck_version_id.as_ref().and_then(|v| estimates.get(v)).cloned(),
            }
        })
        .collect()
}

/// Art for every commander seated in these games, by the seat's commander name. Partners
/// ("A and B") show the first one's art, unless a single card has the whole name.
async fn commander_arts<'a>(pool: &SqlitePool, seats: impl Iterator<Item = &'a SeatCfg>) -> sqlx::Result<HashMap<String, Art>> {
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
    /// Deck name → cards the engine can't play yet (left out of the game).
    missing_cards: HashMap<String, Vec<String>>,
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
}

/// The columns a [`Row`] reads; `o` is online_games, `g` games, `p` playgroups.
const ROW_SELECT: &str = "SELECT o.game_id, o.code, o.host_id, o.stage, o.seats, o.created_at, o.updated_at, g.winner_seat, g.turns, p.name AS playgroup
     FROM online_games o LEFT JOIN games g ON g.id = o.game_id LEFT JOIN playgroups p ON p.id = g.playgroup_id";

impl Row {
    fn seats(&self) -> Vec<SeatCfg> {
        serde_json::from_str(&self.seats).unwrap_or_default()
    }
    fn status(&self) -> &'static str {
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
}

async fn status(State(st): State<AppState>, _u: CurrentUser) -> Json<Status> {
    match st.play.engine() {
        Ok(_) => Json(Status { enabled: true, reason: None }),
        Err(e) => Json(Status { enabled: false, reason: Some(e.to_string()) }),
    }
}

async fn list(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<OnlineGame>>> {
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
    Ok(Json(rows.iter().map(|r| summarize(r, &user.id, HashMap::new(), &estimates, &arts)).collect()))
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
        missing_cards,
    }
}

async fn detail(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<OnlineGame>> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    let mut missing = HashMap::new();
    if r.stage == "lobby" && let Ok(engine) = st.play.engine() {
        for s in r.seats() {
            if let (Some(v), Some(name)) = (&s.deck_version_id, &s.deck_name) {
                let (_, report) = resolve(&engine, &load_version_cards(&st.pool, v).await?);
                if !report.missing.is_empty() {
                    missing.insert(name.clone(), report.missing);
                }
            }
        }
    }
    let estimates = seat_estimates(&st.pool, &[&r]).await?;
    let arts = commander_arts(&st.pool, r.seats().iter()).await?;
    Ok(Json(summarize(&r, &user.id, missing, &estimates, &arts)))
}

fn deck_lines(cards: &[DeckCard]) -> Vec<DeckLine<'_>> {
    cards
        .iter()
        .filter(|c| c.board != Board::Side)
        .map(|c| DeckLine { oracle_id: &c.oracle_id, name: &c.name, qty: c.qty.max(0) as u32, commander: c.board == Board::Commander })
        .collect()
}

fn resolve(engine: &Engine, cards: &[DeckCard]) -> (SeatDeck, yama_play::DeckReport) {
    engine.resolve_deck(&deck_lines(cards))
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
async fn online_support(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<OnlineSupport>> {
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
struct SeatDeckInfo {
    version: String,
    name: String,
    commander: Option<String>,
    identity: String,
    bracket: Option<i64>,
}

/// A deck the user owns: its current version, name, commander, color identity and declared bracket.
async fn deck_for_seat(pool: &SqlitePool, owner: &str, deck_id: &str) -> AppResult<SeatDeckInfo> {
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
}

#[derive(Deserialize)]
struct CreateRequest {
    seats: Vec<SeatRequest>,
    /// Count the game in this playgroup's stats.
    playgroup_id: Option<String>,
}

/// Unfinished games (lobbies and live ones) anyone but an admin may host.
pub const MAX_OPEN_GAMES: i64 = 10;
/// The same for an account that joined without an invite.
pub const OPEN_MAX_OPEN_GAMES: i64 = 2;
/// Unfinished games all accounts without an invite may host together.
pub const OPEN_MAX_OPEN_GAMES_ALL: i64 = 20;

/// Refuse a new game that would take `user` past the limits on unfinished games they host.
async fn check_open_games(pool: &SqlitePool, user: &User) -> AppResult<()> {
    if user.is_admin {
        return Ok(());
    }
    let mine: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM online_games WHERE host_id = ? AND stage IN ('lobby','live')")
        .bind(&user.id)
        .fetch_one(pool)
        .await?;
    let cap = if user.limited { OPEN_MAX_OPEN_GAMES } else { MAX_OPEN_GAMES };
    if mine >= cap {
        return Err(AppError::Conflict(format!(
            "You have {mine} online games that haven't finished. Finish or concede one before starting another."
        )));
    }
    if user.limited {
        let all: i64 = sqlx::query_scalar(concat!(
            "SELECT COUNT(*) FROM online_games o JOIN users u ON u.id = o.host_id WHERE o.stage IN ('lobby','live') AND ",
            crate::auth::limited_sql!()
        ))
        .fetch_one(pool)
        .await?;
        if all >= OPEN_MAX_OPEN_GAMES_ALL {
            return Err(AppError::Conflict("Online play is busy right now. Try again later.".into()));
        }
    }
    Ok(())
}

async fn create(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(body): Json<CreateRequest>,
) -> AppResult<Json<serde_json::Value>> {
    st.limits.play_creates.check_user(&user)?;
    check_open_games(&st.pool, &user).await?;
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
    sqlx::query("INSERT INTO games (id, mode, playgroup_id, created_by, format, status, starting_life, started_at) VALUES (?, 'online', ?, ?, 'commander', 'in_progress', 40, ?)")
        .bind(&id)
        .bind(&body.playgroup_id)
        .bind(&user.id)
        .bind(&stamp)
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
    // With no friends to wait for, start right away.
    if !seats.iter().any(|s| s.kind == "human" && s.user_id.is_none()) {
        start_game(&st, &id, &user.id).await?;
    }
    Ok(Json(serde_json::json!({ "id": id })))
}

#[derive(Deserialize)]
struct JoinRequest {
    code: String,
    deck_id: String,
}

async fn join(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<JoinRequest>) -> AppResult<Json<serde_json::Value>> {
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

async fn start(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    start_game(&st, &id, &user.id).await
}

async fn start_game(st: &AppState, id: &str, user: &str) -> AppResult<()> {
    let r = load_row(&st.pool, id).await?;
    if r.host_id != user {
        return Err(AppError::Forbidden("only the host starts the game".into()));
    }
    if r.stage != "lobby" {
        return Ok(());
    }
    let seats = r.seats();
    if seats.iter().any(|s| s.deck_version_id.is_none()) {
        return Err(AppError::Conflict("every seat needs a player and a deck".into()));
    }
    let engine = st.play.engine()?;
    // Claim the lobby before building anything, so a double tap or a racing request can't
    // start two engines for one game. The seats must still be the ones we read.
    let claimed = sqlx::query("UPDATE online_games SET stage = 'live', updated_at = ? WHERE game_id = ? AND stage = 'lobby' AND seats = ?")
        .bind(now())
        .bind(id)
        .bind(&r.seats)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if claimed == 0 {
        return Ok(()); // someone else started it, or the seats just changed
    }
    let release = || async {
        let _ = sqlx::query("UPDATE online_games SET stage = 'lobby' WHERE game_id = ?").bind(id).execute(&st.pool).await;
    };
    let mut decks = Vec::new();
    for s in &seats {
        match load_version_cards(&st.pool, s.deck_version_id.as_deref().unwrap()).await {
            Ok(cards) => decks.push(resolve(&engine, &cards).0),
            Err(e) => {
                release().await;
                return Err(e);
            }
        }
    }
    let seed: u64 = u64::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..8].try_into().unwrap());
    let ai = ai_seats(&seats);
    let m = match engine.new_match(seed, decks, &ai) {
        Ok(m) => m,
        Err(e) => {
            release().await;
            return Err(AppError::Other(e));
        }
    };

    let mut tx = st.pool.begin().await?;
    sqlx::query("UPDATE games SET engine_version = ?, seed = ?, started_at = ? WHERE id = ?")
        .bind(yama_play::ENGINE_VERSION)
        .bind(seed as i64) // u64 stored bit-for-bit
        .bind(now())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for s in &seats {
        sqlx::query(
            "INSERT OR REPLACE INTO game_seats (game_id, seat, user_id, guest_name, ai_kind, deck_version_id, deck_label, commander_name)
             VALUES (?,?,?,?,?,?,?,?)",
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
        .bind(m.replay_json())
        .bind(now())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    st.play.spawn_game(id.to_string(), m, seats, st.pool.clone());
    Ok(())
}

// ── WebSocket ──────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Choose { revision: u64, index: usize },
    Attack { revision: u64, attacks: Vec<(u64, AttackAt)> },
    Block { revision: u64, blocks: Vec<(u64, u64)> },
    Concede,
    FullControl { on: bool },
    /// Your own stops by step; `null` goes back to the default smart stops.
    Stops { stops: Option<Stops> },
}

async fn connect(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, ws: WebSocketUpgrade) -> AppResult<Response> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    let seats = r.seats();
    let you = seats.iter().find(|s| s.user_id.as_deref() == Some(user.id.as_str())).map(|s| s.seat);
    let live = st.play.live(&id).ok_or_else(|| AppError::Conflict("that game isn't running".into()))?;
    Ok(ws.on_upgrade(move |socket| watch_game(socket, st.pool.clone(), live, you, seats)))
}

/// What the board needs to show a card readably: full-size image and rules text, by name.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
struct CardMeta {
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
}

/// Every card name the view shows (board, hand, stack, graveyards, exile, command zone).
fn view_names(view: &View) -> Vec<String> {
    let mut names: Vec<String> = view
        .battlefield
        .iter()
        .chain(&view.hand)
        .chain(&view.command_zone)
        .chain(&view.exile)
        .chain(view.players.iter().flat_map(|p| p.graveyard.iter()))
        .map(|c| c.name.clone())
        .chain(view.stack.iter().map(|s| s.name.clone()))
        .collect();
    names.sort();
    names.dedup();
    names
}

/// Look up card details by name, remembering answers (including "unknown") for this connection.
async fn card_meta(pool: &SqlitePool, names: &[String], cache: &mut HashMap<String, Option<CardMeta>>) -> HashMap<String, CardMeta> {
    for name in names {
        if cache.contains_key(name) {
            continue;
        }
        let meta: Option<CardMeta> = sqlx::query_as(
            "SELECT c.oracle_id, c.image_normal AS image, c.back_image_normal AS back_image, c.image_art_crop AS art, c.artist, c.mana_cost, c.type_line, c.oracle_text
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

async fn watch_game(socket: WebSocket, pool: SqlitePool, live: LiveGame, you: Option<u8>, seats: Vec<SeatCfg>) {
    let (mut sink, mut stream) = socket.split();
    let mut views = live.views.clone();
    let mut meta_cache: HashMap<String, Option<CardMeta>> = HashMap::new();
    let arts = commander_arts(&pool, seats.iter()).await.unwrap_or_default();
    let infos = serde_json::to_value(seat_infos(&seats, &HashMap::new(), &arts)).unwrap_or_default();
    let (err_tx, mut err_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Incoming choices go to the game thread; refusals come back as error messages.
    let cmds = live.cmds.clone();
    let reader = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let Message::Text(text) = msg else { continue };
            let (Some(seat), Ok(m)) = (you, serde_json::from_str::<ClientMessage>(&text)) else { continue };
            match m {
                ClientMessage::Choose { revision, index } => {
                    let (tx, rx) = oneshot::channel();
                    if cmds.send(Cmd::Choose { seat, revision, index, reply: tx }).is_err() {
                        break;
                    }
                    if let Ok(Err(e)) = rx.await {
                        let _ = err_tx.send(e);
                    }
                }
                ClientMessage::Attack { revision, attacks } => {
                    let (tx, rx) = oneshot::channel();
                    if cmds.send(Cmd::Attack { seat, revision, attacks, reply: tx }).is_err() {
                        break;
                    }
                    if let Ok(Err(e)) = rx.await {
                        let _ = err_tx.send(e);
                    }
                }
                ClientMessage::Block { revision, blocks } => {
                    let (tx, rx) = oneshot::channel();
                    if cmds.send(Cmd::Block { seat, revision, blocks, reply: tx }).is_err() {
                        break;
                    }
                    if let Ok(Err(e)) = rx.await {
                        let _ = err_tx.send(e);
                    }
                }
                ClientMessage::Concede => {
                    let _ = cmds.send(Cmd::Concede { seat });
                }
                ClientMessage::FullControl { on } => {
                    let _ = cmds.send(Cmd::FullControl { seat, on });
                }
                ClientMessage::Stops { stops } => {
                    let _ = cmds.send(Cmd::Stops { seat, stops });
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
            }
        }
        first = false;
        let snap = views.borrow_and_update().clone();
        let Some(view) = snap.views.get(&you).or_else(|| snap.views.get(&None)) else { continue };
        let cards = card_meta(&pool, &view_names(view), &mut meta_cache).await;
        let msg = serde_json::json!({ "type": "view", "you": you, "seats": infos, "cards": cards, "view": view });
        if sink.send(Message::Text(msg.to_string().into())).await.is_err() {
            break;
        }
    }
    reader.abort();
}

/// The board as it stands, over HTTP: for finished games (rebuilt from the replay log) and
/// anyone who can't hold a socket open. Same payload as a socket message.
async fn final_view(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<serde_json::Value>> {
    let r = load_visible(&st.pool, &id, &user.id).await?;
    let seats = r.seats();
    let you = seats.iter().find(|s| s.user_id.as_deref() == Some(user.id.as_str())).map(|s| s.seat);
    let view = if let Some(live) = st.play.live(&id) {
        let snap = live.views.borrow().clone();
        snap.views.get(&you).or_else(|| snap.views.get(&None)).cloned().ok_or(AppError::NotFound("view"))?
    } else {
        let (replay, log): (Option<String>, Option<String>) =
            sqlx::query_as("SELECT replay, log FROM online_games WHERE game_id = ?").bind(&id).fetch_one(&st.pool).await?;
        let lines: Vec<yama_play::LogLine> = log.and_then(|l| serde_json::from_str(&l).ok()).unwrap_or_default();
        let replay = replay.ok_or(AppError::NotFound("game record"))?;
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
    let arts = commander_arts(&st.pool, seats.iter()).await?;
    Ok(Json(serde_json::json!({ "type": "view", "you": you, "seats": seat_infos(&seats, &HashMap::new(), &arts), "cards": cards, "view": view })))
}
