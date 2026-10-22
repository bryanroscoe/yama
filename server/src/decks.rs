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

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/decks", get(list_decks).post(create_deck))
        .route("/api/decks/parse", post(parse_preview))
        .route("/api/decks/{id}", get(get_deck).put(save_version).patch(update_deck).delete(archive_deck))
        .route("/api/decks/{id}/versions", get(list_versions))
        .route("/api/decks/{id}/versions/{version}", get(get_version))
        .route("/api/decks/{id}/check", get(get_check).post(recheck))
        .route("/api/decks/{id}/results", get(results))
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
    id: String,
    name: String,
    folder: Option<String>,
    format: String,
    container_id: Option<String>,
    current_version_id: Option<String>,
    updated_at: String,
    /// The bracket the owner declares (1-5), or none.
    bracket: Option<i64>,
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
        "SELECT id, name, folder, format, container_id, current_version_id, updated_at, bracket FROM decks
         WHERE owner_id = ? AND archived = 0 ORDER BY folder, name",
    )
    .bind(&user.id)
    .fetch_all(&st.pool)
    .await?;
    let items = crate::collection::items_for_owner(&st.pool, &user.id).await?;
    let mut owned_by_oracle: HashMap<&str, i64> = HashMap::new();
    for i in items.iter().filter(|i| !i.proxy) {
        if let Some(o) = &i.oracle_id {
            *owned_by_oracle.entry(o.as_str()).or_insert(0) += i.qty;
        }
    }
    let versions: Vec<String> = decks.iter().filter_map(|d| d.current_version_id.clone()).collect();
    let mut estimates = crate::deck_checks::estimates(&st.pool, &versions).await?;
    for d in &mut decks {
        d.estimate = d.current_version_id.as_ref().and_then(|v| estimates.remove(v));
        // Same rule as the deck page's results (stats::results_by_version): only seats where the
        // owner played the deck themselves, so the computer piloting it online doesn't count.
        let (games, wins, draws): (i64, i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), IFNULL(SUM(g.winner_seat = s.seat), 0), IFNULL(SUM(g.winner_seat IS NULL), 0)
             FROM game_seats s JOIN games g ON g.id = s.game_id JOIN deck_versions v ON v.id = s.deck_version_id
             WHERE v.deck_id = ? AND g.status = 'finished' AND s.ai_kind IS NULL AND s.user_id = ?",
        )
        .bind(&d.id)
        .bind(&user.id)
        .fetch_one(&st.pool)
        .await?;
        (d.games, d.wins, d.draws) = (games, wins, draws);
        if let Some(v) = &d.current_version_id {
            let cards = load_version_cards(&st.pool, v).await?;
            d.card_count = cards.iter().filter(|c| c.board != Board::Side).map(|c| c.qty).sum();
            d.owned = cards
                .iter()
                .filter(|c| c.board != Board::Side)
                .map(|c| c.qty.min(owned_by_oracle.get(c.oracle_id.as_str()).copied().unwrap_or(0)))
                .sum();
            let commanders: Vec<&DeckCard> = cards.iter().filter(|c| c.board == Board::Commander).collect();
            d.commanders = commanders.iter().map(|c| c.name.clone()).collect();
            let mut identity = String::new();
            for c in &commanders {
                let row: Option<(String, Option<String>, Option<String>)> =
                    sqlx::query_as("SELECT color_identity, image_art_crop, artist FROM cards WHERE oracle_id = ?")
                        .bind(&c.oracle_id)
                        .fetch_optional(&st.pool)
                        .await?;
                if let Some((ci, art, artist)) = row {
                    identity.push_str(&ci);
                    if d.commander_image.is_none() && art.is_some() {
                        d.commander_image = art;
                        d.commander_artist = artist;
                    }
                }
            }
            d.color_identity = "WUBRG".chars().filter(|c| identity.contains(*c)).collect();
        }
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
    sqlx::query("INSERT INTO decks (id, owner_id, name, folder, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .bind(&id)
        .bind(owner)
        .bind(name.trim())
        .bind(folder)
        .bind(&stamp)
        .bind(&stamp)
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
async fn insert_version_in(conn: &mut SqliteConnection, deck_id: &str, cards: &[DeckCard], note: Option<&str>) -> AppResult<String> {
    let vid = new_id();
    let stamp = now();
    sqlx::query("INSERT INTO deck_versions (id, deck_id, cards, note, created_at) VALUES (?,?,?,?,?)")
        .bind(&vid)
        .bind(deck_id)
        .bind(serde_json::to_string(cards).map_err(anyhow::Error::from)?)
        .bind(note)
        .bind(&stamp)
        .execute(&mut *conn)
        .await?;
    sqlx::query("UPDATE decks SET current_version_id = ?, updated_at = ? WHERE id = ?")
        .bind(&vid)
        .bind(&stamp)
        .bind(deck_id)
        .execute(&mut *conn)
        .await?;
    crate::deck_checks::queue(&mut *conn, &vid).await?;
    Ok(vid)
}

pub async fn load_version_cards(pool: &SqlitePool, version_id: &str) -> AppResult<Vec<DeckCard>> {
    let json: String = sqlx::query_scalar("SELECT cards FROM deck_versions WHERE id = ?").bind(version_id).fetch_one(pool).await?;
    Ok(serde_json::from_str(&json).map_err(anyhow::Error::from)?)
}

async fn owned_deck(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<(String, Option<String>, Option<String>)> {
    sqlx::query_as("SELECT name, current_version_id, container_id FROM decks WHERE id = ? AND owner_id = ?")
        .bind(id)
        .bind(owner)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("deck"))
}

#[derive(Serialize)]
struct DeckView {
    id: String,
    name: String,
    container_id: Option<String>,
    version_id: Option<String>,
    /// The bracket the owner declares (1-5), or none. Estimates come from `/check`.
    bracket: Option<i64>,
    cards: Vec<DeckEntry>,
    validation: Validation,
    ownership: OwnershipTotals,
    /// Names of the cards on the Commander Game Changers list (commander and main deck).
    /// `None` while any of those cards has no flag loaded yet.
    game_changers: Option<Vec<String>>,
    /// Date of the Scryfall data the flags come from (YYYY-MM-DD), if loaded.
    game_changers_as_of: Option<String>,
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
    /// The printing to name in exports: your own copy (real before proxy, the one in this deck's
    /// container first), else a paper printing (see [`paper_printing`]). `None` if neither is
    /// known, so the export names the card alone.
    printing: Option<PrintRef>,
    /// Colors of mana the card makes (Scryfall's produced_mana, "WUBRGC" order); "" for none,
    /// `None` until the card data import that reads it has run.
    produced_mana: Option<String>,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
struct PrintRef {
    set_code: String,
    collector_number: String,
    /// nonfoil | foil | etched
    finish: String,
    /// "owned" or "default"
    from: &'static str,
}

/// The printing an export should name for a card: a real copy (the one in the deck's container
/// first), then a proxy the same way (it still names a printing), else `None` so the caller can
/// fall back to [`paper_printing`].
fn owned_printing(mine: &[&crate::collection::Item], container_id: Option<&str>) -> Option<PrintRef> {
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

/// One printing of a card, as [`paper_printing`] weighs it.
#[derive(sqlx::FromRow, Debug, Clone)]
struct PrintingChoice {
    set_code: String,
    collector_number: String,
    /// JSON array: nonfoil | foil | etched
    finishes: String,
    lang: String,
    released_at: Option<String>,
    /// Scryfall's `digital` (only released in a video game); `None` until the printings import
    /// that reads it has run.
    digital: Option<bool>,
    set_type: Option<String>,
    is_default: bool,
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
fn paper_printing(printings: &[PrintingChoice]) -> Option<PrintRef> {
    let has = |p: &PrintingChoice, finish: &str| {
        serde_json::from_str::<Vec<String>>(&p.finishes).is_ok_and(|f| f.iter().any(|x| x == finish))
    };
    let best = if printings.iter().any(|p| p.digital.is_some()) {
        printings.iter().filter(|p| p.digital == Some(false)).min_by_key(|p| {
            (
                !has(p, "nonfoil"),
                !p.is_default,
                p.set_type.as_deref().is_some_and(|t| SIDE_SET_TYPES.contains(&t)) || RARE_RUN_SETS.contains(&p.set_code.as_str()),
                p.lang != "en",
                std::cmp::Reverse(p.released_at.clone()),
                p.collector_number.len(),
                p.collector_number.clone(),
            )
        })?
    } else {
        printings.iter().find(|p| p.is_default)?
    };
    let finish = ["nonfoil", "foil", "etched"].into_iter().find(|f| has(best, f)).unwrap_or("nonfoil");
    Some(PrintRef {
        set_code: best.set_code.clone(),
        collector_number: best.collector_number.clone(),
        finish: finish.into(),
        from: "default",
    })
}

#[derive(Serialize, Default)]
struct OwnershipTotals {
    cards: i64,
    owned: i64,
    needed: i64,
    /// Sum of cheapest prices for needed cards that have a price.
    needed_cost_usd: f64,
    needed_without_price: i64,
    /// The Scryfall price snapshot those prices come from (YYYY-MM-DD).
    price_date: Option<String>,
}

async fn get_deck(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<DeckView>> {
    let (name, version_id, container_id) = owned_deck(&st.pool, &user.id, &id).await?;
    let cards = match &version_id {
        Some(v) => load_version_cards(&st.pool, v).await?,
        None => vec![],
    };
    let mut card_info: HashMap<String, Card> = HashMap::new();
    for c in &cards {
        if let Some(card) = sqlx::query_as::<_, Card>(AssertSqlSafe(format!("SELECT {CARD_COLUMNS} FROM cards WHERE oracle_id = ?")))
            .bind(&c.oracle_id)
            .fetch_optional(&st.pool)
            .await?
        {
            card_info.insert(c.oracle_id.clone(), card);
        }
    }
    let validation = validate(&cards, &card_info);
    let game_changers = game_changers(&cards, &card_info);
    let game_changers_as_of = crate::cards::import::game_changers_date(&st.pool).await?;
    let bracket: Option<i64> = sqlx::query_scalar("SELECT bracket FROM decks WHERE id = ?").bind(&id).fetch_one(&st.pool).await?;

    // Ownership, by oracle ID, across the whole collection.
    let items = crate::collection::items_for_owner(&st.pool, &user.id).await?;
    let mut entries = Vec::new();
    let mut totals = OwnershipTotals::default();
    for c in cards {
        let mine: Vec<_> = items.iter().filter(|i| i.oracle_id.as_deref() == Some(&c.oracle_id)).collect();
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
        let needed = (c.qty - owned).max(0);
        let (cheapest_usd, price_date): (Option<f64>, Option<String>) = if c.board == Board::Side {
            (None, None)
        } else {
            sqlx::query_as(
                "SELECT MIN(COALESCE(ps.usd, ps.usd_foil, ps.usd_etched)), MAX(ps.date) FROM printings p
                 JOIN price_snapshots ps ON ps.scryfall_id = p.scryfall_id
                   AND ps.date = (SELECT MAX(date) FROM price_snapshots WHERE scryfall_id = p.scryfall_id)
                 WHERE p.oracle_id = ?",
            )
            .bind(&c.oracle_id)
            .fetch_one(&st.pool)
            .await?
        };
        if price_date > totals.price_date {
            totals.price_date = price_date;
        }
        if c.board != Board::Side {
            totals.cards += c.qty;
            totals.owned += c.qty.min(owned);
            totals.needed += needed;
            if needed > 0 && !is_basic(&c.name) {
                match cheapest_usd {
                    Some(p) => totals.needed_cost_usd += p * needed as f64,
                    None => totals.needed_without_price += needed,
                }
            }
        }
        let card = card_info.get(&c.oracle_id).cloned();
        let printing = match owned_printing(&mine, container_id.as_deref()) {
            Some(p) => Some(p),
            None => paper_printing(
                &sqlx::query_as::<_, PrintingChoice>(
                    "SELECT p.set_code, p.collector_number, p.finishes, p.lang, p.released_at, p.digital, p.set_type,
                            (p.scryfall_id IS c.default_printing) AS is_default
                     FROM printings p JOIN cards c ON c.oracle_id = p.oracle_id WHERE p.oracle_id = ?",
                )
                .bind(&c.oracle_id)
                .fetch_all(&st.pool)
                .await?,
            ),
        };
        let produced_mana: Option<String> = sqlx::query_scalar("SELECT produced_mana FROM cards WHERE oracle_id = ?")
            .bind(&c.oracle_id)
            .fetch_optional(&st.pool)
            .await?
            .flatten();
        entries.push(DeckEntry { entry: c, card, owned, in_deck_container, proxies, locations, needed, cheapest_usd, printing, produced_mana });
    }
    totals.needed_cost_usd = (totals.needed_cost_usd * 100.0).round() / 100.0;
    Ok(Json(DeckView {
        id,
        name,
        container_id,
        version_id,
        bracket,
        cards: entries,
        validation,
        ownership: totals,
        game_changers,
        game_changers_as_of,
    }))
}

#[derive(Deserialize)]
struct SaveVersion {
    cards: Vec<DeckCard>,
    note: Option<String>,
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
    Ok(Json(serde_json::json!({ "version_id": vid })))
}

#[derive(Deserialize)]
struct UpdateDeck {
    name: Option<String>,
    #[serde(default, deserialize_with = "crate::util::double_option")]
    folder: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::util::double_option")]
    container_id: Option<Option<String>>,
    /// The declared bracket, 1-5; null clears it.
    #[serde(default, deserialize_with = "crate::util::double_option")]
    bracket: Option<Option<i64>>,
}

async fn update_deck(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateDeck>,
) -> AppResult<()> {
    let (name, _, container) = owned_deck(&st.pool, &user.id, &id).await?;
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
    let (folder, bracket): (Option<String>, Option<i64>) =
        sqlx::query_as("SELECT folder, bracket FROM decks WHERE id = ?").bind(&id).fetch_one(&st.pool).await?;
    sqlx::query("UPDATE decks SET name = ?, folder = ?, container_id = ?, bracket = ?, updated_at = ? WHERE id = ?")
        .bind(body.name.unwrap_or(name))
        .bind(body.folder.unwrap_or(folder))
        .bind(body.container_id.unwrap_or(container))
        .bind(body.bracket.unwrap_or(bracket))
        .bind(now())
        .bind(&id)
        .execute(&st.pool)
        .await?;
    Ok(())
}

async fn archive_deck(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    owned_deck(&st.pool, &user.id, &id).await?;
    sqlx::query("UPDATE decks SET archived = 1, updated_at = ? WHERE id = ?").bind(now()).bind(&id).execute(&st.pool).await?;
    Ok(())
}

#[derive(Serialize, sqlx::FromRow)]
struct VersionRow {
    id: String,
    note: Option<String>,
    created_at: String,
}

async fn list_versions(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Vec<VersionRow>>> {
    owned_deck(&st.pool, &user.id, &id).await?;
    Ok(Json(
        // rowid breaks ties between versions saved in the same second.
        sqlx::query_as("SELECT id, note, created_at FROM deck_versions WHERE deck_id = ? ORDER BY created_at DESC, rowid DESC")
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
    let mut names = Vec::new();
    for c in cards.iter().filter(|c| c.board != Board::Side) {
        let Some(card) = info.get(&c.oracle_id) else { continue };
        if card.game_changer? {
            names.push(c.name.clone());
        }
    }
    names.sort();
    names.dedup();
    Some(names)
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

fn is_basic(name: &str) -> bool {
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
        if c.qty > 1 && !is_basic(&c.name) && !any_number && up_to.is_none_or(|n| c.qty > n) {
            v.errors.push(format!("{} × {}: Commander is singleton", c.qty, c.name));
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
    }
}

/// CLI: import every `.txt` deck list in a directory for one user. Skips names that already exist.
pub async fn import_dir(pool: &SqlitePool, dir: &std::path::Path, owner_email: &str) -> anyhow::Result<()> {
    let owner: String = match sqlx::query_scalar("SELECT id FROM users WHERE email = ?").bind(owner_email).fetch_optional(pool).await? {
        Some(id) => id,
        None => anyhow::bail!("no user {owner_email}; sign in once first"),
    };
    let mut paths: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "txt")).collect();
    paths.sort();
    for path in paths {
        let name = path.file_stem().unwrap().to_string_lossy().replace('_', " ");
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM decks WHERE owner_id = ? AND name = ? AND archived = 0")
            .bind(&owner)
            .bind(&name)
            .fetch_optional(pool)
            .await?;
        if exists.is_some() {
            println!("skip {name}: already imported");
            continue;
        }
        let text = std::fs::read_to_string(&path)?;
        let parsed = resolve(pool, parse_list(&text, true)).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        let count: i64 = parsed.cards.iter().map(|c| c.qty).sum();
        create_deck_with_cards(pool, &owner, &name, Some("commander-decks"), parsed.cards).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        println!("imported {name}: {count} cards{}", if parsed.unknown.is_empty() { String::new() } else { format!(", unknown: {}", parsed.unknown.join(", ")) });
    }
    Ok(())
}

/// Keep a Yama deck in step with a collection container of kind "deck" (from a Mythic Tools
/// import): create it the first time, add a version when the cards change. Mythic Tools doesn't
/// say which card is the commander, so cards go in the main deck; a lone legendary creature or
/// a card that says it can be your commander is promoted. Returns (deck id, created?).
pub async fn sync_deck_from_container(pool: &SqlitePool, owner: &str, container_id: &str, name: &str) -> AppResult<(String, bool, bool)> {
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
    let eligible: Vec<&String> = rows
        .iter()
        .filter(|(_, _, _, t, o)| (t.contains("Legendary") && t.contains("Creature")) || o.to_lowercase().contains("can be your commander"))
        .map(|(id, ..)| id)
        .collect();
    let commander = (eligible.len() == 1).then(|| eligible[0].clone());
    let cards: Vec<DeckCard> = rows
        .iter()
        .map(|(oracle_id, name, qty, ..)| DeckCard {
            oracle_id: oracle_id.clone(),
            name: name.clone(),
            qty: *qty,
            board: if Some(oracle_id) == commander.as_ref() { Board::Commander } else { Board::Main },
        })
        .collect();
    let existing: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT id, current_version_id FROM decks WHERE owner_id = ? AND container_id = ? AND archived = 0 LIMIT 1")
            .bind(owner)
            .bind(container_id)
            .fetch_optional(pool)
            .await?;
    match existing {
        None => {
            let id = create_deck_with_cards(pool, owner, name, Some("Mythic Tools"), cards).await?;
            sqlx::query("UPDATE decks SET container_id = ? WHERE id = ?").bind(container_id).bind(&id).execute(pool).await?;
            Ok((id, true, true))
        }
        Some((id, version)) => {
            let same = match &version {
                Some(v) => {
                    let old = load_version_cards(pool, v).await?;
                    let key = |c: &[DeckCard]| {
                        let mut k: Vec<(String, i64)> = c.iter().map(|x| (x.oracle_id.clone(), x.qty)).collect();
                        k.sort();
                        k
                    };
                    key(&old) == key(&cards)
                }
                None => false,
            };
            if !same {
                insert_version(pool, &id, &cards, Some("updated from a Mythic Tools import")).await?;
            }
            Ok((id, false, !same))
        }
    }
}
