//! Ask Claude on the shared API key: an Anthropic API key the server owner creates and pays for per
//! use (console.anthropic.com), which an admin may let chosen accounts ask on (Bryan, 2026-10-22:
//! "let Matt use my key as well").
//!
//! - **Not the subscription.** Anthropic doesn't allow sharing someone's Claude subscription with
//!   other people, so this is a separate, pay-per-use key, and the subscription stays with
//!   YAMA_ADVISOR_SUBSCRIPTION_EMAILS. A shared question never falls back to the subscription.
//! - **Where the key is.** Only in the sidecar, as ANTHROPIC_SHARED_API_KEY in its env file
//!   (`deploy/advisor-shared-key.sh` puts it there). Yama sends `mode: "shared"` and no key; the
//!   sidecar's `/health` says whether it holds one, never what it is.
//! - **Who.** A row in `advisor_shared_access`, set by an admin (Admin, People) or the
//!   `yama-server advisor share` command. `access()` in `mod.rs` decides the order: the
//!   subscription, then the account's own key, then the shared key.
//! - **Limits.** Each account's daily questions (the grant's own cap, else the usual 30 or 150, for
//!   admins too), the models in YAMA_ADVISOR_SHARED_MODELS (Haiku by default), and a server-wide
//!   monthly cap in USD (YAMA_ADVISOR_SHARED_MONTHLY_USD, default 10) summed from the cost the
//!   sidecar reports for each answer (`advisor_usage.cost_usd`). Once it's reached, shared
//!   questions wait for the next calendar month, UTC. Set a spend limit on the key itself at
//!   console.anthropic.com too: an answer that stops early may not report its cost.

use super::{Access, Mode, SharedGrant, access};
use crate::admin::AdminUser;
use crate::auth::User;
use crate::config::AdvisorConfig;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::now;
use anyhow::Context;
use axum::extract::{Path, State};
use axum::routing::{get, put};
use axum::{Json, Router};
use chrono::{DateTime, Datelike, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// The largest daily cap an admin may set for one account.
pub const MAX_DAILY_LIMIT: i64 = 1_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/advisor-shared", get(overview_route))
        .route("/api/admin/users/{id}/advisor-shared", put(grant_route).delete(revoke_route))
}

/// An account's grant.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Grant {
    pub daily_limit: Option<i64>,
    /// The display name of the admin who granted it, while that account exists.
    pub granted_by_name: Option<String>,
}

pub async fn grant_for(pool: &SqlitePool, user_id: &str) -> AppResult<Option<Grant>> {
    Ok(sqlx::query_as(
        "SELECT g.daily_limit, b.display_name AS granted_by_name FROM advisor_shared_access g
           LEFT JOIN users b ON b.id = g.granted_by WHERE g.user_id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?)
}

/// Turn the shared key on for an account, or change its daily cap. The first grant's admin and
/// time stay when the cap changes.
pub async fn grant(pool: &SqlitePool, user_id: &str, by: Option<&str>, daily_limit: Option<i64>) -> AppResult<()> {
    if let Some(n) = daily_limit
        && !(1..=MAX_DAILY_LIMIT).contains(&n)
    {
        return Err(AppError::bad(format!("a daily cap is 1 to {MAX_DAILY_LIMIT} questions, or none for the usual allowance")));
    }
    sqlx::query(
        "INSERT INTO advisor_shared_access (user_id, granted_by, granted_at, daily_limit) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET daily_limit = excluded.daily_limit",
    )
    .bind(user_id)
    .bind(by)
    .bind(now())
    .bind(daily_limit)
    .execute(pool)
    .await?;
    Ok(())
}

/// Turn it off. Whether there was a grant.
pub async fn revoke(pool: &SqlitePool, user_id: &str) -> AppResult<bool> {
    Ok(sqlx::query("DELETE FROM advisor_shared_access WHERE user_id = ?").bind(user_id).execute(pool).await?.rows_affected() > 0)
}

/// "Bryan" in "On Bryan's shared key": YAMA_ADVISOR_SHARED_OWNER_NAME, else the granting admin's
/// display name, else "the server owner".
pub fn owner_name(cfg: &AdvisorConfig, grant: Option<&Grant>) -> String {
    cfg.shared_owner_name
        .clone()
        .or_else(|| grant.and_then(|g| g.granted_by_name.clone()))
        .unwrap_or_else(|| "the server owner".into())
}

// ── the month ───────────────────────────────────────────────────────────────

/// The first moment of `t`'s calendar month, UTC.
pub fn month_start(t: DateTime<Utc>) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(t.year(), t.month(), 1, 0, 0, 0).single().expect("the first of a month at midnight UTC exists")
}

