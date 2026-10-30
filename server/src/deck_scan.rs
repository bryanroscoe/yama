//! Scan a deck: the cards someone scanned from the physical deck become a new version of it.
//!
//! - **Check first** (`POST /api/decks/{id}/scan/check`, nothing saved): the scanned names are
//!   read the way an import reads them, then compared with the deck's current list (cards in,
//!   out and unchanged, by copies of each card across the commander and main deck) and given the
//!   Commander checks of the deck page (`decks::validate`: 100 cards, singleton, color identity,
//!   legality). The current version's id comes back as `based_on`.
//! - **Save** (`POST /api/decks/{id}/scan`): a new version, never an overwrite. With `make_current`
//!   it becomes the deck's list, so plan pages read installs from it (`plan::installed`), and the
//!   list it replaces stays in History ("Restore this list" switches back). Without, it is saved
//!   in History only and the deck, its plan and its outside check are untouched. A list the same
//!   as the current one saves nothing. If the deck's list changed since the check (`based_on`),
//!   saving is refused (409) rather than replacing, or building on, a list nobody compared.
//! - The scan covers the commander and main deck only; the current version's sideboard is kept.
//! - Idempotent by `op_id` (`applied_ops`, kind `deck.scan`): a retry gets the first answer, the
//!   same op_id for another list is refused.
//! - The collection isn't touched. After a scan becomes the list, "Add to my collection"
//!   (`collection::deck_box`) previews and fills the deck's box; it counts copies of a card in
//!   the box in any printing, so cards already there are never added twice.

use crate::auth::CurrentUser;
use crate::decks::{Board, DeckCard, Validation, owned_deck};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::now;
use axum::extract::{Path, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::BTreeMap;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/decks/{id}/scan/check", post(check)).route("/api/decks/{id}/scan", post(save))
}

/// The most lines and copies a scan may send: a Commander deck is 100 cards.
const MAX_LINES: usize = 300;
const MAX_COPIES: i64 = 300;

/// One card as scanned: its name, how many copies were scanned, and whether it's the commander.
#[derive(Deserialize, Clone)]
pub(crate) struct ScanLine {
    name: String,
    qty: i64,
    #[serde(default)]
    commander: bool,
}

#[derive(Deserialize)]
struct CheckBody {
    cards: Vec<ScanLine>,
}

/// One card's copies before (the current list) and after (the scan).
#[derive(Serialize, Debug, Clone, PartialEq)]
pub(crate) struct Change {
    oracle_id: String,
    name: String,
    before: i64,
    after: i64,
}

/// What a scan changes in the commander and main deck, by copies of each card.
#[derive(Serialize, Debug, Default, PartialEq)]
pub(crate) struct Comparison {
    /// Cards with more copies in the scan; `after - before` copies go in.
    added: Vec<Change>,
    /// Cards with fewer copies in the scan; `before - after` copies come out.
    removed: Vec<Change>,
    /// Cards in both; `min(before, after)` copies stay.
    unchanged: Vec<Change>,
    commanders_before: Vec<String>,
    commanders_after: Vec<String>,
    /// The commander's cards differ (by oracle ID).
    commander_changed: bool,
}

impl Comparison {
    /// Compared by card, not by name: an older version may spell a card's name differently.
    fn same(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && !self.commander_changed
    }
}

#[derive(Serialize)]
struct CheckResult {
    /// The scan as Yama reads it: canonical names, merged, commander first.
    cards: Vec<DeckCard>,
    /// Names Yama doesn't know; saving is refused until they're fixed.
    unknown: Vec<String>,
    /// The deck's current version: send it back as `based_on` when saving.
    based_on: Option<String>,
    #[serde(flatten)]
    comparison: Comparison,
    /// Same cards as the current list: saving would add nothing.
    same: bool,
    /// Sideboard cards of the current list that the new version keeps.
    kept_sideboard: i64,
    validation: Validation,
}

