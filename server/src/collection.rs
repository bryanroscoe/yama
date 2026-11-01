//! Collection: containers, items, offline ops, and Mythic Tools CSV import/export.
//!
//! Every change is an op with a client-generated `op_id`. The server records applied op IDs,
//! so a phone that retries a sync never double-counts. Quantity changes are deltas, which
//! merge cleanly when two devices edit the same card; other fields are last-writer-wins.
//!
//! Bulk changes the server works out itself (a Mythic Tools import in `mythic.rs`, "Add to my
//! collection" for a deck in `deck_box.rs`) are planned against the collection as it stands and
//! applied as the same ops, in one transaction.

pub mod deck_box;
pub mod mythic;

use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now};
use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use sqlx::{Sqlite, SqlitePool, Transaction};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/collection", get(list_items))
        .route("/api/collection/summary", get(summary))
        .route("/api/collection/ops", post(apply_ops))
        .route("/api/collection/export.csv", get(export_csv))
        .route("/api/containers", get(list_containers).post(create_container))
        .route("/api/containers/{id}", patch(rename_container).delete(delete_container))
        .merge(mythic::router())
        .merge(deck_box::router())
}

pub const KINDS: [&str; 4] = ["binder", "deck", "list", "box"];

// ── ops ────────────────────────────────────────────────────────────────────

/// Fields that, together with the printing and container, make two copies interchangeable.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct CopyKind {
    #[serde(default = "nm")]
    pub condition: String,
    #[serde(default = "nonfoil")]
    pub finish: String,
    #[serde(default = "en")]
    pub lang: String,
    #[serde(default)]
    pub altered: bool,
    #[serde(default)]
    pub signed: bool,
    #[serde(default)]
    pub misprint: bool,
    #[serde(default)]
    pub proxy: bool,
}

