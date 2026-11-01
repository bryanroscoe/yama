//! The Mythic Tools bridge, games first (ARCHITECTURE.md, "Mythic Tools bridge"; what's known of
//! Mythic's API is in docs/mythic-bridge.md). Someone whose playgroup logs games in Mythic Tools
//! brings them into Yama as logged games. Mythic's credentials never reach this server: the person
//! runs a snippet on mythic.tools (web/src/bridges/mythic) that saves their games to a file, and
//! uploads the file here. Every import is a preview first, then Apply.
//!
//! - **Importing again updates instead of adding.** A game's Yama id is derived from the importer
//!   and its Mythic id, and `mythic_links` remembers what each Mythic game and player was matched
//!   to. A game changed in Mythic since the last import is saved again; one deleted in Yama stays
//!   deleted.
//! - **Only the importer's own games are written**, the ones the bridge made. A Mythic game the
//!   person matches to a game already in Yama (logged by hand, or by someone else) is only linked,
//!   so it's skipped from then on.
//! - **Mythic's notes and tags stay private**: in the bridge's own owner-only table, not in
//!   `games.note`, which everyone seated can read.
//!
//! Removing the bridge: this folder, migration 0047, its line in routes.rs, the flag in config.rs
//! and testutil.rs, its two tables in admin/delete.rs, and web/src/bridges/mythic.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::games::{Finish, NewGame, Seat};
use crate::routes::AppState;
use crate::util::now;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, FixedOffset};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::collections::{BTreeMap, HashMap, HashSet};

#[cfg(test)]
mod tests;

/// The most games one upload can hold.
const MAX_GAMES: usize = 5000;
const MAX_BYTES: usize = 16 * 1024 * 1024;
/// How far apart a Mythic game and a Yama game can start and still be offered as the same game.
/// Log a game keeps only the day (8 pm), so this is generous; the person decides.
const MATCH_HOURS: i64 = 12;
/// `games.note` of an imported game. Mythic's own note stays in `mythic_game_notes`.
const NOTE: &str = "Imported from Mythic Tools";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/bridges/mythic", get(status))
        .route("/api/bridges/mythic/games/preview", post(preview).layer(DefaultBodyLimit::max(MAX_BYTES)))
        .route("/api/bridges/mythic/games/apply", post(apply).layer(DefaultBodyLimit::max(MAX_BYTES)))
        .route("/api/bridges/mythic/games/{id}/note", get(note))
}

/// The bridge's routes exist only when it's switched on, so the web app asks this to show it.
async fn status(CurrentUser(_): CurrentUser) -> Json<Value> {
    Json(serde_json::json!({ "enabled": true }))
}

// ── the file the snippet saves ─────────────────────────────────────────────────────────────

/// `{source, exported_at, me: {id, name}, games: [...]}`. Each game is Mythic's own record
/// (`GET /game/{id}`, with or without its `{game: ...}` wrapper); the snippet adds
/// `commander_name` to each deck, since Mythic names cards by its own ids.
#[derive(Deserialize)]
struct Export {
    #[serde(default)]
    me: Option<MythicUser>,
    games: Vec<Entry>,
}

