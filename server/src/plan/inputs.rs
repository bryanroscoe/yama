//! What people do on the plan pages (docs/planner-design.md 3.3, 3.4 and 5.4): review answers,
//! installed ticks, "bought it" marks and ideas, sent as ops with client-made ids.
//!
//! - A retried op is a no-op: `UNIQUE(owner_id, op_id)`, answered `duplicate` with the first result.
//! - Each op runs in its own savepoint, so a bad op is stored as `rejected` with its error and never
//!   blocks the ops after it. A retried rejected op gets the same rejection.
//! - Answers and marks are full records, last writer wins. `at` is UTC in whole seconds, and a device
//!   clock more than five minutes ahead is clamped to the time the op arrived. The later `at` wins;
//!   on a tie the answer made in Yama beats one from an import, then the larger op id wins, so the
//!   result never depends on the order ops and imports arrive in. A cleared answer is a tombstone.
//! - Ops aimed at an imported deck, or at a key that matches no deck, are kept for the export side
//!   (`for_export`). Its script reads them from `GET /api/plan/inbox` and moves the cursor with
//!   `POST /api/plan/inbox/ack`. `seq` is a global AUTOINCREMENT, so two devices can't collide.
//! - "Bought it" is a claim. It never creates an order, changes a list or counts as owned.

use super::tokens::SyncUser;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::now;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::{Json, Router};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::{HashMap, HashSet};

/// Ops in one request.
pub const MAX_OPS: usize = 500;
/// One op as sent, in bytes. A note is at most 2000 characters, so real ops are far smaller.
const MAX_OP_BYTES: usize = 16 * 1024;
/// How far ahead of the server a device clock may be before its time is clamped.
const FUTURE_SECONDS: i64 = 300;
/// Inbox ops per page.
pub const INBOX_PAGE: i64 = 1000;
pub const KINDS: [&str; 4] = ["review", "installed", "bought", "idea"];

pub fn router() -> Router<AppState> {
    use axum::routing::{get, post};
    Router::new()
        .route("/api/plan/inputs", post(post_inputs))
        .route("/api/plan/inbox", get(inbox_route))
        .route("/api/plan/inbox/ack", post(ack_route))
}

// ── what an op names ───────────────────────────────────────────────────────

struct DeckInfo {
    name: String,
    source: String,
}

struct SwapInfo {
    deck_key: String,
    in_name: String,
    out_name: Option<String>,
    stage: String,
    role: String,
}

/// The owner's decks, live swaps, aliases and stores, read once per request.
struct Ctx {
    decks: HashMap<String, DeckInfo>,
    swaps: HashMap<String, SwapInfo>,
    live: HashSet<String>,
    aliases: HashMap<String, String>,
    stores: HashSet<String>,
}

impl Ctx {
    async fn load(conn: &mut SqliteConnection, owner: &str) -> AppResult<Ctx> {
        let decks: Vec<(String, String, String)> =
            sqlx::query_as("SELECT key, name, source FROM plan_decks WHERE owner_id = ?").bind(owner).fetch_all(&mut *conn).await?;
        #[allow(clippy::type_complexity)]
        let swaps: Vec<(String, String, String, Option<String>, String, String)> = sqlx::query_as(
            "SELECT s.ext_key, d.key, s.in_name, s.out_name, s.stage, s.role
             FROM plan_swaps s JOIN plan_decks d ON d.id = s.plan_deck_id AND d.owner_id = s.owner_id
             WHERE s.owner_id = ? AND s.retired_at IS NULL AND d.status != 'archived'",
        )
        .bind(owner)
        .fetch_all(&mut *conn)
        .await?;
        let stores: Vec<String> = sqlx::query_scalar("SELECT key FROM plan_stores WHERE owner_id = ?").bind(owner).fetch_all(&mut *conn).await?;
        let aliases = super::aliases(&mut *conn, owner).await?;
        let swaps: HashMap<String, SwapInfo> = swaps
            .into_iter()
            .map(|(key, deck_key, in_name, out_name, stage, role)| (key, SwapInfo { deck_key, in_name, out_name, stage, role }))
            .collect();
        Ok(Ctx {
            decks: decks.into_iter().map(|(key, name, source)| (key, DeckInfo { name, source })).collect(),
            live: swaps.keys().cloned().collect(),
            swaps,
            aliases,
            stores: stores.into_iter().collect(),
        })
    }

