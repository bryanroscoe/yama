//! List replacement values and separately identified sealed products. No seller/stock claims.
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;

#[derive(Debug, Clone, Default, Serialize)]
pub struct SinglesValue {
    pub usd: Option<f64>,
    pub priced_copies: i64,
    pub unpriced_copies: i64,
    pub oldest_date: Option<String>,
    pub newest_date: Option<String>,
    pub source: &'static str,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct SealedPrice {
    pub product_id: i64,
    pub product_name: String,
    pub usd: Option<f64>,
    pub price_date: String,
    pub source: String,
    pub url: String,
}

#[derive(Deserialize)]
struct Line {
    oracle_id: Option<String>,
    qty: i64,
    board: String,
}

pub type Prices = HashMap<String, (f64, String)>;

// Match the planner's paper-printing eligibility and freshness rule. The date belongs to the
// selected price, never MAX(date) from an unrelated (possibly unpriced) printing.
pub async fn prices(pool: &SqlitePool) -> AppResult<Prices> {
    let rows: Vec<(String, f64, String)> = sqlx::query_as(
        "WITH cur AS MATERIALIZED (
           SELECT p.oracle_id, ps.usd, ps.date, p.scryfall_id FROM printings p
           JOIN price_snapshots ps ON ps.scryfall_id = p.scryfall_id
            AND ps.date = (SELECT MAX(date) FROM price_snapshots WHERE scryfall_id = p.scryfall_id)
           WHERE p.set_code NOT IN ('wc97','wc98','wc99','wc00','wc01','wc02','wc03','wc04','ptc','ced','cei','30a','olgc','ovnt')
            AND p.set_name NOT LIKE '%Oversized%' AND p.set_name NOT LIKE '%Display Commanders%'
         ), fresh AS (SELECT oracle_id, MAX(date) AS newest FROM cur GROUP BY oracle_id),
         ranked AS (
           SELECT cur.*, ROW_NUMBER() OVER (PARTITION BY cur.oracle_id ORDER BY usd, date DESC, scryfall_id) AS rn
           FROM cur JOIN fresh USING (oracle_id)
           WHERE usd IS NOT NULL AND usd >= 0 AND date >= date(fresh.newest, '-3 days')
         ) SELECT oracle_id, usd, date FROM ranked WHERE rn = 1"
    ).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(|(id, usd, date)| (id, (usd, date)))
        .collect())
}

pub fn singles(cards: &Value, prices: &Prices) -> SinglesValue {
    let mut result = SinglesValue {
        source: "TCGplayer market via Scryfall",
        ..Default::default()
    };
    let mut total = 0.0;
    if let Ok(lines) = serde_json::from_value::<Vec<Line>>(cards.clone()) {
        for c in lines.into_iter().filter(|c| c.board != "side" && c.qty > 0) {
            match c.oracle_id.as_ref().and_then(|id| prices.get(id)) {
                Some((usd, date)) => {
                    result.priced_copies += c.qty;
                    total += usd * c.qty as f64;
                    if result.oldest_date.as_ref().is_none_or(|d| date < d) {
                        result.oldest_date = Some(date.clone());
                    }
                    if result.newest_date.as_ref().is_none_or(|d| date > d) {
                        result.newest_date = Some(date.clone());
                    }
                }
                None => result.unpriced_copies += c.qty,
            }
        }
    }
    if result.priced_copies > 0 {
        result.usd = Some((total * 100.0).round() / 100.0);
    }
    result
}

pub async fn sealed(pool: &SqlitePool) -> AppResult<HashMap<String, SealedPrice>> {
    let rows: Vec<(String, i64, String, Option<f64>, String, String, String)> = sqlx::query_as(
        "SELECT precon_id, product_id, product_name, usd, price_date, source, url FROM sealed_deck_prices"
    ).fetch_all(pool).await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, product_id, product_name, usd, price_date, source, url)| {
                (
                    id,
                    SealedPrice {
                        product_id,
                        product_name,
                        usd,
                        price_date,
                        source,
                        url,
                    },
                )
            },
        )
        .collect())
}

