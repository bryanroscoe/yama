//! Collection: containers, items, offline ops, imports and the CSV export.
//!
//! Every change is an op with a client-generated `op_id`. The server records applied op IDs,
//! so a phone that retries a sync never double-counts. Quantity changes are deltas, which
//! merge cleanly when two devices edit the same card; other fields are last-writer-wins.
//!
//! Bulk changes the server works out itself (an import of another app's export or a pasted list
//! in `import.rs`, a Mythic Tools import in `mythic.rs`, "Add to my collection" for a deck in
//! `deck_box.rs`) are planned against the collection as it stands and
//! applied as the same ops, in one transaction.

pub mod deck_box;
pub mod import;
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
        .merge(import::router())
        .merge(deck_box::router())
}

pub const KINDS: [&str; 4] = ["binder", "deck", "list", "box"];
/// What a copy's condition, finish and language may be in an op a client sends. The language
/// codes are Scryfall's.
pub const CONDITIONS: [&str; 5] = ["NM", "LP", "MP", "HP", "DMG"];
pub const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];
pub const LANGS: [&str; 18] = ["en", "es", "fr", "de", "it", "pt", "ja", "ko", "ru", "zhs", "zht", "he", "la", "grc", "ar", "sa", "ph", "qya"];
/// Ops in one request. The pages send a handful; a scanning session sends them as it goes.
pub const MAX_OPS: usize = 500;
/// Copies one op may add, take or split off.
pub const MAX_OP_QTY: i64 = 10_000;
/// A copy's note, in characters.
pub const NOTE_MAX: usize = 1_000;
/// A container's name, in characters, and how many containers one account may make by hand.
pub const CONTAINER_NAME_MAX: usize = 80;
pub const CONTAINERS_MAX: i64 = 500;

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

/// The longest id an op may name (a Scryfall id or one of Yama's own, both UUIDs).
const MAX_ID: usize = 64;

/// An op as a client sent it, checked before anything is written. `apply_op` is also called by
/// Yama's own code (the Mythic Tools import, deck boxes, the MCP's staged changes), which builds
/// its ops from values it has read or checked itself; a request can say anything. So the values
/// a shared collection page and its CSV print (condition, finish, language) must be ones Yama
/// knows, and counts, prices, notes and ids are bounded (every op's JSON is kept in
/// `applied_ops`, whether or not it found a row to change).
///
/// Returns a language to look up in card data, when the op names one that is shaped like a
/// code but isn't in `LANGS`: "change printing" sends the printing's own language, and Scryfall
/// may add one before this list hears of it (`known_lang`).
fn check_client_op(op: &Op) -> AppResult<Option<&str>> {
    fn one_of(what: &str, value: &str, allowed: &[&str]) -> AppResult<()> {
        if allowed.contains(&value) { Ok(()) } else { Err(AppError::bad(format!("{what} must be one of {}", allowed.join(", ")))) }
    }
    /// A language in the list, or (returned) one shaped like a code, to be looked up.
    fn lang(value: &str) -> AppResult<Option<&str>> {
        if LANGS.contains(&value) {
            Ok(None)
        } else if (2..=3).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_lowercase()) {
            Ok(Some(value))
        } else {
            Err(unknown_lang())
        }
    }
    fn id(value: &str) -> AppResult<()> {
        if value.is_empty() || value.len() > MAX_ID { Err(AppError::bad("that isn't a card or copy id")) } else { Ok(()) }
    }
    fn price(p: Option<f64>) -> AppResult<()> {
        if p.is_some_and(|p| !p.is_finite() || !(0.0..=10_000_000.0).contains(&p)) {
            return Err(AppError::bad("a purchase price must be a number from 0 up"));
        }
        Ok(())
    }
    if op.op_id.trim().is_empty() || op.op_id.len() > 100 || op.device_id.as_deref().is_some_and(|d| d.len() > 100) {
        return Err(AppError::bad("each op needs an op_id of at most 100 characters"));
    }
    let mut to_look_up = None;
    match &op.op {
        OpKind::Add { scryfall_id, qty, copy, purchase_price, purchase_currency, container_id } => {
            id(scryfall_id)?;
            if let Some(c) = container_id {
                id(c)?;
            }
            if !(1..=MAX_OP_QTY).contains(qty) {
                return Err(AppError::bad(format!("add needs a quantity from 1 to {MAX_OP_QTY}")));
            }
            one_of("condition", &copy.condition, &CONDITIONS)?;
            one_of("finish", &copy.finish, &FINISHES)?;
            to_look_up = lang(&copy.lang)?;
            price(*purchase_price)?;
            if purchase_currency.as_deref().is_some_and(|c| c.len() != 3 || !c.bytes().all(|b| b.is_ascii_uppercase())) {
                return Err(AppError::bad("purchase_currency must be a three-letter code such as USD"));
            }
        }
        OpKind::Adjust { item_id, delta } => {
            id(item_id)?;
            if !(-MAX_OP_QTY..=MAX_OP_QTY).contains(delta) {
                return Err(AppError::bad(format!("adjust changes at most {MAX_OP_QTY} copies at a time")));
            }
        }
        OpKind::Update { item_id, condition, finish, lang: new_lang, container_id, purchase_price, note, scryfall_id, split, .. } => {
            id(item_id)?;
            if let Some(p) = scryfall_id {
                id(p)?;
            }
            if let Some(Some(c)) = container_id {
                id(c)?;
            }
            if let Some(c) = condition {
                one_of("condition", c, &CONDITIONS)?;
            }
            if let Some(f) = finish {
                one_of("finish", f, &FINISHES)?;
            }
            if let Some(l) = new_lang {
                to_look_up = lang(l)?;
            }
            price(purchase_price.flatten())?;
            if note.as_ref().is_some_and(|n| n.as_deref().is_some_and(|n| n.chars().count() > NOTE_MAX)) {
                return Err(AppError::bad(format!("a note can have at most {NOTE_MAX} characters")));
            }
            if split.is_some_and(|n| n > MAX_OP_QTY) {
                return Err(AppError::bad(format!("split moves at most {MAX_OP_QTY} copies at a time")));
            }
        }
        OpKind::Remove { item_id } => id(item_id)?,
    }
    Ok(to_look_up)
}

