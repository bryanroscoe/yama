//! Decks: text import, immutable versions, Commander validation, and owned/needed against the collection.

use crate::auth::CurrentUser;
use crate::cards::{CARD_COLUMNS, Card};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{AssertSqlSafe, SqliteConnection, SqlitePool};
use std::collections::{BTreeMap, HashMap};

pub mod cli;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/decks", get(list_decks).post(create_deck))
        .route("/api/decks/parse", post(parse_preview))
        .route("/api/decks/{id}", get(get_deck).put(save_version).patch(update_deck).delete(archive_deck))
        .route("/api/decks/{id}/versions", get(list_versions))
        .route("/api/decks/{id}/versions/{version}", get(get_version))
        .route("/api/decks/{id}/check", get(get_check).post(recheck))
        .route("/api/decks/{id}/results", get(results))
        .route("/api/decks/{id}/share-link", post(reset_share_link))
        .route("/api/decks/{id}/configurations", post(new_configuration))
        .route("/api/decks/{id}/use", post(use_list))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Board {
    Commander,
    Main,
    Side,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeckCard {
    pub oracle_id: String,
    pub name: String,
    pub qty: i64,
    pub board: Board,
}

// ── parsing ────────────────────────────────────────────────────────────────

#[derive(Debug, PartialEq)]
pub struct ParsedLine {
    pub qty: i64,
    pub name: String,
    pub board: Board,
}

/// Parse a deck list. Understands `1 Name`, `1x Name`, Arena/Moxfield `1 Name (SET) 123 *F*`,
/// section headers (`Commander`, `Deck`, `Sideboard`, `// Commander`), and comments.
/// With no Commander section, `first_is_commander` makes the first card the commander
/// (the convention in Bryan's commander-decks lists).
pub fn parse_list(text: &str, first_is_commander: bool) -> Vec<ParsedLine> {
    let mut out = Vec::new();
    let mut board = Board::Main;
    let mut saw_commander_section = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let header = line.trim_start_matches("//").trim_start_matches('#').trim().trim_end_matches(':').to_lowercase();
        let header = header.split(['(', ' ']).next().unwrap_or("");
        match header {
            "commander" | "commanders" => {
                board = Board::Commander;
                saw_commander_section = true;
                continue;
            }
            "deck" | "main" | "mainboard" | "maindeck" | "creatures" | "lands" | "spells" => {
                board = Board::Main;
                continue;
            }
            "sideboard" | "side" | "maybeboard" | "considering" => {
                board = Board::Side;
                continue;
            }
            _ => {}
        }
        if line.starts_with("//") || line.starts_with('#') {
            continue;
        }
        let (qty, rest) = match line.split_once(' ') {
            Some((n, rest)) if n.trim_end_matches(['x', 'X']).parse::<i64>().is_ok() => {
                (n.trim_end_matches(['x', 'X']).parse().unwrap(), rest.trim())
            }
            _ => (1, line),
        };
        // Drop "(SET) 123", foil markers and tags.
        let mut name = rest;
        if let Some(i) = name.find(" (") {
            name = &name[..i];
        }
        let name = name.split(" *").next().unwrap_or(name).split(" #").next().unwrap_or(name).trim();
        if name.is_empty() || qty <= 0 {
            continue;
        }
        out.push(ParsedLine { qty, name: name.to_string(), board: board.clone() });
    }
    if first_is_commander && !saw_commander_section && let Some(first) = out.first_mut() {
        if first.qty == 1 {
            first.board = Board::Commander;
        }
    }
    out
}

#[derive(Serialize)]
pub(crate) struct ParseResult {
    pub(crate) cards: Vec<DeckCard>,
    pub(crate) unknown: Vec<String>,
}

#[derive(Deserialize)]
struct ParseRequest {
    text: String,
    #[serde(default = "yes")]
    first_is_commander: bool,
}

fn yes() -> bool {
    true
}

pub(crate) async fn resolve(pool: &SqlitePool, lines: Vec<ParsedLine>) -> AppResult<ParseResult> {
    let names: Vec<String> = lines.iter().map(|l| l.name.clone()).collect();
    let ids = crate::cards::resolve_names(pool, &names).await?;
    let mut cards: Vec<DeckCard> = Vec::new();
    let mut unknown = Vec::new();
    for l in lines {
        match ids.get(&l.name) {
            Some(oid) => {
                let canonical: String =
                    sqlx::query_scalar("SELECT name FROM cards WHERE oracle_id = ?").bind(oid).fetch_one(pool).await?;
                if let Some(existing) = cards.iter_mut().find(|c| &c.oracle_id == oid && c.board == l.board) {
                    existing.qty += l.qty;
                } else {
                    cards.push(DeckCard { oracle_id: oid.clone(), name: canonical, qty: l.qty, board: l.board });
                }
            }
            None => unknown.push(l.name),
        }
    }
    Ok(ParseResult { cards, unknown })
}

async fn parse_preview(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(req): Json<ParseRequest>) -> AppResult<Json<ParseResult>> {
    st.limits.deck_writes.check_user(&user)?;
    Ok(Json(resolve(&st.pool, parse_list(&req.text, req.first_is_commander)).await?))
}

// ── decks ──────────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
struct DeckSummary {
    #[sqlx(skip)]
    singles_value: crate::deck_prices::SinglesValue,
    id: String,
    name: String,
    folder: Option<String>,
    format: String,
    container_id: Option<String>,
    acquisition_status: Option<String>,
    current_version_id: Option<String>,
    updated_at: String,
    /// The bracket the owner declares (1-5), or none.
    bracket: Option<i64>,
    /// The main deck this is a configuration of, and its label ("stock"). A main deck has no
    /// parent; its own label, if any, names its main list.
    parent_id: Option<String>,
    configuration: Option<String>,
    /// private | link | public (`sharing.rs`), and the token in its link (`/d/<token>`).
    visibility: String,
    share_token: Option<String>,
    /// Commander Spellbook's estimate for the current version, once it has answered.
    #[sqlx(skip)]
    estimate: Option<crate::deck_checks::Estimated>,
    #[sqlx(skip)]
    commanders: Vec<String>,
    #[sqlx(skip)]
    color_identity: String,
    #[sqlx(skip)]
    card_count: i64,
    #[sqlx(skip)]
    commander_image: Option<String>,
    /// Who painted `commander_image` (credit it wherever the art shows).
    #[sqlx(skip)]
    commander_artist: Option<String>,
    /// Real (non-proxy) copies you own of the main deck and commanders, out of `card_count`.
    #[sqlx(skip)]
    owned: i64,
    /// Further copies covered by proxies (a card counts once: real copies first).
    #[sqlx(skip)]
    proxies: i64,
    /// Finished games this deck was played in (any version), and how they went.
    #[sqlx(skip)]
    games: i64,
    #[sqlx(skip)]
    wins: i64,
    #[sqlx(skip)]
    draws: i64,
}

