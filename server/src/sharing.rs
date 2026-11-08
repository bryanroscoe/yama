//! Sharing: a handle for a profile (`/u/<handle>`), decks shared by link (`/d/<token>`) or on the
//! profile, research notes shared the same way (`/r/<token>`, `sharing/research.rs`), and the
//! collection's card list. Everything starts private; only what its owner shares
//! is served, and only through the projections here. They never carry prices paid, notes,
//! containers, proxies, ownership counts, plans, games, playgroups or account details (the Google
//! display name and email included). A deck's printings are the ones its exports name. A deck
//! page also shows what's worked out from the list (legality, the stored bracket check, stats,
//! market value) and, when the owner turns it on, its plan's simulated win rates for the lists
//! it and its listed configurations stand for, nothing else from the plan.
mod html;
mod research;
#[cfg(test)]
mod tests;

use crate::auth::CurrentUser;
use crate::decks::{Board, DeckCard, PrintRef};
use crate::error::{AppError, AppResult};
use crate::limits::{ClientAddress, address_key};
use crate::routes::AppState;
use crate::util::now;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/me/sharing", get(get_sharing).put(put_sharing))
        .route("/api/me/sharing/decks", post(share_all))
        .route("/api/public/decks/{token}", get(api_deck))
        .route("/u", get(lookup))
        .route("/u/{handle}", get(html::profile))
        .route("/u/{handle}/collection", get(html::collection))
        .route("/u/{handle}/collection.txt", get(collection_text))
        .route("/u/{handle}/collection.csv", get(collection_csv))
        .route("/d/{token}", get(html::deck))
        .route("/d/{token}/{file}", get(download))
        .route("/r/{token}", get(research::note))
        .route("/r/{token}/{deck}", get(research::deck))
        .route("/r/{token}/{deck}/{file}", get(research::download))
        // The owner's note pages in the app, from the same computations as `/r/`.
        .route("/api/research/{id}/view", get(research::owner_note))
        .route("/api/research/{id}/view/{deck}", get(research::owner_deck))
        .route("/api/research-plans", get(research::owner_plans))
}

/// Only this GET API bypasses view-as resolution: its output has no account context.
pub fn is_public_api(path: &str) -> bool {
    path.strip_prefix("/api/public/decks/").is_some_and(valid_token)
}

/// A deck's share token: 24 hex digits of a random UUID (about 92 random bits; the migration's
/// tokens for existing decks are 20 random hex digits, 80 bits).
pub fn new_token() -> String {
    crate::util::random_token()[..24].to_string()
}

