pub mod import;
pub mod search;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
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
        .route("/api/cards/autocomplete", get(autocomplete))
        .route("/api/cards/{oracle_id}", get(card_detail))
        .route("/api/printings/lookup", get(lookup_printing))
        .route("/api/meta/data", get(data_status))
        .route("/api/cards/offline", get(offline_cards))
        .route("/api/printings/{id}/prices", get(price_history))
        .route("/api/sets", get(set_codes))
}

pub const CARD_COLUMNS: &str = "cards.oracle_id, cards.name, cards.mana_cost, cards.cmc, cards.type_line, \
    cards.oracle_text, cards.colors, cards.color_identity, cards.power, cards.toughness, cards.loyalty, \
    cards.rarity, cards.layout, cards.legalities, cards.image_small, cards.image_normal, cards.image_art_crop, \
    cards.back_image_normal, cards.artist, cards.default_printing, cards.edhrec_rank, cards.game_changer";

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
struct SearchResult {
    total: i64,
    page: u32,
    page_size: u32,
    cards: Vec<Card>,
}

const PAGE_SIZE: u32 = 60;
const GAME_CHANGERS_NOT_LOADED: &str =
    "The Game Changer list isn't loaded on this server yet, so is:gamechanger can't be searched. It comes with the next card data import.";
const EXTRA_LAYOUTS: &str = "('token','double_faced_token','emblem','vanguard','scheme','planar')";

async fn search_cards(
    State(st): State<AppState>,
    _user: CurrentUser,
    Query(p): Query<SearchParams>,
) -> AppResult<Json<SearchResult>> {
    let compiled = search::compile(&p.q).map_err(AppError::BadRequest)?;
    // Before the flags are loaded every card's flag is NULL, so is:gamechanger would quietly
    // find nothing. Say why instead.
    if compiled.uses_game_changer && import::game_changers_date(&st.pool).await?.is_none() {
        return Err(AppError::Conflict(GAME_CHANGERS_NOT_LOADED.into()));
    }
    let mut filter = compiled.sql;
    if !search::wants_extras(&p.q) {
        filter = format!("({filter}) AND IFNULL(cards.layout, '') NOT IN {EXTRA_LAYOUTS}");
    }
    let order = match p.order.as_deref() {
        Some("mv" | "cmc") => "cards.cmc, cards.name",
        Some("edhrec") => "cards.edhrec_rank IS NULL, cards.edhrec_rank, cards.name",
        Some("color") => "length(cards.colors), cards.colors, cards.name",
        _ => "cards.name",
    };
    let page = p.page.unwrap_or(1).max(1);

    let count_sql = format!("SELECT COUNT(*) FROM cards WHERE {filter}");
    let mut count_q = sqlx::query_scalar::<_, i64>(AssertSqlSafe(count_sql));
    for b in &compiled.binds {
        count_q = match b {
            search::Bind::Text(s) => count_q.bind(s),
            search::Bind::Num(n) => count_q.bind(n),
        };
    }
    let total = count_q.fetch_one(&st.pool).await?;

    let sql = format!("SELECT {CARD_COLUMNS} FROM cards WHERE {filter} ORDER BY {order} LIMIT {PAGE_SIZE} OFFSET ?");
    let mut q = sqlx::query_as::<_, Card>(AssertSqlSafe(sql));
    for b in &compiled.binds {
        q = match b {
            search::Bind::Text(s) => q.bind(s),
            search::Bind::Num(n) => q.bind(n),
        };
    }
    let cards = q.bind(((page - 1) * PAGE_SIZE) as i64).fetch_all(&st.pool).await?;
    Ok(Json(SearchResult { total, page, page_size: PAGE_SIZE, cards }))
}

#[derive(Deserialize)]
struct AutoParams {
    q: String,
}

async fn autocomplete(
    State(st): State<AppState>,
    _user: CurrentUser,
    Query(p): Query<AutoParams>,
) -> AppResult<Json<Vec<String>>> {
    let q = p.q.trim();
    if q.len() < 2 {
        return Ok(Json(vec![]));
    }
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM cards WHERE name LIKE ? ESCAPE '\\' AND IFNULL(layout,'') NOT IN ('token','double_faced_token','emblem')
         ORDER BY (name LIKE ? ESCAPE '\\') DESC, edhrec_rank IS NULL, edhrec_rank, name LIMIT 15",
    )
    .bind(format!("%{}%", escape(q)))
    .bind(format!("{}%", escape(q)))
    .fetch_all(&st.pool)
    .await?;
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
    LEFT JOIN price_snapshots ps ON ps.scryfall_id = p.scryfall_id
      AND ps.date = (SELECT MAX(date) FROM price_snapshots WHERE scryfall_id = p.scryfall_id)";

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
        latest_price_date: sqlx::query_scalar("SELECT MAX(date) FROM price_snapshots").fetch_one(&st.pool).await?,
        last_imports: sqlx::query_as(
            "SELECT kind, source_updated_at, finished_at, rows, error FROM import_runs ORDER BY started_at DESC LIMIT 5",
        )
        .fetch_all(&st.pool)
        .await?,
    }))
}

/// Resolve card names (any face, any case) to oracle IDs. Unknown names are left out.
pub async fn resolve_names(pool: &SqlitePool, names: &[String]) -> AppResult<HashMap<String, String>> {
    let mut out = HashMap::new();
    for name in names {
        let key = name.trim();
        let hit: Option<String> = sqlx::query_scalar(
            "SELECT n.oracle_id FROM card_names n JOIN cards c ON c.oracle_id = n.oracle_id
             WHERE n.name = ? ORDER BY IFNULL(c.layout,'') IN ('token','double_faced_token','art_series') LIMIT 1",
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

async fn offline_cards(State(st): State<AppState>, _user: CurrentUser) -> AppResult<Json<OfflineBundle>> {
    let version: Option<String> = sqlx::query_scalar("SELECT MAX(updated_at) FROM cards").fetch_one(&st.pool).await?;
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
    .fetch_all(&st.pool)
    .await?;
    let game_changers = import::game_changers_date(&st.pool).await?.is_some();
    Ok(Json(OfflineBundle { format: OFFLINE_FORMAT, version: version.unwrap_or_default(), game_changers, cards }))
}

#[derive(Serialize, sqlx::FromRow)]
struct PricePoint {
    date: String,
    usd: Option<f64>,
    usd_foil: Option<f64>,
    usd_etched: Option<f64>,
    eur: Option<f64>,
}

/// Every daily snapshot we've kept for one printing, oldest first. Gaps are days we didn't import.
async fn price_history(State(st): State<AppState>, _u: CurrentUser, Path(id): Path<String>) -> AppResult<Json<Vec<PricePoint>>> {
    Ok(Json(
        sqlx::query_as("SELECT date, usd, usd_foil, usd_etched, eur FROM price_snapshots WHERE scryfall_id = ? ORDER BY date")
            .bind(&id)
            .fetch_all(&st.pool)
            .await?,
    ))
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
