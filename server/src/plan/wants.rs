//! One shopping list (docs/shopping-design.md, slice 3): cards and sealed products added to the
//! list by hand (on the Trip page, or by a change from Claude the person applied), beside the plan's
//! buys, proposals and the real-card wishlist. A want is a wish, never a purchase: it leaves the list
//! only when they remove it.
//!
//! A Yama deck that isn't in a plan says which of its cards the collection doesn't hold
//! (`deck_gaps`), so they can add the ones to buy. It isn't added for them: a deck they proxy would
//! fill the trip with cards they mean to print.

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::Json;
use axum::extract::{Path, State};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::HashMap;

/// At most this many wants on a list at once.
pub const MAX_WANTS: i64 = 500;

fn now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// A want to add, checked by [`add`].
#[derive(Clone, Debug, Default, Deserialize)]
pub struct NewWant {
    /// "card" (default) or "sealed".
    pub kind: Option<String>,
    pub name: String,
    pub qty: Option<i64>,
    /// "need" (default) or "along".
    pub priority: Option<String>,
    /// One of their Yama decks, by id.
    pub deck_id: Option<String>,
    /// A label for a deck that isn't in Yama (or to name it differently).
    pub deck_name: Option<String>,
    pub why: Option<String>,
}

/// The want as it would be saved: kind, the canonical name, quantity, priority, deck id, deck label
/// and why. Card names must be cards Yama knows.
pub async fn check(pool: &SqlitePool, owner: &str, w: &NewWant) -> AppResult<(String, String, i64, String, Option<String>, Option<String>, Option<String>)> {
    let kind = w.kind.clone().unwrap_or_else(|| "card".into());
    if kind != "card" && kind != "sealed" {
        return Err(AppError::bad("kind must be card or sealed"));
    }
    let priority = w.priority.clone().unwrap_or_else(|| "need".into());
    if priority != "need" && priority != "along" {
        return Err(AppError::bad("priority must be need (a reason to go to a store) or along (only from a store on the trip)"));
    }
    let qty = w.qty.unwrap_or(1);
    if !(1..=99).contains(&qty) {
        return Err(AppError::bad("qty: 1 to 99"));
    }
    let name = w.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(AppError::bad("name: 1 to 200 characters"));
    }
    let name = if kind == "card" {
        let ids = crate::cards::resolve_names(pool, &[name.to_string()]).await?;
        let Some(oid) = ids.get(name) else { return Err(AppError::bad(format!("Yama doesn't know a card called \"{name}\"."))) };
        sqlx::query_scalar::<_, String>("SELECT name FROM cards WHERE oracle_id = ?").bind(oid).fetch_one(pool).await?
    } else {
        name.to_string()
    };
    let text = |v: &Option<String>, key: &str, max: usize| -> AppResult<Option<String>> {
        match v.as_deref().map(str::trim).filter(|x| !x.is_empty()) {
            Some(x) if x.chars().count() > max => Err(AppError::bad(format!("{key}: at most {max} characters"))),
            other => Ok(other.map(String::from)),
        }
    };
    let why = text(&w.why, "why", 500)?;
    let mut deck_name = text(&w.deck_name, "deck_name", 200)?;
    let deck_id = match w.deck_id.as_deref().filter(|d| !d.is_empty()) {
        None => None,
        Some(id) => {
            let name: Option<String> = sqlx::query_scalar("SELECT name FROM decks WHERE id = ? AND owner_id = ? AND archived = 0").bind(id).bind(owner).fetch_optional(pool).await?;
            let Some(n) = name else { return Err(AppError::NotFound("deck")) };
            deck_name.get_or_insert(n);
            Some(id.to_string())
        }
    };
    Ok((kind, name, qty, priority, deck_id, deck_name, why))
}

/// Add a want for the owner. `source` is "page" or "assistant".
pub async fn add(pool: &SqlitePool, owner: &str, w: &NewWant, source: &str) -> AppResult<Value> {
    let (kind, name, qty, priority, deck_id, deck_name, why) = check(pool, owner, w).await?;
    let open: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shopping_wants WHERE owner_id = ? AND retired_at IS NULL").bind(owner).fetch_one(pool).await?;
    if open >= MAX_WANTS {
        return Err(AppError::bad(format!("Your list has {open} cards and products, the most Yama keeps. Remove some first.")));
    }
    let id = crate::util::new_id();
    let at = now();
    sqlx::query(
        "INSERT INTO shopping_wants (id, owner_id, kind, name, qty, priority, deck_id, deck_name, why, source, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(owner)
    .bind(&kind)
    .bind(&name)
    .bind(qty)
    .bind(&priority)
    .bind(&deck_id)
    .bind(&deck_name)
    .bind(&why)
    .bind(source)
    .bind(&at)
    .execute(pool)
    .await?;
    Ok(json!({"id": id, "kind": kind, "name": name, "qty": qty, "priority": priority, "deck_id": deck_id, "deck_name": deck_name, "why": why, "source": source, "added_at": at}))
}

/// The owner's wants on the list now, oldest first. A deck that's gone keeps its label.
pub async fn list(pool: &SqlitePool, owner: &str) -> AppResult<Vec<Value>> {
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, String, String, i64, String, Option<String>, Option<String>, Option<String>, String, String)> = sqlx::query_as(
        "SELECT w.id, w.kind, w.name, w.qty, w.priority, w.deck_id, COALESCE(d.name, w.deck_name), w.why, w.source, w.added_at
         FROM shopping_wants w LEFT JOIN decks d ON d.id = w.deck_id AND d.owner_id = w.owner_id
         WHERE w.owner_id = ? AND w.retired_at IS NULL ORDER BY w.added_at, w.id",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, kind, name, qty, priority, deck_id, deck_name, why, source, at)| {
            json!({"id": id, "kind": kind, "name": name, "qty": qty, "priority": priority, "deck_id": deck_id, "deck_name": deck_name, "why": why, "source": source, "added_at": at})
        })
        .collect())
}