/// Read scanned names into deck cards. Unknown names are returned, not dropped silently.
pub(crate) async fn resolve(pool: &SqlitePool, lines: &[ScanLine]) -> AppResult<(Vec<DeckCard>, Vec<String>)> {
    if lines.is_empty() {
        return Err(AppError::bad("no cards scanned yet"));
    }
    if lines.len() > MAX_LINES {
        return Err(AppError::bad(format!("a scan can have at most {MAX_LINES} different cards")));
    }
    let mut total = 0;
    for l in lines {
        if l.qty < 1 || l.name.trim().is_empty() || l.name.len() > 200 {
            return Err(AppError::bad("each card needs a name and at least one copy"));
        }
        // Each line is capped first, so the sum can't overflow (at most MAX_LINES × MAX_COPIES).
        if l.qty > MAX_COPIES {
            return Err(AppError::bad(format!("a scan can have at most {MAX_COPIES} cards")));
        }
        total += l.qty;
    }
    if total > MAX_COPIES {
        return Err(AppError::bad(format!("a scan can have at most {MAX_COPIES} cards")));
    }
    let names: Vec<String> = lines.iter().map(|l| l.name.trim().to_string()).collect();
    let ids = crate::cards::resolve_names(pool, &names).await?;
    let mut cards: Vec<DeckCard> = Vec::new();
    let mut unknown = Vec::new();
    for (l, name) in lines.iter().zip(&names) {
        let Some(oid) = ids.get(name) else {
            unknown.push(name.clone());
            continue;
        };
        let board = if l.commander { Board::Commander } else { Board::Main };
        if let Some(c) = cards.iter_mut().find(|c| &c.oracle_id == oid && c.board == board) {
            c.qty += l.qty;
        } else {
            let canonical: String = sqlx::query_scalar("SELECT name FROM cards WHERE oracle_id = ?").bind(oid).fetch_one(pool).await?;
            cards.push(DeckCard { oracle_id: oid.clone(), name: canonical, qty: l.qty, board });
        }
    }
    // A commander is one card; further copies are ordinary cards (and fail the singleton check).
    let mut extra = Vec::new();
    for c in cards.iter_mut().filter(|c| c.board == Board::Commander && c.qty > 1) {
        extra.push(DeckCard { qty: c.qty - 1, board: Board::Main, ..c.clone() });
        c.qty = 1;
    }
    for e in extra {
        match cards.iter_mut().find(|c| c.oracle_id == e.oracle_id && c.board == Board::Main) {
            Some(c) => c.qty += e.qty,
            None => cards.push(e),
        }
    }
    cards.sort_by(|a, b| (a.board != Board::Commander).cmp(&(b.board != Board::Commander)).then_with(|| a.name.cmp(&b.name)));
    Ok((cards, unknown))
}

/// Compare the commander and main deck of two lists, by copies of each card.
pub(crate) fn compare(before: &[DeckCard], after: &[DeckCard]) -> Comparison {
    let mut counts: BTreeMap<String, (String, i64, i64)> = BTreeMap::new();
    for (list, side) in [(before, 0), (after, 1)] {
        for c in list.iter().filter(|c| c.board != Board::Side) {
            let e = counts.entry(c.oracle_id.clone()).or_insert_with(|| (c.name.clone(), 0, 0));
            if side == 0 { e.1 += c.qty } else { e.2 += c.qty }
        }
    }
    let mut out = Comparison::default();
    for (oracle_id, (name, b, a)) in counts {
        let change = Change { oracle_id, name, before: b, after: a };
        if a > b {
            out.added.push(change.clone());
        } else if a < b {
            out.removed.push(change.clone());
        }
        if a.min(b) > 0 {
            out.unchanged.push(change);
        }
    }
    let commanders = |list: &[DeckCard]| {
        let mut names: Vec<String> = list.iter().filter(|c| c.board == Board::Commander).map(|c| c.name.clone()).collect();
        names.sort();
        names
    };
    out.commanders_before = commanders(before);
    out.commanders_after = commanders(after);
    let ids = |list: &[DeckCard]| {
        let mut ids: Vec<&str> = list.iter().filter(|c| c.board == Board::Commander).map(|c| c.oracle_id.as_str()).collect();
        ids.sort();
        ids
    };
    out.commander_changed = ids(before) != ids(after);
    for list in [&mut out.added, &mut out.removed, &mut out.unchanged] {
        list.sort_by(|x, y| x.name.cmp(&y.name));
    }
    out
}

async fn current_list(conn: &mut SqliteConnection, version: Option<&str>) -> AppResult<Vec<DeckCard>> {
    let Some(v) = version else { return Ok(vec![]) };
    let json: String = sqlx::query_scalar("SELECT cards FROM deck_versions WHERE id = ?").bind(v).fetch_one(&mut *conn).await?;
    Ok(serde_json::from_str(&json).map_err(anyhow::Error::from)?)
}

/// The scan plus the current list's sideboard: the cards a new version would hold.
fn with_sideboard(scanned: &[DeckCard], current: &[DeckCard]) -> Vec<DeckCard> {
    let mut cards = scanned.to_vec();
    cards.extend(current.iter().filter(|c| c.board == Board::Side).cloned());
    cards
}