    /// The live swap a key reaches through aliases, with its key.
    fn swap(&self, key: &str) -> Option<(String, &SwapInfo)> {
        let k = super::resolve_key(key, &self.live, &self.aliases)?;
        let s = self.swaps.get(&k)?;
        Some((k, s))
    }
}

// ── parsing one op ─────────────────────────────────────────────────────────

/// An op after its fields are checked, without anything that depends on the owner's rows.
#[derive(Debug, Clone)]
struct Parsed {
    kind: &'static str,
    swap_key: Option<String>,
    deck_key: Option<String>,
    device_id: Option<String>,
    /// The normalized record the export side reads: the full answer, mark or idea.
    record: Value,
}

fn field<'a>(op: &'a Map<String, Value>, name: &str) -> Option<&'a Value> {
    op.get(name).filter(|v| !v.is_null())
}

fn text(op: &Map<String, Value>, name: &str, max: usize) -> Result<Option<String>, String> {
    match field(op, name) {
        None => Ok(None),
        Some(Value::String(s)) if s.chars().count() > max => Err(format!("{name}: at most {max} characters")),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(format!("{name}: expected text, got {other}")),
    }
}

/// Text that must be there and not blank.
fn needed(op: &Map<String, Value>, name: &str, max: usize, what: &str) -> Result<String, String> {
    text(op, name, max)?.filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("{name}: missing; {what}"))
}

/// Text where blank means none.
fn blank_none(op: &Map<String, Value>, name: &str, max: usize) -> Result<Option<String>, String> {
    Ok(text(op, name, max)?.filter(|s| !s.trim().is_empty()))
}

fn flag(op: &Map<String, Value>, name: &str) -> Result<bool, String> {
    match field(op, name) {
        Some(Value::Bool(b)) => Ok(*b),
        Some(other) => Err(format!("{name}: expected true or false, got {other}")),
        None => Err(format!("{name}: missing; true sets it, false clears it")),
    }
}

/// The op's time as applied: UTC, whole seconds, no more than five minutes after `received`.
fn op_time(op: &Map<String, Value>, received: DateTime<Utc>) -> Result<String, String> {
    let s = needed(op, "at", 64, "the time of the tap, RFC 3339 with a zone")?;
    let t = DateTime::parse_from_rfc3339(&s)
        .map_err(|_| format!("at: \"{s}\" isn't an RFC 3339 time with a zone (2026-10-19T01:00:00Z)"))?
        .with_timezone(&Utc);
    let t = if t > received + Duration::seconds(FUTURE_SECONDS) { received } else { t };
    Ok(t.to_rfc3339_opts(SecondsFormat::Secs, true))
}

