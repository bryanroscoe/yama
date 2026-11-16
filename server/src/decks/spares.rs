//! Swappable spares: the cards kept in a deck's box on top of its 100 (Bryan, 15 Nov 2026). The
//! bracket bag's cards and ready swaps live there: Talisman of Creativity rides in the Riders of
//! Rohan box to come in for Thought Vessel at Bracket 4.
//!
//! - **Where they are:** copies in one container linked to the main deck
//!   (`decks.spares_container_id`), apart from the deck's own box (`decks.container_id`). Nothing
//!   that reads the deck's list or its box (size, legality, analysis, prices, the lab, "Add to my
//!   collection") sees them. A configuration (the deck's Bracket 3 list, say) shares its main
//!   deck's spares, as it shares the physical box.
//! - **Which container:** any box, binder or list of the owner's that isn't a deck box and holds no
//!   other live deck's spares. Linking one moves no copy. [`ensure`] links the box called
//!   "<deck> swap bag" when there is one (the plan's swap-in makes those), else makes it.
//! - **What each swaps for:** the plan's bracket bags (the plan linked to the deck, or an unlinked
//!   plan with the deck's name; read live: the card that comes back in at
//!   that bracket, and the card it replaces), and the owner's own note per card
//!   (`deck_spare_swaps`), for swaps a plan doesn't hold.
//!
//! `GET /api/decks/{id}/spares` reads them; `PUT` links (`{"container_id": …}`), unlinks
//! (`{"container_id": null}`) or makes the box (`{"create": true}`); `PUT …/spares/swaps` sets or
//! clears what one card swaps for. Moving copies in and out is an ordinary collection move into
//! that container (the collection's Move, `move_cards`).

use crate::auth::CurrentUser;
use crate::collection::CONTAINERS_MAX;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::extract::{Path, State};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::BTreeMap;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/decks/{id}/spares", get(get_spares).put(put_spares)).route("/api/decks/{id}/spares/swaps", put(put_swap))
}

/// The name of the box [`ensure`] links or makes for a deck's swappable spares.
pub fn default_name(deck: &str) -> String {
    format!("{} swap bag", deck.trim())
}

/// How the collection names a copy in a deck's swappable spares.
pub fn place(deck: &str) -> String {
    format!("in {deck}'s box (swappable)")
}

/// The live main deck a live deck belongs to: (id, name). A configuration answers with its main deck.
pub async fn main_deck(conn: &mut SqliteConnection, owner: &str, deck_id: &str) -> AppResult<(String, String)> {
    sqlx::query_as(
        "SELECT p.id, p.name FROM decks d JOIN decks p ON p.id = COALESCE(d.parent_id, d.id) AND p.owner_id = d.owner_id
         WHERE d.id = ? AND d.owner_id = ? AND d.archived = 0 AND p.archived = 0",
    )
    .bind(deck_id)
    .bind(owner)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or(AppError::NotFound("deck"))
}

/// The container holding a main deck's swappable spares, when one is linked: (id, name).
pub async fn linked(conn: &mut SqliteConnection, owner: &str, main_id: &str) -> AppResult<Option<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT c.id, c.name FROM decks d JOIN containers c ON c.id = d.spares_container_id AND c.owner_id = d.owner_id
         WHERE d.id = ? AND d.owner_id = ?",
    )
    .bind(main_id)
    .bind(owner)
    .fetch_optional(&mut *conn)
    .await?)
}

