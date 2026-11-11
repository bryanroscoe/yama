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
//! guests, so anyone but an admin may host at most [`MAX_HOSTED`] tables at once. Guests' events
//! wait for the host's socket in a queue of at most [`HOST_QUEUE`]; each is at most
//! [`MAX_EVENT`] bytes, a guest sends at most [`GUEST_EVENTS`] per [`GUEST_WINDOW`], and a table
//! has at most [`MAX_GUESTS`] phones following. Past any of those the event (a tap, which can
//! be made again) is dropped, and a phone past the table's limit isn't let in, so a guest
//! holding the share key can't fill the server's memory. A room is forgotten when its last
//! phone leaves, host or guest.

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

impl Rooms {
    /// Forget a room with no host and no guests. A host leaving does this when no guest is
    /// connected; a guest leaving must too, or a room whose guests outlast its host would keep
    /// its last snapshot (up to [`MAX_MESSAGE`]) until the server restarts.
    fn forget_if_empty(&self, game_id: &str) {
        let mut map = self.rooms.lock().unwrap();
        if map.get(game_id).is_some_and(|r| r.host.is_none() && r.guests.receiver_count() == 0) {
            map.remove(game_id);
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
    host: Option<(u64, mpsc::Sender<String>)>,
    guests: broadcast::Sender<String>,
    next_conn: u64,
}

impl Room {
    /// A place among the phones following this table, if there is one: the guest's subscription
    /// to the host's snapshots. Called under the rooms lock, so counting and subscribing are one
    /// step and connections arriving together can't all slip under [`MAX_GUESTS`].
    fn admit(&self) -> Option<broadcast::Receiver<String>> {
        (self.guests.receiver_count() < MAX_GUESTS).then(|| self.guests.subscribe())
    }

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
/// Guests' events waiting for the host's socket. A host that far behind loses the newest ones.
const HOST_QUEUE: usize = 256;
/// The largest event a guest may send. An event is a tap: a few hundred bytes.
const MAX_EVENT: usize = 16 * 1024;
/// Events one guest may send in each [`GUEST_WINDOW`]: 30 a second, faster than fingers.
const GUEST_EVENTS: usize = 300;
const GUEST_WINDOW: Duration = Duration::from_secs(10);
/// Phones following one table at once (a pod is six; spectators and second devices are extra).
const MAX_GUESTS: usize = 32;

/// Counts one guest's events per window.
struct Throttle {
    window_start: Instant,
    count: usize,
}

impl Throttle {
    fn new(now: Instant) -> Self {
        Self { window_start: now, count: 0 }
    }

    /// Whether another event may go through at `now`.
    fn allow(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.window_start) >= GUEST_WINDOW {
            self.window_start = now;
            self.count = 0;
        }
        self.count += 1;
        self.count <= GUEST_EVENTS
    }
}

/// What a guest's text frame becomes for the host: the event, stamped with who sent it. None
/// for anything that isn't an event, is too large, or is past the guest's rate.
fn guest_event(text: &str, from: &str, throttle: &mut Throttle, now: Instant) -> Option<String> {
    if text.len() > MAX_EVENT {
        return None;
    }
    let mut value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    if value.get("type").and_then(|t| t.as_str()) != Some("event") || !throttle.allow(now) {
        return None;
    }
    value["from"] = serde_json::Value::String(from.to_string());
    Some(value.to_string())
}
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
        let map = st.rooms.rooms.lock().unwrap();
        // Rooms still in use: a host or guests connected.
        let hosted = map
            .iter()
            .filter(|(id, r)| **id != game_id && r.host_user.as_deref() == Some(user.id.as_str()))
            .filter(|(_, r)| r.host.is_some() || r.guests.receiver_count() > 0)
            .count();
        if !user.is_admin && hosted >= MAX_HOSTED {
            return Err(AppError::Conflict(format!("You're sharing {hosted} tables already. Close one on its phone first.")));
        }
        // The room itself is made when the socket opens (`run_host`), so a request that never
        // upgrades leaves nothing behind.
    } else {
        let map = st.rooms.rooms.lock().unwrap();
        if !guest_may_join(map.get(&game_id), &user.id, &p.key) {
            return Err(AppError::Forbidden("that table link has expired; scan the code again".into()));
        }
        // A first, early refusal. A browser can't read a refused upgrade's reason, so the page
        // only sees that it couldn't connect; `run_guest` makes the check that holds.
        if map.get(&game_id).is_some_and(|r| r.guests.receiver_count() >= MAX_GUESTS) {
            return Err(AppError::Conflict("That table has as many phones following as it can take.".into()));
        }
    }
    let rooms = st.rooms.clone();
    Ok(ws.max_message_size(MAX_MESSAGE).on_upgrade(move |socket| async move {
        if host {
            run_host(rooms, game_id, user.id, p.key, ended, socket).await
        } else {
            run_guest(rooms, game_id, user.id, user.display_name, ended, socket).await
        }
    }))
}