#[derive(Deserialize)]
struct MythicUser {
    id: Value,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Entry {
    Wrapped { game: MGame },
    Bare(MGame),
}

impl Entry {
    fn game(&self) -> &MGame {
        match self {
            Entry::Wrapped { game } | Entry::Bare(game) => game,
        }
    }
}

#[derive(Deserialize)]
struct MGame {
    id: Value,
    started_at: Option<String>,
    ended_at: Option<String>,
    winner: Option<Value>,
    #[serde(default)]
    winners: Vec<MRef>,
    #[serde(default)]
    players: Vec<MPlayer>,
    #[serde(default)]
    tags: Vec<Value>,
    note: Option<String>,
    formatid: Option<i64>,
}

#[derive(Deserialize)]
struct MRef {
    id: Option<Value>,
}

#[derive(Deserialize)]
struct MPlayer {
    id: Option<Value>,
    /// A player without a Mythic account, kept by whoever logged the game.
    managed_player_id: Option<Value>,
    firstname: Option<String>,
    username: Option<String>,
    position: Option<i64>,
    /// The life the player started on.
    lifetotal: Option<i64>,
    startingplayer: Option<bool>,
    deck: Option<MDeck>,
}

#[derive(Deserialize)]
struct MDeck {
    name: Option<String>,
    commander_name: Option<String>,
}

/// Mythic's ids are numbers; the file may carry them as strings.
fn id_of(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

/// Who a Mythic seat is: their account, or the guest player kept by whoever logged the game.
fn player_key(p: &MPlayer) -> Option<String> {
    p.id.as_ref().and_then(id_of).or_else(|| p.managed_player_id.as_ref().and_then(id_of).map(|m| format!("managed:{m}")))
}

fn player_name(p: &MPlayer) -> Option<String> {
    [&p.firstname, &p.username].into_iter().flatten().map(|s| s.trim()).find(|s| !s.is_empty()).map(str::to_string)
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn parse_time(t: &Option<String>) -> Option<DateTime<FixedOffset>> {
    t.as_deref().and_then(|t| DateTime::parse_from_rfc3339(t).ok())
}

/// The Yama id of the game the bridge makes from a Mythic game: the same for every import by
/// the same person, so a retried import applies once. A name-based UUID (version 8, SHA-256).
fn derived_id(owner: &str, mythic_id: &str) -> String {
    let digest = Sha256::digest(format!("{owner}\nmythic:game:{mythic_id}").as_bytes());
    let mut b = [0u8; 16];
    b.copy_from_slice(&digest[..16]);
    b[6] = (b[6] & 0x0f) | 0x80;
    b[8] = (b[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(b).to_string()
}

// ── the request ────────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ImportRequest {
    export: Export,
    /// The playgroup the games go in, if any. Players can only be matched to its members.
    playgroup_id: Option<String>,
    /// Which Mythic player is the importer ("This is me"). Defaults to the player linked before,
    /// then to the file's own account.
    me: Option<String>,
    /// Mythic player to playgroup member, as the person confirmed it; null keeps the name Mythic
    /// has. A player left out keeps the member it was linked to before.
    #[serde(default)]
    players: HashMap<String, Option<String>>,
    /// Per Mythic game: "skip", "import" (a new game even though one in Yama looks the same), or
    /// "link:<Yama game id>" (it's that game, already in Yama).
    #[serde(default)]
    choices: HashMap<String, String>,
}

#[derive(Serialize)]
struct Preview {
    me: Option<String>,
    players: Vec<PlayerRow>,
    games: Vec<GameRow>,
    counts: BTreeMap<&'static str, usize>,
}

#[derive(Serialize)]
struct PlayerRow {
    mythic_id: String,
    name: String,
    games: usize,
    /// The member this player is matched to, if any.
    member_id: Option<String>,
    /// A member with the same first name, to offer when nothing is matched yet.
    suggested: Option<String>,
}

#[derive(Serialize)]
struct GameRow {
    mythic_id: String,
    started_at: Option<String>,
    /// new, update, conflict (changed in Mythic and in Yama; "update" takes Mythic's), note (only
    /// Mythic's note or tags changed), unchanged, match (looks like a game
    /// already in Yama; needs a choice), linked
    /// (matched to a game in Yama before), deleted (removed in Yama) or invalid.
    status: &'static str,
    /// create, update, note (the private note alone), link or skip: what Apply does.
    action: &'static str,
    yama_id: Option<String>,
    matches: Vec<Candidate>,
    seats: Vec<SeatRow>,
    reason: Option<String>,
}

#[derive(Serialize, Clone)]
struct Candidate {
    id: String,
    started_at: String,
    seats: i64,
    /// Who played, by name, so the person can tell the game apart.
    players: Vec<String>,
    /// Each seat's (member, account), to compare with the Mythic game's known players.
    #[serde(skip)]
    who: Vec<(Option<String>, Option<String>)>,
}

impl Candidate {
    /// Whether someone (by member, or by account) sat in this game.
    fn has(&self, member: Option<&str>, user: Option<&str>) -> bool {
        self.who.iter().any(|(m, u)| (member.is_some() && m.as_deref() == member) || (user.is_some() && u.as_deref() == user))
    }
}

#[derive(Serialize)]
struct SeatRow {
    name: String,
    deck: Option<String>,
    commander: Option<String>,
    won: bool,
    me: bool,
}

// ── planning ───────────────────────────────────────────────────────────────────────────────

/// A Mythic game as Yama would store it.
struct Built {
    started_at: String,
    starting_life: i64,
    seats: Vec<Seat>,
    finish: Finish,
    rows: Vec<SeatRow>,
    note: Option<String>,
    tags: Vec<Value>,
    fingerprint: String,
}

struct Ctx<'a> {
    owner: &'a str,
    playgroup: Option<&'a str>,
    my_member: Option<String>,
    me: Option<String>,
    /// Mythic player to member, as it applies to this import.
    members: HashMap<String, String>,
}

fn build(g: &MGame, ctx: &Ctx) -> Result<Built, String> {
    // 6 is Commander in Mythic (`GET /formats`); a game that doesn't say isn't taken for one.
    if g.formatid != Some(6) {
        return Err("only Commander games are imported for now".into());
    }
    let started = parse_time(&g.started_at).ok_or("Mythic has no start time for it")?;
    let ended = parse_time(&g.ended_at);
    let winner = match g.winners.as_slice() {
        [] => g.winner.as_ref().and_then(id_of),
        [one] => one.id.as_ref().and_then(id_of),
        // More than one winner (a team game): Yama records a single winner, so no winner.
        _ => None,
    };
    if ended.is_none() && winner.is_none() {
        return Err("it isn't finished in Mythic".into());
    }
    let mut players: Vec<&MPlayer> = g.players.iter().collect();
    if players.is_empty() || players.len() > 10 {
        return Err("a game needs 1 to 10 players".into());
    }
    players.sort_by_key(|p| p.position.unwrap_or(i64::MAX));
    // The winner is named by account, or by managed id for a player without one.
    let winner_at = winner.as_ref().and_then(|w| {
        players.iter().position(|p| p.id.as_ref().and_then(id_of).as_ref() == Some(w))
            .or_else(|| players.iter().position(|p| p.id.as_ref().and_then(id_of).is_none() && p.managed_player_id.as_ref().and_then(id_of).as_ref() == Some(w)))
    });

    let (mut seats, mut rows) = (Vec::new(), Vec::new());
    let (mut winner_seat, mut first_seat) = (None, None);
    for (n, p) in players.iter().enumerate() {
        let seat = n as i64;
        let key = player_key(p);
        let name = player_name(p).unwrap_or_else(|| format!("Player {}", n + 1));
        let me = key.is_some() && key == ctx.me;
        let member = if ctx.playgroup.is_none() {
            None
        } else if me {
            ctx.my_member.clone()
        } else {
            key.as_ref().and_then(|k| ctx.members.get(k).cloned())
        };
        let deck = p.deck.as_ref().and_then(|d| clean(&d.name));
        let commander = p.deck.as_ref().and_then(|d| clean(&d.commander_name));
        let won = winner_at == Some(n);
        if won {
            winner_seat = Some(seat);
        }
        if p.startingplayer == Some(true) && first_seat.is_none() {
            first_seat = Some(seat);
        }
        seats.push(Seat {
            seat,
            guest_name: if member.is_none() && !me { Some(name.clone()) } else { None },
            member_id: member,
            user_id: me.then(|| ctx.owner.to_string()),
            ai_kind: None,
            deck_version_id: None,
            deck_label: deck.clone(),
            commander_name: commander.clone(),
            final_life: None,
            eliminated_turn: None,
            eliminated_by_seat: None,
            fun: None,
            display_name: None,
        });
        rows.push(SeatRow { name, deck, commander, won, me });
    }
    let starting_life = players[0].lifetotal.filter(|l| (1..=999).contains(l)).unwrap_or(40);
    let started_at = started.to_rfc3339();
    let ended_at = ended.map(|e| e.to_rfc3339());
    let note = clean(&g.note);
    let tags = g.tags.clone();
    // What the import would store, so a later import knows whether Mythic changed it: the game,
    // then apart from it Mythic's private note, so a note changed alone never rewrites the game.
    let game_print = crate::util::sha256_hex(
        &serde_json::json!({
            "playgroup": ctx.playgroup,
            "started_at": started_at,
            "ended_at": ended_at,
            "starting_life": starting_life,
            "seats": seats,
            "winner": winner_seat,
            "first": first_seat,
        })
        .to_string(),
    );
    let note_print = crate::util::sha256_hex(&serde_json::json!({ "note": note, "tags": tags }).to_string());
    let fingerprint = format!("{game_print} {note_print}");
    Ok(Built {
        started_at,
        starting_life,
        seats,
        finish: Finish { winner_seat, turns: None, ended_at, first_seat, win_condition: None, seats: vec![] },
        rows,
        note,
        tags,
        fingerprint,
    })
}

struct Planned {
    mythic_id: String,
    built: Result<Built, String>,
    status: &'static str,
    action: &'static str,
    yama_id: Option<String>,
    matches: Vec<Candidate>,
    /// The Yama game as last synced, kept when only Mythic's note changes: a note saved again
    /// mustn't make edits made in Yama since look synced.
    saved_yama: Option<String>,
}

struct Plan {
    me: Option<String>,
    players: Vec<PlayerRow>,
    games: Vec<Planned>,
    /// Player links to save on Apply: Mythic player to member (None removes the link).
    player_links: Vec<(String, Option<String>)>,
}

/// Whether a game's (game, note) changed since the fingerprint saved at its last import.
fn changed_parts(saved: Option<&str>, now: &str) -> (bool, bool) {
    let split = |f: &str| {
        let mut parts = f.split(' ');
        Some((parts.next()?.to_string(), parts.next()?.to_string()))
    };
    match (saved.and_then(split), split(now)) {
        (Some((g0, n0)), Some((g1, n1))) => (g0 != g1, n0 != n1),
        _ => (true, true),
    }
}

/// The Yama game as it was when last synced (the fingerprint's third part).
fn saved_yama(saved: Option<&str>) -> Option<&str> {
    saved?.split(' ').nth(2).filter(|y| !y.is_empty())
}

/// What a game is in Yama now, to tell whether it was edited there since the last import.
async fn yama_print<'c, E: sqlx::SqliteExecutor<'c>>(conn: E, game: &str) -> AppResult<String> {
    let state: Option<String> = sqlx::query_scalar(
        "SELECT json_array(
                  (SELECT json_array(playgroup_id, format, starting_life, started_at, ended_at, turns, winner_seat, first_seat, win_condition) FROM games WHERE id = ?),
                  (SELECT json_group_array(json_array(seat, member_id, user_id, guest_name, deck_version_id, deck_label, commander_name))
                     FROM (SELECT * FROM game_seats WHERE game_id = ? ORDER BY seat)))",
    )
    .bind(game)
    .bind(game)
    .fetch_one(conn)
    .await?;
    Ok(crate::util::sha256_hex(&state.unwrap_or_default()))
}

async fn links(pool: &SqlitePool, owner: &str, kind: &str) -> AppResult<HashMap<String, (String, Option<String>)>> {
    let rows: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT mythic_id, yama_id, mythic_changed FROM mythic_links WHERE owner_id = ? AND kind = ?")
            .bind(owner)
            .bind(kind)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(m, y, c)| (m, (y, c))).collect())
}

