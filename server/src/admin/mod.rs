//! The admin area (`/admin` in the web app): people, usage, the server's state and global lab runs.
//!
//! Every route here takes [`AdminUser`], which answers a signed-in non-admin with the same 404 as
//! an unknown API path, so the area's routes don't show up for anyone else. The older admin routes
//! in `auth.rs` (accounts, invites) use it too.

pub mod delete;
#[cfg(test)]
mod tests;

use crate::auth::{CurrentUser, User, limited_sql, power_sql};
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::routing::{delete as delete_route, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/usage", get(usage))
        .route("/api/admin/server", get(server))
        .route("/api/admin/perf", get(perf))
        .route("/api/admin/watch/{id}/stop", post(stop_watch))
        .route("/api/admin/lab-runs", get(lab_runs))
        .route("/api/admin/lab-runs/{id}", delete_route(delete_lab_run).patch(rename_lab_run))
        .route("/api/admin/users/{id}", delete_route(delete_user))
        .route("/api/admin/users/{id}/invite", post(invite_user).delete(uninvite_user))
        .route("/api/admin/users/{id}/power", post(grant_power).delete(revoke_power))
}

/// Extractor: the signed-in user, if an admin. Anyone else signed in gets "API route not found",
/// the answer an unknown path gets; signed out is still 401.
pub struct AdminUser(pub User);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let CurrentUser(user) = CurrentUser::from_request_parts(parts, state).await?;
        if user.is_admin { Ok(AdminUser(user)) } else { Err(AppError::NotFound("API route")) }
    }
}

/// When this server process started (set from `main`).
static STARTED_AT: LazyLock<String> = LazyLock::new(crate::util::now);

/// Note the start time; call once at startup.
pub fn mark_started() {
    LazyLock::force(&STARTED_AT);
}

