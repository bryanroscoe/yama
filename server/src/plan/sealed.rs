//! Sealed precons at stores (docs/shopping-design.md, "Sealed precons", slice 4). A sealed product
//! on the shopping list (`wants.rs`, kind "sealed") is matched to a precon by name when Yama knows
//! one, and shown with:
//!
//! - each store's newest dated price (a sealed quote typed in Yama: never a purchase or proof of
//!   stock now), judged by the sealed cap in force today (`sealed_max_usd`, $51 a deck for Bryan);
//! - the sealed market (`deck_prices::sealed`, TCGplayer via TCGCSV, dated);
//! - the singles inside at market (`deck_prices::singles`, priced and unpriced copies apart). That
//!   is an estimate of the cards, not what they would sell for, and gameplay value is separate.
//!
//! A missing price is unknown, never $0, and never summed.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::Json;
use axum::extract::{Path, State};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::fmt::Write as _;

fn now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn today() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

/// The precon a sealed product's name is, when Yama knows exactly one name like it (the newest
/// release when a name was reused). Returns its id.
pub async fn precon_for(pool: &SqlitePool, name: &str) -> AppResult<Option<String>> {
    let n = name.trim();
    let n = n.strip_suffix(" Commander Deck").or_else(|| n.strip_suffix(" commander deck")).unwrap_or(n).trim();
    Ok(sqlx::query_scalar("SELECT id FROM precons WHERE name = ? COLLATE NOCASE ORDER BY released DESC, id LIMIT 1").bind(n).fetch_optional(pool).await?)
}

/// The sealed cap in the rule set in force on `date` (USD per deck, before tax), when one is set.
pub async fn cap_at(pool: &SqlitePool, owner: &str, date: &str) -> AppResult<Option<f64>> {
    let rules: Option<String> = sqlx::query_scalar("SELECT rules FROM plan_settings WHERE owner_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1")
        .bind(owner)
        .bind(date)
        .fetch_optional(pool)
        .await?;
    Ok(rules.and_then(|r| serde_json::from_str::<Value>(&r).ok()).and_then(|r| r["sealed_max_usd"].as_f64()).filter(|v| v.is_finite()))
}

fn pct(a: f64, b: f64) -> Option<f64> {
    (b > 0.0).then(|| ((a / b - 1.0) * 1000.0).round() / 10.0)
}