/// The members of a playgroup, with the name each goes by.
async fn members(pool: &SqlitePool, playgroup: &str) -> AppResult<Vec<(String, Option<String>, String)>> {
    Ok(sqlx::query_as(
        "SELECT m.id, m.user_id, COALESCE(u.display_name, m.guest_name, '') FROM playgroup_members m
           LEFT JOIN users u ON u.id = m.user_id WHERE m.playgroup_id = ?",
    )
    .bind(playgroup)
    .fetch_all(pool)
    .await?)
}

async fn plan(pool: &SqlitePool, owner: &str, req: &ImportRequest) -> AppResult<Plan> {
    if req.export.games.len() > MAX_GAMES {
        return Err(AppError::bad(format!("an upload can hold at most {MAX_GAMES} games")));
    }
    let playgroup = req.playgroup_id.as_deref().filter(|p| !p.is_empty());
    let group_members = match playgroup {
        Some(pg) => {
            if !crate::playgroups::is_member(pool, pg, owner).await? {
                return Err(AppError::NotFound("playgroup"));
            }
            members(pool, pg).await?
        }
        None => vec![],
    };
    let member_ids: HashSet<&str> = group_members.iter().map(|(id, _, _)| id.as_str()).collect();
    let my_member = group_members.iter().find(|(_, u, _)| u.as_deref() == Some(owner)).map(|(id, _, _)| id.clone());

    // Players: the confirmed choice, else the link made before.
    let player_links = links(pool, owner, "player").await?;
    let me = req
        .me
        .clone()
        .filter(|m| !m.is_empty())
        .or_else(|| player_links.iter().find(|(_, (y, _))| y == owner).map(|(m, _)| m.clone()))
        .or_else(|| req.export.me.as_ref().and_then(|m| id_of(&m.id)));
    let mut to_save = Vec::new();
    for (key, member) in &req.players {
        if let Some(m) = member
            && !member_ids.contains(m.as_str())
        {
            return Err(AppError::bad("a player is matched to someone who isn't in this playgroup"));
        }
        to_save.push((key.clone(), member.clone()));
    }
    // The importer's own player is linked to them, not to a member, whatever the page still holds
    // for it from before they said which player they are.
    to_save.retain(|(k, _)| Some(k) != me.as_ref());
    to_save.sort();
    let mut matched: HashMap<String, String> = HashMap::new();
    for (key, (yama, _)) in &player_links {
        if member_ids.contains(yama.as_str()) {
            matched.insert(key.clone(), yama.clone());
        }
    }
    for (key, member) in &to_save {
        match member {
            Some(m) => matched.insert(key.clone(), m.clone()),
            None => matched.remove(key),
        };
    }
    // One member per Mythic player, and the importer's own member for their own player alone: a
    // member at two seats would count twice in the group's stats. A match made in an earlier
    // import gives way to one made now; two made now are refused.
    let mut taken: HashMap<String, String> = HashMap::new();
    if me.is_some() && let Some(mine) = &my_member {
        taken.insert(mine.clone(), me.clone().unwrap_or_default());
    }
    let mut keys: Vec<String> = matched.keys().cloned().collect();
    // Choices made now first, so they keep their member.
    keys.sort_by_key(|k| (!req.players.contains_key(k), k.clone()));
    for key in keys {
        if Some(&key) == me.as_ref() {
            matched.remove(&key);
            continue;
        }
        let m = matched[&key].clone();
        if taken.contains_key(&m) {
            if req.players.get(&key).is_some_and(Option::is_some) {
                return Err(AppError::bad("two Mythic players are matched to the same member, or a player is matched to you"));
            }
            matched.remove(&key);
        } else {
            taken.insert(m, key);
        }
    }

    // Everyone who played, once each, with a same-name member to suggest.
    let mut players: Vec<PlayerRow> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for e in &req.export.games {
        for p in &e.game().players {
            let Some(key) = player_key(p) else { continue };
            if let Some(&i) = seen.get(&key) {
                players[i].games += 1;
                continue;
            }
            let name = player_name(p).unwrap_or_default();
            let first = name.split_whitespace().next().unwrap_or("").to_lowercase();
            let suggested = group_members
                .iter()
                .filter(|(id, u, n)| u.as_deref() != Some(owner) && !first.is_empty() && n.split_whitespace().next().unwrap_or("").to_lowercase() == first && !matched.values().any(|m| m == id))
                .map(|(id, _, _)| id.clone())
                .next();
            seen.insert(key.clone(), players.len());
            players.push(PlayerRow { member_id: matched.get(&key).cloned(), mythic_id: key, name, games: 1, suggested });
        }
    }

    // A member's account, so a game logged with the person but not the playgroup still matches.
    let member_user: HashMap<String, Option<String>> = group_members.iter().map(|(id, u, _)| (id.clone(), u.clone())).collect();
    let ctx = Ctx { owner, playgroup, my_member, me: me.clone(), members: matched };
    let game_links = links(pool, owner, "game").await?;
    let linked_yama: HashSet<&str> = game_links.values().map(|(y, _)| y.as_str()).collect();
    let visible = visible_games(pool, owner).await?;

    let mut games = Vec::new();
    let mut ids = HashSet::new();
    // Yama games chosen as matches in this upload: each can be one Mythic game's only.
    let mut chosen: HashSet<String> = HashSet::new();
    for e in &req.export.games {
        let g = e.game();
        let Some(mythic_id) = id_of(&g.id) else {
            return Err(AppError::bad("a game in the file has no Mythic id"));
        };
        // The same game twice in one file (pages that overlap) is one game.
        if !ids.insert(mythic_id.clone()) {
            continue;
        }
        let built = build(g, &ctx);
        let choice = req.choices.get(&mythic_id).map(String::as_str);
        let derived = derived_id(owner, &mythic_id);
        let mut p = Planned { mythic_id, built, status: "new", action: "create", yama_id: None, matches: vec![], saved_yama: None };
        let Ok(b) = &p.built else {
            (p.status, p.action) = ("invalid", "skip");
            games.push(p);
            continue;
        };
        if let Some((yama, changed)) = game_links.get(&p.mythic_id) {
            p.yama_id = Some(yama.clone());
            p.saved_yama = saved_yama(changed.as_deref()).map(str::to_string);
            let row: Option<(String, String)> = sqlx::query_as("SELECT created_by, mode FROM games WHERE id = ?").bind(yama).fetch_optional(pool).await?;
            let edited_in_yama = match (&row, &p.saved_yama) {
                (Some(_), Some(saved)) => *saved != yama_print(pool, yama).await?,
                _ => false,
            };
            (p.status, p.action) = match row {
                None => ("deleted", "skip"),
                // A game the bridge made: Mythic's changes are saved again.
                Some((by, mode)) if *yama == derived && by == owner && mode == "in_person" => match changed_parts(changed.as_deref(), &b.fingerprint) {
                    // Changed in Yama too since the last import: the person picks which stays.
                    (true, _) if edited_in_yama => {
                        if choice == Some("update") { ("conflict", "update") } else { ("conflict", "skip") }
                    }
                    (true, _) if choice == Some("skip") => ("update", "skip"),
                    (true, _) => ("update", "update"),
                    (false, true) => ("note", "note"),
                    (false, false) => ("unchanged", "skip"),
                },
                // Matched to a game already in Yama, which stays as it was logged there; only
                // Mythic's private note follows Mythic.
                Some(_) => match changed_parts(changed.as_deref(), &b.fingerprint) {
                    (_, true) => ("linked", "note"),
                    _ => ("linked", "skip"),
                },
            };
            games.push(p);
            continue;
        }
        let start = parse_time(&Some(b.started_at.clone()));
        p.matches = visible
            .iter()
            .filter(|v| v.id != derived && !linked_yama.contains(v.id.as_str()) && v.seats == b.seats.len() as i64)
            .filter(|v| match (start, parse_time(&Some(v.started_at.clone()))) {
                (Some(a), Some(b)) => (a - b).num_hours().abs() <= MATCH_HOURS,
                _ => false,
            })
            // Everyone known on the Mythic side (the importer, matched members) sat in it.
            .filter(|v| {
                b.seats.iter().all(|s| match (&s.member_id, &s.user_id) {
                    (None, None) => true,
                    (m, u) => {
                        let account = u.clone().or_else(|| m.as_ref().and_then(|m| member_user.get(m).cloned().flatten()));
                        v.has(m.as_deref(), account.as_deref())
                    }
                })
            })
            .take(5)
            .cloned()
            .collect();
        match choice {
            Some("skip") => (p.status, p.action) = (if p.matches.is_empty() { "new" } else { "match" }, "skip"),
            Some("import") => (p.status, p.action) = (if p.matches.is_empty() { "new" } else { "match" }, "create"),
            Some(c) if c.starts_with("link:") => {
                let target = &c["link:".len()..];
                // Only a game still offered for it: same players' count, close in time, not matched.
                if !p.matches.iter().any(|m| m.id == target) {
                    return Err(AppError::Conflict("that Yama game isn't a match for this Mythic game any more; preview again".into()));
                }
                if linked_yama.contains(target) || !chosen.insert(target.to_string()) {
                    return Err(AppError::Conflict("that Yama game is already matched to another Mythic game".into()));
                }
                (p.status, p.action, p.yama_id) = ("match", "link", Some(target.to_string()));
            }
            Some(other) => return Err(AppError::bad(format!("unknown choice {other:?}"))),
            None if !p.matches.is_empty() => (p.status, p.action) = ("match", "skip"),
            None => {
                // Made before, but its link went (an import cut short): saving it again is safe.
                let exists: Option<String> = sqlx::query_scalar("SELECT created_by FROM games WHERE id = ?").bind(&derived).fetch_optional(pool).await?;
                if exists.as_deref() == Some(owner) {
                    p.status = "update";
                    p.action = "update";
                }
            }
        }
        if matches!(p.action, "create" | "update") {
            p.yama_id = Some(derived);
        }
        games.push(p);
    }
    Ok(Plan { me, players, games, player_links: to_save })
}

