pub mod import;
pub mod search;
mod preview;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::limits::{ClientAddress, address_key};
use crate::routes::AppState;
use axum::extract::{Path, Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/cards/search", get(search_cards))
        .route("/api/guest/cards/search", get(guest_search_cards))
        .route("/api/cards/autocomplete", get(autocomplete))
        .route("/api/cards/preview", get(preview::get))
        .route("/api/cards/{oracle_id}", get(card_detail))
        .route("/api/cards/{oracle_id}/mine", get(card_in_my_decks))
        .route("/api/printings/lookup", get(lookup_printing))
        .route("/api/meta/data", get(data_status))
        .route("/api/cards/offline", get(offline_cards))
        .route("/api/printings/{id}/prices", get(price_history))
        .route("/api/printings/{id}/price-series", get(price_series))
        .route("/api/sets", get(set_codes))
}

pub const CARD_COLUMNS: &str = "cards.oracle_id, cards.name, cards.mana_cost, cards.cmc, cards.type_line, \
    cards.oracle_text, cards.colors, cards.color_identity, cards.power, cards.toughness, cards.loyalty, \
    cards.rarity, cards.layout, cards.legalities, cards.image_small, cards.image_normal, cards.image_art_crop, \
    cards.back_image_normal, cards.artist, cards.default_printing, cards.edhrec_rank, cards.game_changer, cards.reserved";

/// `Card::releases_on`, to select after [`CARD_COLUMNS`] from `cards`: the card's first release
/// date when every printing is dated on or after the date of the Scryfall data its legality came
/// from, so Scryfall's "not legal" may only mean "not out yet". That date is the source date of
/// the last successful oracle import (the card's own import time when none is recorded), not
/// today: the legalities stay as imported after release day, until the next oracle import.
/// An undated printing counts as out. Only cards whose every printing is known to be paper and
/// outside joke ("funny") sets qualify: digital-only cards and acorn cards stay not legal after
/// release, and a printing without that metadata (older imports) doesn't count as either.
/// Without a source date the run's start stands in, which is when it stamps `cards.updated_at`.
pub const RELEASES_ON: &str = "(SELECT CASE WHEN COUNT(*) = COUNT(p.released_at) \
        AND SUM(CASE WHEN p.digital = 0 AND p.set_type <> 'funny' THEN 0 ELSE 1 END) = 0 \
        AND MIN(p.released_at) >= COALESCE( \
            (SELECT substr(COALESCE(r.source_updated_at, r.started_at), 1, 10) FROM import_runs r \
             WHERE r.kind = 'oracle_cards' AND r.error IS NULL AND r.finished_at IS NOT NULL \
             ORDER BY r.finished_at DESC LIMIT 1), \
            date(cards.updated_at)) \
        THEN MIN(p.released_at) END \
    FROM printings p WHERE p.oracle_id = cards.oracle_id) AS releases_on";

#[derive(Debug, Serialize, sqlx::FromRow, Clone)]
pub struct Card {
    pub oracle_id: String,
    pub name: String,
    pub mana_cost: Option<String>,
    pub cmc: f64,
    pub type_line: String,
    pub oracle_text: String,
    pub colors: String,
    pub color_identity: String,
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub loyalty: Option<String>,
    pub rarity: Option<String>,
    pub layout: Option<String>,
    #[sqlx(json)]
    pub legalities: HashMap<String, String>,
    pub image_small: Option<String>,
    pub image_normal: Option<String>,
    pub image_art_crop: Option<String>,
    pub back_image_normal: Option<String>,
    pub artist: Option<String>,
    pub default_printing: Option<String>,
    pub edhrec_rank: Option<i64>,
    /// On the Commander Game Changers list, per Scryfall. `None` until an oracle import that
    /// reads the flag has run (see `import::importer_version`); never read it as false.
    pub game_changer: Option<bool>,
    /// On Wizards' Reserve List, per Scryfall. `None` until an oracle import that reads the
    /// flag has run; never read it as false.
    pub reserved: Option<bool>,
    /// The first release date of a card none of whose printings was out when its legality data
    /// was imported (a card from a set in prerelease); see [`RELEASES_ON`]. Loaded by the deck
    /// check's card queries; `None` where a query doesn't select it, and for any card out before.
    #[sqlx(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub releases_on: Option<String>,
}

#[derive(Deserialize)]
struct SearchParams {
    q: String,
    #[serde(default)]
    order: Option<String>,
    #[serde(default)]
    page: Option<u32>,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
    pub cards: Vec<SearchCard>,
}

/// A search hit, with what the results grid shows under each card.
#[derive(Serialize)]
pub struct SearchCard {
    #[serde(flatten)]
    pub card: Card,
    /// Market price of the default printing from the latest snapshot: regular, else foil, else
    /// etched; when that printing has none (a set not out yet), the lowest among the card's other
    /// printings, with that printing's date (`search::PRICE_SQL`, which a search compares and
    /// sorts by). `None` means no printing had a price; it is never 0 for "unknown".
    pub usd: Option<f64>,
    pub price_date: Option<String>,
    /// Copies of this card (any printing) in the caller's collection.
    pub owned: i64,
    /// The one binder, box or deck holding every copy, when they're all in the same place.
    pub owned_in: Option<String>,
}

const PAGE_SIZE: u32 = 60;
const GAME_CHANGERS_NOT_LOADED: &str =
    "The Game Changer list isn't loaded on this server yet, so is:gamechanger can't be searched. It comes with the next card data import.";
const RESERVED_NOT_LOADED: &str = "The Reserve List isn't loaded on this server yet, so is:reserved can't be searched. It comes with the next card data import.";
const EXTRA_LAYOUTS: &str = "('token','double_faced_token','emblem','vanguard','scheme','planar')";

/// Longest search query accepted: far more than any real search, and it keeps compiled SQL small.
const MAX_QUERY_CHARS: usize = 1_000;

async fn search_cards(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Query(p): Query<SearchParams>,
) -> AppResult<Json<SearchResult>> {
    st.limits.search.check_user(&user)?;
    Ok(Json(search(&st.pool, &user.id, &p.q, p.order.as_deref(), p.page.unwrap_or(1)).await?))
}

/// Card search without an account, for the life counter's commander fields (2026-11-01): limited
/// per address, owns nothing, and off with YAMA_GUEST_MODE=0.
async fn guest_search_cards(State(st): State<AppState>, ClientAddress(address): ClientAddress, Query(p): Query<SearchParams>) -> AppResult<Json<SearchResult>> {
    if !st.cfg.guest_mode {
        return Err(AppError::Forbidden("Card search without an account is off right now. Type the name, or sign in.".into()));
    }
    st.limits.guest_search.check(&address_key(address))?;
    Ok(Json(search(&st.pool, "", &p.q, p.order.as_deref(), p.page.unwrap_or(1)).await?))
}