pub(crate) fn nm() -> String {
    "NM".into()
}
pub(crate) fn nonfoil() -> String {
    "nonfoil".into()
}
pub(crate) fn en() -> String {
    "en".into()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpKind {
    /// Add copies. Merges into an identical row if there is one.
    Add {
        scryfall_id: String,
        qty: i64,
        #[serde(flatten)]
        copy: CopyKind,
        container_id: Option<String>,
        purchase_price: Option<f64>,
        purchase_currency: Option<String>,
    },
    /// Change a row's quantity by `delta`. A row that reaches 0 is removed.
    Adjust { item_id: String, delta: i64 },
    /// Change fields. If the result matches another row, the two merge.
    Update {
        item_id: String,
        condition: Option<String>,
        finish: Option<String>,
        lang: Option<String>,
        #[serde(default, deserialize_with = "crate::util::double_option")]
        container_id: Option<Option<String>>,
        #[serde(default, deserialize_with = "crate::util::double_option")]
        purchase_price: Option<Option<f64>>,
        #[serde(default, deserialize_with = "crate::util::double_option")]
        note: Option<Option<String>>,
        proxy: Option<bool>,
        /// Another printing of the same card (the row was filed under the wrong one).
        #[serde(default)]
        scryfall_id: Option<String>,
        /// Change only this many of the row's copies, split off into their own row (merging into a
        /// matching one). Fewer copies left than this: the whole row changes. No row: nothing.
        #[serde(default)]
        split: Option<i64>,
    },
    Remove { item_id: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Op {
    pub op_id: String,
    pub device_id: Option<String>,
    #[serde(flatten)]
    pub op: OpKind,
}

#[derive(Serialize)]
struct OpsResult {
    applied: usize,
    skipped_duplicates: usize,
}

async fn apply_ops(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(ops): Json<Vec<Op>>,
) -> AppResult<Json<OpsResult>> {
    let mut tx = st.pool.begin().await?;
    let (mut applied, mut skipped) = (0, 0);
    for op in ops {
        if apply_op(&mut tx, &user.id, &op).await? {
            applied += 1;
        } else {
            skipped += 1;
        }
    }
    tx.commit().await?;
    Ok(Json(OpsResult { applied, skipped_duplicates: skipped }))
}

/// Apply one op. Returns false if this op was already applied.
pub async fn apply_op(tx: &mut Transaction<'_, Sqlite>, owner: &str, op: &Op) -> AppResult<bool> {
    let fresh = sqlx::query(
        "INSERT INTO applied_ops (op_id, owner_id, device_id, kind, payload, applied_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(owner_id, op_id) DO NOTHING",
    )
    .bind(&op.op_id)
    .bind(owner)
    .bind(&op.device_id)
    .bind(op_name(&op.op))
    .bind(serde_json::to_string(&op.op).map_err(anyhow::Error::from)?)
    .bind(now())
    .execute(&mut **tx)
    .await?
    .rows_affected()
        == 1;
    if !fresh {
        return Ok(false);
    }
    match &op.op {
        OpKind::Add { scryfall_id, qty, copy, container_id, purchase_price, purchase_currency } => {
            if *qty <= 0 {
                return Err(AppError::bad("add needs a positive quantity"));
            }
            check_container(tx, owner, container_id.as_deref()).await?;
            add_copies(tx, owner, scryfall_id, *qty, copy, container_id.as_deref(), *purchase_price, purchase_currency.as_deref())
                .await?;
        }
        OpKind::Adjust { item_id, delta } => {
            let item_id = &resolve_item(tx, owner, item_id).await?;
            let qty: i64 = sqlx::query_scalar("SELECT qty FROM collection_items WHERE id = ? AND owner_id = ?")
                .bind(item_id)
                .bind(owner)
                .fetch_optional(&mut **tx)
                .await?
                // Another device may have removed it already; that's fine.
                .unwrap_or(0);
            if qty == 0 {
                return Ok(true);
            }
            let next = (qty + delta).max(0);
            if next == 0 {
                sqlx::query("DELETE FROM collection_items WHERE id = ?").bind(item_id).execute(&mut **tx).await?;
            } else {
                sqlx::query("UPDATE collection_items SET qty = ?, updated_at = ? WHERE id = ?")
                    .bind(next)
                    .bind(now())
                    .bind(item_id)
                    .execute(&mut **tx)
                    .await?;
            }
        }
        OpKind::Update { item_id, condition, finish, lang, container_id, purchase_price, note, proxy, scryfall_id, split } => {
            let item_id = &resolve_item(tx, owner, item_id).await?;
            let Some(item) = load_item(tx, owner, item_id).await? else { return Ok(true) };
            if let Some(Some(c)) = container_id {
                check_container(tx, owner, Some(c)).await?;
            }
            let printing = match scryfall_id {
                Some(p) if *p != item.scryfall_id => {
                    check_same_card(tx, &item.scryfall_id, p).await?;
                    p.clone()
                }
                _ => item.scryfall_id.clone(),
            };
            let copy = CopyKind {
                condition: condition.clone().unwrap_or(item.condition.clone()),
                finish: finish.clone().unwrap_or(item.finish.clone()),
                lang: lang.clone().unwrap_or(item.lang.clone()),
                altered: item.altered,
                signed: item.signed,
                misprint: item.misprint,
                proxy: proxy.unwrap_or(item.proxy),
            };
            let container = container_id.clone().unwrap_or(item.container_id.clone());
            let price = purchase_price.unwrap_or(item.purchase_price);
            let note = note.clone().unwrap_or(item.note.clone());
            if let Some(n) = *split {
                if n <= 0 {
                    return Err(AppError::bad("split needs a positive number of copies"));
                }
                if n < item.qty {
                    sqlx::query("UPDATE collection_items SET qty = qty - ?, updated_at = ? WHERE id = ?")
                        .bind(n)
                        .bind(now())
                        .bind(item_id)
                        .execute(&mut **tx)
                        .await?;
                    let to = add_copies(tx, owner, &printing, n, &copy, container.as_deref(), price, item.purchase_currency.as_deref()).await?;
                    sqlx::query(sqlx::AssertSqlSafe(format!("UPDATE collection_items SET note = {MERGE_NOTE} WHERE id = ?2")))
                        .bind(&note)
                        .bind(&to)
                        .execute(&mut **tx)
                        .await?;
                    return Ok(true);
                }
            }
            // If the change makes this row identical to another one, merge into it and leave an
            // alias so ops still naming this row (from other devices) follow. Otherwise update in
            // place, keeping the row's id.
            let twin: Option<String> = sqlx::query_scalar(
                "SELECT id FROM collection_items WHERE owner_id=? AND scryfall_id=? AND condition=? AND finish=? AND lang=?
                 AND altered=? AND signed=? AND misprint=? AND proxy=? AND IFNULL(container_id,'') = IFNULL(?, '') AND id != ?",
            )
            .bind(owner)
            .bind(&printing)
            .bind(&copy.condition)
            .bind(&copy.finish)
            .bind(&copy.lang)
            .bind(copy.altered)
            .bind(copy.signed)
            .bind(copy.misprint)
            .bind(copy.proxy)
            .bind(&container)
            .bind(item_id)
            .fetch_optional(&mut **tx)
            .await?;
            match twin {
                Some(twin) => {
                    // The price paid comes over with its currency, when the twin has none. Both
                    // rows' notes are kept (once, if they're the same).
                    sqlx::query(sqlx::AssertSqlSafe(format!(
                        "UPDATE collection_items SET qty = qty + ?2, updated_at = ?3,
                            purchase_currency = CASE WHEN purchase_price IS NULL THEN ?4 ELSE purchase_currency END,
                            purchase_price = COALESCE(purchase_price, ?5), note = {MERGE_NOTE}
                         WHERE id = ?6"
                    )))
                        .bind(&note)
                        .bind(item.qty)
                        .bind(now())
                        .bind(&item.purchase_currency)
                        .bind(price)
                        .bind(&twin)
                        .execute(&mut **tx)
                        .await?;
                    sqlx::query("DELETE FROM collection_items WHERE id = ?").bind(item_id).execute(&mut **tx).await?;
                    sqlx::query("INSERT OR REPLACE INTO item_aliases (old_id, owner_id, new_id, created_at) VALUES (?,?,?,?)")
                        .bind(item_id)
                        .bind(owner)
                        .bind(&twin)
                        .bind(now())
                        .execute(&mut **tx)
                        .await?;
                    sqlx::query("UPDATE item_aliases SET new_id = ? WHERE new_id = ? AND owner_id = ?")
                        .bind(&twin)
                        .bind(item_id)
                        .bind(owner)
                        .execute(&mut **tx)
                        .await?;
                }
                None => {
                    sqlx::query(
                        "UPDATE collection_items SET scryfall_id=?, condition=?, finish=?, lang=?, proxy=?, container_id=?, purchase_price=?, note=?, updated_at=?
                         WHERE id = ?",
                    )
                    .bind(&printing)
                    .bind(&copy.condition)
                    .bind(&copy.finish)
                    .bind(&copy.lang)
                    .bind(copy.proxy)
                    .bind(&container)
                    .bind(price)
                    .bind(&note)
                    .bind(now())
                    .bind(item_id)
                    .execute(&mut **tx)
                    .await?;
                }
            }
        }
        OpKind::Remove { item_id } => {
            let item_id = &resolve_item(tx, owner, item_id).await?;
            sqlx::query("DELETE FROM collection_items WHERE id = ? AND owner_id = ?")
                .bind(item_id)
                .bind(owner)
                .execute(&mut **tx)
                .await?;
        }
    }
    Ok(true)
}

/// A row's note after copies with note `?1` join it: both kept, one per line (a shared note once).
const MERGE_NOTE: &str = "CASE WHEN ?1 IS NULL OR note = ?1 THEN note WHEN note IS NULL THEN ?1 ELSE note || char(10) || ?1 END";

/// A row's printing may change only to another printing of the same card that's in our card
/// data. (A row whose printing isn't in our data yet may take any known printing.)
async fn check_same_card(tx: &mut Transaction<'_, Sqlite>, from: &str, to: &str) -> AppResult<()> {
    const ORACLE: &str = "SELECT oracle_id FROM printings WHERE scryfall_id = ?";
    let Some(new) = sqlx::query_scalar::<_, String>(ORACLE).bind(to).fetch_optional(&mut **tx).await? else {
        return Err(AppError::bad("that printing isn't in our card data"));
    };
    match sqlx::query_scalar::<_, String>(ORACLE).bind(from).fetch_optional(&mut **tx).await? {
        Some(old) if old != new => Err(AppError::bad("that's a printing of a different card")),
        _ => Ok(()),
    }
}

/// Follow merge aliases to the row an old item id now lives in.
async fn resolve_item(tx: &mut Transaction<'_, Sqlite>, owner: &str, id: &str) -> AppResult<String> {
    let mut id = id.to_string();
    for _ in 0..8 {
        let next: Option<String> = sqlx::query_scalar("SELECT new_id FROM item_aliases WHERE old_id = ? AND owner_id = ?")
            .bind(&id)
            .bind(owner)
            .fetch_optional(&mut **tx)
            .await?;
        match next {
            Some(n) => id = n,
            None => break,
        }
    }
    Ok(id)
}

/// A number that only grows while `owner`'s collection changes: how many ops have been applied
/// for them. Ops the server plans itself put it in their ids, so the same plan sent twice (a
/// retry) applies once, while a plan made after any other change gets fresh ids, even when the
/// collection is back where it was before (a card taken out and the deck added again).
pub(crate) async fn op_stamp(tx: &mut Transaction<'_, Sqlite>, owner: &str) -> AppResult<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM applied_ops WHERE owner_id = ?").bind(owner).fetch_one(&mut **tx).await?)
}

/// One row of someone's collection with where it is, for the bulk changes that plan against it.
#[derive(sqlx::FromRow, Debug, Clone)]
pub(crate) struct OwnedCopy {
    pub id: String,
    pub scryfall_id: String,
    /// `None` if the printing isn't in Yama's card data.
    pub oracle_id: Option<String>,
    pub name: Option<String>,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    pub qty: i64,
    pub condition: String,
    pub finish: String,
    pub lang: String,
    pub altered: bool,
    pub signed: bool,
    pub misprint: bool,
    pub proxy: bool,
    pub container_id: Option<String>,
    pub container_kind: Option<String>,
    pub container_name: Option<String>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
}

impl OwnedCopy {
    /// Where it is, as people read it: "box: Bulk", or "unfiled".
    pub fn place(&self) -> String {
        match (&self.container_kind, &self.container_name) {
            (Some(k), Some(n)) => format!("{k}: {n}"),
            _ => "unfiled".into(),
        }
    }

    pub fn copy_kind(&self) -> CopyKind {
        CopyKind {
            condition: self.condition.clone(),
            finish: self.finish.clone(),
            lang: self.lang.clone(),
            altered: self.altered,
            signed: self.signed,
            misprint: self.misprint,
            proxy: self.proxy,
        }
    }
}

pub(crate) async fn owned_copies(tx: &mut Transaction<'_, Sqlite>, owner: &str) -> AppResult<Vec<OwnedCopy>> {
    Ok(sqlx::query_as(
        "SELECT i.id, i.scryfall_id, p.oracle_id, p.name, p.set_code, p.collector_number, i.qty, i.condition, i.finish, i.lang,
                i.altered, i.signed, i.misprint, i.proxy, i.container_id, ct.kind AS container_kind, ct.name AS container_name,
                i.purchase_price, i.purchase_currency
         FROM collection_items i
         LEFT JOIN printings p ON p.scryfall_id = i.scryfall_id
         LEFT JOIN containers ct ON ct.id = i.container_id
         WHERE i.owner_id = ? ORDER BY i.created_at, i.id",
    )
    .bind(owner)
    .fetch_all(&mut **tx)
    .await?)
}

fn op_name(op: &OpKind) -> &'static str {
    match op {
        OpKind::Add { .. } => "add",
        OpKind::Adjust { .. } => "adjust",
        OpKind::Update { .. } => "update",
        OpKind::Remove { .. } => "remove",
    }
}

async fn check_container(tx: &mut Transaction<'_, Sqlite>, owner: &str, id: Option<&str>) -> AppResult<()> {
    if let Some(id) = id {
        let found: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE id = ? AND owner_id = ?")
            .bind(id)
            .bind(owner)
            .fetch_optional(&mut **tx)
            .await?;
        found.ok_or(AppError::NotFound("container"))?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn add_copies(
    tx: &mut Transaction<'_, Sqlite>,
    owner: &str,
    scryfall_id: &str,
    qty: i64,
    copy: &CopyKind,
    container_id: Option<&str>,
    purchase_price: Option<f64>,
    purchase_currency: Option<&str>,
) -> AppResult<String> {
    let id = new_id();
    let stamp = now();
    // The unique index on the copy identity turns a duplicate into a quantity bump.
    // A merged row keeps its existing purchase price unless it had none, and the currency goes
    // with whichever price it keeps.
    sqlx::query(
        "INSERT INTO collection_items (id, owner_id, scryfall_id, qty, condition, finish, lang, altered, signed,
            misprint, proxy, container_id, purchase_price, purchase_currency, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(owner_id, scryfall_id, condition, finish, lang, altered, signed, misprint, proxy, IFNULL(container_id, ''))
         DO UPDATE SET qty = qty + excluded.qty, updated_at = excluded.updated_at,
            purchase_currency = CASE WHEN purchase_price IS NULL THEN excluded.purchase_currency ELSE purchase_currency END,
            purchase_price = COALESCE(purchase_price, excluded.purchase_price)",
    )
    .bind(&id)
    .bind(owner)
    .bind(scryfall_id)
    .bind(qty)
    .bind(&copy.condition)
    .bind(&copy.finish)
    .bind(&copy.lang)
    .bind(copy.altered)
    .bind(copy.signed)
    .bind(copy.misprint)
    .bind(copy.proxy)
    .bind(container_id)
    .bind(purchase_price)
    .bind(purchase_currency)
    .bind(&stamp)
    .bind(&stamp)
    .execute(&mut **tx)
    .await?;
    Ok(sqlx::query_scalar(
        "SELECT id FROM collection_items WHERE owner_id=? AND scryfall_id=? AND condition=? AND finish=? AND lang=?
         AND altered=? AND signed=? AND misprint=? AND proxy=? AND IFNULL(container_id,'') = IFNULL(?, '')",
    )
    .bind(owner)
    .bind(scryfall_id)
    .bind(&copy.condition)
    .bind(&copy.finish)
    .bind(&copy.lang)
    .bind(copy.altered)
    .bind(copy.signed)
    .bind(copy.misprint)
    .bind(copy.proxy)
    .bind(container_id)
    .fetch_one(&mut **tx)
    .await?)
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    scryfall_id: String,
    qty: i64,
    condition: String,
    finish: String,
    lang: String,
    altered: bool,
    signed: bool,
    misprint: bool,
    proxy: bool,
    container_id: Option<String>,
    purchase_price: Option<f64>,
    purchase_currency: Option<String>,
    note: Option<String>,
}

async fn load_item(tx: &mut Transaction<'_, Sqlite>, owner: &str, id: &str) -> AppResult<Option<ItemRow>> {
    Ok(sqlx::query_as(
        "SELECT scryfall_id, qty, condition, finish, lang, altered, signed, misprint, proxy, container_id,
            purchase_price, purchase_currency, note FROM collection_items WHERE id = ? AND owner_id = ?",
    )
    .bind(id)
    .bind(owner)
    .fetch_optional(&mut **tx)
    .await?)
}

// ── reading ────────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub struct Item {
    pub id: String,
    pub scryfall_id: String,
    pub qty: i64,
    pub condition: String,
    pub finish: String,
    pub lang: String,
    pub altered: bool,
    pub signed: bool,
    pub misprint: bool,
    pub proxy: bool,
    pub container_id: Option<String>,
    pub container_name: Option<String>,
    pub container_kind: Option<String>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub note: Option<String>,
    pub updated_at: String,
    // printing (NULL if the printing isn't in our card data yet)
    pub oracle_id: Option<String>,
    pub name: Option<String>,
    pub set_code: Option<String>,
    pub set_name: Option<String>,
    pub collector_number: Option<String>,
    pub rarity: Option<String>,
    pub image_small: Option<String>,
    pub image_normal: Option<String>,
    pub type_line: Option<String>,
    pub color_identity: Option<String>,
    /// Market price for this item's finish from the latest snapshot. `None` = no price, never 0.
    pub unit_price_usd: Option<f64>,
    pub price_date: Option<String>,
}

/// A row of the collection list: the item, plus its printing's art crop and artist for the
/// list's art thumbnails (credited wherever they show).
#[derive(Serialize, sqlx::FromRow)]
pub struct ListedItem {
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub item: Item,
    pub image_art_crop: Option<String>,
    pub artist: Option<String>,
}

const ITEM_SELECT: &str = "SELECT i.id, i.scryfall_id, i.qty, i.condition, i.finish, i.lang, i.altered, i.signed,
    i.misprint, i.proxy, i.container_id, ct.name AS container_name, ct.kind AS container_kind, i.purchase_price,
    i.purchase_currency, i.note, i.updated_at, p.oracle_id, p.name, p.set_code, p.set_name, p.collector_number,
    p.rarity, p.image_small, p.image_normal, p.image_art_crop, p.artist, c.type_line, c.color_identity,
    CASE i.finish WHEN 'foil' THEN ps.usd_foil WHEN 'etched' THEN ps.usd_etched ELSE ps.usd END AS unit_price_usd,
    ps.date AS price_date
    FROM collection_items i
    LEFT JOIN containers ct ON ct.id = i.container_id
    LEFT JOIN printings p ON p.scryfall_id = i.scryfall_id
    LEFT JOIN cards c ON c.oracle_id = p.oracle_id
    LEFT JOIN price_snapshots ps ON ps.scryfall_id = i.scryfall_id
      AND ps.date = (SELECT MAX(date) FROM price_snapshots WHERE scryfall_id = i.scryfall_id)";

#[derive(Deserialize)]
struct ListParams {
    container: Option<String>,
    q: Option<String>,
    /// "only": proxies only; "none": real copies only; anything else: both.
    proxy: Option<String>,
}

async fn list_items(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Query(p): Query<ListParams>,
) -> AppResult<Json<Vec<ListedItem>>> {
    let mut sql = format!("{ITEM_SELECT} WHERE i.owner_id = ?");
    if p.container.as_deref() == Some("none") {
        sql.push_str(" AND i.container_id IS NULL");
    } else if p.container.is_some() {
        sql.push_str(" AND i.container_id = ?");
    }
    if p.q.as_deref().is_some_and(|q| !q.trim().is_empty()) {
        sql.push_str(" AND p.name LIKE ?");
    }
    match p.proxy.as_deref() {
        Some("only") => sql.push_str(" AND i.proxy = 1"),
        Some("none") => sql.push_str(" AND i.proxy = 0"),
        _ => {}
    }
    sql.push_str(" ORDER BY p.name, p.set_code, p.collector_number");
    let mut q = sqlx::query_as::<_, ListedItem>(sqlx::AssertSqlSafe(sql)).bind(&user.id);
    if let Some(c) = p.container.as_deref().filter(|c| *c != "none") {
        q = q.bind(c);
    }
    if let Some(text) = p.q.as_deref().filter(|q| !q.trim().is_empty()) {
        q = q.bind(format!("%{}%", text.trim()));
    }
    Ok(Json(q.fetch_all(&st.pool).await?))
}

pub async fn items_for_owner(pool: &SqlitePool, owner: &str) -> AppResult<Vec<Item>> {
    Ok(sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(format!("{ITEM_SELECT} WHERE i.owner_id = ?")))
        .bind(owner)
        .fetch_all(pool)
        .await?)
}

#[derive(Serialize)]
struct Summary {
    copies: i64,
    /// Proxies among `copies`. They have no market value and aren't counted in it.
    proxies: i64,
    distinct_printings: i64,
    /// Sum over copies that have a price. Copies without one are counted separately, not as $0.
    market_value_usd: f64,
    copies_without_price: i64,
    price_date: Option<String>,
    purchase_total_usd: f64,
}

async fn summary(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Summary>> {
    let items = items_for_owner(&st.pool, &user.id).await?;
    let mut s = Summary {
        copies: 0,
        proxies: 0,
        distinct_printings: 0,
        market_value_usd: 0.0,
        copies_without_price: 0,
        price_date: None,
        purchase_total_usd: 0.0,
    };
    let mut printings = std::collections::HashSet::new();
    for i in &items {
        s.copies += i.qty;
        printings.insert(&i.scryfall_id);
        if i.proxy {
            s.proxies += i.qty;
            continue;
        }
        match i.unit_price_usd {
            Some(p) => s.market_value_usd += p * i.qty as f64,
            None => s.copies_without_price += i.qty,
        }
        if i.price_date > s.price_date {
            s.price_date = i.price_date.clone();
        }
        if i.purchase_currency.as_deref().unwrap_or("USD") == "USD" {
            s.purchase_total_usd += i.purchase_price.unwrap_or(0.0) * i.qty as f64;
        }
    }
    s.distinct_printings = printings.len() as i64;
    s.market_value_usd = (s.market_value_usd * 100.0).round() / 100.0;
    s.purchase_total_usd = (s.purchase_total_usd * 100.0).round() / 100.0;
    Ok(Json(s))
}

// ── containers ─────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
struct Container {
    id: String,
    kind: String,
    name: String,
    copies: i64,
    /// Market value of the copies that have a price; the rest are counted in `copies_without_price`.
    #[sqlx(skip)]
    market_value_usd: f64,
    #[sqlx(skip)]
    copies_without_price: i64,
    /// Art crop of the most valuable card inside, for the container's tile, and its artist.
    #[sqlx(skip)]
    art: Option<String>,
    #[sqlx(skip)]
    artist: Option<String>,
}

async fn list_containers(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Vec<Container>>> {
    let mut containers: Vec<Container> = sqlx::query_as(
        "SELECT ct.id, ct.kind, ct.name, IFNULL(SUM(i.qty), 0) AS copies FROM containers ct
         LEFT JOIN collection_items i ON i.container_id = ct.id
         WHERE ct.owner_id = ? GROUP BY ct.id ORDER BY ct.kind, ct.name",
    )
    .bind(&user.id)
    .fetch_all(&st.pool)
    .await?;
    let items = items_for_owner(&st.pool, &user.id).await?;
    for ct in &mut containers {
        let inside: Vec<&Item> = items.iter().filter(|i| i.container_id.as_deref() == Some(ct.id.as_str())).collect();
        for i in inside.iter().filter(|i| !i.proxy) {
            match i.unit_price_usd {
                Some(p) => ct.market_value_usd += p * i.qty as f64,
                None => ct.copies_without_price += i.qty,
            }
        }
        ct.market_value_usd = (ct.market_value_usd * 100.0).round() / 100.0;
        let top = inside.iter().filter(|i| i.oracle_id.is_some() && !i.proxy).max_by(|a, b| {
            a.unit_price_usd.unwrap_or(-1.0).partial_cmp(&b.unit_price_usd.unwrap_or(-1.0)).unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(top) = top {
            let row: Option<(Option<String>, Option<String>)> =
                sqlx::query_as("SELECT image_art_crop, artist FROM printings WHERE scryfall_id = ?")
                    .bind(&top.scryfall_id)
                    .fetch_optional(&st.pool)
                    .await?;
            if let Some((art, artist)) = row {
                (ct.art, ct.artist) = (art, artist);
            }
        }
    }
    Ok(Json(containers))
}

#[derive(Deserialize)]
struct NewContainer {
    kind: String,
    name: String,
}

async fn create_container(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(body): Json<NewContainer>,
) -> AppResult<Json<serde_json::Value>> {
    let id = ensure_container(&st.pool, &user.id, &body.kind, &body.name).await?;
    Ok(Json(serde_json::json!({ "id": id })))
}

pub async fn ensure_container(pool: &SqlitePool, owner: &str, kind: &str, name: &str) -> AppResult<String> {
    let kind = kind.to_lowercase();
    if !KINDS.contains(&kind.as_str()) {
        return Err(AppError::bad(format!("container kind must be one of {}", KINDS.join(", "))));
    }
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::bad("container needs a name"));
    }
    sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING")
        .bind(new_id())
        .bind(owner)
        .bind(&kind)
        .bind(name)
        .bind(now())
        .execute(pool)
        .await?;
    Ok(sqlx::query_scalar("SELECT id FROM containers WHERE owner_id = ? AND kind = ? AND name = ?")
        .bind(owner)
        .bind(&kind)
        .bind(name)
        .fetch_one(pool)
        .await?)
}

#[derive(Deserialize)]
struct RenameContainer {
    name: String,
}

async fn rename_container(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<RenameContainer>,
) -> AppResult<()> {
    let n = sqlx::query("UPDATE containers SET name = ? WHERE id = ? AND owner_id = ?")
        .bind(body.name.trim())
        .bind(&id)
        .bind(&user.id)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if n == 0 { Err(AppError::NotFound("container")) } else { Ok(()) }
}

/// Deleting a container keeps its cards; they become unfiled.
async fn delete_container(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    let mut tx = st.pool.begin().await?;
    // Unfiling can collide with an identical unfiled row, so re-add rather than update.
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM collection_items WHERE container_id = ? AND owner_id = ?")
        .bind(&id)
        .bind(&user.id)
        .fetch_all(&mut *tx)
        .await?;
    for item_id in ids {
        let op = Op {
            op_id: new_id(),
            device_id: None,
            op: OpKind::Update {
                item_id,
                condition: None,
                finish: None,
                lang: None,
                container_id: Some(None),
                purchase_price: None,
                note: None,
                proxy: None,
                scryfall_id: None,
                split: None,
            },
        };
        apply_op(&mut tx, &user.id, &op).await?;
    }
    sqlx::query("DELETE FROM containers WHERE id = ? AND owner_id = ?").bind(&id).bind(&user.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Export in Mythic Tools' column layout, so the file round-trips into Mythic Tools or back into Yama.
async fn export_csv(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<impl IntoResponse> {
    let items = items_for_owner(&st.pool, &user.id).await?;
    let mut w = csv::Writer::from_writer(Vec::new());
    w.write_record([
        "Card Name", "Set Code", "Set Name", "Collector Number", "Rarity", "Language", "Quantity", "Condition", "Finish",
        "Altered", "Signed", "Misprint", "Proxy", "Price (USD)", "Price Date", "Scryfall ID", "Container Type",
        "Container Name", "Purchase Price (USD)",
    ])
    .map_err(anyhow::Error::from)?;
    let opt = |v: &Option<String>| v.clone().unwrap_or_default();
    let money = |v: Option<f64>| v.map(|p| format!("{p:.2}")).unwrap_or_default();
    for i in items {
        w.write_record([
            opt(&i.name),
            opt(&i.set_code),
            opt(&i.set_name),
            opt(&i.collector_number),
            opt(&i.rarity),
            i.lang.clone(),
            i.qty.to_string(),
            i.condition.clone(),
            i.finish.clone(),
            i.altered.to_string(),
            i.signed.to_string(),
            i.misprint.to_string(),
            i.proxy.to_string(),
            money(i.unit_price_usd),
            opt(&i.price_date),
            i.scryfall_id.clone(),
            opt(&i.container_kind),
            opt(&i.container_name),
            money(if i.purchase_currency.as_deref() == Some("USD") { i.purchase_price } else { None }),
        ])
        .map_err(anyhow::Error::from)?;
    }
    let body = w.into_inner().map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (header::CONTENT_DISPOSITION, "attachment; filename=\"yama-collection.csv\""),
        ],
        body,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn user(pool: &SqlitePool) -> String {
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u1','a@b.c','A','now')")
            .execute(pool)
            .await
            .unwrap();
        "u1".into()
    }

    #[tokio::test]
    async fn ops_merge_and_dedupe() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        let add = |op_id: &str, qty| Op {
            op_id: op_id.into(),
            device_id: None,
            op: OpKind::Add {
                scryfall_id: "p1".into(),
                qty,
                copy: CopyKind { condition: nm(), finish: nonfoil(), lang: en(), ..Default::default() },
                container_id: None,
                purchase_price: None,
                purchase_currency: None,
            },
        };
        let mut tx = pool.begin().await.unwrap();
        assert!(apply_op(&mut tx, &owner, &add("a", 1)).await.unwrap());
        assert!(apply_op(&mut tx, &owner, &add("b", 2)).await.unwrap());
        assert!(!apply_op(&mut tx, &owner, &add("b", 2)).await.unwrap()); // retried sync
        tx.commit().await.unwrap();
        let (id, qty): (String, i64) = sqlx::query_as("SELECT id, qty FROM collection_items").fetch_one(&pool).await.unwrap();
        assert_eq!(qty, 3);

        // Update to foil, then add a foil: the rows merge.
        let mut tx = pool.begin().await.unwrap();
        let up = Op {
            op_id: "c".into(),
            device_id: None,
            op: OpKind::Update {
                item_id: id,
                condition: None,
                finish: Some("foil".into()),
                lang: None,
                container_id: None,
                purchase_price: None,
                note: None,
                proxy: None,
                scryfall_id: None,
                split: None,
            },
        };
        apply_op(&mut tx, &owner, &up).await.unwrap();
        let mut foil = add("d", 1);
        if let OpKind::Add { copy, .. } = &mut foil.op {
            copy.finish = "foil".into();
        }
        apply_op(&mut tx, &owner, &foil).await.unwrap();
        tx.commit().await.unwrap();
        let rows: Vec<(String, i64)> = sqlx::query_as("SELECT finish, qty FROM collection_items").fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![("foil".into(), 4)]);
    }

    #[test]
    fn null_clears_and_absent_leaves_alone() {
        let clear: Op = serde_json::from_str(r#"{"op_id":"a","kind":"update","item_id":"i","container_id":null}"#).unwrap();
        let keep: Op = serde_json::from_str(r#"{"op_id":"b","kind":"update","item_id":"i","condition":"LP"}"#).unwrap();
        let OpKind::Update { container_id, .. } = clear.op else { panic!() };
        assert_eq!(container_id, Some(None));
        let OpKind::Update { container_id, condition, .. } = keep.op else { panic!() };
        assert_eq!(container_id, None);
        assert_eq!(condition.as_deref(), Some("LP"));
    }

    #[tokio::test]
    async fn ops_on_a_merged_row_follow_it() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        let add = |op_id: &str, finish: &str| Op {
            op_id: op_id.into(),
            device_id: None,
            op: OpKind::Add {
                scryfall_id: "p1".into(),
                qty: 1,
                copy: CopyKind { condition: nm(), finish: finish.into(), lang: en(), ..Default::default() },
                container_id: None,
                purchase_price: None,
                purchase_currency: None,
            },
        };
        let mut tx = pool.begin().await.unwrap();
        apply_op(&mut tx, &owner, &add("a", "nonfoil")).await.unwrap();
        apply_op(&mut tx, &owner, &add("b", "foil")).await.unwrap();
        tx.commit().await.unwrap();
        let nonfoil: String = sqlx::query_scalar("SELECT id FROM collection_items WHERE finish='nonfoil'").fetch_one(&pool).await.unwrap();

        // Device A marks the nonfoil copy as foil: it merges into the foil row.
        let mut tx = pool.begin().await.unwrap();
        let update = Op {
            op_id: "c".into(),
            device_id: None,
            op: OpKind::Update { item_id: nonfoil.clone(), condition: None, finish: Some("foil".into()), lang: None, container_id: None, purchase_price: None, note: None, proxy: None, scryfall_id: None, split: None },
        };
        apply_op(&mut tx, &owner, &update).await.unwrap();
        // Device B, offline before that, adds two to the old row id.
        apply_op(&mut tx, &owner, &Op { op_id: "d".into(), device_id: None, op: OpKind::Adjust { item_id: nonfoil, delta: 2 } }).await.unwrap();
        tx.commit().await.unwrap();
        let rows: Vec<(String, i64)> = sqlx::query_as("SELECT finish, qty FROM collection_items").fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![("foil".into(), 4)]);
    }

    #[tokio::test]
    async fn update_changes_the_printing_of_the_same_card_only() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        for (id, oracle, set) in [("ltr", "doom", "ltr"), ("ltr-x", "doom", "ltc"), ("bolt", "bolt", "m10")] {
            sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES (?,?,'Card',?,'Set','1','en','now')")
                .bind(id)
                .bind(oracle)
                .bind(set)
                .execute(&pool)
                .await
                .unwrap();
        }
        let add = |op_id: &str, scryfall_id: &str, qty| Op {
            op_id: op_id.into(),
            device_id: None,
            op: OpKind::Add {
                scryfall_id: scryfall_id.into(),
                qty,
                copy: CopyKind { condition: nm(), finish: nonfoil(), lang: en(), ..Default::default() },
                container_id: None,
                purchase_price: None,
                purchase_currency: None,
            },
        };
        let reprint = |op_id: &str, item_id: &str, to: &str| Op {
            op_id: op_id.into(),
            device_id: None,
            op: OpKind::Update {
                item_id: item_id.into(),
                condition: None,
                finish: None,
                lang: None,
                container_id: None,
                purchase_price: None,
                note: None,
                proxy: None,
                scryfall_id: Some(to.into()),
                split: None,
            },
        };
        let mut tx = pool.begin().await.unwrap();
        apply_op(&mut tx, &owner, &add("a", "ltr", 2)).await.unwrap();
        tx.commit().await.unwrap();
        let id: String = sqlx::query_scalar("SELECT id FROM collection_items").fetch_one(&pool).await.unwrap();

        // Another card's printing, or one we don't know, is refused.
        for (op_id, to) in [("b", "bolt"), ("c", "nope")] {
            let mut tx = pool.begin().await.unwrap();
            assert!(apply_op(&mut tx, &owner, &reprint(op_id, &id, to)).await.is_err());
        }

        // The right card: the row keeps its id and copies.
        let mut tx = pool.begin().await.unwrap();
        apply_op(&mut tx, &owner, &reprint("d", &id, "ltr-x")).await.unwrap();
        tx.commit().await.unwrap();
        let rows: Vec<(String, String, i64)> = sqlx::query_as("SELECT id, scryfall_id, qty FROM collection_items").fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![(id.clone(), "ltr-x".into(), 2)]);

        // Back again, onto a row that already holds that printing: they merge.
        let mut tx = pool.begin().await.unwrap();
        apply_op(&mut tx, &owner, &add("e", "ltr", 1)).await.unwrap();
        // Both rows' notes survive the merge.
        sqlx::query("UPDATE collection_items SET note = CASE scryfall_id WHEN 'ltr' THEN 'mine' ELSE 'from a trade' END")
            .execute(&mut *tx)
            .await
            .unwrap();
        apply_op(&mut tx, &owner, &reprint("f", &id, "ltr")).await.unwrap();
        tx.commit().await.unwrap();
        let rows: Vec<(String, i64, Option<String>)> = sqlx::query_as("SELECT scryfall_id, qty, note FROM collection_items").fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![("ltr".into(), 3, Some("mine\nfrom a trade".into()))]);
    }

    #[tokio::test]
    async fn split_moves_some_copies_and_never_more_than_are_there() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        for id in ["ltr", "ltr-x"] {
            sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES (?,'doom','Card','ltr','Set','1','en','now')")
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }
        let mut tx = pool.begin().await.unwrap();
        let add = Op {
            op_id: "a".into(),
            device_id: None,
            op: OpKind::Add {
                scryfall_id: "ltr".into(),
                qty: 3,
                copy: CopyKind { condition: nm(), finish: nonfoil(), lang: en(), ..Default::default() },
                container_id: None,
                purchase_price: Some(4.0),
                purchase_currency: Some("EUR".into()),
            },
        };
        apply_op(&mut tx, &owner, &add).await.unwrap();
        tx.commit().await.unwrap();
        let id: String = sqlx::query_scalar("SELECT id FROM collection_items").fetch_one(&pool).await.unwrap();
        let split = |op_id: &str, n| Op {
            op_id: op_id.into(),
            device_id: None,
            op: OpKind::Update {
                item_id: id.clone(),
                condition: None,
                finish: None,
                lang: None,
                container_id: None,
                purchase_price: None,
                note: None,
                proxy: None,
                scryfall_id: Some("ltr-x".into()),
                split: Some(n),
            },
        };
        async fn rows(pool: &SqlitePool) -> Vec<(String, i64, Option<f64>, Option<String>)> {
            sqlx::query_as("SELECT scryfall_id, qty, purchase_price, purchase_currency FROM collection_items ORDER BY scryfall_id")
                .fetch_all(pool)
                .await
                .unwrap()
        }

        // A twin with a price but no currency keeps both as they were after a merge.
        sqlx::query("INSERT INTO collection_items (id, owner_id, scryfall_id, qty, condition, finish, lang, altered, signed, misprint, proxy, purchase_price, created_at, updated_at) VALUES ('t','u1','ltr-x',1,'NM','nonfoil','en',0,0,0,0,5.0,'now','now')")
            .execute(&pool)
            .await
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        apply_op(&mut tx, &owner, &split("t1", 1)).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(rows(&pool).await, vec![("ltr".into(), 2, Some(4.0), Some("EUR".into())), ("ltr-x".into(), 2, Some(5.0), None)]);
        sqlx::query("DELETE FROM collection_items WHERE id = 't'").execute(&pool).await.unwrap();
        sqlx::query("UPDATE collection_items SET qty = 3").execute(&pool).await.unwrap();

        // One copy moves, with its price, currency and note.
        sqlx::query("UPDATE collection_items SET note = 'signed by a friend'").execute(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        apply_op(&mut tx, &owner, &split("b", 1)).await.unwrap();
        tx.commit().await.unwrap();
        let eur = Some("EUR".to_string());
        assert_eq!(rows(&pool).await, vec![("ltr".into(), 2, Some(4.0), eur.clone()), ("ltr-x".into(), 1, Some(4.0), eur.clone())]);
        let notes: Vec<Option<String>> = sqlx::query_scalar("SELECT note FROM collection_items ORDER BY scryfall_id").fetch_all(&pool).await.unwrap();
        assert_eq!(notes, vec![Some("signed by a friend".into()); 2]);

        // The rest go as a whole row (merging), then a split of a row that's gone adds nothing.
        let mut tx = pool.begin().await.unwrap();
        apply_op(&mut tx, &owner, &split("c", 5)).await.unwrap();
        tx.commit().await.unwrap();
        assert_eq!(rows(&pool).await, vec![("ltr-x".into(), 3, Some(4.0), eur.clone())]);
        sqlx::query("DELETE FROM collection_items").execute(&pool).await.unwrap();
        sqlx::query("DELETE FROM item_aliases").execute(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        apply_op(&mut tx, &owner, &split("d", 1)).await.unwrap();
        tx.commit().await.unwrap();
        assert!(rows(&pool).await.is_empty());
    }
}
