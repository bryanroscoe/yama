//! Games played in person with the life counter (online games will share these tables).
//!
//! A phone can run a whole game offline and sync later, so creation takes a client-chosen ID
//! and events carry their own sequence numbers; replays of the same sync are harmless.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::playgroups::is_member;
use crate::routes::AppState;
use crate::util::now;
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/games", get(list).post(create))
        .route("/api/games/{id}", get(detail).delete(remove))
        .route("/api/games/{id}/events", post(append_events))
        .route("/api/games/{id}/finish", post(finish))
}

#[derive(Debug, Clone, Deserialize, Serialize, sqlx::FromRow)]
pub struct Seat {
    pub seat: i64,
    pub member_id: Option<String>,
    pub user_id: Option<String>,
    pub guest_name: Option<String>,
    pub ai_kind: Option<String>,
    pub deck_version_id: Option<String>,
    pub deck_label: Option<String>,
    pub commander_name: Option<String>,
    pub final_life: Option<i64>,
    pub eliminated_turn: Option<i64>,
    pub eliminated_by_seat: Option<i64>,
    #[sqlx(default)]
    #[serde(default)]
    pub fun: Option<i64>,
    #[sqlx(default)]
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Event {
    pub seq: i64,
    pub actor_seat: Option<i64>,
    pub kind: String,
    pub payload: serde_json::Value,
    pub created_at: Option<String>,
}

#[derive(Deserialize)]
struct NewGame {
    /// Client-generated UUID, so an offline phone can create the game and sync it later.
    id: String,
    playgroup_id: Option<String>,
    #[serde(default = "commander")]
    format: String,
    #[serde(default = "forty")]
    starting_life: i64,
    started_at: Option<String>,
    seats: Vec<Seat>,
    #[serde(default)]
    events: Vec<Event>,
    /// Set when logging a game that's already over (played without the app).
    finish: Option<Finish>,
    note: Option<String>,
}

fn commander() -> String {
    "commander".into()
}
fn forty() -> i64 {
    40
}

#[derive(Deserialize, Clone)]
struct Finish {
    winner_seat: Option<i64>,
    turns: Option<i64>,
    ended_at: Option<String>,
    /// The seat that took the first turn, if anyone said.
    first_seat: Option<i64>,
    /// How the winner won (crate::stats::WIN_CONDITIONS), if anyone said. Ignored for a draw.
    win_condition: Option<String>,
    #[serde(default)]
    seats: Vec<SeatResult>,
}

#[derive(Deserialize, Clone)]
struct SeatResult {
    seat: i64,
    final_life: Option<i64>,
    eliminated_turn: Option<i64>,
    eliminated_by_seat: Option<i64>,
    /// Fun rating, 1 to 5.
    fun: Option<i64>,
}

/// A time from the phone must be RFC 3339, as `Date.toISOString()` writes it. Stats order games
/// by these and the export copies them into every member's CSV, so nothing else gets stored.
fn check_time(t: Option<&str>, what: &str) -> AppResult<()> {
    match t {
        Some(t) if chrono::DateTime::parse_from_rfc3339(t).is_err() => Err(AppError::bad(format!("{what} isn't an RFC 3339 time"))),
        _ => Ok(()),
    }
}

/// Check a finish against the game's seats. Everything here comes from the phone's event log,
/// so the same finish arrives unchanged on every retry; a bad value is a bug worth a 400.
fn check_finish(f: &Finish, seats: &[i64]) -> AppResult<()> {
    check_time(f.ended_at.as_deref(), "ended_at")?;
    let is_seat = |s: Option<i64>| s.is_none_or(|s| seats.contains(&s));
    if !is_seat(f.winner_seat) {
        return Err(AppError::bad("the winner isn't one of the game's seats"));
    }
    if !is_seat(f.first_seat) {
        return Err(AppError::bad("the first player isn't one of the game's seats"));
    }
    if let Some(w) = &f.win_condition && !crate::stats::WIN_CONDITIONS.contains(&w.as_str()) {
        return Err(AppError::bad(format!("unknown win condition {w:?}")));
    }
    for s in &f.seats {
        if !seats.contains(&s.seat) {
            return Err(AppError::bad("a result names a seat that isn't in the game"));
        }
        if s.fun.is_some_and(|f| !(1..=5).contains(&f)) {
            return Err(AppError::bad("fun ratings go from 1 to 5"));
        }
    }
    Ok(())
}

async fn can_see(pool: &SqlitePool, game: &str, user: &str) -> AppResult<bool> {
    let row: Option<(String, Option<String>)> = sqlx::query_as("SELECT created_by, playgroup_id FROM games WHERE id = ?")
        .bind(game)
        .fetch_optional(pool)
        .await?;
    let Some((creator, group)) = row else { return Ok(false) };
    if creator == user {
        return Ok(true);
    }
    if let Some(g) = group && is_member(pool, &g, user).await? {
        return Ok(true);
    }
    let seated: Option<i64> = sqlx::query_scalar("SELECT seat FROM game_seats WHERE game_id = ? AND user_id = ? LIMIT 1")
        .bind(game)
        .bind(user)
        .fetch_optional(pool)
        .await?;
    Ok(seated.is_some())
}

async fn create(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(g): Json<NewGame>) -> AppResult<Json<serde_json::Value>> {
    Ok(Json(create_game(&st.pool, &user.id, g).await?))
}

/// A seat as it's stored, after the checks in `resolve_seat`.
#[derive(Debug, PartialEq, sqlx::FromRow)]
struct StoredSeat {
    seat: i64,
    member_id: Option<String>,
    user_id: Option<String>,
    guest_name: Option<String>,
    ai_kind: Option<String>,
    deck_version_id: Option<String>,
    deck_label: Option<String>,
    commander_name: Option<String>,
}

impl StoredSeat {
    /// Who sits in the seat: what a retry of the same game can't change.
    fn who(&self) -> (i64, Option<&str>, Option<&str>, Option<&str>, Option<&str>) {
        (self.seat, self.member_id.as_deref(), self.user_id.as_deref(), self.guest_name.as_deref(), self.ai_kind.as_deref())
    }
}

/// Decide what a seat sent by `user` stores. A seat can name a playgroup member (picking up their
/// account) or, without a playgroup, only the creator's own account. Anything else is recorded as
/// a guest name, so nobody can put games on someone else's record.
async fn resolve_seat(conn: &mut sqlx::SqliteConnection, user: &str, playgroup: Option<&str>, s: &Seat) -> AppResult<StoredSeat> {
    let member: Option<(Option<String>, Option<String>)> = match (&s.member_id, playgroup) {
        (Some(m), Some(pg)) => {
            let found: Option<(Option<String>, Option<String>)> =
                sqlx::query_as("SELECT user_id, guest_name FROM playgroup_members WHERE id = ? AND playgroup_id = ?")
                    .bind(m)
                    .bind(pg)
                    .fetch_optional(&mut *conn)
                    .await?;
            Some(found.ok_or_else(|| AppError::bad("that player isn't in this playgroup"))?)
        }
        (Some(_), None) => return Err(AppError::bad("a playgroup member needs the playgroup")),
        (None, _) => None,
    };
    let (member_user, member_guest) = member.unwrap_or_default();
    let account = match (member_user, &s.user_id) {
        (Some(u), _) => Some(u),
        (None, Some(u)) if *u == user => Some(u.clone()),
        _ => None,
    };
    // Whose deck versions a seat may hold:
    // - a seat with an account: that account's own decks;
    // - a guest seat (no account): the decks of the person logging the game, who lent one.
    // Anything else (another person's list, or a version that doesn't exist) is dropped rather
    // than refused, so a phone's offline game still uploads, and no game ever points at someone
    // else's version. A lent deck's games aren't its owner's results: results per version count
    // only seats where the owner played it themselves (stats: `own_deck`).
    let version_owner = account.as_deref().unwrap_or(user);
    let deck_version: Option<String> = match &s.deck_version_id {
        Some(v) => {
            sqlx::query_scalar("SELECT v.id FROM deck_versions v JOIN decks d ON d.id = v.deck_id WHERE v.id = ? AND d.owner_id = ?")
                .bind(v)
                .bind(version_owner)
                .fetch_optional(&mut *conn)
                .await?
        }
        None => None,
    };
    Ok(StoredSeat {
        seat: s.seat,
        member_id: if playgroup.is_some() { s.member_id.clone() } else { None },
        // A guest member's name is kept on the seat too, so the game still names them if they're
        // removed from the playgroup later.
        guest_name: if account.is_none() { s.guest_name.clone().or(member_guest).or(s.display_name.clone()) } else { s.guest_name.clone() },
        user_id: account,
        ai_kind: s.ai_kind.clone(),
        deck_version_id: deck_version,
        deck_label: s.deck_label.clone(),
        commander_name: s.commander_name.clone(),
    })
}

async fn insert_seats(conn: &mut sqlx::SqliteConnection, game: &str, seats: &[StoredSeat]) -> AppResult<()> {
    for s in seats {
        sqlx::query(
            "INSERT INTO game_seats (game_id, seat, member_id, user_id, guest_name, ai_kind, deck_version_id, deck_label, commander_name)
             VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(game)
        .bind(s.seat)
        .bind(&s.member_id)
        .bind(&s.user_id)
        .bind(&s.guest_name)
        .bind(&s.ai_kind)
        .bind(&s.deck_version_id)
        .bind(&s.deck_label)
        .bind(&s.commander_name)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Create an in-person game (and finish it, for a game logged afterwards). Sending the same game
/// again is safe, so an offline phone can retry:
///
/// - A table game's retry must name the same players in the same seats. If it doesn't, its
///   finish is numbered against a different game, so it's refused (409) rather than crediting
///   the wrong player.
/// - A logged game (a finish and no table events, from Log a game) is only what the form said, so
///   saving it again stores what the form says now. That covers a Save whose answer was lost
///   and an edit made before saving again.
/// - Online games are written by the rules engine alone; their ids are refused here.
async fn create_game(pool: &SqlitePool, user: &str, g: NewGame) -> AppResult<serde_json::Value> {
    if uuid::Uuid::parse_str(&g.id).is_err() {
        return Err(AppError::bad("game id must be a UUID"));
    }
    if g.seats.is_empty() || g.seats.len() > 10 {
        return Err(AppError::bad("a game needs 1 to 10 seats"));
    }
    let seat_numbers: Vec<i64> = g.seats.iter().map(|s| s.seat).collect();
    if seat_numbers.iter().enumerate().any(|(i, n)| seat_numbers[..i].contains(n)) {
        return Err(AppError::bad("each seat number can appear once"));
    }
    check_time(g.started_at.as_deref(), "started_at")?;
    if let Some(f) = &g.finish {
        check_finish(f, &seat_numbers)?;
    }
    if let Some(pg) = &g.playgroup_id && !is_member(pool, pg, user).await? {
        return Err(AppError::NotFound("playgroup"));
    }
    let mut tx = pool.begin().await?;
    let mut seats = Vec::with_capacity(g.seats.len());
    for s in &g.seats {
        seats.push(resolve_seat(&mut tx, user, g.playgroup_id.as_deref(), s).await?);
    }
    let found: Option<(String, String, Option<String>)> = sqlx::query_as("SELECT created_by, mode, playgroup_id FROM games WHERE id = ?")
        .bind(&g.id)
        .fetch_optional(&mut *tx)
        .await?;
    let existing = match found {
        None => {
            sqlx::query(
                "INSERT INTO games (id, mode, playgroup_id, created_by, format, status, starting_life, started_at, note)
                 VALUES (?, 'in_person', ?, ?, ?, 'in_progress', ?, ?, ?)",
            )
            .bind(&g.id)
            .bind(&g.playgroup_id)
            .bind(user)
            .bind(&g.format)
            .bind(g.starting_life)
            .bind(g.started_at.clone().unwrap_or_else(now))
            .bind(&g.note)
            .execute(&mut *tx)
            .await?;
            insert_seats(&mut tx, &g.id, &seats).await?;
            insert_events(&mut tx, &g.id, &g.events).await?;
            false
        }
        Some((by, mode, stored_group)) if by == user && mode == "in_person" => {
            let has_events: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM game_events WHERE game_id = ?)").bind(&g.id).fetch_one(&mut *tx).await?;
            if g.finish.is_some() && g.events.is_empty() && !has_events {
                sqlx::query("UPDATE games SET playgroup_id = ?, format = ?, starting_life = ?, started_at = COALESCE(?, started_at), note = ? WHERE id = ?")
                    .bind(&g.playgroup_id)
                    .bind(&g.format)
                    .bind(g.starting_life)
                    .bind(&g.started_at)
                    .bind(&g.note)
                    .bind(&g.id)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query("DELETE FROM game_seats WHERE game_id = ?").bind(&g.id).execute(&mut *tx).await?;
                insert_seats(&mut tx, &g.id, &seats).await?;
            } else {
                let stored: Vec<StoredSeat> = sqlx::query_as(
                    "SELECT seat, member_id, user_id, guest_name, ai_kind, deck_version_id, deck_label, commander_name
                     FROM game_seats WHERE game_id = ? ORDER BY seat",
                )
                .bind(&g.id)
                .fetch_all(&mut *tx)
                .await?;
                let mut sent: Vec<&StoredSeat> = seats.iter().collect();
                sent.sort_by_key(|s| s.seat);
                if stored_group != g.playgroup_id || !stored.iter().map(StoredSeat::who).eq(sent.iter().map(|s| s.who())) {
                    return Err(AppError::Conflict("this game was already saved with different players".into()));
                }
                // The same players, but a seat may have changed commanders mid-game: keep the newest,
                // and the deck it's playing now (checked against its owner by resolve_seat; none
                // once it isn't the deck it started with).
                for s in &sent {
                    sqlx::query("UPDATE game_seats SET deck_label = ?, commander_name = ?, deck_version_id = ? WHERE game_id = ? AND seat = ?")
                        .bind(&s.deck_label)
                        .bind(&s.commander_name)
                        .bind(&s.deck_version_id)
                        .bind(&g.id)
                        .bind(s.seat)
                        .execute(&mut *tx)
                        .await?;
                }
                insert_events(&mut tx, &g.id, &g.events).await?;
            }
            true
        }
        // Someone else's game, or an online one.
        Some(_) => return Err(AppError::Conflict("game id already used".into())),
    };
    if let Some(f) = g.finish {
        finish_in(&mut tx, &g.id, f).await?;
    }
    tx.commit().await?;
    Ok(serde_json::json!({ "id": g.id, "existing": existing }))
}

async fn insert_events(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, game: &str, events: &[Event]) -> AppResult<u64> {
    let mut n = 0;
    for e in events {
        let added = sqlx::query(
            "INSERT INTO game_events (game_id, seq, actor_seat, kind, payload, created_at) VALUES (?,?,?,?,?,?)
             ON CONFLICT(game_id, seq) DO NOTHING",
        )
        .bind(game)
        .bind(e.seq)
        .bind(e.actor_seat)
        .bind(&e.kind)
        .bind(e.payload.to_string())
        .bind(e.created_at.clone().unwrap_or_else(now))
        .execute(&mut **tx)
        .await?
        .rows_affected();
        if added == 0 {
            // A retry sends exactly what it sent before (the phone freezes events once handed to
            // an upload). A different event under the same number means a second device is
            // keeping this game too: refuse it rather than drop its taps without a word.
            let (kind, payload, created_at): (String, String, String) = sqlx::query_as("SELECT kind, payload, created_at FROM game_events WHERE game_id = ? AND seq = ?")
                .bind(game)
                .bind(e.seq)
                .fetch_one(&mut **tx)
                .await?;
            // The time travels with the event, so two devices making the same tap under the same
            // number (both "life -1") still differ, and only an exact resend is a retry.
            let same = kind == e.kind
                && serde_json::from_str::<serde_json::Value>(&payload).ok().as_ref() == Some(&e.payload)
                && e.created_at.as_ref().is_none_or(|t| *t == created_at);
            if !same {
                return Err(AppError::Conflict(
                    "another device already saved different changes to this game. Keep the game going on one device".into(),
                ));
            }
        }
        n += added;
    }
    Ok(n)
}

/// A game logged after it was played (Log a game): finished, with no table events. Only those
/// can be saved again with different players (`create_game`).
fn is_logged(game: &GameRow, events: &[Event]) -> bool {
    game.mode == "in_person" && game.status == "finished" && events.is_empty()
}

/// Only the phone that created an in-person game writes to it. Online games are written by
/// the rules engine alone.
async fn can_write(pool: &SqlitePool, game: &str, user: &str) -> AppResult<bool> {
    let row: Option<(String, String)> = sqlx::query_as("SELECT created_by, mode FROM games WHERE id = ?")
        .bind(game)
        .fetch_optional(pool)
        .await?;
    Ok(matches!(row, Some((by, mode)) if by == user && mode == "in_person"))
}

async fn append_events(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(events): Json<Vec<Event>>,
) -> AppResult<Json<serde_json::Value>> {
    if !can_write(&st.pool, &id, &user.id).await? {
        return Err(AppError::NotFound("game"));
    }
    let mut tx = st.pool.begin().await?;
    let added = insert_events(&mut tx, &id, &events).await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "added": added })))
}