/// In-person games the person can see, to offer as the same game as one from Mythic.
async fn visible_games(pool: &SqlitePool, owner: &str) -> AppResult<Vec<Candidate>> {
    Ok(sqlx::query_as::<_, (String, String, i64, String)>(
        "SELECT g.id, g.started_at, (SELECT COUNT(*) FROM game_seats s WHERE s.game_id = g.id),
                (SELECT json_group_array(json_array(s.member_id, s.user_id, COALESCE(u.display_name, s.guest_name, pm.guest_name, '')))
                   FROM game_seats s LEFT JOIN users u ON u.id = s.user_id LEFT JOIN playgroup_members pm ON pm.id = s.member_id
                  WHERE s.game_id = g.id)
           FROM games g
          WHERE g.mode = 'in_person' AND g.status = 'finished'
            AND (g.created_by = ?
                 OR EXISTS (SELECT 1 FROM game_seats s WHERE s.game_id = g.id AND s.user_id = ?)
                 OR g.playgroup_id IN (SELECT id FROM playgroups WHERE owner_id = ?
                                       UNION SELECT playgroup_id FROM playgroup_members WHERE user_id = ?))
          ORDER BY g.started_at DESC",
    )
    .bind(owner)
    .bind(owner)
    .bind(owner)
    .bind(owner)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, started_at, seats, people)| {
        let rows: Vec<(Option<String>, Option<String>, String)> = serde_json::from_str(&people).unwrap_or_default();
        let players = rows.iter().map(|(_, _, n)| n.clone()).filter(|n| !n.is_empty()).collect();
        let who = rows.into_iter().map(|(m, u, _)| (m, u)).collect();
        Candidate { id, started_at, seats, players, who }
    })
    .collect())
}

