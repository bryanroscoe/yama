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
struct ParseResult {
    cards: Vec<DeckCard>,
    unknown: Vec<String>,
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

async fn resolve(pool: &SqlitePool, lines: Vec<ParsedLine>) -> AppResult<ParseResult> {
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

async fn parse_preview(State(st): State<AppState>, _u: CurrentUser, Json(req): Json<ParseRequest>) -> AppResult<Json<ParseResult>> {
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
    #[sqlx(skip)]
    commanders: Vec<String>,
    #[sqlx(skip)]
    color_identity: String,
    #[sqlx(skip)]
    card_count: i64,
    #[sqlx(skip)]
    commander_image: Option<String>,
}

async fn list_decks(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<DeckSummary>>> {
    let mut decks: Vec<DeckSummary> = sqlx::query_as(
        "SELECT id, name, folder, format, container_id, current_version_id, updated_at FROM decks
         WHERE owner_id = ? AND archived = 0 ORDER BY folder, name",
    )
    .bind(&user.id)
    .fetch_all(&st.pool)
    .await?;
    for d in &mut decks {
        if let Some(v) = &d.current_version_id {
            let cards = load_version_cards(&st.pool, v).await?;
            d.card_count = cards.iter().filter(|c| c.board != Board::Side).map(|c| c.qty).sum();
            let commanders: Vec<&DeckCard> = cards.iter().filter(|c| c.board == Board::Commander).collect();
            d.commanders = commanders.iter().map(|c| c.name.clone()).collect();
            let mut identity = String::new();
            for c in &commanders {
                let row: Option<(String, Option<String>)> =
                    sqlx::query_as("SELECT color_identity, image_art_crop FROM cards WHERE oracle_id = ?")
                        .bind(&c.oracle_id)
                        .fetch_optional(&st.pool)
                        .await?;
                if let Some((ci, art)) = row {
                    identity.push_str(&ci);
                    d.commander_image = d.commander_image.take().or(art);
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
    let mut tx = pool.begin().await?;
    let id = create_deck_in(&mut tx, owner, name, folder, &cards).await?;
    tx.commit().await?;
    Ok(id)
}

/// As `create_deck_with_cards`, inside the caller's transaction, so the deck commits (or rolls
/// back) together with the caller's own writes (the lab's op record for a precon deck).
pub async fn create_deck_in(conn: &mut SqliteConnection, owner: &str, name: &str, folder: Option<&str>, cards: &[DeckCard]) -> AppResult<String> {
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
    insert_version_in(conn, &id, cards, Some("created")).await?;
    Ok(id)
}

async fn insert_version(pool: &SqlitePool, deck_id: &str, cards: &[DeckCard], note: Option<&str>) -> AppResult<String> {
    let mut tx = pool.begin().await?;
    let vid = insert_version_in(&mut tx, deck_id, cards, note).await?;
    tx.commit().await?;
    Ok(vid)
}

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
    cards: Vec<DeckEntry>,
    validation: Validation,
    ownership: OwnershipTotals,
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
}

#[derive(Serialize, Default)]
struct OwnershipTotals {
    cards: i64,
    owned: i64,
    needed: i64,
    /// Sum of cheapest prices for needed cards that have a price.
    needed_cost_usd: f64,
    needed_without_price: i64,
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
        let cheapest_usd: Option<f64> = if c.board == Board::Side {
            None
        } else {
            sqlx::query_scalar(
                "SELECT MIN(COALESCE(ps.usd, ps.usd_foil, ps.usd_etched)) FROM printings p
                 JOIN price_snapshots ps ON ps.scryfall_id = p.scryfall_id
                   AND ps.date = (SELECT MAX(date) FROM price_snapshots WHERE scryfall_id = p.scryfall_id)
                 WHERE p.oracle_id = ?",
            )
            .bind(&c.oracle_id)
            .fetch_one(&st.pool)
            .await?
        };
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
        entries.push(DeckEntry { entry: c, card, owned, in_deck_container, proxies, locations, needed, cheapest_usd });
    }
    totals.needed_cost_usd = (totals.needed_cost_usd * 100.0).round() / 100.0;
    Ok(Json(DeckView { id, name, container_id, version_id, cards: entries, validation, ownership: totals }))
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
    let folder: Option<String> = sqlx::query_scalar("SELECT folder FROM decks WHERE id = ?").bind(&id).fetch_one(&st.pool).await?;
    sqlx::query("UPDATE decks SET name = ?, folder = ?, container_id = ?, updated_at = ? WHERE id = ?")
        .bind(body.name.unwrap_or(name))
        .bind(body.folder.unwrap_or(folder))
        .bind(body.container_id.unwrap_or(container))
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
        sqlx::query_as("SELECT id, note, created_at FROM deck_versions WHERE deck_id = ? ORDER BY created_at DESC")
            .bind(&id)
            .fetch_all(&st.pool)
            .await?,
    ))
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

const BASICS: [&str; 11] = [
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
        }
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
