//! Your shopping settings (docs/shopping-design.md, "Account-level rules" and "Choosing stores"):
//! the buy rule and sealed cap as dated rule sets made in Yama, and how you feel about each of your
//! stores (level, your order of how easy it is to get to, and a favourite's premium). The routes
//! serve the web pages; `save_rules` and `set_pref` are also what Claude's staged changes apply.
//! The limits match `packages/core/src/plan/shoprules.ts`.

use super::trip;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::Json;
use axum::extract::{Path, State};
use chrono::{Duration, NaiveDate, Utc};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::{SqliteConnection, SqlitePool};
use std::fmt::Write as _;

pub const PREFERENCES: [&str; 4] = ["favorite", "ok", "maybe", "never"];
pub const MAX_TIERS: usize = 6;
pub const MAX_RULE_USD: f64 = 10000.0;
pub const MAX_MULTIPLE: f64 = 10.0;
pub const MAX_PREMIUM_USD: f64 = 10.0;
pub const MAX_HASSLE: i64 = 999;

fn now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

async fn bump(conn: &mut SqliteConnection, owner: &str, at: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO plan_meta (owner_id, revision, updated_at) VALUES (?, 1, ?)
         ON CONFLICT(owner_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at",
    )
    .bind(owner)
    .bind(at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

// ── the buy rule ────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Tier {
    pub market_under: Option<f64>,
    pub max_multiple: f64,
}

/// A `local_buy` rule as the person sends it (trip.rs `LocalBuyRule` is the one the trip reads).
#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct LocalBuy {
    pub max_usd: Option<f64>,
    pub always_ok_usd: Option<f64>,
    #[serde(default)]
    pub tiers: Vec<Tier>,
}

impl LocalBuy {
    pub fn to_json(&self) -> Value {
        json!({
            "max_usd": self.max_usd, "always_ok_usd": self.always_ok_usd,
            "tiers": self.tiers.iter().map(|t| json!({"market_under": t.market_under, "max_multiple": t.max_multiple})).collect::<Vec<_>>(),
        })
    }

    pub fn rule(&self) -> trip::LocalBuyRule {
        trip::LocalBuyRule { max_usd: self.max_usd, always_ok_usd: self.always_ok_usd, tiers: self.tiers.iter().map(|t| (t.market_under, t.max_multiple)).collect() }
    }

    pub fn from_rule(r: &trip::LocalBuyRule) -> Self {
        LocalBuy { max_usd: r.max_usd, always_ok_usd: r.always_ok_usd, tiers: r.tiers.iter().map(|(u, m)| Tier { market_under: *u, max_multiple: *m }).collect() }
    }
}

fn money(v: Option<f64>) -> bool {
    v.is_none_or(|v| v.is_finite() && (0.0..=MAX_RULE_USD).contains(&v))
}

/// What's wrong with a rule, in the words the Settings page uses; empty when it can be saved.
pub fn problems(lb: &LocalBuy, sealed_max_usd: Option<f64>) -> Vec<String> {
    let mut out = Vec::new();
    if !money(lb.max_usd) {
        out.push(format!("The most a card may cost must be $0 to ${MAX_RULE_USD}."));
    }
    if !money(lb.always_ok_usd) {
        out.push(format!("The always-fine price must be $0 to ${MAX_RULE_USD}."));
    }
    if let (Some(max), Some(ok)) = (lb.max_usd, lb.always_ok_usd)
        && ok > max
    {
        out.push("The always-fine price can't be above the most a card may cost.".into());
    }
    if lb.tiers.len() > MAX_TIERS {
        out.push(format!("At most {MAX_TIERS} market ranges."));
    }
    let mut low = 0.0_f64;
    for (i, t) in lb.tiers.iter().enumerate() {
        let n = i + 1;
        if !(t.max_multiple.is_finite() && t.max_multiple > 0.0 && t.max_multiple <= MAX_MULTIPLE) {
            out.push(format!("Range {n}: the multiple of market must be above 0 and at most {MAX_MULTIPLE}."));
        }
        match t.market_under {
            None if i + 1 < lb.tiers.len() => out.push(format!("Range {n}: only the last range can be \"any market\".")),
            None => {}
            Some(u) => {
                if !money(Some(u)) || u <= low {
                    out.push(format!("Range {n}: the market limit must be above {}.", if i > 0 { "the one before" } else { "$0" }));
                }
                low = low.max(u);
            }
        }
    }
    if !money(sealed_max_usd) {
        out.push(format!("The sealed precon limit must be $0 to ${MAX_RULE_USD}."));
    }
    out
}