/// Every sealed product on the owner's list with its precon, market, singles, cap and store prices.
pub async fn view(pool: &SqlitePool, owner: &str, date: &str) -> AppResult<Value> {
    #[allow(clippy::type_complexity)]
    let wants: Vec<(String, String, i64, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT id, name, qty, priority, why, precon_id FROM shopping_wants WHERE owner_id = ? AND kind = 'sealed' AND retired_at IS NULL ORDER BY added_at, id",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let cap = cap_at(pool, owner, date).await?;
    let market = crate::deck_prices::sealed(pool).await?;
    let stores: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT s.key, s.name, p.preference FROM plan_stores s LEFT JOIN plan_store_prefs p ON p.owner_id = s.owner_id AND p.store_key = s.key WHERE s.owner_id = ?",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::new();
    for (id, name, qty, priority, why, precon) in wants {
        let p: Option<(String, String, Option<String>, Option<String>, String)> = match &precon {
            Some(pid) => sqlx::query_as("SELECT id, name, set_name, released, cards FROM precons WHERE id = ?").bind(pid).fetch_optional(pool).await?,
            None => None,
        };
        let (precon_json, singles, sealed) = match &p {
            None => (Value::Null, Value::Null, Value::Null),
            Some((pid, pname, set, released, cards)) => {
                let list: Value = serde_json::from_str(cards).unwrap_or(json!([]));
                let ids: Vec<String> = list.as_array().into_iter().flatten().filter_map(|c| c["oracle_id"].as_str().map(String::from)).collect();
                let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
                let prices = crate::deck_prices::prices_for(pool, &refs).await?;
                let singles = crate::deck_prices::singles(&list, &prices);
                (
                    json!({"id": pid, "name": pname, "set_name": set, "released": released}),
                    json!(singles),
                    market.get(pid).map(|m| json!(m)).unwrap_or(Value::Null),
                )
            }
        };
        #[allow(clippy::type_complexity)]
        let quotes: Vec<(String, String, Option<f64>, bool, String, Option<String>)> = sqlx::query_as(
            "SELECT q.id, q.store_key, q.price, q.in_stock, q.checked_on, q.note FROM sealed_quotes q
             WHERE q.owner_id = ? AND q.want_id = ?
               AND q.checked_on = (SELECT MAX(checked_on) FROM sealed_quotes WHERE owner_id = q.owner_id AND want_id = q.want_id AND store_key = q.store_key)
             ORDER BY q.price IS NULL, q.price, q.store_key",
        )
        .bind(owner)
        .bind(&id)
        .fetch_all(pool)
        .await?;
        let market_usd = sealed["usd"].as_f64();
        let singles_usd = singles["usd"].as_f64();
        let quotes: Vec<Value> = quotes
            .into_iter()
            .map(|(qid, store, price, in_stock, checked, note)| {
                let s = stores.iter().find(|s| s.0 == store);
                json!({
                    "id": qid, "store": store, "store_name": s.map(|s| s.1.clone()).unwrap_or_else(|| store.clone()),
                    "preference": s.and_then(|s| s.2.clone()).unwrap_or_else(|| "ok".into()),
                    "price": price, "in_stock": in_stock, "checked_on": checked, "note": note,
                    "over_cap": match (price, cap) { (Some(p), Some(c)) => json!(p > c + 1e-9), _ => Value::Null },
                    "vs_market_pct": price.zip(market_usd).and_then(|(p, m)| pct(p, m)),
                    "vs_singles_pct": price.zip(singles_usd).and_then(|(p, v)| pct(p, v)),
                })
            })
            .collect();
        // The cheapest copy in stock within the cap at a store they'll go to.
        let best = quotes
            .iter()
            .filter(|q| q["in_stock"] == true && q["over_cap"] != true && q["preference"] != "never" && q["price"].is_number())
            .min_by(|a, b| a["price"].as_f64().partial_cmp(&b["price"].as_f64()).unwrap_or(std::cmp::Ordering::Equal))
            .map(|q| q["id"].clone());
        out.push(json!({
            "want": id, "name": name, "qty": qty, "priority": priority, "why": why,
            "precon": precon_json, "market": sealed, "singles": singles, "quotes": quotes, "best": best,
        }));
    }
    Ok(json!({"date": date, "cap_usd": cap, "items": out}))
}

/// `GET /api/plan/sealed`: the sealed products on your list, with store prices and their market.
pub async fn view_route(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Value>> {
    Ok(Json(view(&st.pool, &user.id, &today()).await?))
}

#[derive(Deserialize)]
pub struct QuoteBody {
    store: String,
    price: Option<f64>,
    #[serde(default = "yes")]
    in_stock: bool,
    /// YYYY-MM-DD; default today.
    checked_on: Option<String>,
    note: Option<String>,
}

fn yes() -> bool {
    true
}

/// `POST /api/plan/sealed/{want}/quotes`: a store's dated price for a sealed product on your list.
pub async fn quote_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(want): Path<String>, Json(b): Json<QuoteBody>) -> AppResult<Json<Value>> {
    let pool = &st.pool;
    let found: Option<String> = sqlx::query_scalar("SELECT id FROM shopping_wants WHERE id = ? AND owner_id = ? AND kind = 'sealed' AND retired_at IS NULL").bind(&want).bind(&user.id).fetch_optional(pool).await?;
    if found.is_none() {
        return Err(AppError::NotFound("sealed product on your list"));
    }
    let store: Option<String> = sqlx::query_scalar("SELECT key FROM plan_stores WHERE owner_id = ? AND key = ? AND kind != 'printer' AND retired_at IS NULL").bind(&user.id).bind(&b.store).fetch_optional(pool).await?;
    if store.is_none() {
        return Err(AppError::bad(format!("No store with key \"{}\"", b.store)));
    }
    if b.price.is_some_and(|p| !(p.is_finite() && (0.0..=100000.0).contains(&p))) {
        return Err(AppError::bad("price: $0 to $100,000, or null when the store didn't say"));
    }
    let checked = b.checked_on.clone().unwrap_or_else(today);
    if !super::model::is_date(&checked) || checked > today() {
        return Err(AppError::bad("checked_on: a YYYY-MM-DD date, not in the future"));
    }
    let note = b.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
    if note.is_some_and(|n| n.chars().count() > 500) {
        return Err(AppError::bad("note: at most 500 characters"));
    }
    let id = crate::util::new_id();
    sqlx::query("INSERT INTO sealed_quotes (id, owner_id, want_id, store_key, price, in_stock, checked_on, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&id)
        .bind(&user.id)
        .bind(&want)
        .bind(&b.store)
        .bind(b.price)
        .bind(b.in_stock)
        .bind(&checked)
        .bind(note)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(Json(json!({"id": id})))
}

/// `DELETE /api/plan/sealed/quotes/{id}`: a price typed by mistake.
pub async fn remove_quote_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let done = sqlx::query("DELETE FROM sealed_quotes WHERE id = ? AND owner_id = ?").bind(&id).bind(&user.id).execute(&st.pool).await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("sealed price"));
    }
    Ok(Json(json!({"removed": id})))
}