async fn run_host(rooms: Arc<Rooms>, game_id: String, user_id: String, key: String, mut ended: broadcast::Receiver<String>, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(HOST_QUEUE);
    let (conn, guests) = {
        let mut map = rooms.rooms.lock().unwrap();
        let room = map.entry(game_id.clone()).or_insert_with(Room::new);
        // Set here, on every host connection: the room may be new, or made again after the
        // last phone left it.
        room.key = Some(key);
        room.host_user = Some(user_id.clone());
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
    let mut throttle = Throttle::new(Instant::now());
    let (mut sink, mut stream) = socket.split();
    let admitted = {
        let map = rooms.rooms.lock().unwrap();
        // A room that went away since `connect` let this guest in isn't made again here.
        let place = map.get(&game_id).and_then(|room| room.admit().map(|updates| (updates, room.snapshot.clone(), room.host.is_some())));
        place
    };
    // Gone or full (this is the check that holds when several arrive at once): the socket closes.
    let Some((mut updates, snapshot, host_connected)) = admitted else { return };
    let hello = format!(r#"{{"type":"host","connected":{host_connected}}}"#);
    let greeted = sink.send(Message::Text(hello.into())).await.is_ok()
        && match snapshot {
            Some(s) => sink.send(Message::Text(s.into())).await.is_ok(),
            None => true,
        };
    if !greeted {
        drop(updates);
        rooms.forget_if_empty(&game_id);
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
        let Some(event) = guest_event(&text, &name, &mut throttle, Instant::now()) else { continue };
        let host = rooms.rooms.lock().unwrap().get(&game_id).and_then(|r| r.host.as_ref().map(|(_, tx)| tx.clone()));
        if let Some(tx) = host {
            // A full queue (the host's phone is far behind) drops the event rather than grow.
            let _ = tx.try_send(event);
        }
    }
    // The task holds this guest's place (its subscription): once it is gone, a room nobody is
    // in any more is forgotten.
    forward.abort();
    let _ = forward.await;
    rooms.forget_if_empty(&game_id);
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
        server_room.host = Some((1, mpsc::channel(HOST_QUEUE).0));
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
    fn a_guests_events_are_stamped_bounded_and_rate_limited() {
        let t0 = Instant::now();
        let mut throttle = Throttle::new(t0);
        // An event goes to the host with who sent it; a "from" the guest wrote is replaced.
        let sent = guest_event(r#"{"type":"event","event":{"kind":"life","seat":1,"delta":-1},"from":"the host"}"#, "Pat", &mut throttle, t0).unwrap();
        let sent: serde_json::Value = serde_json::from_str(&sent).unwrap();
        assert_eq!((sent["from"].as_str(), sent["event"]["delta"].as_i64()), (Some("Pat"), Some(-1)));
        // Anything else is dropped: a snapshot (only the host sends those), junk, and an
        // event too large to be a tap. None of them uses up the guest's allowance.
        let huge = format!(r#"{{"type":"event","event":{{"pad":"{}"}}}}"#, "x".repeat(MAX_EVENT));
        for dropped in [r#"{"type":"state","players":[]}"#, "not json", "[]", huge.as_str()] {
            assert!(guest_event(dropped, "Pat", &mut throttle, t0).is_none());
        }
        assert_eq!(throttle.count, 1);
        // A flood stops at the allowance and resumes with the next window.
        let event = r#"{"type":"event","event":{}}"#;
        let through = (0..GUEST_EVENTS * 3).filter(|_| guest_event(event, "Pat", &mut throttle, t0 + Duration::from_secs(1)).is_some()).count();
        assert_eq!(through, GUEST_EVENTS - 1);
        assert!(guest_event(event, "Pat", &mut throttle, t0 + GUEST_WINDOW - Duration::from_millis(1)).is_none());
        assert!(guest_event(event, "Pat", &mut throttle, t0 + GUEST_WINDOW).is_some());
    }

    #[test]
    fn a_table_admits_only_so_many_guests() {
        let table = room(&"k".repeat(32), "host");
        // Counting and subscribing are one step (`admit`, under the rooms lock in `run_guest`),
        // so however many connect together, MAX_GUESTS get a place.
        let mut seated: Vec<_> = (0..MAX_GUESTS + 5).filter_map(|_| table.admit()).collect();
        assert_eq!(seated.len(), MAX_GUESTS);
        assert!(table.admit().is_none());
        // A guest leaving frees one place.
        seated.pop();
        seated.extend(table.admit());
        assert_eq!(seated.len(), MAX_GUESTS);
        assert!(table.admit().is_none());
    }

    #[test]
    fn a_room_is_forgotten_when_its_last_phone_leaves() {
        let rooms = Rooms::default();
        let mut table = room(&"k".repeat(32), "host");
        table.snapshot = Some("{\"type\":\"state\"}".into());
        table.host = Some((1, mpsc::channel(HOST_QUEUE).0));
        let guest = table.admit().unwrap();
        rooms.rooms.lock().unwrap().insert("game".into(), table);
        let there = |rooms: &Rooms| rooms.rooms.lock().unwrap().contains_key("game");
        // With its host, or with a guest still following, it stays (and keeps its snapshot).
        rooms.forget_if_empty("game");
        assert!(there(&rooms));
        rooms.rooms.lock().unwrap().get_mut("game").unwrap().host = None;
        rooms.forget_if_empty("game");
        assert!(there(&rooms), "a guest is still following");
        // The guests outlasted the host; when the last of them goes, so does the room.
        drop(guest);
        rooms.forget_if_empty("game");
        assert!(!there(&rooms));
        rooms.forget_if_empty("game");
    }

    #[test]
    fn the_hosts_queue_is_bounded() {
        // What `run_guest` does with an event: `try_send` into the host's queue. Once the host
        // has fallen HOST_QUEUE events behind, more are dropped instead of kept.
        let (tx, mut rx) = mpsc::channel::<String>(HOST_QUEUE);
        let kept = (0..HOST_QUEUE * 4).filter(|i| tx.try_send(i.to_string()).is_ok()).count();
        assert_eq!(kept, HOST_QUEUE);
        assert_eq!(rx.try_recv().unwrap(), "0");
        assert!(tx.try_send("room again".into()).is_ok());
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
