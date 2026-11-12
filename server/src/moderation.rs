//! Moderation of what people make public. Public by default (Bryan, 12 Nov 2026) puts decks in
//! front of people who don't know their builders, so three things come with it:
//!
//! - **Reports.** Every shared deck and every profile has a Report link (`sharing/report.rs`
//!   draws the form). Anyone may send one, with no account; nothing about the sender is kept.
//!   Sending is limited per address and for the whole server, and one page can only pile up so
//!   many open reports.
//! - **Takedown.** An admin makes a deck private and says why (`deck_takedowns`: who, why, when).
//!   It covers the deck's whole family: the main deck and every configuration of it, which
//!   share its name and most of its list. While the takedown stands none of them can be shared
//!   again: `decks.taken_down_at` is set on each, a configuration made afterwards starts with it
//!   too, the deck's settings refuse any visibility but private, and the public projections skip
//!   it whatever its visibility says. An admin can restore it; the decks stay private until
//!   their owner shares them again. The lock is on those decks: a fresh import of the same list
//!   is a new deck, and someone who keeps doing that has their account turned off in the admin
//!   area's People page, as before.
//! - **The text filter** (`text`): a short list of slurs masked on public pages and refused in
//!   handles, and links taken out of public deck names and descriptions.
//!
//! The admin routes take [`AdminUser`], so they answer anyone else as an unknown path does.
pub(crate) mod text;
#[cfg(test)]
mod tests;

use crate::admin::AdminUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/moderation", get(overview_route))
        .route("/api/admin/moderation/reports/{id}/dismiss", post(dismiss))
        .route("/api/admin/moderation/takedowns", post(take_down))
        .route("/api/admin/moderation/takedowns/{id}/restore", post(restore))
}

/// Why a page is reported: the value stored, and what the form and the admin list call it.
pub(crate) const REASONS: [(&str, &str); 5] = [
    ("spam", "Spam or advertising"),
    ("hateful", "Hateful or harassing"),
    ("sexual", "Sexual or graphic"),
    ("personal", "Someone's personal information"),
    ("other", "Something else"),
];

/// The longest note a reporter can add, in characters.
pub(crate) const MAX_DETAILS: usize = 1000;
/// Open reports kept for one deck or one profile. More are thanked and dropped: the admin
/// already has plenty to go on, and a flood about one page can't fill the table.
const MAX_OPEN_PER_TARGET: i64 = 20;
/// The longest reason an admin can give for a takedown, in characters.
const MAX_REASON: usize = 500;

/// What a report is about.
pub(crate) enum Target<'a> {
    Deck { id: &'a str, owner: &'a str },
    Profile { owner: &'a str },
}