fn unknown_lang() -> AppError {
    AppError::bad(format!("lang must be one of {}", LANGS.join(", ")))
}

/// Whether card data has a printing in this language (for a code `LANGS` doesn't list).
async fn known_lang(pool: &SqlitePool, lang: &str) -> AppResult<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM printings WHERE lang = ?)").bind(lang).fetch_one(pool).await?)
}

async fn apply_ops(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(ops): Json<Vec<Op>>,
) -> AppResult<Json<OpsResult>> {
    if ops.len() > MAX_OPS {
        return Err(AppError::bad(format!("send at most {MAX_OPS} changes at a time")));
    }
    let mut looked_up: Vec<&str> = Vec::new();
    for op in &ops {
        if let Some(lang) = check_client_op(op)?
            && !looked_up.contains(&lang)
        {
            looked_up.push(lang);
        }
    }
    st.limits.collection_writes.check_user(&user)?;
    for lang in looked_up {
        if !known_lang(&st.pool, lang).await? {
            return Err(unknown_lang());
        }
    }
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
            if finish.as_deref().is_some_and(|f| !matches!(f, "nonfoil" | "foil" | "etched")) {
                return Err(AppError::bad("finish must be nonfoil, foil or etched"));
            }
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
    LEFT JOIN price_latest ps ON ps.scryfall_id = i.scryfall_id";

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

/// How many real copies and proxies of each card (by oracle id) an owner has, counted in SQL
/// rather than by loading every item.
pub async fn owned_by_oracle(pool: &SqlitePool, owner: &str) -> AppResult<std::collections::HashMap<String, (i64, i64)>> {
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT p.oracle_id, SUM(CASE WHEN i.proxy THEN 0 ELSE i.qty END), SUM(CASE WHEN i.proxy THEN i.qty ELSE 0 END)
           FROM collection_items i JOIN printings p ON p.scryfall_id = i.scryfall_id
          WHERE i.owner_id = ? GROUP BY p.oracle_id",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(oracle, real, proxies)| (oracle, (real, proxies))).collect())
}

/// An owner's copies of just these cards (by oracle id), for a page about one deck, rather than
/// the whole collection.
pub async fn items_for_cards(pool: &SqlitePool, owner: &str, oracle_ids: &[&str]) -> AppResult<Vec<Item>> {
    if oracle_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(format!(
        "{ITEM_SELECT} WHERE i.owner_id = ? AND p.oracle_id IN (SELECT value FROM json_each(?))"
    )))
    .bind(owner)
    .bind(serde_json::to_string(oracle_ids).map_err(anyhow::Error::from)?)
    .fetch_all(pool)
    .await?)
}

