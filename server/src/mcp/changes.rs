//! Staged changes (docs/mcp-design.md, slice 2): "recommend review before editing" as a rule.
//!
//! A write tool checks the requested change against the caller's own rows, then stores it in
//! `assistant_changes` as pending, with a one-line summary and the details a person needs to
//! decide. Nothing else changes. The person applies or discards it in Yama: under the answer in
//! the Ask Claude panel, or on Decks, Suggested changes. An outside client (a script key or an
//! OAuth sign-in) may also call `apply_change`, which its description limits to changes the
//! person said yes to; Ask Claude has no way to apply its own.
//!
//! Applying goes through the same code as the pages: a deck edit is a new deck version, plan
//! changes are the planner's own ops (so they reach the commander-decks repo through its pull like
//! a tap would), a lab run is the lab's create with its allowance, collection changes are
//! collection ops. Plan, lab and collection ops carry the change's id as their op id, so applying
//! twice can't do it twice. A deck edit is made against one version; if the deck has moved on, it
//! fails with the reason and stays pending.

use super::Via;
use super::tools::{card_info, checks, deck_id, near_names, precon_id, text_arg};
use crate::auth::{CurrentUser, User};
use crate::decks::{Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::fmt::Write as _;

mod preview;
use preview::ChangePreview;

/// Changes one account may have waiting at once.
pub const MAX_PENDING: i64 = 50;
/// Cards one deck edit or lab run may add and remove, together.
const MAX_CARDS: usize = 100;
/// The op ids and device id applied changes carry.
const DEVICE: &str = "claude";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/assistant/changes", get(list_route))
        .route("/api/assistant/changes/{id}/apply", post(apply_route))
        .route("/api/assistant/changes/{id}/discard", post(discard_route))
}

// ── the stored change ───────────────────────────────────────────────────────

#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    kind: String,
    summary: String,
    detail: Option<String>,
    payload: String,
    via: String,
    conversation_id: Option<String>,
    message_id: Option<String>,
    status: String,
    error: Option<String>,
    result: Option<String>,
    created_at: String,
    decided_at: Option<String>,
}

const ROW_COLUMNS: &str = "id, kind, summary, detail, payload, via, conversation_id, message_id, status, error, result, created_at, decided_at";

/// A change as the pages and `changes` show it. `result` is what applying made: a label and the
/// page that shows it.
#[derive(Debug, Serialize)]
pub struct ChangeView {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub detail: Option<String>,
    /// A safe presentation of the stored proposal, including proposals staged before this view existed.
    pub preview: Option<ChangePreview>,
    pub via: String,
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub result: Option<Value>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

impl From<Row> for ChangeView {
    fn from(r: Row) -> Self {
        let preview = preview::from_payload(&r.kind, &r.payload, r.detail.as_deref());
        ChangeView {
            id: r.id,
            kind: r.kind,
            summary: r.summary,
            detail: r.detail,
            preview,
            via: r.via,
            conversation_id: r.conversation_id,
            message_id: r.message_id,
            status: r.status,
            error: r.error,
            result: r.result.and_then(|s| serde_json::from_str(&s).ok()),
            created_at: r.created_at,
            decided_at: r.decided_at,
        }
    }
}

async fn load(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<Row> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {ROW_COLUMNS} FROM assistant_changes WHERE id = ? AND owner_id = ?")))
        .bind(id)
        .bind(owner)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("change"))
}

/// The owner's changes, newest first: pending ones, or every one (at most 100), or one
/// conversation's.
pub async fn list(pool: &SqlitePool, owner: &str, pending_only: bool, conversation: Option<&str>) -> AppResult<Vec<ChangeView>> {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {ROW_COLUMNS} FROM assistant_changes
         WHERE owner_id = ? AND (? = 0 OR status = 'pending') AND (? IS NULL OR conversation_id = ?)
         ORDER BY created_at DESC, rowid DESC LIMIT 100"
    )))
    .bind(owner)
    .bind(pending_only)
    .bind(conversation)
    .bind(conversation)
    .fetch_all(pool)
    .await?;
    let mut views: Vec<_> = rows.into_iter().map(ChangeView::from).collect();
    preview::enrich(pool, &mut views).await?;
    Ok(views)
}

async fn load_view(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<ChangeView> {
    let mut view = ChangeView::from(load(pool, owner, id).await?);
    preview::enrich(pool, std::slice::from_mut(&mut view)).await?;
    Ok(view)
}

/// What a write tool hands to [`stage`].
struct Staged {
    kind: &'static str,
    summary: String,
    detail: String,
    payload: Value,
}

/// Store a change as pending and tell Claude what happens next.
async fn stage(st: &AppState, user: &User, via: &Via, s: Staged) -> AppResult<String> {
    let pool = &st.pool;
    let waiting: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM assistant_changes WHERE owner_id = ? AND status = 'pending'").bind(&user.id).fetch_one(pool).await?;
    if waiting >= MAX_PENDING {
        return Err(AppError::bad(format!(
            "{waiting} changes are already waiting for their review, the most Yama keeps. Ask them to apply or discard some first."
        )));
    }
    let id = new_id();
    let (conversation, message) = match via {
        Via::Question(q) => (Some(q.conversation_id.as_str()), Some(q.message_id.as_str())),
        _ => (None, None),
    };
    sqlx::query(
        "INSERT INTO assistant_changes (id, owner_id, kind, summary, detail, payload, via, conversation_id, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&user.id)
    .bind(s.kind)
    .bind(&s.summary)
    .bind(Some(s.detail.trim()).filter(|d| !d.is_empty()))
    .bind(s.payload.to_string())
    .bind(via.as_str())
    .bind(conversation)
    .bind(message)
    .bind(now())
    .execute(pool)
    .await?;
    let mut out = format!("Staged for their review; nothing has changed yet.\nChange: {}\n", s.summary);
    if !s.detail.trim().is_empty() {
        let _ = writeln!(out, "{}", s.detail.trim());
    }
    let _ = writeln!(out, "Change id: {id}");
    let page = st.cfg.public_url.as_deref().map(|u| format!("{}/decks/changes", u.trim_end_matches('/'))).unwrap_or_else(|| "Decks, Suggested changes".into());
    match via {
        Via::Question(_) => out.push_str(
            "It shows under your answer with Apply and Discard buttons. Say that it's waiting for their review; never say it's done.",
        ),
        _ => {
            let _ = write!(
                out,
                "They can apply or discard it in Yama ({page}). If they say yes to this change in this conversation, you may call apply_change with its id."
            );
        }
    }
    Ok(out)
}

// ── arguments ───────────────────────────────────────────────────────────────

/// A list of card names (at most `MAX_CARDS`); missing means none.
fn names_arg(args: &Value, key: &str) -> AppResult<Vec<String>> {
    let Some(v) = args.get(key).filter(|v| !v.is_null()) else { return Ok(vec![]) };
    let arr = v.as_array().ok_or_else(|| AppError::bad(format!("{key} must be a list of card names")))?;
    if arr.len() > MAX_CARDS {
        return Err(AppError::bad(format!("{key}: at most {MAX_CARDS} cards at a time")));
    }
    arr.iter()
        .map(|n| n.as_str().map(str::trim).filter(|n| !n.is_empty() && n.len() <= 200).map(String::from).ok_or_else(|| AppError::bad(format!("{key} must be a list of card names"))))
        .collect()
}

fn opt_text(args: &Value, key: &str, max: usize) -> AppResult<Option<String>> {
    match args.get(key).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) if s.chars().count() > max => Err(AppError::bad(format!("{key}: at most {max} characters"))),
        Some(Value::String(s)) => Ok(Some(s.trim().to_string())),
        Some(_) => Err(AppError::bad(format!("{key} must be text"))),
    }
}

/// Names to oracle ids and canonical names. Any name Yama doesn't know is an error naming close
/// ones, so Claude can correct it.
async fn known_cards(pool: &SqlitePool, names: &[String]) -> AppResult<HashMap<String, (String, String)>> {
    let ids = crate::cards::resolve_names(pool, names).await?;
    let mut out = HashMap::new();
    let mut unknown = Vec::new();
    for n in names {
        match ids.get(n) {
            Some(oid) => {
                let name: String = sqlx::query_scalar("SELECT name FROM cards WHERE oracle_id = ?").bind(oid).fetch_one(pool).await?;
                out.insert(n.clone(), (oid.clone(), name));
            }
            None => {
                let near = near_names(pool, n).await?;
                unknown.push(if near.is_empty() { format!("\"{n}\"") } else { format!("\"{n}\" (close: {})", near.join(", ")) });
            }
        }
    }
    if !unknown.is_empty() {
        return Err(AppError::bad(format!("Yama doesn't know {}. Nothing was staged.", unknown.join("; "))));
    }
    Ok(out)
}

// ── edit_deck ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CardRef {
    oracle_id: String,
    name: String,
}

/// The list after removing one copy of each of `remove` from the main deck and adding one copy of
/// each of `add`. The commander can't be removed here.
fn edit_list(mut cards: Vec<DeckCard>, add: &[CardRef], remove: &[CardRef], deck: &str) -> Result<Vec<DeckCard>, String> {
    for r in remove {
        match cards.iter().position(|c| c.oracle_id == r.oracle_id && c.board == Board::Main) {
            Some(i) => {
                cards[i].qty -= 1;
                if cards[i].qty <= 0 {
                    cards.remove(i);
                }
            }
            None if cards.iter().any(|c| c.oracle_id == r.oracle_id && c.board == Board::Commander) => {
                return Err(format!("{} is the commander of {deck}; change commanders in the deck's editor", r.name));
            }
            None => return Err(format!("{} isn't in {deck}", r.name)),
        }
    }
    for a in add {
        match cards.iter_mut().find(|c| c.oracle_id == a.oracle_id && c.board == Board::Main) {
            Some(c) => c.qty += 1,
            None => cards.push(DeckCard { oracle_id: a.oracle_id.clone(), name: a.name.clone(), qty: 1, board: Board::Main }),
        }
    }
    Ok(cards)
}