/// Make `container_id` the main deck's swappable spares. Refused: a container that isn't theirs,
/// a deck box (the 100 live there), and one holding another live deck's spares. An archived deck
/// that held it lets go of it. No copy moves.
pub async fn link(conn: &mut SqliteConnection, owner: &str, main_id: &str, container_id: &str) -> AppResult<()> {
    let (kind, name): (String, String) = sqlx::query_as("SELECT kind, name FROM containers WHERE id = ? AND owner_id = ?")
        .bind(container_id)
        .bind(owner)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or(AppError::NotFound("container"))?;
    let boxed: Option<String> = sqlx::query_scalar("SELECT name FROM decks WHERE owner_id = ? AND archived = 0 AND container_id = ? LIMIT 1")
        .bind(owner)
        .bind(container_id)
        .fetch_optional(&mut *conn)
        .await?;
    if kind == "deck" || boxed.is_some() {
        return Err(AppError::bad(format!(
            "{name} is {}'s deck box, where its 100 cards are. Swappable spares go in a box, binder or list of their own.",
            boxed.as_deref().unwrap_or("a deck")
        )));
    }
    let holder: Option<(String, String, bool)> = sqlx::query_as("SELECT id, name, archived FROM decks WHERE owner_id = ? AND spares_container_id = ?")
        .bind(owner)
        .bind(container_id)
        .fetch_optional(&mut *conn)
        .await?;
    match holder {
        Some((id, _, _)) if id == main_id => return Ok(()),
        Some((_, deck, false)) => return Err(AppError::Conflict(format!("{name} already holds {deck}'s swappable spares."))),
        Some((id, _, true)) => {
            sqlx::query("UPDATE decks SET spares_container_id = NULL WHERE id = ? AND owner_id = ?").bind(id).bind(owner).execute(&mut *conn).await?;
        }
        None => {}
    }
    sqlx::query("UPDATE decks SET spares_container_id = ? WHERE id = ? AND owner_id = ?").bind(container_id).bind(main_id).bind(owner).execute(&mut *conn).await?;
    Ok(())
}

/// [`link`] when the main deck has no spares yet and the container is free to be them (not a deck
/// box, no live deck's spares); otherwise nothing. Returns whether it linked.
pub async fn adopt(conn: &mut SqliteConnection, owner: &str, main_id: &str, container_id: &str) -> AppResult<bool> {
    if linked(conn, owner, main_id).await?.is_some() {
        return Ok(false);
    }
    let taken: Option<String> = sqlx::query_scalar(
        "SELECT c.id FROM containers c WHERE c.id = ?2 AND c.owner_id = ?1
           AND (c.kind = 'deck' OR EXISTS (SELECT 1 FROM decks d WHERE d.owner_id = ?1 AND d.archived = 0 AND (d.container_id = c.id OR d.spares_container_id = c.id)))",
    )
    .bind(owner)
    .bind(container_id)
    .fetch_optional(&mut *conn)
    .await?;
    if taken.is_some() {
        return Ok(false);
    }
    link(conn, owner, main_id, container_id).await?;
    Ok(true)
}

/// Stop treating the main deck's spares container as its spares. The container and its copies stay.
pub async fn unlink(conn: &mut SqliteConnection, owner: &str, main_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE decks SET spares_container_id = NULL WHERE id = ? AND owner_id = ?").bind(main_id).bind(owner).execute(&mut *conn).await?;
    Ok(())
}

/// Their box called "<deck> swap bag" that no live deck keeps its 100 or its spares in: (id, name).
pub async fn free_bag(conn: &mut SqliteConnection, owner: &str, deck_name: &str) -> AppResult<Option<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT c.id, c.name FROM containers c WHERE c.owner_id = ?1 AND c.kind = 'box' AND lower(c.name) = lower(?2)
           AND NOT EXISTS (SELECT 1 FROM decks d WHERE d.owner_id = ?1 AND d.archived = 0 AND (d.spares_container_id = c.id OR d.container_id = c.id))
         ORDER BY c.name = ?2 DESC, c.created_at LIMIT 1",
    )
    .bind(owner)
    .bind(default_name(deck_name))
    .fetch_optional(&mut *conn)
    .await?)
}

