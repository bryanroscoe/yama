//! Playgroups: friends plus guests who have no account.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, short_code};
use axum::extract::{Path, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/playgroups", get(list).post(create))
        .route("/api/playgroups/join", post(join))
        .route("/api/playgroups/{id}", get(detail))
        .route("/api/playgroups/{id}/guests", post(add_guest))
        .route("/api/playgroups/{id}/members/{member_id}", delete(remove_member))
        .route("/api/playgroups/{id}/stats", get(stats))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Member {
    pub id: String,
    pub user_id: Option<String>,
    pub guest_name: Option<String>,
    pub display_name: String,
}

#[derive(Serialize, sqlx::FromRow)]
struct Group {
    id: String,
    name: String,
    owner_id: String,
    join_code: String,
    #[sqlx(skip)]
    members: Vec<Member>,
}

pub async fn is_member(pool: &SqlitePool, group: &str, user: &str) -> AppResult<bool> {
    let found: Option<String> = sqlx::query_scalar(
        "SELECT g.id FROM playgroups g LEFT JOIN playgroup_members m ON m.playgroup_id = g.id
         WHERE g.id = ? AND (g.owner_id = ? OR m.user_id = ?) LIMIT 1",
    )
    .bind(group)
    .bind(user)
    .bind(user)
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

pub async fn members(pool: &SqlitePool, group: &str) -> AppResult<Vec<Member>> {
    Ok(sqlx::query_as(
        "SELECT m.id, m.user_id, m.guest_name, COALESCE(u.display_name, m.guest_name) AS display_name
         FROM playgroup_members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.playgroup_id = ? ORDER BY m.created_at",
    )
    .bind(group)
    .fetch_all(pool)
    .await?)
}

async fn list(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<Group>>> {
    let mut groups: Vec<Group> = sqlx::query_as(
        "SELECT DISTINCT g.id, g.name, g.owner_id, g.join_code FROM playgroups g
         LEFT JOIN playgroup_members m ON m.playgroup_id = g.id
         WHERE g.owner_id = ? OR m.user_id = ? ORDER BY g.name",
    )
    .bind(&user.id)
    .bind(&user.id)
    .fetch_all(&st.pool)
    .await?;
    for g in &mut groups {
        g.members = members(&st.pool, &g.id).await?;
    }
    Ok(Json(groups))
}

async fn detail(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Group>> {
    if !is_member(&st.pool, &id, &user.id).await? {
        return Err(AppError::NotFound("playgroup"));
    }
    let mut g: Group = sqlx::query_as("SELECT id, name, owner_id, join_code FROM playgroups WHERE id = ?")
        .bind(&id)
        .fetch_one(&st.pool)
        .await?;
    g.members = members(&st.pool, &id).await?;
    Ok(Json(g))
}

#[derive(Deserialize)]
struct NewGroup {
    name: String,
}

async fn create(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<NewGroup>) -> AppResult<Json<Group>> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::bad("playgroup needs a name"));
    }
    let id = new_id();
    let code = short_code(6);
    sqlx::query("INSERT INTO playgroups (id, name, owner_id, join_code, created_at) VALUES (?,?,?,?,?)")
        .bind(&id)
        .bind(name)
        .bind(&user.id)
        .bind(&code)
        .bind(now())
        .execute(&st.pool)
        .await?;
    add_user_member(&st.pool, &id, &user.id).await?;
    Ok(Json(Group { id: id.clone(), name: name.into(), owner_id: user.id, join_code: code, members: members(&st.pool, &id).await? }))
}

async fn add_user_member(pool: &SqlitePool, group: &str, user: &str) -> AppResult<()> {
    sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, user_id, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(new_id())
        .bind(group)
        .bind(user)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct Join {
    code: String,
}

async fn join(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<Join>) -> AppResult<Json<serde_json::Value>> {
    let id: String = sqlx::query_scalar("SELECT id FROM playgroups WHERE join_code = ?")
        .bind(body.code.trim().to_uppercase())
        .fetch_optional(&st.pool)
        .await?
        .ok_or(AppError::NotFound("playgroup with that code"))?;
    add_user_member(&st.pool, &id, &user.id).await?;
    Ok(Json(serde_json::json!({ "id": id })))
}

#[derive(Deserialize)]
struct Guest {
    name: String,
}

async fn add_guest(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<Guest>,
) -> AppResult<Json<serde_json::Value>> {
    if !is_member(&st.pool, &id, &user.id).await? {
        return Err(AppError::NotFound("playgroup"));
    }
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::bad("guest needs a name"));
    }
    let member_id = new_id();
    sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, guest_name, created_at) VALUES (?,?,?,?)")
        .bind(&member_id)
        .bind(&id)
        .bind(name)
        .bind(now())
        .execute(&st.pool)
        .await?;
    Ok(Json(serde_json::json!({ "id": member_id })))
}

