//! Playgroups: friends plus guests who have no account.
//!
//! **Who may do what.** Any member sees the group, adds guests and may leave. Only the owner
//! renames it, makes a new join code, removes other members, hands it on and deletes it.
//!
//! **Join codes.** A code is the whole invitation: anyone with an account who holds it can join
//! and read the group's games and stats. So it changes whenever the owner removes an account (the
//! person removed knows the old one) and whenever the owner asks for a new one.
//!
//! **Leaving, handing on and deleting** follow account deletion (`admin/delete.rs`). An owner who
//! leaves passes the group to its longest-standing other account member. A group can only be
//! deleted once no other account is in it (hand it on or remove them first), so nobody loses a
//! shared history to someone else's click; its games then stay in each player's own history,
//! without the group, and guest seats keep their names.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, short_code};
use axum::extract::{Path, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};

/// A playgroup's name, in characters.
pub const NAME_MAX: usize = 60;
/// A guest's name, in characters.
pub const GUEST_NAME_MAX: usize = 40;
/// Members of one playgroup, accounts and guests together.
pub const MEMBERS_MAX: i64 = 100;
/// Playgroups one account may own.
pub const OWNED_MAX: i64 = 25;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/playgroups", get(list).post(create))
        .route("/api/playgroups/join", post(join))
        .route("/api/playgroups/{id}", get(detail).patch(rename).delete(delete_group))
        .route("/api/playgroups/{id}/code", post(new_code))
        .route("/api/playgroups/{id}/owner", post(hand_on))
        .route("/api/playgroups/{id}/leave", post(leave))
        .route("/api/playgroups/{id}/guests", post(add_guest))
        .route("/api/playgroups/{id}/members/{member_id}", delete(remove_member))
        .route("/api/playgroups/{id}/stats", get(stats))
}

/// A name someone typed, trimmed: not blank, one line (no control characters, nor Unicode's
/// line and paragraph separators), at most `max` characters.
fn clean_name(raw: &str, what: &str, max: usize) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::bad(format!("{what} needs a name")));
    }
    if name.chars().any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')) {
        return Err(AppError::bad(format!("{what} name can't hold line breaks or control characters")));
    }
    if name.chars().count() > max {
        return Err(AppError::bad(format!("{what} name is too long (at most {max} characters)")));
    }
    Ok(name.to_string())
}