fn usd(v: Option<f64>) -> String {
    v.map_or_else(|| "unknown".into(), |v| format!("${v:.2}"))
}

/// The sealed products in words, for `shopping_list`.
pub fn text(v: &Value) -> String {
    let empty = vec![];
    let items = v["items"].as_array().unwrap_or(&empty);
    if items.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    let cap = v["cap_usd"].as_f64();
    let _ = writeln!(
        out,
        "\nSealed products on their list ({}; {}). Store prices are dated quotes they typed; the singles value is a market estimate of the cards, not what they'd sell for.",
        items.len(),
        cap.map_or_else(|| "no sealed cap set".to_string(), |c| format!("their cap is ${c:.2} a deck before tax"))
    );
    for it in items {
        let qty = it["qty"].as_i64().unwrap_or(1);
        let _ = write!(out, "- {}{}", it["name"].as_str().unwrap_or_default(), if qty > 1 { format!(" ×{qty}") } else { String::new() });
        if it["precon"].is_null() {
            out.push_str(": not matched to a precon Yama knows, so no market or singles value.\n");
        } else {
            let m = &it["market"];
            let s = &it["singles"];
            let _ = writeln!(
                out,
                ": sealed market {}{}; singles inside {} ({} priced copies, {} unpriced{}).",
                usd(m["usd"].as_f64()),
                m["price_date"].as_str().map(|d| format!(" on {d}")).unwrap_or_default(),
                usd(s["usd"].as_f64()),
                s["priced_copies"],
                s["unpriced_copies"],
                s["newest_date"].as_str().map(|d| format!(", prices to {d}")).unwrap_or_default(),
            );
        }
        let quotes = it["quotes"].as_array().unwrap_or(&empty);
        if quotes.is_empty() {
            out.push_str("  No store price recorded.\n");
        }
        for q in quotes {
            let mut notes = Vec::new();
            if q["in_stock"] != true {
                notes.push("not in stock".to_string());
            }
            match q["over_cap"].as_bool() {
                Some(true) => notes.push("over their cap".into()),
                Some(false) => notes.push("within their cap".into()),
                None => {}
            }
            if let Some(p) = q["vs_market_pct"].as_f64() {
                notes.push(if p >= 0.0 { format!("{p}% above market") } else { format!("{}% below market", -p) });
            }
            if q["id"] == it["best"] {
                notes.push("the best choice".into());
            }
            let _ = writeln!(out, "  - {}: {} on {}{}", q["store_name"].as_str().unwrap_or_default(), usd(q["price"].as_f64()), q["checked_on"].as_str().unwrap_or_default(), if notes.is_empty() { String::new() } else { format!(" ({})", notes.join(", ")) });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{app, send, user};
    use axum::http::Method;

    #[tokio::test]
    async fn a_sealed_want_shows_store_prices_against_the_cap_market_and_singles() {
        let (app, pool) = app().await;
        let (owner, token) = user(&pool, "bryan@example.com").await;
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES ('o-sol', 'Sol Ring', 'Artifact', 'now')").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES ('p-sol', 'o-sol', 'Sol Ring', 'c21', 'C21', '263', 'en', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO price_snapshots (scryfall_id, date, usd) VALUES ('p-sol', '2026-10-31', 1.5)").execute(&pool).await.unwrap();
        let cards = json!([{"name": "Sol Ring", "oracle_id": "o-sol", "qty": 1, "board": "main"}, {"name": "Mystery", "oracle_id": null, "qty": 1, "board": "main"}]);
        sqlx::query(
            "INSERT INTO precons (id, lab_id, name, set_code, released, commanders, cards, source, content_sha256, imported_at)
             VALUES ('federation-fleet', 'precons/federation-fleet', 'Federation Fleet', 'TRK', '2026-11-13', '[]', ?, 'test', 'x', 'now')",
        )
        .bind(cards.to_string())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO sealed_deck_prices (precon_id, product_id, product_name, usd, price_date, source, url) VALUES ('federation-fleet', 1, 'Federation Fleet', 48.0, '2026-11-01', 'TCGplayer market via TCGCSV', 'https://x')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO plan_settings (owner_id, effective_from, rules, note, origin, created_at) VALUES (?, '2026-10-28', '{\"sealed_max_usd\": 51}', 'x', 'import', 'now')")
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();
        for (key, name) in [("pats", "Pat's Games"), ("mothership", "Mothership")] {
            sqlx::query("INSERT INTO plan_stores (id, owner_id, key, name, kind, sort, origin, created_at, updated_at) VALUES (?, ?, ?, ?, 'local', 1, 'import', 'now', 'now')")
                .bind(format!("s-{key}"))
                .bind(&owner)
                .bind(key)
                .bind(name)
                .execute(&pool)
                .await
                .unwrap();
        }
        let (s, w) = send(&app, Method::POST, "/api/plan/wants", Some(&token), Some(json!({"kind": "sealed", "name": "Federation Fleet Commander Deck"}))).await;
        assert!(s.is_success(), "{w}");
        assert_eq!(w["precon_id"], "federation-fleet", "matched by name");
        let want = w["id"].as_str().unwrap();
        for (store, price, date) in [("pats", json!(54.99), "2026-10-30"), ("mothership", json!(49.99), "2026-10-31"), ("pats", json!(50.0), "2026-11-01")] {
            let (s, v) = send(&app, Method::POST, &format!("/api/plan/sealed/{want}/quotes"), Some(&token), Some(json!({"store": store, "price": price, "checked_on": date}))).await;
            assert!(s.is_success(), "{v}");
        }
        assert_eq!(send(&app, Method::POST, &format!("/api/plan/sealed/{want}/quotes"), Some(&token), Some(json!({"store": "nowhere", "price": 1}))).await.0.as_u16(), 400);
        let v = view(&pool, &owner, "2026-11-01").await.unwrap();
        assert_eq!(v["cap_usd"], 51.0);
        let it = &v["items"][0];
        assert_eq!(it["market"]["usd"], 48.0);
        assert_eq!((it["singles"]["usd"].as_f64(), it["singles"]["priced_copies"].as_i64(), it["singles"]["unpriced_copies"].as_i64()), (Some(1.5), Some(1), Some(1)), "an unpriced card is counted, never $0");
        // Pat's newest price replaces its older one; Mothership is the cheapest within the cap.
        let quotes = it["quotes"].as_array().unwrap();
        assert_eq!(quotes.len(), 2);
        assert_eq!((quotes[0]["store"].as_str(), quotes[0]["price"].as_f64()), (Some("mothership"), Some(49.99)));
        assert_eq!(it["best"], quotes[0]["id"]);
        assert_eq!(quotes[1]["vs_market_pct"], 4.2);
        let t = text(&v);
        assert!(t.contains("their cap is $51.00 a deck") && t.contains("sealed market $48.00 on 2026-11-01") && t.contains("Mothership: $49.99 on 2026-10-31 (within their cap, 4.1% above market, the best choice)"), "{t}");
        // A price over the cap is flagged; another account sees nothing and can't add a price.
        let (_, _) = send(&app, Method::POST, &format!("/api/plan/sealed/{want}/quotes"), Some(&token), Some(json!({"store": "mothership", "price": 59.99}))).await;
        let v = view(&pool, &owner, &today()).await.unwrap();
        assert!(v["items"][0]["quotes"].as_array().unwrap().iter().any(|q| q["store"] == "mothership" && q["over_cap"] == true));
        let (other, other_token) = user(&pool, "other@example.com").await;
        assert_eq!(view(&pool, &other, "2026-11-01").await.unwrap()["items"], json!([]));
        assert_eq!(send(&app, Method::POST, &format!("/api/plan/sealed/{want}/quotes"), Some(&other_token), Some(json!({"store": "pats", "price": 1}))).await.0.as_u16(), 404);
        let qid = quotes[0]["id"].as_str().unwrap();
        assert_eq!(send(&app, Method::DELETE, &format!("/api/plan/sealed/quotes/{qid}"), Some(&other_token), None).await.0.as_u16(), 404);
        assert!(send(&app, Method::DELETE, &format!("/api/plan/sealed/quotes/{qid}"), Some(&token), None).await.0.is_success());
    }
}