async fn list_decks(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<DeckSummary>>> {
    let mut decks: Vec<DeckSummary> = sqlx::query_as(
        "SELECT id, name, folder, format, container_id, current_version_id, updated_at, bracket, parent_id, configuration,
                visibility, share_token,
                CASE WHEN parent_id IS NULL THEN acquisition_status ELSE
                  (SELECT root.acquisition_status FROM decks root WHERE root.id = decks.parent_id AND root.owner_id = decks.owner_id)
                END AS acquisition_status FROM decks
         WHERE owner_id = ? AND archived = 0 ORDER BY folder, name",
    )
    .bind(&user.id)
    .fetch_all(&st.pool)
    .await?;
    // A fixed number of queries however many decks: ownership counted per card in SQL, every
    // version's cards, prices, check estimates, game results and commanders each in one.
    let owned = crate::collection::owned_by_oracle(&st.pool, &user.id).await?;
    let versions: Vec<String> = decks.iter().filter_map(|d| d.current_version_id.clone()).collect();
    let mut estimates = crate::deck_checks::estimates(&st.pool, &versions).await?;
    let cards_by_version = load_versions_cards(&st.pool, &versions).await?;
    // Price only the cards these decks hold, not every card Yama knows.
    let ids: std::collections::BTreeSet<&str> = cards_by_version.values().flatten().map(|c| c.oracle_id.as_str()).collect();
    let market_prices = crate::deck_prices::prices_for(&st.pool, &ids.into_iter().collect::<Vec<_>>()).await?;
    // Same rule as the deck page's results (stats::results_by_version): only seats where the
    // owner played the deck themselves, so the computer piloting it online doesn't count.
    let results: HashMap<String, (i64, i64, i64)> = sqlx::query_as::<_, (String, i64, i64, i64)>(
        "SELECT v.deck_id, COUNT(*), IFNULL(SUM(g.winner_seat = s.seat), 0), IFNULL(SUM(g.winner_seat IS NULL), 0)
         FROM game_seats s JOIN games g ON g.id = s.game_id JOIN deck_versions v ON v.id = s.deck_version_id
         JOIN decks d ON d.id = v.deck_id
         WHERE d.owner_id = ?1 AND d.archived = 0 AND g.status = 'finished' AND s.ai_kind IS NULL AND s.user_id = ?1
         GROUP BY v.deck_id",
    )
    .bind(&user.id)
    .fetch_all(&st.pool)
    .await?
    .into_iter()
    .map(|(deck, games, wins, draws)| (deck, (games, wins, draws)))
    .collect();
    let commander_ids: Vec<&str> = cards_by_version.values().flatten().filter(|c| c.board == Board::Commander).map(|c| c.oracle_id.as_str()).collect();
    let commander_cards: HashMap<String, (String, Option<String>, Option<String>)> = sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
        "SELECT oracle_id, color_identity, image_art_crop, artist FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(&commander_ids).map_err(anyhow::Error::from)?)
    .fetch_all(&st.pool)
    .await?
    .into_iter()
    .map(|(id, ci, art, artist)| (id, (ci, art, artist)))
    .collect();
    for d in &mut decks {
        d.estimate = d.current_version_id.as_ref().and_then(|v| estimates.remove(v));
        (d.games, d.wins, d.draws) = results.get(&d.id).copied().unwrap_or_default();
        let Some(cards) = d.current_version_id.as_ref().and_then(|v| cards_by_version.get(v)) else { continue };
        d.singles_value = crate::deck_prices::singles(&serde_json::to_value(cards).map_err(anyhow::Error::from)?, &market_prices);
        d.card_count = cards.iter().filter(|c| c.board != Board::Side).map(|c| c.qty).sum();
        for c in cards.iter().filter(|c| c.board != Board::Side) {
            let (have, proxies) = owned.get(&c.oracle_id).copied().unwrap_or_default();
            let real = c.qty.min(have);
            d.owned += real;
            d.proxies += (c.qty - real).min(proxies);
        }
        let commanders: Vec<&DeckCard> = cards.iter().filter(|c| c.board == Board::Commander).collect();
        d.commanders = commanders.iter().map(|c| c.name.clone()).collect();
        let mut identity = String::new();
        for c in &commanders {
            if let Some((ci, art, artist)) = commander_cards.get(&c.oracle_id) {
                identity.push_str(ci);
                if d.commander_image.is_none() && art.is_some() {
                    d.commander_image = art.clone();
                    d.commander_artist = artist.clone();
                }
            }
        }
        d.color_identity = "WUBRG".chars().filter(|c| identity.contains(*c)).collect();
    }
    Ok(Json(decks))
}

#[derive(Deserialize)]
struct NewDeck {
    name: String,
    folder: Option<String>,
    /// Either a pasted list…
    text: Option<String>,
    #[serde(default = "yes")]
    first_is_commander: bool,
    /// …or resolved cards.
    cards: Option<Vec<DeckCard>>,
    /// Printings the import named, kept with the deck (deck_import::save_prints).
    #[serde(default)]
    prints: Vec<crate::deck_import::DeckPrint>,
}

#[derive(Serialize)]
struct Created {
    id: String,
    unknown: Vec<String>,
}

async fn create_deck(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<NewDeck>) -> AppResult<Json<Created>> {
    st.limits.deck_writes.check_user(&user)?;
    let (cards, unknown) = match (body.cards, body.text) {
        (Some(cards), _) => (cards, vec![]),
        (None, Some(text)) => {
            let r = resolve(&st.pool, parse_list(&text, body.first_is_commander)).await?;
            (r.cards, r.unknown)
        }
        (None, None) => (vec![], vec![]),
    };
    let id = create_deck_with_cards(&st.pool, &user.id, &body.name, body.folder.as_deref(), cards).await?;
    crate::deck_import::save_prints(&st.pool, &id, &body.prints).await?;
    Ok(Json(Created { id, unknown }))
}

pub async fn create_deck_with_cards(
    pool: &SqlitePool,
    owner: &str,
    name: &str,
    folder: Option<&str>,
    cards: Vec<DeckCard>,
) -> AppResult<String> {
    create_deck_with_note(pool, owner, name, folder, cards, "created").await
}

/// As `create_deck_with_cards`, with the first version's note. The planner uses it to say which
/// plan list a deck was made from.
pub async fn create_deck_with_note(
    pool: &SqlitePool,
    owner: &str,
    name: &str,
    folder: Option<&str>,
    cards: Vec<DeckCard>,
    note: &str,
) -> AppResult<String> {
    let mut tx = pool.begin().await?;
    let id = create_deck_in(&mut tx, owner, name, folder, &cards, note).await?;
    tx.commit().await?;
    crate::deck_checks::wake();
    Ok(id)
}

/// As `create_deck_with_note`, inside the caller's transaction, so the deck commits (or rolls
/// back) together with the caller's own writes (the lab's op record for a precon deck). The
/// version's outside check is queued in the same transaction; call `deck_checks::wake()` after
/// committing.
pub async fn create_deck_in(
    conn: &mut SqliteConnection,
    owner: &str,
    name: &str,
    folder: Option<&str>,
    cards: &[DeckCard],
    note: &str,
) -> AppResult<String> {
    if name.trim().is_empty() {
        return Err(AppError::bad("deck needs a name"));
    }
    let id = new_id();
    let stamp = now();
    // A new deck starts as its owner's chosen default (Sharing, under Group, You).
    sqlx::query(
        "INSERT INTO decks (id, owner_id, name, folder, created_at, updated_at, visibility, share_token)
         SELECT ?,?,?,?,?,?, new_deck_visibility, ? FROM users WHERE id = ?",
    )
    .bind(&id)
    .bind(owner)
    .bind(name.trim())
    .bind(folder)
    .bind(&stamp)
    .bind(&stamp)
    .bind(crate::sharing::new_token())
    .bind(owner)
    .execute(&mut *conn)
    .await?;
    insert_version_in(conn, &id, cards, Some(note)).await?;
    Ok(id)
}

/// Save a new version and make it current. Also queues the version's outside check
/// (deck_checks), which a background worker runs later, so this never waits on the network.
pub(crate) async fn insert_version(pool: &SqlitePool, deck_id: &str, cards: &[DeckCard], note: Option<&str>) -> AppResult<String> {
    let mut tx = pool.begin().await?;
    let vid = insert_version_in(&mut tx, deck_id, cards, note).await?;
    tx.commit().await?;
    crate::deck_checks::wake();
    Ok(vid)
}

/// As `insert_version`, inside the caller's transaction (no wake: the caller wakes the check
/// worker once it commits).
pub(crate) async fn insert_version_in(conn: &mut SqliteConnection, deck_id: &str, cards: &[DeckCard], note: Option<&str>) -> AppResult<String> {
    let (vid, stamp) = insert_saved_version_in(conn, deck_id, cards, note, false).await?;
    sqlx::query("UPDATE decks SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .bind(&vid)
        .bind(&stamp)
        .bind(deck_id)
        .execute(&mut *conn)
        .await?;
    crate::deck_checks::queue(&mut *conn, &vid, cards).await?;
    Ok(vid)
}

/// Save a version row without making it current. With `history_only` it waits in History, where
/// "Restore this list" can put it in the deck later as a new version (a scanned list the owner
/// didn't switch to), so it is never the deck's list itself; no outside check is queued for it.
/// Returns the version's id and timestamp.
pub(crate) async fn insert_saved_version_in(
    conn: &mut SqliteConnection,
    deck_id: &str,
    cards: &[DeckCard],
    note: Option<&str>,
    history_only: bool,
) -> AppResult<(String, String)> {
    let vid = new_id();
    let stamp = now();
    sqlx::query("INSERT INTO deck_versions (id, deck_id, cards, note, created_at, history_only) VALUES (?,?,?,?,?,?)")
        .bind(&vid)
        .bind(deck_id)
        .bind(serde_json::to_string(cards).map_err(anyhow::Error::from)?)
        .bind(note)
        .bind(&stamp)
        .bind(history_only)
        .execute(&mut *conn)
        .await?;
    Ok((vid, stamp))
}

/// Several versions' cards in one query, by version id.
pub async fn load_versions_cards(pool: &SqlitePool, version_ids: &[String]) -> AppResult<HashMap<String, Vec<DeckCard>>> {
    if version_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT id, cards FROM deck_versions WHERE id IN (SELECT value FROM json_each(?))")
        .bind(serde_json::to_string(version_ids).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?;
    rows.into_iter().map(|(id, json)| Ok((id, serde_json::from_str(&json).map_err(anyhow::Error::from)?))).collect()
}

pub async fn load_version_cards(pool: &SqlitePool, version_id: &str) -> AppResult<Vec<DeckCard>> {
    let json: String = sqlx::query_scalar("SELECT cards FROM deck_versions WHERE id = ?").bind(version_id).fetch_one(pool).await?;
    Ok(serde_json::from_str(&json).map_err(anyhow::Error::from)?)
}

pub(crate) async fn owned_deck(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<(String, Option<String>, Option<String>)> {
    sqlx::query_as("SELECT name, current_version_id, container_id FROM decks WHERE id = ? AND owner_id = ?")
        .bind(id)
        .bind(owner)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("deck"))
}

#[derive(Serialize)]
struct DeckView {
    singles_value: crate::deck_prices::SinglesValue,
    id: String,
    name: String,
    container_id: Option<String>,
    acquisition_status: Option<String>,
    version_id: Option<String>,
    /// The bracket the owner declares (1-5), or none. Estimates come from `/check`.
    bracket: Option<i64>,
    parent_id: Option<String>,
    configuration: Option<String>,
    visibility: String,
    share_token: Option<String>,
    /// The main deck and every configuration of it, this one included (just this deck when it
    /// has none), main deck first.
    configurations: Vec<ConfigurationRef>,
    cards: Vec<DeckEntry>,
    validation: Validation,
    ownership: OwnershipTotals,
    /// Names of the cards on the Commander Game Changers list (commander and main deck).
    /// `None` while any of those cards has no flag loaded yet.
    game_changers: Option<Vec<String>>,
    /// Date of the Scryfall data the flags come from (YYYY-MM-DD), if loaded.
    game_changers_as_of: Option<String>,
    /// Names of the cards on Wizards' Reserve List (commander and main deck). `None` while any
    /// of those cards has no flag loaded yet.
    reserved_list: Option<Vec<String>>,
    /// Date of the Scryfall data the Reserve List flags come from (YYYY-MM-DD), if loaded.
    reserved_list_as_of: Option<String>,
    /// What Card Kingdom was buying your copies for (the AGENTS.md deck valuation rule); none
    /// before any Card Kingdom prices are in.
    buylist: Option<BuylistValue>,
}

/// What Card Kingdom was buying your real copies of a deck's cards for, by each copy's own
/// printing and finish, on the newest day Yama read its buylist (via MTGJSON). Individual public
/// references only: the feed cannot establish which copies are economical to sell. No automatic
/// resale total, bulk cutoff or premium-basic exclusion; missing prices remain unknown.
#[derive(Serialize, Debug, Default, PartialEq)]
pub(crate) struct BuylistValue {
    pub provider: &'static str,
    pub date: Option<String>,
    /// Your real copies of the deck's cards (proxies left out), each counted once.
    pub copies: i64,
    pub offered_copies: i64,
    /// No buylist price for that printing and finish: unknown, not $0.
    pub no_offer_copies: i64,
    /// Not near-mint English copies (or altered, signed, misprinted): the price doesn't apply.
    pub unmatched_copies: i64,
    /// Basic copies, whose individual printings must be reviewed (including premium versions).
    pub basics: i64,
    /// Each printing and finish with an offer, highest first.
    pub cards: Vec<BuylistCard>,
}

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct BuylistCard {
    pub name: String,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    pub finish: String,
    pub qty: i64,
    pub offer_usd: f64,
    pub basic: bool,
}

/// [`BuylistValue`] for `cards` from your copies of them (`by_oracle`), the deck box's first, up to
/// each card's count.
async fn buylist_value(
    pool: &SqlitePool,
    cards: &[DeckCard],
    by_oracle: &HashMap<&str, Vec<&crate::collection::Item>>,
    container_id: Option<&str>,
) -> AppResult<Option<BuylistValue>> {
    let mut picked: Vec<(&crate::collection::Item, i64)> = Vec::new();
    let mut used: HashMap<&str, i64> = HashMap::new();
    for c in cards.iter().filter(|c| c.board != Board::Side) {
        let mut mine: Vec<&crate::collection::Item> = by_oracle.get(c.oracle_id.as_str()).into_iter().flatten().copied().filter(|i| !i.proxy).collect();
        mine.sort_by_key(|i| container_id.is_none() || i.container_id.as_deref() != container_id);
        let mut left = c.qty;
        for i in mine {
            let consumed = used.entry(i.id.as_str()).or_default();
            let take = left.min(i.qty - *consumed);
            if take > 0 {
                *consumed += take;
                picked.push((i, take));
                left -= take;
            }
        }
    }
    let ids: Vec<&str> = picked.iter().map(|(i, _)| i.scryfall_id.as_str()).collect();
    let (date, offers) = crate::prices::current_values(pool, crate::prices::mtgjson::CARDKINGDOM, 23, 25, &ids).await?;
    if date.is_none() {
        return Ok(None);
    }
    let mut out = BuylistValue { provider: "Card Kingdom buylist via MTGJSON", date, ..Default::default() };
    let mut rows: BTreeMap<(String, String), BuylistCard> = BTreeMap::new();
    for (i, n) in picked {
        let name = i.name.clone().unwrap_or_default();
        let basic = is_basic(&name);
        let series = 23 + match i.finish.as_str() {
            "foil" => 1,
            "etched" => 2,
            _ => 0,
        };
        let matches = i.condition == "NM" && i.lang == "en" && !i.altered && !i.signed && !i.misprint;
        let offer = offers.get(&(i.scryfall_id.clone(), series)).copied().filter(|_| matches);
        out.copies += n;
        if basic {
            out.basics += n;
        }
        if !matches {
            out.unmatched_copies += n;
        } else if offer.is_none() {
            out.no_offer_copies += n;
        }
        let Some(cents) = offer else { continue };
        out.offered_copies += n;
        let row = rows.entry((i.scryfall_id.clone(), i.finish.clone())).or_insert_with(|| BuylistCard {
            name,
            set_code: i.set_code.clone(),
            collector_number: i.collector_number.clone(),
            finish: i.finish.clone(),
            qty: 0,
            offer_usd: cents as f64 / 100.0,
            basic,
        });
        row.qty += n;
    }
    out.cards = rows.into_values().collect();
    out.cards.sort_by(|a, b| (b.offer_usd * b.qty as f64).total_cmp(&(a.offer_usd * a.qty as f64)).then(a.name.cmp(&b.name)));
    Ok(Some(out))
}

#[derive(Serialize, sqlx::FromRow, Clone)]
pub(crate) struct ConfigurationRef {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) configuration: Option<String>,
    pub(crate) visibility: String,
    pub(crate) share_token: Option<String>,
}

/// The live decks in `deck`'s group: its main deck first, then its configurations by label.
pub(crate) async fn configuration_group(pool: &SqlitePool, owner: &str, deck: &str) -> AppResult<Vec<ConfigurationRef>> {
    Ok(sqlx::query_as(
        "WITH root AS (SELECT COALESCE(parent_id, id) AS id FROM decks WHERE id = ? AND owner_id = ?)
         SELECT d.id, d.name, d.configuration, d.visibility, d.share_token FROM decks d, root
         WHERE d.owner_id = ? AND d.archived = 0 AND (d.id = root.id OR d.parent_id = root.id)
         ORDER BY d.parent_id IS NOT NULL,
                  CASE lower(trim(COALESCE(d.configuration, ''))) WHEN 'stock' THEN 0 WHEN 'original' THEN 0 ELSE 1 END,
                  lower(COALESCE(d.configuration, d.name)), d.created_at",
    )
    .bind(deck)
    .bind(owner)
    .bind(owner)
    .fetch_all(pool)
    .await?)
}

#[derive(Serialize)]
struct DeckEntry {
    #[serde(flatten)]
    entry: DeckCard,
    card: Option<Card>,
    /// Real (non-proxy) copies you own anywhere.
    owned: i64,
    /// Copies filed in this deck's container.
    in_deck_container: i64,
    proxies: i64,
    /// Where your copies are, e.g. {"binder: Trade binder": 1, "deck: Omo": 1}.
    locations: BTreeMap<String, i64>,
    needed: i64,
    /// Cheapest current USD market price across printings. `None` = no price data.
    cheapest_usd: Option<f64>,
    /// The printing that price is for, so the page can say which version to buy.
    cheapest_printing: Option<CheapestPrinting>,
    /// The printing to name in exports: your own copy (real before proxy, the one in this deck's
    /// container first), else a paper printing (see [`paper_printing`]). `None` if neither is
    /// known, so the export names the card alone.
    printing: Option<PrintRef>,
    /// Colors of mana the card makes (Scryfall's produced_mana, "WUBRGC" order); "" for none,
    /// `None` until the card data import that reads it has run.
    produced_mana: Option<String>,
}

/// The printing behind a card's cheapest price.
#[derive(Serialize, Debug, Clone, PartialEq)]
struct CheapestPrinting {
    scryfall_id: String,
    set_code: String,
    set_name: String,
    collector_number: String,
    /// The date of that printing's price (YYYY-MM-DD): within three days of the card's newest.
    date: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub(crate) struct PrintRef {
    pub(crate) set_code: String,
    pub(crate) collector_number: String,
    /// nonfoil | foil | etched
    pub(crate) finish: String,
    /// "owned", "chosen" (the printing an import named) or "default"
    pub(crate) from: &'static str,
}

/// The printing an export should name for a card: a real copy (the one in the deck's container
/// first), then a proxy the same way (it still names a printing), else `None` so the caller can
/// fall back to [`paper_printing`].
pub(crate) fn owned_printing(mine: &[&crate::collection::Item], container_id: Option<&str>) -> Option<PrintRef> {
    let rank = |i: &crate::collection::Item| {
        let here = container_id.is_some() && i.container_id.as_deref() == container_id;
        (i.proxy, !here)
    };
    let best = mine.iter().filter(|i| i.set_code.is_some() && i.collector_number.is_some()).min_by_key(|i| rank(i))?;
    Some(PrintRef {
        set_code: best.set_code.clone()?,
        collector_number: best.collector_number.clone()?,
        finish: best.finish.clone(),
        from: "owned",
    })
}

/// One printing of a card, as [`paper_printing`] and [`collection_printing`] weigh it.
#[derive(sqlx::FromRow, Debug, Clone)]
pub(crate) struct PrintingChoice {
    pub(crate) scryfall_id: String,
    pub(crate) set_code: String,
    pub(crate) collector_number: String,
    /// JSON array: nonfoil | foil | etched
    pub(crate) finishes: String,
    pub(crate) lang: String,
    pub(crate) released_at: Option<String>,
    /// Scryfall's `digital` (only released in a video game); `None` until the printings import
    /// that reads it has run.
    pub(crate) digital: Option<bool>,
    pub(crate) set_type: Option<String>,
    pub(crate) is_default: bool,
}

impl PrintingChoice {
    fn has(&self, finish: &str) -> bool {
        serde_json::from_str::<Vec<String>>(&self.finishes).is_ok_and(|f| f.iter().any(|x| x == finish))
    }

    /// A promo, a collectible that isn't a tournament card (gold borders), a box or an Un-set.
    fn side_product(&self) -> bool {
        self.set_type.as_deref().is_some_and(|t| SIDE_SET_TYPES.contains(&t)) || RARE_RUN_SETS.contains(&self.set_code.as_str())
    }

    /// The finish a copy of this printing has unless said otherwise: nonfoil if it comes that way.
    pub(crate) fn plain_finish(&self) -> &'static str {
        ["nonfoil", "foil", "etched"].into_iter().find(|f| self.has(f)).unwrap_or("nonfoil")
    }
}

#[derive(sqlx::FromRow)]
struct ChoiceRow {
    oracle_id: String,
    #[sqlx(flatten)]
    choice: PrintingChoice,
}

/// Every printing of several cards, by oracle id, in one query.
pub(crate) async fn printing_choices_for<'e, E: sqlx::SqliteExecutor<'e>>(db: E, oracle_ids: &[&str]) -> AppResult<HashMap<String, Vec<PrintingChoice>>> {
    let mut out: HashMap<String, Vec<PrintingChoice>> = HashMap::new();
    if oracle_ids.is_empty() {
        return Ok(out);
    }
    let rows = sqlx::query_as::<_, ChoiceRow>(
        "SELECT p.oracle_id, p.scryfall_id, p.set_code, p.collector_number, p.finishes, p.lang, p.released_at, p.digital, p.set_type,
                (p.scryfall_id IS c.default_printing) AS is_default
         FROM printings p JOIN cards c ON c.oracle_id = p.oracle_id WHERE p.oracle_id IN (SELECT value FROM json_each(?))",
    )
    .bind(serde_json::to_string(oracle_ids).map_err(anyhow::Error::from)?)
    .fetch_all(db)
    .await?;
    for r in rows {
        out.entry(r.oracle_id).or_default().push(r.choice);
    }
    Ok(out)
}

/// Every printing of a card, for [`paper_printing`] and [`collection_printing`].
pub(crate) async fn printing_choices(conn: &mut SqliteConnection, oracle_id: &str) -> AppResult<Vec<PrintingChoice>> {
    Ok(sqlx::query_as::<_, PrintingChoice>(
        "SELECT p.scryfall_id, p.set_code, p.collector_number, p.finishes, p.lang, p.released_at, p.digital, p.set_type,
                (p.scryfall_id IS c.default_printing) AS is_default
         FROM printings p JOIN cards c ON c.oracle_id = p.oracle_id WHERE p.oracle_id = ?",
    )
    .bind(oracle_id)
    .fetch_all(&mut *conn)
    .await?)
}

/// The printing "Add to my collection" adds for a card the deck names no printing for: a paper
/// printing that isn't a promo, gold-bordered or other side product ([`SIDE_SET_TYPES`],
/// [`RARE_RUN_SETS`]), with a nonfoil finish, then Scryfall's default printing, English, the
/// newest. Unlike an export, a side product never wins by being Scryfall's default. Before the
/// printings import has read `digital`, digital printings can't be told apart and all count.
pub(crate) fn collection_printing(printings: &[PrintingChoice]) -> Option<&PrintingChoice> {
    let known = printings.iter().any(|p| p.digital.is_some());
    printings.iter().filter(|p| !known || p.digital == Some(false)).min_by_key(|p| {
        (
            p.side_product(),
            !p.has("nonfoil"),
            !p.is_default,
            p.lang != "en",
            std::cmp::Reverse(p.released_at.clone()),
            p.collector_number.len(),
            p.collector_number.clone(),
        )
    })
}

/// Kinds of set (Scryfall's `set_type`) whose printings are a last resort for an export:
/// collectibles that aren't tournament cards, promos, Secret Lair-style boxes, Un-sets.
const SIDE_SET_TYPES: [&str; 8] = ["memorabilia", "funny", "promo", "token", "minigame", "alchemy", "treasure_chest", "box"];

/// Sets Scryfall files as regular ones whose cards hardly anyone has: Summer Magic, a 1994 run
/// of Revised that was mostly destroyed. Weighed like [`SIDE_SET_TYPES`], so an old dual land
/// names Revised rather than Summer Magic.
const RARE_RUN_SETS: [&str; 1] = ["sum"];

/// The printing an export names for a card you don't own: one that exists on paper, so Moxfield
/// doesn't import an MTGO or Arena printing into a paper deck. In order: a printing with a
/// nonfoil finish, Scryfall's default printing, a regular set (not [`SIDE_SET_TYPES`] or
/// [`RARE_RUN_SETS`]), English, the newest. The finish is the printing's own: nonfoil if it has
/// one, else foil or etched. Until the printings import has read Scryfall's `digital` flag
/// nothing is known to be on paper, so it names the default printing as before (with that
/// printing's finish).
pub(crate) fn paper_printing(printings: &[PrintingChoice]) -> Option<PrintRef> {
    let best = if printings.iter().any(|p| p.digital.is_some()) {
        printings.iter().filter(|p| p.digital == Some(false)).min_by_key(|p| {
            (
                !p.has("nonfoil"),
                !p.is_default,
                p.side_product(),
                p.lang != "en",
                std::cmp::Reverse(p.released_at.clone()),
                p.collector_number.len(),
                p.collector_number.clone(),
            )
        })?
    } else {
        printings.iter().find(|p| p.is_default)?
    };
    Some(PrintRef {
        set_code: best.set_code.clone(),
        collector_number: best.collector_number.clone(),
        finish: best.plain_finish().into(),
        from: "default",
    })
}

#[derive(Serialize, Default)]
struct OwnershipTotals {
    cards: i64,
    /// Real copies, out of `cards`.
    owned: i64,
    /// Copies covered by proxies beyond the real ones. A proxied card isn't needed.
    proxies: i64,
    needed: i64,
    /// Sum of cheapest prices for needed cards that have a price, basics excluded.
    needed_cost_usd: f64,
    needed_without_price: i64,
    /// The same cheapest prices for the real copies you own, and for the copies proxies cover
    /// (what replacing them with real cards would cost). Basics count here. None while no copy
    /// in that group has a price: a missing price is unknown, not zero.
    owned_value_usd: Option<f64>,
    owned_without_price: i64,
    proxy_value_usd: Option<f64>,
    proxies_without_price: i64,
    /// The Scryfall price snapshot those prices come from (YYYY-MM-DD).
    price_date: Option<String>,
}

async fn get_deck(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<DeckView>> {
    let (name, version_id, container_id) = owned_deck(&st.pool, &user.id, &id).await?;
    let cards = match &version_id {
        Some(v) => load_version_cards(&st.pool, v).await?,
        None => vec![],
    };
    let card_info = self::card_info(&st.pool, &cards).await?;
    // One price per card for the whole page: the deck value, what you own, proxies and what's left.
    let cheapest = crate::deck_prices::cheapest_for(&st.pool, &cards.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    let market_prices = crate::deck_prices::as_prices(&cheapest);
    let singles_value = crate::deck_prices::singles(&serde_json::to_value(&cards).map_err(anyhow::Error::from)?, &market_prices);
    let validation = validate(&cards, &card_info);
    let game_changers = game_changers(&cards, &card_info);
    let game_changers_as_of = crate::cards::import::game_changers_date(&st.pool).await?;
    let reserved_list = reserved_list(&cards, &card_info);
    let reserved_list_as_of = crate::cards::import::reserved_list_date(&st.pool).await?;
    let (bracket, parent_id, configuration, visibility, share_token): (Option<i64>, Option<String>, Option<String>, String, Option<String>) =
        sqlx::query_as("SELECT bracket, parent_id, configuration, visibility, share_token FROM decks WHERE id = ?")
            .bind(&id)
            .fetch_one(&st.pool)
            .await?;
    let configurations = configuration_group(&st.pool, &user.id, &id).await?;
    let acquisition_status = sqlx::query_scalar("SELECT root.acquisition_status FROM decks d JOIN decks root ON root.id = COALESCE(d.parent_id, d.id) AND root.owner_id = d.owner_id WHERE d.id = ? AND d.owner_id = ?")
        .bind(&id).bind(&user.id).fetch_one(&st.pool).await?;

    // Your copies of these cards, wherever they are, grouped by card once.
    let items = crate::collection::items_for_cards(&st.pool, &user.id, &cards.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    let mut by_oracle: HashMap<&str, Vec<&crate::collection::Item>> = HashMap::new();
    for i in &items {
        if let Some(o) = i.oracle_id.as_deref() {
            by_oracle.entry(o).or_default().push(i);
        }
    }
    // Printings an import named for this deck.
    let chosen = crate::deck_import::deck_prints(&st.pool, &id).await?;
    // Cards with no copy of yours and no printing named: their printings, all in one query.
    let unprinted: Vec<&str> = cards
        .iter()
        .filter(|c| {
            let mine = by_oracle.get(c.oracle_id.as_str()).map(Vec::as_slice).unwrap_or_default();
            owned_printing(mine, container_id.as_deref()).is_none() && chosen.get(&c.oracle_id).and_then(|p| p.collector_number.as_ref()).is_none()
        })
        .map(|c| c.oracle_id.as_str())
        .collect();
    let choices = printing_choices_for(&st.pool, &unprinted).await?;
    let mana = produced_mana(&st.pool, &cards.iter().map(|c| c.oracle_id.as_str()).collect::<Vec<_>>()).await?;
    let buylist = buylist_value(&st.pool, &cards, &by_oracle, container_id.as_deref()).await?;
    let mut entries = Vec::new();
    let mut totals = OwnershipTotals::default();
    for c in cards {
        let mine: Vec<&crate::collection::Item> = by_oracle.get(c.oracle_id.as_str()).cloned().unwrap_or_default();
        let owned: i64 = mine.iter().filter(|i| !i.proxy).map(|i| i.qty).sum();
        let proxies: i64 = mine.iter().filter(|i| i.proxy).map(|i| i.qty).sum();
        let in_deck_container: i64 = mine
            .iter()
            .filter(|i| container_id.is_some() && i.container_id == container_id)
            .map(|i| i.qty)
            .sum();
        let mut locations = BTreeMap::new();
        for i in &mine {
            let place = match (&i.container_kind, &i.container_name) {
                (Some(k), Some(n)) => format!("{k}: {n}"),
                _ => "unfiled".to_string(),
            };
            let label = if i.proxy { format!("{place} (proxy)") } else { place };
            *locations.entry(label).or_insert(0) += i.qty;
        }
        // A proxy covers a card for play: needed is what neither real copies nor proxies cover.
        let needed = (c.qty - owned - proxies).max(0);
        let (cheapest_usd, price_date, cheapest_printing) = match cheapest.get(&c.oracle_id) {
            Some(p) if c.board != Board::Side => (
                Some(p.usd),
                Some(p.date.clone()),
                Some(CheapestPrinting {
                    scryfall_id: p.scryfall_id.clone(),
                    set_code: p.set_code.clone(),
                    set_name: p.set_name.clone(),
                    collector_number: p.collector_number.clone(),
                    date: p.date.clone(),
                }),
            ),
            _ => (None, None, None),
        };
        if price_date > totals.price_date {
            totals.price_date = price_date;
        }
        if c.board != Board::Side {
            let real = c.qty.min(owned);
            let proxied = (c.qty - real).min(proxies);
            totals.cards += c.qty;
            totals.owned += real;
            totals.proxies += proxied;
            totals.needed += needed;
            match cheapest_usd {
                Some(p) => {
                    if real > 0 {
                        *totals.owned_value_usd.get_or_insert(0.0) += p * real as f64;
                    }
                    if proxied > 0 {
                        *totals.proxy_value_usd.get_or_insert(0.0) += p * proxied as f64;
                    }
                }
                None => {
                    totals.owned_without_price += real;
                    totals.proxies_without_price += proxied;
                }
            }
            if needed > 0 && !is_basic(&c.name) {
                match cheapest_usd {
                    Some(p) => totals.needed_cost_usd += p * needed as f64,
                    None => totals.needed_without_price += needed,
                }
            }
        }
        let card = card_info.get(&c.oracle_id).cloned();
        // Exports need a collector number, so a set alone doesn't count.
        let chosen_print = chosen.get(&c.oracle_id).and_then(|p| p.collector_number.clone().map(|n| (p, n))).map(|(p, n)| PrintRef {
            set_code: p.set_code.clone(),
            collector_number: n,
            finish: p.finish.clone(),
            from: "chosen",
        });
        let printing = match owned_printing(&mine, container_id.as_deref()).or(chosen_print) {
            Some(p) => Some(p),
            None => paper_printing(choices.get(&c.oracle_id).map(Vec::as_slice).unwrap_or_default()),
        };
        let produced_mana = mana.get(&c.oracle_id).cloned().flatten();
        entries.push(DeckEntry { entry: c, card, owned, in_deck_container, proxies, locations, needed, cheapest_usd, cheapest_printing, printing, produced_mana });
    }
    totals.needed_cost_usd = (totals.needed_cost_usd * 100.0).round() / 100.0;
    for v in [&mut totals.owned_value_usd, &mut totals.proxy_value_usd].into_iter().flatten() {
        *v = (*v * 100.0).round() / 100.0;
    }
    Ok(Json(DeckView {
        singles_value,
        id,
        name,
        container_id,
        acquisition_status,
        version_id,
        bracket,
        parent_id,
        configuration,
        visibility,
        share_token,
        configurations,
        cards: entries,
        validation,
        ownership: totals,
        game_changers,
        game_changers_as_of,
        reserved_list,
        reserved_list_as_of,
        buylist,
    }))
}

#[derive(Deserialize)]
struct SaveVersion {
    cards: Vec<DeckCard>,
    note: Option<String>,
    /// Printings the import named (deck_import::save_prints).
    #[serde(default)]
    prints: Vec<crate::deck_import::DeckPrint>,
}

async fn save_version(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<SaveVersion>,
) -> AppResult<Json<serde_json::Value>> {
    st.limits.deck_writes.check_user(&user)?;
    owned_deck(&st.pool, &user.id, &id).await?;
    let vid = insert_version(&st.pool, &id, &body.cards, body.note.as_deref()).await?;
    crate::deck_import::save_prints(&st.pool, &id, &body.prints).await?;
    Ok(Json(serde_json::json!({ "version_id": vid })))
}

#[derive(Deserialize)]
struct UpdateDeck {
    name: Option<String>,
    #[serde(default, deserialize_with = "crate::util::double_option")]
    acquisition_status: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::util::double_option")]
    folder: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::util::double_option")]
    container_id: Option<Option<String>>,
    /// The declared bracket, 1-5; null clears it.
    #[serde(default, deserialize_with = "crate::util::double_option")]
    bracket: Option<Option<i64>>,
    /// private | link | public.
    visibility: Option<String>,
    /// The main deck this is a configuration of; null makes it a main deck again.
    #[serde(default, deserialize_with = "crate::util::double_option")]
    parent_id: Option<Option<String>>,
    /// The configuration's label ("stock"); null or blank clears it.
    #[serde(default, deserialize_with = "crate::util::double_option")]
    configuration: Option<Option<String>>,
}

async fn update_deck(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateDeck>,
) -> AppResult<()> {
    let (name, _, container) = owned_deck(&st.pool, &user.id, &id).await?;
    if let Some(Some(status)) = &body.acquisition_status
        && !matches!(status.as_str(), "owned" | "planned")
    {
        return Err(AppError::bad("acquisition_status must be owned, planned or null"));
    }
    if let Some(Some(c)) = &body.container_id {
        let mine: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE id = ? AND owner_id = ?")
            .bind(c)
            .bind(&user.id)
            .fetch_optional(&st.pool)
            .await?;
        mine.ok_or(AppError::NotFound("container"))?;
    }
    if let Some(Some(b)) = body.bracket
        && !(1..=5).contains(&b)
    {
        return Err(AppError::bad("brackets go from 1 to 5"));
    }
    let name = match body.name {
        Some(n) => deck_name(&n)?,
        None => name,
    };
    if let Some(v) = &body.visibility {
        crate::sharing::visibility(v)?;
    }
    // Immediate, so two moves at once can't both pass the check and nest or loop.
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    if let Some(Some(parent)) = &body.parent_id {
        check_parent(&mut tx, &user.id, &id, parent).await?;
    }
    let (folder, bracket, visibility, parent_id, configuration): (Option<String>, Option<i64>, String, Option<String>, Option<String>) =
        sqlx::query_as("SELECT folder, bracket, visibility, parent_id, configuration FROM decks WHERE id = ?")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
    let configuration = match body.configuration {
        Some(label) => configuration_label(label.as_deref())?,
        None => configuration,
    };
    if body.acquisition_status.is_some() && body.parent_id.as_ref().unwrap_or(&parent_id).is_some() {
        return Err(AppError::bad("set deck ownership on its main deck"));
    }
    sqlx::query(
        "UPDATE decks SET name = ?, folder = ?, container_id = ?, bracket = ?, visibility = ?, parent_id = ?, configuration = ?,
                share_token = COALESCE(share_token, ?), updated_at = ? WHERE id = ?",
    )
    .bind(name)
    .bind(body.folder.unwrap_or(folder))
    .bind(body.container_id.unwrap_or(container))
    .bind(body.bracket.unwrap_or(bracket))
    .bind(body.visibility.unwrap_or(visibility))
    .bind(body.parent_id.unwrap_or(parent_id))
    .bind(configuration)
    .bind(crate::sharing::new_token())
    .bind(now())
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    if let Some(status) = body.acquisition_status {
        sqlx::query("UPDATE decks SET acquisition_status = ? WHERE id = ? AND owner_id = ?")
            .bind(status).bind(&id).bind(&user.id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// A configuration label as typed: trimmed, blank means none, at most 60 characters.
fn configuration_label(label: Option<&str>) -> AppResult<Option<String>> {
    let label = label.map(str::trim).filter(|l| !l.is_empty());
    if label.is_some_and(|l| l.chars().count() > 60) {
        return Err(AppError::bad("keep a configuration's name under 60 characters"));
    }
    Ok(label.map(String::from))
}

/// `deck` may become a configuration of `parent`: both live and the owner's, `parent` a main deck
/// (configurations go one level deep) and `deck` without configurations of its own.
async fn check_parent(conn: &mut SqliteConnection, owner: &str, deck: &str, parent: &str) -> AppResult<()> {
    if deck == parent {
        return Err(AppError::bad("a deck can't be a configuration of itself"));
    }
    let parent_of_parent: Option<Option<String>> =
        sqlx::query_scalar("SELECT parent_id FROM decks WHERE id = ? AND owner_id = ? AND archived = 0")
            .bind(parent)
            .bind(owner)
            .fetch_optional(&mut *conn)
            .await?;
    match parent_of_parent {
        None => return Err(AppError::NotFound("deck")),
        Some(Some(_)) => return Err(AppError::bad("that deck is itself a configuration; pick its main deck")),
        Some(None) => {}
    }
    let children: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks WHERE parent_id = ? AND archived = 0")
        .bind(deck)
        .fetch_one(&mut *conn)
        .await?;
    if children > 0 {
        return Err(AppError::bad("this deck has configurations of its own; move them first"));
    }
    Ok(())
}

async fn reset_share_link(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<serde_json::Value>> {
    owned_deck(&st.pool, &user.id, &id).await?;
    let token = crate::sharing::new_token();
    sqlx::query("UPDATE decks SET share_token = ?, updated_at = ? WHERE id = ?").bind(&token).bind(now()).bind(&id).execute(&st.pool).await?;
    Ok(Json(serde_json::json!({ "share_token": token })))
}

#[derive(Deserialize)]
struct NewConfiguration {
    /// Its label, e.g. "stock" or "high power".
    configuration: String,
    /// Client-generated, so a retried request makes one deck (`applied_ops`).
    op_id: String,
}

/// A new configuration of `id`'s main deck, starting from `id`'s current list and the printings
/// it names. Named "<main deck> (<label>)", in the same folder.
async fn new_configuration(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<NewConfiguration>,
) -> AppResult<Json<Created>> {
    st.limits.deck_writes.check_user(&user)?;
    let label = configuration_label(Some(&body.configuration))?.ok_or_else(|| AppError::bad("name the configuration"))?;
    if body.op_id.trim().is_empty() || body.op_id.len() > 100 {
        return Err(AppError::bad("op_id is required"));
    }
    let (_, version_id, _) = owned_deck(&st.pool, &user.id, &id).await?;
    let mut tx = st.pool.begin().await?;
    let done: Option<(String, String)> = sqlx::query_as("SELECT kind, payload FROM applied_ops WHERE op_id = ? AND owner_id = ?")
        .bind(&body.op_id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some((kind, payload)) = done {
        if kind != "deck.configuration" {
            return Err(AppError::Conflict("that op_id was used for something else".into()));
        }
        let id: String = serde_json::from_str::<serde_json::Value>(&payload).ok().and_then(|v| v["id"].as_str().map(String::from)).unwrap_or_default();
        return Ok(Json(Created { id, unknown: vec![] }));
    }
    let (root, root_name, folder): (String, String, Option<String>) =
        sqlx::query_as("SELECT p.id, p.name, p.folder FROM decks d JOIN decks p ON p.id = COALESCE(d.parent_id, d.id) WHERE d.id = ?")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await?;
    let cards = match &version_id {
        Some(v) => {
            let text: String = sqlx::query_scalar("SELECT cards FROM deck_versions WHERE id = ?").bind(v).fetch_one(&mut *tx).await?;
            serde_json::from_str(&text).map_err(anyhow::Error::from)?
        }
        None => vec![],
    };
    let new = create_deck_in(&mut tx, &user.id, &format!("{root_name} ({label})"), folder.as_deref(), &cards, "new configuration").await?;
    // It shares no more than the list it copies: the source deck's visibility, not the default
    // for new decks.
    sqlx::query("UPDATE decks SET parent_id = ?, configuration = ?, visibility = (SELECT visibility FROM decks WHERE id = ?) WHERE id = ?")
        .bind(&root)
        .bind(&label)
        .bind(&id)
        .bind(&new)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO deck_prints (deck_id, oracle_id, set_code, collector_number, finish, proxy)
         SELECT ?, oracle_id, set_code, collector_number, finish, proxy FROM deck_prints WHERE deck_id = ?",
    )
    .bind(&new)
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO applied_ops (op_id, owner_id, kind, payload, applied_at) VALUES (?,?,?,?,?)")
        .bind(&body.op_id)
        .bind(&user.id)
        .bind("deck.configuration")
        .bind(serde_json::json!({ "id": new, "from": id }).to_string())
        .bind(now())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::deck_checks::wake();
    Ok(Json(Created { id: new, unknown: vec![] }))
}

#[derive(Deserialize)]
struct UseList {
    /// Another deck in this deck's configuration group: its current list becomes this deck's.
    from: Option<String>,
    /// Or one of this deck's own versions, restored.
    version: Option<String>,
    /// Client-generated, so a retried request saves one version (`applied_ops`).
    op_id: String,
}

/// Put another list in this deck (Bryan, 2026-10-28: "There should be the one that's currently
/// implemented, and then there should be an easy way to swap back to other versions of the
/// deck"). `from` copies a configuration's current list into its main deck (or any deck of the
/// group into another); `version` restores one of the deck's own versions. Either saves a new
/// version, so the list it replaces stays in the history and can be restored the same way. The
/// source's chosen printings fill in any card this deck has no printing for; this deck's own
/// choices (proxies included) stay. A list equal to the current one saves nothing.
async fn use_list(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<UseList>,
) -> AppResult<Json<serde_json::Value>> {
    st.limits.deck_writes.check_user(&user)?;
    if body.op_id.trim().is_empty() || body.op_id.len() > 100 {
        return Err(AppError::bad("op_id is required"));
    }
    let (_, current, _) = owned_deck(&st.pool, &user.id, &id).await?;
    let group = configuration_group(&st.pool, &user.id, &id).await?;
    let mut tx = st.pool.begin().await?;
    let done: Option<(String, String)> = sqlx::query_as("SELECT kind, payload FROM applied_ops WHERE op_id = ? AND owner_id = ?")
        .bind(&body.op_id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
    // A retry gets the first answer; the same op_id for another list is refused, never replayed.
    let target = serde_json::json!({ "deck": id, "from": body.from, "version": body.version });
    if let Some((kind, payload)) = done {
        let stored: serde_json::Value = serde_json::from_str(&payload).map_err(anyhow::Error::from)?;
        if kind != "deck.use" || stored["target"] != target {
            return Err(AppError::Conflict("that op_id was used for something else".into()));
        }
        return Ok(Json(serde_json::json!({ "version_id": stored["version_id"], "changed": stored["changed"] })));
    }
    let (cards_json, note, prints_from): (String, String, Option<String>) = match (&body.from, &body.version) {
        (Some(from), None) => {
            if *from == id {
                return Err(AppError::bad("that's this deck's own list"));
            }
            let source = group.iter().find(|c| c.id == *from).ok_or(AppError::NotFound("configuration"))?;
            let label = source.configuration.clone().unwrap_or_else(|| source.name.clone());
            let cards: Option<String> = sqlx::query_scalar(
                "SELECT v.cards FROM decks d JOIN deck_versions v ON v.id = d.current_version_id WHERE d.id = ? AND d.owner_id = ?",
            )
            .bind(from)
            .bind(&user.id)
            .fetch_optional(&mut *tx)
            .await?;
            (cards.ok_or_else(|| AppError::bad("that configuration has no list yet"))?, format!("Switched to {label}"), Some(from.clone()))
        }
        (None, Some(version)) => {
            let row: Option<(String, String)> = sqlx::query_as("SELECT cards, created_at FROM deck_versions WHERE id = ? AND deck_id = ?")
                .bind(version)
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?;
            let (cards, at) = row.ok_or(AppError::NotFound("version"))?;
            (cards, format!("Restored the list from {}", &at[..at.len().min(10)]), None)
        }
        _ => return Err(AppError::bad("give either from (a configuration) or version")),
    };
    let cards: Vec<DeckCard> = serde_json::from_str(&cards_json).map_err(anyhow::Error::from)?;
    let same = match &current {
        Some(v) => {
            let now_cards: String = sqlx::query_scalar("SELECT cards FROM deck_versions WHERE id = ?").bind(v).fetch_one(&mut *tx).await?;
            let now_cards: Vec<DeckCard> = serde_json::from_str(&now_cards).map_err(anyhow::Error::from)?;
            let key = |cs: &[DeckCard]| {
                let mut k: Vec<(String, String, i64)> = cs.iter().map(|c| (format!("{:?}", c.board), c.oracle_id.clone(), c.qty)).collect();
                k.sort();
                k
            };
            key(&now_cards) == key(&cards)
        }
        None => false,
    };
    // The source's printing choices fill gaps even when the list itself is already the same.
    if let Some(from) = &prints_from {
        sqlx::query(
            "INSERT OR IGNORE INTO deck_prints (deck_id, oracle_id, set_code, collector_number, finish, proxy)
             SELECT ?, oracle_id, set_code, collector_number, finish, proxy FROM deck_prints WHERE deck_id = ?",
        )
        .bind(&id)
        .bind(from)
        .execute(&mut *tx)
        .await?;
    }
    let result = if same {
        serde_json::json!({ "version_id": current, "changed": false })
    } else {
        let vid = insert_version_in(&mut tx, &id, &cards, Some(note.as_str())).await?;
        serde_json::json!({ "version_id": vid, "changed": true })
    };
    let mut stored = result.clone();
    stored["target"] = target;
    sqlx::query("INSERT INTO applied_ops (op_id, owner_id, kind, payload, applied_at) VALUES (?,?,?,?,?)")
        .bind(&body.op_id)
        .bind(&user.id)
        .bind("deck.use")
        .bind(stored.to_string())
        .bind(now())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if !same {
        crate::deck_checks::wake();
    }
    Ok(Json(result))
}

async fn archive_deck(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    archive(&st.pool, &user.id, &id).await
}

/// Archive one of `owner`'s decks: it leaves the deck list, and its versions and games stay
/// (`DELETE /api/decks/{id}` and `yama-server deck archive`).
pub async fn archive(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<()> {
    owned_deck(pool, owner, id).await?;
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE decks SET archived = 1, updated_at = ? WHERE id = ?").bind(now()).bind(id).execute(&mut *tx).await?;
    // Its configurations become main decks of their own rather than hang off an archived one.
    sqlx::query("UPDATE decks SET parent_id = NULL WHERE parent_id = ?").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Rename one of `owner`'s decks (`yama-server deck rename`; the web renames through
/// `PATCH /api/decks/{id}`, with the same name check). Its deck box keeps its own name.
pub async fn rename(pool: &SqlitePool, owner: &str, id: &str, name: &str) -> AppResult<()> {
    owned_deck(pool, owner, id).await?;
    sqlx::query("UPDATE decks SET name = ?, updated_at = ? WHERE id = ?").bind(deck_name(name)?).bind(now()).bind(id).execute(pool).await?;
    Ok(())
}

/// A deck name as typed: trimmed, and not empty.
fn deck_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::bad("deck needs a name"));
    }
    Ok(name.to_string())
}

/// The one live (not archived) deck of `owner`'s called `name`, ignoring case: (id, name as
/// saved). For the command line, where people type deck names. More than one is refused with
/// their names, so the wrong deck is never picked.
pub async fn find_by_name(pool: &SqlitePool, owner: &str, name: &str) -> AppResult<Option<(String, String)>> {
    let hits: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, name, created_at FROM decks WHERE owner_id = ? AND archived = 0 AND lower(trim(name)) = lower(trim(?)) ORDER BY created_at",
    )
    .bind(owner)
    .bind(name)
    .fetch_all(pool)
    .await?;
    match &hits[..] {
        [] => Ok(None),
        [(id, name, _)] => Ok(Some((id.clone(), name.clone()))),
        many => Err(AppError::Conflict(format!(
            "{} decks are called {:?} (made {}). Rename or archive one first.",
            many.len(),
            name.trim(),
            many.iter().map(|(id, _, at)| format!("{} as {id}", &at[..at.len().min(10)])).collect::<Vec<_>>().join(", ")
        ))),
    }
}

#[derive(Serialize, sqlx::FromRow)]
struct VersionRow {
    id: String,
    note: Option<String>,
    created_at: String,
    /// Saved for History only (a scan not made the list): never the deck's list.
    #[sqlx(default)]
    history_only: bool,
}

async fn list_versions(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Vec<VersionRow>>> {
    owned_deck(&st.pool, &user.id, &id).await?;
    Ok(Json(
        // rowid breaks ties between versions saved in the same second.
        sqlx::query_as("SELECT id, note, created_at, history_only FROM deck_versions WHERE deck_id = ? ORDER BY created_at DESC, rowid DESC")
            .bind(&id)
            .fetch_all(&st.pool)
            .await?,
    ))
}

#[derive(Serialize)]
struct VersionResult {
    id: String,
    /// 1 for the first save, counting up.
    number: i64,
    note: Option<String>,
    created_at: String,
    current: bool,
    #[serde(flatten)]
    record: crate::stats::Record,
}

#[derive(Serialize)]
struct DeckResults {
    /// Newest version first; versions without games are left out except the current one.
    versions: Vec<VersionResult>,
    provisional_under: i64,
    computed_at: String,
}

/// Finished games played with each version of the deck: wins, losses and draws.
async fn results(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<DeckResults>> {
    let (_, current, _) = owned_deck(&st.pool, &user.id, &id).await?;
    let games = crate::stats::finished_games(&st.pool, crate::stats::Scope::Deck(&id)).await?;
    let mut by_version = crate::stats::results_by_version(&games);
    let rows: Vec<VersionRow> =
        sqlx::query_as("SELECT id, note, created_at FROM deck_versions WHERE deck_id = ? ORDER BY created_at, rowid").bind(&id).fetch_all(&st.pool).await?;
    let mut versions: Vec<VersionResult> = rows
        .into_iter()
        .enumerate()
        .map(|(i, v)| VersionResult {
            current: current.as_deref() == Some(v.id.as_str()),
            record: by_version.remove(&v.id).unwrap_or_default(),
            number: i as i64 + 1,
            id: v.id,
            note: v.note,
            created_at: v.created_at,
        })
        .filter(|v| v.current || v.record.games > 0)
        .collect();
    versions.reverse();
    Ok(Json(DeckResults { versions, provisional_under: crate::stats::PROVISIONAL_UNDER, computed_at: now() }))
}

#[derive(Serialize)]
struct VersionCards {
    id: String,
    note: Option<String>,
    created_at: String,
    cards: Vec<DeckCard>,
}

/// One saved version's cards, for the history and its diffs.
async fn get_version(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path((id, version)): Path<(String, String)>,
) -> AppResult<Json<VersionCards>> {
    owned_deck(&st.pool, &user.id, &id).await?;
    let (note, created_at): (Option<String>, String) =
        sqlx::query_as("SELECT note, created_at FROM deck_versions WHERE id = ? AND deck_id = ?")
            .bind(&version)
            .bind(&id)
            .fetch_optional(&st.pool)
            .await?
            .ok_or(AppError::NotFound("version"))?;
    let cards = load_version_cards(&st.pool, &version).await?;
    Ok(Json(VersionCards { id: version, note, created_at, cards }))
}

/// Commander Spellbook's check of the deck's current version: estimated bracket, flagged
/// cards and combos, or that it's still pending.
async fn get_check(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<crate::deck_checks::CheckView>> {
    let (_, version, _) = owned_deck(&st.pool, &user.id, &id).await?;
    Ok(Json(crate::deck_checks::view(&st.pool, version.as_deref(), st.cfg.deck_checks).await?))
}

/// Ask Commander Spellbook again about the current version (refused within ten minutes of
/// its last answer).
async fn recheck(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<crate::deck_checks::CheckView>> {
    // Someone else's deck is "not found" whatever this server's settings.
    let (_, version, _) = owned_deck(&st.pool, &user.id, &id).await?;
    if !st.cfg.deck_checks {
        return Err(AppError::Conflict("deck checks are off on this server".into()));
    }
    let version = version.ok_or_else(|| AppError::bad("the deck has no cards yet"))?;
    crate::deck_checks::request_again(&st.pool, &version).await?;
    Ok(Json(crate::deck_checks::view(&st.pool, Some(&version), true).await?))
}

/// Game Changers in the deck (not the sideboard), by name, sorted. Uses Scryfall's flag, so
/// it's only as fresh as the last card import. `None` when any of those cards has no flag yet
/// (before the first import that reads it): a count then would be a guess.
pub fn game_changers(cards: &[DeckCard], info: &HashMap<String, Card>) -> Option<Vec<String>> {
    flagged(cards, info, |c| c.game_changer)
}

/// Cards on Wizards' Reserve List in the deck (not the sideboard), by name, sorted, from
/// Scryfall's flag. `None` when any of those cards has no flag yet, as with [`game_changers`].
pub fn reserved_list(cards: &[DeckCard], info: &HashMap<String, Card>) -> Option<Vec<String>> {
    flagged(cards, info, |c| c.reserved)
}

fn flagged(cards: &[DeckCard], info: &HashMap<String, Card>, flag: impl Fn(&Card) -> Option<bool>) -> Option<Vec<String>> {
    let mut names = Vec::new();
    for c in cards.iter().filter(|c| c.board != Board::Side) {
        let Some(card) = info.get(&c.oracle_id) else { continue };
        if flag(card)? {
            names.push(c.name.clone());
        }
    }
    names.sort();
    names.dedup();
    Some(names)
}

/// Card data for a list, by oracle ID; cards not in the data are left out.
/// The cards a list names, by oracle id, in one query.
pub(crate) async fn card_info(pool: &SqlitePool, cards: &[DeckCard]) -> AppResult<HashMap<String, Card>> {
    let ids: std::collections::BTreeSet<&str> = cards.iter().map(|c| c.oracle_id.as_str()).collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query_as::<_, Card>(AssertSqlSafe(format!("SELECT {CARD_COLUMNS} FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))")))
        .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|c| (c.oracle_id.clone(), c)).collect())
}

/// The mana each card makes (`cards.produced_mana`), by oracle id, in one query.
pub(crate) async fn produced_mana(pool: &SqlitePool, oracle_ids: &[&str]) -> AppResult<HashMap<String, Option<String>>> {
    if oracle_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows: Vec<(String, Option<String>)> = sqlx::query_as("SELECT oracle_id, produced_mana FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))")
        .bind(serde_json::to_string(oracle_ids).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().collect())
}

// ── validation ─────────────────────────────────────────────────────────────

#[derive(Serialize, Default, Debug)]
pub struct Validation {
    pub ok: bool,
    pub total: i64,
    pub color_identity: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

pub(crate) const BASICS: [&str; 11] = [
    "Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes",
    "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest",
];

pub(crate) fn is_basic(name: &str) -> bool {
    BASICS.contains(&name)
}

/// Commander deck checks: size, singleton, color identity, legality, and commander eligibility.
/// Uses Scryfall's legality data, which is only as fresh as the last import.
pub fn validate(cards: &[DeckCard], info: &HashMap<String, Card>) -> Validation {
    let mut v = Validation::default();
    let commanders: Vec<&DeckCard> = cards.iter().filter(|c| c.board == Board::Commander).collect();
    v.total = cards.iter().filter(|c| c.board != Board::Side).map(|c| c.qty).sum();

    let mut identity = String::new();
    match commanders.len() {
        0 => v.errors.push("no commander chosen".into()),
        1 | 2 => {}
        n => v.errors.push(format!("{n} commanders; the most is two")),
    }
    for c in &commanders {
        let Some(card) = info.get(&c.oracle_id) else { continue };
        identity.push_str(&card.color_identity);
        let text = card.oracle_text.to_lowercase();
        let eligible = (card.type_line.contains("Legendary")
            && (card.type_line.contains("Creature") || card.type_line.contains("Vehicle") || card.type_line.contains("Spacecraft")))
            || text.contains("can be your commander")
            || card.type_line.contains("Background");
        if !eligible {
            v.errors.push(format!("{} can't be a commander", c.name));
        }
    }
    if commanders.len() == 2 {
        let pairs = commanders.iter().all(|c| {
            info.get(&c.oracle_id).is_some_and(|card| {
                let t = card.oracle_text.to_lowercase();
                t.contains("partner") || t.contains("friends forever") || t.contains("choose a background")
                    || card.type_line.contains("Background") || t.contains("doctor's companion") || card.type_line.contains("Time Lord Doctor")
            })
        });
        if !pairs {
            v.errors.push("two commanders need partner, friends forever, a background, or doctor's companion".into());
        }
    }
    v.color_identity = "WUBRG".chars().filter(|c| identity.contains(*c)).collect();

    if v.total != 100 {
        v.errors.push(format!("{} cards; Commander decks have exactly 100 including the commander", v.total));
    }
    // Copies of a card across the commander and main deck (a commander scanned or listed twice
    // is one commander row and one main row): singleton counts them together, reported once.
    let mut copies: HashMap<&str, i64> = HashMap::new();
    for c in cards.iter().filter(|c| c.board != Board::Side) {
        *copies.entry(c.oracle_id.as_str()).or_insert(0) += c.qty;
    }
    let mut reported: Vec<&str> = Vec::new();
    for c in cards.iter().filter(|c| c.board != Board::Side) {
        let Some(card) = info.get(&c.oracle_id) else {
            v.warnings.push(format!("{} isn't in the card data", c.name));
            continue;
        };
        let text = card.oracle_text.to_lowercase();
        let any_number = text.contains("a deck can have any number of cards named");
        let up_to: Option<i64> = ["up to seven", "up to nine"]
            .iter()
            .zip([7, 9])
            .find(|(phrase, _)| text.contains(&format!("a deck can have {phrase} cards named")))
            .map(|(_, n)| n);
        let qty = copies[c.oracle_id.as_str()];
        if qty > 1 && !is_basic(&c.name) && !any_number && up_to.is_none_or(|n| qty > n) && !reported.contains(&c.oracle_id.as_str()) {
            reported.push(c.oracle_id.as_str());
            v.errors.push(format!("{} × {}: Commander is singleton", qty, c.name));
        }
        if !commanders.is_empty() {
            if let Some(outside) = card.color_identity.chars().find(|ch| !v.color_identity.contains(*ch)) {
                v.errors.push(format!("{} is outside the commander's color identity ({outside})", c.name));
            }
        }
        match card.legalities.get("commander").map(String::as_str) {
            Some("legal") => {}
            Some("banned") => v.errors.push(format!("{} is banned in Commander", c.name)),
            Some(other) => v.errors.push(format!("{} is {} in Commander", c.name, other.replace('_', " "))),
            None => v.warnings.push(format!("no Commander legality data for {}", c.name)),
        }
    }
    v.ok = v.errors.is_empty();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_formats() {
        let text = "Commander\n1 Omo, Queen of Vesuva\n\nDeck\n1x Sol Ring (CMM) 410 *F*\n12 Forest\n// comment\nSideboard\n1 Lightning Bolt";
        let lines = parse_list(text, true);
        assert_eq!(lines[0], ParsedLine { qty: 1, name: "Omo, Queen of Vesuva".into(), board: Board::Commander });
        assert_eq!(lines[1], ParsedLine { qty: 1, name: "Sol Ring".into(), board: Board::Main });
        assert_eq!(lines[2].qty, 12);
        assert_eq!(lines[3].board, Board::Side);
    }

    #[test]
    fn first_card_is_commander_without_sections() {
        let lines = parse_list("1 Mister Fantastic\n1 Arcane Signet\n5 Forest", true);
        assert_eq!(lines[0].board, Board::Commander);
        assert_eq!(lines[1].board, Board::Main);
    }

    fn card(name: &str, type_line: &str, ci: &str, text: &str, legal: &str) -> Card {
        Card {
            oracle_id: name.into(),
            name: name.into(),
            mana_cost: None,
            cmc: 0.0,
            type_line: type_line.into(),
            oracle_text: text.into(),
            colors: ci.into(),
            color_identity: ci.into(),
            power: None,
            toughness: None,
            loyalty: None,
            rarity: None,
            layout: None,
            legalities: HashMap::from([("commander".into(), legal.into())]),
            image_small: None,
            image_normal: None,
            image_art_crop: None,
            back_image_normal: None,
            artist: None,
            default_printing: None,
            edhrec_rank: None,
            game_changer: Some(false),
            reserved: Some(false),
        }
    }

    #[test]
    fn game_changers_skip_the_sideboard() {
        let mut rhystic = card("Rhystic Study", "Enchantment", "U", "", "legal");
        rhystic.game_changer = Some(true);
        let mut sol = card("Sol Ring", "Artifact", "", "", "legal");
        sol.game_changer = Some(false);
        let mut cyclonic = card("Cyclonic Rift", "Instant", "U", "", "legal");
        cyclonic.game_changer = Some(true);
        let info: HashMap<String, Card> = [rhystic, sol, cyclonic].into_iter().map(|c| (c.oracle_id.clone(), c)).collect();
        let dc = |name: &str, board| DeckCard { oracle_id: name.into(), name: name.into(), qty: 1, board };
        let cards = vec![
            dc("Sol Ring", Board::Main),
            dc("Rhystic Study", Board::Main),
            dc("Cyclonic Rift", Board::Side),
            dc("Unknown card", Board::Main),
        ];
        assert_eq!(game_changers(&cards, &info), Some(vec!["Rhystic Study".to_string()]));

        // One card without a loaded flag makes the count unknown, not lower.
        let mut info = info;
        info.get_mut("Sol Ring").unwrap().game_changer = None;
        assert_eq!(game_changers(&cards, &info), None);
        // Unless it's only in the sideboard.
        info.get_mut("Sol Ring").unwrap().game_changer = Some(false);
        info.get_mut("Cyclonic Rift").unwrap().game_changer = None;
        assert_eq!(game_changers(&cards, &info), Some(vec!["Rhystic Study".to_string()]));
    }

    #[test]
    fn reserved_list_skips_the_sideboard_and_waits_for_flags() {
        let mut cradle = card("Gaea's Cradle", "Legendary Land", "", "", "legal");
        cradle.reserved = Some(true);
        let mut lotus = card("Lion's Eye Diamond", "Artifact", "", "", "legal");
        lotus.reserved = Some(true);
        let sol = card("Sol Ring", "Artifact", "", "", "legal");
        let mut info: HashMap<String, Card> = [cradle, lotus, sol].into_iter().map(|c| (c.oracle_id.clone(), c)).collect();
        let dc = |name: &str, board| DeckCard { oracle_id: name.into(), name: name.into(), qty: 1, board };
        let cards = vec![dc("Gaea's Cradle", Board::Main), dc("Sol Ring", Board::Commander), dc("Lion's Eye Diamond", Board::Side)];
        assert_eq!(reserved_list(&cards, &info), Some(vec!["Gaea's Cradle".to_string()]));
        // Before an import reads the flag, the count is unknown, not zero.
        info.get_mut("Sol Ring").unwrap().reserved = None;
        assert_eq!(reserved_list(&cards, &info), None);
    }

    fn item(set: &str, number: &str, container: Option<&str>, proxy: bool, finish: &str) -> crate::collection::Item {
        crate::collection::Item {
            id: format!("{set}-{number}"),
            scryfall_id: format!("{set}-{number}"),
            qty: 1,
            condition: "NM".into(),
            finish: finish.into(),
            lang: "en".into(),
            altered: false,
            signed: false,
            misprint: false,
            proxy,
            container_id: container.map(str::to_string),
            container_name: None,
            container_kind: None,
            purchase_price: None,
            purchase_currency: None,
            note: None,
            updated_at: String::new(),
            oracle_id: Some("o".into()),
            name: Some("Sol Ring".into()),
            set_code: Some(set.into()),
            set_name: None,
            collector_number: Some(number.into()),
            rarity: None,
            image_small: None,
            image_normal: None,
            type_line: None,
            color_identity: None,
            unit_price_usd: None,
            price_date: None,
        }
    }

    #[test]
    fn exports_name_the_copy_in_the_deck_first() {
        let binder = item("cmm", "410", Some("binder"), false, "nonfoil");
        let deck = item("c21", "263", Some("deck"), false, "foil");
        let proxy = item("pip", "1", Some("deck"), true, "nonfoil");
        let pick = |items: &[&crate::collection::Item], c| owned_printing(items, c).map(|p| (p.set_code, p.finish));
        assert_eq!(pick(&[&binder, &proxy, &deck], Some("deck")), Some(("c21".into(), "foil".into())));
        // Real copies before proxies, wherever they are.
        assert_eq!(pick(&[&proxy, &binder], Some("deck")), Some(("cmm".into(), "nonfoil".into())));
        assert_eq!(pick(&[&proxy], None), Some(("pip".into(), "nonfoil".into())));
        assert_eq!(pick(&[], None), None);
    }

    fn printing(set: &str, number: &str, finishes: &str, released: &str, digital: Option<bool>, set_type: &str, is_default: bool) -> PrintingChoice {
        PrintingChoice {
            scryfall_id: format!("{set}-{number}"),
            set_code: set.into(),
            collector_number: number.into(),
            finishes: finishes.into(),
            lang: "en".into(),
            released_at: Some(released.into()),
            digital,
            set_type: Some(set_type.into()),
            is_default,
        }
    }

    #[test]
    fn exports_of_unowned_cards_name_a_paper_printing() {
        let pick = |ps: &[PrintingChoice]| paper_printing(ps).map(|p| format!("{} {} {}", p.set_code, p.collector_number, p.finish));
        let both = r#"["nonfoil","foil"]"#;
        // Plateau: Scryfall's default is Vintage Masters, which is MTGO only. Skip it, the
        // Masters Editions (also MTGO), the 30th Anniversary collectible and Summer Magic for
        // Revised.
        let plateau = [
            printing("30a", "572", r#"["nonfoil"]"#, "2022-11-28", Some(false), "memorabilia", false),
            printing("vma", "308", both, "2014-06-16", Some(true), "masters", true),
            printing("me4", "249", both, "2011-01-10", Some(true), "masters", false),
            printing("sum", "284", r#"["nonfoil"]"#, "1994-06-21", Some(false), "core", false),
            printing("3ed", "284", r#"["nonfoil"]"#, "1994-04-11", Some(false), "core", false),
            printing("leb", "280", r#"["nonfoil"]"#, "1993-10-04", Some(false), "core", false),
        ];
        assert_eq!(pick(&plateau).as_deref(), Some("3ed 284 nonfoil"));

        // A default printing on paper wins, even over newer printings.
        let sol_ring = [
            printing("cmm", "410", both, "2023-08-04", Some(false), "masters", true),
            printing("sld", "1512", r#"["foil"]"#, "2024-01-01", Some(false), "box", false),
            printing("frc", "21", r#"["nonfoil"]"#, "2026-10-02", Some(false), "commander", false),
        ];
        assert_eq!(pick(&sol_ring).as_deref(), Some("cmm 410 nonfoil"));

        // A foil-only default gives way to a nonfoil printing; foil-only everywhere is marked foil.
        let sauron = [
            printing("ltr", "288", r#"["foil"]"#, "2023-06-23", Some(false), "expansion", true),
            printing("ltr", "224", both, "2023-06-23", Some(false), "expansion", false),
        ];
        assert_eq!(pick(&sauron).as_deref(), Some("ltr 224 nonfoil"));
        assert_eq!(pick(&sauron[..1]).as_deref(), Some("ltr 288 foil"));
        let etched = [printing("cmr", "600", r#"["etched"]"#, "2020-11-20", Some(false), "draft_innovation", true)];
        assert_eq!(pick(&etched).as_deref(), Some("cmr 600 etched"));

        // Only on Arena or MTGO: no printing, so the export names the card alone.
        assert_eq!(pick(&[printing("ymid", "1", both, "2021-12-09", Some(true), "alchemy", true)]), None);

        // Before the import that reads `digital`: the default printing, with its own finish.
        let unknown = [
            printing("vma", "308", r#"["foil"]"#, "2014-06-16", None, "masters", true),
            printing("3ed", "284", r#"["nonfoil"]"#, "1994-04-11", None, "core", false),
        ];
        assert_eq!(pick(&unknown).as_deref(), Some("vma 308 foil"));
    }

    #[test]
    fn validation_catches_identity_singleton_bans_and_size() {
        let info: HashMap<String, Card> = [
            card("Omo", "Legendary Creature — Shapeshifter", "UG", "", "legal"),
            card("Sol Ring", "Artifact", "", "", "legal"),
            card("Bolt", "Instant", "R", "", "legal"),
            card("Jeweled Lotus", "Artifact", "", "", "banned"),
            card("Forest", "Basic Land — Forest", "G", "", "legal"),
            card("Relentless Rats", "Creature — Rat", "B", "A deck can have any number of cards named Relentless Rats.", "legal"),
        ]
        .into_iter()
        .map(|c| (c.oracle_id.clone(), c))
        .collect();
        let dc = |name: &str, qty, board| DeckCard { oracle_id: name.into(), name: name.into(), qty, board };
        let cards = vec![
            dc("Omo", 1, Board::Commander),
            dc("Sol Ring", 2, Board::Main),
            dc("Bolt", 1, Board::Main),
            dc("Jeweled Lotus", 1, Board::Main),
            dc("Forest", 95, Board::Main),
        ];
        let v = validate(&cards, &info);
        assert!(!v.ok);
        assert_eq!(v.color_identity, "UG");
        assert!(v.errors.iter().any(|e| e.contains("Sol Ring") && e.contains("singleton")));
        assert!(v.errors.iter().any(|e| e.contains("Bolt is outside")));
        assert!(v.errors.iter().any(|e| e.contains("Jeweled Lotus is banned")));
        assert!(!v.errors.iter().any(|e| e.contains("Forest")));
        assert!(!v.errors.iter().any(|e| e.contains("100"))); // 1 + 2 + 1 + 1 + 95 = 100

        // The commander listed again in the main deck: one row each, counted together, said once.
        let twice = vec![dc("Omo", 1, Board::Commander), dc("Omo", 1, Board::Main), dc("Forest", 98, Board::Main)];
        let v = validate(&twice, &info);
        assert_eq!(v.errors.iter().filter(|e| e.contains("singleton")).collect::<Vec<_>>(), ["2 × Omo: Commander is singleton"]);
        // Basics and "any number" cards still may repeat across rows.
        let rats = vec![dc("Omo", 1, Board::Commander), dc("Relentless Rats", 30, Board::Main), dc("Relentless Rats", 2, Board::Main), dc("Forest", 67, Board::Main)];
        assert!(!validate(&rats, &info).errors.iter().any(|e| e.contains("singleton")));
    }
}

/// The folder of decks made from a Mythic Tools deck container; only they follow it.
const MYTHIC_FOLDER: &str = "Mythic Tools";

/// What [`sync_deck_from_container`] did.
#[derive(Debug, PartialEq, Eq)]
pub enum ContainerSync {
    Created,
    Updated,
    Unchanged,
    /// The container's deck wasn't made from a Mythic Tools file, so it was left alone.
    NotFromMythic,
}

/// Keep a Yama deck in step with a collection container of kind "deck" (from a Mythic Tools
/// import): create it the first time, add a version when the cards change. Mythic Tools doesn't
/// say which card is the commander, so cards go in the main deck; the deck's existing commanders
/// stay while they're in the container, else a lone legendary creature or a card that says it
/// can be your commander is promoted.
///
/// Only decks this made (folder "Mythic Tools") follow their container. A deck made another way
/// whose box the file happens to name (a deck imported on the web, then "Add to my collection")
/// keeps its list: the box can hold more than the list, so following it would change the deck.
pub async fn sync_deck_from_container(pool: &SqlitePool, owner: &str, container_id: &str, name: &str) -> AppResult<ContainerSync> {
    let rows: Vec<(String, String, i64, String, String)> = sqlx::query_as(
        "SELECT c.oracle_id, c.name, SUM(i.qty), c.type_line, c.oracle_text FROM collection_items i
         JOIN printings p ON p.scryfall_id = i.scryfall_id JOIN cards c ON c.oracle_id = p.oracle_id
         WHERE i.owner_id = ? AND i.container_id = ?
         GROUP BY c.oracle_id ORDER BY c.name",
    )
    .bind(owner)
    .bind(container_id)
    .fetch_all(pool)
    .await?;
    let existing: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT id, current_version_id, folder FROM decks WHERE owner_id = ? AND container_id = ? AND archived = 0 ORDER BY created_at LIMIT 1")
            .bind(owner)
            .bind(container_id)
            .fetch_optional(pool)
            .await?;
    if let Some((_, _, folder)) = &existing
        && folder.as_deref() != Some(MYTHIC_FOLDER)
    {
        return Ok(ContainerSync::NotFromMythic);
    }
    let existing = existing.map(|(id, version, _)| (id, version));
    let old = match &existing {
        Some((_, Some(v))) => Some(load_version_cards(pool, v).await?),
        _ => None,
    };
    // The deck's own commanders stay while they're still in the container (someone may have
    // picked one of several legends); otherwise a lone candidate is promoted.
    let kept: Vec<String> = old
        .iter()
        .flatten()
        .filter(|c| c.board == Board::Commander && rows.iter().any(|(id, ..)| id == &c.oracle_id))
        .map(|c| c.oracle_id.clone())
        .collect();
    let eligible: Vec<&String> = rows
        .iter()
        .filter(|(_, _, _, t, o)| (t.contains("Legendary") && t.contains("Creature")) || o.to_lowercase().contains("can be your commander"))
        .map(|(id, ..)| id)
        .collect();
    let commanders: Vec<String> = if !kept.is_empty() {
        kept
    } else if eligible.len() == 1 {
        vec![eligible[0].clone()]
    } else {
        vec![]
    };
    let cards: Vec<DeckCard> = rows
        .iter()
        .map(|(oracle_id, name, qty, ..)| DeckCard {
            oracle_id: oracle_id.clone(),
            name: name.clone(),
            qty: *qty,
            board: if commanders.contains(oracle_id) { Board::Commander } else { Board::Main },
        })
        .collect();
    match existing {
        None => {
            let id = create_deck_with_cards(pool, owner, name, Some(MYTHIC_FOLDER), cards).await?;
            sqlx::query("UPDATE decks SET container_id = ? WHERE id = ?").bind(container_id).bind(&id).execute(pool).await?;
            Ok(ContainerSync::Created)
        }
        Some((id, _)) => {
            let same = match &old {
                Some(old) => {
                    let key = |c: &[DeckCard]| {
                        let mut k: Vec<(String, i64)> = c.iter().map(|x| (x.oracle_id.clone(), x.qty)).collect();
                        k.sort();
                        k
                    };
                    key(old) == key(&cards)
                }
                None => false,
            };
            if same {
                return Ok(ContainerSync::Unchanged);
            }
            insert_version(pool, &id, &cards, Some("updated from a Mythic Tools import")).await?;
            Ok(ContainerSync::Updated)
        }
    }
}
