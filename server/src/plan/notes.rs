//! Plans made from a note's build (2026-11-04). Bryan: "I would expect plans to be part of the
//! MCP", and notes and plans "are hard to use today". People see one thing, a plan: a saved note
//! (yama-research/1) holds the research, and tracking one of a deck's builds makes it that deck's
//! plan, with Buy, Trip, prints, installed and bought marks and the MCP plan tools.
//!
//! Storage is the planner's own: a Yama-made plan deck (`source = 'yama'`) linked to the note deck
//! (`note_id`, `note_deck_key`, `note_build_id`; one plan deck per note deck). Its swaps, store
//! quotes and lists are derived from the build here and derived again whenever the note is saved,
//! so the note stays the one place the plan's content is written. Switching builds keeps the row and
//! retires the old build's swaps (their marks and answers stay, and come back if that build is
//! chosen again); stopping archives it. Every query binds the owner; anyone else's note is a 404.
//!
//! Swap keys are `n|<note>|<deck>|<build>|<swap id>`, stable across note revisions. A swap's
//! source comes from the note's acquisition evidence: owned (kept, transferred, an arrived print,
//! a basic) is `owned`; a buy is `buy`, with the note's dated store offer as a quote; a print is
//! `print`; projected sealed stock and anything the note doesn't account for are `buy` with a note
//! saying so. Stock is the build's list with every swap undone; now applies the owned swaps; after
//! is the build's list.

use super::model::{self, Slot};
use crate::auth::CurrentUser;
use crate::decks::{Board, parse_list};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::extract::{Path, State};
use axum::routing::{delete, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{HashMap, HashSet};

/// What the derived lists say computed them.
pub const COMPUTED_BY: &str = "Yama, from the note's build";
/// The `applied_ops.kind` a tracking request is remembered under, for retries.
const OP_KIND: &str = "plan.from_note";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/plan/from-note", post(track_route)).route("/api/plan/from-note/{key}", delete(stop_route))
}

/// Track (or switch to) one build of one deck in one of the caller's notes.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TrackRequest {
    pub note_id: String,
    pub deck_key: String,
    pub build_id: String,
    /// The Yama deck the plan is for. Missing: the one already linked, else the caller's only live
    /// main deck with the note deck's name, else none (link it later).
    #[serde(default)]
    pub deck_id: Option<String>,
    /// A client-made id: a retry with it returns the first answer instead of tracking twice.
    #[serde(default)]
    pub op_id: Option<String>,
    /// The note's content hash when the person saw it (`content_hash` from the research APIs). When
    /// set and the note has changed since, nothing is tracked (409): what they approved isn't what
    /// would be applied. Claude's staged `track_build` always sets it.
    #[serde(default)]
    pub expected_note_hash: Option<String>,
}

impl TrackRequest {
    fn deck_id(&self) -> Option<&str> {
        self.deck_id.as_deref().map(str::trim).filter(|d| !d.is_empty())
    }

    /// What a retry must repeat exactly to get the first answer back.
    fn identity(&self) -> Value {
        json!({"note_id": self.note_id, "deck_key": self.deck_key, "build_id": self.build_id, "deck_id": self.deck_id()})
    }
}

/// What tracking made: the plan deck and what it holds.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Tracked {
    pub plan_deck_key: String,
    pub name: String,
    pub note_id: String,
    pub deck_key: String,
    pub build_id: String,
    pub build_label: String,
    pub deck_id: Option<String>,
    pub swaps: usize,
    pub warnings: Vec<String>,
    pub link: String,
}

async fn track_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(req): Json<TrackRequest>) -> AppResult<Json<Tracked>> {
    st.limits.deck_writes.check_user(&user)?;
    Ok(Json(track(&st.pool, &user.id, &req).await?))
}

async fn stop_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(key): Path<String>) -> AppResult<Json<Value>> {
    Ok(Json(stop(&st.pool, &user.id, &key).await?))
}