/// The first moment of the next calendar month, UTC.
pub fn next_month_start(t: DateTime<Utc>) -> DateTime<Utc> {
    let (y, m) = if t.month() == 12 { (t.year() + 1, 1) } else { (t.year(), t.month() + 1) };
    Utc.with_ymd_and_hms(y, m, 1, 0, 0, 0).single().expect("the first of a month at midnight UTC exists")
}

fn stamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// Every shared question's reported cost since the month began, everyone together.
pub async fn spent_this_month(pool: &SqlitePool) -> AppResult<f64> {
    Ok(sqlx::query_scalar("SELECT COALESCE(SUM(cost_usd), 0.0) FROM advisor_usage WHERE mode = 'shared' AND created_at >= ?")
        .bind(stamp(month_start(Utc::now())))
        .fetch_one(pool)
        .await?)
}

/// Whether the month's cap is reached, and when shared questions start again if so.
pub async fn paused_until(pool: &SqlitePool, cfg: &AdvisorConfig) -> AppResult<Option<DateTime<Utc>>> {
    let spent = spent_this_month(pool).await?;
    Ok((spent >= cfg.shared_monthly_usd).then(|| next_month_start(Utc::now())))
}

/// The refusal once the month's cap is reached.
pub fn paused_error(owner: &str, until: DateTime<Utc>) -> AppError {
    let wait = (until - Utc::now()).num_seconds().max(60) as u64;
    AppError::TooManyRequests {
        message: format!(
            "{owner}'s shared key has reached this month's limit. Questions on it start again on {} (UTC). You can add your own Anthropic API key in Settings meanwhile.",
            until.format("%-d %B")
        ),
        retry_after: wait,
    }
}

// ── the admin area ──────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
struct GrantRow {
    user_id: String,
    email: String,
    display_name: String,
    #[serde(skip)]
    is_admin: bool,
    #[serde(skip)]
    limited: bool,
    /// An admin or power user: only they can ask, whatever they're granted.
    power: bool,
    #[serde(skip)]
    has_key: bool,
    granted_by_name: Option<String>,
    granted_at: String,
    daily_limit: Option<i64>,
    /// A turned-off account can't sign in, so its grant does nothing until it's enabled again.
    disabled: bool,
    spent_this_month: f64,
    questions_this_month: i64,
    /// Whose Claude the account asks on now (the subscription or its own key win over the grant).
    #[sqlx(skip)]
    mode: Option<Mode>,
    /// The daily cap in effect for its shared questions.
    #[sqlx(skip)]
    per_day: i64,
}

#[derive(Serialize)]
pub struct Overview {
    /// The advisor is set up on this server at all.
    enabled: bool,
    /// The sidecar holds a shared key (null when it didn't answer or the advisor is off).
    key_on_sidecar: Option<bool>,
    /// YAMA_ADVISOR_SHARED_OWNER_NAME, if set.
    owner_name: Option<String>,
    monthly_usd: f64,
    spent_this_month: f64,
    /// When this month's spending started counting, and when it starts again.
    month_start: String,
    next_month: String,
    /// The models shared questions may use, by name.
    models: Vec<&'static str>,
    grants: Vec<GrantRow>,
}