/// The reporter's note as stored: trimmed, without control characters (line breaks stay), cut
/// to [`MAX_DETAILS`]; nothing when it's empty.
fn details_text(raw: &str) -> Option<String> {
    let cleaned: String = raw.chars().filter(|c| *c == '\n' || !c.is_control()).take(MAX_DETAILS).collect();
    let cleaned = cleaned.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

/// Store a report. `reason` must be one of [`REASONS`]. A report that says exactly what an open
/// one already says, or one about a page that already has [`MAX_OPEN_PER_TARGET`] open, is
/// accepted without being stored: the reporter is thanked either way. Returns whether a row
/// was stored, which is what the sending limits count.
pub(crate) async fn file_report(pool: &SqlitePool, target: Target<'_>, reason: &str, details: &str) -> AppResult<bool> {
    if !REASONS.iter().any(|(r, _)| *r == reason) {
        return Err(AppError::bad("pick what's wrong with the page"));
    }
    let details = details_text(details);
    let (kind, owner, deck) = match target {
        Target::Deck { id, owner } => ("deck", owner, Some(id)),
        Target::Profile { owner } => ("profile", owner, None),
    };
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let (open, same): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COALESCE(SUM(reason = ?1 AND COALESCE(details, '') = COALESCE(?2, '')), 0) FROM content_reports
          WHERE resolved_at IS NULL AND kind = ?3 AND owner_id = ?4 AND COALESCE(deck_id, '') = COALESCE(?5, '')",
    )
    .bind(reason)
    .bind(&details)
    .bind(kind)
    .bind(owner)
    .bind(deck)
    .fetch_one(&mut *tx)
    .await?;
    let store = open < MAX_OPEN_PER_TARGET && same == 0;
    if store {
        sqlx::query("INSERT INTO content_reports (id, kind, owner_id, deck_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(new_id())
            .bind(kind)
            .bind(owner)
            .bind(deck)
            .bind(reason)
            .bind(&details)
            .bind(now())
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(store)
}

/// Refuse to share a deck an admin took down, or a configuration of one. For every place an
/// owner changes a deck's visibility to anything but private.
pub(crate) async fn refuse_if_taken_down(conn: &mut sqlx::SqliteConnection, deck: &str) -> AppResult<()> {
    // The takedown is recorded on the family's main deck.
    let down: Option<Option<String>> = sqlx::query_scalar(
        "SELECT (SELECT t.reason FROM deck_takedowns t WHERE t.deck_id IN (d.id, d.parent_id) AND t.restored_at IS NULL ORDER BY t.created_at DESC LIMIT 1)
           FROM decks d WHERE d.id = ?
            AND (d.taken_down_at IS NOT NULL OR EXISTS (SELECT 1 FROM decks m WHERE m.id = d.parent_id AND m.taken_down_at IS NOT NULL))",
    )
    .bind(deck)
    .fetch_optional(conn)
    .await?;
    match down {
        None => Ok(()),
        Some(reason) => Err(AppError::Forbidden(format!(
            "A Yama moderator took this deck's shared page down{}, so it stays private. If you think that's a mistake, write to us from the About page.",
            reason.map(|r| format!(" ({r})")).unwrap_or_default()
        ))),
    }
}

// ── the admin's view ───────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
struct ReportRow {
    id: String,
    kind: String,
    reason: String,
    details: Option<String>,
    created_at: String,
    resolved_at: Option<String>,
    resolution: Option<String>,
    note: Option<String>,
    /// The account whose page was reported.
    owner_id: String,
    owner_email: String,
    handle: Option<String>,
    /// The deck, for a deck report: as its owner named it, unfiltered.
    deck_id: Option<String>,
    deck_name: Option<String>,
    deck_token: Option<String>,
    deck_visibility: Option<String>,
    deck_taken_down: bool,
    /// Its owner deleted it since.
    deck_archived: bool,
}

#[derive(Serialize, sqlx::FromRow)]
struct TakedownRow {
    id: String,
    deck_id: String,
    deck_name: String,
    owner_email: String,
    handle: Option<String>,
    /// The admin who did it; null once that account is gone.
    admin_email: Option<String>,
    reason: String,
    was_visibility: String,
    created_at: String,
    restored_at: Option<String>,
}

#[derive(Serialize)]
struct Overview {
    reasons: Vec<(&'static str, &'static str)>,
    /// Reports waiting for an admin, newest first.
    open: Vec<ReportRow>,
    /// The latest ones dealt with.
    resolved: Vec<ReportRow>,
    /// Takedowns: every one still standing, newest first, then the latest restored ones.
    takedowns: Vec<TakedownRow>,
}

const REPORT_COLUMNS: &str = "r.id, r.kind, r.reason, r.details, r.created_at, r.resolved_at, r.resolution, r.note,
        r.owner_id, u.email AS owner_email, u.handle, d.id AS deck_id, d.name AS deck_name, d.share_token AS deck_token,
        d.visibility AS deck_visibility, d.taken_down_at IS NOT NULL AS deck_taken_down, COALESCE(d.archived, 0) AS deck_archived
   FROM content_reports r JOIN users u ON u.id = r.owner_id LEFT JOIN decks d ON d.id = r.deck_id";

const TAKEDOWN_COLUMNS: &str = "t.id, t.deck_id, d.name AS deck_name, u.email AS owner_email, u.handle, a.email AS admin_email, t.reason,
        t.was_visibility, t.created_at, t.restored_at
   FROM deck_takedowns t JOIN decks d ON d.id = t.deck_id JOIN users u ON u.id = t.owner_id LEFT JOIN users a ON a.id = t.admin_id";

async fn overview(pool: &SqlitePool) -> AppResult<Overview> {
    // The column list is the constant above; nothing from a request is in the SQL.
    let open = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {REPORT_COLUMNS} WHERE r.resolved_at IS NULL ORDER BY r.created_at DESC, r.id LIMIT 500")))
        .fetch_all(pool)
        .await?;
    let resolved = sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {REPORT_COLUMNS} WHERE r.resolved_at IS NOT NULL ORDER BY r.resolved_at DESC, r.id LIMIT 50")))
        .fetch_all(pool)
        .await?;
    // Every standing takedown, however many came after it: restoring one needs its row here.
    // Restored ones are history, so only the latest are listed.
    let mut takedowns: Vec<TakedownRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {TAKEDOWN_COLUMNS} WHERE t.restored_at IS NULL ORDER BY t.created_at DESC, t.id"))).fetch_all(pool).await?;
    let restored: Vec<TakedownRow> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT {TAKEDOWN_COLUMNS} WHERE t.restored_at IS NOT NULL ORDER BY t.restored_at DESC, t.id LIMIT 100"))).fetch_all(pool).await?;
    takedowns.extend(restored);
    Ok(Overview { reasons: REASONS.to_vec(), open, resolved, takedowns })
}

async fn overview_route(State(st): State<AppState>, AdminUser(_): AdminUser) -> AppResult<Json<Overview>> {
    Ok(Json(overview(&st.pool).await?))
}

#[derive(Deserialize)]
struct Dismiss {
    #[serde(default)]
    note: Option<String>,
}

/// The report needs nothing done: it leaves the open list, with who decided and an optional note.
async fn dismiss(State(st): State<AppState>, AdminUser(admin): AdminUser, Path(id): Path<String>, Json(body): Json<Dismiss>) -> AppResult<Json<Overview>> {
    let note = body.note.and_then(|n| details_text(&n));
    let done = sqlx::query("UPDATE content_reports SET resolved_at = ?, resolution = 'dismissed', resolved_by = ?, note = ? WHERE id = ? AND resolved_at IS NULL")
        .bind(now())
        .bind(&admin.id)
        .bind(&note)
        .bind(&id)
        .execute(&st.pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::NotFound("open report"));
    }
    Ok(Json(overview(&st.pool).await?))
}

#[derive(Deserialize)]
struct TakeDown {
    /// The deck: its id, its share token, or its shared page's address (`…/d/<token>`).
    deck: String,
    reason: String,
}

/// The id or token in what an admin pasted: the last part of a `/d/<token>` address, else the
/// text itself.
fn deck_key(raw: &str) -> &str {
    let raw = raw.trim();
    match raw.split_once("/d/") {
        Some((_, rest)) => rest.split(['/', '?', '#']).next().unwrap_or(rest),
        None => raw,
    }
}

/// Make a deck and its configurations private and keep them so, with who and why on record
/// against the main deck. Their open reports are resolved as taken down.
async fn take_down(State(st): State<AppState>, AdminUser(admin): AdminUser, Json(body): Json<TakeDown>) -> AppResult<Json<Overview>> {
    let reason = body.reason.trim();
    if reason.is_empty() || reason.chars().count() > MAX_REASON {
        return Err(AppError::bad("say why, in 500 characters or fewer: the deck's owner is shown it"));
    }
    let key = deck_key(&body.deck);
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    // The deck named, then its family's main deck: itself, or the deck it is a configuration of.
    let named: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT id, parent_id FROM decks WHERE id = ?1 OR share_token = ?1").bind(key).fetch_optional(&mut *tx).await?;
    let Some((named, parent)) = named else { return Err(AppError::NotFound("deck")) };
    let deck = parent.unwrap_or(named);
    let (owner, down): (String, Option<String>) = sqlx::query_as("SELECT owner_id, taken_down_at FROM decks WHERE id = ?").bind(&deck).fetch_one(&mut *tx).await?;
    if down.is_some() {
        return Err(AppError::Conflict("That deck is already taken down.".into()));
    }
    // The widest any of the family was shared, for the record.
    let visibility: String = sqlx::query_scalar(
        "SELECT visibility FROM decks WHERE id = ?1 OR parent_id = ?1 ORDER BY CASE visibility WHEN 'public' THEN 0 WHEN 'link' THEN 1 ELSE 2 END LIMIT 1",
    )
    .bind(&deck)
    .fetch_one(&mut *tx)
    .await?;
    let at = now();
    sqlx::query("UPDATE decks SET visibility = 'private', taken_down_at = ?1, updated_at = ?1 WHERE id = ?2 OR parent_id = ?2").bind(&at).bind(&deck).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO deck_takedowns (id, deck_id, owner_id, admin_id, reason, was_visibility, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(new_id())
        .bind(&deck)
        .bind(&owner)
        .bind(&admin.id)
        .bind(reason)
        .bind(&visibility)
        .bind(&at)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE content_reports SET resolved_at = ?1, resolution = 'taken_down', resolved_by = ?2, note = ?3
          WHERE resolved_at IS NULL AND deck_id IN (SELECT id FROM decks WHERE id = ?4 OR parent_id = ?4)",
    )
        .bind(&at)
        .bind(&admin.id)
        .bind(reason)
        .bind(&deck)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(deck = %deck, admin = %admin.email, "deck taken down");
    Ok(Json(overview(&st.pool).await?))
}

/// Lift a takedown: the deck and its configurations may be shared again. They stay private
/// until their owner does.
async fn restore(State(st): State<AppState>, AdminUser(admin): AdminUser, Path(id): Path<String>) -> AppResult<Json<Overview>> {
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let lifted: Option<(String, String, String)> =
        sqlx::query_as("UPDATE deck_takedowns SET restored_at = ? WHERE id = ? AND restored_at IS NULL RETURNING deck_id, owner_id, created_at")
            .bind(now())
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((deck, owner, taken_down_at)) = lifted else { return Err(AppError::NotFound("standing takedown")) };
    // Every deck this takedown locked carries its time: the family as it was, a configuration
    // made since, and one its owner has moved out on its own since. None of them is left locked
    // with nothing an admin could restore.
    sqlx::query(
        "UPDATE decks SET taken_down_at = NULL WHERE owner_id = ?1 AND taken_down_at = ?2
            AND NOT EXISTS (SELECT 1 FROM deck_takedowns t WHERE t.restored_at IS NULL AND t.deck_id IN (decks.id, decks.parent_id))",
    )
        .bind(&owner)
        .bind(&taken_down_at)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    tracing::info!(deck = %deck, admin = %admin.email, "deck takedown lifted");
    Ok(Json(overview(&st.pool).await?))
}