fn to_preview(plan: Plan) -> Preview {
    let mut counts = BTreeMap::new();
    let games = plan
        .games
        .into_iter()
        .map(|p| {
            *counts.entry(p.status).or_insert(0) += 1;
            let (seats, started_at, reason) = match p.built {
                Ok(b) => (b.rows, Some(b.started_at), None),
                Err(e) => (vec![], None, Some(e)),
            };
            GameRow { mythic_id: p.mythic_id, started_at, status: p.status, action: p.action, yama_id: p.yama_id, matches: p.matches, seats, reason }
        })
        .collect();
    Preview { me: plan.me, players: plan.players, games, counts }
}

async fn preview(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(req): Json<ImportRequest>) -> AppResult<Json<Preview>> {
    st.limits.mythic_bridge.check_user(&user)?;
    Ok(Json(to_preview(plan(&st.pool, &user.id, &req).await?)))
}

// ── applying ───────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Default)]
struct Applied {
    created: usize,
    updated: usize,
    linked: usize,
    /// Games whose Mythic note or tags alone changed.
    notes: usize,
    skipped: usize,
    errors: Vec<GameError>,
}

#[derive(Serialize)]
struct GameError {
    mythic_id: String,
    error: String,
}

async fn link(pool: &SqlitePool, owner: &str, kind: &str, mythic: &str, yama: &str, changed: Option<&str>) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    link_in(&mut tx, owner, kind, mythic, yama, changed).await?;
    tx.commit().await?;
    Ok(())
}