fn day_ago() -> String {
    (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

// ── people ─────────────────────────────────────────────────────────────────

async fn account_email(st: &AppState, id: &str) -> AppResult<(String, bool)> {
    sqlx::query_as("SELECT email, is_admin FROM users WHERE id = ?").bind(id).fetch_optional(&st.pool).await?.ok_or(AppError::NotFound("account"))
}

async fn invite_user(State(st): State<AppState>, AdminUser(admin): AdminUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    let (email, _) = account_email(&st, &id).await?;
    crate::auth::add_invite(&st.pool, &email, Some(&admin.id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn uninvite_user(State(st): State<AppState>, AdminUser(_): AdminUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    let (email, _) = account_email(&st, &id).await?;
    crate::auth::remove_invite(&st, &email).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Make an account a power user, or stop it being one (2026-10-31): only admins and power users may
/// start simulations and watched AI games or ask Claude. Admins always are, so their flag isn't
/// changed here. A run already waiting keeps its place; nothing new can be started once revoked.
async fn set_power(st: &AppState, admin: &User, id: &str, on: bool) -> AppResult<StatusCode> {
    let (email, is_admin) = account_email(st, id).await?;
    if is_admin {
        return Err(AppError::bad("an admin is always a power user"));
    }
    sqlx::query("UPDATE users SET power_user = ? WHERE id = ?").bind(on).bind(id).execute(&st.pool).await?;
    tracing::info!(by = %admin.email, account = %email, power_user = on, "power user changed");
    Ok(StatusCode::NO_CONTENT)
}

async fn grant_power(State(st): State<AppState>, AdminUser(admin): AdminUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    set_power(&st, &admin, &id, true).await
}

async fn revoke_power(State(st): State<AppState>, AdminUser(admin): AdminUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    set_power(&st, &admin, &id, false).await
}

#[derive(Deserialize)]
struct DeleteBody {
    /// The account's email, typed by the admin to confirm.
    confirm_email: String,
}

async fn delete_user(
    State(st): State<AppState>,
    AdminUser(admin): AdminUser,
    Path(id): Path<String>,
    Json(body): Json<DeleteBody>,
) -> AppResult<Json<delete::DeleteReport>> {
    if id == admin.id {
        return Err(AppError::bad("you can't delete your own account here"));
    }
    let (email, is_admin) = account_email(&st, &id).await?;
    if is_admin {
        return Err(AppError::Forbidden("an admin account can't be deleted here; remove it from YAMA_ADMIN_EMAILS first".into()));
    }
    if !body.confirm_email.trim().eq_ignore_ascii_case(&email) {
        return Err(AppError::bad("type the account's email exactly to confirm"));
    }
    let report = delete::delete_account(&st, &id).await?;
    tracing::info!(by = %admin.email, account = %report.email, games_kept = report.games_kept, games_deleted = report.games_deleted,
        rows = report.rows_deleted, "account deleted");
    Ok(Json(report))
}

// ── usage ──────────────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
struct UsageRow {
    id: String,
    email: String,
    display_name: String,
    is_admin: bool,
    limited: bool,
    /// An admin or an account made a power user: may start simulations and ask Claude.
    power: bool,
    /// Made a power user in Admin, People (admins are power users without it).
    power_user: bool,
    disabled: bool,
    decks: i64,
    collection_cards: i64,
    games_logged: i64,
    games_played: i64,
    has_plan: bool,
    lab_games_today: i64,
    lab_games_queued: i64,
    lab_runs_unfinished: i64,
    advisor_today: i64,
    advisor_total: i64,
    advisor_own_key: bool,
    /// An admin granted it the shared API key (Admin, People).
    advisor_shared: bool,
    advisor_shared_limit: Option<i64>,
    #[sqlx(skip)]
    advisor_mode: Option<&'static str>,
    /// Why the account can't ask, when it can't: off | keys_off | needs_key.
    #[sqlx(skip)]
    advisor_reason: Option<&'static str>,
    #[sqlx(skip)]
    watch_running: i64,
    #[sqlx(skip)]
    limits: Limits,
}

/// The account's allowances, so the page can say who is near one. `None`: no limit.
#[derive(Serialize, Default)]
struct Limits {
    lab_games_per_day: Option<i64>,
    lab_runs_at_a_time: Option<i64>,
    advisor_per_day: Option<i64>,
    watch_at_a_time: Option<i64>,
}

#[derive(Serialize)]
struct Usage {
    accounts: Vec<UsageRow>,
    totals: UsageTotals,
}

#[derive(Serialize, Default)]
struct UsageTotals {
    accounts: i64,
    open_signup_accounts: i64,
    disabled: i64,
    seen_today: i64,
    decks: i64,
    games_logged: i64,
    lab_games_today: i64,
    lab_games_queued: i64,
    /// Games waiting or playing that count toward the lab's shared caps.
    lab_queue_cap: i64,
    lab_open_queue_games: i64,
    lab_open_queue_cap: i64,
    advisor_today: i64,
    watch_running: i64,
    online_games_live: i64,
}

async fn usage(State(st): State<AppState>, AdminUser(_): AdminUser) -> AppResult<Json<Usage>> {
    let since = day_ago();
    let mut accounts: Vec<UsageRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT u.id, u.email, u.display_name, u.is_admin, {limited} AS limited, {power} AS power, u.power_user = 1 AS power_user,
           u.disabled_at IS NOT NULL AS disabled,
           (SELECT COUNT(*) FROM decks d WHERE d.owner_id = u.id AND d.archived = 0) AS decks,
           (SELECT COALESCE(SUM(c.qty), 0) FROM collection_items c WHERE c.owner_id = u.id) AS collection_cards,
           (SELECT COUNT(*) FROM games g WHERE g.created_by = u.id) AS games_logged,
           (SELECT COUNT(*) FROM game_seats s WHERE s.user_id = u.id) AS games_played,
           EXISTS (SELECT 1 FROM plan_meta pm WHERE pm.owner_id = u.id) AS has_plan,
           (SELECT COALESCE(SUM(l.games), 0) FROM lab_usage l WHERE l.owner_id = u.id AND l.created_at > ?1) AS lab_games_today,
           (SELECT COALESCE(SUM(e.games_total - e.games_done), 0) FROM lab_experiments e WHERE e.owner_id = u.id AND e.status IN ('queued','running')) AS lab_games_queued,
           (SELECT COUNT(*) FROM lab_experiments e WHERE e.owner_id = u.id AND e.status IN ('queued','running')) AS lab_runs_unfinished,
           (SELECT COUNT(*) FROM advisor_usage a WHERE a.owner_id = u.id AND a.created_at > ?1) AS advisor_today,
           (SELECT COUNT(*) FROM advisor_usage a WHERE a.owner_id = u.id) AS advisor_total,
           EXISTS (SELECT 1 FROM advisor_keys k WHERE k.user_id = u.id) AS advisor_own_key,
           EXISTS (SELECT 1 FROM advisor_shared_access g WHERE g.user_id = u.id) AS advisor_shared,
           (SELECT g.daily_limit FROM advisor_shared_access g WHERE g.user_id = u.id) AS advisor_shared_limit
         FROM users u WHERE u.guest = 0 ORDER BY u.created_at DESC, u.email LIMIT 500",
        limited = limited_sql!(),
        power = power_sql!()
    )))
    .bind(&since)
    .fetch_all(&st.pool)
    .await?;
    let mut watching: HashMap<String, i64> = HashMap::new();
    for g in st.watch.admin_items().into_iter().filter(|g| !g.finished) {
        *watching.entry(g.owner_id).or_default() += 1;
    }
    let quota = &st.cfg.lab_quota;
    let advisor = &st.cfg.advisor;
    // Whether the sidecar holds the shared key, asked once and only when someone has a grant.
    let shared_key = if advisor.enabled() && accounts.iter().any(|a| a.advisor_shared) {
        crate::advisor::sidecar_health(&st).await.is_none_or(|h| h.shared == Some(true))
    } else {
        false
    };
    let mut t = UsageTotals::default();
    for a in &mut accounts {
        let user = User { id: a.id.clone(), email: a.email.clone(), display_name: a.display_name.clone(), is_admin: a.is_admin, limited: a.limited, power: a.power, guest: false };
        a.watch_running = watching.get(&a.id).copied().unwrap_or(0);
        let shared = if a.advisor_shared {
            crate::advisor::SharedGrant::Granted { key_on_sidecar: shared_key }
        } else {
            crate::advisor::SharedGrant::NotGranted
        };
        let access = crate::advisor::access(advisor, &user, a.advisor_own_key, shared);
        a.advisor_reason = access.reason();
        let mode = match access {
            crate::advisor::Access::Ready(m) => Some(m),
            _ => None,
        };
        a.advisor_mode = mode.map(crate::advisor::Mode::as_str);
        let shared_per_day = (mode == Some(crate::advisor::Mode::Shared)).then(|| crate::advisor::shared_daily_limit(&user, a.advisor_shared_limit));
        a.limits = if a.is_admin {
            Limits { advisor_per_day: shared_per_day, ..Limits::default() }
        } else {
            Limits {
                lab_games_per_day: a.limited.then_some(quota.open_daily_games),
                lab_runs_at_a_time: Some(if a.limited { crate::lab::experiments::OPEN_MAX_UNFINISHED } else { crate::lab::experiments::MAX_UNFINISHED }),
                advisor_per_day: shared_per_day.or(Some(if a.limited { crate::advisor::DAILY_LIMITED } else { crate::advisor::DAILY_INVITED })),
                watch_at_a_time: Some((if a.limited { crate::watch::OPEN_MAX_WATCH_GAMES } else { crate::watch::MAX_WATCH_GAMES }) as i64),
            }
        };
        t.accounts += 1;
        t.open_signup_accounts += i64::from(a.limited);
        t.disabled += i64::from(a.disabled);
        t.decks += a.decks;
        t.games_logged += a.games_logged;
        t.lab_games_today += a.lab_games_today;
        t.lab_games_queued += a.lab_games_queued;
        t.advisor_today += a.advisor_today;
        t.watch_running += a.watch_running;
        if a.limited {
            t.lab_open_queue_games += a.lab_games_queued;
        }
    }
    t.seen_today = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE last_seen_at > ?").bind(&since).fetch_one(&st.pool).await?;
    t.lab_queue_cap = quota.queue_games;
    t.lab_open_queue_cap = quota.open_queue_games;
    t.online_games_live = st.play.live_count() as i64;
    Ok(Json(Usage { accounts, totals: t }))
}

// ── the server ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ServerInfo {
    version: &'static str,
    started_at: String,
    engine: EngineInfo,
    scryfall: Vec<ImportInfo>,
    calendar: CalendarInfo,
    database: DatabaseInfo,
    prices: PricesInfo,
    backups: Vec<FileInfo>,
    lab: LabInfo,
    /// The Forge worker (Forge as a second Lab engine).
    forge: ForgeInfo,
    watch: Vec<WatchInfo>,
    advisor: AdvisorInfo,
    sign_in: SignInInfo,
}

#[derive(Serialize)]
struct ForgeInfo {
    #[serde(flatten)]
    worker: crate::lab::forge::ForgeView,
    /// Forge games waiting to be played, everyone's.
    games_waiting: i64,
}

#[derive(Serialize)]
struct EngineInfo {
    /// The label every lab result carries.
    label: &'static str,
    runner: &'static str,
    /// ready | loading | off | failed
    status: &'static str,
    cards: Option<usize>,
    why: Option<String>,
    card_data_file: Option<String>,
    live_online_games: usize,
}

#[derive(Serialize, sqlx::FromRow)]
struct ImportInfo {
    kind: String,
    started_at: String,
    finished_at: Option<String>,
    source_updated_at: Option<String>,
    rows: Option<i64>,
    error: Option<String>,
}

#[derive(Serialize)]
struct CalendarInfo {
    sets_checked_at: Option<String>,
    precons: i64,
    precons_fetched_at: Option<String>,
}

#[derive(Serialize)]
struct DatabaseInfo {
    file: Option<String>,
    bytes: Option<u64>,
    wal_bytes: Option<u64>,
}

/// The price history (prices/): the newest day read, its size, and how it compares with the old
/// daily table it replaced.
#[derive(Serialize)]
struct PricesInfo {
    newest_day: Option<String>,
    /// Days read.
    days: i64,
    /// The one replay of the old table, when it ran: rows compared, mismatches, stale prices.
    backfill: Option<serde_json::Value>,
    /// The newest day's check against the old table.
    newest_check: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct FileInfo {
    name: String,
    bytes: u64,
    modified: Option<String>,
}

#[derive(Serialize)]
struct LabInfo {
    threads: usize,
    /// Null when experiments can run; otherwise why not.
    unavailable: Option<String>,
    queued: i64,
    running: i64,
    games_waiting: i64,
    global_runs: i64,
}

#[derive(Serialize)]
struct WatchInfo {
    #[serde(flatten)]
    item: crate::watch::AdminWatchItem,
    owner_email: Option<String>,
    owner_name: Option<String>,
}

#[derive(Serialize)]
struct AdvisorInfo {
    /// The sidecar's address and shared secret are set.
    enabled: bool,
    /// Whether the sidecar answered its health check (null when the advisor is off).
    reachable: Option<bool>,
    /// The sidecar holds a subscription token (null when it didn't answer).
    subscription_connected: Option<bool>,
    subscription_accounts: usize,
    /// The server can store people's own API keys.
    own_keys_enabled: bool,
    own_keys_saved: i64,
    questions_today: i64,
    /// The sidecar holds the shared API key (null when it didn't answer).
    shared_key: Option<bool>,
    /// Accounts granted the shared key.
    shared_accounts: i64,
    /// What shared questions cost this calendar month (UTC), and the cap.
    shared_spent_this_month: f64,
    shared_monthly_usd: f64,
    /// By name ("Claude Haiku 5.5").
    shared_models: Vec<&'static str>,
}

#[derive(Serialize)]
struct SignInInfo {
    google: bool,
    open_signup: bool,
    password: bool,
    dev_login: bool,
    cloudflare_access: bool,
    admin_emails: usize,
}

fn file_info(path: &std::path::Path) -> Option<(u64, Option<String>)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok().map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
    Some((meta.len(), modified))
}

/// The database file from `DATABASE_URL` (`sqlite://path` or `sqlite:path`); none for memory.
fn database_path(url: &str) -> Option<std::path::PathBuf> {
    let rest = url.strip_prefix("sqlite://").or_else(|| url.strip_prefix("sqlite:"))?;
    let path = rest.split('?').next()?;
    (!path.is_empty() && !path.contains(":memory:")).then(|| std::path::PathBuf::from(path))
}

/// The newest backups in `<data dir>/backups` (deploy.sh writes one before each restart).
fn backups(dir: &std::path::Path) -> Vec<FileInfo> {
    let Ok(entries) = std::fs::read_dir(dir.join("backups")) else { return vec![] };
    let mut out: Vec<FileInfo> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let (bytes, modified) = file_info(&e.path())?;
            Some(FileInfo { name: e.file_name().to_string_lossy().into_owned(), bytes, modified })
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then(b.name.cmp(&a.name)));
    out.truncate(10);
    out
}

async fn server(State(st): State<AppState>, AdminUser(_): AdminUser) -> AppResult<Json<ServerInfo>> {
    let pool = &st.pool;
    let (status, cards, why) = st.play.engine_status();
    let scryfall: Vec<ImportInfo> = sqlx::query_as(
        "SELECT kind, started_at, finished_at, source_updated_at, rows, error FROM import_runs r
          WHERE started_at = (SELECT MAX(started_at) FROM import_runs x WHERE x.kind = r.kind) ORDER BY kind",
    )
    .fetch_all(pool)
    .await?;
    let sets_checked_at: Option<String> = sqlx::query_scalar("SELECT MAX(checked_at) FROM calendar_sets").fetch_one(pool).await?;
    let (precons, precons_fetched_at): (i64, Option<String>) =
        sqlx::query_as("SELECT COUNT(*), MAX(list_fetched_at) FROM calendar_precons").fetch_one(pool).await?;
    let days: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM price_observation").fetch_one(pool).await?;
    let newest_day = crate::prices::latest_date(pool).await?;
    let meta = |key: String| async move {
        let text: Option<String> = sqlx::query_scalar("SELECT value FROM price_meta WHERE key = ?").bind(key).fetch_optional(pool).await?;
        AppResult::Ok(text.and_then(|t| serde_json::from_str(&t).ok()))
    };
    let prices = PricesInfo {
        backfill: meta("backfill".into()).await?,
        newest_check: match &newest_day {
            Some(d) => meta(format!("verify:{d}")).await?,
            None => None,
        },
        newest_day,
        days,
    };
    let db_file = database_path(&st.cfg.database_url);
    let database = DatabaseInfo {
        bytes: db_file.as_deref().and_then(file_info).map(|f| f.0),
        wal_bytes: db_file.as_ref().and_then(|p| file_info(&std::path::PathBuf::from(format!("{}-wal", p.display())))).map(|f| f.0),
        file: db_file.map(|p| p.display().to_string()),
    };
    let (queued, running, games_waiting): (i64, i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(status = 'queued'), 0), COALESCE(SUM(status = 'running'), 0),
                COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN games_total - games_done ELSE 0 END), 0)
           FROM lab_experiments",
    )
    .fetch_one(pool)
    .await?;
    let global_runs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_runs WHERE owner_id IS NULL").fetch_one(pool).await?;
    let forge_waiting: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM lab_experiment_games g JOIN lab_experiments e ON e.id = g.experiment_id
          WHERE g.engine = 'forge' AND g.result IS NULL AND e.status IN ('queued','running')",
    )
    .fetch_one(pool)
    .await?;
    let owners: HashMap<String, (String, String)> = sqlx::query_as::<_, (String, String, String)>("SELECT id, email, display_name FROM users")
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(|(id, email, name)| (id, (email, name)))
        .collect();
    let watch = st
        .watch
        .admin_items()
        .into_iter()
        .map(|item| {
            let owner = owners.get(&item.owner_id);
            WatchInfo { owner_email: owner.map(|o| o.0.clone()), owner_name: owner.map(|o| o.1.clone()), item }
        })
        .collect();
    let adv = &st.cfg.advisor;
    let health = if adv.enabled() { Some(crate::advisor::sidecar_health(&st).await) } else { None };
    let advisor = AdvisorInfo {
        enabled: adv.enabled(),
        reachable: health.as_ref().map(Option::is_some),
        subscription_connected: health.flatten().and_then(|h| h.subscription),
        shared_key: health.flatten().and_then(|h| h.shared),
        shared_accounts: sqlx::query_scalar("SELECT COUNT(*) FROM advisor_shared_access").fetch_one(pool).await?,
        shared_spent_this_month: crate::advisor::shared::spent_this_month(pool).await?,
        shared_monthly_usd: adv.shared_monthly_usd,
        shared_models: crate::advisor::shared_model_labels(adv),
        subscription_accounts: adv.subscription_emails.len(),
        own_keys_enabled: adv.enabled() && adv.key_secret.is_some(),
        own_keys_saved: sqlx::query_scalar("SELECT COUNT(*) FROM advisor_keys").fetch_one(pool).await?,
        questions_today: sqlx::query_scalar("SELECT COUNT(*) FROM advisor_usage WHERE created_at > ?").bind(day_ago()).fetch_one(pool).await?,
    };
    let cfg = &st.cfg;
    Ok(Json(ServerInfo {
        version: env!("YAMA_SERVER_VERSION"),
        started_at: STARTED_AT.clone(),
        engine: EngineInfo {
            label: yama_play::lab::ENGINE,
            runner: yama_play::lab::RUNNER,
            status,
            cards,
            why,
            card_data_file: cfg.engine_card_data.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()),
            live_online_games: st.play.live_count(),
        },
        scryfall,
        calendar: CalendarInfo { sets_checked_at, precons, precons_fetched_at },
        database,
        prices,
        backups: backups(&cfg.data_dir),
        lab: LabInfo {
            threads: st.lab.threads(),
            unavailable: st.lab.check_available().err().map(|e| e.to_string()),
            queued,
            running,
            games_waiting,
            global_runs,
        },
        forge: ForgeInfo { worker: st.lab.forge_view(), games_waiting: forge_waiting },
        watch,
        advisor,
        sign_in: SignInInfo {
            google: !cfg.google_client_ids.is_empty(),
            open_signup: cfg.open_signup && !cfg.google_client_ids.is_empty(),
            password: cfg.password_login,
            dev_login: cfg.dev_login,
            cloudflare_access: st.cf_keys.is_some(),
            admin_emails: cfg.admin_emails.len(),
        },
    }))
}