/// Make `req`'s build the plan for its note deck: a new plan deck, or the existing one switched to
/// this build (and made active again if it was stopped). Idempotent by `op_id`.
pub async fn track(pool: &SqlitePool, owner: &str, req: &TrackRequest) -> AppResult<Tracked> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let conn: &mut SqliteConnection = &mut tx;
    if let Some(op) = req.op_id.as_deref().filter(|o| !o.trim().is_empty()) {
        let done: Option<String> =
            sqlx::query_scalar("SELECT payload FROM applied_ops WHERE owner_id = ? AND op_id = ?").bind(owner).bind(op).fetch_optional(&mut *conn).await?;
        if let Some(payload) = done {
            let p: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
            if p["request"] != req.identity() {
                return Err(AppError::Conflict("That op_id was already used for a different request.".into()));
            }
            return serde_json::from_value(p["result"].clone()).map_err(|e| AppError::Other(e.into()));
        }
    }
    let (doc, hash) = note_document(&mut *conn, owner, &req.note_id).await?;
    if let Some(expected) = req.expected_note_hash.as_deref().filter(|h| !h.is_empty())
        && expected != hash
    {
        return Err(AppError::Conflict("The note has changed since this was reviewed, so its build may differ. Look at it again (ask Claude to stage it again) before tracking it.".into()));
    }
    let deck = find_deck(&doc, &req.deck_key).ok_or(AppError::NotFound("note deck"))?;
    let build = find_build(deck, &req.build_id).ok_or(AppError::NotFound("note build"))?;
    let stamp = now();
    let existing: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT id, key, deck_id FROM plan_decks WHERE owner_id = ? AND note_id = ? AND note_deck_key = ?")
            .bind(owner)
            .bind(&req.note_id)
            .bind(&req.deck_key)
            .fetch_optional(&mut *conn)
            .await?;
    let deck_id = match req.deck_id() {
        Some(id) => {
            let mine: Option<String> = sqlx::query_scalar("SELECT id FROM decks WHERE id = ? AND owner_id = ? AND archived = 0")
                .bind(id)
                .bind(owner)
                .fetch_optional(&mut *conn)
                .await?;
            Some(mine.ok_or(AppError::NotFound("deck"))?)
        }
        None => match existing.as_ref().and_then(|e| e.2.clone()) {
            Some(linked) => Some(linked),
            None => deck_by_name(&mut *conn, owner, text(deck, "name").unwrap_or_default().as_str()).await?,
        },
    };
    let name = text(deck, "name").unwrap_or_else(|| req.deck_key.clone());
    let commander = json_text(&commanders(deck, build));
    let (plan_id, key) = match existing {
        Some((id, key, _)) => {
            sqlx::query(
                "UPDATE plan_decks SET name = ?, status = 'active', commander = ?, deck_id = ?, note_build_id = ?, updated_at = ?
                 WHERE id = ? AND owner_id = ?",
            )
            .bind(&name)
            .bind(&commander)
            .bind(&deck_id)
            .bind(&req.build_id)
            .bind(&stamp)
            .bind(&id)
            .bind(owner)
            .execute(&mut *conn)
            .await?;
            (id, key)
        }
        None => {
            let key = free_key(&mut *conn, owner, &req.deck_key, &[]).await?;
            let id = new_id();
            let sort: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sort), 0) + 1 FROM plan_decks WHERE owner_id = ?").bind(owner).fetch_one(&mut *conn).await?;
            sqlx::query(
                "INSERT INTO plan_decks (id, owner_id, key, name, source, status, commander, deck_id, sort, note_id, note_deck_key,
                   note_build_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?, 'yama', 'active', ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(owner)
            .bind(&key)
            .bind(&name)
            .bind(&commander)
            .bind(&deck_id)
            .bind(sort)
            .bind(&req.note_id)
            .bind(&req.deck_key)
            .bind(&req.build_id)
            .bind(&stamp)
            .bind(&stamp)
            .execute(&mut *conn)
            .await?;
            (id, key)
        }
    };
    let title = text(&doc, "title").unwrap_or_else(|| req.note_id.clone());
    let derived = derive(&mut *conn, owner, &plan_id, &req.note_id, &title, &req.deck_key, build, &stamp).await?;
    bump(&mut *conn, owner, &stamp).await?;
    let result = Tracked {
        link: format!("/decks/plan/d/{key}"),
        plan_deck_key: key,
        name,
        note_id: req.note_id.clone(),
        deck_key: req.deck_key.clone(),
        build_id: req.build_id.clone(),
        build_label: text(build, "label").unwrap_or_else(|| req.build_id.clone()),
        deck_id,
        swaps: derived.swaps,
        warnings: derived.warnings,
    };
    if let Some(op) = req.op_id.as_deref().filter(|o| !o.trim().is_empty()) {
        let payload = json!({"request": req.identity(), "result": result});
        sqlx::query("INSERT INTO applied_ops (owner_id, op_id, device_id, kind, payload, applied_at) VALUES (?, ?, NULL, ?, ?, ?)")
            .bind(owner)
            .bind(op)
            .bind(OP_KIND)
            .bind(payload.to_string())
            .bind(&stamp)
            .execute(&mut *conn)
            .await?;
    }
    tx.commit().await?;
    Ok(result)
}

