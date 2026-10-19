//! Game history export: every finished game a user recorded or played in, or every finished
//! game of a playgroup, as JSON or CSV.
//!
//! The JSON is shaped for `commander-decks/data/games.json`: a top-level `games` list whose
//! entries lead with the fields its README asks for (date, deck and version, player count,
//! result, notes), seen from the exporting player's seat, followed by the whole game (every
//! seat, the first player, the winner and how they won, knockouts and fun ratings). The CSV has
//! one row per seat with the same facts.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::playgroups::is_member;
use crate::routes::AppState;
use crate::stats::{GameFacts, Scope, finished_games};
use crate::util::now;
use axum::extract::{Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/games/export.json", get(export_json)).route("/api/games/export.csv", get(export_csv))
}

pub const FORMAT: &str = "yama-games/1";

#[derive(Deserialize)]
struct Params {
    playgroup: Option<String>,
    /// The browser's offset from UTC in minutes (e.g. -300 for US Central in summer), so each
    /// game's `date` is the local day it was played. UTC without it.
    offset: Option<i32>,
}

/// A deck version as the export names it.
#[derive(Clone, Debug, Default, Serialize)]
pub struct VersionLabel {
    pub deck: String,
    /// "Fantastic Four v3": the deck's name and the version's place among its saves.
    pub label: String,
    pub note: Option<String>,
    pub saved_at: String,
}

async fn version_labels(pool: &SqlitePool, games: &[GameFacts]) -> AppResult<HashMap<String, VersionLabel>> {
    let mut out = HashMap::new();
    // Collected first: an iterator of closures held across an await isn't Send.
    let ids: Vec<String> = games.iter().flat_map(|g| g.seats.iter().filter_map(|s| s.deck_version_id.clone())).collect();
    for v in ids {
        if out.contains_key(&v) {
            continue;
        }
        let row: Option<(String, Option<String>, String, i64)> = sqlx::query_as(
            "SELECT d.name, v.note, v.created_at,
                    (SELECT COUNT(*) FROM deck_versions w WHERE w.deck_id = v.deck_id
                       AND (w.created_at < v.created_at OR (w.created_at = v.created_at AND w.rowid <= v.rowid)))
             FROM deck_versions v JOIN decks d ON d.id = v.deck_id WHERE v.id = ?",
        )
        .bind(&v)
        .fetch_optional(pool)
        .await?;
        if let Some((deck, note, saved_at, number)) = row {
            out.insert(v, VersionLabel { label: format!("{deck} v{number}"), deck, note, saved_at });
        }
    }
    Ok(out)
}

struct Export {
    games: Vec<GameFacts>,
    labels: HashMap<String, VersionLabel>,
    scope: Value,
    offset_minutes: i32,
    me: String,
}

async fn load(st: &AppState, user: &str, p: &Params) -> AppResult<Export> {
    let (games, scope) = match &p.playgroup {
        Some(pg) => {
            if !is_member(&st.pool, pg, user).await? {
                return Err(AppError::NotFound("playgroup"));
            }
            let name: Option<String> = sqlx::query_scalar("SELECT name FROM playgroups WHERE id = ?").bind(pg).fetch_optional(&st.pool).await?;
            (finished_games(&st.pool, Scope::Playgroup(pg)).await?, json!({ "kind": "playgroup", "id": pg, "name": name }))
        }
        None => (finished_games(&st.pool, Scope::User(user)).await?, json!({ "kind": "user" })),
    };
    let labels = version_labels(&st.pool, &games).await?;
    let offset_minutes = p.offset.unwrap_or(0).clamp(-14 * 60, 14 * 60);
    Ok(Export { games, labels, scope, offset_minutes, me: user.to_string() })
}

/// The local day a game was played: its start, shifted by the viewer's UTC offset.
pub fn local_date(started_at: &str, offset_minutes: i32) -> String {
    match chrono::DateTime::parse_from_rfc3339(started_at) {
        Ok(t) => (t.with_timezone(&chrono::Utc) + chrono::Duration::minutes(offset_minutes.into())).format("%Y-%m-%d").to_string(),
        Err(_) => started_at.chars().take(10).collect(),
    }
}

fn file_name(scope: &Value, ext: &str) -> String {
    let day = now()[..10].to_string();
    match scope["kind"].as_str() {
        Some("playgroup") => format!("yama-games-playgroup-{day}.{ext}"),
        _ => format!("yama-games-{day}.{ext}"),
    }
}