async fn overview(st: &AppState) -> AppResult<Overview> {
    let cfg = &st.cfg.advisor;
    let start = month_start(Utc::now());
    let mut grants: Vec<GrantRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT g.user_id, u.email, u.display_name, u.is_admin, {limited} AS limited, {power} AS power,
                EXISTS (SELECT 1 FROM advisor_keys k WHERE k.user_id = u.id) AS has_key,
                b.display_name AS granted_by_name, g.granted_at, g.daily_limit, u.disabled_at IS NOT NULL AS disabled,
                (SELECT COALESCE(SUM(a.cost_usd), 0.0) FROM advisor_usage a WHERE a.owner_id = g.user_id AND a.mode = 'shared' AND a.created_at >= ?1) AS spent_this_month,
                (SELECT COUNT(*) FROM advisor_usage a WHERE a.owner_id = g.user_id AND a.mode = 'shared' AND a.created_at >= ?1) AS questions_this_month
           FROM advisor_shared_access g JOIN users u ON u.id = g.user_id LEFT JOIN users b ON b.id = g.granted_by
          ORDER BY u.display_name, u.email",
        limited = crate::auth::limited_sql!(),
        power = crate::auth::power_sql!()
    )))
    .bind(stamp(start))
    .fetch_all(&st.pool)
    .await?;
    let health = if cfg.enabled() { super::sidecar_health(st).await } else { None };
    let key_on_sidecar = health.map(|h| h.shared == Some(true));
    for g in &mut grants {
        let user = User { id: g.user_id.clone(), email: g.email.clone(), display_name: g.display_name.clone(), is_admin: g.is_admin, limited: g.limited, power: g.power };
        g.mode = match access(cfg, &user, g.has_key, SharedGrant::Granted { key_on_sidecar: key_on_sidecar != Some(false) }) {
            Access::Ready(m) => Some(m),
            _ => None,
        };
        g.per_day = super::shared_daily_limit(&user, g.daily_limit);
    }
    Ok(Overview {
        enabled: cfg.enabled(),
        key_on_sidecar,
        owner_name: cfg.shared_owner_name.clone(),
        monthly_usd: cfg.shared_monthly_usd,
        spent_this_month: spent_this_month(&st.pool).await?,
        month_start: stamp(start),
        next_month: stamp(next_month_start(Utc::now())),
        models: super::shared_model_labels(cfg),
        grants,
    })
}

async fn overview_route(State(st): State<AppState>, AdminUser(_): AdminUser) -> AppResult<Json<Overview>> {
    Ok(Json(overview(&st).await?))
}

#[derive(Deserialize)]
struct GrantBody {
    /// Questions a day on the shared key; null or missing for the account's usual allowance.
    #[serde(default)]
    daily_limit: Option<i64>,
}

async fn account_exists(pool: &SqlitePool, id: &str) -> AppResult<String> {
    sqlx::query_scalar("SELECT email FROM users WHERE id = ?").bind(id).fetch_optional(pool).await?.ok_or(AppError::NotFound("account"))
}

async fn grant_route(State(st): State<AppState>, AdminUser(admin): AdminUser, Path(id): Path<String>, Json(body): Json<GrantBody>) -> AppResult<Json<Overview>> {
    let email = account_exists(&st.pool, &id).await?;
    grant(&st.pool, &id, Some(&admin.id), body.daily_limit).await?;
    tracing::info!(by = %admin.email, account = %email, daily_limit = ?body.daily_limit, "shared advisor key granted");
    Ok(Json(overview(&st).await?))
}

async fn revoke_route(State(st): State<AppState>, AdminUser(admin): AdminUser, Path(id): Path<String>) -> AppResult<Json<Overview>> {
    let email = account_exists(&st.pool, &id).await?;
    if revoke(&st.pool, &id).await? {
        tracing::info!(by = %admin.email, account = %email, "shared advisor key revoked");
    }
    Ok(Json(overview(&st).await?))
}

// ── the command line ────────────────────────────────────────────────────────

pub const CLI_USAGE: &str = "usage: yama-server advisor share EMAIL [--daily N] [--by ADMIN_EMAIL] | advisor unshare EMAIL | advisor shared";

async fn id_for_email(pool: &SqlitePool, email: &str) -> anyhow::Result<Option<(String, bool)>> {
    Ok(sqlx::query_as("SELECT id, disabled_at IS NOT NULL FROM users WHERE email = ?").bind(email.trim().to_lowercase()).fetch_optional(pool).await?)
}

fn usual(limited: bool) -> String {
    format!("{} questions a day, the usual allowance", if limited { super::DAILY_LIMITED } else { super::DAILY_INVITED })
}