/// One page of a card search for `owner` (prices and their own copies included). Shared by the
/// search page and Claude's `find_cards` tool (`mcp/`).
pub async fn search(pool: &SqlitePool, owner: &str, query: &str, order: Option<&str>, page: u32) -> AppResult<SearchResult> {
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err(AppError::bad(format!("a search can be at most {MAX_QUERY_CHARS} characters")));
    }
    let compiled = search::compile(query).map_err(AppError::BadRequest)?;
    // Before the flags are loaded every card's flag is NULL, so is:gamechanger would quietly
    // find nothing. Say why instead.
    if compiled.uses_game_changer && import::game_changers_date(pool).await?.is_none() {
        return Err(AppError::Conflict(GAME_CHANGERS_NOT_LOADED.into()));
    }
    // The same for the Reserve List: NULL until an oracle import that reads it.
    if compiled.uses_reserved && import::reserved_list_date(pool).await?.is_none() {
        return Err(AppError::Conflict(RESERVED_NOT_LOADED.into()));
    }
    let mut filter = compiled.sql;
    if !search::wants_extras(query) {
        filter = format!("({filter}) AND IFNULL(cards.layout, '') NOT IN {EXTRA_LAYOUTS}");
    }
    // Each order walks an index (cards_name, cards_cmc, cards_edhrec, migration 0063), so a page
    // of a broad search stops at its sixtieth card instead of sorting every match.
    let mut order_binds: Vec<search::Bind> = Vec::new();
    let order = match order {
        Some("mv" | "cmc") => "cards.cmc, cards.name".to_string(),
        Some("edhrec") => "cards.edhrec_rank IS NULL, cards.edhrec_rank, cards.name".to_string(),
        Some("color") => "length(cards.colors), cards.colors, cards.name".to_string(),
        // By price and by first release. These sort every match (no index gives the order): the
        // price is one lookup per card, the first release one seek in `printings_oracle_released`
        // (migration 0079). Cards with no price, or no dated printing, go last whichever way the
        // order runs.
        Some("usd") => format!("{0} IS NULL, {0} DESC, cards.name COLLATE NOCASE", search::PRICE_SQL),
        Some("usd_asc") => format!("{0} IS NULL, {0}, cards.name COLLATE NOCASE", search::PRICE_SQL),
        Some("released") => format!("{0} IS NULL, {0} DESC, cards.name COLLATE NOCASE", search::FIRST_RELEASE_SQL),
        Some("released_asc") => format!("{0} IS NULL, {0}, cards.name COLLATE NOCASE", search::FIRST_RELEASE_SQL),
        // By name. When the query types a name ("sol ring"), the card of exactly that name comes
        // first, then names that start with it, then the rest (which only contain its words:
        // Searing Soloist). That ranks every match instead of walking the name index, which is
        // fine for a name search: its LIKE already reads every card.
        _ => match search::name_phrase(query) {
            Some(phrase) => {
                let (rank, binds) = search::name_rank(&phrase);
                order_binds.extend(binds);
                format!("{rank}, cards.name COLLATE NOCASE")
            }
            None => "cards.name COLLATE NOCASE".to_string(),
        },
    };
    let page = page.max(1);
    let offset = ((page - 1) * PAGE_SIZE) as i64;

    let sql = format!("SELECT {CARD_COLUMNS} FROM cards WHERE {filter} ORDER BY {order} LIMIT {PAGE_SIZE} OFFSET ?");
    let mut q = sqlx::query_as::<_, Card>(AssertSqlSafe(sql));
    for b in compiled.binds.iter().chain(&order_binds) {
        q = match b {
            search::Bind::Text(s) => q.bind(s),
            search::Bind::Num(n) => q.bind(n),
        };
    }
    let cards = q.bind(offset).fetch_all(pool).await?;
    // A page that isn't full is the last one, so it says how many there are; only a full page
    // (or an empty one past the end) needs counting.
    let total = if cards.len() < PAGE_SIZE as usize && (offset == 0 || !cards.is_empty()) {
        offset + cards.len() as i64
    } else {
        let count_sql = format!("SELECT COUNT(*) FROM cards WHERE {filter}");
        let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(count_sql));
        for b in &compiled.binds {
            count_q = match b {
                search::Bind::Text(s) => count_q.bind(s),
                search::Bind::Num(n) => count_q.bind(n),
            };
        }
        count_q.fetch_one(pool).await?
    };
    let cards = with_price_and_ownership(pool, owner, cards).await?;
    Ok(SearchResult { total, page, page_size: PAGE_SIZE, cards })
}