async fn link_in(tx: &mut sqlx::SqliteConnection, owner: &str, kind: &str, mythic: &str, yama: &str, changed: Option<&str>) -> AppResult<()> {
    // A Yama record is linked to one Mythic record. A player's newest match wins; a game already
    // linked to another Mythic game is refused by the unique index (another import, at the same
    // time, may have just linked it), never taken from it.
    if kind == "player" {
        sqlx::query("DELETE FROM mythic_links WHERE owner_id = ? AND kind = ? AND yama_id = ? AND mythic_id != ?")
            .bind(owner)
            .bind(kind)
            .bind(yama)
            .bind(mythic)
            .execute(&mut *tx)
            .await?;
    }
    let inserted = sqlx::query(
        "INSERT INTO mythic_links (owner_id, kind, mythic_id, yama_id, mythic_changed, synced_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT (owner_id, kind, mythic_id) DO UPDATE SET yama_id = excluded.yama_id, mythic_changed = excluded.mythic_changed, synced_at = excluded.synced_at",
    )
    .bind(owner)
    .bind(kind)
    .bind(mythic)
    .bind(yama)
    .bind(changed)
    .bind(now())
    .execute(&mut *tx)
    .await;
    match inserted {
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            return Err(AppError::Conflict("that Yama game is already matched to another Mythic game".into()));
        }
        other => other?,
    };
    Ok(())
}