/// Check an op's fields. Pure: references to the owner's rows are checked in `apply`.
fn parse(op: &Map<String, Value>) -> Result<Parsed, String> {
    let kind = match field(op, "kind") {
        Some(Value::String(k)) => KINDS.iter().copied().find(|x| x == k).ok_or_else(|| format!("kind: \"{k}\" isn't one of {}", KINDS.join(", ")))?,
        Some(other) => return Err(format!("kind: expected text, got {other}")),
        None => return Err(format!("kind: missing; one of {}", KINDS.join(", "))),
    };
    let device_id = text(op, "device_id", 100)?;
    let deck_key = blank_none(op, "deck_key", 200)?;
    let swap_key = || needed(op, "swap_key", 500, "the key of the swap this is about");
    let (swap_key, record) = match kind {
        "review" => {
            let decision = match field(op, "decision") {
                None => None,
                Some(Value::String(d)) if ["want", "unsure", "no"].contains(&d.as_str()) => Some(d.clone()),
                Some(other) => return Err(format!("decision: {other} isn't one of want, unsure, no or null")),
            };
            let note = blank_none(op, "note", 2000)?;
            let cut = blank_none(op, "cut", 300)?;
            (Some(swap_key()?), json!({"decision": decision, "note": note, "cut": cut}))
        }
        "installed" => (Some(swap_key()?), json!({"value": flag(op, "value")?})),
        "bought" => {
            let value = flag(op, "value")?;
            let qty = match field(op, "qty") {
                None => 1,
                Some(v) => v.as_i64().filter(|q| (1..=100).contains(q)).ok_or_else(|| format!("qty: {v} isn't a whole number from 1 to 100"))?,
            };
            let price_paid = match field(op, "price_paid") {
                None => None,
                Some(v) => Some(
                    v.as_f64().filter(|p| p.is_finite() && *p >= 0.0).ok_or_else(|| format!("price_paid: {v} isn't a price; a number ≥ 0, or null when you don't know"))?,
                ),
            };
            let on = text(op, "on", 10)?;
            if let Some(d) = &on
                && !super::model::is_date(d)
            {
                return Err(format!("on: \"{d}\" isn't a YYYY-MM-DD date"));
            }
            if value && on.is_none() {
                return Err("on: missing; the date you bought it, YYYY-MM-DD".into());
            }
            let record = json!({
                "value": value, "store_key": blank_none(op, "store_key", 100)?, "store_label": blank_none(op, "store_label", 200)?,
                "price_paid": price_paid, "qty": qty, "on": on,
            });
            (Some(swap_key()?), record)
        }
        _ => {
            if deck_key.is_none() {
                return Err("deck_key: missing; the plan deck the idea is for".into());
            }
            let record = json!({
                "in": needed(op, "in", 200, "the card you'd put in")?, "out": blank_none(op, "out", 200)?, "why": blank_none(op, "why", 2000)?,
            });
            (None, record)
        }
    };
    Ok(Parsed { kind, swap_key, deck_key, device_id, record })
}

// ── applying ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct OpResult {
    /// Null when the op had no usable id (it isn't stored then).
    pub op_id: Option<String>,
    /// applied | duplicate | rejected
    pub status: &'static str,
    /// For a duplicate: what happened the first time (applied or rejected).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub seq: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct InputsReply {
    /// The owner's plan revision after this batch. A bundle with this revision or later includes it.
    pub revision: i64,
    pub results: Vec<OpResult>,
}

/// `POST /api/plan/inputs`: a JSON array of ops. The body is read as bytes, so anything that isn't
/// a JSON array is a 400 that says so, and each op is checked on its own.
async fn post_inputs(State(st): State<AppState>, CurrentUser(user): CurrentUser, body: Bytes) -> AppResult<Json<InputsReply>> {
    let ops: Vec<Value> = serde_json::from_slice(&body).map_err(|e| AppError::bad(format!("body: expected a JSON array of ops ({e})")))?;
    if ops.len() > MAX_OPS {
        return Err(AppError::bad(format!("body: at most {MAX_OPS} ops at a time")));
    }
    Ok(Json(apply_ops(&st.pool, &user.id, ops, Utc::now()).await?))
}