pub(crate) fn valid_token(s: &str) -> bool {
    (16..=40).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub const VISIBILITIES: [&str; 3] = ["private", "link", "public"];

pub fn visibility(v: &str) -> AppResult<&str> {
    VISIBILITIES.iter().copied().find(|x| *x == v).ok_or_else(|| AppError::bad("visibility is private, link or public"))
}

/// Handles that would read as Yama itself, or as a page.
const RESERVED: [&str; 20] = [
    "admin", "administrator", "api", "about", "help", "support", "yama", "official", "staff", "moderator", "mod", "me", "new",
    "settings", "precons", "privacy", "tos", "terms", "null", "undefined",
];

/// A handle as typed: an optional leading @, then 3 to 30 of a-z, 0-9, - and _, starting with a
/// letter and not ending in - or _. Stored lowercase.
pub fn parse_handle(raw: &str) -> AppResult<String> {
    let h = raw.trim().trim_start_matches('@').to_ascii_lowercase();
    let shape = (3..=30).contains(&h.len())
        && h.starts_with(|c: char| c.is_ascii_lowercase())
        && !h.ends_with(['-', '_'])
        && h.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_');
    if !shape {
        return Err(AppError::bad("a handle is 3 to 30 letters, digits, - or _, starting with a letter"));
    }
    if RESERVED.contains(&h.as_str()) {
        return Err(AppError::bad("that handle is reserved; pick another"));
    }
    Ok(h)
}

// ── the owner's settings ───────────────────────────────────────────────────

#[derive(Serialize, Default)]
struct DeckCounts {
    private: i64,
    link: i64,
    public: i64,
}

#[derive(Serialize)]
struct Sharing {
    handle: Option<String>,
    new_deck_visibility: String,
    collection_public: bool,
    /// Shared decks show their plan's simulated win rates.
    share_lab_results: bool,
    /// Live decks by visibility.
    decks: DeckCounts,
}

async fn sharing(pool: &SqlitePool, user: &str) -> AppResult<Sharing> {
    let (handle, new_deck_visibility, collection_public, share_lab_results): (Option<String>, String, bool, bool) =
        sqlx::query_as("SELECT handle, new_deck_visibility, collection_public, share_lab_results FROM users WHERE id = ?").bind(user).fetch_one(pool).await?;
    let mut decks = DeckCounts::default();
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT visibility, COUNT(*) FROM decks WHERE owner_id = ? AND archived = 0 GROUP BY visibility")
            .bind(user)
            .fetch_all(pool)
            .await?;
    for (v, n) in rows {
        match v.as_str() {
            "link" => decks.link = n,
            "public" => decks.public = n,
            _ => decks.private = n,
        }
    }
    Ok(Sharing { handle, new_deck_visibility, collection_public, share_lab_results, decks })
}

async fn get_sharing(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Sharing>> {
    Ok(Json(sharing(&st.pool, &user.id).await?))
}

#[derive(Deserialize)]
struct SharingUpdate {
    /// A new handle; null removes it (and with it the profile).
    #[serde(default, deserialize_with = "crate::util::double_option")]
    handle: Option<Option<String>>,
    new_deck_visibility: Option<String>,
    collection_public: Option<bool>,
    share_lab_results: Option<bool>,
}

async fn put_sharing(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<SharingUpdate>) -> AppResult<Json<Sharing>> {
    if let Some(v) = &body.new_deck_visibility {
        visibility(v)?;
    }
    if let Some(h) = &body.handle {
        let h = match h.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
            Some(h) => Some(parse_handle(h)?),
            None => None,
        };
        if let Some(h) = &h {
            let taken: Option<String> =
                sqlx::query_scalar("SELECT id FROM users WHERE handle = ? AND id <> ?").bind(h).bind(&user.id).fetch_optional(&st.pool).await?;
            if taken.is_some() {
                return Err(AppError::Conflict("That handle is taken. Pick another.".into()));
            }
        }
        let res = sqlx::query("UPDATE users SET handle = ? WHERE id = ?").bind(&h).bind(&user.id).execute(&st.pool).await;
        if let Err(sqlx::Error::Database(e)) = &res
            && e.is_unique_violation()
        {
            return Err(AppError::Conflict("That handle is taken. Pick another.".into()));
        }
        res?;
    }
    if let Some(v) = &body.new_deck_visibility {
        sqlx::query("UPDATE users SET new_deck_visibility = ? WHERE id = ?").bind(v).bind(&user.id).execute(&st.pool).await?;
    }
    if let Some(c) = body.share_lab_results {
        sqlx::query("UPDATE users SET share_lab_results = ? WHERE id = ?").bind(c).bind(&user.id).execute(&st.pool).await?;
    }
    if let Some(c) = body.collection_public {
        sqlx::query("UPDATE users SET collection_public = ? WHERE id = ?").bind(c).bind(&user.id).execute(&st.pool).await?;
    }
    Ok(Json(sharing(&st.pool, &user.id).await?))
}

#[derive(Deserialize)]
struct ShareAll {
    visibility: String,
}

/// Every live deck at once, e.g. "Make all my decks public".
async fn share_all(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<ShareAll>) -> AppResult<Json<Sharing>> {
    let v = visibility(&body.visibility)?;
    sqlx::query("UPDATE decks SET visibility = ?, share_token = COALESCE(share_token, ?), updated_at = ? WHERE owner_id = ? AND archived = 0")
        .bind(v)
        .bind(new_token())
        .bind(now())
        .bind(&user.id)
        .execute(&st.pool)
        .await?;
    // COALESCE used one token for every deck that had none (only decks made before tokens):
    // give each its own.
    let dupes: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM decks WHERE owner_id = ? AND share_token IN (SELECT share_token FROM decks GROUP BY share_token HAVING COUNT(*) > 1)",
    )
    .bind(&user.id)
    .fetch_all(&st.pool)
    .await?;
    for id in dupes {
        sqlx::query("UPDATE decks SET share_token = ? WHERE id = ?").bind(new_token()).bind(&id).execute(&st.pool).await?;
    }
    Ok(Json(sharing(&st.pool, &user.id).await?))
}

// ── public projections ─────────────────────────────────────────────────────

#[derive(Deserialize)]
struct Lookup {
    #[serde(default)]
    handle: String,
}

/// The landing page's "look up a profile" form without JavaScript: `/u?handle=@saget`.
async fn lookup(axum::extract::Query(q): axum::extract::Query<Lookup>) -> axum::response::Redirect {
    match parse_handle(&q.handle) {
        Ok(h) => axum::response::Redirect::to(&format!("/u/{h}")),
        Err(_) => axum::response::Redirect::to("/"),
    }
}

fn limit(st: &AppState, address: &ClientAddress) -> AppResult<()> {
    st.limits.public_precons.check(&address_key(address.0))
}

/// A sharer, as the public sees them: their handle, if they picked one. Disabled accounts share
/// nothing.
#[derive(sqlx::FromRow, Clone)]
pub(crate) struct Sharer {
    id: String,
    pub(crate) handle: Option<String>,
    collection_public: bool,
}

async fn sharer_by_handle(pool: &SqlitePool, handle: &str) -> AppResult<Sharer> {
    let Ok(handle) = parse_handle(handle) else { return Err(AppError::NotFound("profile")) };
    sqlx::query_as("SELECT id, handle, collection_public FROM users WHERE handle = ? AND disabled_at IS NULL")
        .bind(handle)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("profile"))
}