/// The main deck's spares container, linked or made: the one linked, else their box called
/// "<deck> swap bag" when no live deck's spares are in it, else a new box by that name (with
/// " (2)" and so on when the name is taken). Returns (id, name, made).
pub async fn ensure(conn: &mut SqliteConnection, owner: &str, main_id: &str, deck_name: &str) -> AppResult<(String, String, bool)> {
    if let Some((id, name)) = linked(conn, owner, main_id).await? {
        return Ok((id, name, false));
    }
    let base = default_name(deck_name);
    let found = free_bag(conn, owner, deck_name).await?;
    if let Some((id, name)) = found {
        link(conn, owner, main_id, &id).await?;
        return Ok((id, name, false));
    }
    let have: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers WHERE owner_id = ?").bind(owner).fetch_one(&mut *conn).await?;
    if have >= CONTAINERS_MAX {
        return Err(AppError::Conflict(format!("You already have {CONTAINERS_MAX} binders, boxes and lists. Delete one you no longer use first.")));
    }
    let mut name = base.clone();
    for n in 2.. {
        let taken: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE owner_id = ? AND kind = 'box' AND name = ?").bind(owner).bind(&name).fetch_optional(&mut *conn).await?;
        if taken.is_none() {
            break;
        }
        name = format!("{base} ({n})");
    }
    let id = new_id();
    sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?,?,'box',?,?)").bind(&id).bind(owner).bind(&name).bind(now()).execute(&mut *conn).await?;
    link(conn, owner, main_id, &id).await?;
    Ok((id, name, true))
}

/// What a spare swaps for.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct SpareSwap {
    /// The card it comes in for.
    pub out: Option<String>,
    /// The Commander bracket the swap is for.
    pub bracket: Option<i64>,
    pub note: Option<String>,
    /// "plan": the plan's bracket bag; "owner": their own note.
    pub from: &'static str,
}

/// One card in the spares, its copies summed over printings.
#[derive(Serialize, Debug)]
pub struct SpareCard {
    pub oracle_id: String,
    pub name: String,
    pub qty: i64,
    pub proxies: i64,
    pub image_small: Option<String>,
    pub swaps: Vec<SpareSwap>,
}

/// A card the plan's bracket bags put in the spares that isn't there.
#[derive(Serialize, Debug)]
pub struct Missing {
    pub name: String,
    pub swaps: Vec<SpareSwap>,
}

#[derive(Serialize, Debug)]
pub struct Spares {
    /// The main deck (a configuration's spares are its main deck's).
    pub deck_id: String,
    pub deck_name: String,
    pub container_id: Option<String>,
    pub container_name: Option<String>,
    /// How the collection names these copies.
    pub place: String,
    pub copies: i64,
    pub cards: Vec<SpareCard>,
    pub planned_missing: Vec<Missing>,
}

/// The plan's bracket bags for a main deck: card coming back in (its name lowered) -> (its name as
/// the plan wrote it, its swaps).
async fn plan_bags(conn: &mut SqliteConnection, owner: &str, main_id: &str) -> AppResult<BTreeMap<String, (String, Vec<SpareSwap>)>> {
    let brackets: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT pd.bracket FROM plan_decks pd LEFT JOIN decks d ON d.id = pd.deck_id AND d.owner_id = pd.owner_id
         WHERE pd.owner_id = ?1 AND pd.status != 'archived'
           AND (pd.deck_id = ?2 OR d.parent_id = ?2
                -- An unlinked plan deck goes by name, as the plan's installed check and Swap in the
                -- prints read it: the one live main deck with its name.
                OR (pd.deck_id IS NULL AND lower(pd.name) = (SELECT lower(m.name) FROM decks m WHERE m.id = ?2 AND m.owner_id = ?1)
                    AND (SELECT COUNT(*) FROM decks x WHERE x.owner_id = ?1 AND x.archived = 0 AND x.parent_id IS NULL AND lower(x.name) = lower(pd.name)) = 1))
         ORDER BY pd.deck_id = ?2 DESC, pd.sort, pd.key",
    )
    .bind(owner)
    .bind(main_id)
    .fetch_all(&mut *conn)
    .await?;
    let mut out: BTreeMap<String, (String, Vec<SpareSwap>)> = BTreeMap::new();
    for b in brackets.into_iter().flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&b) else { continue };
        for (k, bag) in crate::plan::model::bracket_bags(Some(&v)) {
            let Some(card) = bag.get("in").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else { continue };
            let swap = SpareSwap { out: bag.get("out").and_then(Value::as_str).map(String::from), bracket: k.parse().ok(), note: None, from: "plan" };
            let (_, list) = out.entry(card.to_lowercase()).or_insert_with(|| (card.to_string(), Vec::new()));
            if !list.contains(&swap) {
                list.push(swap);
            }
        }
    }
    Ok(out)
}

