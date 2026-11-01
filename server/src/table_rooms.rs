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
//! here (`PUT /live`, memory only, for a while) so the creator's own other devices can follow.
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
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/table/{game_id}/ws", get(connect))
        .route("/api/table/{game_id}/live", get(live).put(set_live).delete(clear_live))
}

#[derive(Default)]
pub struct Rooms {
    rooms: Mutex<HashMap<String, Room>>,
    /// Games shared through the Cloudflare relay, by game id.
    edge: Mutex<HashMap<String, EdgeShare>>,
}

/// A game its creator's phone is sharing on the Cloudflare relay.
struct EdgeShare {
    user: String,
    key: String,
    at: Instant,
}

/// How long a share key left here stays offered: longer than any game night. A phone that stops
/// sharing takes it back sooner.
const EDGE_TTL: Duration = Duration::from_secs(12 * 60 * 60);

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

/// Whether the creator's phone is sharing this game right now, so their other devices can offer
/// to follow it, with the Cloudflare relay's share key when it's there. Anyone else gets "no": a
/// game's room is only found with its share key.
async fn live(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(game_id): Path<String>) -> Json<serde_json::Value> {
    let edge = {
        let map = st.rooms.edge.lock().unwrap();
        map.get(&game_id).filter(|e| e.user == user.id && e.at.elapsed() < EDGE_TTL).map(|e| e.key.clone())
    };
    if let Some(key) = edge {
        return Json(serde_json::json!({ "hosting": true, "key": key }));
    }
    let map = st.rooms.rooms.lock().unwrap();
    let hosting = map.get(&game_id).is_some_and(|r| r.host_user.as_deref() == Some(user.id.as_str()) && r.host.is_some());
    Json(serde_json::json!({ "hosting": hosting }))
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
    let creator: Option<String> = sqlx::query_scalar("SELECT created_by FROM games WHERE id = ?")
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
    if host {
        let creator: Option<String> = sqlx::query_scalar("SELECT created_by FROM games WHERE id = ?")
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
            run_host(rooms, game_id, socket).await
        } else {
            run_guest(rooms, game_id, user.display_name, socket).await
        }
    }))
}

async fn run_host(rooms: Arc<Rooms>, game_id: String, socket: WebSocket) {
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
    while let Some(Ok(msg)) = stream.next().await {
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

async fn run_guest(rooms: Arc<Rooms>, game_id: String, name: String, socket: WebSocket) {
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
    while let Some(Ok(msg)) = stream.next().await {
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
}