async fn apply(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(req): Json<ImportRequest>) -> AppResult<Json<Applied>> {
    st.limits.mythic_bridge.check_user(&user)?;
    let pool = &st.pool;
    let owner = user.id.as_str();
    let plan = plan(pool, owner, &req).await?;
    let playgroup = req.playgroup_id.clone().filter(|p| !p.is_empty());

    // The players as confirmed, then which one is the importer.
    if playgroup.is_some() {
        for (key, member) in &plan.player_links {
            match member {
                Some(m) => link(pool, owner, "player", key, m, None).await?,
                None => {
                    sqlx::query("DELETE FROM mythic_links WHERE owner_id = ? AND kind = 'player' AND mythic_id = ?").bind(owner).bind(key).execute(pool).await?;
                }
            }
        }
    }
    if let Some(me) = &plan.me {
        link(pool, owner, "player", me, owner, None).await?;
    }

    let mut out = Applied::default();
    for p in plan.games {
        let (Ok(b), Some(yama)) = (p.built, p.yama_id) else {
            out.skipped += 1;
            continue;
        };
        let result = match p.action {
            "create" | "update" => {
                let game = NewGame {
                    id: yama.clone(),
                    playgroup_id: playgroup.clone(),
                    format: "commander".into(),
                    starting_life: b.starting_life,
                    started_at: Some(b.started_at),
                    seats: b.seats,
                    events: vec![],
                    finish: Some(b.finish),
                    note: Some(NOTE.into()),
                };
                save_game(pool, owner, game, Sync { mythic: &p.mythic_id, yama: &yama, fingerprint: &b.fingerprint, keep_yama: None, note: b.note.as_deref(), tags: &b.tags }).await
            }
            // Only Mythic's note changed, or a game matched to one logged in Yama: the game stays as
            // it is, and Mythic's note is kept privately.
            "note" | "link" => {
                let keep = if p.action == "note" { p.saved_yama.as_deref() } else { None };
                sync_game(pool, owner, Sync { mythic: &p.mythic_id, yama: &yama, fingerprint: &b.fingerprint, keep_yama: keep, note: b.note.as_deref(), tags: &b.tags }).await
            }
            _ => {
                out.skipped += 1;
                continue;
            }
        };
        match result {
            Ok(()) => {
                match p.action {
                    "create" => out.created += 1,
                    "update" => out.updated += 1,
                    "note" => out.notes += 1,
                    _ => out.linked += 1,
                }
            }
            Err(e) => out.errors.push(GameError { mythic_id: p.mythic_id, error: e.to_string() }),
        }
    }
    Ok(Json(out))
}

