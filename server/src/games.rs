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
    #[serde(default)]
    seats: Vec<SeatResult>,
}

#[derive(Deserialize, Clone)]
struct SeatResult {
    seat: i64,
    final_life: Option<i64>,
    eliminated_turn: Option<i64>,
    eliminated_by_seat: Option<i64>,
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
    if uuid::Uuid::parse_str(&g.id).is_err() {
        return Err(AppError::bad("game id must be a UUID"));
    }
    if g.seats.is_empty() || g.seats.len() > 10 {
        return Err(AppError::bad("a game needs 1 to 10 seats"));
    }
    if let Some(pg) = &g.playgroup_id && !is_member(&st.pool, pg, &user.id).await? {
        return Err(AppError::NotFound("playgroup"));
    }
    let existing: Option<String> = sqlx::query_scalar("SELECT created_by FROM games WHERE id = ?").bind(&g.id).fetch_optional(&st.pool).await?;
    match existing {
        Some(by) if by == user.id => return Ok(Json(serde_json::json!({ "id": g.id, "existing": true }))),
        Some(_) => return Err(AppError::Conflict("game id already used".into())),
        None => {}
    }
    let mut tx = st.pool.begin().await?;
    sqlx::query(
        "INSERT INTO games (id, mode, playgroup_id, created_by, format, status, starting_life, started_at, note)
         VALUES (?, 'in_person', ?, ?, ?, 'in_progress', ?, ?, ?)",
    )
    .bind(&g.id)
    .bind(&g.playgroup_id)
    .bind(&user.id)
    .bind(&g.format)
    .bind(g.starting_life)
    .bind(g.started_at.clone().unwrap_or_else(now))
    .bind(&g.note)
    .execute(&mut *tx)
    .await?;
    for s in &g.seats {
        // A seat can name a playgroup member (picking up their account) or, without a
        // playgroup, only the creator's own account. Anything else is recorded as a guest name,
        // so nobody can put games on someone else's record.
        let member_user: Option<Option<String>> = match (&s.member_id, &g.playgroup_id) {
            (Some(m), Some(pg)) => {
                let found: Option<Option<String>> =
                    sqlx::query_scalar("SELECT user_id FROM playgroup_members WHERE id = ? AND playgroup_id = ?")
                        .bind(m)
                        .bind(pg)
                        .fetch_optional(&mut *tx)
                        .await?;
                Some(found.ok_or_else(|| AppError::bad("that player isn't in this playgroup"))?)
            }
            (Some(_), None) => return Err(AppError::bad("a playgroup member needs the playgroup")),
            (None, _) => None,
        };
        let account = match (member_user.flatten(), &s.user_id) {
            (Some(u), _) => Some(u),
            (None, Some(u)) if *u == user.id => Some(u.clone()),
            _ => None,
        };
        sqlx::query(
            "INSERT INTO game_seats (game_id, seat, member_id, user_id, guest_name, ai_kind, deck_version_id, deck_label, commander_name)
             VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .bind(&g.id)
        .bind(s.seat)
        .bind(if g.playgroup_id.is_some() { s.member_id.clone() } else { None })
        .bind(&account)
        .bind(if account.is_none() { s.guest_name.clone().or(s.display_name.clone()) } else { s.guest_name.clone() })
        .bind(&s.ai_kind)
        .bind(&s.deck_version_id)
        .bind(&s.deck_label)
        .bind(&s.commander_name)
        .execute(&mut *tx)
        .await?;
    }
    insert_events(&mut tx, &g.id, &g.events).await?;
    tx.commit().await?;
    if let Some(f) = g.finish {
        finish_game(&st.pool, &g.id, f).await?;
    }
    Ok(Json(serde_json::json!({ "id": g.id, "existing": false })))
}

async fn insert_events(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, game: &str, events: &[Event]) -> AppResult<u64> {
    let mut n = 0;
    for e in events {
        n += sqlx::query(
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
    }
    Ok(n)
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
    if !can_write(&st.pool, &id, &user.id).await? {
        return Err(AppError::NotFound("game"));
    }
    finish_game(&st.pool, &id, f).await
}

async fn finish_game(pool: &SqlitePool, id: &str, f: Finish) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE games SET status = 'finished', winner_seat = ?, turns = ?, ended_at = ? WHERE id = ?")
        .bind(f.winner_seat)
        .bind(f.turns)
        .bind(f.ended_at.unwrap_or_else(now))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    for s in f.seats {
        sqlx::query("UPDATE game_seats SET final_life = ?, eliminated_turn = ?, eliminated_by_seat = ? WHERE game_id = ? AND seat = ?")
            .bind(s.final_life)
            .bind(s.eliminated_turn)
            .bind(s.eliminated_by_seat)
            .bind(id)
            .bind(s.seat)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
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
    note: Option<String>,
    #[sqlx(skip)]
    seats: Vec<Seat>,
}

const GAME_COLUMNS: &str = "g.id, g.mode, g.playgroup_id, g.format, g.status, g.starting_life, g.started_at, g.ended_at, g.turns, g.winner_seat, g.note";

async fn seats(pool: &SqlitePool, game: &str) -> AppResult<Vec<Seat>> {
    Ok(sqlx::query_as(
        "SELECT s.seat, s.member_id, s.user_id, s.guest_name, s.ai_kind, s.deck_version_id, s.deck_label, s.commander_name,
                s.final_life, s.eliminated_turn, s.eliminated_by_seat,
                COALESCE(u.display_name, s.guest_name, s.ai_kind) AS display_name
         FROM game_seats s LEFT JOIN users u ON u.id = s.user_id WHERE s.game_id = ? ORDER BY s.seat",
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
    Ok(Json(GameDetail { game, events }))
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