/// Save the buy rule and sealed cap as the rule set from `date`: a copy of the set in force that
/// day with these two replaced, made in Yama. A set already on that date is replaced (an imported
/// one too; the next import then keeps this one and says so).
pub async fn save_rules(pool: &SqlitePool, owner: &str, date: &str, lb: &LocalBuy, sealed_max_usd: Option<f64>, note: Option<&str>) -> AppResult<Value> {
    let found = problems(lb, sealed_max_usd);
    if !found.is_empty() {
        return Err(AppError::bad(found.join(" ")));
    }
    let at = now();
    let mut tx = pool.begin().await?;
    let base: Option<String> = sqlx::query_scalar("SELECT rules FROM plan_settings WHERE owner_id = ? AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1")
        .bind(owner)
        .bind(date)
        .fetch_optional(&mut *tx)
        .await?;
    let mut rules: Map<String, Value> = base.and_then(|r| serde_json::from_str::<Value>(&r).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
    rules.entry("currency").or_insert_with(|| json!("USD"));
    rules.insert("local_buy".into(), lb.to_json());
    match sealed_max_usd {
        Some(v) => rules.insert("sealed_max_usd".into(), json!(v)),
        None => rules.remove("sealed_max_usd"),
    };
    let note = note.map(str::trim).filter(|n| !n.is_empty()).unwrap_or("Buy rule changed in Yama");
    sqlx::query(
        "INSERT INTO plan_settings (owner_id, effective_from, rules, note, origin, created_at) VALUES (?, ?, ?, ?, 'yama', ?)
         ON CONFLICT(owner_id, effective_from) DO UPDATE SET rules = excluded.rules, note = excluded.note,
           origin = excluded.origin, created_at = excluded.created_at",
    )
    .bind(owner)
    .bind(date)
    .bind(Value::Object(rules.clone()).to_string())
    .bind(note)
    .bind(&at)
    .execute(&mut *tx)
    .await?;
    bump(&mut tx, owner, &at).await?;
    tx.commit().await?;
    Ok(json!({"effective_from": date, "origin": "yama", "note": note, "rules": rules}))
}

#[derive(Deserialize)]
pub struct RulesBody {
    effective_from: String,
    local_buy: LocalBuy,
    sealed_max_usd: Option<f64>,
    note: Option<String>,
}

/// The device's today may be a day either side of the server's.
fn near_today(date: &str) -> bool {
    let Ok(d) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else { return false };
    let today = Utc::now().date_naive();
    (today - Duration::days(1)..=today + Duration::days(1)).contains(&d)
}

/// `POST /api/plan/settings`: your buy rule and sealed cap as a new rule set from today.
pub async fn save_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<RulesBody>) -> AppResult<Json<Value>> {
    if !super::model::is_date(&body.effective_from) || !near_today(&body.effective_from) {
        return Err(AppError::bad("effective_from must be today (YYYY-MM-DD): a change applies from the day it's made"));
    }
    if body.note.as_ref().is_some_and(|n| n.chars().count() > 500) {
        return Err(AppError::bad("note: at most 500 characters"));
    }
    Ok(Json(save_rules(&st.pool, &user.id, &body.effective_from, &body.local_buy, body.sealed_max_usd, body.note.as_deref()).await?))
}