/// A deck's swappable spares (a configuration answers with its main deck's).
pub async fn view(pool: &SqlitePool, owner: &str, deck_id: &str) -> AppResult<Spares> {
    let mut conn = pool.acquire().await?;
    let (main_id, deck_name) = main_deck(&mut conn, owner, deck_id).await?;
    let linked = linked(&mut conn, owner, &main_id).await?;
    let mut bags = plan_bags(&mut conn, owner, &main_id).await?;
    let notes: Vec<(String, Option<String>, Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT oracle_id, swaps_out, bracket, note FROM deck_spare_swaps WHERE owner_id = ? AND deck_id = ?").bind(owner).bind(&main_id).fetch_all(&mut *conn).await?;
    let mut cards = Vec::new();
    let mut copies = 0;
    if let Some((cid, _)) = &linked {
        type Row = (String, String, i64, i64, Option<String>);
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT p.oracle_id, MIN(p.name), SUM(i.qty), SUM(CASE WHEN i.proxy = 1 THEN i.qty ELSE 0 END), MIN(p.image_small)
             FROM collection_items i JOIN printings p ON p.scryfall_id = i.scryfall_id
             WHERE i.owner_id = ? AND i.container_id = ? AND i.qty > 0
             GROUP BY p.oracle_id ORDER BY MIN(p.name)",
        )
        .bind(owner)
        .bind(cid)
        .fetch_all(&mut *conn)
        .await?;
        copies = sqlx::query_scalar("SELECT IFNULL(SUM(qty), 0) FROM collection_items WHERE owner_id = ? AND container_id = ?").bind(owner).bind(cid).fetch_one(&mut *conn).await?;
        for (oracle_id, name, qty, proxies, image_small) in rows {
            let mut swaps: Vec<SpareSwap> = notes
                .iter()
                .filter(|n| n.0 == oracle_id)
                .map(|n| SpareSwap { out: n.1.clone(), bracket: n.2, note: n.3.clone(), from: "owner" })
                .collect();
            // A double-faced card's bag entry may name its front face only.
            let front = name.split(" // ").next().unwrap_or(&name).to_lowercase();
            swaps.extend(bags.remove(&name.to_lowercase()).or_else(|| bags.remove(&front)).map(|b| b.1).unwrap_or_default());
            cards.push(SpareCard { oracle_id, name, qty, proxies, image_small, swaps });
        }
    }
    let planned_missing = bags.into_values().map(|(name, swaps)| Missing { name, swaps }).collect();
    Ok(Spares {
        place: place(&deck_name),
        deck_id: main_id,
        deck_name,
        container_id: linked.as_ref().map(|l| l.0.clone()),
        container_name: linked.map(|l| l.1),
        copies,
        cards,
        planned_missing,
    })
}

#[derive(Deserialize)]
struct SetSpares {
    /// Link this container; null unlinks.
    #[serde(default, deserialize_with = "some_or_null")]
    container_id: Option<Option<String>>,
    #[serde(default)]
    create: bool,
}

fn some_or_null<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}