/// Commander problems `after` has that `before` didn't, and the card data both were checked with.
/// An edit may leave a problem the list already had, but not make a new one. A wrong size is one
/// problem whatever the count, so a deck still being built can grow.
async fn new_problems(pool: &SqlitePool, before: &[DeckCard], after: &[DeckCard]) -> AppResult<(Vec<String>, HashMap<String, crate::cards::Card>)> {
    let info = card_info(pool, &[before, after].concat()).await?;
    let size = |e: &String| e.ends_with("Commander decks have exactly 100 including the commander");
    let had = crate::decks::validate(before, &info).errors;
    let new = crate::decks::validate(after, &info).errors.into_iter().filter(|e| !had.contains(e) && !(size(e) && had.iter().any(size))).collect();
    Ok((new, info))
}

fn edit_summary(deck: &str, add: &[CardRef], remove: &[CardRef]) -> String {
    let mut parts: Vec<String> = add.iter().map(|c| format!("+{}", c.name)).collect();
    parts.extend(remove.iter().map(|c| format!("\u{2212}{}", c.name)));
    format!("{deck}: {}", parts.join(", "))
}

pub async fn edit_deck(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let id = deck_id(pool, &user.id, text_arg(args, "deck")?).await?;
    let (name, version): (String, Option<String>) =
        sqlx::query_as("SELECT name, current_version_id FROM decks WHERE id = ? AND owner_id = ?").bind(&id).bind(&user.id).fetch_one(pool).await?;
    let version = version.ok_or_else(|| AppError::bad(format!("{name} has no list yet")))?;
    let (add, remove) = (names_arg(args, "add")?, names_arg(args, "remove")?);
    if add.is_empty() && remove.is_empty() {
        return Err(AppError::bad("Name at least one card to add or remove."));
    }
    if add.len() + remove.len() > MAX_CARDS {
        return Err(AppError::bad(format!("At most {MAX_CARDS} cards in one change.")));
    }
    let known = known_cards(pool, &[add.clone(), remove.clone()].concat()).await?;
    let refs = |names: &[String]| -> Vec<CardRef> { names.iter().map(|n| CardRef { oracle_id: known[n].0.clone(), name: known[n].1.clone() }).collect() };
    let (add, remove) = (refs(&add), refs(&remove));
    let current = crate::decks::load_version_cards(pool, &version).await?;
    let after = edit_list(current.clone(), &add, &remove, &name).map_err(|e| AppError::bad(format!("{e}. Nothing was staged.")))?;
    let (new, info) = new_problems(pool, &current, &after).await?;
    if !new.is_empty() {
        return Err(AppError::bad(format!("That would break the deck: {}. Nothing was staged.", new.join("; "))));
    }
    let note = opt_text(args, "note", 500)?;
    let mut detail = String::new();
    if let Some(n) = &note {
        let _ = writeln!(detail, "Why: {n}");
    }
    let _ = write!(detail, "The list after:\n{}", checks(&after, &info));
    stage(
        st,
        user,
        via,
        Staged {
            kind: "edit_deck",
            summary: edit_summary(&name, &add, &remove),
            detail,
            payload: json!({"deck_id": id, "deck": name, "base_version": version, "add": add, "remove": remove, "note": note}),
        },
    )
    .await
}

async fn apply_edit_deck(st: &AppState, user: &User, summary: &str, p: &Value) -> AppResult<Value> {
    let pool = &st.pool;
    let deck_id = p["deck_id"].as_str().unwrap_or_default();
    let deck = p["deck"].as_str().unwrap_or("the deck");
    let row: Option<(Option<String>, bool)> =
        sqlx::query_as("SELECT current_version_id, archived FROM decks WHERE id = ? AND owner_id = ?").bind(deck_id).bind(&user.id).fetch_optional(pool).await?;
    let current = match row {
        None | Some((_, true)) => return Err(AppError::Conflict(format!("{deck} isn't in your decks any more."))),
        Some((v, false)) => v,
    };
    if current.as_deref() != p["base_version"].as_str() {
        return Err(AppError::Conflict(format!(
            "{deck} changed after this was suggested, so it wasn't applied. Discard it and ask again for a change to the current list."
        )));
    }
    let add: Vec<CardRef> = serde_json::from_value(p["add"].clone()).map_err(anyhow::Error::from)?;
    let remove: Vec<CardRef> = serde_json::from_value(p["remove"].clone()).map_err(anyhow::Error::from)?;
    let cards = crate::decks::load_version_cards(pool, current.as_deref().unwrap_or_default()).await?;
    let after = edit_list(cards.clone(), &add, &remove, deck).map_err(AppError::Conflict)?;
    let (new, _) = new_problems(pool, &cards, &after).await?;
    if !new.is_empty() {
        return Err(AppError::Conflict(format!("Not applied: it would break {deck}: {}.", new.join("; "))));
    }
    st.limits.deck_writes.check_user(user)?;
    let note = format!("Suggested change: {}", p["note"].as_str().unwrap_or(summary));
    crate::decks::insert_version(pool, deck_id, &after, Some(&note)).await?;
    Ok(json!({"label": format!("{deck} has a new version"), "link": format!("/decks/{deck_id}")}))
}

// ── complete deck lists ─────────────────────────────────────────────────────

/// Complete-list construction/import/restore uses the existing edit_deck change kind. The
/// payload distinguishes it from add/remove edits, so no migration or second review queue is
/// needed. The list is pinned at staging, never fetched again during Apply.
pub async fn save_deck(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    use super::research::{analysis, optional_text, required_text};
    if args.get("version").is_some() {
        return Err(AppError::bad(
            "Inspect the historical version first, then pass its complete list to save_deck.",
        ));
    }
    let text = required_text(args, "list", 30000)?;
    let first = super::research::boolean(args, "first_is_commander", true)?;
    let list = analysis::load(st, user, &json!({"list":text,"first_is_commander":first})).await?;
    if !list.unknown.is_empty() {
        return Err(AppError::bad(format!(
            "Unknown names: {}. Nothing was staged.",
            list.unknown.join(", ")
        )));
    }
    let info = card_info(&st.pool, &list.cards).await?;
    let validation = crate::decks::validate(&list.cards, &info);
    if !validation.errors.is_empty() || !validation.warnings.is_empty() {
        return Err(AppError::bad(format!(
            "The complete list is not validated: {}. Nothing was staged.",
            [validation.errors, validation.warnings].concat().join("; ")
        )));
    }
    let (target, base, name) = if let Some(deck) = optional_text(args, "deck", 200)? {
        let id = deck_id(&st.pool, &user.id, deck).await?;
        let (name, version): (String, Option<String>) = sqlx::query_as(
            "SELECT name,current_version_id FROM decks WHERE id = ? AND owner_id = ?",
        )
        .bind(&id)
        .bind(&user.id)
        .fetch_one(&st.pool)
        .await?;
        (Some(id), version, name)
    } else {
        (None, None, required_text(args, "name", 200)?.into())
    };
    let note = optional_text(args, "note", 1000)?
        .unwrap_or("Complete list proposed through Yama")
        .to_string();
    let source = optional_text(args, "source_url", 1000)?
        .map(|raw| super::research::deck_url(raw).map(|(_, _, url)| url))
        .transpose()?;
    let summary = format!(
        "{} {name} with a complete validated list",
        if target.is_some() {
            "Replace"
        } else {
            "Create"
        }
    );
    let detail = format!(
        "Why: {note}\n{}\n{}\n{}",
        source
            .as_deref()
            .map(|s| format!("Source: {s}"))
            .unwrap_or_default(),
        checks(&list.cards, &info),
        analysis::exported(&list.cards)
    );
    stage(st,user,via,Staged {kind:"edit_deck",summary,detail,payload:json!({"complete_list":true,"deck_id":target,"base_version":base,"name":name,"cards":list.cards,"note":note,"source_url":source})}).await
}

