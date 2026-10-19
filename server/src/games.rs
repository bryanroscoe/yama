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

/// Check a finish against the game's seats. Everything here comes from the phone's event log,
/// so the same finish arrives unchanged on every retry; a bad value is a bug worth a 400.
fn check_finish(f: &Finish, seats: &[i64]) -> AppResult<()> {
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

/// Create an in-person game (and finish it, for a game logged afterwards). Creating the same
/// game again is a no-op, so an offline phone can retry.
async fn create_game(pool: &SqlitePool, user: &str, g: NewGame) -> AppResult<serde_json::Value> {
    if uuid::Uuid::parse_str(&g.id).is_err() {
        return Err(AppError::bad("game id must be a UUID"));
    }
    if g.seats.is_empty() || g.seats.len() > 10 {
        return Err(AppError::bad("a game needs 1 to 10 seats"));
    }
    let seat_numbers: Vec<i64> = g.seats.iter().map(|s| s.seat).collect();
    if let Some(f) = &g.finish {
        check_finish(f, &seat_numbers)?;
    }
    if let Some(pg) = &g.playgroup_id && !is_member(pool, pg, user).await? {
        return Err(AppError::NotFound("playgroup"));
    }
    let existing: Option<String> = sqlx::query_scalar("SELECT created_by FROM games WHERE id = ?").bind(&g.id).fetch_optional(pool).await?;
    match existing {
        Some(by) if by == user => {
            // A retry. If the first try stored the game but not its result, finish it now;
            // finishing again with the same result changes nothing.
            if let Some(f) = g.finish {
                finish_game(pool, &g.id, f).await?;
            }
            return Ok(serde_json::json!({ "id": g.id, "existing": true }));
        }
        Some(_) => return Err(AppError::Conflict("game id already used".into())),
        None => {}
    }
    let mut tx = pool.begin().await?;
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
    for s in &g.seats {
        // A seat can name a playgroup member (picking up their account) or, without a
        // playgroup, only the creator's own account. Anything else is recorded as a guest name,
        // so nobody can put games on someone else's record.
        let member: Option<(Option<String>, Option<String>)> = match (&s.member_id, &g.playgroup_id) {
            (Some(m), Some(pg)) => {
                let found: Option<(Option<String>, Option<String>)> =
                    sqlx::query_as("SELECT user_id, guest_name FROM playgroup_members WHERE id = ? AND playgroup_id = ?")
                        .bind(m)
                        .bind(pg)
                        .fetch_optional(&mut *tx)
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
        // Results per deck version count these, so a seat keeps a deck version only when it's a
        // version of a deck the seat's own account owns. Anything else is dropped rather than
        // refused, so a phone's offline game still uploads.
        let deck_version: Option<String> = match (&s.deck_version_id, &account) {
            (Some(v), Some(owner)) => {
                sqlx::query_scalar("SELECT v.id FROM deck_versions v JOIN decks d ON d.id = v.deck_id WHERE v.id = ? AND d.owner_id = ?")
                    .bind(v)
                    .bind(owner)
                    .fetch_optional(&mut *tx)
                    .await?
            }
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
        // A guest member's name is kept on the seat too, so the game still names them if they're
        // removed from the playgroup later.
        .bind(if account.is_none() { s.guest_name.clone().or(member_guest).or(s.display_name.clone()) } else { s.guest_name.clone() })
        .bind(&s.ai_kind)
        .bind(&deck_version)
        .bind(&s.deck_label)
        .bind(&s.commander_name)
        .execute(&mut *tx)
        .await?;
    }
    insert_events(&mut tx, &g.id, &g.events).await?;
    tx.commit().await?;
    if let Some(f) = g.finish {
        finish_game(pool, &g.id, f).await?;
    }
    Ok(serde_json::json!({ "id": g.id, "existing": false }))
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
    finish_as(&st.pool, &id, &user.id, f).await
}

async fn finish_as(pool: &SqlitePool, id: &str, user: &str, f: Finish) -> AppResult<()> {
    if !can_write(pool, id, user).await? {
        return Err(AppError::NotFound("game"));
    }
    let seats: Vec<i64> = sqlx::query_scalar("SELECT seat FROM game_seats WHERE game_id = ?").bind(id).fetch_all(pool).await?;
    check_finish(&f, &seats)?;
    finish_game(pool, id, f).await
}

async fn finish_game(pool: &SqlitePool, id: &str, f: Finish) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    // Setting the same values again is harmless, so a retried finish changes nothing.
    sqlx::query(
        "UPDATE games SET status = 'finished', winner_seat = ?, turns = ?, ended_at = ?, first_seat = ?, win_condition = ? WHERE id = ?",
    )
    .bind(f.winner_seat)
    .bind(f.turns)
    .bind(f.ended_at.unwrap_or_else(now))
    .bind(f.first_seat)
    .bind(if f.winner_seat.is_some() { f.win_condition } else { None })
    .bind(id)
    .execute(&mut *tx)
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
                // Someone else's deck version can't be claimed by a guest seat.
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
        // Only the deck version the seat's own account owns is kept.
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
}
