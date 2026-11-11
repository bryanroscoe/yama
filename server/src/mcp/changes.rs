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
use super::args as arg;
use super::registry::{Pending, Staging};
use super::tools::{card_info, checks, deck_id, near_names, precon_id};
use crate::auth::{CurrentUser, User};
use crate::decks::{Board, DeckCard};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, sha256_hex};
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

/// A change as the pages and `list_changes` show it. `result` is what applying made: a label and the
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

/// One of the owner's changes, whatever its status (the `list_changes` tool with an id).
pub(super) async fn one(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<ChangeView> {
    load_view(pool, owner, id).await
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

/// The caller's own id for one staging call (`op_id`): repeating the call with it stages nothing
/// new. Letters, digits, hyphens and underscores, so a UUID fits.
pub(super) fn op_id(args: &Value) -> AppResult<Option<&str>> {
    match args.get("op_id").filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(Value::String(s)) if (8..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') => Ok(Some(s)),
        Some(_) => Err(AppError::bad("op_id must be 8 to 64 letters, digits, hyphens or underscores (a UUID works)")),
    }
}

/// One staging call's op id and what the call asked for: the stored kind and the arguments
/// without the op id, hashed. A retry hashes the same; anything else doesn't.
pub(super) struct Op<'a> {
    id: &'a str,
    hash: String,
}

/// The `op_id` of a call that stages `kind`, with its request hash; none when it has no op id.
pub(super) fn op<'a>(kind: &str, args: &'a Value) -> AppResult<Option<Op<'a>>> {
    let Some(id) = op_id(args)? else { return Ok(None) };
    let mut request = args.clone();
    if let Some(o) = request.as_object_mut() {
        o.remove("op_id");
    }
    // An object's keys serialize in order, so the same request always hashes the same.
    Ok(Some(Op { id, hash: sha256_hex(&format!("{kind}\n{request}")) }))
}

/// The change this account already staged with this op id, as a staging tool's answer: a retried
/// call gets the first call's change back, whatever became of it since. An op id that staged a
/// different request (another tool, or other arguments) is refused: answering with the earlier
/// change would tell the caller its new change was staged when it wasn't.
pub(super) async fn staged_before(st: &AppState, user: &User, via: &Via, op: &Op<'_>) -> AppResult<Option<String>> {
    #[allow(clippy::type_complexity)]
    let row: Option<(String, String, Option<String>, String, Option<String>)> =
        sqlx::query_as("SELECT id, summary, detail, status, op_hash FROM assistant_changes WHERE owner_id = ? AND op_id = ?").bind(&user.id).bind(op.id).fetch_optional(&st.pool).await?;
    let Some((id, summary, detail, status, hash)) = row else { return Ok(None) };
    if hash.as_deref() != Some(op.hash.as_str()) {
        return Err(AppError::bad(format!(
            "op_id {} was already used for a different request ({summary}, change id {id}). Use a new op_id for a new change. Nothing was staged.",
            op.id
        )));
    }
    let mut out = format!("Already staged with this op_id; nothing new was staged.\nChange: {summary}\n");
    if let Some(d) = detail.as_deref().filter(|d| !d.trim().is_empty()) {
        let _ = writeln!(out, "{}", d.trim());
    }
    let _ = writeln!(out, "Change id: {id}");
    match (status.as_str(), via) {
        // It may have been staged under an earlier answer, or by another client.
        ("pending", Via::Question(_)) => out.push_str("It is waiting for their review in Yama, with Apply and Discard. Say that it's waiting for their review; never say it's done."),
        ("pending", _) => out.push_str(&next_step(st, via)),
        (decided, _) => {
            let _ = write!(out, "It was {decided} since. To stage the same change again, use a new op_id.");
        }
    }
    Ok(Some(out))
}

/// What happens to a pending change next, for the caller that staged it.
fn next_step(st: &AppState, via: &Via) -> String {
    let page = st.cfg.public_url.as_deref().map(|u| format!("{}/decks/changes", u.trim_end_matches('/'))).unwrap_or_else(|| "Decks, Suggested changes".into());
    match via {
        Via::Question(_) => "It shows under your answer with Apply and Discard buttons. Say that it's waiting for their review; never say it's done.".into(),
        // A connection limited to staging has no apply_change: the person applies it in Yama.
        v if !v.may_apply() => format!("They can apply or discard it in Yama ({page}). This connection can't apply changes, so say it is waiting for them there."),
        _ => format!("They can apply or discard it in Yama ({page}). If they say yes to this change in this conversation, you may call apply_change with its id."),
    }
}

/// Store a change as pending and tell Claude what happens next. With an `op_id` in `args`, a
/// second call stores nothing and answers with the first one's change.
async fn stage(st: &AppState, user: &User, via: &Via, args: &Value, s: Staged) -> AppResult<String> {
    let pool = &st.pool;
    // The table no longer checks the kind (0076): the tool table is the list of kinds.
    if super::registry::applier(s.kind).is_none() {
        return Err(AppError::Other(anyhow::anyhow!("no tool applies the change kind {}", s.kind)));
    }
    let op = op(s.kind, args)?;
    if let Some(op) = &op {
        if let Some(again) = staged_before(st, user, via, op).await? {
            return Ok(again);
        }
    }
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
    let stored = sqlx::query(
        "INSERT INTO assistant_changes (id, owner_id, kind, summary, detail, payload, via, conversation_id, message_id, created_at, op_id, op_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(op.as_ref().map(|o| o.id))
    .bind(op.as_ref().map(|o| o.hash.as_str()))
    .execute(pool)
    .await;
    match (stored, &op) {
        (Ok(_), _) => {}
        // Two calls with one op id at once: the index lets one in, and the other answers with it.
        (Err(e), Some(op)) if e.as_database_error().is_some_and(|d| d.is_unique_violation()) => {
            return match staged_before(st, user, via, op).await? {
                Some(again) => Ok(again),
                None => Err(e.into()),
            };
        }
        (Err(e), _) => return Err(e.into()),
    }
    let mut out = format!("Staged for their review; nothing has changed yet.\nChange: {}\n", s.summary);
    if !s.detail.trim().is_empty() {
        let _ = writeln!(out, "{}", s.detail.trim());
    }
    let _ = writeln!(out, "Change id: {id}");
    out.push_str(&next_step(st, via));
    Ok(out)
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
    let id = deck_id(pool, &user.id, arg::text(args, "deck")?).await?;
    let (name, version): (String, Option<String>) =
        sqlx::query_as("SELECT name, current_version_id FROM decks WHERE id = ? AND owner_id = ?").bind(&id).bind(&user.id).fetch_one(pool).await?;
    let version = version.ok_or_else(|| AppError::bad(format!("{name} has no list yet")))?;
    let (add, remove) = (arg::names(args, "add", MAX_CARDS)?, arg::names(args, "remove", MAX_CARDS)?);
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
    let note = arg::opt_string(args, "note", 500)?;
    let mut detail = String::new();
    if let Some(n) = &note {
        let _ = writeln!(detail, "Why: {n}");
    }
    let _ = write!(detail, "The list after:\n{}", checks(&after, &info));
    stage(st, user, via, args, Staged {
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

// ── deleting a deck ─────────────────────────────────────────────────────────

/// A deck's live configurations: (id, label).
async fn configurations_of(pool: &SqlitePool, owner: &str, deck: &str) -> AppResult<Vec<(String, String)>> {
    let rows: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT id, name, configuration FROM decks WHERE owner_id = ? AND parent_id = ? AND archived = 0 ORDER BY created_at, id")
            .bind(owner)
            .bind(deck)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id, name, label)| (id, label.unwrap_or(name))).collect())
}

pub async fn delete_deck(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let id = deck_id(pool, &user.id, arg::text(args, "deck")?).await?;
    let with_configurations = match args.get("configurations") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(AppError::bad("configurations must be true or false")),
    };
    let (name, parent, label): (String, Option<String>, Option<String>) =
        sqlx::query_as("SELECT d.name, (SELECT p.name FROM decks p WHERE p.id = d.parent_id AND p.archived = 0), d.configuration FROM decks d WHERE d.id = ? AND d.owner_id = ?")
            .bind(&id)
            .bind(&user.id)
            .fetch_one(pool)
            .await?;
    let configs = configurations_of(pool, &user.id, &id).await?;
    let labels = configs.iter().map(|(_, l)| l.as_str()).collect::<Vec<_>>().join(", ");
    let (summary, detail) = match (&parent, configs.is_empty(), with_configurations) {
        (Some(main), _, _) => (
            format!("Delete the {} configuration of {main}", label.as_deref().unwrap_or(&name)),
            format!("{name} leaves their decks; {main} and its other configurations stay."),
        ),
        (None, true, _) => (format!("Delete {name}"), format!("{name} leaves their decks.")),
        (None, false, true) => (
            format!("Delete {name} and its {} configuration{}", configs.len(), if configs.len() == 1 { "" } else { "s" }),
            format!("{name} and its configurations ({labels}) leave their decks."),
        ),
        (None, false, false) => (
            format!("Delete {name}"),
            format!("{name} leaves their decks. Its configurations ({labels}) stay as decks of their own."),
        ),
    };
    let detail = format!("{detail} Its share link stops working; games already played keep their record.");
    let pinned: Vec<&str> = configs.iter().map(|(c, _)| c.as_str()).collect();
    stage(st, user, via, args, Staged {
            kind: "delete_deck",
            summary,
            detail,
            payload: json!({"deck_id": id, "deck": name, "configurations": with_configurations, "configuration_ids": pinned}),
        },
    )
    .await
}