/// Request, statement and job timings since the server started (`perf.rs`), for Admin, Server.
async fn perf(AdminUser(_): AdminUser) -> Json<crate::perf::Summary> {
    Json(crate::perf::summary())
}

async fn stop_watch(State(st): State<AppState>, AdminUser(admin): AdminUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    if !st.watch.admin_stop(&id) {
        return Err(AppError::NotFound("game"));
    }
    tracing::info!(by = %admin.email, game = %id, "watched game stopped by an admin");
    Ok(StatusCode::NO_CONTENT)
}

// ── global lab runs ────────────────────────────────────────────────────────

#[derive(Serialize, sqlx::FromRow)]
struct LabRunItem {
    id: String,
    name: String,
    kind: String,
    engine: Option<String>,
    difficulty: Option<String>,
    games: i64,
    decks: i64,
    created_at: String,
    imported_at: String,
}

async fn lab_runs(State(st): State<AppState>, AdminUser(_): AdminUser) -> AppResult<Json<Vec<LabRunItem>>> {
    Ok(Json(
        sqlx::query_as(
            "SELECT r.id, r.name, r.kind, r.engine, r.difficulty, r.games, r.created_at, r.imported_at,
                    (SELECT COUNT(*) FROM lab_ratings x WHERE x.run_id = r.id) AS decks
               FROM lab_runs r WHERE r.owner_id IS NULL ORDER BY r.imported_at DESC, r.name",
        )
        .fetch_all(&st.pool)
        .await?,
    ))
}