async fn apply_complete_deck(
    st: &AppState,
    user: &User,
    change: &str,
    p: &Value,
) -> AppResult<Value> {
    let cards: Vec<DeckCard> =
        serde_json::from_value(p["cards"].clone()).map_err(anyhow::Error::from)?;
    let info = card_info(&st.pool, &cards).await?;
    let v = crate::decks::validate(&cards, &info);
    if !v.errors.is_empty() || !v.warnings.is_empty() {
        return Err(AppError::Conflict(format!(
            "The list no longer validates: {}",
            [v.errors, v.warnings].concat().join("; ")
        )));
    }
    st.limits.deck_writes.check_user(user)?;
    let note = format!(
        "Suggested change: {}{}",
        p["note"].as_str().unwrap_or("Complete list"),
        p["source_url"]
            .as_str()
            .map(|s| format!("\nSource: {s}"))
            .unwrap_or_default()
    );
    let mut tx = st.pool.begin().await?;
    let id = if let Some(id) = p["deck_id"].as_str() {
        let row: Option<(Option<String>, bool)> = sqlx::query_as(
            "SELECT current_version_id,archived FROM decks WHERE id = ? AND owner_id = ?",
        )
        .bind(id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((version, false)) = row else {
            return Err(AppError::NotFound("deck"));
        };
        if version.as_deref() != p["base_version"].as_str() {
            return Err(AppError::Conflict("The deck changed after this list was staged. Review a new proposal against its current version.".into()));
        }
        crate::decks::insert_version_in(&mut tx, id, &cards, Some(&note)).await?;
        id.to_string()
    } else {
        crate::decks::create_deck_in(
            &mut tx,
            &user.id,
            p["name"].as_str().unwrap_or(""),
            None,
            &cards,
            &note,
        )
        .await?
    };
    let result = json!({"label":format!("{} saved",p["name"].as_str().unwrap_or("Deck")),"link":format!("/decks/{id}"),"deck_id":id});
    // The deck and the applied marker commit together: a lost reply cannot create it twice.
    let updated=sqlx::query("UPDATE assistant_changes SET status='applied',result=?,error=NULL,decided_at=? WHERE id=? AND owner_id=? AND status='pending'")
        .bind(result.to_string()).bind(now()).bind(change).bind(&user.id).execute(&mut *tx).await?;
    if updated.rows_affected() != 1 {
        return Err(AppError::Conflict(
            "The proposal is no longer pending; the deck was not saved.".into(),
        ));
    }
    tx.commit().await?;
    crate::deck_checks::wake();
    Ok(result)
}

// ── plan changes ────────────────────────────────────────────────────────────

/// The caller's plan deck by key or name: (key, name).
async fn plan_deck(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<(String, String)> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT key, name FROM plan_decks WHERE owner_id = ?1 AND status != 'archived'
           AND (key = ?2 OR lower(name) = lower(?2) OR instr(lower(name), lower(?2)) > 0)
         ORDER BY key = ?2 DESC, lower(name) = lower(?2) DESC, key LIMIT 10",
    )
    .bind(owner)
    .bind(wanted)
    .fetch_all(pool)
    .await?;
    match rows.as_slice() {
        [] => Err(AppError::NotFound("plan deck")),
        [one] => Ok(one.clone()),
        [first, ..] if first.0 == wanted || first.1.eq_ignore_ascii_case(wanted) => Ok(first.clone()),
        many => Err(AppError::bad(format!("Several plans match \"{wanted}\": {}. Say which.", many.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(", ")))),
    }
}

/// A live swap in one plan deck, named by the card that goes in and (when several swaps put the
/// same card in) the card that comes out.
struct SwapRef {
    key: String,
    deck_key: String,
    deck: String,
    card_in: String,
    card_out: Option<String>,
}

impl SwapRef {
    fn label(&self) -> String {
        match &self.card_out {
            Some(o) => format!("{} for {}", self.card_in, o),
            None => format!("{} (nothing comes out)", self.card_in),
        }
    }
}

async fn find_swap(pool: &SqlitePool, owner: &str, args: &Value) -> AppResult<SwapRef> {
    let (deck_key, deck) = plan_deck(pool, owner, text_arg(args, "plan")?).await?;
    let card_in = text_arg(args, "card_in")?;
    let card_out = opt_text(args, "card_out", 200)?;
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT s.ext_key, s.in_name, s.out_name FROM plan_swaps s JOIN plan_decks d ON d.id = s.plan_deck_id AND d.owner_id = s.owner_id
         WHERE s.owner_id = ? AND d.key = ? AND s.retired_at IS NULL AND lower(s.in_name) = lower(?)
           AND (? IS NULL OR lower(IFNULL(s.out_name, '')) = lower(?))
         ORDER BY s.stage, s.sort, s.ext_key",
    )
    .bind(owner)
    .bind(&deck_key)
    .bind(card_in)
    .bind(&card_out)
    .bind(&card_out)
    .fetch_all(pool)
    .await?;
    match rows.as_slice() {
        [] => Err(AppError::bad(format!(
            "{deck}'s plan has no swap putting in {card_in}{}. Check the card names with plan_deck.",
            card_out.as_deref().map(|o| format!(" for {o}")).unwrap_or_default()
        ))),
        [(key, card_in, card_out)] => Ok(SwapRef { key: key.clone(), deck_key, deck, card_in: card_in.clone(), card_out: card_out.clone() }),
        many => Err(AppError::bad(format!(
            "Several swaps in {deck}'s plan put in {card_in}; give card_out, one of: {}.",
            many.iter().map(|(_, _, o)| o.clone().unwrap_or_else(|| "(none)".into())).collect::<Vec<_>>().join(", ")
        ))),
    }
}

pub async fn propose_swap(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let (deck_key, deck) = plan_deck(pool, &user.id, text_arg(args, "plan")?).await?;
    let card_in = text_arg(args, "card_in")?.to_string();
    let card_out = opt_text(args, "card_out", 200)?;
    let why = opt_text(args, "why", 2000)?;
    let mut names = vec![card_in.clone()];
    names.extend(card_out.clone());
    let known = known_cards(pool, &names).await?;
    let card_in = known[&card_in].1.clone();
    let card_out = card_out.map(|o| known[&o].1.clone());
    let summary = match &card_out {
        Some(o) => format!("Idea for {deck}: {card_in} for {o}"),
        None => format!("Idea for {deck}: add {card_in}"),
    };
    stage(
        st,
        user,
        via,
        Staged {
            kind: "propose_swap",
            summary,
            detail: why.as_deref().map(|w| format!("Why: {w}")).unwrap_or_default(),
            payload: json!({"deck_key": deck_key, "deck": deck, "in": card_in, "out": card_out, "why": why}),
        },
    )
    .await
}

const DECISIONS: [(&str, &str); 3] = [("want", "Want"), ("unsure", "Not sure"), ("no", "No")];

pub async fn answer_review(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let swap = find_swap(&st.pool, &user.id, args).await?;
    let decision = text_arg(args, "decision")?;
    let label = DECISIONS.iter().find(|(d, _)| *d == decision).map(|(_, l)| *l).ok_or_else(|| AppError::bad("decision must be want, unsure or no"))?;
    let note = opt_text(args, "note", 2000)?;
    let cut = opt_text(args, "cut", 300)?;
    let mut detail = String::new();
    if let Some(c) = &cut {
        let _ = writeln!(detail, "Cut {c} instead.");
    }
    if let Some(n) = &note {
        let _ = writeln!(detail, "Note: {n}");
    }
    stage(
        st,
        user,
        via,
        Staged {
            kind: "answer_review",
            summary: format!("Review, {}: {label} for {}", swap.deck, swap.label()),
            detail,
            payload: json!({"swap_key": swap.key, "deck_key": swap.deck_key, "deck": swap.deck, "decision": decision, "note": note, "cut": cut}),
        },
    )
    .await
}

pub async fn mark_bought(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let swap = find_swap(&st.pool, &user.id, args).await?;
    let value = args.get("value").and_then(Value::as_bool).unwrap_or(true);
    let on = opt_text(args, "on", 10)?.unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());
    if !crate::plan::model::is_date(&on) {
        return Err(AppError::bad(format!("on: \"{on}\" isn't a YYYY-MM-DD date")));
    }
    let qty = args.get("qty").and_then(Value::as_i64).unwrap_or(1);
    if !(1..=100).contains(&qty) {
        return Err(AppError::bad("qty must be from 1 to 100"));
    }
    let price = args.get("price_paid").and_then(Value::as_f64).filter(|p| p.is_finite() && *p >= 0.0);
    let store = opt_text(args, "store", 200)?;
    let summary = if value {
        format!("Bought, {}: {}", swap.deck, swap.label())
    } else {
        format!("Not bought after all, {}: {}", swap.deck, swap.label())
    };
    let mut detail = String::new();
    if value {
        let _ = write!(detail, "On {on}, {qty} cop{}", if qty == 1 { "y" } else { "ies" });
        if let Some(p) = price {
            let _ = write!(detail, ", ${p:.2} paid");
        }
        if let Some(s) = &store {
            let _ = write!(detail, ", from {s}");
        }
        detail.push_str(". A bought mark is their claim; it doesn't record an order or change a list.");
    }
    stage(
        st,
        user,
        via,
        Staged {
            kind: "mark_bought",
            summary,
            detail,
            payload: json!({"swap_key": swap.key, "deck_key": swap.deck_key, "deck": swap.deck, "value": value, "on": on, "qty": qty, "price_paid": price, "store": store}),
        },
    )
    .await
}

pub async fn mark_installed(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let swap = find_swap(&st.pool, &user.id, args).await?;
    let value = args.get("value").and_then(Value::as_bool).unwrap_or(true);
    let summary = if value { format!("Installed, {}: {}", swap.deck, swap.label()) } else { format!("Not installed, {}: {}", swap.deck, swap.label()) };
    stage(
        st,
        user,
        via,
        Staged { kind: "mark_installed", summary, detail: String::new(), payload: json!({"swap_key": swap.key, "deck_key": swap.deck_key, "deck": swap.deck, "value": value}) },
    )
    .await
}

pub async fn swap_in_prints(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let (key, name) = plan_deck(&st.pool, &user.id, text_arg(args, "plan")?).await?;
    let preview = crate::plan::swap_in::run(&st.pool, &user.id, &key, true).await?;
    if preview.done {
        return Ok(preview.text());
    }
    stage(
        st,
        user,
        via,
        Staged {
            kind: "swap_in_prints",
            summary: format!("Swap the prints into {name}: {} proxies, {} cards moved, {} swaps ticked installed", preview.proxies_added, preview.moved, preview.ticks.len()),
            detail: preview.text(),
            payload: json!({"deck_key": key, "deck": name}),
        },
    )
    .await
}

