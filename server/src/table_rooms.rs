//! Shared table: every phone at the table follows one life-counter game.
//!
//! The host phone stays authoritative (it owns the event log and works offline). The server is
//! a relay: guests' events go to the host, and the host's state snapshots go to every guest.
//! The latest snapshot is kept in memory so late joiners and reconnecting guests catch up.
//!
//! Wire messages (JSON text frames):
//!   host  → server: {"type":"state", ...snapshot}
//!   guest → server: {"type":"event", "event": {...}}
//!   server → guest: the host's snapshot, or {"type":"host", "connected": bool}
//!   server → host:  {"type":"event", "event": {...}, "from": "<user name>"}
//!
//! Access: only the game's creator may host. The host picks a random share key (it travels in
//! the QR code's URL fragment, never in a page request), and guests must present the same key.
//! The creator's own other devices (a laptop following the game on their phone) may join
//! without it: it's their game.
//!
//! Production tables meet on Yama's Cloudflare relay instead (`relay/`), which keeps working when
//! this server is offline and needs no account. For those, the host phone leaves the share key
//! here (`PUT /live`, memory only, for a while) so the creator and the selected group can follow.
//!
//! Memory: a room keeps its newest snapshot (at most [`MAX_MESSAGE`]) and a short backlog for slow
//! guests, so anyone but an admin may host at most [`MAX_HOSTED`] tables at once.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/table/active", get(active))
        .route("/api/table/{game_id}/ws", get(connect))
        .route("/api/table/{game_id}/live", get(live).put(set_live).delete(clear_live))
}

pub struct Rooms {
    rooms: Mutex<HashMap<String, Room>>,
    /// Games shared through the Cloudflare relay, by game id.
    edge: Mutex<HashMap<String, EdgeShare>>,
    /// Accounts deleted while connected (their ids), and the tables they hosted (`room:<game id>`):
    /// each socket of that account, or following that table, ends (`end_for`).
    ended: broadcast::Sender<String>,
}

impl Default for Rooms {
    fn default() -> Self {
        Self { rooms: Mutex::default(), edge: Mutex::default(), ended: broadcast::channel(BACKLOG).0 }
    }
}

impl Rooms {
    /// An account was deleted: the tables it hosts close for their guests, it stops following
    /// other people's, and the relay share keys it left here are forgotten.
    pub fn end_for(&self, user_id: &str) {
        self.edge.lock().unwrap().retain(|_, e| e.user != user_id);
        let _ = self.ended.send(user_id.to_string());
        let mut closed = Vec::new();
        self.rooms.lock().unwrap().retain(|game, r| {
            let hosted = r.host_user.as_deref() == Some(user_id);
            if hosted {
                closed.push(game.clone());
            }
            !hosted
        });
        for game in closed {
            let _ = self.ended.send(room_end(&game));
        }
    }
}

/// The `ended` message that closes every socket following a table.
fn room_end(game_id: &str) -> String {
    format!("room:{game_id}")
}

/// Whether a socket's loop should end on this `ended` message: it names one of `ids` (its account,
/// or for a guest its table too; `Rooms::end_for`).
fn ended_for(gone: Result<String, broadcast::error::RecvError>, ids: &[&str]) -> bool {
    match gone {
        Ok(id) => ids.contains(&id.as_str()),
        // Notices were missed (many deletions at once): one may have been for this socket. End it;
        // a phone that's still allowed reconnects, and `connect` refuses a deleted account.
        Err(broadcast::error::RecvError::Lagged(_)) => true,
        Err(broadcast::error::RecvError::Closed) => true,
    }
}

/// A game its creator's phone is sharing on the Cloudflare relay.
struct EdgeShare {
    user: String,
    key: String,
    at: Instant,
}

/// How long a share key left here stays offered. The sharing phone leaves it again every
/// minute and takes it back when it stops, so one that closes without stopping (or loses its
/// signal) stops being offered soon.
const EDGE_TTL: Duration = Duration::from_secs(3 * 60);

struct Room {
    /// Set by the host; guests must match it.
    key: Option<String>,
    /// The account hosting it.
    host_user: Option<String>,
    snapshot: Option<String>,
    host: Option<(u64, mpsc::UnboundedSender<String>)>,
    guests: broadcast::Sender<String>,
    next_conn: u64,
}

impl Room {
    fn new() -> Self {
        Self { key: None, host_user: None, snapshot: None, host: None, guests: broadcast::channel(BACKLOG).0, next_conn: 0 }
    }
}