#[derive(Serialize, Clone)]
pub(crate) struct SharedCard {
    pub(crate) name: String,
    pub(crate) qty: i64,
    pub(crate) board: Board,
    pub(crate) type_line: Option<String>,
    pub(crate) cmc: f64,
    #[serde(skip)]
    pub(crate) layout: Option<String>,
    pub(crate) image: Option<String>,
    pub(crate) printing: Option<PrintRef>,
}

/// One of a deck's shared configurations, for the switcher on its page.
#[derive(Serialize, Clone)]
pub(crate) struct SharedLink {
    pub(crate) token: String,
    pub(crate) label: String,
    pub(crate) current: bool,
}

#[derive(Clone)]
pub(crate) struct SharedDeck {
    pub(crate) sharer: Sharer,
    pub(crate) name: String,
    pub(crate) token: String,
    pub(crate) bracket: Option<i64>,
    pub(crate) updated_at: String,
    pub(crate) commanders: Vec<String>,
    pub(crate) color_identity: String,
    pub(crate) art: Option<(String, Option<String>, String)>,
    pub(crate) cards: Vec<SharedCard>,
    /// This deck and the public decks in its configuration group, main deck first.
    pub(crate) configurations: Vec<SharedLink>,
    /// The main deck of its configuration group: this deck, or the one it's a configuration of.
    pub(crate) main_id: String,
    pub(crate) version_id: Option<String>,
    pub(crate) list: Vec<DeckCard>,
    /// The plan states this deck and its listed configurations stand for, with each deck's id,
    /// this deck's first: only their simulated results can be shown.
    pub(crate) states: Vec<(String, String)>,
}

/// What the deck page says about a shared deck beyond its list, as the app's deck page does:
/// legality, Game Changers, the stored bracket check, stats, market value and the plan's newest
/// paired lab run. All of it read from what's stored; viewing never starts a check or a run.
pub(crate) struct SharedDetails {
    pub(crate) validation: crate::decks::Validation,
    pub(crate) game_changers: Option<Vec<String>>,
    pub(crate) reserved_list: Option<Vec<String>>,
    pub(crate) check: Option<crate::deck_checks::CheckResult>,
    pub(crate) stats: crate::deck_stats::DeckStats,
    pub(crate) singles: crate::deck_prices::SinglesValue,
    /// The run and the plan's key, when the plan has a paired run with a list this deck or a
    /// listed configuration stands for.
    pub(crate) sim: Option<(crate::lab::RunListItem, String)>,
    /// This deck's cards are the plan's current list for the state it stands for, so its result
    /// may be called "this list". A label alone doesn't make it so.
    pub(crate) sim_matches: bool,
    /// The states whose deck (this one or a listed configuration) has the plan's current list
    /// for it: the only results shown, in `states` order.
    pub(crate) sim_states: Vec<String>,
    /// The state this deck stands for in that plan.
    pub(crate) sim_current: Option<String>,
}

/// Commander and main deck as (name, is commander, copies), sorted, for comparing a deck with a
/// plan list: the same cards with a different commander are a different list.
fn list_key<'a>(cards: impl Iterator<Item = (&'a str, i64, &'a str)>) -> Vec<(String, bool, i64)> {
    let mut m: HashMap<(String, bool), i64> = HashMap::new();
    for (name, qty, board) in cards {
        if board != "side" {
            *m.entry((name.to_lowercase(), board == "commander")).or_default() += qty;
        }
    }
    let mut v: Vec<_> = m.into_iter().map(|((n, c), q)| (n, c, q)).collect();
    v.sort();
    v
}

/// The plan state a deck stands for: a main deck is "now"; a configuration labelled "stock" is
/// "stock", "after prints" is "after", and another label the state of the same name.
fn plan_state(configuration: Option<&str>) -> String {
    match configuration.map(|c| c.trim().to_lowercase()) {
        None => "now".into(),
        Some(c) if c == "after prints" || c == "after" => "after".into(),
        // "now" is the main deck's alone: a configuration labelled so never stands for it.
        Some(c) if c == "now" => "configuration-now".into(),
        Some(c) => c.split_whitespace().collect::<Vec<_>>().join("-"),
    }
}