pub async fn items_for_owner(pool: &SqlitePool, owner: &str) -> AppResult<Vec<Item>> {
    Ok(sqlx::query_as::<_, Item>(sqlx::AssertSqlSafe(format!("{ITEM_SELECT} WHERE i.owner_id = ?")))
        .bind(owner)
        .fetch_all(pool)
        .await?)
}

#[derive(Serialize)]
pub(crate) struct Summary {
    copies: i64,
    /// Proxies among `copies`. They have no market value and aren't counted in it.
    proxies: i64,
    distinct_printings: i64,
    /// Sum over copies that have a price. Copies without one are counted separately, not as $0.
    market_value_usd: f64,
    copies_without_price: i64,
    price_date: Option<String>,
    /// What was paid in US dollars, over the real copies that have a purchase price in dollars.
    /// The two counts below say which copies it leaves out; neither is counted as $0.
    purchase_total_usd: f64,
    /// Real copies with no purchase price recorded.
    copies_without_purchase_price: i64,
    /// Real copies whose purchase price is in another currency, so it isn't added in.
    copies_paid_in_other_currency: i64,
}

async fn summary(State(st): State<AppState>, CurrentUser(user): CurrentUser) -> AppResult<Json<Summary>> {
    Ok(Json(summary_for(&st.pool, &user.id).await?))
}

/// The Collection page's totals, shared with the MCP's `collection_summary`.
pub(crate) async fn summary_for(pool: &SqlitePool, owner: &str) -> AppResult<Summary> {
    let items = items_for_owner(pool, owner).await?;
    let mut s = Summary {
        copies: 0,
        proxies: 0,
        distinct_printings: 0,
        market_value_usd: 0.0,
        copies_without_price: 0,
        price_date: None,
        purchase_total_usd: 0.0,
        copies_without_purchase_price: 0,
        copies_paid_in_other_currency: 0,
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
        // A missing purchase price is unknown, never $0; another currency isn't dollars.
        match (i.purchase_price, i.purchase_currency.as_deref().unwrap_or("USD")) {
            (None, _) => s.copies_without_purchase_price += i.qty,
            (Some(p), "USD") => s.purchase_total_usd += p * i.qty as f64,
            (Some(_), _) => s.copies_paid_in_other_currency += i.qty,
        }
    }
    s.distinct_printings = printings.len() as i64;
    s.market_value_usd = (s.market_value_usd * 100.0).round() / 100.0;
    s.purchase_total_usd = (s.purchase_total_usd * 100.0).round() / 100.0;
    Ok(s)
}

// ── containers ─────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
pub(crate) struct Container {
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
    Ok(Json(containers_for(&st.pool, &user.id).await?))
}

/// The owner's binders, deck boxes and lists with copies and market value, shared with the MCP.
pub(crate) async fn containers_for(pool: &SqlitePool, owner: &str) -> AppResult<Vec<Container>> {
    let mut containers: Vec<Container> = sqlx::query_as(
        "SELECT ct.id, ct.kind, ct.name, IFNULL(SUM(i.qty), 0) AS copies FROM containers ct
         LEFT JOIN collection_items i ON i.container_id = ct.id
         WHERE ct.owner_id = ? GROUP BY ct.id ORDER BY ct.kind, ct.name",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    // Every filed item once, with its printing's art, grouped by box.
    let items: Vec<ListedItem> = sqlx::query_as(sqlx::AssertSqlSafe(format!("{ITEM_SELECT} WHERE i.owner_id = ? AND i.container_id IS NOT NULL")))
        .bind(owner)
        .fetch_all(pool)
        .await?;
    let mut by_container: std::collections::HashMap<&str, Vec<&ListedItem>> = std::collections::HashMap::new();
    for i in &items {
        if let Some(c) = i.item.container_id.as_deref() {
            by_container.entry(c).or_default().push(i);
        }
    }
    for ct in &mut containers {
        let inside: Vec<&ListedItem> = by_container.remove(ct.id.as_str()).unwrap_or_default();
        for i in inside.iter().map(|i| &i.item).filter(|i| !i.proxy) {
            match i.unit_price_usd {
                Some(p) => ct.market_value_usd += p * i.qty as f64,
                None => ct.copies_without_price += i.qty,
            }
        }
        ct.market_value_usd = (ct.market_value_usd * 100.0).round() / 100.0;
        let top = inside.iter().filter(|i| i.item.oracle_id.is_some() && !i.item.proxy).max_by(|a, b| {
            a.item.unit_price_usd.unwrap_or(-1.0).partial_cmp(&b.item.unit_price_usd.unwrap_or(-1.0)).unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(top) = top {
            (ct.art, ct.artist) = (top.image_art_crop.clone(), top.artist.clone());
        }
    }
    Ok(containers)
}

#[derive(Deserialize)]
struct NewContainer {
    kind: String,
    name: String,
}

/// A container name as typed: trimmed, not blank, no line breaks or control characters, at most
/// `CONTAINER_NAME_MAX` characters.
pub(crate) fn container_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::bad("container needs a name"));
    }
    if name.chars().any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}')) {
        return Err(AppError::bad("a container's name can't hold line breaks or control characters"));
    }
    if name.chars().count() > CONTAINER_NAME_MAX {
        return Err(AppError::bad(format!("a container's name can have at most {CONTAINER_NAME_MAX} characters")));
    }
    Ok(name.to_string())
}