async fn get_spares(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<Spares>> {
    Ok(Json(view(&st.pool, &user.id, &id).await?))
}

async fn put_spares(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, Json(body): Json<SetSpares>) -> AppResult<Json<Spares>> {
    st.limits.collection_writes.check_user(&user)?;
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let (main_id, name) = main_deck(&mut tx, &user.id, &id).await?;
    match (body.create, body.container_id) {
        (true, None) => {
            ensure(&mut tx, &user.id, &main_id, &name).await?;
        }
        (false, Some(Some(c))) => link(&mut tx, &user.id, &main_id, &c).await?,
        (false, Some(None)) => unlink(&mut tx, &user.id, &main_id).await?,
        _ => return Err(AppError::bad("Send {\"create\": true}, {\"container_id\": \"…\"} or {\"container_id\": null}.")),
    }
    tx.commit().await?;
    Ok(Json(view(&st.pool, &user.id, &id).await?))
}

#[derive(Deserialize)]
struct SetSwap {
    oracle_id: String,
    swaps_out: Option<String>,
    bracket: Option<i64>,
    note: Option<String>,
}

/// A short line of typed text: trimmed, none when blank; refused when it has line breaks or control
/// characters or runs past `max` characters.
pub fn short_text(field: &str, raw: Option<&str>, max: usize) -> AppResult<Option<String>> {
    let Some(t) = raw.map(str::trim).filter(|t| !t.is_empty()) else { return Ok(None) };
    if t.chars().any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')) {
        return Err(AppError::bad(format!("{field} can't hold line breaks or control characters")));
    }
    if t.chars().count() > max {
        return Err(AppError::bad(format!("{field} can have at most {max} characters")));
    }
    Ok(Some(t.to_string()))
}

/// Set (or, with nothing given, clear) what one card in a main deck's spares swaps for.
pub async fn set_swap(conn: &mut SqliteConnection, owner: &str, main_id: &str, oracle_id: &str, swaps_out: Option<&str>, bracket: Option<i64>, note: Option<&str>) -> AppResult<()> {
    let known: Option<String> = sqlx::query_scalar("SELECT oracle_id FROM cards WHERE oracle_id = ?").bind(oracle_id).fetch_optional(&mut *conn).await?;
    if known.is_none() {
        return Err(AppError::NotFound("card"));
    }
    if bracket.is_some_and(|b| !(1..=5).contains(&b)) {
        return Err(AppError::bad("bracket must be from 1 to 5"));
    }
    let out = short_text("swaps_out", swaps_out, 200)?;
    let note = short_text("note", note, 300)?;
    if out.is_none() && bracket.is_none() && note.is_none() {
        sqlx::query("DELETE FROM deck_spare_swaps WHERE owner_id = ? AND deck_id = ? AND oracle_id = ?").bind(owner).bind(main_id).bind(oracle_id).execute(&mut *conn).await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO deck_spare_swaps (owner_id, deck_id, oracle_id, swaps_out, bracket, note, updated_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT (deck_id, oracle_id) DO UPDATE SET swaps_out = excluded.swaps_out, bracket = excluded.bracket, note = excluded.note, updated_at = excluded.updated_at
         WHERE deck_spare_swaps.owner_id = excluded.owner_id",
    )
    .bind(owner)
    .bind(main_id)
    .bind(oracle_id)
    .bind(out)
    .bind(bracket)
    .bind(note)
    .bind(now())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

async fn put_swap(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>, Json(body): Json<SetSwap>) -> AppResult<Json<Spares>> {
    st.limits.collection_writes.check_user(&user)?;
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let (main_id, _) = main_deck(&mut tx, &user.id, &id).await?;
    set_swap(&mut tx, &user.id, &main_id, &body.oracle_id, body.swaps_out.as_deref(), body.bracket, body.note.as_deref()).await?;
    tx.commit().await?;
    Ok(Json(view(&st.pool, &user.id, &id).await?))
}

#[cfg(test)]
mod tests;