/// `DELETE /api/plan/settings/{date}`: undo the newest rule set when it was made in Yama.
pub async fn remove_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(date): Path<String>) -> AppResult<Json<Value>> {
    let mut tx = st.pool.begin().await?;
    let newest: Option<(String, String)> = sqlx::query_as("SELECT effective_from, origin FROM plan_settings WHERE owner_id = ? ORDER BY effective_from DESC LIMIT 1")
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
    match newest {
        Some((d, origin)) if d == date && origin == "yama" => {}
        Some((d, _)) if d == date => return Err(AppError::Conflict("That rule set came from your plan import; change it there.".into())),
        _ => {
            let exists: Option<String> = sqlx::query_scalar("SELECT origin FROM plan_settings WHERE owner_id = ? AND effective_from = ?").bind(&user.id).bind(&date).fetch_optional(&mut *tx).await?;
            return match exists {
                None => Err(AppError::NotFound("rule set")),
                Some(_) => Err(AppError::Conflict("Only the newest rule set can be undone, so older checks keep the rules of their day.".into())),
            };
        }
    }
    let at = now();
    sqlx::query("DELETE FROM plan_settings WHERE owner_id = ? AND effective_from = ? AND origin = 'yama'").bind(&user.id).bind(&date).execute(&mut *tx).await?;
    bump(&mut tx, &user.id, &at).await?;
    tx.commit().await?;
    Ok(Json(json!({"removed": date})))
}

// ── store preferences ───────────────────────────────────────────────────────

/// One store's whole setting.
#[derive(Clone, Debug, PartialEq)]
pub struct Pref {
    pub preference: String,
    pub note: Option<String>,
    pub hassle: Option<i64>,
    pub premium_usd: Option<f64>,
}

impl Pref {
    pub fn check(&self) -> AppResult<()> {
        if !PREFERENCES.contains(&self.preference.as_str()) {
            return Err(AppError::bad(format!("preference must be one of favorite, ok, maybe or never, not \"{}\"", self.preference)));
        }
        if self.note.as_ref().is_some_and(|n| n.chars().count() > 500) {
            return Err(AppError::bad("note: at most 500 characters"));
        }
        if self.hassle.is_some_and(|h| !(1..=MAX_HASSLE).contains(&h)) {
            return Err(AppError::bad(format!("hassle: a place from 1 to {MAX_HASSLE}")));
        }
        if self.premium_usd.is_some_and(|p| !(p.is_finite() && (0.0..=MAX_PREMIUM_USD).contains(&p))) {
            return Err(AppError::bad(format!("premium_usd: $0 to ${MAX_PREMIUM_USD}")));
        }
        Ok(())
    }
}

/// The caller's setting for one of their stores, or the default ("ok", nothing else).
pub async fn get_pref(pool: &SqlitePool, owner: &str, key: &str) -> AppResult<Pref> {
    let row: Option<(String, Option<String>, Option<i64>, Option<f64>)> =
        sqlx::query_as("SELECT preference, note, hassle, premium_usd FROM plan_store_prefs WHERE owner_id = ? AND store_key = ?")
            .bind(owner)
            .bind(key)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(preference, note, hassle, premium_usd)| Pref { preference, note, hassle, premium_usd }).unwrap_or(Pref { preference: "ok".into(), note: None, hassle: None, premium_usd: None }))
}