/// Stop tracking: the plan deck is archived, keeping its swaps, marks and answers for a later
/// return. Stopping a stopped plan changes nothing. Only plans made from a note can be stopped here.
pub async fn stop(pool: &SqlitePool, owner: &str, key: &str) -> AppResult<Value> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row: Option<(String, Option<String>, String)> = sqlx::query_as("SELECT id, note_id, status FROM plan_decks WHERE owner_id = ? AND key = ?")
        .bind(owner)
        .bind(key)
        .fetch_optional(&mut *tx)
        .await?;
    let (id, note, status) = row.ok_or(AppError::NotFound("plan deck"))?;
    if note.is_none() {
        return Err(AppError::Conflict("That plan wasn't made from a note, so it isn't stopped here.".into()));
    }
    if status != "archived" {
        let stamp = now();
        sqlx::query("UPDATE plan_decks SET status = 'archived', updated_at = ? WHERE id = ? AND owner_id = ?")
            .bind(&stamp)
            .bind(&id)
            .bind(owner)
            .execute(&mut *tx)
            .await?;
        bump(&mut tx, owner, &stamp).await?;
    }
    tx.commit().await?;
    Ok(json!({"plan_deck_key": key, "status": "archived"}))
}

/// After a note is saved: derive every plan tracking one of its builds again. A tracked deck or
/// build the note no longer has stops being tracked (archived, its swaps retired) rather than
/// keeping a plan the note doesn't describe. Returns how many plan decks changed.
pub async fn rederive(conn: &mut SqliteConnection, owner: &str, note_id: &str, doc: &Value) -> AppResult<usize> {
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, note_deck_key, note_build_id FROM plan_decks WHERE owner_id = ? AND note_id = ? AND status != 'archived'",
    )
    .bind(owner)
    .bind(note_id)
    .fetch_all(&mut *conn)
    .await?;
    if rows.is_empty() {
        return Ok(0);
    }
    let stamp = now();
    let title = text(doc, "title").unwrap_or_else(|| note_id.to_string());
    for (id, deck_key, build_id) in &rows {
        match find_deck(doc, deck_key).and_then(|d| Some((d, find_build(d, build_id)?))) {
            Some((deck, build)) => {
                sqlx::query("UPDATE plan_decks SET name = ?, commander = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
                    .bind(text(deck, "name").unwrap_or_else(|| deck_key.clone()))
                    .bind(json_text(&commanders(deck, build)))
                    .bind(&stamp)
                    .bind(id)
                    .bind(owner)
                    .execute(&mut *conn)
                    .await?;
                derive(&mut *conn, owner, id, note_id, &title, deck_key, build, &stamp).await?;
            }
            None => {
                sqlx::query("UPDATE plan_decks SET status = 'archived', updated_at = ? WHERE id = ? AND owner_id = ?")
                    .bind(&stamp)
                    .bind(id)
                    .bind(owner)
                    .execute(&mut *conn)
                    .await?;
                sqlx::query("UPDATE plan_swaps SET retired_at = ?, updated_at = ? WHERE owner_id = ? AND plan_deck_id = ? AND retired_at IS NULL")
                    .bind(&stamp)
                    .bind(&stamp)
                    .bind(owner)
                    .bind(id)
                    .execute(&mut *conn)
                    .await?;
            }
        }
    }
    bump(&mut *conn, owner, &stamp).await?;
    Ok(rows.len())
}

