//! Slice 3's two deck routes: link a plan deck to the owner's Yama deck, and make a Yama deck
//! from one of a plan deck's stored lists. Neither changes plan content, so both work on imported
//! plans. Anyone else's plan deck or Yama deck is a 404.

use super::model::Slot;
use super::plan_deck;
use crate::auth::CurrentUser;
use crate::decks::{Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::now;
use axum::Json;
use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

/// The folder decks made from plan lists go in.
pub const PLANS_FOLDER: &str = "Plans";

const MANAGED: &str = "This plan is managed by your commander-decks export; change it there.";

#[derive(Deserialize)]
pub struct DeckPatch {
    /// Absent: leave as is. `null`: unlink.
    #[serde(default, deserialize_with = "crate::util::double_option")]
    deck_id: Option<Option<String>>,
    sort: Option<i64>,
}

/// `PATCH /api/plan/decks/{key}`: link (or unlink) the Yama deck that is this plan's physical
/// deck, and for Yama-made plans set the order. The link is the owner's own data, so it is allowed
/// on imported plans; their order comes from the export (409).
pub async fn patch_deck(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(key): Path<String>,
    Json(body): Json<DeckPatch>,
) -> AppResult<Json<Value>> {
    let (id, source, _) = plan_deck(&st.pool, &user.id, &key).await?;
    if body.sort.is_some() && source == "import" {
        return Err(AppError::Conflict(MANAGED.into()));
    }
    if let Some(Some(deck_id)) = &body.deck_id {
        let mine: Option<String> = sqlx::query_scalar("SELECT id FROM decks WHERE id = ? AND owner_id = ? AND archived = 0")
            .bind(deck_id)
            .bind(&user.id)
            .fetch_optional(&st.pool)
            .await?;
        mine.ok_or(AppError::NotFound("deck"))?;
    }
    let (deck_id, sort): (Option<String>, i64) =
        sqlx::query_as("SELECT deck_id, sort FROM plan_decks WHERE id = ? AND owner_id = ?").bind(&id).bind(&user.id).fetch_one(&st.pool).await?;
    let new_deck_id = body.deck_id.clone().unwrap_or_else(|| deck_id.clone());
    let new_sort = body.sort.unwrap_or(sort);
    // The same values again change nothing, not even the bundle's cache key.
    if new_deck_id != deck_id || new_sort != sort {
        let stamp = now();
        let mut tx = st.pool.begin().await?;
        sqlx::query("UPDATE plan_decks SET deck_id = ?, sort = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
            .bind(&new_deck_id)
            .bind(new_sort)
            .bind(&stamp)
            .bind(&id)
            .bind(&user.id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO plan_meta (owner_id, revision, updated_at) VALUES (?, 1, ?)
             ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at",
        )
        .bind(&user.id)
        .bind(&stamp)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    Ok(Json(json!({ "key": key, "deck_id": new_deck_id, "sort": new_sort })))
}

#[derive(Deserialize)]
pub struct MakeDeck {
    state: String,
}

fn state_label(state: &str) -> Option<&'static str> {
    Some(match state {
        "stock" => "stock",
        "now" => "now",
        "after" => "after prints",
        "proposal" => "proposed",
        "bracket3" => "Bracket 3",
        "bracket2" => "Bracket 2",
        _ => return None,
    })
}

/// `POST /api/plan/decks/{key}/yama-deck` `{state}`: a new Yama deck, in the folder "Plans", from
/// the plan deck's **stored** list. Every card must be in Yama's card data (400 lists the ones
/// that aren't). The first version's note names the list by its content hash, so asking again
/// for the same list returns the deck already made (unless it was archived) instead of a copy.
pub async fn make_yama_deck(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(key): Path<String>,
    Json(body): Json<MakeDeck>,
) -> AppResult<Json<Value>> {
    let label = state_label(&body.state).ok_or_else(|| AppError::bad(format!("state: unknown list \"{}\"", body.state)))?;
    let (plan_id, _, _) = plan_deck(&st.pool, &user.id, &key).await?;
    let (name, hash, cards, computed_by): (String, String, String, String) = sqlx::query_as(
        "SELECT d.name, s.content_hash, s.cards, s.computed_by FROM plan_states s
         JOIN plan_decks d ON d.id = s.plan_deck_id AND d.owner_id = s.owner_id
         WHERE s.plan_deck_id = ? AND s.owner_id = ? AND s.state = ? AND s.current = 1",
    )
    .bind(&plan_id)
    .bind(&user.id)
    .bind(&body.state)
    .fetch_optional(&st.pool)
    .await?
    .ok_or(AppError::NotFound("plan list"))?;
    let slots: Vec<Slot> = serde_json::from_str(&cards).map_err(anyhow::Error::from)?;

    let names: Vec<String> = slots.iter().map(|s| s.name.trim().to_string()).collect();
    let resolved = super::resolve_names(&st.pool, &names).await?;
    let mut unknown: Vec<&str> = Vec::new();
    for n in &names {
        if !resolved.contains_key(n) && !unknown.contains(&n.as_str()) {
            unknown.push(n);
        }
    }
    if !unknown.is_empty() {
        return Err(AppError::bad(format!(
            "These cards aren't in Yama's card data yet, so this list can't be a Yama deck: {}",
            unknown.join(", ")
        )));
    }

    let note = format!(
        "Made from the plan's {label} list ({computed_by}; list {}). A plan list, not a record of what's in your deck box.",
        &hash[..hash.len().min(12)]
    );
    let existing: Option<(String, String)> = sqlx::query_as(
        "SELECT d.id, d.name FROM decks d JOIN deck_versions v ON v.deck_id = d.id
         WHERE d.owner_id = ? AND d.archived = 0 AND v.note = ? ORDER BY v.created_at LIMIT 1",
    )
    .bind(&user.id)
    .bind(&note)
    .fetch_optional(&st.pool)
    .await?;
    if let Some((id, name)) = existing {
        return Ok(Json(json!({ "id": id, "name": name, "existing": true, "note": note })));
    }

    // Canonical names, and copies of one card (basics in two printings) summed per board.
    let ids: Vec<&String> = resolved.values().collect();
    let canonical: HashMap<String, String> = sqlx::query_as("SELECT oracle_id, name FROM cards WHERE oracle_id IN (SELECT value FROM json_each(?))")
        .bind(serde_json::to_string(&ids).map_err(anyhow::Error::from)?)
        .fetch_all(&st.pool)
        .await?
        .into_iter()
        .collect();
    let mut deck_cards: Vec<DeckCard> = Vec::new();
    for s in &slots {
        let oracle_id = resolved[s.name.trim()].clone();
        let board = if s.board == "commander" { Board::Commander } else { Board::Main };
        if let Some(c) = deck_cards.iter_mut().find(|c| c.oracle_id == oracle_id && c.board == board) {
            c.qty += s.qty;
        } else {
            let name = canonical.get(&oracle_id).cloned().unwrap_or_else(|| s.name.clone());
            deck_cards.push(DeckCard { oracle_id, name, qty: s.qty, board });
        }
    }
    let deck_name = format!("{name} ({label} list)");
    let id = crate::decks::create_deck_with_note(&st.pool, &user.id, &deck_name, Some(PLANS_FOLDER), deck_cards, &note).await?;
    Ok(Json(json!({ "id": id, "name": deck_name, "existing": false, "note": note })))
}

#[cfg(test)]
mod tests {
    use crate::testutil::{app, send, user};
    use axum::Router;
    use axum::http::{Method, StatusCode};
    use serde_json::{Value, json};
    use sqlx::SqlitePool;

    async fn seed(pool: &SqlitePool) {
        for (id, name, type_line, ci) in [
            ("o-cmd", "Test Commander", "Legendary Creature — Elf", "G"),
            ("o-sol", "Sol Ring", "Artifact", ""),
            ("o-forest", "Forest", "Basic Land — Forest", "G"),
        ] {
            sqlx::query(
                "INSERT INTO cards (oracle_id, name, type_line, color_identity, legalities, updated_at)
                 VALUES (?, ?, ?, ?, '{\"commander\":\"legal\"}', 'now')",
            )
            .bind(id)
            .bind(name)
            .bind(type_line)
            .bind(ci)
            .execute(pool)
            .await
            .unwrap();
            sqlx::query("INSERT INTO card_names (name, oracle_id) VALUES (?, ?)").bind(name).bind(id).execute(pool).await.unwrap();
        }
    }

    /// One deck: a stock list Yama knows (Forest in two printings) and a now list with a card it doesn't.
    fn doc() -> Value {
        let stock = json!([
            {"name": "Test Commander", "qty": 1, "board": "commander", "kind": "stock"},
            {"name": "Sol Ring", "qty": 1, "board": "main", "kind": "stock"},
            {"name": "Forest", "qty": 60, "board": "main", "kind": "stock", "set": "tst", "num": "1"},
            {"name": "Forest", "qty": 38, "board": "main", "kind": "stock", "set": "abc", "num": "2"}
        ]);
        let now = json!([
            {"name": "Test Commander", "qty": 1, "board": "commander", "kind": "stock"},
            {"name": "Unknown Future Card", "qty": 1, "board": "main", "kind": "bought"},
            {"name": "Forest", "qty": 98, "board": "main", "kind": "stock"}
        ]);
        json!({
            "format": "yama-plan/1",
            "meta": {"app": "commander-decks", "guide_version": 6},
            "plan": {"decks": [{"key": "alpha", "name": "Alpha Deck", "commander": ["Test Commander"], "color_identity": "G",
                                "computed_by": "test writer, guide v6",
                                "states": {"stock": {"cards": stock}, "now": {"cards": now}, "after": {"cards": now}}}]}
        })
    }

    async fn setup() -> (Router, SqlitePool, String, String, String) {
        let (app, pool) = app().await;
        seed(&pool).await;
        let (a, token_a) = user(&pool, "a@example.com").await;
        let (_, token_b) = user(&pool, "b@example.com").await;
        let (status, report) = send(&app, Method::POST, "/api/plan/import", Some(&token_a), Some(doc())).await;
        assert_eq!(status, StatusCode::OK, "{report}");
        (app, pool, a, token_a, token_b)
    }

    async fn bundle(app: &Router, token: &str) -> Value {
        let (status, b) = send(app, Method::GET, "/api/plan/bundle", Some(token), None).await;
        assert_eq!(status, StatusCode::OK);
        b
    }

    #[tokio::test]
    async fn a_list_with_unknown_cards_cant_become_a_yama_deck() {
        let (app, pool, _, a, _) = setup().await;
        let (status, body) = send(&app, Method::POST, "/api/plan/decks/alpha/yama-deck", Some(&a), Some(json!({"state": "now"}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().ends_with(": Unknown Future Card"), "{body}");
        let decks: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM decks").fetch_one(&pool).await.unwrap();
        assert_eq!(decks, 0);

        let (status, body) = send(&app, Method::POST, "/api/plan/decks/alpha/yama-deck", Some(&a), Some(json!({"state": "lab"}))).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let (status, _) = send(&app, Method::POST, "/api/plan/decks/alpha/yama-deck", Some(&a), Some(json!({"state": "bracket3"}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_yama_deck_made_from_a_list_belongs_to_the_caller() {
        let (app, pool, a_id, a, b) = setup().await;
        let (status, made) = send(&app, Method::POST, "/api/plan/decks/alpha/yama-deck", Some(&a), Some(json!({"state": "stock"}))).await;
        assert_eq!(status, StatusCode::OK, "{made}");
        assert_eq!(made["existing"], false);
        assert_eq!(made["name"], "Alpha Deck (stock list)");
        let id = made["id"].as_str().unwrap().to_string();

        let (owner, folder): (String, String) = sqlx::query_as("SELECT owner_id, folder FROM decks WHERE id = ?").bind(&id).fetch_one(&pool).await.unwrap();
        assert_eq!((owner.as_str(), folder.as_str()), (a_id.as_str(), "Plans"));
        let (status, deck) = send(&app, Method::GET, &format!("/api/decks/{id}"), Some(&a), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(deck["validation"]["total"], 100);
        // Forest in two printings is one line of 98.
        let forest: Vec<&Value> = deck["cards"].as_array().unwrap().iter().filter(|c| c["name"] == "Forest").collect();
        assert_eq!(forest.len(), 1);
        assert_eq!(forest[0]["qty"], 98);
        let note: String = sqlx::query_scalar("SELECT note FROM deck_versions WHERE deck_id = ?").bind(&id).fetch_one(&pool).await.unwrap();
        assert!(note.starts_with("Made from the plan's stock list (test writer, guide v6; list "), "{note}");
        assert!(note.ends_with("A plan list, not a record of what's in your deck box."), "{note}");

        // Asking again gives the same deck, not a copy.
        let (_, again) = send(&app, Method::POST, "/api/plan/decks/alpha/yama-deck", Some(&a), Some(json!({"state": "stock"}))).await;
        assert_eq!(again["id"], made["id"]);
        assert_eq!(again["existing"], true);

        // Nobody else can see it or use the plan deck.
        let (status, _) = send(&app, Method::GET, &format!("/api/decks/{id}"), Some(&b), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&app, Method::POST, "/api/plan/decks/alpha/yama-deck", Some(&b), Some(json!({"state": "stock"}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&app, Method::POST, "/api/plan/decks/alpha/yama-deck", None, Some(json!({"state": "stock"}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        // Archived, it's made again.
        sqlx::query("UPDATE decks SET archived = 1 WHERE id = ?").bind(&id).execute(&pool).await.unwrap();
        let (_, fresh) = send(&app, Method::POST, "/api/plan/decks/alpha/yama-deck", Some(&a), Some(json!({"state": "stock"}))).await;
        assert_ne!(fresh["id"], made["id"]);
    }

    #[tokio::test]
    async fn linking_checks_both_owners_and_survives_a_new_import() {
        let (app, pool, a_id, a, b) = setup().await;
        let b_id: String = sqlx::query_scalar("SELECT id FROM users WHERE email = 'b@example.com'").fetch_one(&pool).await.unwrap();
        let (mine, _) = crate::testutil::deck(&pool, &a_id, "My Alpha").await;
        let (theirs, _) = crate::testutil::deck(&pool, &b_id, "Their deck").await;

        // Another user's deck, or another user's plan deck, is a 404.
        let (status, _) = send(&app, Method::PATCH, "/api/plan/decks/alpha", Some(&a), Some(json!({"deck_id": theirs}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&app, Method::PATCH, "/api/plan/decks/alpha", Some(&b), Some(json!({"deck_id": theirs}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, _) = send(&app, Method::PATCH, "/api/plan/decks/no-such-deck", Some(&a), Some(json!({"deck_id": mine}))).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let before = bundle(&app, &a).await;
        let (status, linked) = send(&app, Method::PATCH, "/api/plan/decks/alpha", Some(&a), Some(json!({"deck_id": mine}))).await;
        assert_eq!(status, StatusCode::OK, "{linked}");
        let after = bundle(&app, &a).await;
        assert_eq!(after["decks"][0]["deck_id"], mine.as_str());
        assert_ne!(after["rev"], before["rev"], "a new link moves the bundle's cache key");

        // The same link again changes nothing.
        send(&app, Method::PATCH, "/api/plan/decks/alpha", Some(&a), Some(json!({"deck_id": mine}))).await;
        assert_eq!(bundle(&app, &a).await["rev"], after["rev"]);

        // An imported plan's order belongs to its export.
        let (status, body) = send(&app, Method::PATCH, "/api/plan/decks/alpha", Some(&a), Some(json!({"sort": 4}))).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");

        // A new import keeps the link.
        let (status, _) = send(&app, Method::POST, "/api/plan/import?force=1", Some(&a), Some(doc())).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bundle(&app, &a).await["decks"][0]["deck_id"], mine.as_str());

        // null unlinks.
        let (status, _) = send(&app, Method::PATCH, "/api/plan/decks/alpha", Some(&a), Some(json!({"deck_id": null}))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bundle(&app, &a).await["decks"][0]["deck_id"], Value::Null);
    }
}