/// Save one store's whole setting. "ok" with nothing else set is the default, so the row goes.
pub async fn set_pref(pool: &SqlitePool, owner: &str, key: &str, p: &Pref) -> AppResult<Value> {
    p.check()?;
    let known: Option<String> = sqlx::query_scalar("SELECT key FROM plan_stores WHERE owner_id = ? AND key = ?").bind(owner).bind(key).fetch_optional(pool).await?;
    if known.is_none() {
        return Err(AppError::NotFound("store"));
    }
    let premium = p.premium_usd.filter(|v| *v > 0.0);
    let at = now();
    if p.preference == "ok" && p.note.is_none() && p.hassle.is_none() && premium.is_none() {
        sqlx::query("DELETE FROM plan_store_prefs WHERE owner_id = ? AND store_key = ?").bind(owner).bind(key).execute(pool).await?;
    } else {
        sqlx::query(
            "INSERT INTO plan_store_prefs (owner_id, store_key, preference, note, hassle, premium_usd, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(owner_id, store_key) DO UPDATE SET preference = excluded.preference, note = excluded.note,
               hassle = excluded.hassle, premium_usd = excluded.premium_usd, updated_at = excluded.updated_at",
        )
        .bind(owner)
        .bind(key)
        .bind(&p.preference)
        .bind(&p.note)
        .bind(p.hassle)
        .bind(premium)
        .bind(&at)
        .execute(pool)
        .await?;
    }
    Ok(json!({"store": key, "preference": p.preference, "note": p.note, "hassle": p.hassle, "premium_usd": premium, "updated_at": at}))
}

