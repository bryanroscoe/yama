//! Anonymous, read-only stock reference. Public DTOs never serialize Lab summaries or owners.
//! Publication copies reviewed results; importing or deleting a run cannot change that copy.
mod consensus;
mod power;
pub(crate) use power::correlation;
pub(crate) mod v2;
pub(crate) mod html;
#[cfg(test)]
mod tests;

use crate::error::{AppError, AppResult};
use crate::limits::{ClientAddress, address_key};
use crate::routes::AppState;
use crate::util::{new_id, now, sha256_hex};
use anyhow::{Context, ensure};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path as FilePath;
use std::sync::Arc;

pub const NOTICE: &str = include_str!("../../web/public/site-notice.html");
const METHOD: &str = "stock-precons-v1";
const MODEL: &str =
    "Plackett-Luce on finishing order; worth = deck strength x turn-position term (per pod size)";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/public/precons", get(api_list))
        .route("/api/public/precons/{slug}", get(api_detail))
        .route("/precons", get(html::index))
        .route("/precons/", get(html::index))
        .route("/precons/methodology", get(html::methodology))
        .route("/precons/{slug}", get(html::detail))
        .route("/precons/{slug}/decklist.txt", get(download))
        .route(
            "/precons/{slug}/commanders/{variant}/decklist.txt",
            get(download_variant),
        )
        .route("/precons/style.css", get(html::style))
        .route("/precons/assets/{filename}", get(html::versioned_style))
        .route("/sitemap.xml", get(html::sitemap))
}

/// Only these GET/HEAD APIs bypass view-as resolution: their output has no account context.
pub fn is_public_api(path: &str) -> bool {
    path == "/api/public/precons"
        || path
            .strip_prefix("/api/public/precons/")
            .is_some_and(valid_slug)
}

fn valid_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 160
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Publication {
    pub id: String,
    pub published_at: String,
    pub title: String,
    pub method: String,
    pub engine: String,
    pub card_data: String,
    pub runner: String,
    pub difficulty: String,
    pub analysed_at: String,
    pub interval_level: f64,
    pub field_size: usize,
    pub scored_games: i64,
    pub failed_games: i64,
    pub time_caps: i64,
    pub no_winner: i64,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Rating {
    pub games: i64,
    pub rank: Option<i64>,
    pub rank_interval: Option<[i64; 2]>,
    pub strength: Option<f64>,
    pub strength_interval: Option<[f64; 2]>,
    pub model_win_rate: Option<f64>,
    pub model_interval: Option<[f64; 2]>,
    pub observed_win_rate: Option<f64>,
    pub observed_interval: Option<[f64; 2]>,
    pub confidence: String,
    pub reasons: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct RatedList {
    list_hash: String,
    rating: Rating,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    publication: Publication,
    ratings: BTreeMap<String, RatedList>,
    #[serde(default)]
    comparisons: Vec<Snapshot>,
}

#[derive(Clone, Serialize)]
pub struct Simulation {
    pub publication_id: String,
    pub engine: String,
    pub rating: Rating,
}

#[derive(Clone, Serialize)]
pub struct RealGames {
    pub win_rate_4p: f64,
    pub games: i64,
    pub rank_in_catalog: Option<i64>,
    pub rated_catalog_decks: Option<i64>,
    pub fetched_at: Option<String>,
    pub source: &'static str,
    pub url: String,
}

#[derive(Clone, Serialize)]
pub struct Precon {
    pub power: Option<power::Power>,
    pub upgradeability: crate::upgradeability::Assessment,
    pub id: String,
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub released: Option<String>,
    pub commanders: Vec<String>,
    pub color_identity: String,
    pub card_count: i64,
    pub art: Option<crate::lab::Art>,
    pub singles_value: crate::deck_prices::SinglesValue,
    pub sealed_price: Option<crate::deck_prices::SealedPrice>,
    pub real_games: Option<RealGames>,
    pub rating: Option<Rating>,
    pub simulations: Vec<Simulation>,
    pub meta: Option<consensus::Meta>,
    /// Rating v2: real games from the enabled datasets with the published simulation.
    pub v2: Option<v2::Row>,
    /// Every list under the commander, from each enabled source that doesn't rate the stock list
    /// (Mythic Tools). Rating v2 reads it only for precons without stock games, once it passes its test.
    pub commander_games: Vec<v2::CommanderGames>,
    pub rating_status: &'static str,
    pub catalog_updated_at: Option<String>,
    pub source_url: Option<String>,
    pub partly_supported: Vec<String>,
    // Retain the exact list read with its metadata, so a concurrent catalog import cannot
    // pair one version's rating with another version's detail/export. Never serialize raw JSON.
    #[serde(skip)]
    stock_cards: String,
}

/// A stock list's real-game figure as the pages show it.
pub(crate) struct StockReal<'a> {
    pub source: &'a str,
    /// Four-player-normalised win rate, percent.
    pub rate: f64,
    pub games: u64,
    pub url: Option<&'a str>,
    /// The day the figure describes (snapshot or fetch).
    pub as_of: Option<String>,
}

impl Precon {
    /// The stock list's real games: the enabled dataset's newest snapshot (what the rank reads),
    /// else the catalog's cached Playgroup.gg figure.
    pub(crate) fn stock_real(&self) -> Option<StockReal<'_>> {
        if let Some(r) = self.v2.as_ref().and_then(|v| v.real.as_ref()) {
            return Some(StockReal {
                source: &r.source,
                rate: r.all_time,
                games: r.games,
                url: r.url.as_deref(),
                as_of: Some(r.as_of.format("%Y-%m-%d").to_string()),
            });
        }
        self.real_games.as_ref().map(|r| StockReal {
            source: r.source,
            rate: r.win_rate_4p,
            games: r.games.max(0) as u64,
            url: Some(&r.url),
            as_of: r.fetched_at.clone(),
        })
    }

    /// The stock list as deck cards. A card Yama's data doesn't know has an empty id.
    pub(crate) fn stock_list(&self) -> anyhow::Result<Vec<crate::decks::DeckCard>> {
        let cards: Vec<crate::lab::PreconCard> = serde_json::from_str(&self.stock_cards)?;
        Ok(cards.into_iter().map(|c| crate::decks::DeckCard { oracle_id: c.oracle_id.unwrap_or_default(), name: c.name, qty: i64::from(c.qty), board: c.board }).collect())
    }

    /// Games-weighted win share over every list under the commander, across the sources that have one.
    pub(crate) fn commander_rate(&self) -> Option<f64> {
        let games: u64 = self.commander_games.iter().map(|f| f.games).sum();
        (games > 0).then(|| self.commander_games.iter().map(|f| f.rate * f.games as f64).sum::<f64>() / games as f64)
    }
}