/// One game in the JSON export. Field order is the file's order: commander-decks' fields first.
#[derive(Serialize)]
struct ExportGame<'a> {
    // The fields commander-decks' README asks for, from your seat (null if you didn't play).
    date: String,
    deck: Option<String>,
    version: Option<String>,
    version_id: Option<&'a str>,
    player_count: usize,
    result: Option<&'static str>,
    notes: Option<&'a str>,
    // The whole game.
    id: &'a str,
    source: &'static str,
    mode: &'a str,
    playgroup: Option<&'a str>,
    started_at: &'a str,
    ended_at: Option<&'a str>,
    turns: Option<i64>,
    first_seat: Option<i64>,
    first_player: Option<&'a str>,
    winner_seat: Option<i64>,
    winner: Option<&'a str>,
    win_condition: Option<&'a str>,
    seats: Vec<ExportSeat<'a>>,
}

#[derive(Serialize)]
struct ExportSeat<'a> {
    seat: i64,
    turn_position: Option<usize>,
    player: &'a str,
    you: bool,
    result: &'static str,
    deck: Option<&'a str>,
    deck_version_id: Option<&'a str>,
    deck_version: Option<&'a str>,
    deck_version_note: Option<&'a str>,
    deck_version_saved_at: Option<&'a str>,
    deck_label: Option<&'a str>,
    commander: Option<&'a str>,
    final_life: Option<i64>,
    eliminated_turn: Option<i64>,
    eliminated_by_seat: Option<i64>,
    eliminated_by: Option<&'a str>,
    fun: Option<i64>,
}

#[derive(Serialize)]
struct ExportFile<'a> {
    format: &'static str,
    exported_from: &'static str,
    exported_at: String,
    scope: &'a Value,
    about: &'static str,
    games: Vec<ExportGame<'a>>,
}

fn export_file(e: &Export) -> ExportFile<'_> {
    let games = e
        .games
        .iter()
        .map(|g| {
            let mine = g.seats.iter().find(|s| s.user_id.as_deref() == Some(e.me.as_str()));
            let label = |v: &Option<String>| v.as_ref().and_then(|v| e.labels.get(v));
            let name_of = |seat: Option<i64>| seat.and_then(|s| g.seat(s)).map(|s| s.name.as_str());
            let seats = g
                .seats
                .iter()
                .map(|s| {
                    let v = label(&s.deck_version_id);
                    ExportSeat {
                        seat: s.seat,
                        turn_position: g.turn_position(s.seat),
                        player: &s.name,
                        you: s.user_id.as_deref() == Some(e.me.as_str()),
                        result: g.result_for(s.seat),
                        deck: v.map(|v| v.deck.as_str()).or(s.deck_label.as_deref()),
                        deck_version_id: s.deck_version_id.as_deref(),
                        deck_version: v.map(|v| v.label.as_str()),
                        deck_version_note: v.and_then(|v| v.note.as_deref()),
                        deck_version_saved_at: v.map(|v| v.saved_at.as_str()),
                        deck_label: s.deck_label.as_deref(),
                        commander: s.commander_name.as_deref(),
                        final_life: s.final_life,
                        eliminated_turn: s.eliminated_turn,
                        eliminated_by_seat: s.eliminated_by_seat,
                        eliminated_by: name_of(s.eliminated_by_seat),
                        fun: s.fun,
                    }
                })
                .collect();
            let my_version = mine.and_then(|s| label(&s.deck_version_id));
            ExportGame {
                date: local_date(&g.started_at, e.offset_minutes),
                deck: my_version.map(|v| v.deck.clone()).or_else(|| mine.and_then(|s| s.deck_label.clone())),
                version: my_version.map(|v| v.label.clone()),
                version_id: mine.and_then(|s| s.deck_version_id.as_deref()),
                player_count: g.seats.len(),
                result: mine.map(|s| g.result_for(s.seat)),
                notes: g.note.as_deref(),
                id: &g.id,
                source: "yama",
                mode: &g.mode,
                playgroup: g.playgroup_name.as_deref(),
                started_at: &g.started_at,
                ended_at: g.ended_at.as_deref(),
                turns: g.turns,
                first_seat: g.first_seat,
                first_player: name_of(g.first_seat),
                winner_seat: g.winner_seat,
                winner: name_of(g.winner_seat),
                win_condition: g.win_condition.as_deref(),
                seats,
            }
        })
        .collect();
    ExportFile {
        format: FORMAT,
        exported_from: "Yama",
        exported_at: now(),
        scope: &e.scope,
        about: "Finished games only, oldest first. Seats run clockwise and turn_position 1 took the first turn. \
                Null means not recorded; a null result means you didn't play in that game. \
                win_condition is one of combat, commander_damage, combo, alternate, mill, poison, concession, other. \
                fun is each player's rating from 1 to 5.",
        games,
    }
}