async fn check(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<CheckBody>,
) -> AppResult<Json<CheckResult>> {
    st.limits.deck_writes.check_user(&user)?;
    let (_, based_on, _) = owned_deck(&st.pool, &user.id, &id).await?;
    let (cards, unknown) = resolve(&st.pool, &body.cards).await?;
    let current = current_list(&mut *st.pool.acquire().await?, based_on.as_deref()).await?;
    let comparison = compare(&current, &cards);
    let info = crate::decks::card_info(&st.pool, &cards).await?;
    let validation = crate::decks::validate(&cards, &info);
    Ok(Json(CheckResult {
        same: unknown.is_empty() && comparison.same(),
        kept_sideboard: current.iter().filter(|c| c.board == Board::Side).map(|c| c.qty).sum(),
        cards,
        unknown,
        based_on,
        comparison,
        validation,
    }))
}

#[derive(Deserialize)]
struct SaveBody {
    op_id: String,
    cards: Vec<ScanLine>,
    /// Make the scan the deck's list (else it's saved in History only).
    make_current: bool,
    /// The current version the person compared the scan with (`based_on` from the check).
    based_on: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Saved {
    /// The new version, or the current one when nothing changed.
    version_id: Option<String>,
    /// A new version was saved.
    changed: bool,
    /// The deck's list is now the scan.
    current: bool,
}

async fn save(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<SaveBody>,
) -> AppResult<Json<Saved>> {
    st.limits.deck_writes.check_user(&user)?;
    if body.op_id.trim().is_empty() || body.op_id.len() > 100 {
        return Err(AppError::bad("op_id is required"));
    }
    owned_deck(&st.pool, &user.id, &id).await?;
    let (scanned, unknown) = resolve(&st.pool, &body.cards).await?;
    if !unknown.is_empty() {
        return Err(AppError::bad(format!("Yama doesn't know {}; fix or remove them first", unknown.join(", "))));
    }
    // What this op asks for: a retry must ask for exactly the same.
    let mut key: Vec<(String, String, i64)> = scanned.iter().map(|c| (format!("{:?}", c.board), c.oracle_id.clone(), c.qty)).collect();
    key.sort();
    let target = serde_json::json!({ "deck": id, "cards": key, "make_current": body.make_current });

    let mut tx = st.pool.begin().await?;
    let done: Option<(String, String)> = sqlx::query_as("SELECT kind, payload FROM applied_ops WHERE op_id = ? AND owner_id = ?")
        .bind(&body.op_id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some((kind, payload)) = done {
        let stored: serde_json::Value = serde_json::from_str(&payload).map_err(anyhow::Error::from)?;
        if kind != "deck.scan" || stored["target"] != target {
            return Err(AppError::Conflict("that op_id was used for something else".into()));
        }
        return Ok(Json(serde_json::from_value(stored["saved"].clone()).map_err(anyhow::Error::from)?));
    }
    // Read the current list inside the transaction, so the comparison below is the one saved over.
    let current_id: Option<String> = sqlx::query_scalar("SELECT current_version_id FROM decks WHERE id = ? AND owner_id = ?")
        .bind(&id)
        .bind(&user.id)
        .fetch_one(&mut *tx)
        .await?;
    // Either way the new version is built from the current list (its sideboard), so it must be
    // the list the person compared the scan with.
    if current_id != body.based_on {
        return Err(AppError::Conflict("This deck's list changed since you checked the scan. Check the changes again before saving.".into()));
    }
    let current = current_list(&mut tx, current_id.as_deref()).await?;
    let cards = with_sideboard(&scanned, &current);
    let saved = if current_id.is_some() && compare(&current, &scanned).same() {
        Saved { version_id: current_id.clone(), changed: false, current: true }
    } else {
        let note = format!("Scanned from the deck ({} cards)", scanned.iter().map(|c| c.qty).sum::<i64>());
        if body.make_current {
            let vid = crate::decks::insert_version_in(&mut tx, &id, &cards, Some(&note)).await?;
            Saved { version_id: Some(vid), changed: true, current: true }
        } else {
            let (vid, _) = crate::decks::insert_saved_version_in(&mut tx, &id, &cards, Some(&note), true).await?;
            Saved { version_id: Some(vid), changed: true, current: false }
        }
    };
    let stored = serde_json::json!({ "target": target, "saved": saved });
    sqlx::query("INSERT INTO applied_ops (op_id, owner_id, kind, payload, applied_at) VALUES (?,?,?,?,?)")
        .bind(&body.op_id)
        .bind(&user.id)
        .bind("deck.scan")
        .bind(stored.to_string())
        .bind(now())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if saved.changed && saved.current {
        crate::deck_checks::wake();
    }
    Ok(Json(saved))
}

#[cfg(test)]
mod tests;