#[derive(sqlx::FromRow)]
struct CatalogRow {
    id: String,
    name: String,
    set_code: String,
    set_name: Option<String>,
    released: Option<String>,
    color_identity: String,
    cards: String,
    source: String,
    imported_at: String,
    engine_support: Option<String>,
    playgroup: Option<String>,
    art_url: Option<String>,
    art_artist: Option<String>,
    art_card: Option<String>,
}

#[derive(Serialize)]
pub struct Catalog {
    pub publication: Option<Publication>,
    pub comparisons: Vec<Publication>,
    pub meta_cohort: usize,
    pub rating_v2: Option<v2::Info>,
    /// Every enabled real-game source with its credit, ranked by v2 or not.
    pub real_sources: Vec<v2::Source>,
    pub precons: Vec<Precon>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Card {
    pub name: String,
    pub qty: i64,
    pub board: String,
    pub type_line: Option<String>,
    pub image: Option<String>,
    pub scryfall_url: String,
}

#[derive(Serialize)]
pub struct Detail {
    pub publication: Option<Publication>,
    pub comparisons: Vec<Publication>,
    pub meta_cohort: usize,
    pub rating_v2: Option<v2::Info>,
    pub real_sources: Vec<v2::Source>,
    pub precon: Precon,
    pub cards: Vec<Card>,
}

#[derive(Deserialize, Default)]
pub struct Filters {
    #[serde(default)]
    pub q: String,
    #[serde(default)]
    pub c: String,
    #[serde(default)]
    pub m: String,
    #[serde(default)]
    pub y: String,
    #[serde(default)]
    pub set: String,
    #[serde(default)]
    pub s: String,
    #[serde(default)]
    pub page: usize,
}

impl Filters {
    fn apply(&self, rows: &mut Vec<Precon>) -> AppResult<()> {
        if self.q.len() > 200
            || self.c.len() > 5
            || self.y.len() > 4
            || self.set.len() > 12
            || self.s.len() > 20
            || self.m.len() > 20
        {
            return Err(AppError::bad("Precon filters are too long"));
        }
        let q = self.q.to_lowercase();
        let colors = self.c.to_ascii_uppercase();
        if !colors.chars().all(|c| "WUBRGC".contains(c))
            || (colors.contains('C') && colors != "C")
            || (!self.y.is_empty()
                && (self.y.len() != 4 || !self.y.bytes().all(|c| c.is_ascii_digit())))
        {
            return Err(AppError::bad(
                "Use WUBRG or C for colors and a four-digit year",
            ));
        }
        rows.retain(|p| {
            let id = &p.color_identity;
            let color_match = colors.is_empty()
                || if colors == "C" {
                    id.is_empty()
                } else {
                    match self.m.as_str() {
                        "exact" => {
                            id.chars().all(|c| colors.contains(c))
                                && colors.chars().all(|c| id.contains(c))
                        }
                        "within" => id.chars().all(|c| colors.contains(c)),
                        _ => colors.chars().all(|c| id.contains(c)),
                    }
                };
            color_match
                && (self.y.is_empty()
                    || p.released.as_ref().is_some_and(|d| d.starts_with(&self.y)))
                && (self.set.is_empty() || p.set_code.eq_ignore_ascii_case(&self.set))
                && (q.is_empty()
                    || format!(
                        "{} {} {} {}",
                        p.name,
                        p.commanders
                            .iter()
                            .chain(
                                p.upgradeability
                                    .alternatives
                                    .iter()
                                    .flat_map(|a| &a.commanders)
                            )
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(" "),
                        p.set_code,
                        p.set_name.as_deref().unwrap_or("")
                    )
                    .to_lowercase()
                    .contains(&q))
        });
        rows.sort_by(|a, b| {
            let ordering = match self.s.as_str() {
                "upgradeability" => b
                    .upgradeability
                    .package
                    .as_ref()
                    .map(|p| p.best_supported_score)
                    .unwrap_or(b.upgradeability.score)
                    .cmp(
                        &a.upgradeability
                            .package
                            .as_ref()
                            .map(|p| p.best_supported_score)
                            .unwrap_or(a.upgradeability.score),
                    ),
                "name" => a.name.cmp(&b.name),
                "year" => b.released.cmp(&a.released),
                // Highest first; decks without the figure after.
                "real" => b
                    .stock_real()
                    .map(|r| r.rate)
                    .partial_cmp(&a.stock_real().map(|r| r.rate))
                    .unwrap_or(std::cmp::Ordering::Equal),
                "commander" => b.commander_rate().partial_cmp(&a.commander_rate()).unwrap_or(std::cmp::Ordering::Equal),
                "power" => b.power.as_ref().map(|p| p.level).partial_cmp(&a.power.as_ref().map(|p| p.level)).unwrap_or(std::cmp::Ordering::Equal),
                "bracket" => b.power.as_ref().map(|p| p.bracket).cmp(&a.power.as_ref().map(|p| p.bracket)),
                "sealed" => a
                    .sealed_price
                    .as_ref()
                    .and_then(|p| p.usd)
                    .unwrap_or(f64::INFINITY)
                    .total_cmp(
                        &b.sealed_price
                            .as_ref()
                            .and_then(|p| p.usd)
                            .unwrap_or(f64::INFINITY),
                    ),
                "rank" => {
                    let rank = |p: &Precon| {
                        p.rating
                            .as_ref()
                            .filter(|r| r.confidence != "unreliable")
                            .and_then(|r| r.rank)
                            .unwrap_or(i64::MAX)
                    };
                    rank(a).cmp(&rank(b))
                }
                _ => {
                    // Rating v2 when a real-game source is enabled, then the v1 meta rank.
                    let key = |p: &Precon| {
                        (
                            p.v2.as_ref().map(|v| v.rank).unwrap_or(usize::MAX),
                            p.meta.as_ref().map(|m| m.rank).unwrap_or(usize::MAX),
                            if p.meta.is_none() {
                                p.rating
                                    .as_ref()
                                    .filter(|r| r.confidence != "unreliable")
                                    .and_then(|r| r.rank)
                                    .unwrap_or(i64::MAX)
                            } else {
                                0
                            },
                        )
                    };
                    key(a).cmp(&key(b))
                }
            };
            ordering
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(())
    }
}

fn date(s: &str) -> Option<String> {
    if chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
        || chrono::DateTime::parse_from_rfc3339(s).is_ok()
    {
        Some(s.to_string())
    } else {
        None
    }
}

fn source_url(value: &str, host: &str) -> Option<String> {
    let u = url::Url::parse(value).ok()?;
    (u.scheme() == "https"
        && u.host_str() == Some(host)
        && u.username().is_empty()
        && u.password().is_none()
        && u.port().is_none())
    .then(|| u.to_string())
}

fn list_hash(cards: &str) -> anyhow::Result<String> {
    let cards: Vec<crate::lab::PreconCard> = serde_json::from_str(cards)?;
    let mut rows: BTreeMap<(String, String), u32> = BTreeMap::new();
    for c in cards {
        ensure!(c.qty > 0, "stock list contains a zero quantity");
        let board = match c.board {
            crate::decks::Board::Commander => "commander",
            crate::decks::Board::Main => "main",
            crate::decks::Board::Side => "side",
        };
        *rows.entry((board.into(), c.name)).or_default() += c.qty;
    }
    let rows: Vec<_> = rows.into_iter().collect();
    Ok(sha256_hex(&serde_json::to_string(&rows)?))
}

async fn snapshot(pool: &SqlitePool) -> AppResult<Option<Snapshot>> {
    let text: Option<String> = sqlx::query_scalar("SELECT p.document FROM precon_publications p JOIN precon_publication_head h ON h.publication_id = p.id WHERE h.singleton = 1")
        .fetch_optional(pool).await?;
    text.map(|t| {
        serde_json::from_str(&t)
            .map_err(anyhow::Error::from)
            .map_err(AppError::from)
    })
    .transpose()
}

/// The catalog before rating v2 and the default order, which are cheap and keep their own freshness.
/// Building it prices every stock list, which is most of a page's time, so it is kept until its
/// inputs change (derived.rs).
#[derive(Clone)]
struct Built {
    publication: Option<Publication>,
    comparisons: Vec<Publication>,
    meta_cohort: usize,
    precons: Vec<Precon>,
}

static BUILT: crate::derived::Kept<Built> = crate::derived::Kept::new("public precons rebuild");

/// Cheap evidence of a change to anything [`build`] reads: the catalog rows, the published
/// snapshot, sealed prices, each price day read (prices/) and card data imports (names, art).
pub(crate) async fn fingerprint(pool: &SqlitePool) -> AppResult<String> {
    let inputs: String = sqlx::query_scalar(
        "SELECT (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT id || ':' || imported_at || ':' || length(cards) || ':' || IFNULL(length(engine_support), 0)
                    || ':' || IFNULL(length(playgroup), 0) || ':' || name || ':' || IFNULL(set_name, '') || ':' || IFNULL(released, '') || ':' || color_identity AS k FROM precons ORDER BY id))
             || '#' || IFNULL((SELECT publication_id FROM precon_publication_head WHERE singleton = 1), '')
             || '#' || (SELECT IFNULL(group_concat(k, '|'), '') FROM (SELECT precon_id || ':' || product_id || ':' || IFNULL(usd, '') || ':' || price_date AS k FROM sealed_deck_prices ORDER BY precon_id))
             || '#' || (SELECT IFNULL(max(observed_at), '') FROM price_observation)
             || '#' || (SELECT IFNULL(max(finished_at), '') FROM import_runs)",
    )
    .fetch_one(pool)
    .await?;
    Ok(format!("{}#{inputs}", pool.connect_options().get_filename().display()))
}

async fn built(pool: &SqlitePool) -> AppResult<Arc<Built>> {
    let key = fingerprint(pool).await?;
    BUILT.get(pool, key, |pool| async move { build(&pool).await }).await
}

/// Build the catalog and its rating now if their inputs changed (derived.rs).
pub async fn prewarm(pool: &SqlitePool) -> AppResult<()> {
    let key = fingerprint(pool).await?;
    BUILT.refresh(pool, key, |pool| async move { build(&pool).await }).await?;
    v2::prewarm(pool).await
}

pub async fn catalog(pool: &SqlitePool) -> AppResult<Catalog> {
    let Built { publication, comparisons, meta_cohort, mut precons } = (*built(pool).await?).clone();
    let (rating_v2, real_sources) = v2::assign(pool, &mut precons).await?;
    Filters::default().apply(&mut precons)?;
    Ok(Catalog {
        publication,
        comparisons,
        meta_cohort,
        rating_v2,
        real_sources,
        precons,
    })
}

async fn build(pool: &SqlitePool) -> AppResult<Built> {
    let snapshot = snapshot(pool).await?;
    let catalog: Vec<CatalogRow> = sqlx::query_as("SELECT p.id, p.name, p.set_code, p.set_name, p.released, p.color_identity, p.cards, p.source, p.imported_at, p.engine_support, p.playgroup, c.image_art_crop AS art_url, c.artist AS art_artist, c.name AS art_card FROM precons p LEFT JOIN cards c ON c.oracle_id = json_extract(p.cards, '$[0].oracle_id') ORDER BY p.id").fetch_all(pool).await?;
    // Price only the cards these lists hold, not every card Yama knows.
    let ids: BTreeSet<String> = catalog
        .iter()
        .filter_map(|p| serde_json::from_str::<Vec<crate::lab::PreconCard>>(&p.cards).ok())
        .flatten()
        .filter_map(|c| c.oracle_id)
        .collect();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let prices = crate::deck_prices::prices_for(pool, &ids).await?;
    let mut sealed = crate::deck_prices::sealed(pool).await?;
    let mut rows = Vec::new();
    for p in catalog {
        if !valid_slug(&p.id) {
            continue;
        }
        let cards = &p.cards;
        let stock: Vec<crate::lab::PreconCard> =
            serde_json::from_str(cards).map_err(anyhow::Error::from)?;
        let reference_matches = crate::upgradeability::allows_reference_results(&p.id, &stock);
        let published = snapshot.as_ref().and_then(|s| s.ratings.get(&p.id));
        let unchanged = published.is_some_and(|r| list_hash(cards).is_ok_and(|h| h == r.list_hash));
        let rating = published.filter(|_| unchanged).map(|r| r.rating.clone());
        let mut simulations = Vec::new();
        if let Some(s) = &snapshot {
            for source in std::iter::once(s).chain(s.comparisons.iter()) {
                if let Some(r) = source
                    .ratings
                    .get(&p.id)
                    .filter(|r| list_hash(cards).is_ok_and(|h| h == r.list_hash))
                {
                    simulations.push(Simulation {
                        publication_id: source.publication.id.clone(),
                        engine: source.publication.engine.clone(),
                        rating: r.rating.clone(),
                    });
                }
            }
        }
        let playgroup: Option<Value> = p
            .playgroup
            .as_deref()
            .filter(|_| reference_matches)
            .and_then(|v| serde_json::from_str(v).ok());
        let real_games = playgroup.as_ref().and_then(|v| {
            let rate = v
                .get("win_rate_4p")?
                .as_f64()
                .filter(|n| n.is_finite() && (0.0..=100.0).contains(n))?;
            let games = v.get("games")?.as_i64().filter(|n| *n > 0)?;
            Some(RealGames {
                win_rate_4p: rate,
                games,
                rank_in_catalog: v.get("rank").and_then(Value::as_i64).filter(|n| *n > 0),
                rated_catalog_decks: v.get("of").and_then(Value::as_i64).filter(|n| *n > 0),
                fetched_at: v.get("fetched").and_then(Value::as_str).and_then(date),
                source: "Playgroup.gg",
                url: v
                    .get("url")
                    .and_then(Value::as_str)
                    .and_then(|u| source_url(u, "playgroup.gg"))
                    .unwrap_or_else(|| "https://playgroup.gg/commander/precons".into()),
            })
        });
        let support: Value = p
            .engine_support
            .as_deref()
            .and_then(|t| serde_json::from_str(t).ok())
            .unwrap_or(Value::Null);
        let commanders = stock
            .iter()
            .filter(|c| c.board == crate::decks::Board::Commander)
            .map(|c| c.name.clone())
            .collect();
        let stock_names: BTreeSet<_> = stock.iter().map(|c| c.name.clone()).collect();
        let partly_supported = ["partly_unimplemented", "other_face_partly_unimplemented"]
            .into_iter()
            .flat_map(|k| {
                support
                    .get(k)
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
            .filter_map(Value::as_str)
            .filter(|n| stock_names.contains(*n))
            .map(str::to_string)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let art = match (p.art_url, p.art_artist, p.art_card) {
            (Some(url), Some(artist), Some(card))
                if source_url(&url, "cards.scryfall.io").is_some() =>
            {
                Some(crate::lab::Art {
                    url,
                    artist: Some(artist),
                    card,
                })
            }
            _ => None,
        };
        let sealed_price = sealed.remove(&p.id).map(|mut p| {
            p.source = "TCGplayer market via TCGCSV".into();
            p.url = format!("https://www.tcgplayer.com/product/{}", p.product_id);
            p
        });
        rows.push(Precon {
            power: None,
            upgradeability: crate::upgradeability::assess(&p.id, &stock),
            id: p.id,
            name: p.name,
            set_code: p.set_code,
            set_name: p.set_name,
            released: p.released.as_deref().and_then(date),
            commanders,
            color_identity: p.color_identity,
            card_count: stock.iter().map(|c| i64::from(c.qty)).sum(),
            art,
            singles_value: crate::deck_prices::singles(
                &serde_json::from_str(cards).map_err(anyhow::Error::from)?,
                &prices,
            ),
            sealed_price,
            real_games,
            rating,
            simulations,
            meta: None,
            v2: None,
            commander_games: Vec::new(),
            rating_status: if published.is_some() && !unchanged {
                "stock_list_changed"
            } else if published.is_none() {
                "not_rated"
            } else {
                "published"
            },
            catalog_updated_at: date(&p.imported_at),
            source_url: p
                .source
                .split_whitespace()
                .find_map(|part| source_url(part.trim_end_matches(','), "mtgjson.com")),
            partly_supported,
            stock_cards: p.cards,
        });
    }
    let comparisons = snapshot
        .as_ref()
        .map(|s| {
            s.comparisons
                .iter()
                .map(|s| s.publication.clone())
                .collect()
        })
        .unwrap_or_default();
    let source_count = snapshot
        .as_ref()
        .map(|s| 1 + s.comparisons.len())
        .unwrap_or(0);
    power::assign(pool, &mut rows).await?;
    let meta_cohort = consensus::assign(&mut rows, source_count);
    Ok(Built {
        publication: snapshot.map(|s| s.publication),
        comparisons,
        meta_cohort,
        precons: rows,
    })
}

async fn detail_data(pool: &SqlitePool, slug: &str) -> AppResult<Detail> {
    if !valid_slug(slug) {
        return Err(AppError::NotFound("precon"));
    }
    let c = catalog(pool).await?;
    let precon = c
        .precons
        .into_iter()
        .find(|p| p.id == slug)
        .ok_or(AppError::NotFound("precon"))?;
    let mut cards: Vec<Card> = sqlx::query_as(
        "SELECT json_extract(j.value, '$.name') AS name, json_extract(j.value, '$.qty') AS qty,
            json_extract(j.value, '$.board') AS board, c.type_line, c.image_normal AS image, '' AS scryfall_url
         FROM json_each(?) j LEFT JOIN cards c ON c.oracle_id = json_extract(j.value, '$.oracle_id')
         ORDER BY CASE json_extract(j.value, '$.board') WHEN 'commander' THEN 0 WHEN 'main' THEN 1 ELSE 2 END, name"
    ).bind(&precon.stock_cards).fetch_all(pool).await?;
    for card in &mut cards {
        card.image = card
            .image
            .take()
            .filter(|u| source_url(u, "cards.scryfall.io").is_some());
        let mut u = url::Url::parse("https://scryfall.com/search").expect("constant URL");
        u.query_pairs_mut()
            .append_pair("q", &format!("!\"{}\"", card.name.replace('"', "")));
        card.scryfall_url = u.into();
    }
    Ok(Detail {
        publication: c.publication,
        comparisons: c.comparisons,
        meta_cohort: c.meta_cohort,
        rating_v2: c.rating_v2,
        real_sources: c.real_sources,
        precon,
        cards,
    })
}

pub(crate) fn limit(st: &AppState, address: ClientAddress) -> AppResult<()> {
    st.limits.public_precons.check(&address_key(address.0))
}

/// ETag and public caching apply to these account-independent bodies only. Errors are never cached.
pub(crate) fn cached(headers: &HeaderMap, body: String, content_type: &'static str) -> Response {
    let etag = format!("\"{}\"", sha256_hex(&body));
    let unchanged = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .any(|t| t.trim() == etag || t.trim() == format!("W/{etag}") || t.trim() == "*")
        });
    let mut response = if unchanged {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        body.into_response()
    };
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=60, must-revalidate"),
    );
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&etag).expect("hex etag"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn api_list(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Query(filters): Query<Filters>,
) -> AppResult<Response> {
    limit(&st, address)?;
    let mut data = catalog(&st.pool).await?;
    filters.apply(&mut data.precons)?;
    Ok(cached(
        &headers,
        serde_json::to_string(&data).map_err(anyhow::Error::from)?,
        "application/json; charset=utf-8",
    ))
}

async fn api_detail(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> AppResult<Response> {
    limit(&st, address)?;
    Ok(cached(
        &headers,
        serde_json::to_string(&detail_data(&st.pool, &slug).await?).map_err(anyhow::Error::from)?,
        "application/json; charset=utf-8",
    ))
}

fn deck_text(detail: &Detail) -> String {
    let mut text = String::new();
    for (board, label) in [
        ("commander", "Commander"),
        ("main", "Deck"),
        ("side", "Sideboard"),
    ] {
        let cards: Vec<_> = detail.cards.iter().filter(|c| c.board == board).collect();
        if cards.is_empty() {
            continue;
        }
        text.push_str(&format!("{label}\n"));
        for card in cards {
            text.push_str(&format!("{} {}\n", card.qty, card.name));
        }
        text.push('\n');
    }
    text
}

async fn download(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> AppResult<Response> {
    limit(&st, address)?;
    let data = detail_data(&st.pool, &slug).await?;
    let mut res = cached(&headers, deck_text(&data), "text/plain; charset=utf-8");
    res.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{slug}.txt\""))
            .expect("validated slug"),
    );
    Ok(res)
}