pub(crate) async fn shared_details(pool: &SqlitePool, d: &SharedDeck) -> AppResult<SharedDetails> {
    let info = crate::decks::card_info(pool, &d.list).await?;
    let check = match &d.version_id {
        Some(v) => crate::deck_checks::view(pool, Some(v), false).await?.result,
        None => None,
    };
    let prices = crate::deck_prices::prices_for(pool, &d.list.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    // Only when the owner chose to show them (Group, You, Sharing).
    let shares_lab: bool = sqlx::query_scalar("SELECT share_lab_results FROM users WHERE id = ?").bind(&d.sharer.id).fetch_one(pool).await?;
    // A deck's own plan comes first: a configuration linked to its own plan is that plan's "now"
    // list, and its siblings (lists of the main deck's plan) have no part in it. Otherwise the
    // main deck's plan, with this deck and its listed configurations as its states.
    let this_id = d.states.first().map(|s| s.1.clone()).unwrap_or_else(|| d.main_id.clone());
    let plan_of = |deck: String| async move {
        if !shares_lab {
            return Ok::<Option<String>, sqlx::Error>(None);
        }
        sqlx::query_scalar("SELECT key FROM plan_decks WHERE owner_id = ? AND deck_id = ? AND status <> 'archived' ORDER BY sort LIMIT 1")
            .bind(&d.sharer.id)
            .bind(deck)
            .fetch_optional(pool)
            .await
    };
    let own = if this_id != d.main_id { plan_of(this_id.clone()).await? } else { None };
    let (key, states): (Option<String>, Vec<(String, String)>) = match own {
        Some(k) => (Some(k), vec![("now".into(), this_id.clone())]),
        None => (plan_of(d.main_id.clone()).await?, d.states.clone()),
    };
    // Each listed deck's result shows only when its cards are the plan's current list for the
    // state it stands for.
    // The plan's newest paired run, then each listed deck's result only when its cards are the
    // plan's current list for its state and that list was current when the run was made: runs
    // don't keep their inputs, so a list changed or brought back since never borrows the numbers.
    let run = match &key {
        Some(key) => crate::lab::paired_for_plan(pool, &d.sharer.id, key).await?,
        None => None,
    };
    let mut sim_states = Vec::new();
    // Whether this deck (the first of `states`) matched, not just some deck with its label.
    let mut sim_matches = false;
    if let (Some(key), Some(run)) = (&key, &run) {
        let board = |b: &Board| match b {
            Board::Commander => "commander",
            Board::Main => "main",
            Board::Side => "side",
        };
        for (i, (state, deck_id)) in states.iter().enumerate() {
            // Two listed decks standing for the same list can't both be it: show neither.
            if states.iter().filter(|(s, _)| s == state).count() > 1 {
                continue;
            }
            let plan_list: Option<(String, String)> = sqlx::query_as(
                // updated_at: when this list last became current or changed (import.rs).
                "SELECT s.cards, s.updated_at FROM plan_states s JOIN plan_decks p ON p.id = s.plan_deck_id
                 WHERE p.owner_id = ? AND p.key = ? AND s.state = ? AND s.current = 1",
            )
            .bind(&d.sharer.id)
            .bind(key)
            .bind(state)
            .fetch_optional(pool)
            .await?;
            let Some((cards, since)) = plan_list else { continue };
            // The runner writes its own timestamp format; an unreadable one proves nothing.
            let at = |t: &str| {
                chrono::DateTime::parse_from_rfc3339(t)
                    .map(|d| d.to_utc())
                    .or_else(|_| chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%.f").map(|n| n.and_utc()))
                    .ok()
            };
            if !matches!((at(&since), at(&run.run.created_at)), (Some(a), Some(b)) if a <= b) {
                continue;
            }
            let Ok(cards) = serde_json::from_str::<Vec<serde_json::Value>>(&cards) else { continue };
            let theirs = list_key(cards.iter().map(|c| {
                (c["name"].as_str().unwrap_or(""), c["qty"].as_i64().unwrap_or(1), c["board"].as_str().unwrap_or("main"))
            }));
            // This deck's cards are loaded already; a listed configuration's are its current list.
            let list = if *deck_id == this_id {
                d.list.clone()
            } else {
                let version: Option<String> = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ?").bind(deck_id).fetch_optional(pool).await?.flatten();
                match version {
                    Some(v) => crate::decks::load_version_cards(pool, &v).await?,
                    None => vec![],
                }
            };
            if !theirs.is_empty() && theirs == list_key(list.iter().map(|c| (c.name.as_str(), c.qty, board(&c.board)))) {
                sim_states.push(state.clone());
                sim_matches |= i == 0;
            }
        }
    }
    let sim = match (key, run) {
        (Some(key), Some(run)) => run
            .paired
            .as_ref()
            .is_some_and(|p| p.variants.iter().any(|v| crate::lab::variant_state(&v.id, &key).is_some_and(|s| sim_states.contains(&s))))
            .then_some((run, key)),
        _ => None,
    };
    Ok(SharedDetails {
        validation: crate::decks::validate(&d.list, &info),
        game_changers: crate::decks::game_changers(&d.list, &info),
        reserved_list: crate::decks::reserved_list(&d.list, &info),
        check,
        stats: crate::deck_stats::stats(pool, &d.list, &info).await?,
        singles: crate::deck_prices::singles(&serde_json::to_value(&d.list).map_err(anyhow::Error::from)?, &prices),
        sim,
        sim_matches,
        sim_current: states.first().map(|s| s.0.clone()),
        sim_states,
    })
}

#[derive(sqlx::FromRow)]
struct DeckRow {
    id: String,
    owner_id: String,
    name: String,
    bracket: Option<i64>,
    updated_at: String,
    current_version_id: Option<String>,
    container_id: Option<String>,
    parent_id: Option<String>,
}

/// A deck shared by link or on a profile, by its token. Private, archived and unknown decks,
/// and decks of disabled accounts, are all the same "not found".
pub(crate) async fn shared_deck(pool: &SqlitePool, token: &str) -> AppResult<SharedDeck> {
    if !valid_token(token) {
        return Err(AppError::NotFound("deck"));
    }
    let row: DeckRow = sqlx::query_as(
        "SELECT d.id, d.owner_id, d.name, d.bracket,
                COALESCE((SELECT v.created_at FROM deck_versions v WHERE v.id = d.current_version_id), d.created_at) AS updated_at,
                d.current_version_id, d.container_id, d.parent_id
         FROM decks d JOIN users u ON u.id = d.owner_id
         WHERE d.share_token = ? AND d.visibility IN ('link', 'public') AND d.archived = 0 AND u.disabled_at IS NULL",
    )
    .bind(token)
    .fetch_optional(pool)
    .await?
    .ok_or(AppError::NotFound("deck"))?;
    let sharer: Sharer =
        sqlx::query_as("SELECT id, handle, collection_public FROM users WHERE id = ?").bind(&row.owner_id).fetch_one(pool).await?;
    let list: Vec<DeckCard> = match &row.current_version_id {
        Some(v) => crate::decks::load_version_cards(pool, v).await?,
        None => vec![],
    };
    let chosen = crate::deck_import::deck_prints(pool, &row.id).await?;
    // The owner's copies of just these cards (for the printing their exports name), each card's
    // facts, and the printings of cards with neither: one query each, however long the list.
    let ids: Vec<&str> = list.iter().map(|c| c.oracle_id.as_str()).collect();
    let items = crate::collection::items_for_cards(pool, &row.owner_id, &ids).await?;
    let mut by_oracle: HashMap<&str, Vec<&crate::collection::Item>> = HashMap::new();
    for i in &items {
        if let Some(o) = i.oracle_id.as_deref() {
            by_oracle.entry(o).or_default().push(i);
        }
    }
    type Info = (Option<String>, f64, Option<String>, Option<String>, String, Option<String>, Option<String>);
    let infos: HashMap<String, Info> = sqlx::query_as::<_, (String, Option<String>, f64, Option<String>, Option<String>, String, Option<String>, Option<String>)>(
        "SELECT oracle_id, type_line, cmc, layout, image_normal, color_identity, image_art_crop, artist FROM cards
          WHERE oracle_id IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(id, t, cmc, layout, image, ci, art, artist)| (id, (t, cmc, layout, image, ci, art, artist)))
    .collect();
    let has_chosen = |c: &DeckCard| chosen.get(&c.oracle_id).and_then(|p| p.collector_number.as_ref()).is_some();
    let unprinted: Vec<&str> = list
        .iter()
        .filter(|c| !has_chosen(c) && crate::decks::owned_printing(by_oracle.get(c.oracle_id.as_str()).map(Vec::as_slice).unwrap_or_default(), row.container_id.as_deref()).is_none())
        .map(|c| c.oracle_id.as_str())
        .collect();
    let choices = crate::decks::printing_choices_for(pool, &unprinted).await?;
    let mut cards = Vec::new();
    let (mut commanders, mut identity, mut art) = (vec![], String::new(), None);
    for c in list.iter().cloned() {
        let (type_line, cmc, layout, image, ci, art_crop, artist) = infos.get(&c.oracle_id).cloned().unwrap_or((None, 0.0, None, None, String::new(), None, None));
        if c.board == Board::Commander {
            commanders.push(c.name.clone());
            identity.push_str(&ci);
            if art.is_none()
                && let Some(url) = art_crop.filter(|u| u.starts_with("https://cards.scryfall.io/"))
                && artist.is_some()
            {
                art = Some((url, artist, c.name.clone()));
            }
        }
        // As the owner's own exports name it: the printing the deck names, a copy of theirs (real
        // before proxy, the one in the deck's box first), else a paper printing.
        let mine: &[&crate::collection::Item] = by_oracle.get(c.oracle_id.as_str()).map(Vec::as_slice).unwrap_or_default();
        let chosen_print = chosen.get(&c.oracle_id).and_then(|p| {
            p.collector_number.clone().map(|n| PrintRef { set_code: p.set_code.clone(), collector_number: n, finish: p.finish.clone(), from: "chosen" })
        });
        let printing = match chosen_print.or_else(|| crate::decks::owned_printing(mine, row.container_id.as_deref())) {
            Some(p) => Some(p),
            None => crate::decks::paper_printing(choices.get(&c.oracle_id).map(Vec::as_slice).unwrap_or_default()),
        };
        cards.push(SharedCard {
            name: c.name,
            qty: c.qty,
            board: c.board,
            type_line,
            cmc,
            layout,
            image: image.filter(|u| u.starts_with("https://cards.scryfall.io/")),
            printing,
        });
    }
    let group = crate::decks::configuration_group(pool, &row.owner_id, &row.id).await?;
    let listed: Vec<_> = group
        .iter()
        // A link-only configuration is never listed elsewhere, only this deck and public ones.
        .filter(|g| g.id == row.id || g.visibility == "public")
        .collect();
    let state_of = |g: &crate::decks::ConfigurationRef| plan_state(if g.id == group[0].id { None } else { Some(g.configuration.as_deref().unwrap_or(&g.name)) });
    let mut states: Vec<(String, String)> = listed.iter().filter(|g| g.id == row.id).map(|g| (state_of(g), g.id.clone())).collect();
    states.extend(listed.iter().filter(|g| g.id != row.id).map(|g| (state_of(g), g.id.clone())));
    let configurations = listed
        .into_iter()
        .filter_map(|g| {
            Some(SharedLink {
                token: g.share_token.clone()?,
                label: display_configuration(g.configuration.as_deref(), &g.name, g.id == group[0].id),
                current: g.id == row.id,
            })
        })
        .collect();
    Ok(SharedDeck {
        sharer,
        name: row.name,
        token: token.to_string(),
        bracket: row.bracket,
        updated_at: row.updated_at,
        commanders,
        color_identity: "WUBRG".chars().filter(|c| identity.contains(*c)).collect(),
        art,
        cards,
        configurations,
        main_id: row.parent_id.clone().unwrap_or_else(|| row.id.clone()),
        version_id: row.current_version_id,
        list,
        states,
    })
}

/// What a deck list shows on its tile: its commanders, their colors, the first commander's art
/// crop (only Scryfall's, and only with its artist) and the cards outside the sideboard.
pub(crate) struct DeckFace {
    pub(crate) commanders: Vec<String>,
    pub(crate) color_identity: String,
    pub(crate) art: Option<(String, Option<String>, String)>,
    pub(crate) card_count: i64,
}

pub(crate) async fn deck_face(pool: &SqlitePool, version: Option<&str>) -> AppResult<DeckFace> {
    let cards = match version {
        Some(v) => crate::decks::load_version_cards(pool, v).await?,
        None => vec![],
    };
    let (mut commanders, mut identity, mut art) = (vec![], String::new(), None);
    for c in cards.iter().filter(|c| c.board == Board::Commander) {
        commanders.push(c.name.clone());
        let row: Option<(String, Option<String>, Option<String>)> =
            sqlx::query_as("SELECT color_identity, image_art_crop, artist FROM cards WHERE oracle_id = ?").bind(&c.oracle_id).fetch_optional(pool).await?;
        if let Some((ci, crop, artist)) = row {
            identity.push_str(&ci);
            if art.is_none()
                && let Some(url) = crop.filter(|u| u.starts_with("https://cards.scryfall.io/"))
                && artist.is_some()
            {
                art = Some((url, artist, c.name.clone()));
            }
        }
    }
    Ok(DeckFace {
        commanders,
        color_identity: "WUBRG".chars().filter(|c| identity.contains(*c)).collect(),
        art,
        card_count: cards.iter().filter(|c| c.board != Board::Side).map(|c| c.qty).sum(),
    })
}

/// A profile's public decks: each main deck with its public configurations, and any public
/// configuration whose main deck isn't public on its own.
pub(crate) struct ProfileDeck {
    pub(crate) token: String,
    pub(crate) name: String,
    pub(crate) commanders: Vec<String>,
    pub(crate) color_identity: String,
    pub(crate) art: Option<(String, Option<String>, String)>,
    pub(crate) card_count: i64,
    /// The main list's own label ("Main" unless it has one), as its page names it.
    pub(crate) label: String,
    pub(crate) configurations: Vec<(String, String)>,
}

#[derive(sqlx::FromRow)]
struct PublicRow {
    id: String,
    name: String,
    share_token: String,
    parent_id: Option<String>,
    configuration: Option<String>,
    current_version_id: Option<String>,
}

fn display_configuration(label: Option<&str>, name: &str, main: bool) -> String {
    if !main && let Some(s) = label.map(str::trim)
        && s.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("bracket "))
    {
        let (number, suffix) = s[8..].split_once(' ').unwrap_or((&s[8..], ""));
        if matches!(number, "1" | "2" | "3" | "4" | "5") {
            let suffix = suffix.trim_start_matches([' ', '—', ':', '-']);
            return format!("[{number}]{}", if suffix.is_empty() { String::new() } else { format!(" {suffix}") });
        }
    }
    match label.map(str::trim).filter(|s| !s.is_empty()) {
        None => if main { "Current".into() } else { name.into() },
        Some(s) if main && matches!(s.to_lowercase().as_str(), "main" | "current") => "Current".into(),
        Some(s) if !main && matches!(s.to_lowercase().as_str(), "stock" | "original") => "Stock".into(),
        Some(s) => s.into(),
    }
}

fn legacy_configuration(label: &str) -> bool {
    let lower = label.trim().to_lowercase();
    matches!(lower.as_str(), "now" | "after prints" | "after-prints") || lower == "legacy" || lower.starts_with("legacy:") || lower.starts_with("legacy ")
}

pub(crate) async fn profile_decks(pool: &SqlitePool, owner: &str) -> AppResult<Vec<ProfileDeck>> {
    let rows: Vec<PublicRow> = sqlx::query_as(
        "SELECT id, name, share_token, parent_id, configuration, current_version_id FROM decks
         WHERE owner_id = ? AND archived = 0 AND visibility = 'public' AND share_token IS NOT NULL
         ORDER BY lower(name)",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let shown: std::collections::HashSet<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    let mut out = Vec::new();
    for r in rows.iter().filter(|r| r.parent_id.as_deref().is_none_or(|p| !shown.contains(p))) {
        let mut configurations: Vec<(String, String)> = rows
            .iter()
            .filter(|c| c.parent_id.as_deref() == Some(r.id.as_str()))
            .map(|c| (c.share_token.clone(), display_configuration(c.configuration.as_deref(), &c.name, false)))
            .collect();
        configurations.sort_by_key(|c| (c.1 != "Stock", c.1.to_lowercase()));
        let face = deck_face(pool, r.current_version_id.as_deref()).await?;
        // A configuration listed on its own (its main deck isn't public) keeps its full name.
        out.push(ProfileDeck {
            token: r.share_token.clone(),
            name: r.name.clone(),
            commanders: face.commanders,
            color_identity: face.color_identity,
            art: face.art,
            card_count: face.card_count,
            label: display_configuration(r.configuration.as_deref(), &r.name, r.parent_id.is_none()),
            configurations,
        });
    }
    Ok(out)
}

/// One line of a shared collection: real copies only, grouped by printing, finish, language and
/// condition. No prices paid, notes, containers or proxies.
#[derive(Serialize, sqlx::FromRow, Clone)]
pub(crate) struct CollectionLine {
    pub(crate) name: String,
    pub(crate) set_code: String,
    pub(crate) set_name: Option<String>,
    pub(crate) collector_number: String,
    pub(crate) finish: String,
    pub(crate) lang: String,
    pub(crate) condition: String,
    pub(crate) qty: i64,
    pub(crate) image: Option<String>,
    pub(crate) type_line: Option<String>,
}

pub(crate) async fn shared_collection(pool: &SqlitePool, handle: &str) -> AppResult<(Sharer, Vec<CollectionLine>)> {
    let sharer = sharer_by_handle(pool, handle).await?;
    if !sharer.collection_public {
        return Err(AppError::NotFound("collection"));
    }
    let lines = sqlx::query_as(
        "SELECT c.name, p.set_code, p.set_name, p.collector_number, i.finish, i.lang, i.condition, SUM(i.qty) AS qty,
                c.image_normal AS image, c.type_line
         FROM collection_items i JOIN printings p ON p.scryfall_id = i.scryfall_id JOIN cards c ON c.oracle_id = p.oracle_id
         WHERE i.owner_id = ? AND i.proxy = 0 AND i.qty > 0
         GROUP BY c.name, p.set_code, p.collector_number, i.finish, i.lang, i.condition
         ORDER BY c.name, p.set_code, p.collector_number, i.finish",
    )
    .bind(&sharer.id)
    .fetch_all(pool)
    .await?;
    Ok((sharer, lines))
}

// ── exports ────────────────────────────────────────────────────────────────

/// The same three formats as the deck page's Export (packages/core/src/deckExport.ts).
pub(crate) const FORMATS: [(&str, &str); 3] = [("names", "Names only"), ("moxfield", "Moxfield"), ("arena", "MTG Arena")];

const FRONT_FACE_ONLY: [&str; 6] = ["transform", "modal_dfc", "adventure", "flip", "meld", "reversible_card"];

pub(crate) fn export(cards: &[SharedCard], format: &str) -> String {
    let mut sections = vec![("Commander", Board::Commander), ("Deck", Board::Main)];
    if format != "names" {
        sections.push(("Sideboard", Board::Side));
    }
    let mut out = String::new();
    for (title, board) in sections {
        let mut rows: Vec<&SharedCard> = cards.iter().filter(|c| c.board == board && c.qty > 0).collect();
        if rows.is_empty() {
            continue;
        }
        rows.sort_by(|a, b| a.name.cmp(&b.name));
        out.push_str(title);
        out.push('\n');
        for c in rows {
            let line = match (format, &c.printing) {
                ("arena", _) => {
                    let front = c.layout.as_deref().is_some_and(|l| FRONT_FACE_ONLY.contains(&l));
                    format!("{} {}", c.qty, if front { c.name.split(" // ").next().unwrap_or(&c.name) } else { &c.name })
                }
                ("moxfield", Some(p)) => {
                    let mark = match p.finish.as_str() {
                        "foil" => " *F*",
                        "etched" => " *E*",
                        _ => "",
                    };
                    format!("{} {} ({}) {}{mark}", c.qty, c.name, p.set_code.to_uppercase(), p.collector_number)
                }
                _ => format!("{} {}", c.qty, c.name),
            };
            out.push_str(&line);
            out.push('\n');
        }
        out.push('\n');
    }
    format!("{}\n", out.trim_end())
}

/// "Riders of Rohan (stock)" + "moxfield" → "riders-of-rohan-stock-moxfield.txt"
pub(crate) fn file_name(name: &str, format: &str) -> String {
    let mut slug = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    format!("{}-{format}.txt", if slug.is_empty() { "deck" } else { slug })
}

/// Account-specific public bodies: revalidated every time, so turning sharing off takes effect at
/// once, and never stored by a shared cache.
pub(crate) fn fresh(headers: &HeaderMap, body: String, content_type: &'static str) -> Response {
    let etag = format!("\"{}\"", crate::util::sha256_hex(&body));
    let unchanged = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    let mut res = if unchanged { StatusCode::NOT_MODIFIED.into_response() } else { body.into_response() };
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-cache"));
    h.insert(header::ETAG, HeaderValue::from_str(&etag).expect("hex etag"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert("x-robots-tag", HeaderValue::from_static("noindex"));
    res
}

fn attachment(mut res: Response, name: &str) -> Response {
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")) {
        res.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    res
}

async fn download(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path((token, file)): Path<(String, String)>,
) -> AppResult<Response> {
    limit(&st, &address)?;
    let format = file.strip_suffix(".txt").filter(|f| FORMATS.iter().any(|(x, _)| x == f)).ok_or(AppError::NotFound("export"))?;
    let deck = shared_deck(&st.pool, &token).await?;
    let res = fresh(&headers, export(&deck.cards, format), "text/plain; charset=utf-8");
    Ok(attachment(res, &file_name(&deck.name, format)))
}

#[derive(Serialize)]
struct PublicDeck {
    name: String,
    handle: Option<String>,
    commanders: Vec<String>,
    /// The Moxfield export: what "Save a copy in Yama" imports.
    text: String,
}

/// For "Save a copy in Yama": the import page reads the list from here.
async fn api_deck(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(token): Path<String>) -> AppResult<Response> {
    limit(&st, &address)?;
    let deck = shared_deck(&st.pool, &token).await?;
    let body = PublicDeck { text: export(&deck.cards, "moxfield"), name: deck.name, handle: deck.sharer.handle, commanders: deck.commanders };
    Ok(fresh(&headers, serde_json::to_string(&body).map_err(anyhow::Error::from)?, "application/json"))
}

fn finish_mark(finish: &str) -> &'static str {
    match finish {
        "foil" => " *F*",
        "etched" => " *E*",
        _ => "",
    }
}

async fn collection_text(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(handle): Path<String>) -> AppResult<Response> {
    limit(&st, &address)?;
    let (sharer, lines) = shared_collection(&st.pool, &handle).await?;
    let mut merged: Vec<(String, i64)> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for l in &lines {
        let key = format!("{} ({}) {}{}", l.name, l.set_code.to_uppercase(), l.collector_number, finish_mark(&l.finish));
        match at.get(&key) {
            Some(&i) => merged[i].1 += l.qty,
            None => {
                at.insert(key.clone(), merged.len());
                merged.push((key, l.qty));
            }
        }
    }
    let body: String = merged.iter().map(|(k, n)| format!("{n} {k}\n")).collect();
    let res = fresh(&headers, body, "text/plain; charset=utf-8");
    Ok(attachment(res, &format!("{}-collection.txt", sharer.handle.unwrap_or_default())))
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
}

async fn collection_csv(State(st): State<AppState>, address: ClientAddress, headers: HeaderMap, Path(handle): Path<String>) -> AppResult<Response> {
    limit(&st, &address)?;
    let (sharer, lines) = shared_collection(&st.pool, &handle).await?;
    let mut body = String::from("Count,Name,Edition,Collector Number,Foil,Condition,Language\n");
    for l in &lines {
        let foil = match l.finish.as_str() {
            "foil" => "foil",
            "etched" => "etched",
            _ => "",
        };
        body.push_str(&format!(
            "{},{},{},{},{},{},{}\n",
            l.qty,
            csv_field(&l.name),
            csv_field(&l.set_code),
            csv_field(&l.collector_number),
            foil,
            csv_field(&l.condition),
            csv_field(&l.lang)
        ));
    }
    let res = fresh(&headers, body, "text/csv; charset=utf-8");
    Ok(attachment(res, &format!("{}-collection.csv", sharer.handle.unwrap_or_default())))
}