// Require a single exact stock-deck reference. Bundles, cases and collector editions must
// never inherit the standard deck's price. Ambiguous products stay unpriced.
fn product_for<'a>(set: &'a Value, code: &str, name: &str) -> Option<&'a Value> {
    let products: Vec<_> = set["sealedProduct"]
        .as_array()?
        .iter()
        .filter(|p| {
            p["category"].as_str() == Some("deck")
                && !p["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains("collector")
                && !p["name"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains("minimal packaging")
                && p["contents"]["deck"].as_array().is_some_and(|decks| {
                    decks.len() == 1
                        && decks[0]["name"]
                            .as_str()
                            .is_some_and(|n| n.eq_ignore_ascii_case(name))
                        && decks[0]["set"]
                            .as_str()
                            .is_some_and(|s| s.eq_ignore_ascii_case(code))
                        && decks[0]["count"].as_i64().unwrap_or(1) == 1
                })
        })
        .collect();
    if products.len() == 1 {
        Some(products[0])
    } else {
        None
    }
}

async fn fetch(http: &reqwest::Client, url: &str) -> anyhow::Result<Value> {
    Ok(http
        .get(url)
        .timeout(std::time::Duration::from_secs(90))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

pub async fn refresh(pool: &SqlitePool, http: &reqwest::Client) -> anyhow::Result<()> {
    refresh_from(
        pool,
        http,
        "https://tcgcsv.com",
        "https://mtgjson.com/api/v5/SetList.json",
    )
    .await
}

async fn refresh_from(
    pool: &SqlitePool,
    http: &reqwest::Client,
    tcgcsv: &str,
    set_list: &str,
) -> anyhow::Result<()> {
    // Enforce the provider's daily cache policy across process restarts and manual imports.
    let recent: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM deck_price_imports WHERE id = 'sealed' AND checked_at > datetime('now', '-24 hours'))")
        .fetch_one(pool).await?;
    if recent {
        return Ok(());
    }
    let decks: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, set_code, name FROM precons")
            .fetch_all(pool)
            .await?;
    if decks.is_empty() {
        return Ok(());
    }
    let stamp = http
        .get(format!("{tcgcsv}/last-updated.txt"))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let date = stamp
        .trim()
        .get(..10)
        .filter(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok())
        .ok_or_else(|| anyhow::anyhow!("invalid TCGCSV date"))?;
    let previous: Option<String> =
        sqlx::query_scalar("SELECT source_updated_at FROM deck_price_imports WHERE id = 'sealed'")
            .fetch_optional(pool)
            .await?;
    if previous.as_deref() == Some(stamp.trim()) {
        sqlx::query(
            "UPDATE deck_price_imports SET checked_at = datetime('now') WHERE id = 'sealed'",
        )
        .execute(pool)
        .await?;
        return Ok(());
    }
    let sets = fetch(http, set_list).await?;
    let sets = sets["data"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalid MTGJSON SetList"))?;
    let mut groups: HashMap<i64, Value> = HashMap::new();
    let mut rows = Vec::new();
    for (id, code, name) in decks {
        let Some(set) = sets.iter().find(|s| {
            s["code"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case(&code))
        }) else {
            continue;
        };
        let Some(product) = product_for(set, &code, &name) else {
            continue;
        };
        let Some(product_id) = product["identifiers"]["tcgplayerProductId"]
            .as_str()
            .and_then(|s| s.parse::<i64>().ok())
        else {
            continue;
        };
        let Some(group) = set["tcgplayerGroupId"].as_i64() else {
            continue;
        };
        if !groups.contains_key(&group) {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let data = fetch(http, &format!("{tcgcsv}/tcgplayer/1/{group}/prices")).await?;
            anyhow::ensure!(
                data["success"] == true && data["results"].is_array(),
                "invalid TCGCSV response for {group}"
            );
            groups.insert(group, data);
        }
        let matches: Vec<_> = groups[&group]["results"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| {
                p["productId"].as_i64() == Some(product_id)
                    && p["subTypeName"].as_str() == Some("Normal")
            })
            .collect();
        let usd = if matches.len() == 1 {
            matches[0]["marketPrice"]
                .as_f64()
                .filter(|p| p.is_finite() && *p >= 0.0)
        } else {
            None
        };
        rows.push((
            id,
            product_id,
            product["name"].as_str().unwrap_or(&name).to_owned(),
            usd,
        ));
    }
    let mut tx = pool.begin().await?;
    // A successful refresh clears mappings that disappeared or became ambiguous.
    sqlx::query("DELETE FROM sealed_deck_prices")
        .execute(&mut *tx)
        .await?;
    for (id, product, name, usd) in rows {
        sqlx::query("INSERT INTO sealed_deck_prices (precon_id, product_id, product_name, usd, price_date, source, url) VALUES (?, ?, ?, ?, ?, 'TCGplayer market via TCGCSV', ?)")
            .bind(id).bind(product).bind(name).bind(usd).bind(date).bind(format!("https://www.tcgplayer.com/product/{product}"))
            .execute(&mut *tx).await?;
    }
    sqlx::query("INSERT OR REPLACE INTO deck_price_imports (id, checked_at, source_updated_at) VALUES ('sealed', datetime('now'), ?)").bind(stamp.trim()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub fn spawn_scheduler(pool: SqlitePool, http: reqwest::Client) {
    tokio::spawn(async move {
        loop {
            if let Err(e) = refresh(&pool, &http).await {
                tracing::warn!(error = %e, "sealed deck price import failed");
            }
            tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn list_value_counts_copies_and_missing_without_sideboards() {
        let prices = HashMap::from([
            ("ring".into(), (1.25, "2026-10-26".into())),
            ("basic".into(), (0.10, "2026-10-25".into())),
        ]);
        let v = singles(
            &json!([
                {"oracle_id":"ring", "qty":1, "board":"commander"},
                {"oracle_id":"basic", "qty":30, "board":"main"},
                {"oracle_id":null, "qty":2, "board":"main"},
                {"oracle_id":"ring", "qty":4, "board":"side"}
            ]),
            &prices,
        );
        assert_eq!(v.usd, Some(4.25));
        assert_eq!((v.priced_copies, v.unpriced_copies), (31, 2));
        assert_eq!(v.oldest_date.as_deref(), Some("2026-10-25"));
        assert_eq!(v.newest_date.as_deref(), Some("2026-10-26"));
        let unknown = singles(
            &json!([{"oracle_id":null,"qty":100,"board":"main"}]),
            &prices,
        );
        assert_eq!(unknown.usd, None);
        assert_eq!(unknown.unpriced_copies, 100);
        assert_eq!(singles(&json!([]), &prices).usd, None);
    }

    #[test]
    fn sealed_mapping_rejects_bundles_collectors_wrong_sets_and_ambiguity() {
        let product = json!({"name":"Commander Deck Riders of Rohan", "category":"deck", "contents":{"deck":[{"name":"Riders of Rohan","set":"ltc"}]}});
        assert!(
            product_for(
                &json!({"sealedProduct":[product.clone()]}),
                "LTC",
                "Riders of Rohan"
            )
            .is_some()
        );
        let mut bundle = product.clone();
        bundle["category"] = json!("bundle");
        let mut collector = product.clone();
        collector["name"] = json!("Riders of Rohan Collector Edition");
        assert!(
            product_for(
                &json!({"sealedProduct":[bundle, collector]}),
                "LTC",
                "Riders of Rohan"
            )
            .is_none()
        );
        assert!(
            product_for(
                &json!({"sealedProduct":[product.clone()]}),
                "CMD",
                "Riders of Rohan"
            )
            .is_none()
        );
        assert!(
            product_for(
                &json!({"sealedProduct":[product.clone(), product]}),
                "LTC",
                "Riders of Rohan"
            )
            .is_none()
        );
    }

    #[tokio::test]
    async fn saved_deck_prices_are_consistent_and_private() {
        use crate::decks::{Board, DeckCard};
        use axum::http::{Method, StatusCode};
        let (app, pool) = crate::testutil::app().await;
        let (owner, token) = crate::testutil::user(&pool, "owner@example.com").await;
        let (_, other) = crate::testutil::user(&pool, "other@example.com").await;
        let id = crate::decks::create_deck_with_cards(
            &pool,
            &owner,
            "My deck",
            None,
            vec![
                DeckCard {
                    oracle_id: "a".into(),
                    name: "Commander".into(),
                    qty: 1,
                    board: Board::Commander,
                },
                DeckCard {
                    oracle_id: "unknown".into(),
                    name: "Unknown".into(),
                    qty: 99,
                    board: Board::Main,
                },
                DeckCard {
                    oracle_id: "a".into(),
                    name: "Commander".into(),
                    qty: 4,
                    board: Board::Side,
                },
            ],
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES ('p', 'a', 'Commander', 'cmd', 'Commander', '1', 'en', '2026-10-27')").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES ('p', '2026-10-26', 2.5)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let (status, list) =
            crate::testutil::send(&app, Method::GET, "/api/decks", Some(&token), None).await;
        assert_eq!(status, StatusCode::OK);
        let (status, detail) = crate::testutil::send(
            &app,
            Method::GET,
            &format!("/api/decks/{id}"),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(list[0]["singles_value"], detail["singles_value"]);
        assert_eq!(detail["singles_value"]["usd"], 2.5);
        assert_eq!(detail["singles_value"]["unpriced_copies"], 99);
        let (status, _) = crate::testutil::send(
            &app,
            Method::GET,
            &format!("/api/decks/{id}"),
            Some(&other),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (_, list) =
            crate::testutil::send(&app, Method::GET, "/api/decks", Some(&other), None).await;
        assert_eq!(list, json!([]));
    }

    #[tokio::test]
    async fn market_uses_eligible_recent_printing_and_its_own_date() {
        let pool = crate::db::test_pool().await;
        sqlx::query("INSERT INTO cards (oracle_id, name, layout, color_identity, colors, cmc, updated_at) VALUES ('a','A','normal','','',0,'2026-10-27')").execute(&pool).await.unwrap();
        for (id, set, date, usd) in [
            ("gold", "wc99", "2026-10-27", Some(0.01)),
            ("stale", "cmd", "2026-09-01", Some(0.02)),
            ("valid", "cmd", "2026-10-25", Some(1.25)),
            ("newest", "cmd", "2026-10-27", Some(2.0)),
            ("missing", "cmd", "2026-10-27", None),
        ] {
            sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES (?, 'a', 'A', ?, 'Set', '1', 'en', '2026-10-27')")
                .bind(id).bind(set).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES (?, ?, ?)")
                .bind(id)
                .bind(date)
                .bind(usd)
                .execute(&pool)
                .await
                .unwrap();
        }
        let market = prices(&pool).await.unwrap();
        assert_eq!(market.get("a"), Some(&(1.25, "2026-10-25".into())));
    }
}

#[cfg(test)]
mod import_tests {
    use super::*;
    use axum::{Json, Router, routing::get};
    use serde_json::json;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[tokio::test]
    async fn sealed_import_is_cached_and_atomic_and_apis_expose_both_values() {
        let pool = crate::db::test_pool().await;
        sqlx::query("INSERT INTO precons (id, lab_id, name, set_code, commanders, cards, source, content_sha256, imported_at) VALUES ('rohan','precons/rohan','Riders of Rohan','LTC','[]', ?, 'fixture','hash','2026-10-27')")
            .bind(json!([{"name":"Unknown", "oracle_id":null,"qty":100,"board":"main"}]).to_string()).execute(&pool).await.unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let app = Router::new()
            .route("/last-updated.txt", get(|| async { "2026-10-26T20:05:56+0000" }))
            .route("/sets", get(|| async { Json(json!({"data":[{"code":"LTC","tcgplayerGroupId":23071,"sealedProduct":[
                {"name":"Commander Deck Riders of Rohan", "category":"deck", "contents":{"deck":[{"name":"Riders of Rohan","set":"ltc"}]}, "identifiers":{"tcgplayerProductId":"488296"}},
                {"name":"Commander Deck Riders of Rohan Minimal Packaging", "category":"deck", "contents":{"deck":[{"name":"Riders of Rohan","set":"ltc"}]}, "identifiers":{"tcgplayerProductId":"999"}}
            ]}]})) }))
            .route("/tcgplayer/1/23071/prices", get(move || { let n = n.clone(); async move {
                if n.fetch_add(1, Ordering::SeqCst) == 0 {
                    Json(json!({"success":true,"results":[{"productId":488296,"marketPrice":81.13,"subTypeName":"Normal"}]}))
                } else { Json(json!({"success":false,"results":[]})) }
            }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let http = crate::routes::http_client();
        refresh_from(&pool, &http, &base, &format!("{base}/sets"))
            .await
            .unwrap();
        let first = sealed(&pool).await.unwrap();
        assert_eq!(first["rohan"].usd, Some(81.13));
        assert_eq!(first["rohan"].product_id, 488296);
        assert_eq!(first["rohan"].price_date, "2026-10-26");
        refresh_from(&pool, &http, &base, &format!("{base}/sets"))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // An old local check but unchanged provider timestamp also avoids downloading groups.
        sqlx::query("UPDATE deck_price_imports SET checked_at = '2000-01-01'")
            .execute(&pool)
            .await
            .unwrap();
        refresh_from(&pool, &http, &base, &format!("{base}/sets"))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Failure part-way through a new build preserves the previous dated snapshot.
        sqlx::query(
            "UPDATE deck_price_imports SET checked_at = '2000-01-01', source_updated_at = 'old'",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(
            refresh_from(&pool, &http, &base, &format!("{base}/sets"))
                .await
                .is_err()
        );
        assert_eq!(sealed(&pool).await.unwrap()["rohan"].usd, Some(81.13));
        let list = crate::lab::precon_list(&pool).await.unwrap();
        let detail = crate::lab::precon_detail(&pool, "rohan").await.unwrap();
        for item in [&list.precons[0], &detail.precon] {
            assert_eq!(item.singles_value.usd, None);
            assert_eq!(item.singles_value.unpriced_copies, 100);
            assert_eq!(item.sealed_price.as_ref().unwrap().usd, Some(81.13));
        }
        server.abort();
    }
}