async fn download_variant(
    State(st): State<AppState>,
    address: ClientAddress,
    headers: HeaderMap,
    Path((slug, variant)): Path<(String, String)>,
) -> AppResult<Response> {
    limit(&st, address)?;
    if !valid_slug(&slug) || !valid_slug(&variant) {
        return Err(AppError::NotFound("commander comparison list"));
    }
    let text: Option<String> = sqlx::query_scalar("SELECT cards FROM precons WHERE id=?")
        .bind(&slug)
        .fetch_optional(&st.pool)
        .await?;
    let cards: Vec<crate::lab::PreconCard> =
        serde_json::from_str(&text.ok_or(AppError::NotFound("precon"))?)
            .map_err(anyhow::Error::from)?;
    let body = crate::upgradeability::variant_deck(&slug, &variant, &cards)
        .ok_or(AppError::NotFound("commander comparison list"))?;
    let mut res = cached(&headers, body, "text/plain; charset=utf-8");
    res.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{slug}--{variant}.txt\""))
            .expect("validated slugs"),
    );
    Ok(res)
}

/// Reviewed labels are deliberately separate from untrusted free text in imported summaries.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    run_id: String,
    stock_index: String,
    title: String,
    engine: String,
    card_data: String,
    runner: String,
    difficulty: String,
    #[serde(default)]
    notes: Vec<String>,
    #[serde(default)]
    reasons: BTreeMap<String, Vec<String>>,
    /// Other reviewed source manifests, validated atomically with the primary source.
    #[serde(default)]
    comparisons: Vec<String>,
}