/// The JSON file's bytes, in field order (a `Value` would sort the keys).
fn to_json_bytes(e: &Export) -> anyhow::Result<Vec<u8>> {
    Ok(serde_json::to_vec_pretty(&export_file(e))?)
}

#[cfg(test)]
fn to_json(e: &Export) -> Value {
    serde_json::to_value(export_file(e)).expect("export serializes")
}

pub const CSV_HEADER: [&str; 28] = [
    "game_id", "date", "started_at", "ended_at", "mode", "playgroup", "player_count", "turns", "first_seat", "winner_seat",
    "win_condition", "game_note", "seat", "turn_position", "player", "you", "result", "deck", "deck_version", "deck_version_id",
    "deck_version_note", "deck_label", "commander", "final_life", "eliminated_turn", "eliminated_by_seat", "eliminated_by", "fun",
];

/// Text a spreadsheet would read as a formula (=, +, -, @, tab, return) gets a leading
/// apostrophe. Only for free text such as names and notes; numbers are written as numbers.
pub fn cell(text: &str) -> String {
    if text.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{text}") } else { text.to_string() }
}

fn to_csv(e: &Export) -> anyhow::Result<Vec<u8>> {
    let mut w = csv::Writer::from_writer(Vec::new());
    w.write_record(CSV_HEADER)?;
    let num = |v: Option<i64>| v.map(|n| n.to_string()).unwrap_or_default();
    let text = |v: Option<&str>| v.map(cell).unwrap_or_default();
    for g in &e.games {
        for s in &g.seats {
            let v = s.deck_version_id.as_ref().and_then(|v| e.labels.get(v));
            let deck = v.map(|v| v.deck.clone()).or(s.deck_label.clone());
            w.write_record([
                g.id.clone(),
                local_date(&g.started_at, e.offset_minutes),
                g.started_at.clone(),
                g.ended_at.clone().unwrap_or_default(),
                g.mode.clone(),
                text(g.playgroup_name.as_deref()),
                g.seats.len().to_string(),
                num(g.turns),
                num(g.first_seat),
                num(g.winner_seat),
                g.win_condition.clone().unwrap_or_default(),
                text(g.note.as_deref()),
                s.seat.to_string(),
                g.turn_position(s.seat).map(|p| p.to_string()).unwrap_or_default(),
                cell(&s.name),
                (s.user_id.as_deref() == Some(e.me.as_str())).to_string(),
                g.result_for(s.seat).to_string(),
                text(deck.as_deref()),
                text(v.map(|v| v.label.as_str())),
                s.deck_version_id.clone().unwrap_or_default(),
                text(v.and_then(|v| v.note.as_deref())),
                text(s.deck_label.as_deref()),
                text(s.commander_name.as_deref()),
                num(s.final_life),
                num(s.eliminated_turn),
                num(s.eliminated_by_seat),
                text(s.eliminated_by_seat.and_then(|b| g.seat(b)).map(|b| b.name.as_str())),
                num(s.fun),
            ])?;
        }
    }
    Ok(w.into_inner().map_err(|e| anyhow::anyhow!("{e}"))?)
}

async fn export_json(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(p): Query<Params>) -> AppResult<impl IntoResponse> {
    let e = load(&st, &user.id, &p).await?;
    let body = to_json_bytes(&e)?;
    let disposition = format!("attachment; filename=\"{}\"", file_name(&e.scope, "json"));
    Ok(([(header::CONTENT_TYPE, "application/json".to_string()), (header::CONTENT_DISPOSITION, disposition)], body))
}