/// Before an import writes `keys`: a plan made from a note that holds one of them moves to a free
/// key (`<key>-note`), so publishing a plan file never collides with a tracked note. Its swaps are
/// keyed by the note, not the deck key, so marks and answers stay with it.
pub async fn make_room(conn: &mut SqliteConnection, owner: &str, keys: &[&str]) -> AppResult<usize> {
    let taken: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, key FROM plan_decks WHERE owner_id = ? AND note_id IS NOT NULL AND key IN (SELECT value FROM json_each(?))",
    )
    .bind(owner)
    .bind(json_text(&keys))
    .fetch_all(&mut *conn)
    .await?;
    let stamp = now();
    for (id, key) in &taken {
        let new_key = free_key(&mut *conn, owner, &format!("{key}-note"), keys).await?;
        sqlx::query("UPDATE plan_decks SET key = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
            .bind(&new_key)
            .bind(&stamp)
            .bind(id)
            .bind(owner)
            .execute(&mut *conn)
            .await?;
    }
    Ok(taken.len())
}

// ── deriving ───────────────────────────────────────────────────────────────

struct Derived {
    swaps: usize,
    warnings: Vec<String>,
}

/// Where a swap's card comes from, read from the note's acquisition evidence.
struct Source {
    src: &'static str,
    store_label: Option<String>,
    got: Option<Value>,
    note: Option<String>,
    /// The note's store offer for a buy: becomes a dated quote.
    offer: Option<Value>,
}

/// The note's own record for a card: the swap's acquisition, else the build's acquisition lists.
fn evidence<'a>(build: &'a Value, swap: &'a Value, card: &str) -> (Option<&'static str>, &'a Value) {
    let own = &swap["acquisition"];
    if own.get("kind").and_then(Value::as_str).is_some_and(|k| !k.trim().is_empty()) {
        return (None, own);
    }
    let want = card.trim().to_lowercase();
    for (section, kind) in [("owned", "owned"), ("buys", "buy"), ("prints", "print"), ("basics", "basic"), ("sealed_purchases", "future_stock")] {
        if let Some(item) =
            build["acquisition"][section].as_array().into_iter().flatten().find(|i| i["card"].as_str().is_some_and(|c| c.trim().to_lowercase() == want))
        {
            return (Some(kind), item);
        }
    }
    (None, own)
}

fn source_of(build: &Value, swap: &Value, card: &str) -> Source {
    let (section, item) = evidence(build, swap, card);
    let kind = item["kind"].as_str().map(str::trim).filter(|k| !k.is_empty()).or(section).unwrap_or("");
    let detail = text(item, "detail");
    let owned = |detail: Option<String>| Source { src: "owned", store_label: None, got: Some(json!({"how": "owned", "detail": detail})), note: None, offer: None };
    match kind {
        "owned" | "keep" => owned(detail),
        "arrived_print" => owned(Some(detail.unwrap_or_else(|| "Your print, arrived".into()))),
        "basic" => owned(Some(detail.unwrap_or_else(|| "A basic land".into()))),
        "transfer" => owned(text(item, "deck").map(|d| format!("Moved from {d}")).or(detail)),
        "buy" | "buys" | "local_buy" | "online_buy" => Source { src: "buy", store_label: text(item, "store"), got: None, note: detail, offer: Some(item.clone()) },
        "print" | "prints" | "proxy" => Source { src: "print", store_label: None, got: None, note: detail, offer: None },
        "future_stock" | "projected_stock" | "sealed" => Source {
            src: "buy",
            store_label: None,
            got: None,
            note: Some(format!("Comes with {} if you buy it.", detail.unwrap_or_else(|| "a sealed product".into()))),
            offer: None,
        },
        _ => Source { src: "buy", store_label: None, got: None, note: Some("The note doesn't say where this card comes from.".into()), offer: None },
    }
}