pub async fn publish_file(pool: &SqlitePool, file: &FilePath) -> anyhow::Result<String> {
    let raw = std::fs::read_to_string(file).context("reading publication manifest")?;
    ensure!(raw.len() <= 256 * 1024, "publication manifest is too large");
    let manifest: Manifest =
        serde_json::from_str(&raw).context("reading publication manifest fields")?;
    publish(pool, manifest, file.parent().unwrap_or(FilePath::new("."))).await
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}
fn rate(v: &Value) -> Option<f64> {
    number(v).filter(|n| (0.0..=1.0).contains(n))
}
fn interval(v: &Value, probability: bool) -> Option<[f64; 2]> {
    let get = |v: &Value| if probability { rate(v) } else { number(v) };
    let out = [get(&v[0])?, get(&v[1])?];
    (out[0] <= out[1]).then_some(out)
}

async fn publish(pool: &SqlitePool, mut m: Manifest, base: &FilePath) -> anyhow::Result<String> {
    ensure!(
        m.comparisons.len() <= 1,
        "publish at most one run per engine (Phase and Forge)"
    );
    let comparisons = std::mem::take(&mut m.comparisons);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut snapshot = build_snapshot(&mut tx, m, base).await?;
    ensure!(
        comparisons.is_empty() || consensus::engine_family(&snapshot.publication.engine) != "Other",
        "multi-engine publication supports Phase and Forge"
    );
    let mut families = BTreeSet::new();
    families.insert(consensus::engine_family(&snapshot.publication.engine));
    for path in comparisons {
        let path = base.join(path);
        let raw = std::fs::read_to_string(&path).context("reading comparison manifest")?;
        ensure!(raw.len() <= 256 * 1024, "comparison manifest is too large");
        let m: Manifest = serde_json::from_str(&raw)?;
        ensure!(
            m.comparisons.is_empty(),
            "nested comparison manifests are not supported"
        );
        let other = build_snapshot(&mut tx, m, path.parent().unwrap_or(base)).await?;
        let family = consensus::engine_family(&other.publication.engine);
        ensure!(
            family != "Other" && families.insert(family),
            "use one reviewed run per independent engine family"
        );
        snapshot.comparisons.push(other);
    }
    let id = snapshot.publication.id.clone();
    let document = serde_json::to_string(&snapshot)?;
    sqlx::query("INSERT INTO precon_publications(id, published_at, content_sha256, document) VALUES (?,?,?,?)")
        .bind(&id).bind(&snapshot.publication.published_at).bind(sha256_hex(&document)).bind(document).execute(&mut *tx).await?;
    sqlx::query("UPDATE precon_publication_head SET publication_id = ? WHERE singleton = 1")
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(id)
}