/// `POST /api/plan/wants`: add a card or sealed product to your list.
pub async fn add_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(w): Json<NewWant>) -> AppResult<Json<Value>> {
    Ok(Json(add(&st.pool, &user.id, &w, "page").await?))
}

/// `DELETE /api/plan/wants/{id}`: take it off your list (kept, retired, for the record).
pub async fn remove_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let done = sqlx::query("UPDATE shopping_wants SET retired_at = ? WHERE id = ? AND owner_id = ? AND retired_at IS NULL")
        .bind(now())
        .bind(&id)
        .bind(&user.id)
        .execute(&st.pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("want"));
    }
    Ok(Json(json!({"removed": id})))
}

/// A deck's cards the collection doesn't hold enough real copies of: (name, needed, real copies,
/// proxies). Copies are counted across every printing and container, so a card another deck uses
/// counts here too; basic lands are left out.
pub async fn deck_gaps(pool: &SqlitePool, owner: &str, deck: &str) -> AppResult<(String, Vec<(String, i64, i64, i64)>)> {
    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT name, current_version_id FROM decks WHERE id = ? AND owner_id = ?").bind(deck).bind(owner).fetch_optional(pool).await?;
    let Some((name, version)) = row else { return Err(AppError::NotFound("deck")) };
    let cards: Vec<Value> = match version {
        None => vec![],
        Some(v) => {
            let text: Option<String> = sqlx::query_scalar("SELECT cards FROM deck_versions WHERE id = ? AND deck_id = ?").bind(v).bind(deck).fetch_optional(pool).await?;
            text.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
        }
    };
    let mut need: Vec<(String, String, i64)> = Vec::new();
    for c in &cards {
        if c["board"] == "side" {
            continue;
        }
        let (Some(oid), Some(n)) = (c["oracle_id"].as_str(), c["name"].as_str()) else { continue };
        let q = c["qty"].as_i64().unwrap_or(1).max(1);
        match need.iter_mut().find(|x| x.0 == oid) {
            Some(x) => x.2 += q,
            None => need.push((oid.to_string(), n.to_string(), q)),
        }
    }
    let ids: Vec<&String> = need.iter().map(|x| &x.0).collect();
    let owned: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT p.oracle_id, SUM(CASE WHEN c.proxy = 0 THEN c.qty ELSE 0 END), SUM(CASE WHEN c.proxy = 1 THEN c.qty ELSE 0 END)
         FROM collection_items c JOIN printings p ON p.scryfall_id = c.scryfall_id
         WHERE c.owner_id = ? AND p.oracle_id IN (SELECT value FROM json_each(?)) GROUP BY p.oracle_id",
    )
    .bind(owner)
    .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?;
    let owned: HashMap<String, (i64, i64)> = owned.into_iter().map(|(o, r, p)| (o, (r, p))).collect();
    let basics: Vec<String> = sqlx::query_scalar("SELECT oracle_id FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?)) AND type_line LIKE 'Basic%'")
        .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
        .fetch_all(pool)
        .await?;
    let mut out: Vec<(String, i64, i64, i64)> = need
        .into_iter()
        .filter(|(oid, _, _)| !basics.contains(oid))
        .filter_map(|(oid, n, q)| {
            let (real, proxy) = owned.get(&oid).copied().unwrap_or((0, 0));
            (real < q).then_some((n, q, real, proxy))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok((name, out))
}

/// `GET /api/plan/wants/deck-gaps/{deck}`: a deck's cards your collection doesn't hold.
pub async fn gaps_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(deck): Path<String>) -> AppResult<Json<Value>> {
    let (name, gaps) = deck_gaps(&st.pool, &user.id, &deck).await?;
    Ok(Json(json!({
        "deck": deck, "name": name,
        "cards": gaps.into_iter().map(|(n, need, real, proxy)| json!({"name": n, "need": need, "real": real, "proxy": proxy})).collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{app, deck, send, user};
    use axum::http::Method;

    #[tokio::test]
    async fn wants_are_checked_owned_and_retired() {
        let (app, pool) = app().await;
        let (owner, token) = user(&pool, "bryan@example.com").await;
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES ('o-sol', 'Sol Ring', 'Artifact', 'now'), ('o-isl', 'Island', 'Basic Land — Island', 'now')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES ('Sol Ring', 'o-sol'), ('Island', 'o-isl')").execute(&pool).await.unwrap();
        let (s, v) = send(&app, Method::POST, "/api/plan/wants", Some(&token), Some(json!({"name": "sol ring", "qty": 2, "deck_name": "Kraum & Tymna (cEDH)", "why": "Local buy"}))).await;
        assert!(s.is_success(), "{v}");
        assert_eq!((v["name"].as_str(), v["priority"].as_str(), v["qty"].as_i64()), (Some("Sol Ring"), Some("need"), Some(2)));
        let id = v["id"].as_str().unwrap().to_string();
        for bad in [json!({"name": "Not A Card"}), json!({"name": "Sol Ring", "qty": 0}), json!({"name": "Sol Ring", "priority": "soon"}), json!({"name": "Sol Ring", "kind": "pack"})] {
            assert_eq!(send(&app, Method::POST, "/api/plan/wants", Some(&token), Some(bad.clone())).await.0.as_u16(), 400, "{bad}");
        }
        // A sealed product is free text.
        let (s, _) = send(&app, Method::POST, "/api/plan/wants", Some(&token), Some(json!({"kind": "sealed", "name": "Federation Fleet", "priority": "along"}))).await;
        assert!(s.is_success());
        assert_eq!(list(&pool, &owner).await.unwrap().len(), 2);
        // In the bundle, and its card in the trip.
        let b = crate::plan::bundle::load_bundle(&pool, &owner).await.unwrap();
        assert_eq!(b["shopping_wants"].as_array().unwrap().len(), 2);
        let wants = crate::plan::trip::trip_wants(&b);
        assert_eq!(wants.iter().filter(|w| w.card == "Sol Ring" && w.needed && w.source == "want").count(), 2, "one want a copy");
        // Someone else can't see or remove it.
        let (other, other_token) = user(&pool, "other@example.com").await;
        assert!(list(&pool, &other).await.unwrap().is_empty());
        assert_eq!(send(&app, Method::DELETE, &format!("/api/plan/wants/{id}"), Some(&other_token), None).await.0.as_u16(), 404);
        let (d, _) = deck(&pool, &owner, "Theirs").await;
        assert_eq!(send(&app, Method::POST, "/api/plan/wants", Some(&other_token), Some(json!({"name": "Sol Ring", "deck_id": d}))).await.0.as_u16(), 404);
        assert!(send(&app, Method::DELETE, &format!("/api/plan/wants/{id}"), Some(&token), None).await.0.is_success());
        assert_eq!(list(&pool, &owner).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_deck_says_which_cards_the_collection_lacks() {
        let (app, pool) = app().await;
        let (owner, token) = user(&pool, "bryan@example.com").await;
        sqlx::query("INSERT INTO cards (oracle_id, name, type_line, updated_at) VALUES ('o-sol', 'Sol Ring', 'Artifact', 'now'), ('o-isl', 'Island', 'Basic Land — Island', 'now'), ('o-fs', 'Fellwar Stone', 'Artifact', 'now')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at)
             VALUES ('p-sol', 'o-sol', 'Sol Ring', 'c21', 'C21', '263', 'en', 'now'), ('p-fs', 'o-fs', 'Fellwar Stone', 'drk', 'The Dark', '103', 'en', 'now')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, proxy, created_at, updated_at) VALUES ('c1', ?, 'p-sol', 1, 0, 'now', 'now'), ('c2', ?, 'p-fs', 1, 1, 'now', 'now')")
            .bind(&owner)
            .bind(&owner)
            .execute(&pool)
            .await
            .unwrap();
        let (deck_id, version) = deck(&pool, &owner, "Kraum & Tymna").await;
        let cards = json!([
            {"oracle_id": "o-sol", "name": "Sol Ring", "qty": 1, "board": "main"},
            {"oracle_id": "o-fs", "name": "Fellwar Stone", "qty": 1, "board": "main"},
            {"oracle_id": "o-isl", "name": "Island", "qty": 5, "board": "main"},
        ]);
        sqlx::query("UPDATE deck_versions SET cards = ? WHERE id = ?").bind(cards.to_string()).bind(&version).execute(&pool).await.unwrap();
        let (s, v) = send(&app, Method::GET, &format!("/api/plan/wants/deck-gaps/{deck_id}"), Some(&token), None).await;
        assert!(s.is_success(), "{v}");
        // Sol Ring is owned; Fellwar Stone only as a proxy; Island is a basic.
        assert_eq!(v["cards"], json!([{"name": "Fellwar Stone", "need": 1, "real": 0, "proxy": 1}]));
        let (_, other) = user(&pool, "other@example.com").await;
        assert_eq!(send(&app, Method::GET, &format!("/api/plan/wants/deck-gaps/{deck_id}"), Some(&other), None).await.0.as_u16(), 404);
    }
}