/// The planner op a plan change becomes. Its op id is the change's, so it applies once.
fn plan_op(kind: &str, id: &str, p: &Value) -> Value {
    let at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let mut op = json!({"op_id": format!("{DEVICE}-{id}"), "device_id": DEVICE, "at": at});
    let o = op.as_object_mut().expect("an object");
    match kind {
        "propose_swap" => {
            o.insert("kind".into(), json!("idea"));
            o.insert("deck_key".into(), p["deck_key"].clone());
            o.insert("in".into(), p["in"].clone());
            o.insert("out".into(), p["out"].clone());
            o.insert("why".into(), p["why"].clone());
        }
        "answer_review" => {
            o.insert("kind".into(), json!("review"));
            o.insert("swap_key".into(), p["swap_key"].clone());
            o.insert("decision".into(), p["decision"].clone());
            o.insert("note".into(), p["note"].clone());
            o.insert("cut".into(), p["cut"].clone());
        }
        "mark_bought" => {
            o.insert("kind".into(), json!("bought"));
            o.insert("swap_key".into(), p["swap_key"].clone());
            o.insert("value".into(), p["value"].clone());
            o.insert("qty".into(), p["qty"].clone());
            o.insert("price_paid".into(), p["price_paid"].clone());
            o.insert("store_label".into(), p["store"].clone());
            if p["value"].as_bool() == Some(true) {
                o.insert("on".into(), p["on"].clone());
            }
        }
        _ => {
            o.insert("kind".into(), json!("installed"));
            o.insert("swap_key".into(), p["swap_key"].clone());
            o.insert("value".into(), p["value"].clone());
        }
    }
    op
}

async fn apply_plan(st: &AppState, user: &User, kind: &str, id: &str, p: &Value) -> AppResult<Value> {
    let reply = crate::plan::inputs::apply_ops(&st.pool, &user.id, vec![plan_op(kind, id, p)], Utc::now()).await?;
    let r = reply.results.first().ok_or_else(|| anyhow::anyhow!("the planner returned no result"))?;
    if r.status == "rejected" || r.original.as_deref() == Some("rejected") {
        return Err(AppError::Conflict(format!("The planner refused it: {}", r.error.clone().unwrap_or_default())));
    }
    let deck = p["deck"].as_str().unwrap_or("the plan");
    let label = match kind {
        "propose_swap" => format!("Saved as an idea for {deck}"),
        "answer_review" => format!("Answered in {deck}'s review"),
        "mark_bought" => format!("Marked in {deck}'s plan"),
        _ => format!("Marked in {deck}'s plan"),
    };
    Ok(json!({"label": label, "link": format!("/decks/plan/d/{}", p["deck_key"].as_str().unwrap_or_default())}))
}

// ── lab runs ────────────────────────────────────────────────────────────────