async fn remove_member(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path((id, member_id)): Path<(String, String)>,
) -> AppResult<()> {
    let owner: Option<String> = sqlx::query_scalar("SELECT owner_id FROM playgroups WHERE id = ?").bind(&id).fetch_optional(&st.pool).await?;
    let member_user: Option<Option<String>> = sqlx::query_scalar("SELECT user_id FROM playgroup_members WHERE id = ? AND playgroup_id = ?")
        .bind(&member_id)
        .bind(&id)
        .fetch_optional(&st.pool)
        .await?;
    let Some(member_user) = member_user else { return Err(AppError::NotFound("member")) };
    // The owner can remove anyone; anyone can leave.
    if owner.as_deref() != Some(user.id.as_str()) && member_user.as_deref() != Some(user.id.as_str()) {
        return Err(AppError::Forbidden("only the playgroup owner can remove other members".into()));
    }
    // Past games keep the seat's name; only the membership goes.
    sqlx::query("UPDATE game_seats SET guest_name = COALESCE(guest_name, (SELECT display_name FROM users WHERE id = game_seats.user_id)), member_id = NULL WHERE member_id = ?")
        .bind(&member_id)
        .execute(&st.pool)
        .await?;
    sqlx::query("DELETE FROM playgroup_members WHERE id = ?").bind(&member_id).execute(&st.pool).await?;
    Ok(())
}

// ── stats ──────────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct PlayerStat {
    pub name: String,
    pub member_id: Option<String>,
    pub games: i64,
    pub wins: i64,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct CommanderStat {
    pub commander: String,
    pub games: i64,
    pub wins: i64,
}

#[derive(Serialize)]
struct Stats {
    games: i64,
    players: Vec<PlayerStat>,
    commanders: Vec<CommanderStat>,
    average_turns: Option<f64>,
    average_minutes: Option<f64>,
}

async fn stats(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Stats>> {
    if !is_member(&st.pool, &id, &user.id).await? {
        return Err(AppError::NotFound("playgroup"));
    }
    let games: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM games WHERE playgroup_id = ? AND status = 'finished'")
        .bind(&id)
        .fetch_one(&st.pool)
        .await?;
    let players = sqlx::query_as(
        "SELECT COALESCE(u.display_name, s.guest_name, s.ai_kind, 'Unknown') AS name, s.member_id,
                COUNT(*) AS games, SUM(g.winner_seat = s.seat) AS wins
         FROM games g JOIN game_seats s ON s.game_id = g.id LEFT JOIN users u ON u.id = s.user_id
         WHERE g.playgroup_id = ? AND g.status = 'finished'
         GROUP BY COALESCE(s.member_id, s.user_id, s.guest_name) ORDER BY wins DESC, games DESC",
    )
    .bind(&id)
    .fetch_all(&st.pool)
    .await?;
    let commanders = sqlx::query_as(
        "SELECT COALESCE(s.commander_name, s.deck_label, 'Unknown') AS commander, COUNT(*) AS games, SUM(g.winner_seat = s.seat) AS wins
         FROM games g JOIN game_seats s ON s.game_id = g.id
         WHERE g.playgroup_id = ? AND g.status = 'finished'
         GROUP BY commander ORDER BY wins DESC, games DESC",
    )
    .bind(&id)
    .fetch_all(&st.pool)
    .await?;
    let (average_turns, average_minutes): (Option<f64>, Option<f64>) = sqlx::query_as(
        "SELECT AVG(turns), AVG((julianday(ended_at) - julianday(started_at)) * 1440)
         FROM games WHERE playgroup_id = ? AND status = 'finished'",
    )
    .bind(&id)
    .fetch_one(&st.pool)
    .await?;
    Ok(Json(Stats { games, players, commanders, average_turns, average_minutes }))
}