/// Apply a batch as `owner`, received at `received`. One transaction, one savepoint per op.
pub async fn apply_ops(pool: &SqlitePool, owner: &str, ops: Vec<Value>, received: DateTime<Utc>) -> AppResult<InputsReply> {
    let received_at = received.to_rfc3339_opts(SecondsFormat::Secs, true);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let conn: &mut SqliteConnection = &mut tx;
    let ctx = Ctx::load(&mut *conn, owner).await?;
    let mut results = Vec::with_capacity(ops.len());
    let mut applied = 0;
    for op in ops {
        let op_id = op.get("op_id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty() && s.chars().count() <= 100).map(str::to_string);
        let Some(op_id) = op_id else {
            results.push(OpResult { op_id: None, status: "rejected", original: None, error: Some("op_id: missing; every op needs a client-made id of up to 100 characters".into()), seq: None });
            continue;
        };
        let earlier: Option<(i64, String, Option<String>)> = sqlx::query_as("SELECT seq, status, error FROM plan_inputs WHERE owner_id = ? AND op_id = ?")
            .bind(owner)
            .bind(&op_id)
            .fetch_optional(&mut *conn)
            .await?;
        if let Some((seq, status, error)) = earlier {
            results.push(OpResult { op_id: Some(op_id), status: "duplicate", original: Some(status), error, seq: Some(seq) });
            continue;
        }
        let payload = op.to_string();
        sqlx::query("SAVEPOINT plan_op").execute(&mut *conn).await?;
        let outcome = match op.as_object() {
            None => Err(format!("op: expected an object, got {op}")),
            Some(_) if payload.len() > MAX_OP_BYTES => Err(format!("op: at most {MAX_OP_BYTES} bytes")),
            Some(obj) => match (parse(obj), op_time(obj, received)) {
                (Ok(p), Ok(at)) => apply(&mut *conn, owner, &ctx, &p, &op_id, &at).await?.map(|(deck_key, for_export)| (p, at, deck_key, for_export)),
                (Err(e), _) | (_, Err(e)) => Err(e),
            },
        };
        let obj = op.as_object();
        let raw = |name: &str| obj.and_then(|o| o.get(name)).and_then(Value::as_str).map(|s| s.chars().take(500).collect::<String>());
        let seq = match outcome {
            Ok((p, at, deck_key, for_export)) => {
                applied += 1;
                insert_input(&mut *conn, owner, &op_id, p.device_id.as_deref(), p.kind, p.swap_key.as_deref(), deck_key.as_deref(), &payload, "applied", None, for_export, &at, &received_at).await?
            }
            Err(error) => {
                sqlx::query("ROLLBACK TO plan_op").execute(&mut *conn).await?;
                let kind = raw("kind").unwrap_or_default();
                let client_at = raw("at").unwrap_or_else(|| received_at.clone());
                let seq = insert_input(
                    &mut *conn, owner, &op_id, raw("device_id").as_deref(), &kind, raw("swap_key").as_deref(), raw("deck_key").as_deref(),
                    &payload, "rejected", Some(&error), false, &client_at, &received_at,
                )
                .await?;
                sqlx::query("RELEASE plan_op").execute(&mut *conn).await?;
                results.push(OpResult { op_id: Some(op_id), status: "rejected", original: None, error: Some(error), seq: Some(seq) });
                continue;
            }
        };
        sqlx::query("RELEASE plan_op").execute(&mut *conn).await?;
        results.push(OpResult { op_id: Some(op_id), status: "applied", original: None, error: None, seq: Some(seq) });
    }
    if applied > 0 {
        sqlx::query("INSERT INTO plan_meta (owner_id, updated_at) VALUES (?, ?) ON CONFLICT(owner_id) DO NOTHING").bind(owner).bind(&received_at).execute(&mut *conn).await?;
        sqlx::query("UPDATE plan_meta SET revision = revision + 1, updated_at = ? WHERE owner_id = ?").bind(&received_at).bind(owner).execute(&mut *conn).await?;
    }
    let revision: i64 = sqlx::query_scalar("SELECT IFNULL((SELECT revision FROM plan_meta WHERE owner_id = ?), 0)").bind(owner).fetch_one(&mut *conn).await?;
    tx.commit().await?;
    Ok(InputsReply { revision, results })
}

#[allow(clippy::too_many_arguments)]
async fn insert_input(
    conn: &mut SqliteConnection,
    owner: &str,
    op_id: &str,
    device_id: Option<&str>,
    kind: &str,
    swap_key: Option<&str>,
    deck_key: Option<&str>,
    payload: &str,
    status: &str,
    error: Option<&str>,
    for_export: bool,
    client_at: &str,
    received_at: &str,
) -> AppResult<i64> {
    Ok(sqlx::query_scalar(
        "INSERT INTO plan_inputs (owner_id, op_id, device_id, kind, swap_key, deck_key, payload, status, error, for_export, client_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq",
    )
    .bind(owner)
    .bind(op_id)
    .bind(device_id)
    .bind(kind)
    .bind(swap_key)
    .bind(deck_key)
    .bind(payload)
    .bind(status)
    .bind(error)
    .bind(for_export)
    .bind(client_at)
    .bind(received_at)
    .fetch_one(&mut *conn)
    .await?)
}

/// Write one checked op. `Ok(Err(..))` rejects the op; `Err(..)` is a database failure that fails the
/// batch. Returns the deck the op is about (when known) and whether the export side should see it.
async fn apply(conn: &mut SqliteConnection, owner: &str, ctx: &Ctx, p: &Parsed, op_id: &str, at: &str) -> AppResult<Result<(Option<String>, bool), String>> {
    let swap = p.swap_key.as_deref().and_then(|k| ctx.swap(k));
    let deck_key = swap.as_ref().map(|(_, s)| s.deck_key.clone()).or_else(|| p.deck_key.clone());
    let deck = deck_key.as_deref().and_then(|k| ctx.decks.get(k));
    // Ops on a deck made in Yama take effect here only; everything else is for the export side.
    let for_export = deck.is_none_or(|d| d.source != "yama");
    let key = p.swap_key.as_deref().unwrap_or_default();
    match p.kind {
        "review" => {
            let r = &p.record;
            let card = swap.as_ref().map(|(_, s)| s.in_name.clone());
            sqlx::query(
                "INSERT INTO plan_reviews (owner_id, swap_key, decision, note, cut, deck_name, card, at, origin, op_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'yama', ?)
                 ON CONFLICT(owner_id, swap_key) DO UPDATE SET decision = excluded.decision, note = excluded.note, cut = excluded.cut,
                   deck_name = COALESCE(excluded.deck_name, plan_reviews.deck_name), card = COALESCE(excluded.card, plan_reviews.card),
                   at = excluded.at, origin = 'yama', op_id = excluded.op_id
                 WHERE excluded.at > plan_reviews.at
                    OR (excluded.at = plan_reviews.at AND (plan_reviews.origin != 'yama' OR excluded.op_id > IFNULL(plan_reviews.op_id, '')))",
            )
            .bind(owner)
            .bind(key)
            .bind(r["decision"].as_str())
            .bind(r["note"].as_str())
            .bind(r["cut"].as_str())
            .bind(deck.map(|d| d.name.as_str()))
            .bind(card)
            .bind(at)
            .bind(op_id)
            .execute(&mut *conn)
            .await?;
        }
        "installed" | "bought" => {
            let mut payload = p.record.clone();
            if let Some(s) = payload.get("store_key").and_then(Value::as_str)
                && !ctx.stores.contains(s)
            {
                return Ok(Err(format!("store_key: there's no store \"{s}\" in your plan")));
            }
            let value = payload.as_object_mut().and_then(|o| o.remove("value")).and_then(|v| v.as_bool()).unwrap_or(false);
            sqlx::query(
                "INSERT INTO plan_marks (owner_id, swap_key, kind, value, payload, at, op_id) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(owner_id, swap_key, kind) DO UPDATE SET value = excluded.value, payload = excluded.payload,
                   at = excluded.at, op_id = excluded.op_id
                 WHERE excluded.at > plan_marks.at OR (excluded.at = plan_marks.at AND excluded.op_id > plan_marks.op_id)",
            )
            .bind(owner)
            .bind(key)
            .bind(p.kind)
            .bind(value)
            .bind(payload.to_string())
            .bind(at)
            .bind(op_id)
            .execute(&mut *conn)
            .await?;
        }
        _ => {} // an idea is only its plan_inputs row
    }
    Ok(Ok((deck_key, for_export)))
}

// ── the inbox, for the export side ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct InboxQuery {
    after: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct InboxOp {
    pub seq: i64,
    pub op_id: String,
    pub device_id: Option<String>,
    pub kind: String,
    /// The key as sent.
    pub swap_key: Option<String>,
    /// The live key it reaches through aliases; null for an orphan or an idea.
    pub key: Option<String>,
    /// True when `swap_key` reaches no live swap (kept, never dropped).
    pub orphan: bool,
    pub deck_key: Option<String>,
    /// The deck's display name, as the review site's keys and review.json use it.
    pub deck: Option<String>,
    /// The swap's card in and card out, when the key reaches a live swap.
    pub card: Option<String>,
    pub out: Option<String>,
    pub stage: Option<String>,
    pub role: Option<String>,
    /// The time the op applies at: UTC, whole seconds, clamped.
    pub at: String,
    pub received_at: String,
    /// The normalized full record: review {decision, note, cut}; installed {value}; bought {value,
    /// store_key, store_label, price_paid, qty, on}; idea {in, out, why}.
    pub record: Value,
    pub outcome: Option<String>,
    pub outcome_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Inbox {
    /// The cursor the export side last acknowledged.
    pub pulled_through: i64,
    pub pulled_at: Option<String>,
    /// The highest seq in `ops` (or `after` when empty): acknowledge this once they're saved.
    pub through: i64,
    /// More ops wait after `through`; ask again with `?after=<through>`.
    pub more: bool,
    pub ops: Vec<InboxOp>,
}

async fn inbox_route(State(st): State<AppState>, user: SyncUser, Query(q): Query<InboxQuery>) -> AppResult<Json<Inbox>> {
    Ok(Json(inbox(&st.pool, &user.user_id, q.after).await?))
}

#[derive(sqlx::FromRow)]
struct InputRow {
    seq: i64,
    op_id: String,
    device_id: Option<String>,
    kind: String,
    swap_key: Option<String>,
    deck_key: Option<String>,
    payload: String,
    client_at: String,
    received_at: String,
    outcome: Option<String>,
    outcome_at: Option<String>,
}

/// Applied ops for the export side after `after` (default: the acknowledged cursor), oldest first.
pub async fn inbox(pool: &SqlitePool, owner: &str, after: Option<i64>) -> AppResult<Inbox> {
    let mut conn = pool.acquire().await?;
    let (pulled_through, pulled_at): (i64, Option<String>) = sqlx::query_as("SELECT pulled_through, pulled_at FROM plan_meta WHERE owner_id = ?")
        .bind(owner)
        .fetch_optional(&mut *conn)
        .await?
        .unwrap_or((0, None));
    let after = after.unwrap_or(pulled_through).max(0);
    let mut rows: Vec<InputRow> = sqlx::query_as(
        "SELECT seq, op_id, device_id, kind, swap_key, deck_key, payload, client_at, received_at, outcome, outcome_at FROM plan_inputs
         WHERE owner_id = ? AND for_export = 1 AND status = 'applied' AND seq > ? ORDER BY seq LIMIT ?",
    )
    .bind(owner)
    .bind(after)
    .bind(INBOX_PAGE + 1)
    .fetch_all(&mut *conn)
    .await?;
    let more = rows.len() as i64 > INBOX_PAGE;
    rows.truncate(INBOX_PAGE as usize);
    let ctx = Ctx::load(&mut conn, owner).await?;
    let ops: Vec<InboxOp> = rows
        .into_iter()
        .map(|r| {
            let parsed = serde_json::from_str::<Value>(&r.payload).ok().and_then(|v| v.as_object().and_then(|o| parse(o).ok()));
            let swap = r.swap_key.as_deref().and_then(|k| ctx.swap(k));
            let deck_key = swap.as_ref().map(|(_, s)| s.deck_key.clone()).or(r.deck_key);
            InboxOp {
                seq: r.seq,
                op_id: r.op_id,
                device_id: r.device_id,
                orphan: r.swap_key.is_some() && swap.is_none(),
                key: swap.as_ref().map(|(k, _)| k.clone()),
                card: swap.as_ref().map(|(_, s)| s.in_name.clone()),
                out: swap.as_ref().and_then(|(_, s)| s.out_name.clone()),
                stage: swap.as_ref().map(|(_, s)| s.stage.clone()),
                role: swap.as_ref().map(|(_, s)| s.role.clone()),
                deck: deck_key.as_deref().and_then(|k| ctx.decks.get(k)).map(|d| d.name.clone()),
                deck_key,
                kind: r.kind,
                swap_key: r.swap_key,
                at: r.client_at,
                received_at: r.received_at,
                record: parsed.map(|p| p.record).unwrap_or(Value::Null),
                outcome: r.outcome,
                outcome_at: r.outcome_at,
            }
        })
        .collect();
    let through = ops.last().map_or(after, |o| o.seq);
    Ok(Inbox { pulled_through, pulled_at, through, more, ops })
}

#[derive(Deserialize)]
pub struct Ack {
    through: i64,
}

#[derive(Debug, Serialize)]
pub struct AckReply {
    pub pulled_through: i64,
    pub pulled_at: Option<String>,
}

async fn ack_route(State(st): State<AppState>, user: SyncUser, body: Bytes) -> AppResult<Json<AckReply>> {
    let Ack { through } = serde_json::from_slice(&body).map_err(|e| AppError::bad(format!("body: expected {{\"through\": <seq>}} ({e})")))?;
    if through < 0 {
        return Err(AppError::bad("through: a seq is 0 or more"));
    }
    Ok(Json(ack(&st.pool, &user.user_id, through).await?))
}

/// Move the cursor forward to `through`, never back, and never past the owner's newest op: seq is
/// global, so a cursor beyond it could skip this owner's next op.
pub async fn ack(pool: &SqlitePool, owner: &str, through: i64) -> AppResult<AckReply> {
    let stamp = now();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("INSERT INTO plan_meta (owner_id, updated_at) VALUES (?, ?) ON CONFLICT(owner_id) DO NOTHING").bind(owner).bind(&stamp).execute(&mut *tx).await?;
    let newest: i64 = sqlx::query_scalar("SELECT IFNULL(MAX(seq), 0) FROM plan_inputs WHERE owner_id = ?").bind(owner).fetch_one(&mut *tx).await?;
    let moved = sqlx::query(
        "UPDATE plan_meta SET pulled_through = ?1, pulled_at = ?2, revision = revision + 1, updated_at = ?2
         WHERE owner_id = ?3 AND pulled_through < ?1",
    )
    .bind(through.min(newest))
    .bind(&stamp)
    .bind(owner)
    .execute(&mut *tx)
    .await?;
    if moved.rows_affected() == 0 {
        // Nothing new: still record that the export side asked.
        sqlx::query("UPDATE plan_meta SET pulled_at = ? WHERE owner_id = ?").bind(&stamp).bind(owner).execute(&mut *tx).await?;
    }
    let (pulled_through, pulled_at): (i64, Option<String>) =
        sqlx::query_as("SELECT pulled_through, pulled_at FROM plan_meta WHERE owner_id = ?").bind(owner).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(AckReply { pulled_through, pulled_at })
}

/// The owner's ideas with what the export side did with them, for the bundle.
pub async fn ideas(pool: &SqlitePool, owner: &str) -> AppResult<Vec<Value>> {
    let rows: Vec<InputRow> = sqlx::query_as(
        "SELECT seq, op_id, device_id, kind, swap_key, deck_key, payload, client_at, received_at, outcome, outcome_at FROM plan_inputs
         WHERE owner_id = ? AND kind = 'idea' AND status = 'applied' ORDER BY seq",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let p = serde_json::from_str::<Value>(&r.payload).ok().and_then(|v| v.as_object().and_then(|o| parse(o).ok()))?;
            Some(json!({
                "op_id": r.op_id, "seq": r.seq, "deck_key": r.deck_key, "in": p.record["in"], "out": p.record["out"],
                "why": p.record["why"], "at": r.client_at, "outcome": r.outcome, "outcome_at": r.outcome_at,
            }))
        })
        .collect())
}