/// Put one store at `place` (from 1) in the owner's order and renumber the others around it, as the
/// Trip page's arrows do, so no two stores share a place.
pub async fn place_store(pool: &SqlitePool, owner: &str, key: &str, place: i64) -> AppResult<()> {
    let mut order: Vec<String> = sqlx::query_scalar(
        "SELECT s.key FROM plan_stores s LEFT JOIN plan_store_prefs p ON p.owner_id = s.owner_id AND p.store_key = s.key
         WHERE s.owner_id = ? AND s.retired_at IS NULL AND s.kind != 'printer'
         ORDER BY p.hassle IS NULL, p.hassle, s.sort, s.key",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    let Some(at) = order.iter().position(|k| k == key) else { return Err(AppError::NotFound("store")) };
    let moved = order.remove(at);
    order.insert(((place - 1).max(0) as usize).min(order.len()), moved);
    write_order(pool, owner, &order).await
}

/// The owner's order of how easy their stores are to get to: the given stores take places 1, 2, ...
/// in one transaction, and keep their other settings. Each must be one of their current stores.
pub async fn write_order(pool: &SqlitePool, owner: &str, keys: &[String]) -> AppResult<()> {
    let known: Vec<String> = sqlx::query_scalar("SELECT key FROM plan_stores WHERE owner_id = ? AND retired_at IS NULL AND kind != 'printer'")
        .bind(owner)
        .fetch_all(pool)
        .await?;
    let mut seen = std::collections::HashSet::new();
    for k in keys {
        if !known.contains(k) {
            return Err(AppError::bad(format!("No store with key \"{k}\"")));
        }
        if !seen.insert(k) {
            return Err(AppError::bad(format!("\"{k}\" appears twice")));
        }
    }
    let at = now();
    let mut tx = pool.begin().await?;
    for (i, k) in keys.iter().enumerate() {
        sqlx::query(
            "INSERT INTO plan_store_prefs (owner_id, store_key, preference, hassle, updated_at) VALUES (?, ?, 'ok', ?, ?)
             ON CONFLICT(owner_id, store_key) DO UPDATE SET hassle = excluded.hassle, updated_at = excluded.updated_at",
        )
        .bind(owner)
        .bind(k)
        .bind(i as i64 + 1)
        .bind(&at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct OrderBody {
    keys: Vec<String>,
}

/// `PUT /api/plan/store-order`: the caller's whole order of their stores, saved at once.
pub async fn order_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Json(body): Json<OrderBody>) -> AppResult<Json<Value>> {
    if body.keys.len() > MAX_HASSLE as usize {
        return Err(AppError::bad("too many stores"));
    }
    write_order(&st.pool, &user.id, &body.keys).await?;
    Ok(Json(json!({"keys": body.keys})))
}

#[derive(Deserialize)]
pub struct PrefBody {
    /// Null: "ok".
    preference: Option<String>,
    note: Option<String>,
    hassle: Option<i64>,
    premium_usd: Option<f64>,
}

/// `PUT /api/plan/stores/{key}/preference`: the caller's whole setting for one of their stores. It
/// lives apart from the imported store row, so an import never overwrites it.
pub async fn preference_route(State(st): State<AppState>, CurrentUser(user): CurrentUser, Path(key): Path<String>, Json(body): Json<PrefBody>) -> AppResult<Json<Value>> {
    let preference = match body.preference.as_deref() {
        None => "ok".to_string(),
        Some("default") => "favorite".to_string(), // the name before migration 0051
        Some(p) => p.to_string(),
    };
    let note = body.note.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    Ok(Json(set_pref(&st.pool, &user.id, &key, &Pref { preference, note, hassle: body.hassle, premium_usd: body.premium_usd }).await?))
}

// ── for Claude ──────────────────────────────────────────────────────────────

/// `shopping_settings`: the rule in force, every dated set, and each store's setting, in words.
pub fn settings_text(bundle: &Value, today: &str) -> String {
    let empty = vec![];
    let sets = bundle["settings"].as_array().unwrap_or(&empty);
    let set = trip::rules_at(sets, today);
    let rule = trip::local_buy_rule(set);
    let mut out = String::new();
    match set {
        Some(s) => {
            let origin = if s["origin"] == "yama" { "made in Yama" } else { "from their plan import" };
            let _ = writeln!(out, "Rule in force on {today}: the set from {} ({origin}).", s["effective_from"].as_str().unwrap_or("?"));
        }
        None => {
            let _ = writeln!(out, "No rule set is in force on {today}.");
        }
    }
    let _ = writeln!(out, "{}", rule.text);
    match set.and_then(|s| s["rules"]["sealed_max_usd"].as_f64()) {
        Some(v) => {
            let _ = writeln!(out, "Sealed precons: at most ${v:.2} a deck before tax.");
        }
        None => out.push_str("Sealed precons: no limit set.\n"),
    }
    if !sets.is_empty() {
        out.push_str("\nRule sets (each applies from its date, so older checks keep the rules of their day):\n");
        for s in sets {
            let origin = if s["origin"] == "yama" { "made in Yama" } else { "imported" };
            let _ = writeln!(out, "- from {} ({origin}){}", s["effective_from"].as_str().unwrap_or("?"), s["note"].as_str().map(|n| format!(": {n}")).unwrap_or_default());
        }
    }
    let stores: Vec<&Value> = bundle["stores"].as_array().map(|a| a.iter().filter(|s| s["retired"] != true && s["kind"] != "printer").collect()).unwrap_or_default();
    if !stores.is_empty() {
        out.push_str("\nTheir stores, easiest to get to first (favourite: on every trip it has a card for):\n");
        let order = trip::hassle_order(bundle);
        let mut sorted = stores.clone();
        sorted.sort_by_key(|s| order.get(s["key"].as_str().unwrap_or_default()).copied().unwrap_or(usize::MAX));
        for s in sorted {
            let key = s["key"].as_str().unwrap_or_default();
            let pref = trip::store_preference(bundle, key);
            let premium = trip::store_premium(bundle, key);
            let placed = bundle["store_prefs"][key]["hassle"].as_i64().is_some();
            let _ = writeln!(
                out,
                "- {} (key {key}{}): {}{}{}",
                s["name"].as_str().unwrap_or(key),
                s["location"].as_str().map(|l| format!(", {l}")).unwrap_or_default(),
                trip::preference_text(pref),
                if premium > 0.0 { format!(", up to ${premium:.2} more a card here") } else { String::new() },
                if placed { "" } else { ", not placed in their order" },
            );
        }
    }
    out
}