/// A join code no playgroup has. (The column is unique, so a clash that slipped past this check
/// would fail the write rather than give two groups one code.)
async fn fresh_code(conn: &mut SqliteConnection) -> AppResult<String> {
    loop {
        let code = short_code(6);
        let taken: Option<String> = sqlx::query_scalar("SELECT id FROM playgroups WHERE join_code = ?").bind(&code).fetch_optional(&mut *conn).await?;
        if taken.is_none() {
            return Ok(code);
        }
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Member {
    pub id: String,
    pub user_id: Option<String>,
    pub guest_name: Option<String>,
    pub display_name: String,
    /// Their profile handle, if they picked one: the seat can then offer their public decks.
    pub handle: Option<String>,
}

#[derive(Serialize, sqlx::FromRow)]
pub(crate) struct Group {
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

pub async fn members<'e, E: sqlx::SqliteExecutor<'e>>(db: E, group: &str) -> AppResult<Vec<Member>> {
    Ok(sqlx::query_as(
        "SELECT m.id, m.user_id, m.guest_name, COALESCE(u.display_name, m.guest_name) AS display_name,
                CASE WHEN u.disabled_at IS NULL THEN u.handle END AS handle
         FROM playgroup_members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.playgroup_id = ? ORDER BY m.created_at",
    )
    .bind(group)
    .fetch_all(db)
    .await?)
}

async fn list(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<Group>>> {
    Ok(Json(groups_for(&st.pool, &user.id).await?))
}

/// The playgroups this account owns or is in, with members, shared with the MCP's `playgroups`.
pub(crate) async fn groups_for(pool: &SqlitePool, user_id: &str) -> AppResult<Vec<Group>> {
    let mut groups: Vec<Group> = sqlx::query_as(
        "SELECT DISTINCT g.id, g.name, g.owner_id, g.join_code FROM playgroups g
         LEFT JOIN playgroup_members m ON m.playgroup_id = g.id
         WHERE g.owner_id = ? OR m.user_id = ? ORDER BY g.name",
    )
    .bind(user_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    for g in &mut groups {
        g.members = members(pool, &g.id).await?;
    }
    Ok(groups)
}

/// One group as a member sees it. The membership check and the row (with its join code) are one
/// statement, so someone removed a moment ago never reads the code that replaced the one they knew.
async fn detail(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Group>> {
    let mut g: Group = sqlx::query_as(
        "SELECT g.id, g.name, g.owner_id, g.join_code FROM playgroups g
          WHERE g.id = ?1 AND (g.owner_id = ?2 OR EXISTS (SELECT 1 FROM playgroup_members m WHERE m.playgroup_id = g.id AND m.user_id = ?2))",
    )
    .bind(&id)
    .bind(&user.id)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound("playgroup"))?;
    g.members = members(&st.pool, &id).await?;
    Ok(Json(g))
}

#[derive(Deserialize)]
struct NewGroup {
    name: String,
}

/// The group as it stands inside a write's transaction, for that write's answer. Read before
/// the commit, by the person the transaction has just checked: an answer read afterwards could
/// carry a join code made since, for someone removed in between.
async fn load_in(conn: &mut SqliteConnection, id: &str) -> AppResult<Group> {
    let mut g: Group = sqlx::query_as("SELECT id, name, owner_id, join_code FROM playgroups WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or(AppError::NotFound("playgroup"))?;
    g.members = members(&mut *conn, id).await?;
    Ok(g)
}

async fn create(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<NewGroup>) -> AppResult<Json<Group>> {
    let name = clean_name(&body.name, "playgroup", NAME_MAX)?;
    st.limits.playgroup_writes.check_user(&user)?;
    let id = new_id();
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playgroups WHERE owner_id = ?").bind(&user.id).fetch_one(&mut *tx).await?;
    if owned >= OWNED_MAX {
        return Err(AppError::Conflict(format!("You already have {OWNED_MAX} playgroups. Delete one you no longer use first.")));
    }
    let code = fresh_code(&mut tx).await?;
    sqlx::query("INSERT INTO playgroups (id, name, owner_id, join_code, created_at) VALUES (?,?,?,?,?)")
        .bind(&id)
        .bind(&name)
        .bind(&user.id)
        .bind(&code)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    add_user_member(&mut tx, &id, &user.id).await?;
    let group = load_in(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(Json(group))
}

async fn add_user_member(conn: &mut SqliteConnection, group: &str, user: &str) -> AppResult<()> {
    sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, user_id, created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(new_id())
        .bind(group)
        .bind(user)
        .bind(now())
        .execute(&mut *conn)
        .await?;
    Ok(())
}

async fn member_count(conn: &mut SqliteConnection, group: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM playgroup_members WHERE playgroup_id = ?").bind(group).fetch_one(&mut *conn).await?)
}

fn full() -> AppError {
    AppError::Conflict(format!("This playgroup is full ({MEMBERS_MAX} members)."))
}

#[derive(Deserialize)]
struct Join {
    code: String,
}

/// Join by code. Tries (right or wrong) are rate-limited per account, so codes can't be guessed.
async fn join(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<Join>) -> AppResult<Json<serde_json::Value>> {
    st.limits.join_codes.check_user(&user)?;
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let id: String = sqlx::query_scalar("SELECT id FROM playgroups WHERE join_code = ?")
        .bind(body.code.trim().to_uppercase())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound("playgroup with that code"))?;
    let already: Option<String> = sqlx::query_scalar("SELECT id FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?")
        .bind(&id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if already.is_none() {
        if member_count(&mut tx, &id).await? >= MEMBERS_MAX {
            return Err(full());
        }
        add_user_member(&mut tx, &id, &user.id).await?;
    }
    tx.commit().await?;
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
    // Membership is read inside the write, like every other change here: someone removed a
    // moment ago adds nothing, and a group deleted meanwhile is not found rather than an error.
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    owner_for_member(&mut tx, &id, &user.id).await?;
    let name = clean_name(&body.name, "guest", GUEST_NAME_MAX)?;
    st.limits.playgroup_writes.check_user(&user)?;
    let member_id = new_id();
    if member_count(&mut tx, &id).await? >= MEMBERS_MAX {
        return Err(full());
    }
    sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, guest_name, created_at) VALUES (?,?,?,?)")
        .bind(&member_id)
        .bind(&id)
        .bind(&name)
        .bind(now())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(serde_json::json!({ "id": member_id })))
}

/// The group's owner, when `user` is in the group: 404 for everyone else, as for a group that
/// doesn't exist. Read inside the caller's write transaction, so it is still true at the write.
async fn owner_for_member(conn: &mut SqliteConnection, group: &str, user: &str) -> AppResult<String> {
    sqlx::query_scalar(
        "SELECT g.owner_id FROM playgroups g
          WHERE g.id = ?1 AND (g.owner_id = ?2 OR EXISTS (SELECT 1 FROM playgroup_members m WHERE m.playgroup_id = g.id AND m.user_id = ?2))",
    )
    .bind(group)
    .bind(user)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(AppError::NotFound("playgroup"))
}

/// As `owner_for_member`, and `user` must be that owner.
async fn require_owner(conn: &mut SqliteConnection, group: &str, user: &str, to: &str) -> AppResult<()> {
    if owner_for_member(conn, group, user).await? != user {
        return Err(AppError::Forbidden(format!("only the playgroup owner can {to}")));
    }
    Ok(())
}

#[derive(Deserialize)]
struct Rename {
    name: String,
}

async fn rename(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, Json(body): Json<Rename>) -> AppResult<Json<Group>> {
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    require_owner(&mut tx, &id, &user.id, "rename it").await?;
    let name = clean_name(&body.name, "playgroup", NAME_MAX)?;
    st.limits.playgroup_writes.check_user(&user)?;
    sqlx::query("UPDATE playgroups SET name = ? WHERE id = ?").bind(&name).bind(&id).execute(&mut *tx).await?;
    let group = load_in(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(Json(group))
}

/// A new join code; the old one stops working at once. People already in the group stay.
async fn new_code(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Group>> {
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    require_owner(&mut tx, &id, &user.id, "change the join code").await?;
    st.limits.playgroup_writes.check_user(&user)?;
    rotate_code(&mut tx, &id).await?;
    let group = load_in(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(Json(group))
}

async fn rotate_code(conn: &mut SqliteConnection, group: &str) -> AppResult<()> {
    let code = fresh_code(conn).await?;
    sqlx::query("UPDATE playgroups SET join_code = ? WHERE id = ?").bind(code).bind(group).execute(&mut *conn).await?;
    Ok(())
}

#[derive(Deserialize)]
struct HandOn {
    /// The member (an account, not a guest) who becomes the owner.
    member_id: String,
}

/// Make another account in the group its owner. The old owner stays a member.
async fn hand_on(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, Json(body): Json<HandOn>) -> AppResult<Json<Group>> {
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    require_owner(&mut tx, &id, &user.id, "hand it on").await?;
    let heir: Option<(Option<String>, bool)> = sqlx::query_as(
        "SELECT m.user_id, u.disabled_at IS NOT NULL FROM playgroup_members m LEFT JOIN users u ON u.id = m.user_id
          WHERE m.id = ? AND m.playgroup_id = ?",
    )
    .bind(&body.member_id)
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await?;
    let (heir, disabled) = heir.ok_or(AppError::NotFound("member"))?;
    let Some(heir) = heir else {
        return Err(AppError::bad("a guest can't own a playgroup; pick someone with an account"));
    };
    // Nobody could then rename it, remove anyone or delete it.
    if disabled {
        return Err(AppError::bad("that account is turned off, so it can't own a playgroup"));
    }
    sqlx::query("UPDATE playgroups SET owner_id = ? WHERE id = ?").bind(&heir).bind(&id).execute(&mut *tx).await?;
    // An owner from before member rows were kept for owners still shows in the group.
    add_user_member(&mut tx, &id, &user.id).await?;
    let group = load_in(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(Json(group))
}

/// Take a member row out of its group. Past games keep the seat's name; only the membership goes.
async fn drop_member(conn: &mut SqliteConnection, member_id: &str) -> AppResult<()> {
    sqlx::query(
        "UPDATE game_seats SET guest_name = COALESCE(guest_name, (SELECT display_name FROM users WHERE id = game_seats.user_id),
                                                    (SELECT guest_name FROM playgroup_members WHERE id = game_seats.member_id)),
                               member_id = NULL
         WHERE member_id = ?",
    )
    .bind(member_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM playgroup_members WHERE id = ?").bind(member_id).execute(&mut *conn).await?;
    Ok(())
}

/// Who takes a group over when `leaving` goes: its longest-standing other account member, one
/// that can sign in before one that is turned off. With `working_only`, never one turned off
/// (an owner who chooses to leave mustn't strand the group with an owner who can't act);
/// account deletion (`admin/delete.rs`) takes whoever there is, so the group lives on.
pub(crate) async fn heir(conn: &mut SqliteConnection, group: &str, leaving: &str, working_only: bool) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar(
        "SELECT m.user_id FROM playgroup_members m JOIN users u ON u.id = m.user_id
          WHERE m.playgroup_id = ?1 AND m.user_id != ?2 AND (?3 = 0 OR u.disabled_at IS NULL)
          ORDER BY u.disabled_at IS NOT NULL, m.created_at, m.id LIMIT 1",
    )
    .bind(group)
    .bind(leaving)
    .bind(working_only)
    .fetch_optional(&mut *conn)
    .await?)
}

/// `user` leaves `group`. An owner first passes the group to its longest-standing other account
/// member (as account deletion does); with nobody to take it, they delete it instead.
async fn leave_in(conn: &mut SqliteConnection, group: &str, user: &str) -> AppResult<()> {
    if owner_for_member(conn, group, user).await? == user {
        let Some(heir) = heir(conn, group, user, true).await? else {
            return Err(AppError::Conflict("Nobody else in this playgroup can take it over. Delete it instead of leaving.".into()));
        };
        sqlx::query("UPDATE playgroups SET owner_id = ? WHERE id = ?").bind(heir).bind(group).execute(&mut *conn).await?;
    }
    let mine: Option<String> = sqlx::query_scalar("SELECT id FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?")
        .bind(group)
        .bind(user)
        .fetch_optional(&mut *conn)
        .await?;
    if let Some(mine) = mine {
        drop_member(conn, &mine).await?;
    }
    Ok(())
}

async fn leave(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    leave_in(&mut tx, &id, &user.id).await?;
    tx.commit().await?;
    Ok(())
}

/// Remove a member. The owner can remove anyone; anyone can remove themselves, which is leaving.
/// Removing someone's account changes the join code, so the code they know no longer lets them
/// (or anyone they gave it to) back in.
async fn remove_member(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path((id, member_id)): Path<(String, String)>,
) -> AppResult<()> {
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let owner = owner_for_member(&mut tx, &id, &user.id).await?;
    let member_user: Option<Option<String>> = sqlx::query_scalar("SELECT user_id FROM playgroup_members WHERE id = ? AND playgroup_id = ?")
        .bind(&member_id)
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(member_user) = member_user else { return Err(AppError::NotFound("member")) };
    if member_user.as_deref() == Some(user.id.as_str()) {
        leave_in(&mut tx, &id, &user.id).await?;
    } else if owner == user.id {
        drop_member(&mut tx, &member_id).await?;
        if member_user.is_some() {
            rotate_code(&mut tx, &id).await?;
        }
    } else {
        return Err(AppError::Forbidden("only the playgroup owner can remove other members".into()));
    }
    tx.commit().await?;
    Ok(())
}

/// Delete a playgroup's rows. Its games leave the group and stay in each player's own history;
/// seats leave its member rows (a guest member's name stays on the seat). The members go with
/// the group. Shared with account deletion (`admin/delete.rs`).
pub(crate) async fn delete_rows(conn: &mut SqliteConnection, group: &str) -> AppResult<()> {
    sqlx::query("UPDATE games SET playgroup_id = NULL WHERE playgroup_id = ?").bind(group).execute(&mut *conn).await?;
    sqlx::query(
        "UPDATE game_seats SET
           guest_name = COALESCE(game_seats.guest_name, (SELECT m.guest_name FROM playgroup_members m WHERE m.id = game_seats.member_id)),
           member_id = NULL
         WHERE member_id IN (SELECT id FROM playgroup_members WHERE playgroup_id = ?)",
    )
    .bind(group)
    .execute(&mut *conn)
    .await?;
    sqlx::query("DELETE FROM playgroups WHERE id = ?").bind(group).execute(&mut *conn).await?;
    Ok(())
}

/// Delete a playgroup. Only its owner, and only once no other account is in it: while someone
/// else is, the history is theirs too, so the owner hands the group on (or removes them) first.
async fn delete_group(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    require_owner(&mut tx, &id, &user.id, "delete it").await?;
    let others: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM playgroup_members WHERE playgroup_id = ? AND user_id IS NOT NULL AND user_id != ?")
        .bind(&id)
        .bind(&user.id)
        .fetch_one(&mut *tx)
        .await?;
    if others > 0 {
        return Err(AppError::Conflict(
            "Other people are still in this playgroup. Leave it to hand it on, or remove them first, then delete it.".into(),
        ));
    }
    delete_rows(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(())
}

// ── stats ──────────────────────────────────────────────────────────────────

/// Everything the Group page shows, computed from the playgroup's finished games on request.
#[derive(Serialize)]
pub(crate) struct Stats {
    games: i64,
    players: Vec<crate::stats::PlayerStat>,
    commanders: Vec<crate::stats::CommanderStat>,
    average_turns: Option<crate::stats::Average>,
    average_minutes: Option<crate::stats::Average>,
    seats: Vec<crate::stats::PodSeats>,
    seats_unknown: i64,
    seat_reference: crate::stats::SeatReference,
    win_conditions: crate::stats::WinConditions,
    head_to_head: Vec<crate::stats::HeadToHead>,
    knockout_games: i64,
    provisional_under: i64,
    computed_at: String,
}

async fn stats(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Stats>> {
    Ok(Json(stats_for(&st.pool, &user.id, &id).await?))
}

/// The Group page's stats for one playgroup this account is in, shared with the MCP.
pub(crate) async fn stats_for(pool: &SqlitePool, user_id: &str, id: &str) -> AppResult<Stats> {
    use crate::stats as s;
    if !is_member(pool, id, user_id).await? {
        return Err(AppError::NotFound("playgroup"));
    }
    let games = s::finished_games(pool, s::Scope::Playgroup(id)).await?;
    Ok(Stats {
        games: games.len() as i64,
        players: s::players(&games),
        commanders: s::commanders(&games),
        average_turns: s::average_turns(&games),
        average_minutes: s::average_minutes(&games),
        seats: s::seats(&games),
        seats_unknown: s::seats_unknown(&games),
        seat_reference: s::SEAT_REFERENCE,
        win_conditions: s::win_conditions(&games),
        head_to_head: s::head_to_head(&games),
        knockout_games: s::knockout_games(&games),
        provisional_under: s::PROVISIONAL_UNDER,
        computed_at: now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{app, send, user};
    use axum::http::{Method, StatusCode};
    use serde_json::{Value, json};

    /// A playgroup Bryan owns that Pat joined by code. Returns (group id, join code).
    async fn group(app: &Router, owner: &str, joiner: &str) -> (String, String) {
        let (status, g) = send(app, Method::POST, "/api/playgroups", Some(owner), Some(json!({ "name": "Thursday" }))).await;
        assert_eq!(status, StatusCode::OK, "{g}");
        let (id, code) = (g["id"].as_str().unwrap().to_string(), g["join_code"].as_str().unwrap().to_string());
        let (status, joined) = send(app, Method::POST, "/api/playgroups/join", Some(joiner), Some(json!({ "code": code }))).await;
        assert_eq!(status, StatusCode::OK, "{joined}");
        (id, code)
    }

    async fn detail(app: &Router, token: &str, id: &str) -> Value {
        let (status, g) = send(app, Method::GET, &format!("/api/playgroups/{id}"), Some(token), None).await;
        assert_eq!(status, StatusCode::OK, "{g}");
        g
    }

    fn member_of<'a>(g: &'a Value, user_id: &str) -> &'a str {
        g["members"].as_array().unwrap().iter().find(|m| m["user_id"] == user_id).expect("a member row")["id"].as_str().unwrap()
    }

    #[tokio::test]
    async fn a_removed_account_cannot_rejoin_with_the_code_it_knew() {
        let (app, pool) = app().await;
        let (_, bt) = user(&pool, "bryan@example.com").await;
        let (pat, pt) = user(&pool, "pat@example.com").await;
        let (id, code) = group(&app, &bt, &pt).await;
        let g = detail(&app, &bt, &id).await;

        // A guest going changes nothing about the code: a guest never held it.
        let (_, guest) = send(&app, Method::POST, &format!("/api/playgroups/{id}/guests"), Some(&bt), Some(json!({ "name": "Sam" }))).await;
        let guest = guest["id"].as_str().unwrap();
        let (status, _) = send(&app, Method::DELETE, &format!("/api/playgroups/{id}/members/{guest}"), Some(&bt), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detail(&app, &bt, &id).await["join_code"], code.as_str());

        // The owner removes Pat: the code changes, and the old one finds nothing.
        let (status, _) = send(&app, Method::DELETE, &format!("/api/playgroups/{id}/members/{}", member_of(&g, &pat)), Some(&bt), None).await;
        assert_eq!(status, StatusCode::OK);
        let fresh = detail(&app, &bt, &id).await["join_code"].as_str().unwrap().to_string();
        assert_ne!(fresh, code);
        let (status, _) = send(&app, Method::POST, "/api/playgroups/join", Some(&pt), Some(json!({ "code": code }))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&app, Method::GET, &format!("/api/playgroups/{id}"), Some(&pt), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "a removed member no longer sees the group");
        // Invited again with the new code, Pat is back.
        let (status, _) = send(&app, Method::POST, "/api/playgroups/join", Some(&pt), Some(json!({ "code": fresh }))).await;
        assert_eq!(status, StatusCode::OK);

        // Leaving by choice doesn't change the code (through the member route or `/leave`).
        let g = detail(&app, &bt, &id).await;
        let (status, _) = send(&app, Method::DELETE, &format!("/api/playgroups/{id}/members/{}", member_of(&g, &pat)), Some(&pt), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detail(&app, &bt, &id).await["join_code"], fresh.as_str());
        assert_eq!(detail(&app, &bt, &id).await["members"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn only_the_owner_renames_recodes_removes_hands_on_and_deletes() {
        let (app, pool) = app().await;
        let (bryan, bt) = user(&pool, "bryan@example.com").await;
        let (pat, pt) = user(&pool, "pat@example.com").await;
        let (_, st) = user(&pool, "stranger@example.com").await;
        let (id, code) = group(&app, &bt, &pt).await;
        let g = detail(&app, &bt, &id).await;
        let (bryan_row, pat_row) = (member_of(&g, &bryan).to_string(), member_of(&g, &pat).to_string());

        let writes = |member: &str| {
            vec![
                (Method::PATCH, format!("/api/playgroups/{id}"), Some(json!({ "name": "Mine now" }))),
                (Method::POST, format!("/api/playgroups/{id}/code"), None),
                (Method::POST, format!("/api/playgroups/{id}/owner"), Some(json!({ "member_id": member }))),
                (Method::DELETE, format!("/api/playgroups/{id}/members/{bryan_row}"), None),
                (Method::DELETE, format!("/api/playgroups/{id}"), None),
            ]
        };
        // A member who isn't the owner is told so; someone outside the group learns nothing.
        for (method, path, body) in writes(&pat_row) {
            let (status, _) = send(&app, method.clone(), &path, Some(&pt), body.clone()).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path} as a member");
            let (status, _) = send(&app, method.clone(), &path, Some(&st), body).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path} as a stranger");
        }
        let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/leave"), Some(&st), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let g = detail(&app, &bt, &id).await;
        assert_eq!((g["name"].as_str(), g["owner_id"].as_str(), g["join_code"].as_str()), (Some("Thursday"), Some(bryan.as_str()), Some(code.as_str())));
        assert_eq!(g["members"].as_array().unwrap().len(), 2);

        // The owner renames it and makes a new code; the old code stops working, members stay.
        let (status, g) = send(&app, Method::PATCH, &format!("/api/playgroups/{id}"), Some(&bt), Some(json!({ "name": "  Friday night  " }))).await;
        assert_eq!((status, g["name"].as_str()), (StatusCode::OK, Some("Friday night")));
        let (status, g) = send(&app, Method::POST, &format!("/api/playgroups/{id}/code"), Some(&bt), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_ne!(g["join_code"], code.as_str());
        assert_eq!(g["members"].as_array().unwrap().len(), 2);
        let (status, _) = send(&app, Method::POST, "/api/playgroups/join", Some(&st), Some(json!({ "code": code }))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        // Handing on: only to an account in this group. Then Pat owns it and Bryan is a member.
        let (_, guest) = send(&app, Method::POST, &format!("/api/playgroups/{id}/guests"), Some(&bt), Some(json!({ "name": "Sam" }))).await;
        let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/owner"), Some(&bt), Some(json!({ "member_id": guest["id"] }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/owner"), Some(&bt), Some(json!({ "member_id": "nobody" }))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, g) = send(&app, Method::POST, &format!("/api/playgroups/{id}/owner"), Some(&bt), Some(json!({ "member_id": pat_row }))).await;
        assert_eq!((status, g["owner_id"].as_str()), (StatusCode::OK, Some(pat.as_str())));
        assert_eq!(g["members"].as_array().unwrap().len(), 3);
        let (status, _) = send(&app, Method::PATCH, &format!("/api/playgroups/{id}"), Some(&bt), Some(json!({ "name": "Back to me" }))).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn names_are_trimmed_capped_and_never_blank() {
        let (app, pool) = app().await;
        let (_, bt) = user(&pool, "bryan@example.com").await;
        let (_, pt) = user(&pool, "pat@example.com").await;
        let (id, _) = group(&app, &bt, &pt).await;
        let long_group = "g".repeat(NAME_MAX + 1);
        let long_guest = "g".repeat(GUEST_NAME_MAX + 1);
        for bad in ["", "   ", "Thurs\nday", "Thurs\u{2028}day", long_group.as_str()] {
            let (status, _) = send(&app, Method::POST, "/api/playgroups", Some(&bt), Some(json!({ "name": bad }))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "create {bad:?}");
            let (status, _) = send(&app, Method::PATCH, &format!("/api/playgroups/{id}"), Some(&bt), Some(json!({ "name": bad }))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "rename {bad:?}");
        }
        for bad in ["", "  ", "Sa\tm", long_guest.as_str()] {
            let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/guests"), Some(&bt), Some(json!({ "name": bad }))).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "guest {bad:?}");
        }
        // Exactly at the cap is fine, counted in characters rather than bytes.
        let at_cap = "é".repeat(NAME_MAX);
        let (status, g) = send(&app, Method::PATCH, &format!("/api/playgroups/{id}"), Some(&bt), Some(json!({ "name": at_cap }))).await;
        assert_eq!((status, g["name"].as_str()), (StatusCode::OK, Some(at_cap.as_str())));
        assert_eq!(detail(&app, &bt, &id).await["members"].as_array().unwrap().len(), 2, "no guest was added");
    }

    /// A group can pass to an account that is turned off only when its owner's account is
    /// deleted and nobody else is there; an account that can sign in comes first.
    #[tokio::test]
    async fn the_heir_is_an_account_that_can_sign_in_when_there_is_one() {
        let (app, pool) = app().await;
        let (bryan, bt) = user(&pool, "bryan@example.com").await;
        let (pat, pt) = user(&pool, "pat@example.com").await;
        let (sam, st) = user(&pool, "sam@example.com").await;
        let (id, code) = group(&app, &bt, &pt).await;
        send(&app, Method::POST, "/api/playgroups/join", Some(&st), Some(json!({ "code": code }))).await;
        sqlx::query("UPDATE playgroup_members SET created_at = '2030-01-01T00:00:00Z' WHERE playgroup_id = ? AND user_id = ?")
            .bind(&id).bind(&sam).execute(&pool).await.unwrap();
        // Pat has been in it longer than Sam, but Pat's account is turned off.
        sqlx::query("UPDATE users SET disabled_at = '2030-01-01T00:00:00Z' WHERE id = ?").bind(&pat).execute(&pool).await.unwrap();
        // (The test database has one connection, so it is given back before the next statement.)
        {
            let mut conn = pool.acquire().await.unwrap();
            assert_eq!(heir(&mut conn, &id, &bryan, true).await.unwrap(), Some(sam.clone()));
            assert_eq!(heir(&mut conn, &id, &bryan, false).await.unwrap(), Some(sam.clone()));
            assert_eq!(heir(&mut conn, &id, &sam, true).await.unwrap(), Some(bryan.clone()));
        }
        // With only Pat left beside Bryan, leaving finds nobody; account deletion still finds Pat.
        sqlx::query("DELETE FROM playgroup_members WHERE playgroup_id = ? AND user_id = ?").bind(&id).bind(&sam).execute(&pool).await.unwrap();
        {
            let mut conn = pool.acquire().await.unwrap();
            assert_eq!(heir(&mut conn, &id, &bryan, true).await.unwrap(), None);
            assert_eq!(heir(&mut conn, &id, &bryan, false).await.unwrap(), Some(pat.clone()));
        }
        let (status, body) = send(&app, Method::POST, &format!("/api/playgroups/{id}/leave"), Some(&bt), None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
    }

    #[tokio::test]
    async fn a_group_holds_only_so_many_members_and_an_account_only_so_many_groups() {
        let (app, pool) = app().await;
        let (bryan, bt) = user(&pool, "bryan@example.com").await;
        let (_, pt) = user(&pool, "pat@example.com").await;
        let (_, st) = user(&pool, "sam@example.com").await;
        let (id, code) = group(&app, &bt, &pt).await;
        for i in 2..MEMBERS_MAX {
            sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, guest_name, created_at) VALUES (?,?,?,?)")
                .bind(format!("g{i}")).bind(&id).bind(format!("Guest {i}")).bind(now()).execute(&pool).await.unwrap();
        }
        let (status, body) = send(&app, Method::POST, &format!("/api/playgroups/{id}/guests"), Some(&bt), Some(json!({ "name": "One more" }))).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        let (status, _) = send(&app, Method::POST, "/api/playgroups/join", Some(&st), Some(json!({ "code": code }))).await;
        assert_eq!(status, StatusCode::CONFLICT);
        // Someone already in it can still "join" (a no-op), full or not.
        let (status, _) = send(&app, Method::POST, "/api/playgroups/join", Some(&pt), Some(json!({ "code": code }))).await;
        assert_eq!(status, StatusCode::OK);

        for i in 1..OWNED_MAX {
            sqlx::query("INSERT INTO playgroups (id, name, owner_id, join_code, created_at) VALUES (?,?,?,?,?)")
                .bind(format!("pg{i}")).bind("More").bind(&bryan).bind(format!("CODE{i:02}")).bind(now()).execute(&pool).await.unwrap();
        }
        let (status, body) = send(&app, Method::POST, "/api/playgroups", Some(&bt), Some(json!({ "name": "Too many" }))).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
    }

    #[tokio::test]
    async fn playgroup_changes_are_rate_limited_per_account() {
        let (app, pool) = app().await;
        let (_, bt) = user(&pool, "bryan@example.com").await;
        let (_, pt) = user(&pool, "pat@example.com").await;
        let (id, _) = group(&app, &bt, &pt).await;
        let mut refused = None;
        for i in 0..200 {
            let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/code"), Some(&bt), None).await;
            if status == StatusCode::TOO_MANY_REQUESTS {
                refused = Some(i);
                break;
            }
            assert_eq!(status, StatusCode::OK);
        }
        assert!(refused.is_some(), "a script changing the code is stopped");
        // Another account has its own allowance.
        let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/guests"), Some(&pt), Some(json!({ "name": "Sam" }))).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/guests"), Some(&bt), Some(json!({ "name": "Jo" }))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn an_owner_who_leaves_hands_the_group_to_its_longest_standing_account() {
        let (app, pool) = app().await;
        let (bryan, bt) = user(&pool, "bryan@example.com").await;
        let (pat, pt) = user(&pool, "pat@example.com").await;
        let (sam, st) = user(&pool, "sam@example.com").await;
        let (id, code) = group(&app, &bt, &pt).await;
        // Sam joined after Pat (the timestamps are to the second, so set them apart).
        send(&app, Method::POST, "/api/playgroups/join", Some(&st), Some(json!({ "code": code }))).await;
        sqlx::query("UPDATE playgroup_members SET created_at = '2030-01-01T00:00:00Z' WHERE playgroup_id = ? AND user_id = ?")
            .bind(&id).bind(&sam).execute(&pool).await.unwrap();
        // A game Bryan sat in, by his member row.
        let g = detail(&app, &bt, &id).await;
        sqlx::query("INSERT INTO games (id, mode, playgroup_id, created_by, status, started_at) VALUES ('g1','in_person',?,?,'finished','2026-01-01T00:00:00Z')")
            .bind(&id).bind(&pat).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO game_seats (game_id, seat, member_id, user_id) VALUES ('g1', 0, ?, ?)")
            .bind(member_of(&g, &bryan)).bind(&bryan).execute(&pool).await.unwrap();

        // A member leaves: gone from the list, the owner and code unchanged.
        let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/leave"), Some(&st), None).await;
        assert_eq!(status, StatusCode::OK);
        let g = detail(&app, &bt, &id).await;
        assert_eq!((g["owner_id"].as_str(), g["join_code"].as_str(), g["members"].as_array().unwrap().len()), (Some(bryan.as_str()), Some(code.as_str()), 2));
        send(&app, Method::POST, "/api/playgroups/join", Some(&st), Some(json!({ "code": code }))).await;
        sqlx::query("UPDATE playgroup_members SET created_at = '2030-01-01T00:00:00Z' WHERE playgroup_id = ? AND user_id = ?")
            .bind(&id).bind(&sam).execute(&pool).await.unwrap();

        // The owner leaves: Pat, who has been in it longest, owns it; Bryan no longer sees it.
        let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/leave"), Some(&bt), None).await;
        assert_eq!(status, StatusCode::OK);
        let g = detail(&app, &pt, &id).await;
        assert_eq!(g["owner_id"], pat.as_str());
        assert_eq!(g["members"].as_array().unwrap().len(), 2);
        let (status, _) = send(&app, Method::GET, &format!("/api/playgroups/{id}"), Some(&bt), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // His seat in the group's game keeps his account and name, without the member row.
        let (member, account, name): (Option<String>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT member_id, user_id, guest_name FROM game_seats WHERE game_id = 'g1'").fetch_one(&pool).await.unwrap();
        assert_eq!((member, account.as_deref(), name.as_deref()), (None, Some(bryan.as_str()), Some("bryan")));

        // Sam's account is turned off: Pat can't hand the group to it, by choice or by leaving.
        sqlx::query("UPDATE users SET disabled_at = '2030-01-01T00:00:00Z' WHERE id = ?").bind(&sam).execute(&pool).await.unwrap();
        let g = detail(&app, &pt, &id).await;
        let (status, _) = send(&app, Method::POST, &format!("/api/playgroups/{id}/owner"), Some(&pt), Some(json!({ "member_id": member_of(&g, &sam) }))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, body) = send(&app, Method::POST, &format!("/api/playgroups/{id}/leave"), Some(&pt), None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(detail(&app, &pt, &id).await["owner_id"], pat.as_str());
        sqlx::query("UPDATE users SET disabled_at = NULL WHERE id = ?").bind(&sam).execute(&pool).await.unwrap();

        // Sam leaves; Pat, now alone, can't leave the group to nobody.
        send(&app, Method::POST, &format!("/api/playgroups/{id}/leave"), Some(&st), None).await;
        let (status, body) = send(&app, Method::POST, &format!("/api/playgroups/{id}/leave"), Some(&pt), None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(detail(&app, &pt, &id).await["owner_id"], pat.as_str());
    }

    #[tokio::test]
    async fn deleting_waits_for_other_accounts_to_go_and_keeps_the_games() {
        let (app, pool) = app().await;
        let (bryan, bt) = user(&pool, "bryan@example.com").await;
        let (pat, pt) = user(&pool, "pat@example.com").await;
        let (id, _) = group(&app, &bt, &pt).await;
        let (_, guest) = send(&app, Method::POST, &format!("/api/playgroups/{id}/guests"), Some(&bt), Some(json!({ "name": "Sam" }))).await;
        let guest = guest["id"].as_str().unwrap().to_string();
        let g = detail(&app, &bt, &id).await;
        sqlx::query("INSERT INTO games (id, mode, playgroup_id, created_by, status, started_at) VALUES ('g1','in_person',?,?,'finished','2026-01-01T00:00:00Z')")
            .bind(&id).bind(&bryan).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO game_seats (game_id, seat, member_id, user_id) VALUES ('g1', 0, ?, ?)")
            .bind(member_of(&g, &bryan)).bind(&bryan).execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO game_seats (game_id, seat, member_id) VALUES ('g1', 1, ?)").bind(&guest).execute(&pool).await.unwrap();

        // While Pat is in it, the history is Pat's too.
        let (status, body) = send(&app, Method::DELETE, &format!("/api/playgroups/{id}"), Some(&bt), None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(detail(&app, &pt, &id).await["members"].as_array().unwrap().len(), 3);

        let (status, _) = send(&app, Method::DELETE, &format!("/api/playgroups/{id}/members/{}", member_of(&g, &pat)), Some(&bt), None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = send(&app, Method::DELETE, &format!("/api/playgroups/{id}"), Some(&bt), None).await;
        assert_eq!(status, StatusCode::OK);

        let left: (i64, i64) = sqlx::query_as("SELECT (SELECT COUNT(*) FROM playgroups), (SELECT COUNT(*) FROM playgroup_members)").fetch_one(&pool).await.unwrap();
        assert_eq!(left, (0, 0));
        let (status, _) = send(&app, Method::GET, &format!("/api/playgroups/{id}"), Some(&bt), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        // The game stays in Bryan's history without the group; the guest's seat keeps the name.
        let group_of: Option<String> = sqlx::query_scalar("SELECT playgroup_id FROM games WHERE id = 'g1'").fetch_one(&pool).await.unwrap();
        assert_eq!(group_of, None);
        let seats: Vec<(i64, Option<String>, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT seat, member_id, user_id, guest_name FROM game_seats WHERE game_id = 'g1' ORDER BY seat").fetch_all(&pool).await.unwrap();
        assert_eq!(seats, vec![(0, None, Some(bryan.clone()), None), (1, None, None, Some("Sam".into()))]);
        let (status, games) = send(&app, Method::GET, "/api/games", Some(&bt), None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(games.as_array().unwrap().iter().any(|g| g["id"] == "g1"), "{games}");
    }
}