/// One list as (board, name, qty), in order.
type List = Vec<(&'static str, String, i64)>;

fn take(list: &mut List, name: &str) -> bool {
    let want = name.trim().to_lowercase();
    let Some(i) = list.iter().position(|(b, n, _)| *b == "main" && n.trim().to_lowercase() == want) else {
        return false;
    };
    list[i].2 -= 1;
    if list[i].2 <= 0 {
        list.remove(i);
    }
    true
}

fn put(list: &mut List, name: &str) {
    let want = name.trim().to_lowercase();
    match list.iter_mut().find(|(b, n, _)| *b == "main" && n.trim().to_lowercase() == want) {
        Some(row) => row.2 += 1,
        None => list.push(("main", name.trim().to_string(), 1)),
    }
}

struct SwapRow {
    key: String,
    card_in: String,
    card_out: Option<String>,
    source: Source,
}

#[allow(clippy::too_many_arguments)]
async fn derive(conn: &mut SqliteConnection, owner: &str, plan_id: &str, note_id: &str, title: &str, deck_key: &str, build: &Value, stamp: &str) -> AppResult<Derived> {
    let build_id = text(build, "id").unwrap_or_default();
    let mut warnings = Vec::new();
    let after: List = parse_list(build["list"].as_str().unwrap_or_default(), true)
        .into_iter()
        .filter_map(|l| match l.board {
            Board::Commander => Some(("commander", l.name, l.qty)),
            Board::Main => Some(("main", l.name, l.qty)),
            _ => None,
        })
        .collect();
    let total: i64 = after.iter().map(|c| c.2).sum();
    if total != 100 {
        warnings.push(format!("The build's list has {total} cards, not 100."));
    }

    // Swaps, upserted by their stable key; ones the build no longer has are retired.
    let mut rows: Vec<SwapRow> = Vec::new();
    let mut seen = HashSet::new();
    for (i, s) in build["swaps"].as_array().into_iter().flatten().enumerate() {
        let Some(card_in) = text(s, "card_in") else { continue };
        let id = text(s, "id").unwrap_or_else(|| format!("swap-{}", i + 1));
        let key = format!("n|{note_id}|{deck_key}|{build_id}|{id}");
        if !seen.insert(key.clone()) {
            warnings.push(format!("Swap id \"{id}\" appears twice in the build; the second was left out."));
            continue;
        }
        let source = source_of(build, s, &card_in);
        let card_out = text(s, "card_out");
        let row = json!({
            "role": if card_out.is_some() { "swap" } else { "optional" }, "src": source.src, "store_label": source.store_label,
            "out": card_out, "in": card_in, "sort": i, "got": source.got, "why": text(s, "why"), "why_out": text(s, "why_out"),
            "note": source.note,
        });
        sqlx::query(
            "INSERT INTO plan_swaps (id, owner_id, plan_deck_id, ext_key, stage, role, src, store_label, out_name, in_name, sort, got,
               why, why_out, note, content_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner_id, ext_key) DO UPDATE SET plan_deck_id = excluded.plan_deck_id, stage = excluded.stage,
               role = excluded.role, src = excluded.src, store_label = excluded.store_label, out_name = excluded.out_name,
               in_name = excluded.in_name, sort = excluded.sort, got = excluded.got, why = excluded.why, why_out = excluded.why_out,
               note = excluded.note, content_hash = excluded.content_hash, retired_at = NULL, updated_at = excluded.updated_at
             WHERE plan_swaps.content_hash IS NOT excluded.content_hash OR plan_swaps.retired_at IS NOT NULL
               OR plan_swaps.plan_deck_id != excluded.plan_deck_id",
        )
        .bind(new_id())
        .bind(owner)
        .bind(plan_id)
        .bind(&key)
        .bind(row["role"].as_str())
        .bind(source.src)
        .bind(&source.store_label)
        .bind(&card_out)
        .bind(&card_in)
        .bind(i as i64)
        .bind(source.got.as_ref().map(Value::to_string))
        .bind(text(s, "why"))
        .bind(text(s, "why_out"))
        .bind(&source.note)
        .bind(model::row_hash(&row))
        .bind(stamp)
        .bind(stamp)
        .execute(&mut *conn)
        .await?;
        rows.push(SwapRow { key, card_in, card_out, source });
    }
    let keys: Vec<&str> = rows.iter().map(|r| r.key.as_str()).collect();
    sqlx::query(
        "UPDATE plan_swaps SET retired_at = ?, updated_at = ? WHERE owner_id = ? AND plan_deck_id = ? AND retired_at IS NULL
           AND ext_key NOT IN (SELECT value FROM json_each(?))",
    )
    .bind(stamp)
    .bind(stamp)
    .bind(owner)
    .bind(plan_id)
    .bind(json_text(&keys))
    .execute(&mut *conn)
    .await?;

    // The note's dated store offers for its buys, as quotes. Re-written whole each time.
    sqlx::query(
        "DELETE FROM plan_quotes WHERE owner_id = ? AND origin = 'yama'
           AND swap_id IN (SELECT id FROM plan_swaps WHERE owner_id = ? AND plan_deck_id = ?)",
    )
    .bind(owner)
    .bind(owner)
    .bind(plan_id)
    .execute(&mut *conn)
    .await?;
    for r in &rows {
        let Some(offer) = &r.source.offer else { continue };
        let (Some(store), Some(checked)) = (text(offer, "store"), text(offer, "checked")) else { continue };
        let checked: String = checked.chars().take(10).collect();
        if !model::is_date(&checked) {
            continue;
        }
        let swap_id: String =
            sqlx::query_scalar("SELECT id FROM plan_swaps WHERE owner_id = ? AND ext_key = ?").bind(owner).bind(&r.key).fetch_one(&mut *conn).await?;
        let price = offer["price"].as_f64().filter(|p| *p >= 0.0);
        let url = text(offer, "url").filter(|u| u.starts_with("https://") || u.starts_with("http://"));
        sqlx::query(
            "INSERT INTO plan_quotes (id, owner_id, swap_id, card_name, kind, store_label, checked_on, result, in_stock, price, currency,
               printing, url, source, origin, created_at)
             VALUES (?, ?, ?, ?, 'stock_check', ?, ?, ?, 1, ?, 'USD', ?, ?, ?, 'yama', ?)",
        )
        .bind(new_id())
        .bind(owner)
        .bind(&swap_id)
        .bind(&r.card_in)
        .bind(&store)
        .bind(&checked)
        .bind(text(offer, "condition"))
        .bind(price)
        .bind(text(offer, "printing"))
        .bind(url)
        .bind(format!("Recorded in the note \"{title}\""))
        .bind(stamp)
        .execute(&mut *conn)
        .await?;
    }

    // Lists: stock undoes every swap, now applies the owned ones, after is the build's list.
    let mut stock = after.clone();
    for r in &rows {
        if take(&mut stock, &r.card_in) {
            if let Some(out) = &r.card_out {
                put(&mut stock, out);
            }
        } else {
            warnings.push(format!("{} isn't in the build's list, so its swap leaves stock unchanged.", r.card_in));
        }
    }
    let mut now_list = stock.clone();
    for r in rows.iter().filter(|r| r.source.src == "owned") {
        if let Some(out) = &r.card_out {
            take(&mut now_list, out);
        }
        put(&mut now_list, &r.card_in);
    }
    let by_in: HashMap<String, &SwapRow> = rows.iter().map(|r| (r.card_in.trim().to_lowercase(), r)).collect();
    let slots = |list: &List, swapped: &dyn Fn(&SwapRow) -> bool| -> Vec<Value> {
        let mut out: Vec<Value> = list
            .iter()
            .map(|(board, name, qty)| match by_in.get(&name.trim().to_lowercase()).filter(|r| *board == "main" && swapped(&***r)) {
                Some(r) => json!({
                    "name": name, "qty": qty, "board": board,
                    "kind": match r.source.src { "owned" => "owner", "print" => "print", _ => "bought" },
                    "replaces": r.card_out, "swap": r.key, "got": r.source.got,
                }),
                None => json!({"name": name, "qty": qty, "board": board, "kind": "stock"}),
            })
            .collect();
        out.sort_by(|a, b| {
            (a["board"] != "commander", a["name"].as_str().unwrap_or_default().to_lowercase())
                .cmp(&(b["board"] != "commander", b["name"].as_str().unwrap_or_default().to_lowercase()))
        });
        out
    };
    let status = |r: &SwapRow| match r.source.src {
        "owned" => "done",
        "print" => "print",
        _ => "waiting",
    };
    let after_log: Vec<Value> = rows.iter().map(|r| json!({"swap": r.key, "status": status(r)})).collect();
    let now_log: Vec<Value> = rows.iter().filter(|r| r.source.src == "owned").map(|r| json!({"swap": r.key, "status": "done"})).collect();
    let states = [
        ("stock", slots(&stock, &|_| false), Vec::new()),
        ("now", slots(&now_list, &|r| r.source.src == "owned"), now_log),
        ("after", slots(&after, &|_| true), after_log),
    ];
    sqlx::query("UPDATE plan_states SET current = 0, updated_at = ? WHERE owner_id = ? AND plan_deck_id = ? AND current = 1")
        .bind(stamp)
        .bind(owner)
        .bind(plan_id)
        .execute(&mut *conn)
        .await?;
    for (state, cards, log) in states {
        let typed: Vec<Slot> = serde_json::from_value(Value::Array(cards.clone())).map_err(|e| AppError::Other(e.into()))?;
        sqlx::query(
            "INSERT INTO plan_states (id, owner_id, plan_deck_id, state, content_hash, cards, log, computed_by, current, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(plan_deck_id, state, content_hash) DO UPDATE SET cards = excluded.cards, log = excluded.log,
               computed_by = excluded.computed_by, current = 1, updated_at = excluded.updated_at",
        )
        .bind(new_id())
        .bind(owner)
        .bind(plan_id)
        .bind(state)
        .bind(model::list_identity(&typed))
        .bind(Value::Array(cards).to_string())
        .bind(Value::Array(log).to_string())
        .bind(COMPUTED_BY)
        .bind(stamp)
        .bind(stamp)
        .execute(&mut *conn)
        .await?;
    }
    Ok(Derived { swaps: rows.len(), warnings })
}