async fn export_csv(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(p): Query<Params>) -> AppResult<impl IntoResponse> {
    let e = load(&st, &user.id, &p).await?;
    let body = to_csv(&e)?;
    let disposition = format!("attachment; filename=\"{}\"", file_name(&e.scope, "csv"));
    Ok(([(header::CONTENT_TYPE, "text/csv; charset=utf-8".to_string()), (header::CONTENT_DISPOSITION, disposition)], body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::tests::game;

    fn sample() -> Export {
        let mut g = game("1", &["a", "b", "c"], Some(1));
        g.started_at = "2026-10-18T02:30:00Z".into(); // the evening of the 17th in Austin
        g.first_seat = Some(2);
        g.win_condition = Some("combat".into());
        g.note = Some("=HYPERLINK(\"x\")".into());
        g.seats[0].user_id = Some("me".into());
        g.seats[0].deck_version_id = Some("v3".into());
        g.seats[0].eliminated_turn = Some(6);
        g.seats[0].eliminated_by_seat = Some(1);
        g.seats[0].fun = Some(4);
        g.seats[2].name = "-Sam, the \"guest\"".into();
        let mut labels = HashMap::new();
        labels.insert("v3".to_string(), VersionLabel { deck: "Fantastic Four".into(), label: "Fantastic Four v3".into(), note: Some("Sol Ring in".into()), saved_at: "2026-10-12T10:00:00Z".into() });
        Export { games: vec![g], labels, scope: json!({ "kind": "user" }), offset_minutes: -300, me: "me".into() }
    }

    #[test]
    fn json_leads_with_commander_decks_fields_from_your_seat() {
        let v = to_json(&sample());
        assert_eq!(v["format"], FORMAT);
        let g = &v["games"][0];
        assert_eq!(g["date"], "2026-10-17");
        assert_eq!(g["deck"], "Fantastic Four");
        assert_eq!(g["version"], "Fantastic Four v3");
        assert_eq!(g["version_id"], "v3");
        assert_eq!(g["player_count"], 3);
        assert_eq!(g["result"], "loss");
        assert_eq!(g["first_player"], "-Sam, the \"guest\""); // JSON keeps names as typed
        assert_eq!(g["winner"], "B");
        assert_eq!(g["win_condition"], "combat");
        let me = &g["seats"][0];
        assert_eq!(me["turn_position"], 2);
        assert_eq!(me["you"], true);
        assert_eq!(me["eliminated_by"], "B");
        assert_eq!(me["fun"], 4);
        assert_eq!(me["deck_version_note"], "Sol Ring in");
        assert_eq!(g["seats"][2]["turn_position"], 1);
        assert_eq!(g["seats"][1]["fun"], Value::Null);
    }

    #[test]
    fn json_file_leads_each_game_with_the_readme_fields() {
        let text = String::from_utf8(to_json_bytes(&sample()).unwrap()).unwrap();
        let at = |k: &str| text.find(&format!("\"{k}\":")).unwrap();
        assert!(at("date") < at("deck") && at("deck") < at("version") && at("version") < at("player_count"));
        assert!(at("player_count") < at("result") && at("result") < at("notes") && at("notes") < at("id"));
    }

    #[test]
    fn json_result_is_null_when_you_didnt_play() {
        let mut e = sample();
        e.me = "someone else".into();
        let v = to_json(&e);
        assert_eq!(v["games"][0]["result"], Value::Null);
        assert_eq!(v["games"][0]["deck"], Value::Null);
    }

    #[test]
    fn csv_has_one_row_per_seat_and_defuses_formulas() {
        let bytes = to_csv(&sample()).unwrap();
        let mut r = csv::Reader::from_reader(bytes.as_slice());
        assert_eq!(r.headers().unwrap().iter().collect::<Vec<_>>(), CSV_HEADER.to_vec());
        let rows: Vec<csv::StringRecord> = r.records().map(|x| x.unwrap()).collect();
        assert_eq!(rows.len(), 3);
        let col = |name: &str| CSV_HEADER.iter().position(|h| *h == name).unwrap();
        assert_eq!(&rows[0][col("date")], "2026-10-17");
        assert_eq!(&rows[0][col("result")], "loss");
        assert_eq!(&rows[0][col("deck_version")], "Fantastic Four v3");
        assert_eq!(&rows[0][col("eliminated_by")], "B");
        assert_eq!(&rows[0][col("fun")], "4");
        assert_eq!(&rows[0][col("game_note")], "'=HYPERLINK(\"x\")");
        assert_eq!(&rows[2][col("player")], "'-Sam, the \"guest\"");
        assert_eq!(&rows[2][col("turn_position")], "1");
        assert_eq!(&rows[1][col("fun")], "");
    }

    #[test]
    fn local_date_shifts_by_the_offset() {
        assert_eq!(local_date("2026-10-18T02:30:00Z", -300), "2026-10-17");
        assert_eq!(local_date("2026-10-18T02:30:00Z", 0), "2026-10-18");
        assert_eq!(local_date("2026-10-18T23:30:00Z", 120), "2026-10-19");
    }
}
