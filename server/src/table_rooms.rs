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

use crate::auth::CurrentUser;
use crate::routes::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/table/{game_id}/ws", get(connect))
}

#[derive(Default)]
pub struct Rooms {
    rooms: Mutex<HashMap<String, Room>>,
}

struct Room {
    snapshot: Option<String>,
    host: Option<(u64, mpsc::UnboundedSender<String>)>,
    guests: broadcast::Sender<String>,
    next_conn: u64,
}

impl Room {
    fn new() -> Self {
        Self { snapshot: None, host: None, guests: broadcast::channel(64).0, next_conn: 0 }
    }
}

#[derive(Deserialize)]
struct ConnectParams {
    role: String,
}

const MAX_MESSAGE: usize = 512 * 1024;

async fn connect(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(game_id): Path<String>,
    Query(p): Query<ConnectParams>,
    ws: WebSocketUpgrade,
) -> Response {
    let rooms = st.rooms.clone();
    let host = p.role == "host";
    ws.max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| async move {
            if host {
                run_host(rooms, game_id, socket).await
            } else {
                run_guest(rooms, game_id, user.display_name, socket).await
            }
        })
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