// ── helpers ────────────────────────────────────────────────────────────────

fn text(v: &Value, field: &str) -> Option<String> {
    v.get(field).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

fn json_text<T: Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).expect("json")
}

pub(crate) fn find_deck<'a>(doc: &'a Value, key: &str) -> Option<&'a Value> {
    doc["decks"].as_array()?.iter().find(|d| d["key"] == key)
}

pub(crate) fn find_build<'a>(deck: &'a Value, id: &str) -> Option<&'a Value> {
    deck["builds"].as_array()?.iter().find(|b| b["id"] == id)
}

/// The build's commander line(s), else the note deck's commander.
fn commanders(deck: &Value, build: &Value) -> Vec<String> {
    let from_list: Vec<String> =
        parse_list(build["list"].as_str().unwrap_or_default(), true).into_iter().filter(|l| l.board == Board::Commander).map(|l| l.name).collect();
    if !from_list.is_empty() {
        return from_list;
    }
    text(deck, "commander").into_iter().collect()
}

/// One of the owner's notes: its document and content hash.
pub(crate) async fn note_document(conn: &mut SqliteConnection, owner: &str, id: &str) -> AppResult<(Value, String)> {
    let row: Option<(String, String)> = sqlx::query_as("SELECT document, content_hash FROM research_reports WHERE owner_id = ? AND id = ?")
        .bind(owner)
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?;
    let (doc, hash) = row.ok_or(AppError::NotFound("note"))?;
    Ok((serde_json::from_str(&doc).map_err(|e| AppError::Other(e.into()))?, hash))
}