/// A game's link and Mythic's private note, together: the link's fingerprint never says a note
/// was saved when it wasn't, so retrying an upload repairs an Apply cut short.
struct Sync<'a> {
    mythic: &'a str,
    yama: &'a str,
    fingerprint: &'a str,
    /// The Yama game's state to record: as it is now, unless the game wasn't written.
    keep_yama: Option<&'a str>,
    note: Option<&'a str>,
    tags: &'a [Value],
}

async fn sync_game(pool: &SqlitePool, owner: &str, s: Sync<'_>) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    sync_in(&mut tx, owner, s).await?;
    tx.commit().await?;
    Ok(())
}

/// A Mythic game saved as a Yama game, with its link and note, in one commit: a failure leaves
/// the game, link and note all as they were, so importing the file again finishes the job.
async fn save_game(pool: &SqlitePool, owner: &str, game: NewGame, s: Sync<'_>) -> AppResult<()> {
    crate::games::check_game(pool, owner, &game).await?;
    let mut tx = pool.begin().await?;
    crate::games::create_game_in(&mut tx, owner, game).await?;
    sync_in(&mut tx, owner, s).await?;
    tx.commit().await?;
    Ok(())
}

async fn sync_in(tx: &mut sqlx::SqliteConnection, owner: &str, s: Sync<'_>) -> AppResult<()> {
    let Sync { mythic, yama, fingerprint, keep_yama, note, tags } = s;
    let now = match keep_yama {
        Some(kept) => kept.to_string(),
        None => yama_print(&mut *tx, yama).await?,
    };
    let print = format!("{fingerprint} {now}");
    link_in(&mut *tx, owner, "game", mythic, yama, Some(&print)).await?;
    save_note(&mut *tx, owner, yama, note, tags).await?;
    Ok(())
}

/// Mythic's note and tags for a game, kept for the importer alone.
async fn save_note(conn: &mut sqlx::SqliteConnection, owner: &str, game: &str, note: Option<&str>, tags: &[Value]) -> AppResult<()> {
    if note.is_none() && tags.is_empty() {
        sqlx::query("DELETE FROM mythic_game_notes WHERE owner_id = ? AND game_id = ?").bind(owner).bind(game).execute(&mut *conn).await?;
    } else {
        sqlx::query(
            "INSERT INTO mythic_game_notes (owner_id, game_id, note, tags) VALUES (?,?,?,?)
             ON CONFLICT (owner_id, game_id) DO UPDATE SET note = excluded.note, tags = excluded.tags",
        )
        .bind(owner)
        .bind(game)
        .bind(note)
        .bind(serde_json::to_string(tags).unwrap_or_else(|_| "[]".into()))
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// The Mythic note and tags of a game the person imported; nobody else's.
async fn note(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let row: Option<(Option<String>, String)> = sqlx::query_as("SELECT note, tags FROM mythic_game_notes WHERE owner_id = ? AND game_id = ?")
        .bind(&user.id)
        .bind(&id)
        .fetch_optional(&st.pool)
        .await?;
    let (note, tags) = row.ok_or(AppError::NotFound("Mythic note"))?;
    Ok(Json(serde_json::json!({ "note": note, "tags": serde_json::from_str::<Value>(&tags).unwrap_or(Value::Null) })))
}