/// Adds each card's default-printing price and how many copies the user owns, in two queries.
async fn with_price_and_ownership(pool: &SqlitePool, owner: &str, cards: Vec<Card>) -> AppResult<Vec<SearchCard>> {
    if cards.is_empty() {
        return Ok(vec![]);
    }
    let printings: Vec<&str> = cards.iter().filter_map(|c| c.default_printing.as_deref()).collect();
    let mut prices: HashMap<String, (Option<f64>, String)> = HashMap::new();
    if !printings.is_empty() {
        let marks = vec!["?"; printings.len()].join(",");
        let sql = format!(
            "SELECT ps.scryfall_id, COALESCE(ps.usd, ps.usd_foil, ps.usd_etched), ps.date FROM price_latest ps
             WHERE ps.scryfall_id IN ({marks})"
        );
        let mut q = sqlx::query_as::<_, (String, Option<f64>, String)>(AssertSqlSafe(sql));
        for id in &printings {
            q = q.bind(*id);
        }
        for (id, usd, date) in q.fetch_all(pool).await? {
            prices.insert(id, (usd, date));
        }
    }
    // A default printing with no price (a set that isn't out yet): the lowest price among the
    // card's other printings, as the search compares and sorts by.
    let unpriced: Vec<&str> =
        cards.iter().filter(|c| c.default_printing.as_deref().and_then(|id| prices.get(id)).is_none_or(|(usd, _)| usd.is_none())).map(|c| c.oracle_id.as_str()).collect();
    let mut lowest: HashMap<String, (f64, String)> = HashMap::new();
    if !unpriced.is_empty() {
        let rows: Vec<(String, Option<f64>, String)> = sqlx::query_as(
            "SELECT p.oracle_id, MIN(COALESCE(ps.usd, ps.usd_foil, ps.usd_etched)), ps.date FROM printings p
             JOIN price_latest ps ON ps.scryfall_id = p.scryfall_id
             WHERE p.oracle_id IN (SELECT value FROM json_each(?)) GROUP BY p.oracle_id",
        )
        .bind(serde_json::to_string(&unpriced).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?;
        for (oracle_id, usd, date) in rows {
            if let Some(usd) = usd {
                lowest.insert(oracle_id, (usd, date));
            }
        }
    }
    let marks = vec!["?"; cards.len()].join(",");
    let sql = format!(
        "SELECT p.oracle_id, SUM(i.qty), COUNT(DISTINCT IFNULL(i.container_id, '')), MIN(ct.name), MIN(i.container_id IS NULL)
         FROM collection_items i
         JOIN printings p ON p.scryfall_id = i.scryfall_id
         LEFT JOIN containers ct ON ct.id = i.container_id
         WHERE i.owner_id = ? AND i.qty > 0 AND p.oracle_id IN ({marks})
         GROUP BY p.oracle_id"
    );
    let mut q = sqlx::query_as::<_, (String, i64, i64, Option<String>, bool)>(AssertSqlSafe(sql)).bind(owner);
    for c in &cards {
        q = q.bind(&c.oracle_id);
    }
    let mut owned: HashMap<String, (i64, Option<String>)> = HashMap::new();
    for (oracle_id, qty, places, name, any_loose) in q.fetch_all(pool).await? {
        let place = if places == 1 && !any_loose { name } else { None };
        owned.insert(oracle_id, (qty, place));
    }
    Ok(cards
        .into_iter()
        .map(|card| {
            let (mut usd, mut price_date) = card
                .default_printing
                .as_deref()
                .and_then(|id| prices.get(id))
                .map(|(usd, date)| (*usd, Some(date.clone())))
                .unwrap_or((None, None));
            if usd.is_none()
                && let Some((other, date)) = lowest.get(&card.oracle_id)
            {
                usd = Some(*other);
                price_date = Some(date.clone());
            }
            let (owned, owned_in) = owned.remove(&card.oracle_id).unwrap_or((0, None));
            SearchCard { card, usd, price_date, owned, owned_in }
        })
        .collect())
}

#[derive(Deserialize)]
struct AutoParams {
    q: String,
}

async fn autocomplete(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Query(p): Query<AutoParams>,
) -> AppResult<Json<Vec<String>>> {
    let q = p.q.trim();
    if q.len() < 2 {
        return Ok(Json(vec![]));
    }
    st.limits.autocomplete.check_user(&user)?;
    if q.chars().count() > 200 {
        return Ok(Json(vec![]));
    }
    // Names that start with it first, from card_names' index (faces included); then, if there's
    // room, names that contain it.
    let mut names: Vec<String> = sqlx::query_scalar(
        "SELECT c.name FROM card_names n JOIN cards c ON c.oracle_id = n.oracle_id
          WHERE n.name LIKE ? ESCAPE '\\' AND IFNULL(c.layout,'') NOT IN ('token','double_faced_token','emblem')
          GROUP BY c.oracle_id ORDER BY c.edhrec_rank IS NULL, c.edhrec_rank, c.name LIMIT 15",
    )
    .bind(format!("{}%", escape(q)))
    .fetch_all(&st.pool)
    .await?;
    if names.len() < 15 {
        let more: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM cards WHERE name LIKE ? ESCAPE '\\' AND IFNULL(layout,'') NOT IN ('token','double_faced_token','emblem')
             ORDER BY edhrec_rank IS NULL, edhrec_rank, name LIMIT 30",
        )
        .bind(format!("%{}%", escape(q)))
        .fetch_all(&st.pool)
        .await?;
        for name in more {
            if names.len() == 15 {
                break;
            }
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    Ok(Json(names))
}

fn escape(v: &str) -> String {
    v.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Printing {
    pub scryfall_id: String,
    pub oracle_id: String,
    pub name: String,
    pub set_code: String,
    pub set_name: String,
    pub collector_number: String,
    pub lang: String,
    pub rarity: Option<String>,
    #[sqlx(json)]
    pub finishes: Vec<String>,
    pub released_at: Option<String>,
    pub image_normal: Option<String>,
    pub image_small: Option<String>,
    pub back_image_normal: Option<String>,
    pub artist: Option<String>,
    /// Latest snapshot. `None` means Scryfall had no price; it is never 0 for "unknown".
    pub price_date: Option<String>,
    pub usd: Option<f64>,
    pub usd_foil: Option<f64>,
    pub usd_etched: Option<f64>,
    pub eur: Option<f64>,
    pub eur_foil: Option<f64>,
}

pub const PRINTING_SELECT: &str = "SELECT p.scryfall_id, p.oracle_id, p.name, p.set_code, p.set_name, p.collector_number,
    p.lang, p.rarity, p.finishes, p.released_at, p.image_normal, p.image_small, p.back_image_normal, p.artist,
    ps.date AS price_date, ps.usd, ps.usd_foil, ps.usd_etched, ps.eur, ps.eur_foil
    FROM printings p
    LEFT JOIN price_latest ps ON ps.scryfall_id = p.scryfall_id";

#[derive(Serialize)]
struct CardDetail {
    card: Card,
    printings: Vec<Printing>,
    /// Oldest first, as Scryfall lists them. `None` (null) when no rulings import has
    /// succeeded yet, so an empty list really means the card has no rulings.
    rulings: Option<Vec<Ruling>>,
}

/// One ruling from Scryfall's rulings file. `source` is "wotc" (Wizards) or "scryfall".
#[derive(Debug, Serialize, sqlx::FromRow, PartialEq)]
pub struct Ruling {
    pub source: String,
    pub published_at: String,
    pub comment: String,
}

pub async fn rulings_for(pool: &SqlitePool, oracle_id: &str) -> AppResult<Vec<Ruling>> {
    Ok(sqlx::query_as(
        "SELECT source, published_at, comment FROM rulings WHERE oracle_id = ? ORDER BY published_at, rowid",
    )
    .bind(oracle_id)
    .fetch_all(pool)
    .await?)
}

async fn card_detail(
    State(st): State<AppState>,
    _user: CurrentUser,
    Path(oracle_id): Path<String>,
) -> AppResult<Json<CardDetail>> {
    let card = sqlx::query_as::<_, Card>(AssertSqlSafe(format!("SELECT {CARD_COLUMNS} FROM cards WHERE oracle_id = ?")))
        .bind(&oracle_id)
        .fetch_optional(&st.pool)
        .await?
        .ok_or(AppError::NotFound("card"))?;
    let printings = sqlx::query_as::<_, Printing>(AssertSqlSafe(format!(
        "{PRINTING_SELECT} WHERE p.oracle_id = ? ORDER BY p.released_at DESC, p.set_code, p.collector_number"
    )))
    .bind(&oracle_id)
    .fetch_all(&st.pool)
    .await?;
    let rulings = match import::current_import_date(&st.pool, "rulings").await? {
        Some(_) => Some(rulings_for(&st.pool, &oracle_id).await?),
        None => None,
    };
    Ok(Json(CardDetail { card, printings, rulings }))
}

/// A deck of the caller's whose current list has the card.
#[derive(Serialize, sqlx::FromRow)]
struct DeckUse {
    deck_id: String,
    /// The deck's name; a configuration's already says which ("Omo (stock)").
    name: String,
    /// Copies in the list, over every board.
    qty: i64,
    /// Where the list has it: "commander" if it is in the command zone, else "main", else "side".
    board: String,
    /// Whether Yama has Commander Spellbook's answer for this list. Without one, no combos
    /// shown for the deck means "not checked yet", not "none".
    #[sqlx(skip)]
    checked: bool,
    #[serde(skip)]
    version_id: String,
    /// The card's name as this list writes it (Spellbook's answer names cards the same way).
    #[serde(skip)]
    listed_name: Option<String>,
}

/// A deck a combo was found in.
#[derive(Serialize)]
struct ComboDeck {
    deck_id: String,
    name: String,
}

/// A combo Commander Spellbook found in those decks' lists that the card is part of, once,
/// with every deck it was found in. Nothing is asked of Spellbook here: these are the answers
/// Yama already keeps for each deck version (`deck_checks`).
#[derive(Serialize)]
struct DeckCombo {
    decks: Vec<ComboDeck>,
    /// When Spellbook answered for the first of those lists.
    checked_at: String,
    #[serde(flatten)]
    combo: crate::deck_checks::Combo,
}

#[derive(Serialize)]
struct CardInDecks {
    decks: Vec<DeckUse>,
    combos: Vec<DeckCombo>,
    /// Combos left out of `combos` (it holds the first [`MAX_CARD_COMBOS`]).
    more_combos: usize,
}

/// The most combos one card page lists.
const MAX_CARD_COMBOS: usize = 30;

/// `GET /api/cards/{oracle_id}/mine`: what the caller's own decks do with a card.
async fn card_in_my_decks(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(oracle_id): Path<String>) -> AppResult<Json<CardInDecks>> {
    Ok(Json(card_in_decks(&st.pool, &user.id, &oracle_id).await?))
}

/// `owner`'s live decks whose current list has the card, by name, and the kept Spellbook combos
/// of those lists that name it. Every query is bound to the owner, and a deck's list is read
/// only if that version is the deck's own: nobody else's decks, lists or combos are read.
async fn card_in_decks(pool: &SqlitePool, owner: &str, oracle_id: &str) -> AppResult<CardInDecks> {
    let name: String = sqlx::query_scalar("SELECT name FROM cards WHERE oracle_id = ?").bind(oracle_id).fetch_optional(pool).await?.ok_or(AppError::NotFound("card"))?;
    let mut decks: Vec<DeckUse> = sqlx::query_as(
        "SELECT d.id AS deck_id, d.name, v.id AS version_id,
                SUM(json_extract(je.value, '$.qty')) AS qty,
                CASE WHEN SUM(json_extract(je.value, '$.board') = 'commander') > 0 THEN 'commander'
                     WHEN SUM(json_extract(je.value, '$.board') = 'main') > 0 THEN 'main' ELSE 'side' END AS board,
                MIN(json_extract(je.value, '$.name')) AS listed_name
         FROM decks d JOIN deck_versions v ON v.id = d.current_version_id AND v.deck_id = d.id JOIN json_each(v.cards) je
         WHERE d.owner_id = ?1 AND d.archived = 0 AND json_extract(je.value, '$.oracle_id') = ?2
         GROUP BY d.id ORDER BY d.name COLLATE NOCASE, d.id",
    )
    .bind(owner)
    .bind(oracle_id)
    .fetch_all(pool)
    .await?;
    let mut combos: Vec<DeckCombo> = Vec::new();
    let mut more_combos = 0;
    if !decks.is_empty() {
        let versions: Vec<&str> = decks.iter().map(|d| d.version_id.as_str()).collect();
        let checks: Vec<(String, String, String)> = sqlx::query_as(
            "SELECT version_id, combos, checked_at FROM deck_version_checks
             WHERE source = ? AND combos IS NOT NULL AND checked_at IS NOT NULL AND version_id IN (SELECT value FROM json_each(?))",
        )
        .bind(crate::deck_checks::SPELLBOOK)
        .bind(serde_json::to_string(&versions).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?;
        for d in decks.iter_mut() {
            let Some((_, json, checked_at)) = checks.iter().find(|(version, _, _)| *version == d.version_id) else { continue };
            d.checked = true;
            // Spellbook's answer names a card as the deck's list does; a list may name one face.
            let listed = d.listed_name.as_deref().unwrap_or(&name);
            let is_card = |n: &str| n.eq_ignore_ascii_case(&name) || n.eq_ignore_ascii_case(listed) || name.split(" // ").any(|face| face.eq_ignore_ascii_case(n));
            let found: Vec<crate::deck_checks::Combo> = serde_json::from_str(json).unwrap_or_default();
            for combo in found.into_iter().filter(|c| c.cards.iter().any(|n| is_card(n))) {
                let deck = ComboDeck { deck_id: d.deck_id.clone(), name: d.name.clone() };
                // The same combo in another deck (a configuration of the same list, say): once, with both.
                let seen = combos.iter().position(|c| c.combo.id == combo.id);
                match seen {
                    Some(i) => combos[i].decks.push(deck),
                    None if combos.len() < MAX_CARD_COMBOS => combos.push(DeckCombo { decks: vec![deck], checked_at: checked_at.clone(), combo }),
                    None => more_combos += 1,
                }
            }
        }
    }
    Ok(CardInDecks { decks, combos, more_combos })
}

#[derive(Deserialize)]
struct LookupParams {
    set: String,
    number: String,
    lang: Option<String>,
}

async fn lookup_printing(
    State(st): State<AppState>,
    _user: CurrentUser,
    Query(p): Query<LookupParams>,
) -> AppResult<Json<Printing>> {
    let printing = printing_by_set_number(&st.pool, &p.set, &p.number, p.lang.as_deref())
        .await?
        .ok_or(AppError::NotFound("printing"))?;
    Ok(Json(printing))
}

/// A printing by set code (any case) and collector number, with its latest price snapshot.
/// Prefers `lang` (English when `None`) and falls back to another language of the same
/// printing. `None` when Yama's card data doesn't have it; callers keep the reference rather
/// than drop it.
pub async fn printing_by_set_number(pool: &SqlitePool, set: &str, number: &str, lang: Option<&str>) -> AppResult<Option<Printing>> {
    Ok(sqlx::query_as::<_, Printing>(AssertSqlSafe(format!(
        "{PRINTING_SELECT} WHERE p.set_code = ? AND p.collector_number = ? ORDER BY (p.lang = ?) DESC, p.scryfall_id LIMIT 1"
    )))
    .bind(set.trim().to_lowercase())
    .bind(number.trim())
    .bind(lang.unwrap_or("en"))
    .fetch_optional(pool)
    .await?)
}

#[derive(Serialize)]
struct DataStatus {
    cards: i64,
    printings: i64,
    latest_price_date: Option<String>,
    last_imports: Vec<ImportRun>,
}

#[derive(Serialize, sqlx::FromRow)]
struct ImportRun {
    kind: String,
    source_updated_at: Option<String>,
    finished_at: Option<String>,
    rows: Option<i64>,
    error: Option<String>,
}

async fn data_status(State(st): State<AppState>, _user: CurrentUser) -> AppResult<Json<DataStatus>> {
    Ok(Json(DataStatus {
        cards: sqlx::query_scalar("SELECT COUNT(*) FROM cards").fetch_one(&st.pool).await?,
        printings: sqlx::query_scalar("SELECT COUNT(*) FROM printings").fetch_one(&st.pool).await?,
        latest_price_date: import::latest_price_date(&st.pool).await?,
        last_imports: sqlx::query_as(
            "SELECT kind, source_updated_at, finished_at, rows, error FROM import_runs ORDER BY started_at DESC LIMIT 5",
        )
        .fetch_all(&st.pool)
        .await?,
    }))
}

/// Resolve card names (any face, any case) to oracle IDs. Unknown names are left out. One card
/// each: real cards before tokens, a card's own name before another
/// card's face ("Swords to Plowshares" is also the back of Emeritus of Truce), then the more played
/// card when two share a face name ("Fire" is in Fire // Ice and Start // Fire).
pub async fn resolve_names(pool: &SqlitePool, names: &[String]) -> AppResult<HashMap<String, String>> {
    let mut out = HashMap::new();
    for name in names {
        let key = name.trim();
        let hit: Option<String> = sqlx::query_scalar(
            "SELECT n.oracle_id FROM card_names n JOIN cards c ON c.oracle_id = n.oracle_id
             WHERE n.name = ?
             ORDER BY IFNULL(c.layout,'') IN ('token','double_faced_token','art_series'), c.name = n.name COLLATE NOCASE DESC,
                      IFNULL(c.edhrec_rank, 1000000000) LIMIT 1",
        )
        .bind(key)
        .fetch_optional(pool)
        .await?;
        if let Some(id) = hit {
            out.insert(name.clone(), id);
        }
    }
    Ok(out)
}

/// Compact card list for offline search on the device. Field names match `OfflineCard` in
/// packages/core/src/search.ts. Only the formats the app filters on are included.
#[derive(Serialize, sqlx::FromRow)]
struct OfflineCard {
    i: String,
    n: String,
    m: Option<String>,
    v: f64,
    t: String,
    o: String,
    c: String,
    ci: String,
    p: Option<String>,
    th: Option<String>,
    l: Option<String>,
    r: Option<String>,
    #[sqlx(json)]
    k: Vec<String>,
    #[sqlx(json)]
    f: HashMap<String, String>,
    y: Option<String>,
    img: Option<String>,
    e: Option<i64>,
    /// Game Changer. Sent only when true, to keep the bundle small; `game_changers` on the
    /// bundle says whether a missing value means false or not loaded.
    #[serde(skip_serializing_if = "not_true")]
    g: Option<bool>,
}

fn not_true(v: &Option<bool>) -> bool {
    *v != Some(true)
}

/// Shape of the offline bundle. The app downloads again when its saved copy has another
/// format. 2: `game_changers` and `g`.
const OFFLINE_FORMAT: u32 = 2;

#[derive(Serialize)]
struct OfflineBundle {
    format: u32,
    /// Changes whenever the card data is re-imported.
    version: String,
    /// Whether the Game Changer flags were loaded when this bundle was made. If not, the app
    /// treats every card's flag as unknown.
    game_changers: bool,
    cards: Vec<OfflineCard>,
}

/// The offline bundle's validator (web PR #111): its format, the card data's version and whether
/// the Game Changer flags were loaded, which is everything that changes the bundle.
fn offline_etag(version: &str, game_changers: bool) -> String {
    format!("\"{OFFLINE_FORMAT}-{version}-{}\"", u8::from(game_changers))
}

/// The last bundle sent, encoded, by its ETag: building one reads every card (24 MB of JSON).
static OFFLINE: std::sync::Mutex<Option<(String, axum::body::Bytes)>> = std::sync::Mutex::new(None);
/// One build at a time.
static OFFLINE_BUILD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn offline_kept(etag: &str) -> Option<axum::body::Bytes> {
    // Test databases are all in memory under one name: an ETag can't tell them apart.
    if cfg!(test) {
        return None;
    }
    OFFLINE.lock().unwrap_or_else(|e| e.into_inner()).as_ref().filter(|(k, _)| k == etag).map(|(_, b)| b.clone())
}

/// `GET /api/cards/offline`. A copy the device already has (`If-None-Match`) is a 304, decided
/// before anything is built, and doesn't count against the hourly limit.
async fn offline_cards(State(st): State<AppState>, CurrentUser(user): CurrentUser, headers: axum::http::HeaderMap) -> AppResult<axum::response::Response> {
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse;
    let version = import::cards_changed_at(&st.pool).await?.unwrap_or_default();
    let game_changers = import::game_changers_date(&st.pool).await?.is_some();
    let etag = offline_etag(&version, game_changers);
    let validators = [(header::ETAG, etag.clone()), (header::CACHE_CONTROL, "private, no-cache".to_string())];
    if crate::util::etag_matches(&headers, &etag) {
        return Ok((StatusCode::NOT_MODIFIED, validators).into_response());
    }
    st.limits.offline_cards.check_user(&user)?;
    let body = match offline_kept(&etag) {
        Some(b) => b,
        None => {
            let _building = OFFLINE_BUILD.lock().await;
            match offline_kept(&etag) {
                Some(b) => b,
                None => {
                    let bundle = offline_bundle(&st.pool, version, game_changers).await?;
                    let b = axum::body::Bytes::from(serde_json::to_vec(&bundle).map_err(anyhow::Error::from)?);
                    *OFFLINE.lock().unwrap_or_else(|e| e.into_inner()) = Some((etag.clone(), b.clone()));
                    b
                }
            }
        }
    };
    Ok((validators, [(header::CONTENT_TYPE, "application/json".to_string())], body).into_response())
}

async fn offline_bundle(pool: &SqlitePool, version: String, game_changers: bool) -> AppResult<OfflineBundle> {
    let cards = sqlx::query_as::<_, OfflineCard>(
        "SELECT oracle_id AS i, name AS n, mana_cost AS m, cmc AS v, type_line AS t, oracle_text AS o, colors AS c,
                color_identity AS ci, power AS p, toughness AS th, loyalty AS l, rarity AS r,
                (SELECT json_group_array(lower(value)) FROM json_each(cards.keywords)) AS k,
                json_object('commander', json_extract(legalities, '$.commander'),
                            'standard', json_extract(legalities, '$.standard'),
                            'pioneer', json_extract(legalities, '$.pioneer'),
                            'modern', json_extract(legalities, '$.modern'),
                            'legacy', json_extract(legalities, '$.legacy'),
                            'vintage', json_extract(legalities, '$.vintage'),
                            'pauper', json_extract(legalities, '$.pauper'),
                            'brawl', json_extract(legalities, '$.brawl')) AS f,
                layout AS y, image_normal AS img, edhrec_rank AS e, game_changer AS g
         FROM cards ORDER BY name",
    )
    .fetch_all(pool)
    .await?;
    Ok(OfflineBundle { format: OFFLINE_FORMAT, version, game_changers, cards })
}

#[derive(Deserialize)]
struct HistoryRange {
    from: Option<String>,
    to: Option<String>,
}

/// One printing's prices on each day Yama read Scryfall's file, from its first price, oldest
/// first (`?from=`, `?to=`, YYYY-MM-DD). Gaps are days we didn't import. The same shape as before
/// the history (2026-11-02), with Cardmarket foil and etched and MTGO tickets added.
async fn price_history(
    State(st): State<AppState>,
    _u: CurrentUser,
    Path(id): Path<String>,
    Query(range): Query<HistoryRange>,
) -> AppResult<Json<Vec<crate::prices::history::DayPoint>>> {
    let (from, to) = crate::prices::history::range(range.from.as_deref(), range.to.as_deref())?;
    Ok(Json(crate::prices::history::history(&st.pool, &id, from, to).await?))
}

/// Every series a printing has prices in, Scryfall's and MTGJSON's (Card Kingdom retail and
/// buylist, Mana Pool's lowest listing): each with its provider, kind, finish and label, and its
/// changes over its own feed's observed days (`?from=`, `?to=`). One series per entry, never a
/// number made from two providers.
async fn price_series(
    State(st): State<AppState>,
    _u: CurrentUser,
    Path(id): Path<String>,
    Query(range): Query<HistoryRange>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let (from, to) = crate::prices::history::range(range.from.as_deref(), range.to.as_deref())?;
    let series: Vec<(i64, String, String, String, String, String, String)> = sqlx::query_as(
        "SELECT s.id, s.feed, s.provider, s.kind, s.finish, s.currency, s.label FROM price_series s
          WHERE EXISTS (SELECT 1 FROM price_printing k JOIN price_point pp ON pp.printing = k.id WHERE k.scryfall_id = ? AND pp.series = s.id)
          ORDER BY s.id",
    )
    .bind(&id)
    .fetch_all(&st.pool)
    .await?;
    let mut out = Vec::with_capacity(series.len());
    for (sid, feed, provider, kind, finish, currency, label) in series {
        let h = crate::prices::history::changes(&st.pool, &id, sid, from, to).await?;
        let point = |p: &Option<(String, Option<f64>)>| p.as_ref().map(|(d, v)| serde_json::json!({"date": d, "price": v}));
        let extreme = |p: &Option<(String, f64)>| p.as_ref().map(|(d, v)| serde_json::json!({"date": d, "price": v}));
        out.push(serde_json::json!({
            "id": sid, "feed": feed, "provider": provider, "kind": kind, "finish": finish, "currency": currency, "label": label,
            "observed_days": h.observed_days, "first": point(&h.first), "last": point(&h.last), "low": extreme(&h.low), "high": extreme(&h.high),
            "changes": h.changes.iter().map(|(d, v)| serde_json::json!({"date": d, "price": v})).collect::<Vec<_>>(),
        }));
    }
    Ok(Json(out))
}

/// Every set code we have printings for, so the scanner only looks up real sets.
async fn set_codes(State(st): State<AppState>, _u: CurrentUser) -> AppResult<Json<Vec<String>>> {
    Ok(Json(sqlx::query_scalar("SELECT DISTINCT set_code FROM printings ORDER BY set_code").fetch_all(&st.pool).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{app, send, user};
    use axum::http::{Method, StatusCode};

    async fn seed(pool: &SqlitePool) {
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES ('o1', 'Sol Ring', 'Artifact', 'now')")
            .execute(pool)
            .await
            .unwrap();
        for (id, set, num, lang) in [("p-en", "cmm", "410", "en"), ("p-ja", "cmm", "410", "ja"), ("p-sta-ja", "sta", "1", "ja")] {
            sqlx::query(
                "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, updated_at)
                 VALUES (?, 'o1', 'Sol Ring', ?, 'Set', ?, ?, '[\"nonfoil\"]', 'now')",
            )
            .bind(id)
            .bind(set)
            .bind(num)
            .bind(lang)
            .execute(pool)
            .await
            .unwrap();
        }
        // An older and a newer snapshot; the newer one has no foil price.
        sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd, usd_foil) VALUES ('p-en', '2026-10-17', 1.25, 9.0), ('p-en', '2026-10-18', 1.5, NULL)")
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn autocomplete_puts_names_that_start_with_it_first_and_search_counts_only_full_pages() {
        let (app, pool) = app().await;
        let (_, token) = user(&pool, "me@example.com").await;
        // The popular card contains "sol"; the obscure one starts with it, as does a face.
        for (id, name, rank, face) in [("o1", "Absolute Law", 10, None), ("o2", "Solemn Simulacrum", 900, None), ("o3", "Fable // Solar Kiki", 5, Some("solar kiki"))] {
            sqlx::query("INSERT INTO cards (oracle_id, name, type_line, edhrec_rank, updated_at) VALUES (?, ?, 'Artifact', ?, 'now')")
                .bind(id)
                .bind(name)
                .bind(rank)
                .execute(&pool)
                .await
                .unwrap();
            for n in std::iter::once(name.to_lowercase()).chain(face.map(String::from)) {
                sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(n).bind(id).execute(&pool).await.unwrap();
            }
        }
        let (status, names) = send(&app, Method::GET, "/api/cards/autocomplete?q=sol", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(names, serde_json::json!(["Fable // Solar Kiki", "Solemn Simulacrum", "Absolute Law"]));
        // A page that isn't full gives the total without a count; it's right either way.
        let r = search(&pool, "", "t:artifact", None, 1).await.unwrap();
        assert_eq!((r.total, r.cards.len()), (3, 3));
        assert_eq!(r.cards.iter().map(|c| c.card.name.as_str()).collect::<Vec<_>>(), ["Absolute Law", "Fable // Solar Kiki", "Solemn Simulacrum"]);
        assert_eq!(search(&pool, "", "t:artifact", None, 2).await.unwrap().total, 3);
    }

    #[tokio::test]
    async fn the_offline_list_carries_its_version_as_an_etag_and_an_unchanged_copy_is_a_304() {
        use axum::body::Body;
        use axum::http::{Request, header};
        use tower::ServiceExt;
        let (app, pool) = app().await;
        sqlx::query(
            "INSERT INTO cards (oracle_id, name, mana_cost, cmc, type_line, oracle_text, colors, color_identity, keywords, legalities, updated_at)
             VALUES ('o1', 'Sol Ring', '{1}', 1, 'Artifact', '{T}: Add {C}{C}.', '', '', '[]', '{\"commander\":\"legal\",\"standard\":\"legal\",\"pioneer\":\"legal\",\"modern\":\"legal\",\"legacy\":\"legal\",\"vintage\":\"legal\",\"pauper\":\"legal\",\"brawl\":\"legal\"}', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let import = |id: &str, at: &str| {
            sqlx::query("INSERT INTO import_runs (id, kind, started_at, finished_at, rows) VALUES (?, 'oracle_cards', ?, ?, 1)").bind(id.to_string()).bind(at.to_string()).bind(at.to_string())
        };
        import("r1", "2026-11-01T00:02:00Z").execute(&pool).await.unwrap();
        let (_, token) = user(&pool, "bryan@example.com").await;
        let get = |etag: Option<String>| {
            let mut req = Request::builder().uri("/api/cards/offline").header(header::AUTHORIZATION, format!("Bearer {token}"));
            if let Some(e) = etag {
                req = req.header(header::IF_NONE_MATCH, e);
            }
            app.clone().oneshot(req.body(Body::empty()).unwrap())
        };
        let res = get(None).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let etag = res.headers()[header::ETAG].to_str().unwrap().to_string();
        assert_eq!(etag, format!("\"{OFFLINE_FORMAT}-2026-11-01T00:02:00Z-0\""));
        assert_eq!(res.headers()[header::CACHE_CONTROL], "private, no-cache");
        let body: serde_json::Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
        assert_eq!((body["version"].as_str(), body["cards"][0]["n"].as_str()), (Some("2026-11-01T00:02:00Z"), Some("Sol Ring")));
        // The copy the device has: a 304 with no body, as often as it likes (the hourly limit is 10).
        for _ in 0..15 {
            let again = get(Some(format!("W/{etag}"))).await.unwrap();
            assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
            assert_eq!(again.headers()[header::ETAG], etag.as_str());
            assert!(axum::body::to_bytes(again.into_body(), usize::MAX).await.unwrap().is_empty());
        }
        // New card data: a new version, and the old copy gets the new list.
        import("r2", "2026-11-02T00:02:00Z").execute(&pool).await.unwrap();
        let res = get(Some(etag.clone())).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_ne!(res.headers()[header::ETAG], etag.as_str());
    }

    #[tokio::test]
    async fn finds_a_printing_by_set_and_number() {
        let pool = crate::db::test_pool().await;
        seed(&pool).await;

        // Any case and stray spaces; English first; the latest price, with a missing foil price left missing.
        let p = printing_by_set_number(&pool, "CMM", " 410 ", None).await.unwrap().unwrap();
        assert_eq!(p.scryfall_id, "p-en");
        assert_eq!(p.price_date.as_deref(), Some("2026-10-18"));
        assert_eq!((p.usd, p.usd_foil), (Some(1.5), None));

        // Another language when asked for; no snapshot means no price and no date, never 0.
        let p = printing_by_set_number(&pool, "cmm", "410", Some("ja")).await.unwrap().unwrap();
        assert_eq!(p.scryfall_id, "p-ja");
        assert_eq!((p.price_date, p.usd), (None, None));

        // Falls back to another language of the same printing.
        let p = printing_by_set_number(&pool, "sta", "1", None).await.unwrap().unwrap();
        assert_eq!(p.scryfall_id, "p-sta-ja");

        assert!(printing_by_set_number(&pool, "cmm", "999", None).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn search_hits_carry_price_and_ownership() {
        let (app, pool) = app().await;
        seed(&pool).await;
        sqlx::query("UPDATE cards SET default_printing = 'p-en'").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, default_printing, updated_at) VALUES ('o2', 'Sol Talisman', 'Artifact', 'p-none', 'now')")
            .execute(&pool)
            .await
            .unwrap();
        let (me, token) = user(&pool, "bryan@example.com").await;
        let (other, _) = user(&pool, "sam@example.com").await;
        sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES ('box', ?, 'deck', 'Riders of Rohan', 'now')")
            .bind(&me)
            .execute(&pool)
            .await
            .unwrap();
        for (id, owner, printing, qty, container) in
            [("i1", &me, "p-en", 1, Some("box")), ("i2", &me, "p-ja", 2, Some("box")), ("i3", &other, "p-en", 5, None)]
        {
            sqlx::query(
                "INSERT INTO collection_items (id, owner_id, scryfall_id, qty, container_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'now', 'now')",
            )
            .bind(id)
            .bind(owner)
            .bind(printing)
            .bind(qty)
            .bind(container)
            .execute(&pool)
            .await
            .unwrap();
        }
        let (status, body) = send(&app, Method::GET, "/api/cards/search?q=sol", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        let ring = &body["cards"][0];
        assert_eq!(ring["name"], "Sol Ring");
        // The latest snapshot's price and date; only the caller's copies, and the one place they're all in.
        assert_eq!((ring["usd"].as_f64(), ring["price_date"].as_str()), (Some(1.5), Some("2026-10-18")));
        assert_eq!((ring["owned"].as_i64(), ring["owned_in"].as_str()), (Some(3), Some("Riders of Rohan")));
        // No snapshot: no price and no date, never 0; none owned.
        let talisman = &body["cards"][1];
        assert_eq!((talisman["usd"].clone(), talisman["price_date"].clone()), (serde_json::Value::Null, serde_json::Value::Null));
        assert_eq!((talisman["owned"].as_i64(), talisman["owned_in"].clone()), (Some(0), serde_json::Value::Null));

        // A loose copy as well: the copies are no longer all in one place.
        sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, created_at, updated_at) VALUES ('i4', ?, 'p-en', 1, 'now', 'now')")
            .bind(&me)
            .execute(&pool)
            .await
            .unwrap();
        let (_, body) = send(&app, Method::GET, "/api/cards/search?q=sol", Some(&token), None).await;
        assert_eq!((body["cards"][0]["owned"].as_i64(), body["cards"][0]["owned_in"].clone()), (Some(4), serde_json::Value::Null));
    }

    #[tokio::test]
    async fn a_typed_name_puts_its_exact_and_prefix_matches_first() {
        let pool = crate::db::test_pool().await;
        seed(&pool).await;
        // Every one of these has "sol" and "ring" somewhere in its name.
        for (id, name) in [("o-a", "Searing Soloist"), ("o-b", "Insolent Ringleader"), ("o-c", "Sol Ringbearer"), ("o-d", "Absolver of Rings")] {
            sqlx::query("INSERT INTO cards (oracle_id, name, type_line, cmc, updated_at) VALUES (?, ?, 'Artifact', 3, 'now')")
                .bind(id)
                .bind(name)
                .execute(&pool)
                .await
                .unwrap();
        }
        let names = |r: SearchResult| r.cards.into_iter().map(|c| c.card.name).collect::<Vec<_>>();

        // By name (the default): the card of that name, then names starting with it, then A to Z.
        let by_name = names(search(&pool, "", "sol ring", None, 1).await.unwrap());
        assert_eq!(by_name, ["Sol Ring", "Sol Ringbearer", "Absolver of Rings", "Insolent Ringleader", "Searing Soloist"]);
        // Any case, quoted or not, with other terms beside it.
        assert_eq!(names(search(&pool, "", "SOL RING t:artifact", Some("name"), 1).await.unwrap()), by_name);
        assert_eq!(names(search(&pool, "", r#""sol ring""#, None, 1).await.unwrap()), ["Sol Ring", "Sol Ringbearer"]);
        // A prefix alone: names starting with it lead.
        assert_eq!(names(search(&pool, "", "sol", None, 1).await.unwrap())[..2], ["Sol Ring", "Sol Ringbearer"]);
        // No name typed: plain A to Z. Another order is that order.
        assert_eq!(names(search(&pool, "", "t:artifact", None, 1).await.unwrap())[..2], ["Absolver of Rings", "Insolent Ringleader"]);
        assert_eq!(names(search(&pool, "", "sol ring", Some("mv"), 1).await.unwrap())[0], "Sol Ring");
        assert_eq!(names(search(&pool, "", "sol ring", Some("mv"), 1).await.unwrap())[1], "Absolver of Rings");
        // The count is unchanged by the order.
        assert_eq!(search(&pool, "", "sol ring", None, 1).await.unwrap().total, 5);
    }

    #[tokio::test]
    async fn searches_by_set_artist_year_and_price_and_sorts_by_price_and_release() {
        let pool = crate::db::test_pool().await;
        let printing = "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, finishes, released_at, artist, updated_at)
                        VALUES (?, ?, ?, ?, 'Set', '1', 'en', '[\"nonfoil\"]', ?, ?, 'now')";
        // (oracle id, name, default printing, set, artist, released, price). Mana Crypt has no
        // price. Swiftfoot Boots' default printing is from a set that isn't out and has none.
        for (oid, name, pid, set, artist, released, usd) in [
            ("o-ring", "Sol Ring", "p-ring", "cmm", "Mike Bierek", "2023-08-04", Some(1.5)),
            ("o-lotus", "Black Lotus", "p-lotus", "lea", "Christopher Rush", "1993-08-05", Some(50000.0)),
            ("o-crypt", "Mana Crypt", "p-crypt", "cmm", "Matt Stewart", "2023-08-04", None),
            ("o-boots", "Swiftfoot Boots", "p-boots-new", "trk", "Svetlin Velinov", "2026-11-13", None),
        ] {
            sqlx::query("INSERT INTO cards (oracle_id, name, type_line, default_printing, updated_at) VALUES (?, ?, 'Artifact', ?, 'now')")
                .bind(oid)
                .bind(name)
                .bind(pid)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(printing).bind(pid).bind(oid).bind(name).bind(set).bind(released).bind(artist).execute(&pool).await.unwrap();
            if let Some(usd) = usd {
                sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES (?, '2026-11-01', ?)").bind(pid).bind(usd).execute(&pool).await.unwrap();
            }
        }
        // Sol Ring's first printing: another set, another artist, thirty years earlier. The
        // Boots' older printing, which has a price.
        sqlx::query(printing).bind("p-ring-lea").bind("o-ring").bind("Sol Ring").bind("lea").bind("1993-08-05").bind("Mark Tedin").execute(&pool).await.unwrap();
        sqlx::query(printing).bind("p-boots-old").bind("o-boots").bind("Swiftfoot Boots").bind("c21").bind("2021-04-23").bind("Svetlin Velinov").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES ('p-boots-old', '2026-10-30', 1.87)").execute(&pool).await.unwrap();
        async fn names(pool: &SqlitePool, query: &str, order: Option<&str>) -> Vec<String> {
            search(pool, "", query, order, 1).await.unwrap().cards.into_iter().map(|c| c.card.name).collect()
        }
        let none: [&str; 0] = [];

        // A set or an artist is matched over every printing, not only the one shown.
        assert_eq!(names(&pool, "set:lea", None).await, ["Black Lotus", "Sol Ring"]);
        assert_eq!(names(&pool, "e:CMM", None).await, ["Mana Crypt", "Sol Ring"]);
        assert_eq!(names(&pool, "a:tedin", None).await, ["Sol Ring"]);
        assert_eq!(names(&pool, r#"a:"christopher rush""#, None).await, ["Black Lotus"]);
        assert_eq!(names(&pool, "year<2000", None).await, ["Black Lotus", "Sol Ring"]);
        assert_eq!(names(&pool, "year=2023", None).await, ["Mana Crypt", "Sol Ring"]);
        // Printing terms side by side are about one printing. Sol Ring was printed in Alpha
        // and in 2023, but its Alpha printing isn't from 2023, and nothing of it is from between.
        assert_eq!(names(&pool, "set:lea year>=2020", None).await, none);
        assert_eq!(names(&pool, "year>=2000 year<=2022", None).await, ["Swiftfoot Boots"]);
        assert_eq!(names(&pool, "set:cmm a:tedin", None).await, none);
        assert_eq!(names(&pool, "set:lea a:tedin t:artifact", None).await, ["Sol Ring"]);
        // Negated: no printing like it at all.
        assert_eq!(names(&pool, "-set:cmm", None).await, ["Black Lotus", "Swiftfoot Boots"]);
        assert_eq!(names(&pool, "-year<2000", None).await, ["Mana Crypt", "Swiftfoot Boots"]);
        // A card with no price is neither under nor over anything, negated or not. A card whose
        // default printing has none is priced by its cheapest other printing.
        assert_eq!(names(&pool, "usd<5", None).await, ["Sol Ring", "Swiftfoot Boots"]);
        assert_eq!(names(&pool, "usd>=5", None).await, ["Black Lotus"]);
        assert_eq!(names(&pool, "-usd<5", None).await, ["Black Lotus"]);
        assert_eq!(names(&pool, "usd>0 or usd<=0", None).await, ["Black Lotus", "Sol Ring", "Swiftfoot Boots"]);
        // The price shown is the one compared, with the date of the printing it came from.
        let boots = search(&pool, "", "boots", None, 1).await.unwrap().cards.remove(0);
        assert_eq!((boots.usd, boots.price_date.as_deref()), (Some(1.87), Some("2026-10-30")));
        let crypt = search(&pool, "", "crypt", None, 1).await.unwrap().cards.remove(0);
        assert_eq!((crypt.usd, crypt.price_date), (None, None));
        // By price either way, and by first release either way: no price goes last both times.
        assert_eq!(names(&pool, "t:artifact", Some("usd")).await, ["Black Lotus", "Swiftfoot Boots", "Sol Ring", "Mana Crypt"]);
        assert_eq!(names(&pool, "t:artifact", Some("usd_asc")).await, ["Sol Ring", "Swiftfoot Boots", "Black Lotus", "Mana Crypt"]);
        assert_eq!(names(&pool, "t:artifact", Some("released")).await, ["Mana Crypt", "Swiftfoot Boots", "Black Lotus", "Sol Ring"]);
        assert_eq!(names(&pool, "t:artifact", Some("released_asc")).await, ["Black Lotus", "Sol Ring", "Swiftfoot Boots", "Mana Crypt"]);
        assert_eq!(search(&pool, "", "t:artifact", Some("usd"), 1).await.unwrap().total, 4);

        // The Reserve List isn't loaded: say so, rather than find nothing.
        assert!(matches!(search(&pool, "", "is:reserved", None, 1).await, Err(AppError::Conflict(_))));
        sqlx::query("INSERT INTO import_runs (id, kind, started_at, finished_at, rows, importer_version) VALUES ('r1', 'oracle_cards', '2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z', 3, 99)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE cards SET reserved = (oracle_id = 'o-lotus')").execute(&pool).await.unwrap();
        assert_eq!(names(&pool, "is:reserved", None).await, ["Black Lotus"]);
        assert_eq!(names(&pool, "-is:reserved", None).await, ["Mana Crypt", "Sol Ring", "Swiftfoot Boots"]);
    }

    #[tokio::test]
    async fn the_new_is_values_run_in_sqlite_and_keep_cards_with_nothing_to_read() {
        let pool = crate::db::test_pool().await;
        // (name, type line, mana cost, rules text, layout, keywords)
        for (name, type_line, cost, text, layout, keywords) in [
            ("Boros Reckoner", "Creature — Minotaur Wizard", Some("{R/W}{R/W}{R/W}"), "Whenever Boros Reckoner is dealt damage, it deals that much damage to any target.", Some("normal"), "[]"),
            ("Gitaxian Probe", "Sorcery", Some("{U/P}"), "Look at target player's hand.", Some("normal"), "[]"),
            ("Spellskite", "Artifact Creature — Phyrexian Horror", Some("{2}"), "{U/P}: Change a target of target spell or ability to Spellskite.", Some("normal"), "[]"),
            ("Grizzly Bears", "Creature — Bear", Some("{1}{G}"), "", Some("normal"), "[]"),
            ("Tymna the Weaver", "Legendary Creature — Human Cleric", Some("{1}{W}{B}"), "Lifelink\nPartner", Some("normal"), "[\"Lifelink\",\"Partner\"]"),
            ("Diviner's Wand", "Kindred Artifact — Wizard Equipment", Some("{3}"), "Equipped creature has a draw ability.", Some("normal"), "[\"Equip\"]"),
            ("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", "Enchantment — Saga // Enchantment Creature — Goblin Shaman", Some("{2}{R}"), "Read ahead.", Some("transform"), "[]"),
            ("Forest", "Basic Land — Forest", None, "({T}: Add {G}.)", None, "[]"),
        ] {
            sqlx::query("INSERT INTO cards (oracle_id, name, type_line, mana_cost, oracle_text, layout, keywords, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'now')")
                .bind(name)
                .bind(name)
                .bind(type_line)
                .bind(cost)
                .bind(text)
                .bind(layout)
                .bind(keywords)
                .execute(&pool)
                .await
                .unwrap();
        }
        async fn names(pool: &SqlitePool, query: &str) -> Vec<String> {
            search(pool, "", query, None, 1).await.unwrap().cards.into_iter().map(|c| c.card.name).collect()
        }
        // Hybrid is two halves that aren't Phyrexian; Phyrexian mana counts in the cost or the text.
        assert_eq!(names(&pool, "is:hybrid").await, ["Boros Reckoner"]);
        assert_eq!(names(&pool, "is:phyrexian").await, ["Gitaxian Probe", "Spellskite"]);
        assert_eq!(names(&pool, "is:vanilla").await, ["Grizzly Bears"]);
        assert_eq!(names(&pool, "is:partner").await, ["Tymna the Weaver"]);
        // A party is creatures: the Wizard's wand isn't in it.
        assert_eq!(names(&pool, "is:party").await, ["Boros Reckoner", "Tymna the Weaver"]);
        // A Saga by its type line, whatever its layout; the same card is double-faced.
        assert_eq!(names(&pool, "is:saga").await, ["Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"]);
        assert_eq!(names(&pool, "is:dfc").await, ["Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"]);
        assert_eq!(names(&pool, "is:transform").await, ["Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"]);
        // A card with no mana cost or no layout isn't hybrid or double-faced, and the negation finds it.
        assert_eq!(names(&pool, "-is:hybrid -is:phyrexian -is:dfc t:land").await, ["Forest"]);
        assert_eq!(names(&pool, "-is:transform t:basic").await, ["Forest"]);
    }

    #[tokio::test]
    async fn a_card_page_lists_my_decks_with_the_card_and_their_combos_with_it() {
        let (app, pool) = app().await;
        seed(&pool).await;
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES ('o2', 'Dramatic Reversal', 'Instant', 'now')").execute(&pool).await.unwrap();
        let (me, token) = user(&pool, "me@example.com").await;
        let (other, other_token) = user(&pool, "sam@example.com").await;
        let ring = r#"{"oracle_id":"o1","name":"Sol Ring","qty":1,"board":"main"}"#;
        let reversal = r#"{"oracle_id":"o2","name":"Dramatic Reversal","qty":1,"board":"main"}"#;
        // (deck, owner, name, archived, list). "alpha" has the ring in the command zone and the sideboard.
        for (id, owner, name, archived, cards) in [
            ("d1", &me, "Zeta", 0, format!("[{ring}]")),
            ("d2", &me, "alpha", 0, format!(r#"[{{"oracle_id":"o1","name":"Sol Ring","qty":1,"board":"commander"}},{{"oracle_id":"o1","name":"Sol Ring","qty":2,"board":"side"}},{reversal}]"#)),
            ("d3", &me, "Old", 1, format!("[{ring}]")),
            ("d4", &me, "No ring", 0, format!("[{reversal}]")),
            ("d5", &other, "Theirs", 0, format!("[{ring}]")),
        ] {
            sqlx::query("INSERT INTO decks (id, owner_id, name, current_version_id, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'now', 'now')")
                .bind(id)
                .bind(owner)
                .bind(name)
                .bind(format!("v-{id}"))
                .bind(archived)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO deck_versions (id, deck_id, cards, created_at) VALUES (?, ?, ?, 'now')").bind(format!("v-{id}")).bind(id).bind(cards).execute(&pool).await.unwrap();
        }
        // A deck of mine that points at their version (it can't through Yama, but nothing in the
        // schema stops it) reads nothing of theirs.
        sqlx::query("INSERT INTO decks (id, owner_id, name, current_version_id, archived, created_at, updated_at) VALUES ('d6', ?, 'Borrowed', 'v-d5', 0, 'now', 'now')")
            .bind(&me)
            .execute(&pool)
            .await
            .unwrap();
        // A configuration of Zeta with the same list, checked like alpha's.
        sqlx::query("INSERT INTO decks (id, owner_id, name, current_version_id, archived, created_at, updated_at) VALUES ('d7', ?, 'Zeta (stock)', 'v-d7', 0, 'now', 'now')")
            .bind(&me)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO deck_versions (id, deck_id, cards, created_at) VALUES ('v-d7', 'd7', ?, 'now')").bind(format!("[{ring},{reversal}]")).execute(&pool).await.unwrap();
        // Spellbook's kept answers: alpha's list has a combo with the ring and one without; so has their deck.
        let found = r#"[{"id":"1-2","cards":["Sol Ring","Dramatic Reversal"],"results":["Infinite colorless mana"]},{"id":"3-4","cards":["Dramatic Reversal","Isochron Scepter"],"results":["Infinite untaps"]}]"#;
        for version in ["v-d2", "v-d5", "v-d7"] {
            sqlx::query("INSERT INTO deck_version_checks (version_id, source, requested_at, checked_at, bracket_tag, combos) VALUES (?, 'commander_spellbook', '2026-11-01T00:00:00Z', '2026-11-01T00:00:05Z', 'C', ?)")
                .bind(version)
                .bind(found)
                .execute(&pool)
                .await
                .unwrap();
        }
        fn decks(body: &serde_json::Value) -> Vec<(String, String, i64)> {
            body["decks"].as_array().unwrap().iter().map(|d| (d["name"].as_str().unwrap().to_string(), d["board"].as_str().unwrap().to_string(), d["qty"].as_i64().unwrap())).collect()
        }

        let (status, body) = send(&app, Method::GET, "/api/cards/o1/mine", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        // By name whatever its case. Not the archived deck, the deck without the card, the deck
        // pointing at someone else's version, or anyone else's.
        assert_eq!(
            decks(&body),
            vec![("alpha".to_string(), "commander".to_string(), 3), ("Zeta".to_string(), "main".to_string(), 1), ("Zeta (stock)".to_string(), "main".to_string(), 1)]
        );
        assert_eq!(body["decks"][0]["deck_id"], "d2");
        assert!(body["decks"][0].get("version_id").is_none() && body["decks"][0].get("listed_name").is_none(), "{body}");
        // Which lists Spellbook has answered for: Zeta's hasn't been checked, which isn't "no combos".
        assert_eq!(body["decks"].as_array().unwrap().iter().map(|d| d["checked"].as_bool().unwrap()).collect::<Vec<_>>(), [true, false, true]);
        // Only the combo the card is part of, once, with both of the caller's decks it is in.
        let combos = body["combos"].as_array().unwrap();
        assert_eq!(combos.len(), 1, "{body}");
        assert_eq!(combos[0]["id"], "1-2");
        assert_eq!(combos[0]["decks"], serde_json::json!([{"deck_id": "d2", "name": "alpha"}, {"deck_id": "d7", "name": "Zeta (stock)"}]));
        assert_eq!(combos[0]["checked_at"], "2026-11-01T00:00:05Z");
        assert_eq!(combos[0]["results"], serde_json::json!(["Infinite colorless mana"]));
        assert_eq!(body["more_combos"], 0);

        // The other account sees its own deck and combo, and nothing of the caller's.
        let (_, theirs) = send(&app, Method::GET, "/api/cards/o1/mine", Some(&other_token), None).await;
        assert_eq!(decks(&theirs), vec![("Theirs".to_string(), "main".to_string(), 1)]);
        assert_eq!(theirs["combos"].as_array().unwrap().len(), 1);
        assert_eq!(theirs["combos"][0]["decks"], serde_json::json!([{"deck_id": "d5", "name": "Theirs"}]));
        // A card in none of their decks: two empty lists.
        let (status, none) = send(&app, Method::GET, "/api/cards/o2/mine", Some(&other_token), None).await;
        assert_eq!((status, none), (StatusCode::OK, serde_json::json!({"decks": [], "combos": [], "more_combos": 0})));
        // A card Yama doesn't have, and a caller who isn't signed in.
        assert_eq!(send(&app, Method::GET, "/api/cards/nope/mine", Some(&token), None).await.0, StatusCode::NOT_FOUND);
        assert_eq!(send(&app, Method::GET, "/api/cards/o1/mine", None, None).await.0, StatusCode::UNAUTHORIZED);
        let _ = (me, other);
    }

    #[tokio::test]
    async fn guests_search_without_an_account_until_it_is_switched_off() {
        let (app, pool) = app().await;
        seed(&pool).await;
        let (status, body) = send(&app, Method::GET, "/api/guest/cards/search?q=sol", None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!((body["cards"][0]["name"].as_str(), body["cards"][0]["owned"].as_i64()), (Some("Sol Ring"), Some(0)));
        // The account search still wants one.
        assert_eq!(send(&app, Method::GET, "/api/cards/search?q=sol", None, None).await.0, StatusCode::UNAUTHORIZED);
        // YAMA_GUEST_MODE=0 turns it off.
        let off = crate::routes::app(crate::testutil::state_with(crate::config::Config { guest_mode: false, ..crate::testutil::config() }, pool).await);
        assert_eq!(send(&off, Method::GET, "/api/guest/cards/search?q=sol", None, None).await.0, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn the_lookup_route_uses_it() {
        let (app, pool) = app().await;
        seed(&pool).await;
        let (_, token) = user(&pool, "bryan@example.com").await;
        let (status, body) = send(&app, Method::GET, "/api/printings/lookup?set=CMM&number=410", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["scryfall_id"], "p-en");
        assert_eq!(body["usd_foil"], serde_json::Value::Null);
        let (status, _) = send(&app, Method::GET, "/api/printings/lookup?set=cmm&number=999", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
