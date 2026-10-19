//! The per-user deck planner (docs/planner-design.md, docs/plan-format.md).
//!
//! Every user gets the same tables and routes on their own rows. Slice 1: storage, the import of a
//! `yama-plan/1` document, and the bundle the pages read. Every query binds the caller's id, and
//! anyone else's row is a 404.

pub mod bundle;
pub mod import;
pub mod model;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Sqlite, SqlitePool};
use std::collections::{HashMap, HashSet};

/// A plan file is at most 8 MB; larger bodies get 413.
pub const IMPORT_LIMIT: usize = 8 << 20;

/// An alias is followed to a live key at most this many hops.
const ALIAS_HOPS: usize = 10;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/plan/import", post(import_route).layer(DefaultBodyLimit::max(IMPORT_LIMIT)))
        .route("/api/plan/head", get(head_route))
        .route("/api/plan/imports", get(imports_route))
        .route("/api/plan/bundle", get(bundle_route))
}

#[derive(Deserialize)]
struct ImportQuery {
    dry_run: Option<String>,
    force: Option<String>,
}

fn truthy(v: &Option<String>) -> bool {
    matches!(v.as_deref(), Some("1" | "true" | "yes"))
}

/// The upload is read as bytes, untouched: the content hash covers the exact bytes of `plan`.
async fn import_route(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Query(q): Query<ImportQuery>,
    body: Bytes,
) -> AppResult<Json<import::Report>> {
    let opts = import::Options { dry_run: truthy(&q.dry_run), force: truthy(&q.force), via: "web" };
    Ok(Json(import::import_doc(&st.pool, &user.id, &body, opts).await?))
}

#[derive(Serialize)]
struct Head {
    head_hash: Option<String>,
    git_sha: Option<String>,
    guide_version: Option<i64>,
    imported_at: Option<String>,
    revision: i64,
}

/// What Yama holds now, for `publish.py`'s ancestor check (it moves to SyncUser in slice 4).
async fn head_route(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Head>> {
    let h = import::head_info(&st.pool, &user.id).await?;
    Ok(Json(Head { head_hash: h.content_hash, git_sha: h.git_sha, guide_version: h.guide_version, imported_at: h.imported_at, revision: h.revision }))
}

#[derive(Serialize, sqlx::FromRow)]
struct ImportRow {
    id: String,
    content_hash: String,
    via: String,
    forced: bool,
    imported_at: String,
    #[sqlx(json)]
    meta: Value,
    #[sqlx(json)]
    report: Value,
}

/// The last 20 applied imports, newest first, with their reports. Documents stay on the server.
async fn imports_route(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<ImportRow>>> {
    Ok(Json(
        sqlx::query_as(
            "SELECT id, content_hash, via, forced, imported_at, meta, report FROM plan_imports
             WHERE owner_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 20",
        )
        .bind(&user.id)
        .fetch_all(&st.pool)
        .await?,
    ))
}

#[derive(Deserialize)]
struct BundleQuery {
    rev: Option<String>,
}

/// Everything the plan pages need. `rev` is the cache key the last bundle carried; when nothing
/// it depends on has changed (plan revision, card data, prices) the answer is `{unchanged: true}`.
async fn bundle_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Query(q): Query<BundleQuery>) -> AppResult<Json<Value>> {
    let rev = bundle::rev(&st.pool, &user.id).await?;
    if q.rev.as_deref() == Some(rev.as_str()) {
        return Ok(Json(serde_json::json!({ "unchanged": true, "rev": rev })));
    }
    Ok(Json(bundle::load_bundle(&st.pool, &user.id).await?))
}

/// One of the owner's plan decks by key: (id, source, status). Anyone else's key is a 404.
/// Slice 3's deck routes use it; the isolation tests cover it now.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn plan_deck(pool: &SqlitePool, owner: &str, key: &str) -> AppResult<(String, String, String)> {
    sqlx::query_as("SELECT id, source, status FROM plan_decks WHERE owner_id = ? AND key = ?")
        .bind(owner)
        .bind(key)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound("plan deck"))
}

/// Resolve card names (any face, any case) to oracle ids in one query. Unknown names are left
/// out; callers keep them by name.
pub async fn resolve_names<'c, E>(db: E, names: &[String]) -> AppResult<HashMap<String, String>>
where
    E: sqlx::Executor<'c, Database = Sqlite>,
{
    let trimmed: Vec<&str> = names.iter().map(|n| n.trim()).filter(|n| !n.is_empty()).collect();
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT j.value,
           (SELECT n.oracle_id FROM card_names n JOIN cards c ON c.oracle_id = n.oracle_id
            WHERE n.name = j.value ORDER BY IFNULL(c.layout, '') IN ('token', 'double_faced_token', 'art_series') LIMIT 1)
         FROM json_each(?) j",
    )
    .bind(serde_json::to_string(&trimmed).map_err(anyhow::Error::from)?)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().filter_map(|(name, id)| Some((name, id?))).collect())
}

/// Keys of the owner's swaps that are in the plan now (not retired, deck not archived).
pub async fn live_keys<'c, E>(db: E, owner: &str) -> AppResult<HashSet<String>>
where
    E: sqlx::Executor<'c, Database = Sqlite>,
{
    Ok(sqlx::query_scalar(
        "SELECT s.ext_key FROM plan_swaps s JOIN plan_decks d ON d.id = s.plan_deck_id AND d.owner_id = s.owner_id
         WHERE s.owner_id = ? AND s.retired_at IS NULL AND d.status != 'archived'",
    )
    .bind(owner)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect())
}

pub async fn aliases<'c, E>(db: E, owner: &str) -> AppResult<HashMap<String, String>>
where
    E: sqlx::Executor<'c, Database = Sqlite>,
{
    Ok(sqlx::query_as("SELECT old_key, new_key FROM plan_key_aliases WHERE owner_id = ?")
        .bind(owner)
        .fetch_all(db)
        .await?
        .into_iter()
        .collect())
}

/// Follow aliases from `key` to a live key, at most ten hops. `None` means the key is an orphan.
pub fn resolve_key(key: &str, live: &HashSet<String>, aliases: &HashMap<String, String>) -> Option<String> {
    let mut k = key;
    for _ in 0..=ALIAS_HOPS {
        if live.contains(k) {
            return Some(k.to_string());
        }
        k = aliases.get(k)?;
    }
    None
}

#[cfg(test)]
mod tests;