async fn build_snapshot(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    m: Manifest,
    base: &FilePath,
) -> anyhow::Result<Snapshot> {
    for label in [&m.title, &m.engine, &m.card_data, &m.runner, &m.difficulty] {
        ensure!(
            !label.trim().is_empty() && label.len() <= 300 && !label.chars().any(char::is_control),
            "reviewed publication labels must be nonempty text up to 300 bytes"
        );
    }
    ensure!(
        m.notes.len() <= 30 && m.reasons.values().all(|v| v.len() <= 20),
        "too many publication notes"
    );
    ensure!(
        m.notes
            .iter()
            .chain(m.reasons.values().flatten())
            .all(|s| s.len() <= 2000),
        "publication note is too long"
    );
    let index_path = base.join(&m.stock_index);
    let index: Value = serde_json::from_str(
        &std::fs::read_to_string(&index_path).context("reading the run's original stock index")?,
    )?;
    let index_rows = index["decks"]
        .as_array()
        .context("stock index needs decks")?;
    let root = index_path.parent().context("stock index has no parent")?;
    let (owner, kind, engine, data, runner, difficulty, analysed, raw): (Option<String>, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, String) =
        sqlx::query_as("SELECT owner_id, kind, engine, card_data, runner, difficulty, analysed_at, summary FROM lab_runs WHERE id = ?")
        .bind(&m.run_id).fetch_one(&mut **tx).await.context("finding imported run")?;
    ensure!(
        owner.is_none() && kind == "precon-ratings",
        "only a global stock-precon rating run can be published; owned and paired runs stay private"
    );
    ensure!(
        engine.as_deref() == Some(m.engine.as_str())
            && data.as_deref() == Some(m.card_data.as_str())
            && runner.as_deref() == Some(m.runner.as_str())
            && difficulty.as_deref() == Some(m.difficulty.as_str()),
        "reviewed engine, card_data, runner and difficulty labels must exactly match the imported run"
    );
    let summary: Value = serde_json::from_str(&raw)?;
    ensure!(
        summary["paired"].is_null() && summary["run_meta"]["pod"].as_i64() == Some(4),
        "publish a four-player stock-precon benchmark, not a paired or mixed experiment"
    );
    ensure!(
        summary["inputs"]["index"].as_str().is_some()
            && summary["inputs"]["index"] == index["generated"],
        "stock index date must match the run's original index; legacy runs without provenance need reanalysis"
    );
    ensure!(
        matches!(
            summary["analysis"]["model"].as_str(),
            Some(MODEL) | Some("Plackett-Luce")
        ),
        "this public method supports Plackett-Luce analyses only"
    );
    ensure!(
        summary["analysis"]["time_caps_scored"].as_bool() == Some(false)
            && summary["analysis"]["drop_capped"].as_bool() == Some(false),
        "public scoring requires time caps unscored and turn/action caps retained as no winner"
    );
    ensure!(
        summary["analysis"]["bootstrap"]["cluster"].as_str() == Some("game"),
        "public rank intervals require the game-cluster bootstrap method"
    );
    ensure!(
        summary["counts"]["by_pod_size"]
            .as_object()
            .is_some_and(|pods| pods.len() == 1 && pods.contains_key("4")),
        "publish a benchmark containing four-player games only"
    );
    for k in [
        "pending",
        "not_in_schedule",
        "deck_mismatch_with_schedule",
        "conflicting_duplicates",
    ] {
        ensure!(
            summary["counts"][k].as_i64().unwrap_or(0) == 0,
            "run is incomplete or has inconsistent results ({k})"
        );
    }
    for k in ["engine", "card_data", "runner"] {
        ensure!(
            summary["versions"][k]
                .as_object()
                .is_some_and(|v| v.len() == 1),
            "a public benchmark must use one {k} version"
        );
    }
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, lab_id, cards FROM precons")
            .fetch_all(&mut **tx)
            .await?;
    let catalog: BTreeMap<_, _> = rows
        .into_iter()
        .map(|(id, lab, cards)| (lab, (id, cards)))
        .collect();
    let decks = summary["decks"]
        .as_array()
        .context("run has no rated decks")?;
    ensure!(!decks.is_empty(), "run has no rated decks");
    let ids: BTreeSet<_> = decks.iter().filter_map(|d| d["id"].as_str()).collect();
    ensure!(
        ids.len() == decks.len() && ids.iter().all(|id| catalog.contains_key(*id)),
        "every entrant must be a distinct current catalog precon"
    );
    if let Some(matrix) = summary["matrix"]["ids"].as_array() {
        let field: BTreeSet<_> = matrix.iter().filter_map(Value::as_str).collect();
        ensure!(
            field == ids && field.len() == matrix.len(),
            "model field must contain exactly the rated stock precons; filtering a private field is not publication"
        );
    }
    for key in ["ids", "exclude"] {
        if let Some(refs) = summary["run_meta"]["filter"][key].as_array() {
            ensure!(
                refs.iter()
                    .all(|v| v.as_str().is_some_and(|id| catalog.contains_key(id))),
                "run filter contains a non-catalog deck"
            );
        }
    }
    let level = rate(&summary["analysis"]["bootstrap"]["level"])
        .filter(|n| *n > 0.0 && *n < 1.0)
        .context("run needs an interval level")?;
    let mut ratings = BTreeMap::new();
    for d in decks {
        let lab_id = d["id"].as_str().context("deck id")?;
        let (slug, cards) = &catalog[lab_id];
        ensure!(
            valid_slug(slug) && d["kind"].as_str() == Some("precon"),
            "every rated entry must be a stock precon"
        );
        let entry = index_rows
            .iter()
            .find(|r| r["id"].as_str() == Some(lab_id) && r["kind"].as_str() == Some("precon"))
            .context("rated precon missing from original stock index")?;
        let id_path = FilePath::new(lab_id);
        ensure!(
            id_path
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_))),
            "unsafe deck path in stock index"
        );
        let file = yama_play::lab::parse_deck(&std::fs::read_to_string(
            root.join(format!("{lab_id}.txt")),
        )?)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
        let frozen: Vec<Value> = [("commander", file.commander), ("main", file.main)].into_iter().flat_map(|(board, rows)| rows.into_iter().map(move |(qty, name)| serde_json::json!({"name": name, "qty": qty, "board": board, "oracle_id": null}))).collect();
        let hash = list_hash(cards)?;
        ensure!(
            list_hash(&serde_json::to_string(&frozen)?)? == hash,
            "{slug}: current stock list differs from the run's original list"
        );
        let cards_value: Value = serde_json::from_str(cards)?;
        ensure!(
            cards_value
                .as_array()
                .context("stock cards")?
                .iter()
                .filter_map(|c| c["qty"].as_u64())
                .sum::<u64>()
                == 100,
            "{slug}: stock list must have 100 cards"
        );
        ensure!(
            d["commanders"] == entry["commanders"],
            "{slug}: run and stock index use different commanders"
        );
        let confidence = match d["confidence"]["level"].as_str() {
            Some("ok") => "ok",
            Some("doubtful") => "doubtful",
            Some("unreliable") => "unreliable",
            _ => "unreviewed",
        };
        let reasons = m.reasons.get(slug).cloned().unwrap_or_else(|| match confidence {
            "unreliable" => vec!["Known engine/AI limitations or disagreement with real games make this simulation unreliable for this deck.".into()],
            "doubtful" => vec!["The analysis flags engine/AI limitations or disagreement with real games for this deck.".into()],
            "unreviewed" => vec!["This run has no deck-specific simulation confidence assessment.".into()],
            _ => vec![],
        });
        let rank = d["rank"]
            .as_i64()
            .filter(|n| *n > 0 && *n <= decks.len() as i64);
        let games = d["games"].as_i64().context("deck needs game count")?;
        ensure!(games >= 0, "negative game count");
        let rank_interval = interval(&d["rank_ci"], false)
            .map(|v| [v[0].round() as i64, v[1].round() as i64])
            .filter(|v| v[0] > 0 && v[1] <= decks.len() as i64);
        ratings.insert(
            slug.clone(),
            RatedList {
                list_hash: hash,
                rating: Rating {
                    games,
                    rank,
                    rank_interval,
                    strength: number(&d["strength"]).filter(|n| *n > 0.0),
                    strength_interval: interval(&d["strength_ci"], false),
                    model_win_rate: rate(&d["p4_field"]),
                    model_interval: interval(&d["p4_field_ci"], true),
                    observed_win_rate: rate(&d["main"]["win_rate"]),
                    observed_interval: interval(&d["main"]["wilson"], true),
                    confidence: confidence.into(),
                    reasons,
                },
            },
        );
    }
    ensure!(
        m.reasons.keys().all(|id| ratings.contains_key(id)),
        "reviewed confidence notes refer to an unrated deck"
    );
    let games = summary["counts"]["games_in_model"]
        .as_i64()
        .filter(|n| *n > 0)
        .context("run has no scored games")?;
    let id = new_id();
    let publication = Publication {
        id: id.clone(),
        published_at: now(),
        title: m.title,
        method: METHOD.into(),
        engine: m.engine,
        card_data: m.card_data,
        runner: m.runner,
        difficulty: m.difficulty,
        analysed_at: analysed
            .as_deref()
            .and_then(date)
            .context("run needs a valid analysis date")?,
        interval_level: level,
        field_size: ratings.len(),
        scored_games: games,
        failed_games: summary["counts"]["failed_games"]
            .as_i64()
            .unwrap_or(0)
            .max(0),
        time_caps: summary["counts"]["unscored_time_caps"]
            .as_i64()
            .unwrap_or(0)
            .max(0),
        no_winner: ["draw", "turn_cap", "action_cap"]
            .iter()
            .filter_map(|k| summary["counts"]["by_end"][k].as_i64())
            .map(|n| n.max(0))
            .sum(),
        notes: m.notes,
    };
    Ok(Snapshot {
        publication,
        ratings,
        comparisons: Vec::new(),
    })
}

pub async fn withdraw(pool: &SqlitePool) -> anyhow::Result<()> {
    sqlx::query("UPDATE precon_publication_head SET publication_id = NULL WHERE singleton = 1")
        .execute(pool)
        .await?;
    Ok(())
}