async fn create_container(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(body): Json<NewContainer>,
) -> AppResult<Json<serde_json::Value>> {
    let name = container_name(&body.name)?;
    let kind = body.kind.to_lowercase();
    if !KINDS.contains(&kind.as_str()) {
        return Err(AppError::bad(format!("container kind must be one of {}", KINDS.join(", "))));
    }
    st.limits.collection_writes.check_user(&user)?;
    let id = insert_container(&st.pool, &user.id, &kind, &name).await?;
    Ok(Json(serde_json::json!({ "id": id })))
}

/// Make a container of a checked kind and name, or answer with the one that is already there.
/// Shared with the MCP's `create_container`.
pub(crate) async fn insert_container(pool: &SqlitePool, owner: &str, kind: &str, name: &str) -> AppResult<String> {
    // Immediate, so the count and the insert are one step: two requests arriving together
    // can't both find room for the last one. Asking for a container that is already there
    // answers with it, as before, however many there are.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let existing: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE owner_id = ? AND kind = ? AND name = ?")
        .bind(owner)
        .bind(kind)
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?;
    let id = match existing {
        Some(id) => id,
        None => {
            let have: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers WHERE owner_id = ?").bind(owner).fetch_one(&mut *tx).await?;
            if have >= CONTAINERS_MAX {
                return Err(AppError::Conflict(format!("You already have {CONTAINERS_MAX} binders, boxes and lists. Delete one you no longer use first.")));
            }
            let id = new_id();
            sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?,?,?,?,?)")
                .bind(&id)
                .bind(owner)
                .bind(kind)
                .bind(name)
                .bind(now())
                .execute(&mut *tx)
                .await?;
            id
        }
    };
    tx.commit().await?;
    Ok(id)
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
    let name = container_name(&body.name)?;
    st.limits.collection_writes.check_user(&user)?;
    // Immediate, so the name can't be taken between the check and the rename. (Names are unique
    // per owner and kind; without the check a clash was a database error, a 500.)
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    let kind: String = sqlx::query_scalar("SELECT kind FROM containers WHERE id = ? AND owner_id = ?")
        .bind(&id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(AppError::NotFound("container"))?;
    let taken: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE owner_id = ? AND kind = ? AND name = ? AND id != ?")
        .bind(&user.id)
        .bind(&kind)
        .bind(&name)
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?;
    if taken.is_some() {
        return Err(AppError::Conflict(format!("You already have a {kind} called {name}.")));
    }
    sqlx::query("UPDATE containers SET name = ? WHERE id = ? AND owner_id = ?").bind(&name).bind(&id).bind(&user.id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// Deleting a container keeps its cards; they become unfiled. A container that isn't the
/// caller's (someone else's, already deleted, never there) is a 404 and changes nothing.
async fn delete_container(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(id): Path<String>) -> AppResult<()> {
    st.limits.collection_writes.check_user(&user)?;
    if delete_container_for_owner(&st.pool, &user.id, &id).await? { Ok(()) } else { Err(AppError::NotFound("container")) }
}

/// Returns whether `owner` had this container (false: nothing was there to delete).
async fn delete_container_for_owner(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<bool> {
    // Immediate: it reads the container's cards and then rewrites them.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mine: Option<String> = sqlx::query_scalar("SELECT id FROM containers WHERE id = ? AND owner_id = ?")
        .bind(id)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await?;
    if mine.is_none() {
        return Ok(false);
    }
    // Unfiling can collide with an identical unfiled row, so re-add rather than update.
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM collection_items WHERE container_id = ? AND owner_id = ?")
        .bind(id)
        .bind(owner)
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
        apply_op(&mut tx, owner, &op).await?;
    }
    sqlx::query("UPDATE decks SET container_id = NULL WHERE container_id = ? AND owner_id = ?")
        .bind(id).bind(owner).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM containers WHERE id = ? AND owner_id = ?").bind(id).bind(owner).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
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

    #[tokio::test]
    async fn deleting_a_container_keeps_cards_and_decks_and_is_owner_scoped() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        sqlx::query("INSERT INTO users (id, email, display_name, created_at) VALUES ('u2','other@example.com','Other','now')")
            .execute(&pool).await.unwrap();
        let box_id = ensure_container(&pool, &owner, "box", "Reality lab").await.unwrap();
        sqlx::query("INSERT INTO decks (id, owner_id, name, container_id, created_at, updated_at) VALUES ('d1', ?, 'Saved deck', ?, 'now', 'now')")
            .bind(&owner).bind(&box_id).execute(&pool).await.unwrap();
        for (op_id, qty, container_id) in [("loose", 2, None), ("boxed", 3, Some(box_id.clone()))] {
            let mut tx = pool.begin().await.unwrap();
            apply_op(&mut tx, &owner, &Op {
                op_id: op_id.into(), device_id: None,
                op: OpKind::Add {
                    scryfall_id: "p1".into(), qty,
                    copy: CopyKind { condition: nm(), finish: nonfoil(), lang: en(), ..Default::default() },
                    container_id, purchase_price: None, purchase_currency: None,
                },
            }).await.unwrap();
            tx.commit().await.unwrap();
        }
        assert!(!delete_container_for_owner(&pool, "u2", &box_id).await.unwrap(), "someone else's box");
        let linked: Option<String> = sqlx::query_scalar("SELECT container_id FROM decks WHERE id = 'd1'").fetch_one(&pool).await.unwrap();
        assert_eq!(linked.as_deref(), Some(box_id.as_str()));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers WHERE id = ?").bind(&box_id).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 1);

        assert!(delete_container_for_owner(&pool, &owner, &box_id).await.unwrap());
        // A retry after a lost response changes nothing more (the route answers 404, which the
        // page reads as already deleted).
        assert!(!delete_container_for_owner(&pool, &owner, &box_id).await.unwrap());
        let rows: Vec<(i64, Option<String>)> = sqlx::query_as("SELECT qty, container_id FROM collection_items WHERE owner_id = ?")
            .bind(&owner).fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![(5, None)]);
        let linked: Option<String> = sqlx::query_scalar("SELECT container_id FROM decks WHERE id = 'd1'").fetch_one(&pool).await.unwrap();
        assert_eq!(linked, None); // the saved deck survives without a dangling box
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers WHERE id = ?").bind(&box_id).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
        let empty = ensure_container(&pool, &owner, "box", "Empty").await.unwrap();
        assert!(delete_container_for_owner(&pool, &owner, &empty).await.unwrap());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers WHERE id = ?").bind(empty).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
    }

    /// A printing Yama knows, priced or not, for tests through the routes.
    async fn printing(pool: &SqlitePool, id: &str, name: &str) {
        sqlx::query("INSERT OR IGNORE INTO cards (oracle_id, name, type_line, color_identity, legalities, updated_at) VALUES (?, ?, 'Artifact', '', '{}', 'now')")
            .bind(format!("o-{id}")).bind(name).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES (?, ?, ?, 'tst', 'Test Set', ?, 'en', 'now')")
            .bind(id).bind(format!("o-{id}")).bind(name).bind(id).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn client_ops_take_only_conditions_finishes_and_languages_yama_knows() {
        use crate::testutil::{app, send, user};
        use axum::http::{Method, StatusCode};
        use serde_json::json;
        let (app, pool) = app().await;
        let (_, token) = user(&pool, "collector@example.com").await;
        printing(&pool, "p1", "Sol Ring").await;
        let ops = |body: serde_json::Value| send(&app, Method::POST, "/api/collection/ops", Some(&token), Some(body));
        let add = |op_id: &str, extra: serde_json::Value| {
            let mut op = json!({ "op_id": op_id, "kind": "add", "scryfall_id": "p1", "qty": 1 });
            op.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            json!([op])
        };

        // Refused before anything is written, so the op id isn't used up either.
        let bad = [
            json!({ "condition": "=HYPERLINK(\"https://evil.example\")" }),
            json!({ "condition": "nm" }),
            json!({ "finish": "shiny" }),
            json!({ "lang": "@SUM(1+1)" }),
            json!({ "lang": "english" }),
            json!({ "lang": "xx" }),
            json!({ "scryfall_id": "p".repeat(MAX_ID + 1) }),
            json!({ "scryfall_id": "" }),
            json!({ "container_id": "c".repeat(MAX_ID + 1) }),
            json!({ "qty": 0 }),
            json!({ "qty": MAX_OP_QTY + 1 }),
            json!({ "purchase_price": -1.0 }),
            json!({ "purchase_price": 1.0e12 }),
            json!({ "purchase_currency": "dollars" }),
        ];
        for extra in bad {
            let (status, body) = ops(add("a", extra.clone())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{extra}: {body}");
        }
        let rows: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM collection_items) + (SELECT COUNT(*) FROM applied_ops)").fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 0);

        // The defaults and every listed value are fine.
        let (status, _) = ops(add("a", json!({}))).await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = ops(add("b", json!({ "condition": "DMG", "finish": "etched", "lang": "ja", "purchase_price": 2.5, "purchase_currency": "USD" }))).await;
        assert_eq!(status, StatusCode::OK);
        // A language the list hasn't heard of yet is fine once card data has a printing in it
        // ("change printing" sends the printing's own language).
        sqlx::query("INSERT INTO printings (scryfall_id, oracle_id, name, set_code, set_name, collector_number, lang, updated_at) VALUES ('p-new', 'o-p1', 'Sol Ring', 'tst', 'Test Set', 'new', 'tlh', 'now')")
            .execute(&pool).await.unwrap();
        let (status, body) = ops(add("b2", json!({ "scryfall_id": "p-new", "lang": "tlh" }))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let item: String = sqlx::query_scalar("SELECT id FROM collection_items WHERE scryfall_id = 'p1' AND condition = 'NM'").fetch_one(&pool).await.unwrap();

        // Changing a copy: the same lists, and a bounded note.
        let update = |op_id: &str, extra: serde_json::Value| {
            let mut op = json!({ "op_id": op_id, "kind": "update", "item_id": item });
            op.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            json!([op])
        };
        let bad = [
            json!({ "condition": "+1" }),
            json!({ "finish": "-foil" }),
            json!({ "lang": "xx" }),
            json!({ "note": "n".repeat(NOTE_MAX + 1) }),
            json!({ "purchase_price": -0.01 }),
            json!({ "split": MAX_OP_QTY + 1 }),
        ];
        for extra in bad {
            let (status, body) = ops(update("c", extra.clone())).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{extra}: {body}");
        }
        let (status, _) = ops(update("c", json!({ "condition": "LP", "lang": "de", "note": "from Dave", "purchase_price": null }))).await;
        assert_eq!(status, StatusCode::OK);
        let kept: (String, String, String) = sqlx::query_as("SELECT condition, finish, lang FROM collection_items WHERE id = ?").bind(&item).fetch_one(&pool).await.unwrap();
        assert_eq!(kept, ("LP".into(), "nonfoil".into(), "de".into()));

        // One request carries at most MAX_OPS changes, and each needs a usable op id.
        let many: Vec<_> = (0..=MAX_OPS).map(|i| json!({ "op_id": format!("m{i}"), "kind": "adjust", "item_id": item, "delta": 1 })).collect();
        assert_eq!(ops(json!(many)).await.0, StatusCode::BAD_REQUEST);
        assert_eq!(ops(json!([{ "op_id": " ", "kind": "remove", "item_id": item }])).await.0, StatusCode::BAD_REQUEST);
        // Ids are bounded whatever the op, since every op's JSON is kept.
        let long_id = "i".repeat(MAX_ID + 1);
        for op in [
            json!({ "op_id": "e", "kind": "remove", "item_id": long_id }),
            json!({ "op_id": "e", "kind": "adjust", "item_id": long_id, "delta": 1 }),
            json!({ "op_id": "e", "kind": "update", "item_id": long_id }),
            json!({ "op_id": "e", "kind": "update", "item_id": item, "scryfall_id": long_id }),
        ] {
            assert_eq!(ops(json!([op])).await.0, StatusCode::BAD_REQUEST, "{op}");
        }
        let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM applied_ops WHERE op_id = 'e'").fetch_one(&pool).await.unwrap();
        assert_eq!(kept, 0);
        assert_eq!(ops(json!([{ "op_id": "d", "kind": "adjust", "item_id": item, "delta": -(MAX_OP_QTY + 1) }])).await.0, StatusCode::BAD_REQUEST);
        let qty: i64 = sqlx::query_scalar("SELECT qty FROM collection_items WHERE id = ?").bind(&item).fetch_one(&pool).await.unwrap();
        assert_eq!(qty, 1);
    }

    #[tokio::test]
    async fn collection_changes_are_rate_limited_per_account() {
        use crate::testutil::{app, send, user};
        use axum::http::{Method, StatusCode};
        use serde_json::json;
        let (app, pool) = app().await;
        let (_, token) = user(&pool, "collector@example.com").await;
        let (_, other) = user(&pool, "other@example.com").await;
        let mut refused = None;
        for i in 0..2_000 {
            let (status, _) = send(&app, Method::POST, "/api/collection/ops", Some(&token), Some(json!([]))).await;
            if status == StatusCode::TOO_MANY_REQUESTS {
                refused = Some(i);
                break;
            }
            assert_eq!(status, StatusCode::OK);
        }
        assert!(refused.is_some_and(|n| n >= 100), "a script is stopped, a person at a screen isn't: {refused:?}");
        let (status, _) = send(&app, Method::POST, "/api/containers", Some(&token), Some(json!({ "kind": "box", "name": "Bulk" }))).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        let (status, _) = send(&app, Method::POST, "/api/collection/ops", Some(&other), Some(json!([]))).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn container_names_are_checked_and_unknown_containers_are_not_found() {
        use crate::testutil::{app, send, user};
        use axum::http::{Method, StatusCode};
        use serde_json::json;
        let (app, pool) = app().await;
        let (_, token) = user(&pool, "collector@example.com").await;
        let (_, other) = user(&pool, "other@example.com").await;
        let make = |kind: &str, name: &str| send(&app, Method::POST, "/api/containers", Some(&token), Some(json!({ "kind": kind, "name": name })));
        let (_, bulk) = make("box", "Bulk").await;
        let (_, trade) = make("box", "Trade").await;
        let (_, binder) = make("binder", "Rares").await;
        let (bulk, trade, binder) = (bulk["id"].as_str().unwrap(), trade["id"].as_str().unwrap(), binder["id"].as_str().unwrap());
        let rename = |token: &str, id: &str, name: &str| {
            let (token, path) = (token.to_string(), format!("/api/containers/{id}"));
            let (app, body) = (app.clone(), json!({ "name": name }));
            async move { send(&app, Method::PATCH, &path, Some(&token), Some(body)).await.0 }
        };

        // A name another box already has is a conflict (it was a 500); a binder may share it.
        assert_eq!(rename(&token, trade, "Bulk").await, StatusCode::CONFLICT);
        assert_eq!(rename(&token, trade, "  Bulk  ").await, StatusCode::CONFLICT);
        assert_eq!(rename(&token, binder, "Bulk").await, StatusCode::OK);
        assert_eq!(rename(&token, trade, "Trade").await, StatusCode::OK, "its own name again");
        // Blank, multi-line and overlong names are refused, for a new container too.
        let long = "n".repeat(CONTAINER_NAME_MAX + 1);
        for bad in ["", "   ", "two\nlines", "two\u{2029}lines", long.as_str()] {
            assert_eq!(rename(&token, trade, bad).await, StatusCode::BAD_REQUEST, "{bad:?}");
            assert_eq!(make("box", bad).await.0, StatusCode::BAD_REQUEST, "{bad:?}");
        }
        assert_eq!(rename(&token, trade, &"é".repeat(CONTAINER_NAME_MAX)).await, StatusCode::OK);
        // A container that isn't yours, or isn't there, is not found, and nothing changes.
        assert_eq!(rename(&other, bulk, "Mine now").await, StatusCode::NOT_FOUND);
        assert_eq!(rename(&token, "nope", "Anything").await, StatusCode::NOT_FOUND);
        let delete = |token: &str, id: &str| {
            let (token, path, app) = (token.to_string(), format!("/api/containers/{id}"), app.clone());
            async move { send(&app, Method::DELETE, &path, Some(&token), None).await.0 }
        };
        assert_eq!(delete(&other, bulk).await, StatusCode::NOT_FOUND);
        assert_eq!(delete(&token, "nope").await, StatusCode::NOT_FOUND);
        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM containers ORDER BY created_at, name").fetch_all(&pool).await.unwrap();
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"Bulk".to_string()) && !names.contains(&"Mine now".to_string()), "{names:?}");
        assert_eq!(delete(&token, bulk).await, StatusCode::OK);
        assert_eq!(delete(&token, bulk).await, StatusCode::NOT_FOUND, "already deleted");

        // An account makes at most CONTAINERS_MAX by hand. With room for one more, two
        // requests arriving together get one container between them.
        let owner: String = sqlx::query_scalar("SELECT owner_id FROM containers LIMIT 1").fetch_one(&pool).await.unwrap();
        let have: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers WHERE owner_id = ?").bind(&owner).fetch_one(&pool).await.unwrap();
        for i in have..CONTAINERS_MAX - 1 {
            sqlx::query("INSERT INTO containers (id, owner_id, kind, name, created_at) VALUES (?, ?, 'list', ?, 'now')")
                .bind(format!("c{i}")).bind(&owner).bind(format!("List {i}")).execute(&pool).await.unwrap();
        }
        let (one, two) = tokio::join!(make("box", "One more"), make("box", "And another"));
        let got = [one.0, two.0];
        assert!(got.contains(&StatusCode::OK) && got.contains(&StatusCode::CONFLICT), "{got:?}");
        let have: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM containers WHERE owner_id = ?").bind(&owner).fetch_one(&pool).await.unwrap();
        assert_eq!(have, CONTAINERS_MAX);
        // One that is already there is still answered with its id, and an unknown kind refused.
        let (status, again) = make("binder", "Bulk").await;
        assert_eq!((status, again["id"].as_str()), (StatusCode::OK, Some(binder)));
        assert_eq!(make("crate", "Nope").await.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn the_purchase_total_says_which_copies_it_leaves_out() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        for id in ["p1", "p2", "p3", "p4"] {
            printing(&pool, id, id).await;
        }
        let add = |op_id: &str, id: &str, qty, price: Option<f64>, currency: Option<&str>, proxy| Op {
            op_id: op_id.into(),
            device_id: None,
            op: OpKind::Add {
                scryfall_id: id.into(),
                qty,
                copy: CopyKind { condition: nm(), finish: nonfoil(), lang: en(), proxy, ..Default::default() },
                container_id: None,
                purchase_price: price,
                purchase_currency: currency.map(String::from),
            },
        };
        let mut tx = pool.begin().await.unwrap();
        for op in [
            add("a", "p1", 2, Some(1.5), Some("USD"), false),
            add("b", "p2", 3, None, None, false),
            add("c", "p3", 4, Some(9.0), Some("EUR"), false),
            add("d", "p4", 1, Some(0.25), None, false),
            add("e", "p4", 5, Some(100.0), Some("USD"), true),
        ] {
            apply_op(&mut tx, &owner, &op).await.unwrap();
        }
        tx.commit().await.unwrap();
        let s = summary_for(&pool, &owner).await.unwrap();
        // $3.00 for two copies and $0.25 for one with no currency named (dollars). The three
        // with no price and the four paid in euros are counted, not added in as $0; proxies
        // are left out of all of it.
        assert_eq!(s.purchase_total_usd, 3.25);
        assert_eq!((s.copies_without_purchase_price, s.copies_paid_in_other_currency), (3, 4));
        assert_eq!((s.copies, s.proxies), (15, 5));
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
    async fn update_sets_a_foil_back_to_regular_and_refuses_unknown_finishes() {
        let pool = crate::db::test_pool().await;
        let owner = user(&pool).await;
        let mut tx = pool.begin().await.unwrap();
        let add = Op {
            op_id: "a".into(),
            device_id: None,
            op: OpKind::Add {
                scryfall_id: "p1".into(),
                qty: 1,
                copy: CopyKind { condition: nm(), finish: "foil".into(), lang: en(), ..Default::default() },
                container_id: None,
                purchase_price: None,
                purchase_currency: None,
            },
        };
        apply_op(&mut tx, &owner, &add).await.unwrap();
        tx.commit().await.unwrap();
        let id: String = sqlx::query_scalar("SELECT id FROM collection_items").fetch_one(&pool).await.unwrap();
        let set = |op_id: &str, finish: &str| Op {
            op_id: op_id.into(),
            device_id: None,
            op: OpKind::Update { item_id: id.clone(), condition: None, finish: Some(finish.into()), lang: None, container_id: None, purchase_price: None, note: None, proxy: None, scryfall_id: None, split: None },
        };
        let mut tx = pool.begin().await.unwrap();
        assert!(apply_op(&mut tx, &owner, &set("b", "shiny")).await.is_err());
        drop(tx);
        let mut tx = pool.begin().await.unwrap();
        apply_op(&mut tx, &owner, &set("c", "nonfoil")).await.unwrap();
        tx.commit().await.unwrap();
        let rows: Vec<(String, i64)> = sqlx::query_as("SELECT finish, qty FROM collection_items").fetch_all(&pool).await.unwrap();
        assert_eq!(rows, vec![("nonfoil".into(), 1)]);
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