async fn apply_delete_deck(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let pool = &st.pool;
    let deck_id = p["deck_id"].as_str().unwrap_or_default();
    let deck = p["deck"].as_str().unwrap_or("the deck");
    let live: Option<bool> = sqlx::query_scalar("SELECT archived FROM decks WHERE id = ? AND owner_id = ?").bind(deck_id).bind(&user.id).fetch_optional(pool).await?;
    if live != Some(false) {
        return Err(AppError::Conflict(format!("{deck} isn't in your decks any more.")));
    }
    let with_configurations = p["configurations"] == true;
    // Deleting configurations deletes the ones that were named when this was suggested, never one
    // made since (checked in the delete's own transaction).
    let pinned: Vec<String> = p["configuration_ids"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
    st.limits.deck_writes.check_user(user)?;
    let done = crate::decks::delete_pinned(pool, &user.id, deck_id, with_configurations, Some(&pinned)).await.map_err(|e| match e {
        AppError::Conflict(_) => AppError::Conflict(format!("{deck}'s configurations changed after this was suggested, so it wasn't applied. Discard it and ask again.")),
        other => other,
    })?;
    let label = match (done.deleted.len(), done.kept.len()) {
        (1, 0) => format!("Deleted {deck}"),
        (1, 1) => format!("Deleted {deck}; its configuration is now a deck of its own"),
        (1, kept) => format!("Deleted {deck}; its {kept} configurations are now decks of their own"),
        (n, _) => format!("Deleted {deck} and {} configuration{}", n - 1, if n == 2 { "" } else { "s" }),
    };
    Ok(json!({"label": label, "link": "/decks"}))
}

// ── complete deck lists ─────────────────────────────────────────────────────

/// Complete-list construction/import/restore uses the existing edit_deck change kind. The
/// payload distinguishes it from add/remove edits, so no migration or second review queue is
/// needed. The list is pinned at staging, never fetched again during Apply.
pub async fn save_deck(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    use super::research::analysis;
    if args.get("version").is_some() {
        return Err(AppError::bad(
            "Inspect the historical version first, then pass its complete list to save_deck.",
        ));
    }
    let text = arg::text_max(args, "list", 30000)?;
    let first = arg::flag(args, "first_is_commander", true)?;
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
    let (target, base, name) = if let Some(deck) = arg::opt_text(args, "deck", 200)? {
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
        (None, None, arg::text_max(args, "name", 200)?.into())
    };
    let note = arg::opt_text(args, "note", 1000)?
        .unwrap_or("Complete list proposed through Yama")
        .to_string();
    let source = arg::opt_text(args, "source_url", 1000)?
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
    stage(st, user, via, args, Staged {kind:"edit_deck",summary,detail,payload:json!({"complete_list":true,"deck_id":target,"base_version":base,"name":name,"cards":list.cards,"note":note,"source_url":source})}).await
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
pub(super) async fn plan_deck(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<(String, String)> {
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
    let (deck_key, deck) = plan_deck(pool, owner, arg::text(args, "plan")?).await?;
    let card_in = arg::text(args, "card_in")?;
    let card_out = arg::opt_string(args, "card_out", 200)?;
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
            "{deck}'s plan has no swap putting in {card_in}{}. Check the card names with get_plan.",
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
    let (deck_key, deck) = plan_deck(pool, &user.id, arg::text(args, "plan")?).await?;
    let card_in = arg::text(args, "card_in")?.to_string();
    let card_out = arg::opt_string(args, "card_out", 200)?;
    let why = arg::opt_string(args, "why", 2000)?;
    let mut names = vec![card_in.clone()];
    names.extend(card_out.clone());
    let known = known_cards(pool, &names).await?;
    let card_in = known[&card_in].1.clone();
    let card_out = card_out.map(|o| known[&o].1.clone());
    let summary = match &card_out {
        Some(o) => format!("Idea for {deck}: {card_in} for {o}"),
        None => format!("Idea for {deck}: add {card_in}"),
    };
    stage(st, user, via, args, Staged {
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
    let decision = arg::text(args, "decision")?;
    let label = DECISIONS.iter().find(|(d, _)| *d == decision).map(|(_, l)| *l).ok_or_else(|| AppError::bad("decision must be want, unsure or no"))?;
    let note = arg::opt_string(args, "note", 2000)?;
    let cut = arg::opt_string(args, "cut", 300)?;
    let mut detail = String::new();
    if let Some(c) = &cut {
        let _ = writeln!(detail, "Cut {c} instead.");
    }
    if let Some(n) = &note {
        let _ = writeln!(detail, "Note: {n}");
    }
    stage(st, user, via, args, Staged {
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
    let on = arg::opt_string(args, "on", 10)?.unwrap_or_else(|| Utc::now().format("%Y-%m-%d").to_string());
    if !crate::plan::model::is_date(&on) {
        return Err(AppError::bad(format!("on: \"{on}\" isn't a YYYY-MM-DD date")));
    }
    let qty = args.get("qty").and_then(Value::as_i64).unwrap_or(1);
    if !(1..=100).contains(&qty) {
        return Err(AppError::bad("qty must be from 1 to 100"));
    }
    let price = args.get("price_paid").and_then(Value::as_f64).filter(|p| p.is_finite() && *p >= 0.0);
    let store = arg::opt_string(args, "store", 200)?;
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
    stage(st, user, via, args, Staged {
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
    stage(st, user, via, args, Staged { kind: "mark_installed", summary, detail: String::new(), payload: json!({"swap_key": swap.key, "deck_key": swap.deck_key, "deck": swap.deck, "value": value}) },
    )
    .await
}

pub async fn swap_in_prints(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let (key, name) = plan_deck(&st.pool, &user.id, arg::text(args, "plan")?).await?;
    let preview = crate::plan::swap_in::run(&st.pool, &user.id, &key, true).await?;
    if preview.done {
        return Ok(preview.text());
    }
    stage(st, user, via, args, Staged {
            kind: "swap_in_prints",
            summary: format!("Swap the prints into {name}: {} proxies, {} cards moved, {} swaps ticked installed", preview.proxies_added, preview.moved, preview.ticks.len()),
            detail: preview.text(),
            payload: json!({"deck_key": key, "deck": name}),
        },
    )
    .await
}

/// Track one build of a note's deck as that deck's plan, or stop tracking (`build` null). Applied
/// through `plan::notes`, the same code as `POST /api/plan/from-note`.
pub async fn track_build(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    use crate::plan::notes::{find_build, find_deck, note_document};
    let pool = &st.pool;
    let note_id = arg::text(args, "note")?.to_string();
    let deck_key = arg::text(args, "deck")?.to_string();
    let build_id = match args.get("build") {
        None | Some(Value::Null) => None,
        Some(Value::String(b)) if !b.trim().is_empty() => Some(b.trim().to_string()),
        _ => return Err(AppError::bad("build is a build id from the note, or null to stop tracking")),
    };
    let (doc, note_hash) = {
        let mut conn = pool.acquire().await?;
        note_document(&mut conn, &user.id, &note_id).await?
    };
    let title = doc["title"].as_str().unwrap_or(&note_id).to_string();
    let keys = |v: &Value, list: &str, field: &str| -> String {
        v[list].as_array().into_iter().flatten().filter_map(|x| x[field].as_str()).collect::<Vec<_>>().join(", ")
    };
    let deck = find_deck(&doc, &deck_key)
        .ok_or_else(|| AppError::bad(format!("The note \"{title}\" has no deck \"{deck_key}\"; its decks are {}.", keys(&doc, "decks", "key"))))?;
    let deck_name = deck["name"].as_str().unwrap_or(&deck_key).to_string();
    let tracked: Option<(String, String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT key, status, note_build_id, deck_id FROM plan_decks WHERE owner_id = ? AND note_id = ? AND note_deck_key = ?")
            .bind(&user.id)
            .bind(&note_id)
            .bind(&deck_key)
            .fetch_optional(pool)
            .await?;
    let active = tracked.as_ref().filter(|t| t.1 != "archived");
    let Some(build_id) = build_id else {
        let Some((key, _, _, _)) = active else {
            return Ok(format!("No build of {deck_name} in \"{title}\" is tracked, so there's nothing to stop."));
        };
        return stage(st, user, via, args, Staged {
                kind: "track_build",
                summary: format!("Stop tracking {deck_name}'s plan"),
                detail: "Its swaps, marks and answers are kept; tracking a build again brings them back.".into(),
                payload: json!({"note_id": note_id, "deck_key": deck_key, "build_id": null, "plan_deck_key": key, "deck": deck_name}),
            },
        )
        .await;
    };
    let build = find_build(deck, &build_id)
        .ok_or_else(|| AppError::bad(format!("{deck_name} in \"{title}\" has no build \"{build_id}\"; its builds are {}.", keys(deck, "builds", "id"))))?;
    let label = build["label"].as_str().unwrap_or(&build_id).to_string();
    let yama_deck = match args.get("yama_deck").and_then(Value::as_str).map(str::trim).filter(|w| !w.is_empty()) {
        Some(w) => Some(deck_id(pool, &user.id, w).await?),
        None => None,
    };
    // The same build again is nothing to do, unless it asks for another Yama deck: then it relinks.
    let relink = match active {
        Some((key, _, Some(current), linked)) if *current == build_id => {
            if yama_deck.is_none() || yama_deck == *linked {
                return Ok(format!("{label} is already {deck_name}'s plan (plan key {key}); nothing to stage."));
            }
            true
        }
        _ => false,
    };
    let swaps = build["swaps"].as_array().cloned().unwrap_or_default();
    let mut detail = format!("From the note \"{title}\": {} swap{}.\n", swaps.len(), if swaps.len() == 1 { "" } else { "s" });
    for s in swaps.iter().take(40) {
        let card_in = s["card_in"].as_str().unwrap_or_default();
        let _ = match s["card_out"].as_str().filter(|o| !o.trim().is_empty()) {
            Some(out) => writeln!(detail, "- {card_in} in, {out} out"),
            None => writeln!(detail, "- add {card_in}"),
        };
    }
    if swaps.len() > 40 {
        writeln!(detail, "...and {} more.", swaps.len() - 40).ok();
    }
    let summary = match active {
        Some(_) if relink => format!("Link {deck_name}'s plan ({label}) to another Yama deck"),
        Some(_) => format!("Switch {deck_name}'s plan to {label}"),
        None => format!("Track {label} as {deck_name}'s plan"),
    };
    stage(st, user, via, args, Staged {
            kind: "track_build",
            summary,
            detail,
            // The note as reviewed: applying refuses if it has changed since (plan::notes::track).
            payload: json!({"note_id": note_id, "deck_key": deck_key, "build_id": build_id, "deck_id": yama_deck, "deck": deck_name, "label": label, "note_hash": note_hash}),
        },
    )
    .await
}

/// Approve a deck's plan version whole, or keep the version before it (`plan::versions`). The
/// version, its changes and the skips are fixed when staged; applying refuses if the plan has
/// changed since, so what they approve is what they saw.
pub async fn approve_plan(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let (key, name) = plan_deck(pool, &user.id, arg::text(args, "plan")?).await?;
    let action = args.get("action").and_then(Value::as_str).unwrap_or("approve");
    if !["approve", "keep"].contains(&action) {
        return Err(AppError::bad("action is approve (the default) or keep (keep the version before it)"));
    }
    let id: String = sqlx::query_scalar("SELECT id FROM plan_decks WHERE owner_id = ? AND key = ?").bind(&user.id).bind(&key).fetch_one(pool).await?;
    let plan = {
        let mut conn = pool.acquire().await?;
        crate::plan::versions::load(&mut conn, &user.id, None).await?.decks.remove(&id)
    }
    .ok_or(AppError::NotFound("plan deck"))?;
    let Some(next) = plan.next.clone() else {
        return Ok(format!("Nothing in {name}'s plan is waiting for their OK ({}).", crate::advisor::context::plan_state_text(&plan)));
    };
    let swaps: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT s.ext_key, s.in_name, s.out_name FROM plan_swaps s WHERE s.owner_id = ? AND s.plan_deck_id = ? AND s.retired_at IS NULL")
            .bind(&user.id)
            .bind(&id)
            .fetch_all(pool)
            .await?;
    // Each change as it will be approved: the cut the page shows (a chosen cut, or the plan's
    // fallback when its cut is already going), else the plan's.
    let label = |k: &str| {
        let cut = next.cuts.iter().find(|c| c.key == k).map(|c| c.out.clone());
        swaps
            .iter()
            .find(|s| s.0 == k)
            .map(|(_, i, o)| cut.clone().unwrap_or_else(|| o.clone()).map(|o| format!("{i} for {o}")).unwrap_or_else(|| i.clone()))
            .unwrap_or_else(|| k.to_string())
    };
    // Skips name a change by its key or by the card it puts in.
    // The page's starting skips: answered no, and cuts the plan in force already makes.
    let mut skip: Vec<String> = crate::plan::versions::start_skipped(&next);
    for w in args.get("skip").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        let w = w.trim();
        // A key names one change; a card name names every change that puts it in (each copy of a
        // note swap is its own change), so skipping a card skips all of them.
        let found: Vec<&String> = match next.keys.iter().find(|k| k.as_str() == w) {
            Some(k) => vec![k],
            None => next.keys.iter().filter(|k| swaps.iter().any(|s| &s.0 == *k && s.1.eq_ignore_ascii_case(w))).collect(),
        };
        if found.is_empty() {
            return Err(AppError::bad(format!("\"{w}\" isn't one of the changes waiting in {name}'s version {}.", next.n)));
        }
        for k in found {
            if !skip.contains(k) {
                skip.push(k.clone());
            }
        }
    }
    // Keeping the version before answers no to every change waiting, so it names them all.
    if action == "keep" {
        skip.clear();
    }
    let keys: Vec<String> = if action == "keep" { next.keys.clone() } else { next.keys.iter().filter(|k| !skip.contains(k)).cloned().collect() };
    let mut answers: Vec<Value> = Vec::new();
    for a in args.get("answers").and_then(Value::as_array).into_iter().flatten() {
        let (Some(q), Some(ans)) = (a.get("question").and_then(Value::as_str), a.get("answer").and_then(Value::as_str)) else {
            return Err(AppError::bad("answers is a list of {question, answer}, the question as get_plan lists it"));
        };
        answers.push(json!({"question": q, "answer": ans}));
    }
    if action == "approve" {
        for q in &plan.questions {
            if !answers.iter().any(|a| a["question"].as_str() == Some(q) && a["answer"].as_str().is_some_and(|x| !x.trim().is_empty())) {
                return Err(AppError::bad(format!("Answer this open question first (their answer, in answers): {q}")));
            }
        }
        if keys.is_empty() {
            return Err(AppError::bad("Every change would be skipped; there's nothing to approve."));
        }
        // The page's checks: no card to cut, a cut already going, two changes cutting one card.
        let problems = crate::plan::versions::problems(&next, &skip);
        if !problems.is_empty() {
            return Err(AppError::bad(format!(
                "Settle these first (skip a change, or propose a fixed one):\n- {}",
                problems.join("\n- ")
            )));
        }
    }
    let summary = if action == "approve" {
        format!("Approve {name}'s plan, version {}: {} changes{}", next.n, keys.len(), if skip.is_empty() { String::new() } else { format!(", {} skipped", skip.len()) })
    } else {
        format!("Keep {name}'s plan at version {}, not version {}", plan.version.unwrap_or(1), next.n)
    };
    let mut detail = String::new();
    if action == "approve" {
        for k in keys.iter().take(60) {
            let _ = writeln!(detail, "- {}", label(k));
        }
        if keys.len() > 60 {
            let _ = writeln!(detail, "...and {} more.", keys.len() - 60);
        }
        for k in &skip {
            let _ = writeln!(detail, "- skip {}", label(k));
        }
        for a in &answers {
            let _ = writeln!(detail, "{} {}", a["question"].as_str().unwrap_or_default(), a["answer"].as_str().unwrap_or_default());
        }
    }
    stage(st, user, via, args, Staged {
            kind: "approve_plan",
            summary,
            detail,
            payload: json!({"deck_key": key, "deck": name, "action": action, "version": next.n, "keys": keys, "skip": skip, "answers": answers, "hash": next.hash}),
        },
    )
    .await
}

async fn apply_approve_plan(st: &AppState, user: &User, id: &str, p: &Value) -> AppResult<Value> {
    let at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    let op = json!({
        "op_id": format!("{DEVICE}-{id}"), "device_id": DEVICE, "at": at, "kind": "plan", "deck_key": p["deck_key"],
        "action": p["action"], "version": p["version"], "keys": p["keys"], "skip": p["skip"], "answers": p["answers"], "hash": p["hash"],
    });
    let reply = crate::plan::inputs::apply_ops(&st.pool, &user.id, vec![op], Utc::now()).await?;
    let r = reply.results.first().ok_or_else(|| anyhow::anyhow!("the planner returned no result"))?;
    if r.status == "rejected" || r.original.as_deref() == Some("rejected") {
        return Err(AppError::Conflict(format!("The plan refused it: {}", r.error.clone().unwrap_or_default())));
    }
    let deck = p["deck"].as_str().unwrap_or("the deck");
    let label = if p["action"] == "keep" { format!("Kept {deck}'s plan as it was") } else { format!("Approved {deck}'s plan, version {}", p["version"]) };
    Ok(json!({"label": label, "link": crate::plan::page_link(p["deck_key"].as_str().unwrap_or_default())}))
}

async fn apply_track_build(st: &AppState, user: &User, id: &str, p: &Value) -> AppResult<Value> {
    st.limits.deck_writes.check_user(user)?;
    let note_id = p["note_id"].as_str().unwrap_or_default().to_string();
    let deck_key = p["deck_key"].as_str().unwrap_or_default().to_string();
    match p["build_id"].as_str() {
        Some(build_id) => {
            let req = crate::plan::notes::TrackRequest {
                note_id,
                deck_key,
                build_id: build_id.to_string(),
                deck_id: p["deck_id"].as_str().map(String::from),
                op_id: Some(format!("{DEVICE}-{id}")),
                expected_note_hash: p["note_hash"].as_str().map(String::from),
                // A build taken up from a note is a plan version waiting for their OK.
                proposed: true,
            };
            let t = crate::plan::notes::track(&st.pool, &user.id, &req).await?;
            Ok(json!({"label": format!("{} is {}'s next plan version, waiting for your OK ({} changes)", t.build_label, t.name, t.swaps), "link": t.link}))
        }
        None => {
            // Found by the note link: an import may have moved the plan to another key since.
            let key: Option<String> = sqlx::query_scalar("SELECT key FROM plan_decks WHERE owner_id = ? AND note_id = ? AND note_deck_key = ?")
                .bind(&user.id)
                .bind(&note_id)
                .bind(&deck_key)
                .fetch_optional(&st.pool)
                .await?;
            crate::plan::notes::stop(&st.pool, &user.id, &key.ok_or(AppError::NotFound("plan deck"))?).await?;
            Ok(json!({"label": format!("Stopped tracking {}'s plan", p["deck"].as_str().unwrap_or("the deck")), "link": "/decks/plans"}))
        }
    }
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
    Ok(json!({"label": label, "link": crate::plan::page_link(p["deck_key"].as_str().unwrap_or_default())}))
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
    match (arg::opt_string(args, deck, 300)?, arg::opt_string(args, list, crate::lab::experiments::MAX_TEXT_BYTES)?) {
        (Some(d), None) => list_choice(pool, owner, &d).await,
        (None, Some(text)) => {
            let label = arg::opt_string(args, label, 120)?.unwrap_or_else(|| "A pasted list".into());
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
    let mode = arg::opt_string(args, "mode", 20)?.unwrap_or_else(|| "change".into());
    let games = games_arg(user, args, None)?;
    let engine = arg::opt_string(args, "engine", 10)?.unwrap_or_else(|| "phase".into());
    crate::lab::forge::EngineMode::parse(Some(&engine)).map_err(AppError::bad)?;
    let ai = arg::opt_string(args, "ai", 10)?.unwrap_or_else(|| "Easy".into());
    if !["Easy", "Medium"].contains(&ai.as_str()) && !user.is_admin {
        return Err(AppError::bad("ai must be Easy or Medium"));
    }
    let forge_ai = arg::opt_string(args, "forge_ai", 20)?.unwrap_or_else(|| crate::lab::forge::DEFAULT_PROFILE.into());
    if !crate::lab::forge::FORGE_PROFILES.contains(&forge_ai.as_str()) {
        return Err(AppError::bad(format!("forge_ai must be one of {}", crate::lab::forge::FORGE_PROFILES.join(", "))));
    }
    let (field, against) = match arg::opt_string(args, "opponents", 20)?.as_deref() {
        None | Some("strongest") => (json!({"kind": "precons_top", "n": crate::lab::experiments::DEFAULT_FIELD}), "the strongest precons".to_string()),
        Some("similar") => match arg::opt_string(args, "near", 300)? {
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
            let (add, cut) = (arg::names(args, "add", MAX_CARDS)?, arg::names(args, "cut", MAX_CARDS)?);
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
                let text = arg::opt_string(input, "list", crate::lab::experiments::MAX_TEXT_BYTES)?.ok_or_else(|| AppError::bad("Each pasted entrant needs list text"))?;
                let label = arg::opt_string(input, "label", 120)?.filter(|s| !s.trim().is_empty()).ok_or_else(|| AppError::bad("Each pasted entrant needs a label"))?;
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
    stage(st, user, via, args, Staged { kind: "start_lab_run", summary, detail, payload: request }).await
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
    let id = arg::text(args, "id")?;
    let run = run_info(&st.pool, &user.id, id).await?;
    if matches!(run.mode.as_str(), "versus" | "tournament") {
        return Err(AppError::bad("A head-to-head run can't take more games; use rerun_lab_run."));
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
    stage(st, user, via, args, Staged { kind: "more_lab_games", summary, detail, payload: json!({"experiment": id, "games": games, "seen_pods": run.pods}) }).await
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
    let id = arg::text(args, "id")?;
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
    stage(st, user, via, args, Staged { kind: "run_lab_again", summary, detail, payload: json!({"experiment": id, "games": games}) }).await
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
    let id = arg::text(args, "id")?;
    let run = run_info(&st.pool, &user.id, id).await?;
    if !matches!(run.status.as_str(), "queued" | "running") {
        return Err(AppError::bad(format!("This run is {}, so there's nothing to cancel.", run.status)));
    }
    let summary = format!("Cancel lab run, {}", run.name);
    let detail = "Games already playing finish and count; no new ones start. The results so far stay.".to_string();
    stage(st, user, via, args, Staged { kind: "cancel_lab_run", summary, detail, payload: json!({"experiment": id}) }).await
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
    let wanted = arg::text(args, "card")?.to_string();
    let known = known_cards(pool, std::slice::from_ref(&wanted)).await?;
    let (oracle_id, name) = known[&wanted].clone();
    let qty = args.get("qty").and_then(Value::as_i64).unwrap_or(1);
    if !(1..=100).contains(&qty) {
        return Err(AppError::bad("qty must be from 1 to 100"));
    }
    let set = arg::opt_string(args, "set", 10)?;
    let number = arg::opt_string(args, "number", 20)?;
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
    let place = match arg::opt_string(args, "container", 200)? {
        Some(c) => Some(container(pool, &user.id, &c).await?),
        None => None,
    };
    let proxy = args.get("proxy").and_then(Value::as_bool).unwrap_or(false);
    let finish = arg::opt_string(args, "finish", 10)?.unwrap_or_else(|| "nonfoil".into());
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
    stage(st, user, via, args, Staged { kind: "add_to_collection", summary, detail: String::new(), payload }).await
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
    set_code: Option<String>,
    collector_number: Option<String>,
}

impl CopyRow {
    /// "TST #12, foil, LP, proxy": what tells this row's copies from the card's other copies.
    fn kind(&self) -> String {
        let mut said = format!("{} #{}", self.set_code.as_deref().unwrap_or("?").to_uppercase(), self.collector_number.as_deref().unwrap_or("?"));
        for part in [self.finish.as_str(), self.condition.as_str()] {
            said.push_str(", ");
            said.push_str(part);
        }
        if self.proxy {
            said.push_str(", proxy");
        }
        said
    }
}

async fn copies_in(conn: &mut sqlx::SqliteConnection, owner: &str, oracle_id: &str, container_id: &str) -> AppResult<Vec<CopyRow>> {
    Ok(sqlx::query_as(
        "SELECT i.id, i.qty, i.scryfall_id, i.condition, i.finish, i.lang, i.altered, i.signed, i.misprint, i.proxy, i.purchase_price,
                p.set_code, p.collector_number
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
    let wanted = arg::text(args, "card")?.to_string();
    let known = known_cards(pool, std::slice::from_ref(&wanted)).await?;
    let (oracle_id, name) = known[&wanted].clone();
    let qty = args.get("qty").and_then(Value::as_i64).unwrap_or(1);
    if !(1..=100).contains(&qty) {
        return Err(AppError::bad("qty must be from 1 to 100"));
    }
    let from = container(pool, &user.id, arg::text(args, "from")?).await?;
    let to = container(pool, &user.id, arg::text(args, "to")?).await?;
    if from.0 == to.0 {
        return Err(AppError::bad("from and to are the same place"));
    }
    let have: i64 = copies_in(&mut *pool.acquire().await?, &user.id, &oracle_id, &from.0).await?.iter().map(|c| c.qty).sum();
    if have < qty {
        return Err(AppError::bad(format!("{} holds {have} {name}, not {qty}. Nothing was staged.", from.1)));
    }
    let summary = format!("Move {qty} {name} from {} to {}", from.1, to.1);
    let payload = json!({"oracle_id": oracle_id, "name": name, "qty": qty, "from_id": from.0, "from": from.1, "to_id": to.0, "to": to.1});
    stage(st, user, via, args, Staged { kind: "move_cards", summary, detail: String::new(), payload }).await
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
    let condition = arg::text(args, "condition")?.to_uppercase();
    let Some((_, said)) = CONDITIONS.iter().find(|(c, _)| *c == condition) else {
        return Err(AppError::bad("condition must be NM, LP, MP, HP or DMG"));
    };
    let place = container(pool, &user.id, arg::text(args, "container")?).await?;
    let card = match arg::opt_string(args, "card", 200)? {
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
    stage(st, user, via, args, Staged { kind: "set_condition", summary, detail, payload }).await
}

async fn apply_collection(st: &AppState, user: &User, kind: &str, id: &str, p: &Value) -> AppResult<Value> {
    use crate::collection::{CopyKind, Op, OpKind, apply_op};
    let op = |n: usize, op: OpKind| Op { op_id: format!("{DEVICE}-{id}-{n}"), device_id: Some(DEVICE.into()), op };
    let mut tx = st.pool.begin().await?;
    if !first_apply(&mut tx, &user.id, id, kind).await? {
        return Ok(json!({"label": "Already done", "link": "/collection"}));
    }
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
                scryfall_id: None,
                split: None,
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
                    scryfall_id: None,
                    split: None,
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
    Ok(json!({"label": label, "link": crate::plan::page_link(&key)}))
}

// ── applying and discarding ─────────────────────────────────────────────────

/// One apply at a time on this server, so two taps (or a tap and `apply_change`) can't both run a
/// change that isn't idempotent on its own (a deck edit).
// ── shopping settings (docs/shopping-design.md) ─────────────────────────────

/// A store of theirs by key or name (case-insensitive), not retired.
pub(super) async fn their_store(pool: &SqlitePool, owner: &str, wanted: &str) -> AppResult<(String, String)> {
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


/// The parts of a buy-rule change Claude named, checked for type. Only these are applied, over
/// whatever rule is in force when the person applies it, so a staged change never reverts an edit
/// made in between.
fn rules_changes(args: &Value) -> AppResult<Value> {
    let mut out = serde_json::Map::new();
    for key in ["max_usd", "always_ok_usd", "sealed_max_usd"] {
        if let Some(v) = arg::opt_number(args, key)? {
            out.insert(key.into(), json!(v));
        }
    }
    if let Some(t) = args.get("tiers").filter(|t| !t.is_null()) {
        let tiers: Vec<crate::plan::shopping::Tier> =
            serde_json::from_value(t.clone()).map_err(|_| AppError::bad("tiers must be a list of {market_under: number or null, max_multiple: number}"))?;
        out.insert("tiers".into(), json!(tiers.iter().map(|t| json!({"market_under": t.market_under, "max_multiple": t.max_multiple})).collect::<Vec<_>>()));
    }
    if out.is_empty() {
        return Err(AppError::bad("Name at least one of max_usd, always_ok_usd, tiers or sealed_max_usd. Nothing was staged."));
    }
    Ok(Value::Object(out))
}

/// The rule in force today with the named parts replaced, and what's wrong with it.
async fn rules_with(st: &AppState, user: &User, changes: &Value) -> AppResult<(crate::plan::shopping::LocalBuy, Option<f64>, Vec<String>)> {
    use crate::plan::shopping::{LocalBuy, problems};
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let bundle = crate::plan::bundle::load_bundle(&st.pool, &user.id).await?;
    let empty = vec![];
    let sets = bundle["settings"].as_array().unwrap_or(&empty);
    let set = crate::plan::trip::rules_at(sets, &today);
    let current = crate::plan::trip::local_buy_rule(set).rule.unwrap_or(crate::plan::trip::LocalBuyRule { max_usd: None, always_ok_usd: None, tiers: vec![] });
    let mut lb = LocalBuy::from_rule(&current);
    let mut sealed = set.and_then(|s| s["rules"]["sealed_max_usd"].as_f64());
    if let Some(v) = changes.get("max_usd") {
        lb.max_usd = v.as_f64();
    }
    if let Some(v) = changes.get("always_ok_usd") {
        lb.always_ok_usd = v.as_f64();
    }
    if let Some(v) = changes.get("tiers") {
        lb.tiers = serde_json::from_value(v.clone()).map_err(anyhow::Error::from)?;
    }
    if let Some(v) = changes.get("sealed_max_usd") {
        sealed = v.as_f64();
    }
    let found = problems(&lb, sealed);
    Ok((lb, sealed, found))
}

/// `set_shopping_rules`: a new buy rule and sealed cap, as a rule set from the day they apply it.
/// Only the parts named change, over the rule in force when it's applied.
pub async fn set_shopping_rules(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let changes = rules_changes(args)?;
    let (lb, sealed, found) = rules_with(st, user, &changes).await?;
    if !found.is_empty() {
        return Err(AppError::bad(format!("{} Nothing was staged.", found.join(" "))));
    }
    let note = arg::opt_string(args, "note", 500)?;
    let text = crate::plan::trip::rule_text(&lb.rule());
    let summary = "Change the buy rule".to_string();
    let detail = format!(
        "{text} Sealed precons: {}. Applies from the day it's applied; older checks keep their own day's rules. Only the parts named change; the rest stay as they are then.",
        sealed.map_or_else(|| "no limit".to_string(), |v| format!("at most ${v:.2} a deck before tax"))
    );
    let payload = json!({"changes": changes, "note": note});
    stage(st, user, via, args, Staged { kind: "set_shopping_rules", summary, detail, payload }).await
}

async fn apply_shopping_rules(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let (lb, sealed, found) = rules_with(st, user, &p["changes"]).await?;
    if !found.is_empty() {
        return Err(AppError::Conflict(format!("With the rule in force now, this change doesn't make sense: {}", found.join(" "))));
    }
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let saved = crate::plan::shopping::save_rules(&st.pool, &user.id, &today, &lb, sealed, p["note"].as_str()).await?;
    Ok(json!({"label": format!("New rule set from {today}."), "effective_from": saved["effective_from"]}))
}

/// The parts of a store setting Claude named, checked for type; only these are applied.
fn pref_changes(args: &Value) -> AppResult<Value> {
    use crate::plan::shopping::PREFERENCES;
    let mut out = serde_json::Map::new();
    if let Some(v) = args.get("preference").filter(|v| !v.is_null()) {
        let v = v.as_str().filter(|v| PREFERENCES.contains(v)).ok_or_else(|| AppError::bad("preference must be favorite, ok, maybe or never"))?;
        out.insert("preference".into(), json!(v));
    }
    match args.get("hassle") {
        None => {}
        Some(Value::Null) => {
            out.insert("hassle".into(), Value::Null);
        }
        Some(v) => {
            out.insert("hassle".into(), json!(v.as_i64().ok_or_else(|| AppError::bad("hassle must be a whole number from 1 (easiest to get to)"))?));
        }
    }
    if let Some(v) = arg::opt_number(args, "premium_usd")? {
        out.insert("premium_usd".into(), json!(v.filter(|x| *x > 0.0)));
    }
    if args.get("note").is_some() {
        out.insert("note".into(), json!(arg::opt_string(args, "note", 500)?));
    }
    if out.is_empty() {
        return Err(AppError::bad("Name at least one of preference, hassle, premium_usd or note. Nothing was staged."));
    }
    Ok(Value::Object(out))
}

/// The store's setting now with the named parts replaced.
async fn pref_with(pool: &SqlitePool, owner: &str, key: &str, changes: &Value) -> AppResult<crate::plan::shopping::Pref> {
    let mut p = crate::plan::shopping::get_pref(pool, owner, key).await?;
    if p.preference == "default" {
        p.preference = "favorite".into();
    }
    if let Some(v) = changes.get("preference").and_then(Value::as_str) {
        p.preference = v.into();
    }
    if let Some(v) = changes.get("hassle") {
        p.hassle = v.as_i64();
    }
    if let Some(v) = changes.get("premium_usd") {
        p.premium_usd = v.as_f64();
    }
    if let Some(v) = changes.get("note") {
        p.note = v.as_str().map(String::from);
    }
    p.check()?;
    Ok(p)
}

/// `set_store_preference`: one store's level, place in their order and premium. Only the parts
/// named change, over the setting as it is when they apply it.
pub async fn set_store_preference(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let (key, name) = their_store(&st.pool, &user.id, arg::text(args, "store")?).await?;
    let changes = pref_changes(args)?;
    let p = pref_with(&st.pool, &user.id, &key, &changes).await?;
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
    let payload = json!({"store": key, "changes": changes});
    stage(st, user, via, args, Staged { kind: "set_store_preference", summary, detail: parts.join("; ") + ".", payload }).await
}

async fn apply_store_preference(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let key = p["store"].as_str().unwrap_or_default();
    // Check the store is still one of theirs before writing anything (an import may have retired it).
    let active: Option<String> = sqlx::query_scalar("SELECT key FROM plan_stores WHERE owner_id = ? AND key = ? AND retired_at IS NULL AND kind != 'printer'")
        .bind(&user.id)
        .bind(key)
        .fetch_optional(&st.pool)
        .await?;
    if active.is_none() {
        return Err(AppError::Conflict(format!("{key} is no longer one of their stores.")));
    }
    let pref = pref_with(&st.pool, &user.id, key, &p["changes"]).await?;
    crate::plan::shopping::set_pref(&st.pool, &user.id, key, &pref).await?;
    if let Some(place) = p["changes"].get("hassle").and_then(Value::as_i64) {
        crate::plan::shopping::place_store(&st.pool, &user.id, key, place).await?;
    }
    Ok(json!({"label": format!("Saved your setting for {key}.")}))
}

/// `check_stores`: read their stores' stock (`plan/stock.rs`) when they apply it, for the cards
/// named (default: every card the trip plans for).
pub async fn check_stores(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    use crate::plan::stock;
    let cards = arg::names(args, "cards", stock::MAX_CARDS)?;
    let mut stores: Vec<(String, String)> = Vec::new();
    if let Some(v) = args.get("stores").filter(|v| !v.is_null()) {
        let list = v.as_array().ok_or_else(|| AppError::bad("stores must be a list of store keys or names"))?;
        for x in list {
            let found = their_store(&st.pool, &user.id, x.as_str().ok_or_else(|| AppError::bad("stores must be a list of store keys or names"))?).await?;
            if !stores.contains(&found) {
                stores.push(found);
            }
        }
    }
    let refresh_catalog = args.get("refresh_catalog").and_then(Value::as_bool).unwrap_or(false);
    let yestcg = args.get("yestcg").and_then(Value::as_bool).unwrap_or(false);
    // Say now which stores Yama can't read, so Claude doesn't stage a check that reads nothing.
    let checkable = stock::checkable(&st.pool, &user.id).await?;
    let readable = |key: &str| checkable.iter().any(|c| c.0 == key && (c.2.is_some() || (yestcg && c.3.is_some())));
    let named: Vec<&(String, String)> = stores.iter().collect();
    // With no stores named, at least one store they'll go to must be readable.
    if named.is_empty() && !checkable.iter().any(|c| c.4 != "never" && readable(&c.0)) {
        return Err(AppError::bad(format!(
            "Yama can't read any of their stores' stock{}. It reads the store websites on its own short list and TCGplayer Pro storefronts. Nothing was staged.",
            if yestcg { "" } else { " (try yestcg: true)" }
        )));
    }
    if let Some((_, name)) = named.iter().find(|(k, _)| !readable(k)) {
        return Err(AppError::bad(format!(
            "Yama can't read {name}'s stock{}. It reads the store websites on its own short list and TCGplayer Pro storefronts; YesTCG covers some others. Nothing was staged.",
            if yestcg { "" } else { " (try yestcg: true)" }
        )));
    }
    // Something must actually be read: a whole catalog, or a card search with cards to look for
    // (the trip's when none are named).
    let cards_now = if cards.is_empty() && refresh_catalog { Vec::new() } else if cards.is_empty() { stock::trip_cards(&crate::plan::bundle::load_bundle(&st.pool, &user.id).await?) } else { cards.clone() };
    let target = |c: &(String, String, Option<(stock::Kind, String)>, Option<String>, String)| {
        matches!(c.2, Some((stock::Kind::Pro, _))) || (refresh_catalog && matches!(c.2, Some((stock::Kind::Shopify, _)))) || (!cards_now.is_empty() && (c.2.is_some() || (yestcg && c.3.is_some())))
    };
    let any = checkable.iter().any(|c| if named.is_empty() { c.4 != "never" && target(c) } else { named.iter().any(|(k, _)| *k == c.0) && target(c) });
    if !any {
        return Err(AppError::bad("Nothing to read: there are no cards to look for (the trip has none and none were named), and none of those stores has a whole catalog Yama can read. Nothing was staged."));
    }
    let which = if named.is_empty() { "every store they'll go to that Yama can read".to_string() } else { named.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", ") };
    let what = if cards.is_empty() { "every card the trip plans for".to_string() } else if cards.len() == 1 { cards[0].clone() } else { format!("{} cards", cards.len()) };
    let summary = format!("Check stock: {which}");
    let detail = format!(
        "Reads {which} for {what}{} when applied, in the background, as dated snapshots. The trip then uses the newest answer for each card. At most {} store reads a day.",
        if yestcg { ", also through YesTCG's search" } else { "" },
        stock::DAILY_SNAPSHOTS
    );
    let detail = if refresh_catalog { format!("{detail} Rebuilds complete public Shopify catalogs; other stores use their normal stock checks. No cart or purchase changes.") } else { detail };
    let payload = json!({"stores": (!stores.is_empty()).then(|| stores.iter().map(|(k, _)| k.clone()).collect::<Vec<_>>()), "cards": (refresh_catalog || !cards.is_empty()).then_some(&cards), "yestcg": yestcg, "refresh_catalog":refresh_catalog});
    stage(st, user, via, args, Staged { kind: "check_stores", summary, detail, payload }).await
}

async fn apply_check_stores(st: &AppState, user: &User, change: &str, p: &Value) -> AppResult<Value> {
    let body = crate::plan::stock::CheckBody {
        stores: p["stores"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        cards: p["cards"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()),
        yestcg: p["yestcg"] == true,
        refresh_catalog: p["refresh_catalog"] == true,
    };
    // The snapshots carry the change's id, so applying it again (after a crash between the two
    // writes) reads nothing.
    let started = crate::plan::stock::start(st, &user.id, &body, "assistant", Some(change)).await?;
    let n = started["snapshots"].as_array().map_or(0, Vec::len);
    if n == 0 {
        return Err(AppError::Conflict("None of those stores can be read now.".into()));
    }
    Ok(json!({"label": format!("Reading {n} {} now; the Trip page shows each when it's done.", if n == 1 { "store" } else { "stores" }), "snapshots": started["snapshots"]}))
}

/// `add_wish`: a card or sealed product on their shopping list (`plan/wants.rs`), when they apply it.
pub async fn add_wish(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let mut w = crate::plan::wants::NewWant {
        kind: arg::opt_string(args, "kind", 10)?,
        name: arg::text(args, "name")?.to_string(),
        qty: match args.get("qty").filter(|v| !v.is_null()) {
            None => None,
            Some(v) => Some(v.as_i64().ok_or_else(|| AppError::bad("qty must be a whole number from 1 to 99"))?),
        },
        priority: arg::opt_string(args, "priority", 10)?,
        deck_id: None,
        deck_name: None,
        why: arg::opt_string(args, "why", 500)?,
    };
    // A deck by name: one of their Yama decks when it matches, else a label (a deck not in Yama yet).
    if let Some(d) = arg::opt_string(args, "deck", 200)? {
        let by_id: Option<String> = sqlx::query_scalar("SELECT id FROM decks WHERE owner_id = ? AND archived = 0 AND id = ?").bind(&user.id).bind(&d).fetch_optional(&st.pool).await?;
        // Two decks with the name is refused (with their ids), so the wish never lands on the wrong one.
        let found = match by_id {
            Some(id) => Some(id),
            None => crate::decks::find_by_name(&st.pool, &user.id, &d).await.map_err(|e| match e {
                AppError::Conflict(m) => AppError::bad(format!("{m} Or give the deck's id. Nothing was staged.")),
                other => other,
            })?.map(|(id, _)| id),
        };
        match found {
            Some(id) => w.deck_id = Some(id),
            None => w.deck_name = Some(d),
        }
    }
    let (kind, name, qty, priority, _, deck_name, why) = crate::plan::wants::check(&st.pool, &user.id, &w).await?;
    let summary = format!("Add {}{name} to their shopping list", if qty > 1 { format!("{qty}× ") } else { String::new() });
    let mut parts = vec![if kind == "sealed" { "A sealed product".to_string() } else { "A card".to_string() }];
    parts.push(if priority == "need" { "to buy (it can decide which stores they visit)".into() } else { "only along the way, from a store already on the trip".into() });
    if let Some(d) = &deck_name {
        parts.push(format!("for {d}{}", if w.deck_id.is_none() { " (not a Yama deck; kept as a label)" } else { "" }));
    }
    if let Some(y) = &why {
        parts.push(format!("why: {y}"));
    }
    let payload = json!({"kind": kind, "name": name, "qty": qty, "priority": priority, "deck_id": w.deck_id, "deck_name": w.deck_name, "why": why});
    stage(st, user, via, args, Staged { kind: "add_wish", summary, detail: parts.join(", ") + ".", payload }).await
}

async fn apply_add_wish(st: &AppState, user: &User, change: &str, p: &Value) -> AppResult<Value> {
    let text = |k: &str| p[k].as_str().map(String::from);
    let w = crate::plan::wants::NewWant {
        kind: text("kind"),
        name: text("name").unwrap_or_default(),
        qty: p["qty"].as_i64(),
        priority: text("priority"),
        deck_id: text("deck_id"),
        deck_name: text("deck_name"),
        why: text("why"),
    };
    // The want takes the change's id, so applying it again (after a crash between the two writes)
    // adds nothing.
    let saved = crate::plan::wants::add(&st.pool, &user.id, &w, "assistant", Some(change)).await.map_err(|e| match e {
        AppError::NotFound(_) => AppError::Conflict("That deck is gone.".into()),
        other => other,
    })?;
    Ok(json!({"label": format!("Added {} to your shopping list.", saved["name"].as_str().unwrap_or_default()), "id": saved["id"]}))
}

// ── what the app does that had no tool (2026-11-11) ─────────────────────────

/// `update_deck`: a deck's name, its declared bracket, or both.
pub async fn update_deck(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let id = deck_id(pool, &user.id, arg::text(args, "deck")?).await?;
    let (name, bracket): (String, Option<i64>) = sqlx::query_as("SELECT name, bracket FROM decks WHERE id = ? AND owner_id = ?").bind(&id).bind(&user.id).fetch_one(pool).await?;
    let new_name = match arg::opt_text(args, "name", arg::TEXT)? {
        Some(wanted) => Some(crate::decks::deck_name(wanted)?).filter(|wanted| *wanted != name),
        None => None,
    };
    let new_bracket = match args.get("bracket") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(b) => Some(Some(b.as_i64().filter(|b| (1..=5).contains(b)).ok_or_else(|| AppError::bad("bracket is a whole number from 1 to 5, or null to clear it"))?)),
    }
    .filter(|wanted| *wanted != bracket);
    let mut parts = Vec::new();
    if let Some(wanted) = &new_name {
        parts.push(format!("Rename {name} to {wanted}"));
    }
    match new_bracket {
        Some(Some(b)) => parts.push(format!("{} Bracket {b}", if parts.is_empty() { format!("Declare {name}") } else { "declare it".into() })),
        Some(None) => parts.push(if parts.is_empty() { format!("Clear {name}'s declared bracket") } else { "clear its declared bracket".into() }),
        None => {}
    }
    if parts.is_empty() {
        return Err(AppError::bad(format!("Give a new name, a bracket (1 to 5, or null to clear it), or both. {name} already has what was sent. Nothing was staged.")));
    }
    let detail = match bracket {
        Some(b) if new_bracket.is_some() => format!("It is declared Bracket {b} now. The declared bracket is their own call; Yama's estimate from the list is separate."),
        None if new_bracket.is_some() => "No bracket is declared now. The declared bracket is their own call; Yama's estimate from the list is separate.".to_string(),
        _ => String::new(),
    };
    let payload = json!({"deck_id": id, "deck": name, "name": new_name, "set_bracket": new_bracket.is_some(), "bracket": new_bracket.flatten()});
    stage(st, user, via, args, Staged { kind: "update_deck", summary: parts.join(" and "), detail, payload }).await
}

async fn apply_update_deck(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let deck_id = p["deck_id"].as_str().unwrap_or_default();
    let deck = p["deck"].as_str().unwrap_or("the deck");
    st.limits.deck_writes.check_user(user)?;
    // The fields this change leaves alone are read inside the write, so it can't put back a name
    // or a bracket they changed in Yama meanwhile.
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let live: Option<(String, Option<i64>)> =
        sqlx::query_as("SELECT name, bracket FROM decks WHERE id = ? AND owner_id = ? AND archived = 0").bind(deck_id).bind(&user.id).fetch_optional(&mut *tx).await?;
    let Some((name, bracket)) = live else {
        return Err(AppError::Conflict(format!("{deck} isn't in your decks any more.")));
    };
    let name = match p["name"].as_str() {
        Some(wanted) => crate::decks::deck_name(wanted)?,
        None => name,
    };
    let bracket = if p["set_bracket"] == true { p["bracket"].as_i64().filter(|b| (1..=5).contains(b)) } else { bracket };
    sqlx::query("UPDATE decks SET name = ?, bracket = ?, updated_at = ? WHERE id = ? AND owner_id = ?").bind(&name).bind(bracket).bind(now()).bind(deck_id).bind(&user.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(json!({"label": format!("Updated {name}"), "link": format!("/decks/{deck_id}")}))
}

/// `remove_wish`: one want off their shopping list, by its name (or id).
pub async fn remove_wish(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let wanted = arg::text(args, "wish")?;
    let all = crate::plan::wants::list(&st.pool, &user.id).await?;
    let text = |want: &Value, key: &str| want[key].as_str().unwrap_or_default().to_string();
    let found: Vec<&Value> = match all.iter().find(|want| want["id"].as_str() == Some(wanted)) {
        Some(by_id) => vec![by_id],
        None => all.iter().filter(|want| want["name"].as_str().is_some_and(|name| name.eq_ignore_ascii_case(wanted))).collect(),
    };
    let label = |want: &Value| match want["deck_name"].as_str() {
        Some(deck) => format!("{} for {deck}", text(want, "name")),
        None => text(want, "name"),
    };
    let want = match found.as_slice() {
        [] => return Err(AppError::bad(format!("Nothing they added to their shopping list is called \"{wanted}\". `get_shopping_list` shows what they added. Nothing was staged."))),
        [one] => *one,
        many => {
            let which = many.iter().copied().map(|want| format!("{} (wish {})", label(want), text(want, "id"))).collect::<Vec<_>>().join("; ");
            return Err(AppError::bad(format!("{} wishes are called \"{wanted}\": {which}. Give the id of the one to remove. Nothing was staged.", many.len())));
        }
    };
    let qty = want["qty"].as_i64().unwrap_or(1);
    let summary = format!("Take {}{} off their shopping list", if qty > 1 { format!("{qty}× ") } else { String::new() }, label(want));
    let detail = "Only the wish goes. A card an approved plan buys stays on the list.".to_string();
    stage(st, user, via, args, Staged { kind: "remove_wish", summary, detail, payload: json!({"want_id": want["id"], "name": want["name"]}) }).await
}

async fn apply_remove_wish(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let name = p["name"].as_str().unwrap_or("That wish");
    crate::plan::wants::remove(&st.pool, &user.id, p["want_id"].as_str().unwrap_or_default()).await.map_err(|e| match e {
        AppError::NotFound(_) => AppError::Conflict(format!("{name} is already off your shopping list.")),
        other => other,
    })?;
    Ok(json!({"label": format!("Took {name} off your shopping list.")}))
}

/// What the app calls each kind of container.
const CONTAINER_KINDS: [(&str, &str); 4] = [("binder", "binder"), ("deck", "deck box"), ("box", "box"), ("list", "list")];

/// `create_container`: a new binder, deck box, box or list.
pub async fn create_container(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let name = crate::collection::container_name(arg::text(args, "name")?)?;
    let kind = arg::text(args, "kind")?.to_lowercase();
    let Some(&(kind, said)) = CONTAINER_KINDS.iter().find(|(k, _)| *k == kind) else {
        return Err(AppError::bad("kind is binder, deck, box or list"));
    };
    let there: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE owner_id = ? AND kind = ? AND name = ?").bind(&user.id).bind(kind).bind(&name).fetch_optional(&st.pool).await?;
    if there.is_some() {
        return Err(AppError::bad(format!("They already have a {said} called {name}. Nothing was staged.")));
    }
    let summary = format!("Make a {said} called {name}");
    stage(st, user, via, args, Staged { kind: "create_container", summary, detail: "It starts empty.".into(), payload: json!({"kind": kind, "said": said, "name": name}) }).await
}

async fn apply_create_container(st: &AppState, user: &User, p: &Value) -> AppResult<Value> {
    let name = crate::collection::container_name(p["name"].as_str().unwrap_or_default())?;
    let kind = p["kind"].as_str().filter(|k| crate::collection::KINDS.contains(k)).ok_or_else(|| AppError::bad("kind is binder, deck, box or list"))?;
    st.limits.collection_writes.check_user(user)?;
    crate::collection::insert_container(&st.pool, &user.id, kind, &name).await?;
    Ok(json!({"label": format!("Made the {} {name}", p["said"].as_str().unwrap_or(kind)), "link": "/collection"}))
}

/// `remove_from_collection`: copies of a card leave one of their binders, boxes or lists for
/// good. The change names the exact rows and how many go from each: when the copies there are
/// not all alike (another printing, finish, condition, a proxy), the call has to say which.
pub async fn remove_from_collection(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let wanted = arg::text(args, "card")?.to_string();
    let known = known_cards(pool, std::slice::from_ref(&wanted)).await?;
    let (oracle_id, name) = known[&wanted].clone();
    let qty = arg::int(args, "qty", 1, 1, 100)?;
    let from = container(pool, &user.id, arg::text(args, "from")?).await?;
    let (set, number) = (arg::opt_string(args, "set", 10)?, arg::opt_string(args, "number", 20)?);
    let finish = match arg::opt_text(args, "finish", 20)? {
        Some(f) if !FINISHES.iter().any(|(k, _)| *k == f) => return Err(AppError::bad("finish is nonfoil, foil or etched")),
        f => f,
    };
    let proxy = match args.get("proxy") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(AppError::bad("proxy must be true or false")),
    };
    let rows = copies_in(&mut *pool.acquire().await?, &user.id, &oracle_id, &from.0).await?;
    if rows.is_empty() {
        return Err(AppError::bad(format!("{} holds no {name}. Nothing was staged.", from.1)));
    }
    let there = rows.iter().map(|r| format!("{} × {}", r.qty, r.kind())).collect::<Vec<_>>().join("; ");
    let same = |have: &Option<String>, want: &Option<String>| want.as_deref().is_none_or(|w| have.as_deref().is_some_and(|h| h.eq_ignore_ascii_case(w)));
    let meant: Vec<&CopyRow> =
        rows.iter().filter(|r| same(&r.set_code, &set) && same(&r.collector_number, &number) && finish.is_none_or(|f| f == r.finish) && proxy.is_none_or(|p| p == r.proxy)).collect();
    let able: i64 = meant.iter().map(|r| r.qty).sum();
    if able < qty {
        return Err(AppError::bad(format!("{} holds {able} {name} like that, not {qty}. It holds: {there}. Nothing was staged.", from.1)));
    }
    if meant.len() > 1 && qty < able {
        return Err(AppError::bad(format!(
            "{}'s {name} are not all alike: {there}. Say which {} with set and number, finish or proxy. Nothing was staged.",
            from.1,
            if qty == 1 { "one goes" } else { "ones go" }
        )));
    }
    // One kind of copy, or every copy meant: the rows and how many leave each are pinned here.
    let mut left = qty;
    let mut going = Vec::new();
    let mut said = Vec::new();
    for r in meant {
        let take = left.min(r.qty);
        if take == 0 {
            break;
        }
        left -= take;
        going.push(json!({"id": r.id, "qty": take}));
        said.push(format!("{take} × {}", r.kind()));
    }
    let summary = format!("Remove {qty} {name} from {}", from.1);
    let detail = format!(
        "Leaving their collection for good (sold, traded, lost or entered by mistake): {}. {} of the {} {name} there stay. To put copies somewhere else, move them instead.",
        said.join("; "),
        rows.iter().map(|r| r.qty).sum::<i64>() - qty,
        rows.iter().map(|r| r.qty).sum::<i64>(),
    );
    let payload = json!({"name": name, "qty": qty, "from_id": from.0, "from": from.1, "rows": going});
    stage(st, user, via, args, Staged { kind: "remove_from_collection", summary, detail, payload }).await
}

/// Takes the pinned copies out of the pinned rows. A row that has gone, moved or holds fewer
/// than was pinned means the collection changed since: nothing is removed.
async fn apply_remove_copies(st: &AppState, user: &User, id: &str, p: &Value) -> AppResult<Value> {
    use crate::collection::{Op, OpKind, apply_op};
    let (name, place) = (p["name"].as_str().unwrap_or("copies"), p["from"].as_str().unwrap_or("That place"));
    let label = format!("Removed {name} from {place}");
    st.limits.collection_writes.check_user(user)?;
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    if !first_apply(&mut tx, &user.id, id, "remove_from_collection").await? {
        return Ok(json!({"label": label, "link": "/collection"}));
    }
    for (n, row) in p["rows"].as_array().into_iter().flatten().enumerate() {
        let (item, take) = (row["id"].as_str().unwrap_or_default(), row["qty"].as_i64().unwrap_or(0));
        let held: Option<i64> = sqlx::query_scalar("SELECT qty FROM collection_items WHERE id = ? AND owner_id = ? AND container_id = ?")
            .bind(item)
            .bind(&user.id)
            .bind(p["from_id"].as_str().unwrap_or_default())
            .fetch_optional(&mut *tx)
            .await?;
        if take <= 0 || held.is_none_or(|held| held < take) {
            return Err(AppError::Conflict(format!("{place}'s {name} changed after this was suggested, so nothing was removed. Discard it and ask again.")));
        }
        let op = Op { op_id: format!("{DEVICE}-{id}-{n}"), device_id: Some(DEVICE.into()), op: OpKind::Adjust { item_id: item.into(), delta: -take } };
        apply_op(&mut tx, &user.id, &op).await?;
    }
    tx.commit().await?;
    Ok(json!({"label": label, "link": "/collection"}))
}

/// The words for a finish, as the collection page says them.
const FINISHES: [(&str, &str); 3] = [("nonfoil", "nonfoil"), ("foil", "foil"), ("etched", "etched foil")];

/// Whether a finish or proxy edit would change this row.
fn edit_changes(row: &CopyRow, finish: Option<&str>, proxy: Option<bool>) -> bool {
    finish.is_some_and(|f| f != row.finish) || proxy.is_some_and(|p| p != row.proxy)
}

/// `edit_copies`: the finish or proxy mark of some or all copies of a card in one place, or a
/// note or price paid for all of them. The collection keeps one note and one price for a row of
/// identical copies, so those two can't be set on only some.
pub async fn edit_copies(st: &AppState, user: &User, via: &Via, args: &Value) -> AppResult<String> {
    let pool = &st.pool;
    let wanted = arg::text(args, "card")?.to_string();
    let known = known_cards(pool, std::slice::from_ref(&wanted)).await?;
    let (oracle_id, name) = known[&wanted].clone();
    let place = container(pool, &user.id, arg::text(args, "container")?).await?;
    let mut parts = Vec::new();
    let finish = match arg::opt_text(args, "finish", 20)? {
        None => None,
        Some(f) => {
            let &(finish, said) = FINISHES.iter().find(|(k, _)| *k == f).ok_or_else(|| AppError::bad("finish is nonfoil, foil or etched"))?;
            parts.push(said.to_string());
            Some(finish)
        }
    };
    let proxy = match args.get("proxy") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(b)) => {
            parts.push(if *b { "a proxy".into() } else { "a real card, not a proxy".into() });
            Some(*b)
        }
        Some(_) => return Err(AppError::bad("proxy must be true or false")),
    };
    let note = match args.get("note") {
        None => None,
        Some(Value::Null) => {
            parts.push("no note".into());
            Some(None)
        }
        Some(_) => match arg::opt_string(args, "note", 500)? {
            Some(text) => {
                parts.push(format!("note \"{text}\""));
                Some(Some(text))
            }
            None => {
                parts.push("no note".into());
                Some(None)
            }
        },
    };
    let price = arg::opt_number(args, "price_paid")?;
    match price {
        Some(Some(usd)) if !(0.0..=1_000_000.0).contains(&usd) => return Err(AppError::bad("price_paid is an amount from 0 to 1,000,000, or null to clear it")),
        Some(Some(usd)) => parts.push(format!("paid {usd:.2} each")),
        Some(None) => parts.push("no price paid".into()),
        None => {}
    }
    if parts.is_empty() {
        return Err(AppError::bad("Give what to change: finish, proxy, note or price_paid. For condition use set_condition; to move copies use move_cards. Nothing was staged."));
    }
    let rows = copies_in(&mut *pool.acquire().await?, &user.id, &oracle_id, &place.0).await?;
    let have: i64 = rows.iter().map(|r| r.qty).sum();
    if have == 0 {
        return Err(AppError::bad(format!("{} holds no {name}. Nothing was staged.", place.1)));
    }
    // A note or a price is for every copy there; a finish or proxy edit takes copies it changes.
    let whole = note.is_some() || price.is_some();
    let able: i64 = if whole { have } else { rows.iter().filter(|r| edit_changes(r, finish, proxy)).map(|r| r.qty).sum() };
    if able == 0 {
        return Err(AppError::bad(format!("Every {name} in {} is already {}. Nothing was staged.", place.1, parts.join(", "))));
    }
    let qty = match args.get("qty").filter(|q| !q.is_null()) {
        None => able,
        Some(_) => arg::int(args, "qty", able, 1, 100)?,
    };
    if whole && qty != have {
        return Err(AppError::bad(format!(
            "A note and the price paid are kept for a card's identical copies together, so they can't be set on only some of them. Leave qty out to set them on all {have} {name} in {}, or change only finish or proxy on some. Nothing was staged.",
            place.1
        )));
    }
    if qty > able {
        return Err(AppError::bad(format!("{} holds {able} {name} that this would change, not {qty}. Nothing was staged.", place.1)));
    }
    let summary = format!("Mark {qty} {name} in {}: {}", place.1, parts.join(", "));
    let detail = if qty < have { format!("{} holds {have}; the other {} stay as they are.", place.1, have - qty) } else { String::new() };
    let payload = json!({
        "oracle_id": oracle_id, "name": name, "qty": qty, "container_id": place.0, "container": place.1,
        "finish": finish, "proxy": proxy, "set_note": note.is_some(), "note": note.flatten(), "set_price": price.is_some(), "price_paid": price.flatten(),
    });
    stage(st, user, via, args, Staged { kind: "edit_copies", summary, detail, payload }).await
}

/// Marks a change as applied to the collection, inside the transaction that applies it. False
/// when an earlier attempt already did: the change's own status is written after that commit,
/// so after a crash between the two it is applied again, and the rows a second attempt would
/// find are no longer the ones the first one changed.
async fn first_apply(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, owner: &str, change: &str, kind: &str) -> AppResult<bool> {
    let marked = sqlx::query("INSERT INTO applied_ops (op_id, owner_id, device_id, kind, payload, applied_at) VALUES (?, ?, ?, ?, '{}', ?) ON CONFLICT(owner_id, op_id) DO NOTHING")
        .bind(format!("{DEVICE}-{change}"))
        .bind(owner)
        .bind(DEVICE)
        .bind(kind)
        .bind(now())
        .execute(&mut **tx)
        .await?;
    Ok(marked.rows_affected() == 1)
}

/// Applies `edit_copies` to the rows as they are now, through the collection ops the app sends.
async fn apply_edit_copies(st: &AppState, user: &User, id: &str, p: &Value) -> AppResult<Value> {
    use crate::collection::{Op, OpKind, apply_op};
    let op = |n: usize, op: OpKind| Op { op_id: format!("{DEVICE}-{id}-{n}"), device_id: Some(DEVICE.into()), op };
    let (name, place) = (p["name"].as_str().unwrap_or("copies"), p["container"].as_str().unwrap_or("That place"));
    let label = format!("Done: {name} in {place} updated");
    let (finish, proxy) = (p["finish"].as_str(), p["proxy"].as_bool());
    let whole = p["set_note"] == true || p["set_price"] == true;
    let mut left = p["qty"].as_i64().unwrap_or(1);
    st.limits.collection_writes.check_user(user)?;
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    if !first_apply(&mut tx, &user.id, id, "edit_copies").await? {
        return Ok(json!({"label": label, "link": "/collection"}));
    }
    let mut rows = copies_in(&mut tx, &user.id, p["oracle_id"].as_str().unwrap_or_default(), p["container_id"].as_str().unwrap_or_default()).await?;
    if !whole {
        rows.retain(|r| edit_changes(r, finish, proxy));
    }
    let there: i64 = rows.iter().map(|r| r.qty).sum();
    if there < left || (whole && there != left) {
        return Err(AppError::Conflict(format!("{place}'s {name} changed after this was suggested ({there} to change now, not {left}), so it wasn't applied. Discard it and ask again.")));
    }
    for (n, r) in rows.into_iter().enumerate() {
        if left == 0 {
            break;
        }
        let take = left.min(r.qty);
        left -= take;
        let change = OpKind::Update {
            item_id: r.id,
            condition: None,
            finish: finish.map(String::from),
            lang: None,
            container_id: None,
            purchase_price: (p["set_price"] == true).then(|| p["price_paid"].as_f64()),
            note: (p["set_note"] == true).then(|| p["note"].as_str().map(String::from)),
            proxy,
            scryfall_id: None,
            // Fewer than the row holds: those copies split off into a row of their own.
            split: (take < r.qty).then_some(take),
        };
        apply_op(&mut tx, &user.id, &op(n, change)).await?;
    }
    tx.commit().await?;
    Ok(json!({"label": label, "link": "/collection"}))
}

/// One apply or discard at a time for each account, so the same change can't be applied twice
/// at once (a double click, the page and `apply_change` together). Accounts don't wait on each
/// other: before 2026-11-11 one lock covered everyone, so a slow apply (a lab run, a store read)
/// held up every other account's.
async fn owner_lock(owner: &str) -> tokio::sync::OwnedMutexGuard<()> {
    type Locks = std::sync::Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>;
    static LOCKS: std::sync::OnceLock<Locks> = std::sync::OnceLock::new();
    let lock = {
        let mut locks = LOCKS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        // Forget the accounts nobody is applying for, so the map stays small.
        if locks.len() >= 256 {
            locks.retain(|_, l| std::sync::Arc::strong_count(l) > 1);
        }
        locks.entry(owner.to_string()).or_default().clone()
    };
    lock.lock_owned().await
}

/// Apply a pending change. A failure is kept on the change (it stays pending) and returned, so the
/// page shows the reason; a server fault is logged and shown in general terms.
pub async fn apply(st: &AppState, user: &User, id: &str) -> AppResult<ChangeView> {
    let _one = owner_lock(&user.id).await;
    let row = load(&st.pool, &user.id, id).await?;
    if row.status != "pending" {
        return Err(AppError::Conflict(format!("This change was already {}.", row.status)));
    }
    let p: Value = serde_json::from_str(&row.payload).map_err(anyhow::Error::from)?;
    let done = match super::registry::applier(&row.kind) {
        Some(apply) => apply(st, user, Pending { id: &row.id, summary: &row.summary }, &p).await,
        None => Err(AppError::Other(anyhow::anyhow!("unknown change kind {}", row.kind))),
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
    let _one = owner_lock(owner).await;
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

// ── what each staging tool stores, and how it is applied ────────────────────

/// One `Staging` per staging tool, for its entry in the tool table (`tools::TOOLS`): the kind
/// stored in `assistant_changes` and the function that applies it. Applying looks the kind up
/// there (`registry::applier`), so a tool can't stage a kind nothing applies.
pub(super) mod staging {
    use super::*;

    /// `edit_deck` and `save_deck` both store an `edit_deck` change; a complete list says so.
    pub const EDIT_DECK: Staging = Staging {
        kind: "edit_deck",
        apply: |st, user, change, p| {
            Box::pin(async move { if p["complete_list"] == true { apply_complete_deck(st, user, change.id, p).await } else { apply_edit_deck(st, user, change.summary, p).await } })
        },
    };
    pub const DELETE_DECK: Staging = Staging { kind: "delete_deck", apply: |st, user, _, p| Box::pin(apply_delete_deck(st, user, p)) };
    pub const PROPOSE_SWAP: Staging = Staging { kind: "propose_swap", apply: |st, user, change, p| Box::pin(apply_plan(st, user, "propose_swap", change.id, p)) };
    pub const ANSWER_REVIEW: Staging = Staging { kind: "answer_review", apply: |st, user, change, p| Box::pin(apply_plan(st, user, "answer_review", change.id, p)) };
    pub const MARK_BOUGHT: Staging = Staging { kind: "mark_bought", apply: |st, user, change, p| Box::pin(apply_plan(st, user, "mark_bought", change.id, p)) };
    pub const MARK_INSTALLED: Staging = Staging { kind: "mark_installed", apply: |st, user, change, p| Box::pin(apply_plan(st, user, "mark_installed", change.id, p)) };
    pub const TRACK_BUILD: Staging = Staging { kind: "track_build", apply: |st, user, change, p| Box::pin(apply_track_build(st, user, change.id, p)) };
    pub const APPROVE_PLAN: Staging = Staging { kind: "approve_plan", apply: |st, user, change, p| Box::pin(apply_approve_plan(st, user, change.id, p)) };
    pub const SWAP_IN_PRINTS: Staging = Staging { kind: "swap_in_prints", apply: |st, user, _, p| Box::pin(apply_swap_in(st, user, p)) };
    pub const START_LAB_RUN: Staging = Staging { kind: "start_lab_run", apply: |st, user, change, p| Box::pin(apply_lab_run(st, user, change.id, p)) };
    pub const MORE_LAB_GAMES: Staging = Staging { kind: "more_lab_games", apply: |st, user, _, p| Box::pin(apply_more_games(st, user, p)) };
    pub const RUN_LAB_AGAIN: Staging = Staging { kind: "run_lab_again", apply: |st, user, change, p| Box::pin(apply_again(st, user, change.id, p)) };
    pub const CANCEL_LAB_RUN: Staging = Staging { kind: "cancel_lab_run", apply: |st, user, _, p| Box::pin(apply_cancel(st, user, p)) };
    pub const ADD_TO_COLLECTION: Staging = Staging { kind: "add_to_collection", apply: |st, user, change, p| Box::pin(apply_collection(st, user, "add_to_collection", change.id, p)) };
    pub const MOVE_CARDS: Staging = Staging { kind: "move_cards", apply: |st, user, change, p| Box::pin(apply_collection(st, user, "move_cards", change.id, p)) };
    pub const SET_CONDITION: Staging = Staging { kind: "set_condition", apply: |st, user, change, p| Box::pin(apply_collection(st, user, "set_condition", change.id, p)) };
    pub const SET_SHOPPING_RULES: Staging = Staging { kind: "set_shopping_rules", apply: |st, user, _, p| Box::pin(apply_shopping_rules(st, user, p)) };
    pub const SET_STORE_PREFERENCE: Staging = Staging { kind: "set_store_preference", apply: |st, user, _, p| Box::pin(apply_store_preference(st, user, p)) };
    pub const CHECK_STORES: Staging = Staging { kind: "check_stores", apply: |st, user, change, p| Box::pin(apply_check_stores(st, user, change.id, p)) };
    pub const ADD_WISH: Staging = Staging { kind: "add_wish", apply: |st, user, change, p| Box::pin(apply_add_wish(st, user, change.id, p)) };
    pub const UPDATE_DECK: Staging = Staging { kind: "update_deck", apply: |st, user, _, p| Box::pin(apply_update_deck(st, user, p)) };
    pub const REMOVE_WISH: Staging = Staging { kind: "remove_wish", apply: |st, user, _, p| Box::pin(apply_remove_wish(st, user, p)) };
    pub const CREATE_CONTAINER: Staging = Staging { kind: "create_container", apply: |st, user, _, p| Box::pin(apply_create_container(st, user, p)) };
    pub const REMOVE_FROM_COLLECTION: Staging = Staging { kind: "remove_from_collection", apply: |st, user, change, p| Box::pin(apply_remove_copies(st, user, change.id, p)) };
    pub const EDIT_COPIES: Staging = Staging { kind: "edit_copies", apply: |st, user, change, p| Box::pin(apply_edit_copies(st, user, change.id, p)) };
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

    #[tokio::test]
    async fn applying_waits_only_for_the_same_account() {
        use std::time::Duration;
        let held = owner_lock("account-a").await;
        // Another account goes straight through; the same account waits its turn.
        tokio::time::timeout(Duration::from_secs(5), owner_lock("account-b")).await.expect("another account isn't held up");
        assert!(tokio::time::timeout(Duration::from_millis(50), owner_lock("account-a")).await.is_err(), "the same account waits");
        drop(held);
        tokio::time::timeout(Duration::from_secs(5), owner_lock("account-a")).await.expect("and gets it when the first is done");
    }

    #[test]
    fn op_ids_are_plain_tokens() {
        assert_eq!(op_id(&json!({})).unwrap(), None);
        assert_eq!(op_id(&json!({"op_id": null})).unwrap(), None);
        assert_eq!(op_id(&json!({"op_id": "0f8fad5b-d9cb-469f-a165-70867728950e"})).unwrap(), Some("0f8fad5b-d9cb-469f-a165-70867728950e"));
        for bad in [json!("short"), json!("has a space in it"), json!(12345678), json!("x".repeat(65))] {
            assert!(op_id(&json!({"op_id": bad})).is_err(), "{bad}");
        }
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