#[derive(Deserialize)]
struct RenameBody {
    name: String,
}

/// Longest run name.
const MAX_RUN_NAME: usize = 80;

async fn rename_lab_run(
    State(st): State<AppState>,
    AdminUser(_): AdminUser,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> AppResult<StatusCode> {
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > MAX_RUN_NAME {
        return Err(AppError::bad(format!("a run's name is 1 to {MAX_RUN_NAME} characters")));
    }
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM lab_runs WHERE owner_id IS NULL AND name = ? AND id != ?)")
        .bind(name)
        .bind(&id)
        .fetch_one(&st.pool)
        .await?;
    if taken {
        return Err(AppError::Conflict(format!("another run is already called {name}")));
    }
    let n = sqlx::query("UPDATE lab_runs SET name = ? WHERE id = ? AND owner_id IS NULL").bind(name).bind(&id).execute(&st.pool).await?.rows_affected();
    if n == 0 { Err(AppError::NotFound("run")) } else { Ok(StatusCode::NO_CONTENT) }
}

async fn delete_lab_run(State(st): State<AppState>, AdminUser(admin): AdminUser, Path(id): Path<String>) -> AppResult<StatusCode> {
    let name: Option<String> = sqlx::query_scalar("DELETE FROM lab_runs WHERE id = ? AND owner_id IS NULL RETURNING name").bind(&id).fetch_optional(&st.pool).await?;
    let name = name.ok_or(AppError::NotFound("run"))?;
    tracing::info!(by = %admin.email, run = %name, "global lab run deleted");
    Ok(StatusCode::NO_CONTENT)
}