/// The caller's only live main deck with this name (any case), if there is exactly one.
async fn deck_by_name(conn: &mut SqliteConnection, owner: &str, name: &str) -> AppResult<Option<String>> {
    if name.trim().is_empty() {
        return Ok(None);
    }
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM decks WHERE owner_id = ? AND archived = 0 AND parent_id IS NULL AND name = ? COLLATE NOCASE LIMIT 2")
            .bind(owner)
            .bind(name.trim())
            .fetch_all(&mut *conn)
            .await?;
    Ok(if ids.len() == 1 { ids.into_iter().next() } else { None })
}

/// `base` as a plan key (lower case, a-z, 0-9 and -), or the first free `base-2`, `base-3`...,
/// avoiding the caller's plan decks and `also` (keys an import is about to write).
async fn free_key(conn: &mut SqliteConnection, owner: &str, base: &str, also: &[&str]) -> AppResult<String> {
    let mut slug = String::new();
    for ch in base.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-').to_string();
    let slug = if slug.is_empty() { "plan".to_string() } else { slug };
    for n in 1.. {
        let candidate = if n == 1 { slug.clone() } else { format!("{slug}-{n}") };
        if also.contains(&candidate.as_str()) {
            continue;
        }
        let taken: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM plan_decks WHERE owner_id = ? AND key = ?").bind(owner).bind(&candidate).fetch_optional(&mut *conn).await?;
        if taken.is_none() {
            return Ok(candidate);
        }
    }
    unreachable!("an unbounded range always finds a free key")
}

async fn bump(conn: &mut SqliteConnection, owner: &str, stamp: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO plan_meta (owner_id, revision, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at",
    )
    .bind(owner)
    .bind(stamp)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

#[cfg(test)]
#[path = "tests_notes.rs"]
mod tests;