/// One of their decks by name or id, else a precon by name or slug: the lab's list choice and its
/// name.
async fn list_choice(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<(Value, String)> {
    match deck_id(pool, owner, wanted).await {
        Ok(id) => {
            let name: String = sqlx::query_scalar("SELECT name FROM decks WHERE id = ?").bind(&id).fetch_one(pool).await?;
            Ok((json!({"kind": "deck", "id": id}), name))
        }
        Err(AppError::NotFound(_)) => match precon_id(pool, wanted).await {
            Ok((id, name)) => Ok((json!({"kind": "precon", "id": id}), name)),
            Err(AppError::NotFound(_)) => Err(AppError::bad(format!("No deck of theirs and no precon matches \"{wanted}\"."))),
            Err(e) => Err(e),
        },
        Err(e) => Err(e),
    }
}

/// A list from `deck` (their deck or a precon) or `list` (pasted, named by `label`).
async fn list_arg(pool: &SqlitePool, owner: &str, args: &Value, deck: &str, list: &str, label: &str, what: &str) -> AppResult<(Value, String)> {
    match (opt_text(args, deck, 300)?, opt_text(args, list, crate::lab::experiments::MAX_TEXT_BYTES)?) {
        (Some(d), None) => list_choice(pool, owner, &d).await,
        (None, Some(text)) => {
            let label = opt_text(args, label, 120)?.unwrap_or_else(|| "A pasted list".into());
            Ok((json!({"kind": "list", "text": text, "label": label}), label))
        }
        _ => Err(AppError::bad(format!("Give {what}: either {deck} (one of their decks or a precon) or {list} (a whole list), not both."))),
    }
}

/// A game count the caller may choose (as the lab checks it), or the default.
fn games_arg(user: &User, args: &Value, default: Option<u32>) -> AppResult<u32> {
    let games = match args.get("games").filter(|v| !v.is_null()) {
        None => default.unwrap_or(crate::lab::experiments::game_choices(user)[0]),
        Some(v) => v.as_u64().and_then(|g| u32::try_from(g).ok()).ok_or_else(|| AppError::bad("games must be a whole number"))?,
    };
    crate::lab::experiments::check_games(user, games)?;
    Ok(games)
}

/// The fewest games the caller may choose that are at least `wanted`, else the most.
fn games_at_least(user: &User, wanted: usize) -> u32 {
    let wanted = u32::try_from(wanted).unwrap_or(u32::MAX);
    if user.is_admin {
        return (wanted.max(2).div_ceil(2) * 2).min(crate::lab::experiments::ADMIN_MAX_GAMES);
    }
    let choices = crate::lab::experiments::game_choices(user);
    choices.iter().copied().find(|&c| c >= wanted).unwrap_or(choices[choices.len() - 1])
}

fn engine_words(engine: &str, ai: &str, forge_ai: &str) -> String {
    match engine {
        "forge" => format!("on Forge with its {forge_ai} AI"),
        "both" => format!("on phase ({ai} AI) and Forge ({forge_ai} AI) side by side, each playing every pod"),
        _ => format!("on phase with the {ai} AI"),
    }
}

pub async fn start_lab_run(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    user.require_power()?;
    let pool = &st.pool;
    let mode = opt_text(args, "mode", 20)?.unwrap_or_else(|| "change".into());
    let games = games_arg(user, args, None)?;
    let engine = opt_text(args, "engine", 10)?.unwrap_or_else(|| "phase".into());
    crate::lab::forge::EngineMode::parse(Some(&engine)).map_err(AppError::bad)?;
    let ai = opt_text(args, "ai", 10)?.unwrap_or_else(|| "Easy".into());
    if !["Easy", "Medium"].contains(&ai.as_str()) && !user.is_admin {
        return Err(AppError::bad("ai must be Easy or Medium"));
    }
    let forge_ai = opt_text(args, "forge_ai", 20)?.unwrap_or_else(|| crate::lab::forge::DEFAULT_PROFILE.into());
    if !crate::lab::forge::FORGE_PROFILES.contains(&forge_ai.as_str()) {
        return Err(AppError::bad(format!("forge_ai must be one of {}", crate::lab::forge::FORGE_PROFILES.join(", "))));
    }
    let (field, against) = match opt_text(args, "opponents", 20)?.as_deref() {
        None | Some("strongest") => (json!({"kind": "precons_top", "n": crate::lab::experiments::DEFAULT_FIELD}), "the strongest precons".to_string()),
        Some("similar") => match opt_text(args, "near", 300)? {
            Some(near) => {
                let (id, name) = precon_id(pool, &near).await?;
                (json!({"kind": "precons_near", "n": crate::lab::experiments::DEFAULT_FIELD, "ids": [id]}), format!("the precons nearest in strength to {name}"))
            }
            None => (json!({"kind": "precons_near", "n": crate::lab::experiments::DEFAULT_FIELD}), "the precons nearest in strength to the list".to_string()),
        },
        Some("all_precons") => (json!({"kind": "precons_all"}), "every precon".to_string()),
        Some("my_decks") => (json!({"kind": "my_decks"}), "their own decks".to_string()),
        Some(other) => return Err(AppError::bad(format!("opponents: \"{other}\" isn't strongest, similar, all_precons or my_decks"))),
    };
    let mut request = json!({"mode": mode, "field": field, "games": games, "difficulty": ai});
    if engine != "phase" {
        request["engine"] = json!(engine);
        request["forge_ai"] = json!(forge_ai);
    }
    let summary = match mode.as_str() {
        "change" | "solo" => {
            let (base, base_label) = list_arg(pool, &user.id, args, "deck", "list", "label", "the list to start from").await?;
            request["base"] = base;
            let (add, cut) = (names_arg(args, "add")?, names_arg(args, "cut")?);
            if mode == "solo" {
                if !add.is_empty() || !cut.is_empty() {
                    return Err(AppError::bad("A solo run plays the list as it is: leave out add and cut, or use mode change."));
                }
                format!("Lab run, {base_label} as it is")
            } else {
                if add.is_empty() && cut.is_empty() {
                    return Err(AppError::bad("Name at least one card to add or cut (or use mode solo to run the list as it is)."));
                }
                let known = known_cards(pool, &[add.clone(), cut.clone()].concat()).await?;
                let canon = |names: &[String]| -> Vec<String> { names.iter().map(|n| known[n].1.clone()).collect() };
                let (add, cut) = (canon(&add), canon(&cut));
                let mut parts: Vec<String> = add.iter().map(|c| format!("+{c}")).collect();
                parts.extend(cut.iter().map(|c| format!("\u{2212}{c}")));
                request["variant"] = json!({"add": add, "cut": cut});
                format!("Lab run, {base_label}: {}", parts.join(", "))
            }
        }
        "compare" => {
            let (a, a_label) = list_arg(pool, &user.id, args, "deck", "list", "label", "the first list").await?;
            let (b, b_label) = list_arg(pool, &user.id, args, "other", "other_list", "other_label", "the second list").await?;
            request["base"] = a;
            request["other"] = b;
            format!("Lab run, {a_label} against {b_label}")
        }
        "versus" | "tournament" => {
            let names: Vec<String> = match args.get("entrants") {
                Some(Value::Array(a)) => a.iter().map(|v| v.as_str().filter(|n| !n.trim().is_empty() && n.len() <= 300).map(str::trim).map(String::from).ok_or_else(|| AppError::bad("Each named entrant must be a nonempty deck or precon name"))).collect::<AppResult<_>>()?,
                None => vec![],
                _ => return Err(AppError::bad("entrants must be an array of names")),
            };
            let pasted = match args.get("entrant_lists") {
                Some(Value::Array(a)) => a.as_slice(),
                None => &[],
                _ => return Err(AppError::bad("entrant_lists must be an array of labelled lists")),
            };
            let max = if mode == "tournament" { crate::lab::experiments::MAX_TOURNAMENT_ENTRANTS } else { crate::lab::experiments::MAX_ENTRANTS };
            let min = if mode == "tournament" { 1 } else { 2 };
            if !(min..=max).contains(&(names.len() + pasted.len())) {
                return Err(AppError::bad(format!("{mode} needs {min} to {max} entrants")));
            }
            let mut entrants = Vec::new();
            let mut labels = Vec::new();
            for n in &names {
                let (choice, label) = list_choice(pool, &user.id, n).await?;
                entrants.push(choice);
                labels.push(label);
            }
            for input in pasted {
                let text = opt_text(input, "list", crate::lab::experiments::MAX_TEXT_BYTES)?.ok_or_else(|| AppError::bad("Each pasted entrant needs list text"))?;
                let label = opt_text(input, "label", 120)?.filter(|s| !s.trim().is_empty()).ok_or_else(|| AppError::bad("Each pasted entrant needs a label"))?;
                entrants.push(json!({"kind": "list", "text": text, "label": label}));
                labels.push(label);
            }
            let pod = args.get("pod").and_then(Value::as_u64).unwrap_or(4);
            request["entrants"] = json!(entrants);
            request["pod"] = json!(pod);
            if (mode == "tournament" && args.get("opponents").is_none()) || (mode == "versus" && (pod == 2 || entrants.len() >= 4)) {
                request.as_object_mut().map(|o| o.remove("field"));
            }
            if mode == "tournament" { format!("Tournament, {} selected lists", labels.len()) } else { format!("Lab run, head to head: {}", labels.join(", ")) }
        }
        other => return Err(AppError::bad(format!("mode: \"{other}\" isn't change, compare, solo, versus or tournament"))),
    };
    let engines = engine_words(&engine, &ai, &forge_ai);
    let detail = match mode.as_str() {
        "change" => format!("{games} games against {against}, the base list against the changed one in the same pods, {engines}."),
        "compare" => format!("{games} games against {against}, the two lists in the same pods, {engines}."),
        "solo" => format!("{games} games against {against}, {engines}."),
        "tournament" => format!("At least {games} appearances per unique deck per engine in one shared field, randomized four-player pods with balanced seats; total games scale with the final field size. Identical lists are counted once. Optional opponents join the field as scored entrants. {engines}."),
        _ if request.get("field").is_some() => format!("{games} games, with {against} filling empty seats, {engines}."),
        _ => format!("{games} games, {engines}."),
    };
    stage(st, user, via, Staged { kind: "start_lab_run", summary, detail, payload: request }).await
}

async fn apply_lab_run(st: &AppState, user: &User, id: &str, p: &Value) -> AppResult<Value> {
    let mut req = p.clone();
    req["op_id"] = json!(format!("{DEVICE}-{id}"));
    let req: crate::lab::experiments::NewExperiment = serde_json::from_value(req).map_err(anyhow::Error::from)?;
    let sim = st.lab.simulator()?;
    let made = crate::lab::experiments::create_with(&st.pool, user, req, sim.as_ref(), &st.cfg.lab_quota, &st.lab.forge_access()).await?;
    st.lab.wake();
    st.lab.wake_forge();
    Ok(json!({"label": format!("Lab run queued: {}", made.item.name), "link": format!("/lab/runs/{}", made.item.id)}))
}

/// One of the caller's experiments as staging needs it.
struct RunInfo {
    name: String,
    status: String,
    mode: String,
    /// Pod templates (games per engine in solo and versus).
    pods: usize,
    engine: String,
    /// Each engine's results so far (phase's half first in a "both" run).
    summaries: Vec<crate::lab::stats::Summary>,
}

async fn run_info(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<RunInfo> {
    type Row = (String, String, Option<String>, i64, Option<String>, Option<String>, Option<String>);
    let row: Option<Row> = sqlx::query_as(
        "SELECT name, status, json_extract(spec, '$.mode'), json_extract(spec, '$.pods'), json_extract(spec, '$.engines.mode'),
                summary, summary_forge
         FROM lab_experiments WHERE id = ? AND owner_id = ?",
    )
    .bind(id)
    .bind(owner)
    .fetch_optional(pool)
    .await?;
    let (name, status, mode, pods, engine, summary, forge) = row.ok_or(AppError::NotFound("experiment"))?;
    let summaries = [summary, forge].into_iter().flatten().filter_map(|t| serde_json::from_str(&t).ok()).collect();
    Ok(RunInfo {
        name,
        status,
        mode: mode.unwrap_or_else(|| "change".into()),
        pods: usize::try_from(pods).unwrap_or(0),
        engine: engine.unwrap_or_else(|| "phase".into()),
        summaries,
    })
}

/// Games one pod takes on one engine.
fn per_pod(mode: &str) -> usize {
    if matches!(mode, "solo" | "versus" | "tournament") { 1 } else { 2 }
}

pub async fn more_lab_games(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    user.require_power()?;
    let id = text_arg(args, "id")?;
    let run = run_info(&st.pool, &user.id, id).await?;
    if matches!(run.mode.as_str(), "versus" | "tournament") {
        return Err(AppError::bad("A head-to-head run can't take more games; use run_lab_again."));
    }
    if run.status != "done" {
        return Err(AppError::bad(format!("Only a finished run can take more games; this one is {}.", run.status)));
    }
    // Enough for the run's settle estimate, where it has one (the larger of the two engines').
    let per = per_pod(&run.mode);
    let default = run.summaries.iter().filter_map(crate::lab::stats::pods_to_add).max().map(|n| games_at_least(user, n as usize * per));
    let games = games_arg(user, args, default)?;
    let new_pods = games as usize / per;
    let mut detail = format!(
        "{games} more games{}: {} pods so far, then {new_pods} more that continue the same schedule and pool with them.",
        if run.engine == "both" { " on each engine" } else { "" },
        run.pods
    );
    for sm in &run.summaries {
        if let Some(n) = sm.paired.settle_pods {
            let _ = write!(detail, " If the difference holds, about {n} counted pods would settle it ({} so far).", sm.paired.pods);
        }
    }
    let summary = format!("More lab games, {}: {games} more", run.name);
    stage(st, user, via, Staged { kind: "more_lab_games", summary, detail, payload: json!({"experiment": id, "games": games, "seen_pods": run.pods}) }).await
}

async fn apply_more_games(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let id = p["experiment"].as_str().unwrap_or_default();
    let games = p["games"].as_u64().and_then(|g| u32::try_from(g).ok()).unwrap_or(0);
    let seen = p["seen_pods"].as_u64().and_then(|n| usize::try_from(n).ok()).unwrap_or(0);
    let run = run_info(&st.pool, &user.id, id).await?;
    if run.pods != seen {
        return Err(AppError::Conflict(format!("The run has {} pods now, not the {seen} it had when this was staged; stage it again.", run.pods)));
    }
    let sim = st.lab.simulator()?;
    let d = crate::lab::experiments::more_with(&st.pool, user, id, games, seen, sim.as_ref(), &st.cfg.lab_quota, &st.lab.forge_access()).await?;
    st.lab.wake();
    st.lab.wake_forge();
    Ok(json!({"label": format!("{games} more games queued: {}", d.item.name), "link": format!("/lab/runs/{id}")}))
}

pub async fn run_lab_again(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    user.require_power()?;
    let id = text_arg(args, "id")?;
    let run = run_info(&st.pool, &user.id, id).await?;
    let had = if run.mode == "tournament" {
        let target: Option<i64> = sqlx::query_scalar("SELECT json_extract(spec, '$.games_per_deck') FROM lab_experiments WHERE id=? AND owner_id=?")
            .bind(id).bind(&user.id).fetch_one(&st.pool).await?;
        target.unwrap_or(100).max(2) as usize
    } else { run.pods * per_pod(&run.mode) };
    let games = games_arg(user, args, Some(games_at_least(user, had)))?;
    let summary = format!("Lab run again, {}: {games} games", run.name);
    let detail = format!(
        "A new run with the same lists, opponents, engines and AI{}, and a new seed. The first run stays as it is.",
        if run.engine == "both" { format!(" ({games} games on each engine)") } else { String::new() }
    );
    stage(st, user, via, Staged { kind: "run_lab_again", summary, detail, payload: json!({"experiment": id, "games": games}) }).await
}

async fn apply_again(st: &AppState, user: &User, change: &str, p: &Value) -> AppResult<Value> {
    let id = p["experiment"].as_str().unwrap_or_default();
    let games = p["games"].as_u64().and_then(|g| u32::try_from(g).ok()).unwrap_or(0);
    let sim = st.lab.simulator()?;
    let op = format!("{DEVICE}-{change}");
    let d = crate::lab::experiments::again_with(&st.pool, user, id, games, Some(&op), sim.as_ref(), &st.cfg.lab_quota, &st.lab.forge_access()).await?;
    st.lab.wake();
    st.lab.wake_forge();
    Ok(json!({"label": format!("Lab run queued: {}", d.item.name), "link": format!("/lab/runs/{}", d.item.id)}))
}

pub async fn cancel_lab_run(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let id = text_arg(args, "id")?;
    let run = run_info(&st.pool, &user.id, id).await?;
    if !matches!(run.status.as_str(), "queued" | "running") {
        return Err(AppError::bad(format!("This run is {}, so there's nothing to cancel.", run.status)));
    }
    let summary = format!("Cancel lab run, {}", run.name);
    let detail = "Games already playing finish and count; no new ones start. The results so far stay.".to_string();
    stage(st, user, via, Staged { kind: "cancel_lab_run", summary, detail, payload: json!({"experiment": id}) }).await
}

async fn apply_cancel(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let id = p["experiment"].as_str().unwrap_or_default();
    let lab = &st.lab;
    let d = crate::lab::experiments::cancel(&st.pool, &user.id, id, &|e: &str| lab.playing(e)).await?;
    lab.wake();
    let label = if d.item.status == "cancelled" { format!("Lab run cancelled: {}", d.item.name) } else { format!("{} was already {}", d.item.name, d.item.status) };
    Ok(json!({"label": label, "link": format!("/lab/runs/{id}")}))
}

// ── collection ──────────────────────────────────────────────────────────────

/// The caller's binder, deck box or list by name: (id, name). Unknown names list theirs.
async fn container(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<(String, String)> {
    let all: Vec<(String, String)> = sqlx::query_as("SELECT id, name FROM containers WHERE owner_id = ? ORDER BY name").bind(owner).fetch_all(pool).await?;
    if let Some(c) = all.iter().find(|(id, n)| id == wanted || n.eq_ignore_ascii_case(wanted)) {
        return Ok(c.clone());
    }
    let near: Vec<&(String, String)> = all.iter().filter(|(_, n)| n.to_lowercase().contains(&wanted.to_lowercase())).collect();
    match near.as_slice() {
        [one] => Ok((*one).clone()),
        _ => Err(AppError::bad(format!(
            "They have no binder, deck box or list called \"{wanted}\". Theirs: {}.",
            if all.is_empty() { "none yet".into() } else { all.iter().take(40).map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ") }
        ))),
    }
}

pub async fn add_to_collection(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let wanted = text_arg(args, "card")?.to_string();
    let known = known_cards(pool, std::slice::from_ref(&wanted)).await?;
    let (oracle_id, name) = known[&wanted].clone();
    let qty = args.get("qty").and_then(Value::as_i64).unwrap_or(1);
    if !(1..=100).contains(&qty) {
        return Err(AppError::bad("qty must be from 1 to 100"));
    }
    let set = opt_text(args, "set", 10)?;
    let number = opt_text(args, "number", 20)?;
    let printing: Option<(String, String, String)> = match &set {
        Some(set) => {
            sqlx::query_as(
                "SELECT scryfall_id, set_name, collector_number FROM printings WHERE oracle_id = ? AND lower(set_code) = lower(?) AND (? IS NULL OR collector_number = ?)
                 ORDER BY lang = 'en' DESC, collector_number LIMIT 1",
            )
            .bind(&oracle_id)
            .bind(set)
            .bind(&number)
            .bind(&number)
            .fetch_optional(pool)
            .await?
        }
        None => {
            sqlx::query_as(
                "SELECT p.scryfall_id, p.set_name, p.collector_number FROM cards c JOIN printings p ON p.scryfall_id = c.default_printing WHERE c.oracle_id = ?",
            )
            .bind(&oracle_id)
            .fetch_optional(pool)
            .await?
        }
    };
    let (scryfall_id, set_name, number) = printing.ok_or_else(|| {
        AppError::bad(match &set {
            Some(s) => format!("Yama has no printing of {name} in set \"{s}\"{}.", number.as_deref().map(|n| format!(" numbered {n}")).unwrap_or_default()),
            None => format!("Yama has no printing of {name} to add."),
        })
    })?;
    let place = match opt_text(args, "container", 200)? {
        Some(c) => Some(container(pool, &user.id, &c).await?),
        None => None,
    };
    let proxy = args.get("proxy").and_then(Value::as_bool).unwrap_or(false);
    let finish = opt_text(args, "finish", 10)?.unwrap_or_else(|| "nonfoil".into());
    if !["nonfoil", "foil", "etched"].contains(&finish.as_str()) {
        return Err(AppError::bad("finish must be nonfoil, foil or etched"));
    }
    let summary = format!(
        "Add {qty} {name}{} ({set_name} #{number}{}) to {}",
        if proxy { " proxy" } else { "" },
        if finish == "nonfoil" { String::new() } else { format!(", {finish}") },
        place.as_ref().map(|(_, n)| n.as_str()).unwrap_or("the collection (not in a binder or box)")
    );
    let payload = json!({
        "scryfall_id": scryfall_id, "name": name, "qty": qty, "proxy": proxy, "finish": finish,
        "container_id": place.as_ref().map(|(id, _)| id), "container": place.as_ref().map(|(_, n)| n),
    });
    stage(st, user, via, Staged { kind: "add_to_collection", summary, detail: String::new(), payload }).await
}

/// One row of the caller's collection that a move can take copies from.
#[derive(sqlx::FromRow)]
struct CopyRow {
    id: String,
    qty: i64,
    scryfall_id: String,
    condition: String,
    finish: String,
    lang: String,
    altered: bool,
    signed: bool,
    misprint: bool,
    proxy: bool,
    purchase_price: Option<f64>,
}

async fn copies_in(conn: &mut sqlx::SqliteConnection, owner: &str, oracle_id: &str, container_id: &str) -> AppResult<Vec<CopyRow>> {
    Ok(sqlx::query_as(
        "SELECT i.id, i.qty, i.scryfall_id, i.condition, i.finish, i.lang, i.altered, i.signed, i.misprint, i.proxy, i.purchase_price
         FROM collection_items i JOIN printings p ON p.scryfall_id = i.scryfall_id
         WHERE i.owner_id = ? AND p.oracle_id = ? AND i.container_id = ? AND i.qty > 0
         ORDER BY i.proxy, i.qty DESC, i.id",
    )
    .bind(owner)
    .bind(oracle_id)
    .bind(container_id)
    .fetch_all(&mut *conn)
    .await?)
}

pub async fn move_cards(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let wanted = text_arg(args, "card")?.to_string();
    let known = known_cards(pool, std::slice::from_ref(&wanted)).await?;
    let (oracle_id, name) = known[&wanted].clone();
    let qty = args.get("qty").and_then(Value::as_i64).unwrap_or(1);
    if !(1..=100).contains(&qty) {
        return Err(AppError::bad("qty must be from 1 to 100"));
    }
    let from = container(pool, &user.id, text_arg(args, "from")?).await?;
    let to = container(pool, &user.id, text_arg(args, "to")?).await?;
    if from.0 == to.0 {
        return Err(AppError::bad("from and to are the same place"));
    }
    let have: i64 = copies_in(&mut *pool.acquire().await?, &user.id, &oracle_id, &from.0).await?.iter().map(|c| c.qty).sum();
    if have < qty {
        return Err(AppError::bad(format!("{} holds {have} {name}, not {qty}. Nothing was staged.", from.1)));
    }
    let summary = format!("Move {qty} {name} from {} to {}", from.1, to.1);
    let payload = json!({"oracle_id": oracle_id, "name": name, "qty": qty, "from_id": from.0, "from": from.1, "to_id": to.0, "to": to.1});
    stage(st, user, via, Staged { kind: "move_cards", summary, detail: String::new(), payload }).await
}

/// Card conditions, as the collection page names them.
const CONDITIONS: [(&str, &str); 5] =
    [("NM", "near mint"), ("LP", "lightly played"), ("MP", "moderately played"), ("HP", "heavily played"), ("DMG", "damaged")];

/// Rows in a container (of one card, or all of them) not yet in a condition: (id, name, qty).
async fn rows_to_grade(conn: &mut sqlx::SqliteConnection, owner: &str, container_id: &str, oracle_id: Option<&str>, condition: &str) -> AppResult<Vec<(String, String, i64)>> {
    Ok(sqlx::query_as(
        "SELECT i.id, p.name, i.qty FROM collection_items i JOIN printings p ON p.scryfall_id = i.scryfall_id
         WHERE i.owner_id = ? AND i.container_id = ? AND (? IS NULL OR p.oracle_id = ?) AND i.condition != ? AND i.qty > 0
         ORDER BY p.name, i.id",
    )
    .bind(owner)
    .bind(container_id)
    .bind(oracle_id)
    .bind(oracle_id)
    .bind(condition)
    .fetch_all(&mut *conn)
    .await?)
}

pub async fn set_condition(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let condition = text_arg(args, "condition")?.to_uppercase();
    let Some((_, said)) = CONDITIONS.iter().find(|(c, _)| *c == condition) else {
        return Err(AppError::bad("condition must be NM, LP, MP, HP or DMG"));
    };
    let place = container(pool, &user.id, text_arg(args, "container")?).await?;
    let card = match opt_text(args, "card", 200)? {
        Some(wanted) => Some(known_cards(pool, std::slice::from_ref(&wanted)).await?[&wanted].clone()),
        None => None,
    };
    let rows = rows_to_grade(&mut *pool.acquire().await?, &user.id, &place.0, card.as_ref().map(|(o, _)| o.as_str()), &condition).await?;
    if rows.is_empty() {
        return Err(AppError::bad(format!(
            "{} holds no {} that isn't already {said}. Nothing was staged.",
            place.1,
            card.as_ref().map(|(_, n)| n.as_str()).unwrap_or("cards")
        )));
    }
    let mut counts: Vec<(String, i64)> = Vec::new();
    for (_, name, qty) in &rows {
        match counts.last_mut() {
            Some((n, q)) if n == name => *q += qty,
            _ => counts.push((name.clone(), *qty)),
        }
    }
    let total: i64 = counts.iter().map(|(_, q)| q).sum();
    let summary = match &card {
        Some((_, name)) => format!("Mark {total} {name} in {} {said}", place.1),
        None => format!("Mark {total} cards in {} {said}", place.1),
    };
    let detail = counts.iter().map(|(n, q)| format!("{q} {n}")).collect::<Vec<_>>().join(", ");
    let payload = json!({
        "condition": condition, "container_id": place.0, "container": place.1,
        "oracle_id": card.as_ref().map(|(o, _)| o), "name": card.as_ref().map(|(_, n)| n),
    });
    stage(st, user, via, Staged { kind: "set_condition", summary, detail, payload }).await
}

async fn apply_collection(st: &AppState, user: &User, kind: &str, id: &str, p: &Value) -> AppResult<Value> {
    use crate::collection::{CopyKind, Op, OpKind, apply_op};
    let op = |n: usize, op: OpKind| Op { op_id: format!("{DEVICE}-{id}-{n}"), device_id: Some(DEVICE.into()), op };
    let mut tx = st.pool.begin().await?;
    if kind == "add_to_collection" {
        let copy = CopyKind { condition: "NM".into(), finish: p["finish"].as_str().unwrap_or("nonfoil").into(), lang: "en".into(), proxy: p["proxy"].as_bool().unwrap_or(false), ..Default::default() };
        let add = OpKind::Add {
            scryfall_id: p["scryfall_id"].as_str().unwrap_or_default().into(),
            qty: p["qty"].as_i64().unwrap_or(1),
            copy,
            container_id: p["container_id"].as_str().map(String::from),
            purchase_price: None,
            purchase_currency: None,
        };
        apply_op(&mut tx, &user.id, &op(0, add)).await?;
    } else if kind == "set_condition" {
        // The rows at apply time: copies added to the box since staging are graded too.
        let condition = p["condition"].as_str().unwrap_or("NM");
        let rows = rows_to_grade(&mut tx, &user.id, p["container_id"].as_str().unwrap_or_default(), p["oracle_id"].as_str(), condition).await?;
        for (n, (item_id, _, _)) in rows.into_iter().enumerate() {
            let update = OpKind::Update {
                item_id,
                condition: Some(condition.into()),
                finish: None,
                lang: None,
                container_id: None,
                purchase_price: None,
                note: None,
                proxy: None,
            };
            apply_op(&mut tx, &user.id, &op(n, update)).await?;
        }
        tx.commit().await?;
        let said = CONDITIONS.iter().find(|(c, _)| *c == condition).map(|(_, s)| *s).unwrap_or(condition);
        let what = p["name"].as_str().unwrap_or("Cards");
        return Ok(json!({"label": format!("Done: {what} in {} now {said}", p["container"].as_str().unwrap_or("the box")), "link": "/collection"}));
    } else {
        let (oracle_id, to) = (p["oracle_id"].as_str().unwrap_or_default(), p["to_id"].as_str().unwrap_or_default());
        let mut left = p["qty"].as_i64().unwrap_or(1);
        let rows = copies_in(&mut tx, &user.id, oracle_id, p["from_id"].as_str().unwrap_or_default()).await?;
        if rows.iter().map(|r| r.qty).sum::<i64>() < left {
            return Err(AppError::Conflict(format!("{} no longer holds {left} {}.", p["from"].as_str().unwrap_or("That place"), p["name"].as_str().unwrap_or("copies"))));
        }
        let mut n = 0;
        for r in rows {
            if left == 0 {
                break;
            }
            let take = left.min(r.qty);
            left -= take;
            if take == r.qty {
                let update = OpKind::Update {
                    item_id: r.id.clone(),
                    condition: None,
                    finish: None,
                    lang: None,
                    container_id: Some(Some(to.into())),
                    purchase_price: None,
                    note: None,
                    proxy: None,
                };
                apply_op(&mut tx, &user.id, &op(n, update)).await?;
                n += 1;
            } else {
                apply_op(&mut tx, &user.id, &op(n, OpKind::Adjust { item_id: r.id.clone(), delta: -take })).await?;
                let copy = CopyKind { condition: r.condition, finish: r.finish, lang: r.lang, altered: r.altered, signed: r.signed, misprint: r.misprint, proxy: r.proxy };
                let add = OpKind::Add { scryfall_id: r.scryfall_id, qty: take, copy, container_id: Some(to.into()), purchase_price: r.purchase_price, purchase_currency: None };
                apply_op(&mut tx, &user.id, &op(n + 1, add)).await?;
                n += 2;
            }
        }
    }
    tx.commit().await?;
    let label = match p["container"].as_str().or(p["to"].as_str()) {
        Some(place) => format!("Done: {} now in {place}", p["name"].as_str().unwrap_or("cards")),
        None => format!("Done: {} added", p["name"].as_str().unwrap_or("cards")),
    };
    Ok(json!({"label": label, "link": "/collection"}))
}

/// Runs the swap-in against the plan, box and deck as they are now; it plans from state, so a
/// change applied twice (or after the person did it on the web) finds nothing left to do.
async fn apply_swap_in(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    st.limits.deck_writes.check_user(user)?;
    let key = p["deck_key"].as_str().unwrap_or_default();
    let done = crate::plan::swap_in::run(&st.pool, &user.id, key, false).await?;
    let label = if done.done {
        format!("{} already held its after-prints list", done.plan_name)
    } else {
        format!("Prints swapped into {}: {} proxies added, {} cards moved", done.plan_name, done.proxies_added, done.moved)
    };
    Ok(json!({"label": label, "link": format!("/decks/plan/d/{key}")}))
}

// ── applying and discarding ─────────────────────────────────────────────────

/// One apply at a time on this server, so two taps (or a tap and `apply_change`) can't both run a
/// change that isn't idempotent on its own (a deck edit).
// ── shopping settings (docs/shopping-design.md) ─────────────────────────────

/// A store of theirs by key or name (case-insensitive), not retired.
async fn their_store(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<(String, String)> {
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT key, name FROM plan_stores WHERE owner_id = ? AND retired_at IS NULL AND kind != 'printer' ORDER BY sort, key")
        .bind(owner)
        .fetch_all(pool)
        .await?;
    let w = wanted.trim().to_lowercase();
    rows.iter()
        .find(|(k, n)| k.to_lowercase() == w || n.to_lowercase() == w)
        .or_else(|| {
            let hits: Vec<&(String, String)> = rows.iter().filter(|(_, n)| n.to_lowercase().contains(&w)).collect();
            (hits.len() == 1).then(|| hits[0])
        })
        .cloned()
        .ok_or_else(|| {
            let names: Vec<String> = rows.iter().map(|(k, n)| format!("{n} ({k})")).collect();
            AppError::bad(format!("No store \"{wanted}\" in their plan. Their stores: {}.", if names.is_empty() { "none".into() } else { names.join(", ") }))
        })
}

fn opt_number(args: &Value, key: &str) -> AppResult<Option<Option<f64>>> {
    match args.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => v.as_f64().filter(|x| x.is_finite()).map(|x| Some(Some(x))).ok_or_else(|| AppError::bad(format!("{key} must be a number or null"))),
    }
}

/// `set_shopping_rules`: a new buy rule and sealed cap, as a rule set from the day they apply it.
/// Parts left out keep the rule in force today.
pub async fn set_shopping_rules(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    use crate::plan::shopping::{LocalBuy, problems};
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let bundle = crate::plan::bundle::load_bundle(&st.pool, &user.id).await?;
    let empty = vec![];
    let sets = bundle["settings"].as_array().unwrap_or(&empty);
    let set = crate::plan::trip::rules_at(sets, &today);
    let current = crate::plan::trip::local_buy_rule(set).rule.unwrap_or(crate::plan::trip::LocalBuyRule { max_usd: None, always_ok_usd: None, tiers: vec![] });
    let mut lb = LocalBuy::from_rule(&current);
    if let Some(v) = opt_number(args, "max_usd")? {
        lb.max_usd = v;
    }
    if let Some(v) = opt_number(args, "always_ok_usd")? {
        lb.always_ok_usd = v;
    }
    if let Some(t) = args.get("tiers").filter(|t| !t.is_null()) {
        lb.tiers = serde_json::from_value(t.clone()).map_err(|_| AppError::bad("tiers must be a list of {market_under: number or null, max_multiple: number}"))?;
    }
    let mut sealed = set.and_then(|s| s["rules"]["sealed_max_usd"].as_f64());
    if let Some(v) = opt_number(args, "sealed_max_usd")? {
        sealed = v;
    }
    let found = problems(&lb, sealed);
    if !found.is_empty() {
        return Err(AppError::bad(format!("{} Nothing was staged.", found.join(" "))));
    }
    let note = opt_text(args, "note", 500)?;
    let text = crate::plan::trip::rule_text(&lb.rule());
    let summary = "Change the buy rule".to_string();
    let detail = format!(
        "{text} Sealed precons: {}. Applies from the day it's applied; older checks keep their own day's rules.",
        sealed.map_or_else(|| "no limit".to_string(), |v| format!("at most ${v:.2} a deck before tax"))
    );
    let payload = json!({"local_buy": lb.to_json(), "sealed_max_usd": sealed, "note": note});
    stage(st, user, via, Staged { kind: "set_shopping_rules", summary, detail, payload }).await
}

async fn apply_shopping_rules(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let lb: crate::plan::shopping::LocalBuy = serde_json::from_value(p["local_buy"].clone()).map_err(anyhow::Error::from)?;
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let saved = crate::plan::shopping::save_rules(&st.pool, &user.id, &today, &lb, p["sealed_max_usd"].as_f64(), p["note"].as_str()).await?;
    Ok(json!({"label": format!("New rule set from {today}."), "effective_from": saved["effective_from"]}))
}

/// `set_store_preference`: one store's level, place in their order and premium. Parts left out
/// stay as they are.
pub async fn set_store_preference(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    use crate::plan::shopping::{PREFERENCES, get_pref};
    let (key, name) = their_store(&st.pool, &user.id, text_arg(args, "store")?).await?;
    let mut p = get_pref(&st.pool, &user.id, &key).await?;
    if p.preference == "default" {
        p.preference = "favorite".into();
    }
    if let Some(v) = args.get("preference").filter(|v| !v.is_null()) {
        let v = v.as_str().filter(|v| PREFERENCES.contains(v)).ok_or_else(|| AppError::bad("preference must be favorite, ok, maybe or never"))?;
        p.preference = v.into();
    }
    match args.get("hassle") {
        None => {}
        Some(Value::Null) => p.hassle = None,
        Some(v) => p.hassle = Some(v.as_i64().ok_or_else(|| AppError::bad("hassle must be a whole number from 1 (easiest to get to)"))?),
    }
    if let Some(v) = opt_number(args, "premium_usd")? {
        p.premium_usd = v.filter(|x| *x > 0.0);
    }
    if args.get("note").is_some() {
        p.note = opt_text(args, "note", 500)?;
    }
    p.check()?;
    let level = crate::plan::trip::preference_text(&p.preference);
    let summary = format!("{name}: {level}");
    let mut parts = vec![format!("{name} ({key}): {level}")];
    if let Some(h) = p.hassle {
        parts.push(format!("place {h} in their order of how easy stores are to get to"));
    }
    if let Some(v) = p.premium_usd {
        parts.push(format!("up to ${v:.2} more a card here"));
    }
    if let Some(n) = &p.note {
        parts.push(format!("note: {n}"));
    }
    let payload = json!({"store": key, "preference": p.preference, "hassle": p.hassle, "premium_usd": p.premium_usd, "note": p.note});
    stage(st, user, via, Staged { kind: "set_store_preference", summary, detail: parts.join("; ") + ".", payload }).await
}

async fn apply_store_preference(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let key = p["store"].as_str().unwrap_or_default();
    let pref = crate::plan::shopping::Pref {
        preference: p["preference"].as_str().unwrap_or("ok").into(),
        note: p["note"].as_str().map(String::from),
        hassle: p["hassle"].as_i64(),
        premium_usd: p["premium_usd"].as_f64(),
    };
    crate::plan::shopping::set_pref(&st.pool, &user.id, key, &pref).await?;
    Ok(json!({"label": format!("Saved your setting for {key}.")}))
}

fn apply_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(Default::default)
}

/// Apply a pending change. A failure is kept on the change (it stays pending) and returned, so the
/// page shows the reason; a server fault is logged and shown in general terms.
pub async fn apply(st: &AppState, user: &User, id: &str) -> AppResult<ChangeView> {
    let _one = apply_lock().lock().await;
    let row = load(&st.pool, &user.id, id).await?;
    if row.status != "pending" {
        return Err(AppError::Conflict(format!("This change was already {}.", row.status)));
    }
    let p: Value = serde_json::from_str(&row.payload).map_err(anyhow::Error::from)?;
    let done = match row.kind.as_str() {
        "edit_deck" if p["complete_list"] == true => apply_complete_deck(st, user, &row.id, &p).await,
        "edit_deck" => apply_edit_deck(st, user, &row.summary, &p).await,
        "propose_swap" | "answer_review" | "mark_bought" | "mark_installed" => apply_plan(st, user, &row.kind, &row.id, &p).await,
        "start_lab_run" => apply_lab_run(st, user, &row.id, &p).await,
        "more_lab_games" => apply_more_games(st, user, &p).await,
        "run_lab_again" => apply_again(st, user, &row.id, &p).await,
        "cancel_lab_run" => apply_cancel(st, user, &p).await,
        "add_to_collection" | "move_cards" | "set_condition" => apply_collection(st, user, &row.kind, &row.id, &p).await,
        "swap_in_prints" => apply_swap_in(st, user, &p).await,
        "set_shopping_rules" => apply_shopping_rules(st, user, &p).await,
        "set_store_preference" => apply_store_preference(st, user, &p).await,
        other => Err(AppError::Other(anyhow::anyhow!("unknown change kind {other}"))),
    };
    let at = now();
    match done {
        Ok(result) => {
            sqlx::query("UPDATE assistant_changes SET status = 'applied', error = NULL, result = ?, decided_at = ? WHERE id = ? AND owner_id = ?")
                .bind(result.to_string())
                .bind(&at)
                .bind(id)
                .bind(&user.id)
                .execute(&st.pool)
                .await?;
            tracing::info!(kind = %row.kind, "assistant change applied");
        }
        Err(e) => {
            let message = match &e {
                AppError::Db(_) | AppError::Other(_) => {
                    tracing::error!(error = ?e, kind = %row.kind, "assistant change failed");
                    "Yama couldn't apply it (a server error). Try again later.".to_string()
                }
                other => other.to_string(),
            };
            sqlx::query("UPDATE assistant_changes SET error = ? WHERE id = ? AND owner_id = ?").bind(&message).bind(id).bind(&user.id).execute(&st.pool).await?;
        }
    }
    load_view(&st.pool, &user.id, id).await
}

pub async fn discard(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<ChangeView> {
    let _one = apply_lock().lock().await;
    let row = load(pool, owner, id).await?;
    if row.status != "pending" {
        return Err(AppError::Conflict(format!("This change was already {}.", row.status)));
    }
    sqlx::query("UPDATE assistant_changes SET status = 'discarded', decided_at = ? WHERE id = ? AND owner_id = ? AND status = 'pending'")
        .bind(now())
        .bind(id)
        .bind(owner)
        .execute(pool)
        .await?;
    load_view(pool, owner, id).await
}

// ── routes (the pages, signed in) ───────────────────────────────────────────

#[derive(Deserialize)]
struct ListQuery {
    /// "all" for decided ones too; pending only by default.
    status: Option<String>,
    conversation: Option<String>,
}

async fn list_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(q): Query<ListQuery>) -> AppResult<Json<Vec<ChangeView>>> {
    // A conversation's changes are shown whatever became of them.
    let pending_only = q.status.as_deref() != Some("all") && q.conversation.is_none();
    Ok(Json(list(&st.pool, &user.id, pending_only, q.conversation.as_deref()).await?))
}

async fn apply_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<ChangeView>> {
    Ok(Json(apply(&st, &user, &id).await?))
}

async fn discard_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<Json<ChangeView>> {
    Ok(Json(discard(&st.pool, &user.id, &id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str, name: &str, board: Board) -> DeckCard {
        DeckCard { oracle_id: id.into(), name: name.into(), qty: 1, board }
    }

    fn r(id: &str, name: &str) -> CardRef {
        CardRef { oracle_id: id.into(), name: name.into() }
    }

    #[test]
    fn an_edit_takes_one_copy_out_and_puts_one_in() {
        let list = vec![card("c", "Commander", Board::Commander), card("a", "Alpha", Board::Main), card("f", "Forest", Board::Main)];
        let mut forests = list.clone();
        forests[2].qty = 3;
        let after = edit_list(forests, &[r("b", "Beta"), r("f", "Forest")], &[r("a", "Alpha"), r("f", "Forest")], "Deck").unwrap();
        assert!(!after.iter().any(|c| c.oracle_id == "a"));
        assert_eq!(after.iter().find(|c| c.oracle_id == "f").unwrap().qty, 3);
        assert_eq!(after.iter().find(|c| c.oracle_id == "b").unwrap().board, Board::Main);

        assert_eq!(edit_list(list.clone(), &[], &[r("x", "Gone")], "Deck").unwrap_err(), "Gone isn't in Deck");
        assert!(edit_list(list, &[], &[r("c", "Commander")], "Deck").unwrap_err().contains("is the commander"));
    }

    #[test]
    fn plan_ops_carry_the_change_id() {
        let p = json!({"swap_key": "k", "deck_key": "d", "value": true, "on": "2026-10-22", "qty": 1, "price_paid": null, "store": "Pat's"});
        let op = plan_op("mark_bought", "abc", &p);
        assert_eq!(op["op_id"], "claude-abc");
        assert_eq!(op["kind"], "bought");
        assert_eq!(op["store_label"], "Pat's");
        let op = plan_op("mark_bought", "abc", &json!({"swap_key": "k", "value": false, "on": "2026-10-22"}));
        assert!(op.get("on").is_none(), "an unmark sends no date");
    }
}