async fn finish(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(f): Json<Finish>,
) -> AppResult<()> {
    finish_as(&st.pool, &id, &user.id, f).await
}

async fn finish_as(pool: &SqlitePool, id: &str, user: &str, f: Finish) -> AppResult<()> {
    if !can_write(pool, id, user).await? {
        return Err(AppError::NotFound("game"));
    }
    let seats: Vec<i64> = sqlx::query_scalar("SELECT seat FROM game_seats WHERE game_id = ?").bind(id).fetch_all(pool).await?;
    check_finish(&f, &seats)?;
    let mut tx = pool.begin().await?;
    finish_in(&mut tx, id, f).await?;
    tx.commit().await?;
    Ok(())
}

/// Store a checked finish. Setting the same values again is harmless, so a retried finish
/// changes nothing.
async fn finish_in(conn: &mut sqlx::SqliteConnection, id: &str, f: Finish) -> AppResult<()> {
    sqlx::query(
        "UPDATE games SET status = 'finished', winner_seat = ?, turns = ?, ended_at = ?, first_seat = ?, win_condition = ? WHERE id = ?",
    )
    .bind(f.winner_seat)
    .bind(f.turns)
    .bind(f.ended_at.unwrap_or_else(now))
    .bind(f.first_seat)
    .bind(if f.winner_seat.is_some() { f.win_condition } else { None })
    .bind(id)
    .execute(&mut *conn)
    .await?;
    for s in f.seats {
        sqlx::query(
            "UPDATE game_seats SET final_life = ?, eliminated_turn = ?, eliminated_by_seat = ?, fun = ? WHERE game_id = ? AND seat = ?",
        )
        .bind(s.final_life)
        .bind(s.eliminated_turn)
        .bind(s.eliminated_by_seat)
        .bind(s.fun)
        .bind(id)
        .bind(s.seat)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

#[derive(Serialize, sqlx::FromRow)]
struct GameRow {
    id: String,
    mode: String,
    playgroup_id: Option<String>,
    format: String,
    status: String,
    starting_life: i64,
    started_at: String,
    ended_at: Option<String>,
    turns: Option<i64>,
    winner_seat: Option<i64>,
    first_seat: Option<i64>,
    win_condition: Option<String>,
    note: Option<String>,
    #[sqlx(skip)]
    seats: Vec<Seat>,
}

const GAME_COLUMNS: &str =
    "g.id, g.mode, g.playgroup_id, g.format, g.status, g.starting_life, g.started_at, g.ended_at, g.turns, g.winner_seat, g.first_seat, g.win_condition, g.note";

async fn seats(pool: &SqlitePool, game: &str) -> AppResult<Vec<Seat>> {
    Ok(sqlx::query_as(
        "SELECT s.seat, s.member_id, s.user_id, s.guest_name, s.ai_kind, s.deck_version_id, s.deck_label, s.commander_name,
                s.final_life, s.eliminated_turn, s.eliminated_by_seat, s.fun,
                COALESCE(u.display_name, s.guest_name, m.guest_name, s.ai_kind) AS display_name
         FROM game_seats s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN playgroup_members m ON m.id = s.member_id
         WHERE s.game_id = ? ORDER BY s.seat",
    )
    .bind(game)
    .fetch_all(pool)
    .await?)
}

#[derive(Deserialize)]
struct ListParams {
    playgroup: Option<String>,
}

async fn list(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(p): Query<ListParams>) -> AppResult<Json<Vec<GameRow>>> {
    let mut games: Vec<GameRow> = match &p.playgroup {
        Some(pg) => {
            if !is_member(&st.pool, pg, &user.id).await? {
                return Err(AppError::NotFound("playgroup"));
            }
            sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT {GAME_COLUMNS} FROM games g WHERE g.playgroup_id = ? ORDER BY g.started_at DESC LIMIT 200"
            )))
            .bind(pg)
            .fetch_all(&st.pool)
            .await?
        }
        None => sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "SELECT DISTINCT {GAME_COLUMNS} FROM games g LEFT JOIN game_seats s ON s.game_id = g.id
             WHERE g.created_by = ? OR s.user_id = ? ORDER BY g.started_at DESC LIMIT 200"
        )))
        .bind(&user.id)
        .bind(&user.id)
        .fetch_all(&st.pool)
        .await?,
    };
    for g in &mut games {
        g.seats = seats(&st.pool, &g.id).await?;
    }
    Ok(Json(games))
}