#[derive(Deserialize)]
struct ConnectParams {
    role: String,
    #[serde(default)]
    key: String,
}

/// Only current, explicitly shared in-person games are discoverable. Selecting a playgroup
/// shares its live counter with current members, never the game's private log or account data.
#[derive(Serialize, sqlx::FromRow)]
struct ActiveTable {
    id: String,
    group_name: Option<String>,
    host_name: String,
    started_at: String,
    #[sqlx(skip)]
    key: Option<String>,
    #[sqlx(skip)]
    relay: String,
}

async fn active_tables(st: &AppState, user: &str) -> AppResult<Vec<ActiveTable>> {
    // Copy credentials before any await; the room locks never span database I/O.
    let mut shared: HashMap<String, (Option<String>, &str)> = st.rooms.rooms.lock().unwrap().iter()
        .filter(|(_, r)| r.host.is_some())
        .map(|(id, r)| (id.clone(), (r.key.clone(), "server"))).collect();
    for (id, e) in st.rooms.edge.lock().unwrap().iter().filter(|(_, e)| e.at.elapsed() < EDGE_TTL) {
        shared.insert(id.clone(), (Some(e.key.clone()), "edge"));
    }
    if shared.is_empty() { return Ok(Vec::new()); }
    let ids = serde_json::to_string(&shared.keys().collect::<Vec<_>>()).unwrap();
    let mut tables: Vec<ActiveTable> = sqlx::query_as(
        "SELECT g.id, pg.name AS group_name, u.display_name AS host_name, g.started_at
         FROM games g JOIN users u ON u.id = g.created_by
         LEFT JOIN playgroups pg ON pg.id = g.playgroup_id
         WHERE g.id IN (SELECT value FROM json_each(?)) AND g.mode = 'in_person'
           AND g.status = 'in_progress' AND u.disabled_at IS NULL
           AND (g.created_by = ? OR pg.owner_id = ? OR EXISTS (
             SELECT 1 FROM playgroup_members m WHERE m.playgroup_id = pg.id AND m.user_id = ?))
         ORDER BY g.started_at DESC, g.id",
    ).bind(ids).bind(user).bind(user).bind(user).fetch_all(&st.pool).await?;
    for table in &mut tables {
        let (key, relay) = shared.remove(&table.id).unwrap();
        table.key = key;
        table.relay = relay.into();
    }
    Ok(tables)
}