/// `yama-server advisor share|unshare|shared`, so an agent on the server can grant an account.
/// `args` starts after `advisor`.
pub async fn cli(pool: &SqlitePool, cfg: &crate::config::Config, args: &[String]) -> anyhow::Result<()> {
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    match args.first().map(String::as_str) {
        Some("share") => {
            let email = args.get(1).filter(|a| !a.starts_with("--")).context(CLI_USAGE)?;
            let daily = flag("--daily").map(|n| n.parse::<i64>().with_context(|| format!("--daily {n:?} must be a whole number"))).transpose()?;
            let (id, disabled) = id_for_email(pool, email).await?.with_context(|| format!("there's no account for {email}; they need to sign in to Yama once first"))?;
            // Whose key it is, for "On Bryan's shared key": --by, else the first admin email with an account.
            let mut by = None;
            let candidates: Vec<String> = match flag("--by") {
                Some(b) => vec![b],
                None => cfg.admin_emails.clone(),
            };
            for c in &candidates {
                if let Some((admin_id, _)) = id_for_email(pool, c).await? {
                    by = Some(admin_id);
                    break;
                }
            }
            if flag("--by").is_some() && by.is_none() {
                anyhow::bail!("there's no account for {}", candidates[0]);
            }
            grant(pool, &id, by.as_deref(), daily).await.map_err(|e| anyhow::anyhow!("{e}"))?;
            let limited: bool = sqlx::query_scalar(concat!("SELECT ", crate::auth::limited_sql!(), " FROM users u WHERE u.id = ?")).bind(&id).fetch_one(pool).await?;
            let cap = daily.map_or_else(|| usual(limited), |n| format!("{n} questions a day"));
            println!("{email} may ask Claude on the shared key ({cap}; models: {}).", cfg.advisor.shared_models.join(", "));
            if disabled {
                println!("Note: the account is turned off, so the grant does nothing until it's enabled again.");
            }
            println!(
                "The shared key's monthly cap is ${:.2}; it needs ANTHROPIC_SHARED_API_KEY in the sidecar (deploy/advisor-shared-key.sh). Their own key or the subscription, if they have one, comes first.",
                cfg.advisor.shared_monthly_usd
            );
            Ok(())
        }
        Some("unshare") => {
            let email = args.get(1).context(CLI_USAGE)?;
            let (id, _) = id_for_email(pool, email).await?.with_context(|| format!("there's no account for {email}"))?;
            if revoke(pool, &id).await.map_err(|e| anyhow::anyhow!("{e}"))? {
                println!("{email} no longer asks Claude on the shared key.");
            } else {
                println!("{email} didn't have the shared key.");
            }
            Ok(())
        }
        Some("shared") => {
            let start = stamp(month_start(Utc::now()));
            let rows: Vec<(String, Option<i64>, bool, bool, f64, i64)> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                "SELECT u.email, g.daily_limit, {limited}, u.disabled_at IS NOT NULL,
                        (SELECT COALESCE(SUM(a.cost_usd), 0.0) FROM advisor_usage a WHERE a.owner_id = u.id AND a.mode = 'shared' AND a.created_at >= ?1),
                        (SELECT COUNT(*) FROM advisor_usage a WHERE a.owner_id = u.id AND a.mode = 'shared' AND a.created_at >= ?1)
                   FROM advisor_shared_access g JOIN users u ON u.id = g.user_id ORDER BY u.email",
                limited = crate::auth::limited_sql!()
            )))
            .bind(&start)
            .fetch_all(pool)
            .await?;
            let spent: f64 = sqlx::query_scalar("SELECT COALESCE(SUM(cost_usd), 0.0) FROM advisor_usage WHERE mode = 'shared' AND created_at >= ?").bind(&start).fetch_one(pool).await?;
            println!("Shared key this month: ${spent:.2} of ${:.2}. Models: {}.", cfg.advisor.shared_monthly_usd, cfg.advisor.shared_models.join(", "));
            if rows.is_empty() {
                println!("Nobody has it.");
            }
            for (email, daily, limited, disabled, cost, questions) in rows {
                let cap = daily.map_or_else(|| usual(limited), |n| format!("{n} questions a day"));
                println!("  {email}: {cap}; ${cost:.2} and {questions} questions this month{}", if disabled { " (turned off)" } else { "" });
            }
            Ok(())
        }
        _ => anyhow::bail!(CLI_USAGE),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months_begin_and_end_in_utc() {
        let t = Utc.with_ymd_and_hms(2026, 10, 22, 23, 59, 0).unwrap();
        assert_eq!(stamp(month_start(t)), "2026-10-01T00:00:00Z");
        assert_eq!(stamp(next_month_start(t)), "2026-11-01T00:00:00Z");
        let dec = Utc.with_ymd_and_hms(2026, 12, 31, 12, 0, 0).unwrap();
        assert_eq!(stamp(next_month_start(dec)), "2027-01-01T00:00:00Z");
    }

    #[test]
    fn the_owner_is_named_by_config_then_the_granting_admin() {
        let mut cfg = AdvisorConfig::default();
        let g = Grant { daily_limit: None, granted_by_name: Some("Bryan Roscoe".into()) };
        assert_eq!(owner_name(&cfg, Some(&g)), "Bryan Roscoe");
        assert_eq!(owner_name(&cfg, None), "the server owner");
        cfg.shared_owner_name = Some("Bryan".into());
        assert_eq!(owner_name(&cfg, Some(&g)), "Bryan");
    }
}