#[derive(Serialize)]
struct GameDetail {
    #[serde(flatten)]
    game: GameRow,
    events: Vec<Event>,
    /// This account started this in-person game, so it can carry on with it on another device.
    can_continue: bool,
    /// A game this account logged after it was played: Log a game can open it again, and saving
    /// it again stores what the form says now (`create_game`).
    can_edit: bool,
    /// Seat number to deck id, for seats that played one of this account's own decks (so editing
    /// can name it); never anyone else's deck.
    your_decks: std::collections::BTreeMap<i64, String>,
}

async fn detail(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<GameDetail>> {
    if !can_see(&st.pool, &id, &user.id).await? {
        return Err(AppError::NotFound("game"));
    }
    let mut game: GameRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {GAME_COLUMNS} FROM games g WHERE g.id = ?")))
        .bind(&id)
        .fetch_one(&st.pool)
        .await?;
    game.seats = seats(&st.pool, &id).await?;
    let rows: Vec<(i64, Option<i64>, String, String, String)> =
        sqlx::query_as("SELECT seq, actor_seat, kind, payload, created_at FROM game_events WHERE game_id = ? ORDER BY seq")
            .bind(&id)
            .fetch_all(&st.pool)
            .await?;
    let events = rows
        .into_iter()
        .map(|(seq, actor_seat, kind, payload, created_at)| Event {
            seq,
            actor_seat,
            kind,
            payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
            created_at: Some(created_at),
        })
        .collect();
    let mine = can_write(&st.pool, &id, &user.id).await?;
    let can_continue = game.status == "in_progress" && mine;
    let can_edit = mine && is_logged(&game, &events);
    let mut your_decks = std::collections::BTreeMap::new();
    for s in &game.seats {
        if let Some(v) = &s.deck_version_id {
            let deck: Option<String> = sqlx::query_scalar("SELECT d.id FROM deck_versions v JOIN decks d ON d.id = v.deck_id WHERE v.id = ? AND d.owner_id = ?")
                .bind(v)
                .bind(&user.id)
                .fetch_optional(&st.pool)
                .await?;
            if let Some(d) = deck {
                your_decks.insert(s.seat, d);
            }
        }
    }
    Ok(Json(GameDetail { game, events, can_continue, can_edit, your_decks }))
}

async fn remove(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    let n = sqlx::query("DELETE FROM games WHERE id = ? AND created_by = ? AND mode = 'in_person'")
        .bind(&id)
        .bind(&user.id)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if n == 0 { Err(AppError::NotFound("game")) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn setup() -> SqlitePool {
        let pool = crate::db::test_pool().await;
        for (id, email, name) in [("me", "me@x.y", "Bryan"), ("sam", "sam@x.y", "Sam")] {
            sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES (?,?,?,'2026-10-01T00:00:00Z')")
                .bind(id)
                .bind(email)
                .bind(name)
                .execute(&pool)
                .await
                .unwrap();
        }
        for (deck, owner, version) in [("d-me", "me", "v-me"), ("d-sam", "sam", "v-sam")] {
            sqlx::query("INSERT INTO decks (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,'t','t')")
                .bind(deck)
                .bind(owner)
                .bind(format!("{owner}'s deck"))
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO deck_versions (id, deck_id, cards, created_at) VALUES (?,?,'[]','2026-10-01T00:00:00Z')")
                .bind(version)
                .bind(deck)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    fn new_game(id: &str, finish: Option<serde_json::Value>) -> NewGame {
        serde_json::from_value(json!({
            "id": id,
            "started_at": "2026-10-18T01:00:00Z",
            "seats": [
                { "seat": 0, "user_id": "me", "deck_version_id": "v-me" },
                // Sam's deck version on a guest seat isn't kept: a guest seat can only hold a deck
                // the person logging the game lent, and that's "me", not Sam.
                { "seat": 1, "guest_name": "Sam", "deck_version_id": "v-sam" },
                { "seat": 2, "guest_name": "Alex" },
            ],
            "finish": finish,
        }))
        .unwrap()
    }

    fn finish(v: serde_json::Value) -> Finish {
        serde_json::from_value(v).unwrap()
    }

    #[tokio::test]
    async fn finish_records_first_seat_win_condition_and_fun_and_retries_change_nothing() {
        let pool = setup().await;
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0001";
        create_game(&pool, "me", new_game(id, None)).await.unwrap();
        let body = json!({
            "winner_seat": 1, "turns": 9, "ended_at": "2026-10-18T03:00:00Z", "first_seat": 2, "win_condition": "commander_damage",
            "seats": [
                { "seat": 0, "final_life": 0, "eliminated_turn": 7, "eliminated_by_seat": 1, "fun": 4 },
                { "seat": 1, "final_life": 12, "eliminated_turn": null, "eliminated_by_seat": null, "fun": 5 },
                { "seat": 2, "final_life": 3, "eliminated_turn": null, "eliminated_by_seat": null, "fun": null },
            ],
        });
        finish_as(&pool, id, "me", finish(body.clone())).await.unwrap();
        finish_as(&pool, id, "me", finish(body)).await.unwrap(); // a retry from the phone

        let games = crate::stats::finished_games(&pool, crate::stats::Scope::User("me")).await.unwrap();
        assert_eq!(games.len(), 1);
        let g = &games[0];
        assert_eq!((g.first_seat, g.winner_seat, g.win_condition.as_deref()), (Some(2), Some(1), Some("commander_damage")));
        assert_eq!(g.seats.iter().map(|s| s.fun).collect::<Vec<_>>(), vec![Some(4), Some(5), None]);
        assert_eq!(g.seats[0].eliminated_by_seat, Some(1));
        assert_eq!(g.seats[0].name, "Bryan");
        assert_eq!(g.seats[0].key, "u:me");
        // My version on my seat is kept; Sam's on a guest seat isn't.
        assert_eq!(g.seats[0].deck_version_id.as_deref(), Some("v-me"));
        assert_eq!(g.seats[1].deck_version_id, None);

        // The deck's results see the game; Sam's deck doesn't.
        let mine = crate::stats::finished_games(&pool, crate::stats::Scope::Deck("d-me")).await.unwrap();
        assert_eq!(crate::stats::results_by_version(&mine)["v-me"], crate::stats::Record { games: 1, wins: 0, losses: 1, draws: 0 });
        assert!(crate::stats::finished_games(&pool, crate::stats::Scope::Deck("d-sam")).await.unwrap().is_empty());
        // Sam didn't sit in it with an account, so it isn't on Sam's record.
        assert!(crate::stats::finished_games(&pool, crate::stats::Scope::User("sam")).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_deck_lent_to_a_guest_stays_on_the_seat_but_isnt_the_owners_result() {
        let pool = setup().await;
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0010";
        let g: NewGame = serde_json::from_value(json!({
            "id": id,
            "started_at": "2026-10-18T01:00:00Z",
            "seats": [
                { "seat": 0, "user_id": "me", "deck_version_id": "v-me" },
                // I lent Alex my deck for the game.
                { "seat": 1, "guest_name": "Alex", "deck_version_id": "v-me" },
            ],
            "finish": { "winner_seat": 1, "seats": [] },
        }))
        .unwrap();
        create_game(&pool, "me", g).await.unwrap();
        let versions: Vec<Option<String>> =
            sqlx::query_scalar("SELECT deck_version_id FROM game_seats WHERE game_id = ? ORDER BY seat").bind(id).fetch_all(&pool).await.unwrap();
        assert_eq!(versions, vec![Some("v-me".to_string()), Some("v-me".to_string())]);

        // The deck's record is my own seat's game only: Alex winning with it isn't my win.
        let games = crate::stats::finished_games(&pool, crate::stats::Scope::Deck("d-me")).await.unwrap();
        assert_eq!(crate::stats::results_by_version(&games)["v-me"], crate::stats::Record { games: 1, wins: 0, losses: 1, draws: 0 });
    }

    #[tokio::test]
    async fn a_draw_keeps_no_win_condition_and_logged_games_carry_everything() {
        let pool = setup().await;
        let draw = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0002";
        create_game(&pool, "me", new_game(draw, Some(json!({ "winner_seat": null, "first_seat": 0, "win_condition": "combo", "seats": [] }))))
            .await
            .unwrap();
        let logged = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0003";
        let f = json!({ "winner_seat": 0, "turns": 8, "first_seat": 1, "win_condition": "alternate", "seats": [{ "seat": 2, "fun": 3 }] });
        create_game(&pool, "me", new_game(logged, Some(f.clone()))).await.unwrap();
        // Sending the same logged game again is a no-op.
        assert_eq!(create_game(&pool, "me", new_game(logged, Some(f.clone()))).await.unwrap()["existing"], true);
        // A retry also finishes a game whose first try was stored without its result.
        let half = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0006";
        create_game(&pool, "me", new_game(half, None)).await.unwrap();
        create_game(&pool, "me", new_game(half, Some(f))).await.unwrap();
        let status: String = sqlx::query_scalar("SELECT status FROM games WHERE id = ?").bind(half).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "finished");

        let games = crate::stats::finished_games(&pool, crate::stats::Scope::User("me")).await.unwrap();
        let d = games.iter().find(|g| g.id == draw).unwrap();
        assert_eq!((d.first_seat, d.win_condition.clone()), (Some(0), None));
        let l = games.iter().find(|g| g.id == logged).unwrap();
        assert_eq!((l.first_seat, l.win_condition.as_deref(), l.seats[2].fun), (Some(1), Some("alternate"), Some(3)));
    }

    #[tokio::test]
    async fn a_logged_game_can_be_edited_by_whoever_logged_it() {
        let pool = setup().await;
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0010";
        let game = |seats: serde_json::Value, finish: serde_json::Value| -> NewGame {
            serde_json::from_value(json!({ "id": id, "started_at": "2026-10-20T20:00:00Z", "seats": seats, "finish": finish, "note": "Logged after the game" })).unwrap()
        };
        let three = json!([{ "seat": 0, "user_id": "me" }, { "seat": 1, "guest_name": "Sam" }, { "seat": 2, "guest_name": "Alex" }]);
        create_game(&pool, "me", game(three, json!({ "winner_seat": 2, "first_seat": 2, "seats": [{ "seat": 2, "fun": 5 }] }))).await.unwrap();
        let stored: GameRow = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {GAME_COLUMNS} FROM games g WHERE g.id = ?"))).bind(id).fetch_one(&pool).await.unwrap();
        assert!(is_logged(&stored, &[]) && can_write(&pool, id, "me").await.unwrap());
        assert!(!can_write(&pool, id, "sam").await.unwrap());
        // A table game, with its play-by-play, isn't one to edit in Log a game.
        let event = Event { seq: 1, actor_seat: None, kind: "life".into(), payload: json!({}), created_at: None };
        assert!(!is_logged(&stored, &[event]));

        // Alex was never there: the edit drops the seat, and the answers about it go with it.
        let two = json!([{ "seat": 0, "user_id": "me" }, { "seat": 1, "guest_name": "Sam" }]);
        create_game(&pool, "me", game(two, json!({ "winner_seat": 1, "first_seat": null, "seats": [] }))).await.unwrap();
        let g = &crate::stats::finished_games(&pool, crate::stats::Scope::User("me")).await.unwrap()[0];
        assert_eq!(g.seats.len(), 2);
        assert_eq!((g.winner_seat, g.first_seat), (Some(1), None));
        assert!(g.seats.iter().all(|s| s.fun.is_none()));
        // Someone else can't rewrite it.
        let theirs = game(json!([{ "seat": 0, "guest_name": "Sam" }]), json!({ "winner_seat": 0, "seats": [] }));
        assert!(create_game(&pool, "sam", theirs).await.is_err());
    }

    #[tokio::test]
    async fn the_detail_says_who_can_edit_and_names_only_your_own_decks() {
        use crate::testutil::{app, deck, send, user};
        use axum::http::{Method, StatusCode};
        let (app, pool) = app().await;
        let (me, mt) = user(&pool, "me@example.com").await;
        let (sam, st) = user(&pool, "sam@example.com").await;
        let (my_deck, my_version) = deck(&pool, &me, "Riders of Rohan").await;
        let (_, sams_version) = deck(&pool, &sam, "Sam's brew").await;
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0011";
        let body = json!({
            "id": id,
            "seats": [
                { "seat": 0, "user_id": me, "deck_version_id": my_version },
                { "seat": 1, "guest_name": "Guest", "deck_version_id": sams_version, "deck_label": "Sam's brew" },
            ],
            "finish": { "winner_seat": 0, "seats": [] },
            "note": "Logged after the game",
        });
        assert_eq!(send(&app, Method::POST, "/api/games", Some(&mt), Some(body)).await.0, StatusCode::OK);
        let (s, g) = send(&app, Method::GET, &format!("/api/games/{id}"), Some(&mt), None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(g["can_edit"], true);
        assert_eq!(g["your_decks"], json!({ "0": my_deck }));
        // Sam has no seat on it, so can't even see it (and Sam's list on a guest seat was dropped).
        assert_eq!(send(&app, Method::GET, &format!("/api/games/{id}"), Some(&st), None).await.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn guest_members_keep_their_name_on_the_seat() {
        let pool = setup().await;
        sqlx::query("INSERT INTO playgroups (id, name, owner_id, join_code, created_at) VALUES ('pg','Friday','me','ABC123','t')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, user_id, created_at) VALUES ('m-me','pg','me','t')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, guest_name, created_at) VALUES ('m-jo','pg','Jo','t')").execute(&pool).await.unwrap();
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0005";
        let g: NewGame = serde_json::from_value(json!({
            "id": id, "playgroup_id": "pg",
            "seats": [{ "seat": 0, "member_id": "m-me" }, { "seat": 1, "member_id": "m-jo", "guest_name": null }],
            "finish": { "winner_seat": 1, "seats": [] },
        }))
        .unwrap();
        create_game(&pool, "me", g).await.unwrap();
        let stored: Option<String> = sqlx::query_scalar("SELECT guest_name FROM game_seats WHERE game_id = ? AND seat = 1").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(stored.as_deref(), Some("Jo"));
        let games = crate::stats::finished_games(&pool, crate::stats::Scope::Playgroup("pg")).await.unwrap();
        assert_eq!(games[0].seats.iter().map(|s| (s.name.as_str(), s.key.as_str())).collect::<Vec<_>>(), vec![("Bryan", "u:me"), ("Jo", "m:m-jo")]);
    }

    #[tokio::test]
    async fn bad_finishes_are_refused() {
        let pool = setup().await;
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0004";
        create_game(&pool, "me", new_game(id, None)).await.unwrap();
        for bad in [
            json!({ "winner_seat": 7 }),
            json!({ "winner_seat": 0, "first_seat": 5 }),
            json!({ "winner_seat": 0, "win_condition": "vibes" }),
            json!({ "winner_seat": 0, "seats": [{ "seat": 0, "fun": 6 }] }),
            json!({ "winner_seat": 0, "seats": [{ "seat": 9, "fun": 3 }] }),
        ] {
            assert!(matches!(finish_as(&pool, id, "me", finish(bad.clone())).await, Err(AppError::BadRequest(_))), "{bad}");
        }
        // Someone who didn't create the game can't finish it.
        assert!(matches!(finish_as(&pool, id, "sam", finish(json!({ "winner_seat": 0 }))).await, Err(AppError::NotFound(_))));
    }

    #[tokio::test]
    async fn create_refuses_times_that_are_not_rfc3339() {
        // Stats order games by it and the export copies it into every member's CSV.
        let pool = crate::db::test_pool().await;
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('me','me@x.y','Bryan','t')").execute(&pool).await.unwrap();
        let g: NewGame = serde_json::from_value(json!({
            "id": "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f00aa",
            "started_at": "=HYPERLINK(\"x\")",
            "seats": [{ "seat": 0, "user_id": "me" }],
        }))
        .unwrap();
        assert!(matches!(create_game(&pool, "me", g).await, Err(AppError::BadRequest(_))));
    }

    #[tokio::test]
    async fn create_retry_cannot_rewrite_an_online_game() {
        // can_write keeps online games engine-only (POST /finish refuses them); a "retried create"
        // with the same id mustn't get round that.
        let pool = crate::db::test_pool().await;
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('me','me@x.y','Bryan','t')").execute(&pool).await.unwrap();
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f00ac";
        sqlx::query("INSERT INTO games (id, mode, created_by, status, started_at, ended_at, winner_seat, turns) VALUES (?,'online','me','finished','2026-10-18T01:00:00Z','2026-10-18T02:00:00Z',1,9)")
            .bind(id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO game_seats (game_id, seat, user_id) VALUES (?,0,'me')").bind(id).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO game_seats (game_id, seat, guest_name, ai_kind) VALUES (?,1,'Atraxa','phase-ai Hard')").bind(id).execute(&pool).await.unwrap();
        // The /finish route refuses it...
        assert!(matches!(finish_as(&pool, id, "me", serde_json::from_value(json!({ "winner_seat": 0 })).unwrap()).await, Err(AppError::NotFound(_))));
        // ...and so does a "retried create" with the same id.
        let g: NewGame = serde_json::from_value(json!({
            "id": id, "seats": [{ "seat": 0, "user_id": "me" }, { "seat": 1, "guest_name": "Atraxa" }],
            "finish": { "winner_seat": 0, "turns": 3, "seats": [] },
        }))
        .unwrap();
        assert!(matches!(create_game(&pool, "me", g).await, Err(AppError::Conflict(_))));
        let (winner, turns): (Option<i64>, Option<i64>) =
            sqlx::query_as("SELECT winner_seat, turns FROM games WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!((winner, turns), (Some(1), Some(9)), "the online game's result was rewritten");
    }

    #[tokio::test]
    async fn deck_results_leave_out_seats_the_ai_played() {
        // Online games put the host's deck version on AI seats (play.rs create: deck_for_seat with
        // the host's id). The computer's results aren't the deck's record.
        let pool = crate::db::test_pool().await;
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('me','me@x.y','Bryan','t')").execute(&pool).await.unwrap();
        for (deck, version) in [("d-a", "v-a"), ("d-b", "v-b")] {
            sqlx::query("INSERT INTO decks (id, owner_id, name, created_at, updated_at) VALUES (?,'me',?,'t','t')").bind(deck).bind(deck).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO deck_versions (id, deck_id, cards, created_at) VALUES (?,?,'[]','2026-10-01T00:00:00Z')").bind(version).bind(deck).execute(&pool).await.unwrap();
        }
        // Bryan plays deck A against the computer piloting his deck B, and wins.
        sqlx::query("INSERT INTO games (id, mode, created_by, status, started_at, ended_at, winner_seat) VALUES ('og','online','me','finished','2026-10-18T01:00:00Z','2026-10-18T02:00:00Z',0)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO game_seats (game_id, seat, user_id, deck_version_id) VALUES ('og',0,'me','v-a')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO game_seats (game_id, seat, guest_name, ai_kind, deck_version_id) VALUES ('og',1,'Atraxa','phase-ai Medium','v-b')")
            .execute(&pool).await.unwrap();
        let games = crate::stats::finished_games(&pool, crate::stats::Scope::Deck("d-b")).await.unwrap();
        let by_version = crate::stats::results_by_version(&games);
        // Bryan never played deck B; its record shouldn't show a loss.
        assert!(by_version.get("v-b").is_none_or(|r| r.games == 0), "deck B's record: {:?}", by_version.get("v-b"));
        // A mirror match (the computer with the same version) counts once.
        sqlx::query("UPDATE game_seats SET deck_version_id = 'v-a' WHERE game_id = 'og' AND seat = 1").execute(&pool).await.unwrap();
        let games = crate::stats::finished_games(&pool, crate::stats::Scope::Deck("d-a")).await.unwrap();
        assert_eq!(crate::stats::results_by_version(&games)["v-a"], crate::stats::Record { games: 1, wins: 1, losses: 0, draws: 0 });
    }

    #[tokio::test]
    async fn a_retried_log_with_different_seats_does_not_credit_the_wrong_player() {
        // Log a game keeps one id per form. If the first Save reached the server but the phone
        // saw an error, and the user then removes a seat and saves again, the new finish is
        // numbered against the new seat list.
        let pool = crate::db::test_pool().await;
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('me','me@x.y','Bryan','t')").execute(&pool).await.unwrap();
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f00ab";
        let first: NewGame = serde_json::from_value(json!({
            "id": id, "started_at": "2026-10-18T01:00:00Z",
            "seats": [{ "seat": 0, "user_id": "me" }, { "seat": 1, "guest_name": "Sam" }, { "seat": 2, "guest_name": "Alex" }],
            "finish": { "winner_seat": 2, "seats": [] },
        }))
        .unwrap();
        create_game(&pool, "me", first).await.unwrap();
        // Second Save: Bryan's seat removed, Sam (now seat 0) marked as the winner.
        let edited: NewGame = serde_json::from_value(json!({
            "id": id, "started_at": "2026-10-18T01:00:00Z",
            "seats": [{ "seat": 0, "guest_name": "Sam" }, { "seat": 1, "guest_name": "Alex" }],
            "finish": { "winner_seat": 0, "seats": [] },
        }))
        .unwrap();
        let r = create_game(&pool, "me", edited).await;
        let winner: Option<String> = sqlx::query_scalar(
            "SELECT COALESCE(u.display_name, s.guest_name) FROM games g JOIN game_seats s ON s.game_id = g.id AND s.seat = g.winner_seat
             LEFT JOIN users u ON u.id = s.user_id WHERE g.id = ?",
        )
        .bind(id)
        .fetch_optional(&pool)
        .await
        .unwrap();
        // A logged game is only what the form said, so the second Save stores what it says now.
        assert!(r.is_ok() && winner.as_deref() == Some("Sam"), "retry returned {:?}; stored winner {winner:?}", r.map(|v| v.to_string()));
        let seats: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM game_seats WHERE game_id = ?").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(seats, 2);
    }

    #[tokio::test]
    async fn a_retry_keeps_a_commander_changed_mid_game() {
        let pool = setup().await;
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0008";
        create_game(&pool, "me", new_game(id, None)).await.unwrap();
        let mut again = new_game(id, None);
        again.seats[1].commander_name = Some("Atraxa, Praetors' Voice".into());
        again.seats[1].deck_label = Some("Atraxa, Praetors' Voice".into());
        assert_eq!(create_game(&pool, "me", again).await.unwrap()["existing"], true);
        let stored: (Option<String>, Option<String>) = sqlx::query_as("SELECT commander_name, deck_label FROM game_seats WHERE game_id = ? AND seat = 1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(stored.0.as_deref(), Some("Atraxa, Praetors' Voice"));
        assert_eq!(stored.1.as_deref(), Some("Atraxa, Praetors' Voice"));
    }

    #[tokio::test]
    async fn a_second_device_cant_quietly_lose_its_events() {
        let pool = setup().await;
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0009";
        create_game(&pool, "me", new_game(id, None)).await.unwrap();
        let event = |delta: i64| -> Event {
            serde_json::from_value(json!({ "seq": 1, "actor_seat": 0, "kind": "life", "payload": { "type": "life", "seat": 0, "delta": delta }, "created_at": "2026-10-29T19:00:00.000Z" })).unwrap()
        };
        let mut tx = pool.begin().await.unwrap();
        assert_eq!(insert_events(&mut tx, id, &[event(-3)]).await.unwrap(), 1);
        // The same event again (a retry) is fine and adds nothing.
        assert_eq!(insert_events(&mut tx, id, &[event(-3)]).await.unwrap(), 0);
        // A different event under the same number is another device: refused, not dropped.
        assert!(matches!(insert_events(&mut tx, id, &[event(-5)]).await, Err(AppError::Conflict(_))));
        // The same tap made on another device at another moment is another event too.
        let mut twin = event(-3);
        twin.created_at = Some("2026-10-29T19:00:04.000Z".into());
        assert!(matches!(insert_events(&mut tx, id, &[twin]).await, Err(AppError::Conflict(_))));
    }

    #[tokio::test]
    async fn a_table_game_retry_must_name_the_same_players() {
        let pool = setup().await;
        let id = "6f1c2c43-6c1e-4d6c-9f55-1d2b8a7f0007";
        create_game(&pool, "me", new_game(id, None)).await.unwrap();
        let event: Event = serde_json::from_value(json!({ "seq": 1, "actor_seat": 0, "kind": "life", "payload": { "type": "life", "seat": 0, "delta": -3 } })).unwrap();
        let mut tx = pool.begin().await.unwrap();
        insert_events(&mut tx, id, &[event]).await.unwrap();
        tx.commit().await.unwrap();
        // The phone retries the same create: fine, and a finish with it is checked as usual.
        let mut again = new_game(id, None);
        again.events = vec![];
        assert_eq!(create_game(&pool, "me", again).await.unwrap()["existing"], true);
        // A different seat list under the same id is refused, not applied to the stored seats.
        let other: NewGame = serde_json::from_value(json!({
            "id": id, "started_at": "2026-10-18T01:00:00Z",
            "seats": [{ "seat": 0, "guest_name": "Sam" }, { "seat": 1, "guest_name": "Alex" }, { "seat": 2, "guest_name": "Jo" }, { "seat": 3, "guest_name": "Kim" }],
            "finish": { "winner_seat": 3, "seats": [] },
        }))
        .unwrap();
        assert!(matches!(create_game(&pool, "me", other).await, Err(AppError::Conflict(_))));
        let status: String = sqlx::query_scalar("SELECT status FROM games WHERE id = ?").bind(id).fetch_one(&pool).await.unwrap();
        assert_eq!(status, "in_progress");
        // Someone else can't take over the id either.
        assert!(matches!(create_game(&pool, "sam", new_game(id, None)).await, Err(AppError::Conflict(_))));
    }

    /// The seat deck-version rule through the real router. Planner slice 0 refused another user's
    /// (or a missing) version with a 404; now it's dropped instead, so an offline phone's game
    /// still uploads. A seat keeps a version of its own account's deck, and a guest seat keeps one
    /// the person logging the game lent; no game points at anyone else's list, and a missing
    /// version doesn't fail the foreign key with a 500.
    mod through_the_router {
        use crate::testutil::{app, deck, send, user};
        use axum::http::{Method, StatusCode};
        use serde_json::json;

        fn game(id: &str, seats: serde_json::Value) -> serde_json::Value {
            json!({ "id": id, "seats": seats })
        }

        async fn stored(pool: &sqlx::SqlitePool, id: &str) -> Vec<Option<String>> {
            sqlx::query_scalar("SELECT deck_version_id FROM game_seats WHERE game_id = ? ORDER BY seat").bind(id).fetch_all(pool).await.unwrap()
        }

        #[tokio::test]
        async fn a_seat_cant_use_someone_elses_deck_version() {
            let (app, pool) = app().await;
            let (alice, _) = user(&pool, "alice@example.com").await;
            let (bob, bob_token) = user(&pool, "bob@example.com").await;
            let (_, alices_version) = deck(&pool, &alice, "Alice's deck").await;

            // Alice's list on Bob's own seat, or on a guest's seat in Bob's game: the game is
            // saved without it.
            let id = uuid::Uuid::new_v4().to_string();
            let seats = json!([
                { "seat": 0, "user_id": bob, "deck_version_id": alices_version },
                { "seat": 1, "guest_name": "Guest", "deck_version_id": alices_version },
            ]);
            let (status, body) = send(&app, Method::POST, "/api/games", Some(&bob_token), Some(game(&id, seats))).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(stored(&pool, &id).await, vec![None, None]);

            // A version that doesn't exist is dropped the same way, on a guest's seat or his own.
            let id = uuid::Uuid::new_v4().to_string();
            let seats = json!([
                { "seat": 0, "user_id": bob, "deck_version_id": "no-such-version" },
                { "seat": 1, "guest_name": "Guest", "deck_version_id": "no-such-version" },
            ]);
            let (status, body) = send(&app, Method::POST, "/api/games", Some(&bob_token), Some(game(&id, seats))).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(stored(&pool, &id).await, vec![None, None]);
        }

        #[tokio::test]
        async fn the_logger_can_lend_a_deck_to_a_guest() {
            let (app, pool) = app().await;
            let (bob, bob_token) = user(&pool, "bob@example.com").await;
            let (bobs_deck, bobs_version) = deck(&pool, &bob, "Bob's deck").await;
            let (_, bobs_other) = deck(&pool, &bob, "Bob's other deck").await;

            // His own list stays on his own seat, and the deck he lent stays on the guest's.
            let id = uuid::Uuid::new_v4().to_string();
            let mut body = game(&id, json!([
                { "seat": 0, "user_id": bob, "deck_version_id": bobs_version },
                { "seat": 1, "guest_name": "Guest", "deck_version_id": bobs_other },
                { "seat": 2, "guest_name": "Another guest", "deck_version_id": bobs_version },
            ]));
            body["finish"] = json!({ "winner_seat": 2, "seats": [] });
            let (status, body) = send(&app, Method::POST, "/api/games", Some(&bob_token), Some(body)).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(stored(&pool, &id).await, vec![Some(bobs_version.clone()), Some(bobs_other), Some(bobs_version.clone())]);

            // The deck's results count only the seat Bob played it on: the guest's win isn't his.
            let (status, body) = send(&app, Method::GET, &format!("/api/decks/{bobs_deck}/results"), Some(&bob_token), None).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            let v = &body["versions"][0];
            assert_eq!((v["id"].as_str(), v["games"].as_i64(), v["wins"].as_i64(), v["losses"].as_i64()), (Some(bobs_version.as_str()), Some(1), Some(0), Some(1)));
        }

        #[tokio::test]
        async fn a_seated_playgroup_member_can_bring_their_own_deck() {
            let (app, pool) = app().await;
            let (alice, _) = user(&pool, "alice@example.com").await;
            let (bob, bob_token) = user(&pool, "bob@example.com").await;
            let (carol, _) = user(&pool, "carol@example.com").await;
            let (_, alices_version) = deck(&pool, &alice, "Alice's deck").await;
            let (_, bobs_version) = deck(&pool, &bob, "Bob's deck").await;
            sqlx::query("INSERT INTO playgroups (id, name, owner_id, join_code, created_at) VALUES ('pg', 'Friday', ?, 'ABC123', 'now')")
                .bind(&bob)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(
                "INSERT INTO playgroup_members (id, playgroup_id, user_id, guest_name, created_at)
                 VALUES ('m-alice', 'pg', ?, NULL, 'now'), ('m-bob', 'pg', ?, NULL, 'now'), ('m-carol', 'pg', ?, NULL, 'now'), ('m-kim', 'pg', NULL, 'Kim', 'now')",
            )
            .bind(&alice)
            .bind(&bob)
            .bind(&carol)
            .execute(&pool)
            .await
            .unwrap();

            // Alice's list on a guest's seat isn't kept, even in the playgroup: Bob is logging the
            // game, so a guest seat can only hold a deck Bob lent. The same goes for a guest
            // member (one without an account).
            let id = uuid::Uuid::new_v4().to_string();
            let mut body = game(&id, json!([
                { "seat": 0, "guest_name": "Someone", "deck_version_id": alices_version },
                { "seat": 1, "member_id": "m-kim", "deck_version_id": alices_version },
            ]));
            body["playgroup_id"] = json!("pg");
            let (status, body) = send(&app, Method::POST, "/api/games", Some(&bob_token), Some(body)).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(stored(&pool, &id).await, vec![None, None]);

            // On Alice's own seat it is. Bob's list on Carol's seat isn't: a seat with an account
            // holds only that account's decks. Bob can lend his to the guest member, Kim.
            let id = uuid::Uuid::new_v4().to_string();
            let mut body = game(&id, json!([
                { "seat": 0, "member_id": "m-bob" },
                { "seat": 1, "member_id": "m-alice", "deck_version_id": alices_version },
                { "seat": 2, "member_id": "m-carol", "deck_version_id": bobs_version },
                { "seat": 3, "member_id": "m-kim", "deck_version_id": bobs_version },
            ]));
            body["playgroup_id"] = json!("pg");
            let (status, body) = send(&app, Method::POST, "/api/games", Some(&bob_token), Some(body)).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(stored(&pool, &id).await, vec![None, Some(alices_version), None, Some(bobs_version)]);
        }
    }
}