async fn active(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<ActiveTable>>> {
    Ok(Json(active_tables(&st, &user.id).await?))
}

async fn live(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(game_id): Path<String>) -> AppResult<Json<serde_json::Value>> {
    let table = active_tables(&st, &user.id).await?.into_iter().find(|t| t.id == game_id);
    Ok(Json(match table {
        Some(t) => serde_json::json!({ "hosting": true, "key": t.key, "relay": t.relay }),
        None => serde_json::json!({ "hosting": false }),
    }))
}

#[derive(Deserialize)]
struct SetLive {
    key: String,
}

/// A share key from the relay: 32 lowercase hex characters (packages/core relayKey.ts).
fn is_relay_key(key: &str) -> bool {
    key.len() == 32 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The creator's phone is sharing this game on the Cloudflare relay.
async fn set_live(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(game_id): Path<String>,
    Json(body): Json<SetLive>,
) -> AppResult<Json<serde_json::Value>> {
    if !is_relay_key(&body.key) {
        return Err(AppError::bad("not a share key"));
    }
    let creator: Option<String> = sqlx::query_scalar("SELECT created_by FROM games WHERE id = ? AND mode = 'in_person' AND status = 'in_progress'")
        .bind(&game_id)
        .fetch_optional(&st.pool)
        .await?;
    if creator.as_deref() != Some(user.id.as_str()) {
        return Err(AppError::Forbidden("only the phone that started this game can share it".into()));
    }
    let mut map = st.rooms.edge.lock().unwrap();
    map.retain(|_, e| e.at.elapsed() < EDGE_TTL);
    let others = map.iter().filter(|(id, e)| **id != game_id && e.user == user.id).count();
    if !user.is_admin && others >= MAX_HOSTED {
        return Err(AppError::Conflict(format!("You're sharing {others} tables already. Close one on its phone first.")));
    }
    map.insert(game_id, EdgeShare { user: user.id, key: body.key, at: Instant::now() });
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// It stopped sharing.
async fn clear_live(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(game_id): Path<String>) -> Json<serde_json::Value> {
    let mut map = st.rooms.edge.lock().unwrap();
    if map.get(&game_id).is_some_and(|e| e.user == user.id) {
        map.remove(&game_id);
    }
    Json(serde_json::json!({ "ok": true }))
}

/// A guest may join with the room's share key, or as the account hosting it.
fn guest_may_join(room: Option<&Room>, user: &str, key: &str) -> bool {
    let Some(room) = room else { return false };
    let by_key = key.len() >= 16 && room.key.as_deref() == Some(key);
    by_key || room.host_user.as_deref() == Some(user)
}

const MAX_MESSAGE: usize = 512 * 1024;
/// Snapshots kept for a guest that falls behind (it skips to the newest, which carries everything).
const BACKLOG: usize = 16;
/// Tables one account (not an admin) may host at once.
pub const MAX_HOSTED: usize = 4;

async fn connect(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(game_id): Path<String>,
    Query(p): Query<ConnectParams>,
    ws: WebSocketUpgrade,
) -> AppResult<Response> {
    let host = p.role == "host";
    if host && p.key.len() < 16 {
        return Err(AppError::bad("missing share key"));
    }
    // Hear a deletion of this account from now on, then check it still exists: a deletion that
    // committed before this subscribed (`Rooms::end_for` runs after the commit) is caught here.
    let ended = st.rooms.ended.subscribe();
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users WHERE id = ?)").bind(&user.id).fetch_one(&st.pool).await?;
    if !exists {
        return Err(AppError::Unauthorized);
    }
    if host {
        let creator: Option<String> = sqlx::query_scalar("SELECT created_by FROM games WHERE id = ? AND mode = 'in_person' AND status = 'in_progress'")
            .bind(&game_id)
            .fetch_optional(&st.pool)
            .await?;
        if creator.as_deref() != Some(user.id.as_str()) {
            return Err(AppError::Forbidden("only the phone that started this game can share it".into()));
        }
        let mut map = st.rooms.rooms.lock().unwrap();
        // Rooms still in use: a host or guests connected (one whose upgrade never finished doesn't count).
        let hosted = map
            .iter()
            .filter(|(id, r)| **id != game_id && r.host_user.as_deref() == Some(user.id.as_str()))
            .filter(|(_, r)| r.host.is_some() || r.guests.receiver_count() > 0)
            .count();
        if !user.is_admin && hosted >= MAX_HOSTED {
            return Err(AppError::Conflict(format!("You're sharing {hosted} tables already. Close one on its phone first.")));
        }
        let room = map.entry(game_id.clone()).or_insert_with(Room::new);
        room.key = Some(p.key.clone());
        room.host_user = Some(user.id.clone());
    } else {
        let map = st.rooms.rooms.lock().unwrap();
        if !guest_may_join(map.get(&game_id), &user.id, &p.key) {
            return Err(AppError::Forbidden("that table link has expired; scan the code again".into()));
        }
    }
    let rooms = st.rooms.clone();
    Ok(ws.max_message_size(MAX_MESSAGE).on_upgrade(move |socket| async move {
        if host {
            run_host(rooms, game_id, user.id, ended, socket).await
        } else {
            run_guest(rooms, game_id, user.id, user.display_name, ended, socket).await
        }
    }))
}

async fn run_host(rooms: Arc<Rooms>, game_id: String, user_id: String, mut ended: broadcast::Receiver<String>, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let (conn, guests) = {
        let mut map = rooms.rooms.lock().unwrap();
        let room = map.entry(game_id.clone()).or_insert_with(Room::new);
        room.next_conn += 1;
        // A newer host connection (e.g. after a reconnect) replaces the old one.
        room.host = Some((room.next_conn, tx));
        (room.next_conn, room.guests.clone())
    };
    let _ = guests.send(r#"{"type":"host","connected":true}"#.into());

    let forward = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });
    loop {
        let msg = tokio::select! {
            msg = stream.next() => msg,
            gone = ended.recv() => if ended_for(gone, &[user_id.as_str()]) { break } else { continue },
        };
        let Some(Ok(msg)) = msg else { break };
        if let Message::Text(text) = msg {
            let text = text.to_string();
            if text.contains(r#""type":"state""#) {
                if let Some(room) = rooms.rooms.lock().unwrap().get_mut(&game_id) {
                    room.snapshot = Some(text.clone());
                }
                let _ = guests.send(text);
            }
        }
    }
    forward.abort();
    let mut map = rooms.rooms.lock().unwrap();
    if let Some(room) = map.get_mut(&game_id) && room.host.as_ref().is_some_and(|(c, _)| *c == conn) {
        room.host = None;
        let _ = room.guests.send(r#"{"type":"host","connected":false}"#.into());
        if room.guests.receiver_count() == 0 {
            map.remove(&game_id);
        }
    }
}

async fn run_guest(
    rooms: Arc<Rooms>,
    game_id: String,
    user_id: String,
    name: String,
    mut ended: broadcast::Receiver<String>,
    socket: WebSocket,
) {
    let table = room_end(&game_id);
    let (mut sink, mut stream) = socket.split();
    let (mut updates, snapshot, host_connected) = {
        let mut map = rooms.rooms.lock().unwrap();
        let room = map.entry(game_id.clone()).or_insert_with(Room::new);
        (room.guests.subscribe(), room.snapshot.clone(), room.host.is_some())
    };
    let hello = format!(r#"{{"type":"host","connected":{host_connected}}}"#);
    if sink.send(Message::Text(hello.into())).await.is_err() {
        return;
    }
    if let Some(s) = snapshot && sink.send(Message::Text(s.into())).await.is_err() {
        return;
    }
    let forward = tokio::spawn(async move {
        loop {
            match updates.recv().await {
                Ok(msg) => {
                    if sink.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                // Missed some snapshots; the next one carries the full state anyway.
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    loop {
        let msg = tokio::select! {
            msg = stream.next() => msg,
            gone = ended.recv() => if ended_for(gone, &[user_id.as_str(), table.as_str()]) { break } else { continue },
        };
        let Some(Ok(msg)) = msg else { break };
        let Message::Text(text) = msg else { continue };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        if value.get("type").and_then(|t| t.as_str()) != Some("event") {
            continue;
        }
        value["from"] = serde_json::Value::String(name.clone());
        let host = rooms.rooms.lock().unwrap().get(&game_id).and_then(|r| r.host.as_ref().map(|(_, tx)| tx.clone()));
        if let Some(tx) = host {
            let _ = tx.send(value.to_string());
        }
    }
    forward.abort();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room(key: &str, host: &str) -> Room {
        let mut r = Room::new();
        r.key = Some(key.into());
        r.host_user = Some(host.into());
        r
    }

    #[tokio::test]
    async fn live_discovery_requires_current_membership_and_a_current_shared_game() {
        use crate::testutil::{config, send, state_with, user};
        use axum::http::{Method, StatusCode};
        use serde_json::json;
        let pool = crate::db::test_pool().await;
        let (host, ht) = user(&pool, "host@example.com").await;
        let (member, mt) = user(&pool, "member@example.com").await;
        let (_, outsider) = user(&pool, "outsider@example.com").await;
        let state = state_with(config(), pool.clone()).await;
        let app = crate::routes::app(state.clone());
        let (_, pg) = send(&app, Method::POST, "/api/playgroups", Some(&ht), Some(json!({"name":"Magic Bros"}))).await;
        let pg = pg["id"].as_str().unwrap();
        sqlx::query("INSERT INTO playgroup_members (id, playgroup_id, user_id, created_at) VALUES ('friend', ?, ?, 'now')")
            .bind(pg).bind(&member).execute(&pool).await.unwrap();
        for (id, group, status, mode) in [
            ("live", Some(pg), "in_progress", "in_person"),
            ("finished", Some(pg), "finished", "in_person"),
            ("private", None, "in_progress", "in_person"),
            ("expired", Some(pg), "in_progress", "in_person"),
            ("unshared", Some(pg), "in_progress", "in_person"),
            ("online", Some(pg), "in_progress", "online"),
            ("server", Some(pg), "in_progress", "in_person"),
        ] {
            sqlx::query("INSERT INTO games (id, mode, created_by, playgroup_id, format, status, starting_life, started_at, note) VALUES (?, ?, ?, ?, 'commander', ?, 40, '2026-11-02T19:00:00Z', 'private note')")
                .bind(id).bind(mode).bind(&host).bind(group).bind(status).execute(&pool).await.unwrap();
            if id != "unshared" && id != "server" {
                state.rooms.edge.lock().unwrap().insert(id.into(), EdgeShare { user: host.clone(), key: "a".repeat(32), at: if id == "expired" { Instant::now() - EDGE_TTL } else { Instant::now() } });
            }
        }
        let mut server_room = room(&"b".repeat(32), &host);
        server_room.host = Some((1, mpsc::unbounded_channel().0));
        state.rooms.rooms.lock().unwrap().insert("server".into(), server_room);
        let (_, own) = send(&app, Method::GET, "/api/table/active", Some(&ht), None).await;
        assert_eq!(own.as_array().unwrap().len(), 3, "creator sees their private and group counters: {own}");
        let (_, group) = send(&app, Method::GET, "/api/table/active", Some(&mt), None).await;
        assert_eq!(group.as_array().unwrap().len(), 2, "{group}");
        assert_eq!(group[0]["group_name"], "Magic Bros");
        assert!(!group.to_string().contains("private note"));
        assert!(group.as_array().unwrap().iter().any(|t| t["id"] == "live" && t["relay"] == "edge" && t["key"] == "a".repeat(32)));
        assert!(group.as_array().unwrap().iter().any(|t| t["id"] == "server" && t["relay"] == "server" && t["key"] == "b".repeat(32)));
        assert_eq!(send(&app, Method::GET, "/api/table/live/live", Some(&mt), None).await.1["hosting"], true);
        assert_eq!(send(&app, Method::GET, "/api/table/private/live", Some(&mt), None).await.1["hosting"], false);
        assert_eq!(send(&app, Method::GET, "/api/table/active", Some(&outsider), None).await.1, json!([]));
        assert_eq!(send(&app, Method::GET, "/api/table/live/live", Some(&outsider), None).await.1, json!({"hosting":false}));
        assert_eq!(send(&app, Method::GET, "/api/table/active", None, None).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(send(&app, Method::PUT, "/api/table/live/live", Some(&mt), Some(json!({"key":"c".repeat(32)}))).await.0, StatusCode::FORBIDDEN);
        assert_eq!(send(&app, Method::PUT, "/api/table/finished/live", Some(&ht), Some(json!({"key":"c".repeat(32)}))).await.0, StatusCode::FORBIDDEN);
        sqlx::query("DELETE FROM playgroup_members WHERE id = 'friend'").execute(&pool).await.unwrap();
        assert_eq!(send(&app, Method::GET, "/api/table/active", Some(&mt), None).await.1, json!([]));
        sqlx::query("UPDATE users SET disabled_at = 'now' WHERE id = ?").bind(&host).execute(&pool).await.unwrap();
        assert!(active_tables(&state, &host).await.unwrap().is_empty());
    }

    #[test]
    fn guests_need_the_key_unless_its_the_hosts_own_account() {
        let key = "0123456789abcdef0123";
        let r = room(key, "bryan");
        assert!(guest_may_join(Some(&r), "sam", key));
        assert!(!guest_may_join(Some(&r), "sam", "0123456789abcdef9999"));
        assert!(!guest_may_join(Some(&r), "sam", ""));
        // The host following on their laptop, no key in hand.
        assert!(guest_may_join(Some(&r), "bryan", ""));
        // No room: nobody, not even the creator, joins a game that isn't being shared.
        assert!(!guest_may_join(None, "bryan", key));
        // A short key never matches, even a short stored one.
        let short = room("abc", "bryan");
        assert!(!guest_may_join(Some(&short), "sam", "abc"));
    }

    #[test]
    fn deleting_an_account_closes_its_tables_and_ends_its_sockets() {
        let rooms = Rooms::default();
        rooms.rooms.lock().unwrap().insert("ann-game".into(), room("0123456789abcdef0123", "ann"));
        rooms.rooms.lock().unwrap().insert("bob-game".into(), room("0123456789abcdef0123", "bob"));
        rooms.edge.lock().unwrap().insert("ann-edge".into(), EdgeShare { user: "ann".into(), key: "k".into(), at: Instant::now() });
        let mut ended = rooms.ended.subscribe();
        rooms.end_for("ann");
        let map = rooms.rooms.lock().unwrap();
        assert!(!map.contains_key("ann-game") && map.contains_key("bob-game"), "only the deleted account's table closes");
        assert!(rooms.edge.lock().unwrap().is_empty());
        let gone = ended.try_recv().unwrap();
        assert!(ended_for(Ok(gone.clone()), &["ann"]), "ann's sockets end");
        assert!(!ended_for(Ok(gone), &["bob"]), "bob's don't");
        // Then her table closes for whoever follows it, and only hers.
        let table = ended.try_recv().unwrap();
        assert!(ended_for(Ok(table.clone()), &["sam", room_end("ann-game").as_str()]), "sam, following ann's table, leaves");
        assert!(!ended_for(Ok(table), &["sam", room_end("bob-game").as_str()]), "bob's table carries on");
        assert!(ended_for(Err(broadcast::error::RecvError::Lagged(3)), &["bob"]), "missed notices end the socket to be safe");
    }
}
