//! Owner-scoped Phase execution pilot. Leases fence stale uploads; entire paired pods commit
//! together. Comparison copies never enter lab_experiment_games or deck ratings.
use super::experiments::{ExperimentSpec, Mode};
use super::process::Request;
use super::stats::Build;
use crate::auth::CurrentUser;
use crate::error::{AppError, AppResult};
use crate::routes::AppState;
use crate::util::{new_id, now, sha256_hex};
use axum::extract::{DefaultBodyLimit, FromRequestParts, Path, State};
use axum::http::request::Parts;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool};
use std::collections::BTreeMap;
use yama_play::lab::{End, GameResult, GameSpec};

const LEASE_SECONDS: i64 = 180;
const ONLINE_SECONDS: i64 = 45;
const TARGETS: [&str; 3] = ["saget", "laptop", "github"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/lab/executions", post(create_handler))
        .route("/api/lab/executions/{id}", get(report_handler))
        .route("/api/lab/executions/{id}/cancel", post(cancel_handler))
        .route("/api/lab/executions/{id}/budget", post(budget_handler))
        .route("/api/lab/workers/claim", post(claim_handler))
        .route("/api/lab/workers/runtime", get(runtime_handler))
        .route("/api/lab/workers/runtime/{kind}", get(download_handler))
        .route(
            "/api/lab/workers/leases/{id}/heartbeat",
            post(heartbeat_handler),
        )
        .route("/api/lab/workers/leases/{id}/results", post(submit_handler))
        .route(
            "/api/lab/workers/leases/{id}/release",
            post(release_handler),
        )
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
}

#[derive(Clone)]
struct Worker {
    owner: String,
    token: String,
    target: String,
}

impl FromRequestParts<AppState> for Worker {
    type Rejection = AppError;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> AppResult<Self> {
        let key = parts
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(AppError::Unauthorized)?;
        // Session cookies, MCP keys and plan-sync keys cannot use this API.
        for target in TARGETS {
            if let Some(owner) =
                crate::plan::tokens::user_for_key(&st.pool, key, &format!("lab:worker:{target}"))
                    .await?
                && owner.is_admin
                && (st.cfg.open_signup || !owner.limited)
            {
                let token = sqlx::query_scalar("SELECT id FROM api_tokens WHERE token_hash=?")
                    .bind(sha256_hex(key))
                    .fetch_one(&st.pool)
                    .await?;
                return Ok(Self {
                    owner: owner.id,
                    token,
                    target: target.into(),
                });
            }
        }
        Err(AppError::Unauthorized)
    }
}

#[derive(Deserialize, Serialize)]
struct NewExecution {
    /// Client-generated UUID; identical retries return the original execution.
    id: String,
    experiment_id: String,
    #[serde(default = "auto")]
    target: String,
    #[serde(default)]
    comparison: bool,
    #[serde(default)]
    targets: Vec<String>,
    #[serde(default = "sample")]
    sample_units: usize,
    /// Conservative work reservation, not GitHub account billing enforcement. Zero disables GH.
    #[serde(default)]
    github_minutes: i64,
}
fn auto() -> String {
    "auto".into()
}
fn sample() -> usize {
    3
}

async fn create_handler(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Json(body): Json<NewExecution>,
) -> AppResult<Json<Value>> {
    if !user.is_admin {
        return Err(AppError::Forbidden(
            "Remote execution is an admin pilot".into(),
        ));
    }
    let sim = st
        .lab
        .ready()
        .ok_or_else(|| AppError::Unavailable("The Phase runtime is not ready".into()))?;
    let build = super::worker::current_build(sim.as_ref());
    let id = create(&st.pool, &user.id, &body, &build).await?;
    Ok(Json(report(&st.pool, &user.id, &id).await?))
}

async fn create(
    pool: &SqlitePool,
    owner: &str,
    body: &NewExecution,
    execution_build: &Build,
) -> AppResult<String> {
    if uuid::Uuid::parse_str(&body.id).is_err()
        || !["auto", "saget", "laptop", "github"].contains(&body.target.as_str())
        || !(1..=10).contains(&body.sample_units)
        || !(0..=10_000).contains(&body.github_minutes)
    {
        return Err(AppError::bad(
            "Use a UUID, a supported target, 1–10 sample units and 0–10000 GitHub work minutes",
        ));
    }
    let targets = if body.comparison {
        body.targets.clone()
    } else {
        vec![body.target.clone()]
    };
    if body.comparison
        && (targets.len() < 2
            || targets.len() > 3
            || targets.iter().any(|t| !TARGETS.contains(&t.as_str()))
            || targets
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != targets.len())
    {
        return Err(AppError::bad(
            "A comparison needs two or three distinct execution targets",
        ));
    }
    let hash = sha256_hex(&serde_json::to_string(body).map_err(anyhow::Error::from)?);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let existing: Option<(String, String)> =
        sqlx::query_as("SELECT owner_id, request_hash FROM lab_execution_runs WHERE id=?")
            .bind(&body.id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((who, original)) = existing {
        if who != owner {
            return Err(AppError::NotFound("execution"));
        }
        if original != hash {
            return Err(AppError::Conflict(
                "Execution id already used for another request".into(),
            ));
        }
        return Ok(body.id.clone());
    }
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT spec,status FROM lab_experiments WHERE id=? AND owner_id=?")
            .bind(&body.experiment_id)
            .bind(owner)
            .fetch_optional(&mut *tx)
            .await?;
    let Some((text, status)) = row else {
        return Err(AppError::NotFound("experiment"));
    };
    if status == "cancelled" {
        return Err(AppError::Conflict("Experiment is cancelled".into()));
    }
    let frozen: ExperimentSpec = serde_json::from_str(&text).map_err(anyhow::Error::from)?;
    if !body.comparison {
        let started: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lab_experiment_games WHERE experiment_id=? AND engine='phase' AND (attempts>0 OR result IS NOT NULL))")
            .bind(&body.experiment_id).fetch_one(&mut *tx).await?;
        let routed: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lab_execution_runs WHERE experiment_id=? AND comparison=0)")
            .bind(&body.experiment_id).fetch_one(&mut *tx).await?;
        if started || routed || !["queued", "running"].contains(&status.as_str()) {
            return Err(AppError::Conflict(
                "Route Phase before its first game starts; use comparison for an existing run"
                    .into(),
            ));
        }
    }
    let lists: BTreeMap<_, _> = std::iter::once(frozen.base)
        .chain(frozen.variant)
        .chain(frozen.entrants)
        .chain(frozen.opponents.into_iter().map(|o| o.list))
        .map(|l| (l.id.clone(), l))
        .collect();
    let rows: Vec<(i64, String)> = sqlx::query_as("SELECT ord,spec FROM lab_experiment_games WHERE experiment_id=? AND engine='phase' ORDER BY ord")
        .bind(&body.experiment_id).fetch_all(&mut *tx).await?;
    if rows.is_empty() {
        return Err(AppError::bad("This pilot requires Phase games"));
    }
    let mut units: BTreeMap<i64, Vec<Request>> = BTreeMap::new();
    for (ord, text) in rows {
        let spec: GameSpec = serde_json::from_str(&text).map_err(anyhow::Error::from)?;
        if spec.pilots.iter().flatten().any(|p| p.starts_with("llm:")) {
            return Err(AppError::bad("The worker pilot supports heuristic AI only"));
        }
        let decks = spec
            .decks
            .iter()
            .map(|id| {
                lists
                    .get(id)
                    .cloned()
                    .ok_or_else(|| AppError::bad("Missing frozen deck"))
            })
            .collect::<AppResult<Vec<_>>>()?;
        let unit = if matches!(frozen.mode, Mode::Change | Mode::Compare) {
            ord / 2
        } else {
            ord
        };
        units.entry(unit).or_default().push(Request {
            spec,
            decks,
            limits: frozen.limits,
            card_data: execution_build.card_data.clone(),
        });
    }
    if targets.iter().any(|t| t == "github") {
        let required = units
            .values()
            .take(if body.comparison {
                body.sample_units
            } else {
                usize::MAX
            })
            .fold(0i64, |sum, requests| {
                sum.saturating_add(work_minutes(requests))
            });
        if body.github_minutes < required {
            return Err(AppError::Invalid {
                message: format!("This execution requires at least {required} GitHub work minutes"),
                details: json!({"required_github_minutes":required}),
            });
        }
    }
    let expected = serde_json::to_string(&Build {
        engine: execution_build.engine.clone(),
        card_data: execution_build.card_data.clone(),
        runner: source(&execution_build.runner).into(),
    })
    .map_err(anyhow::Error::from)?;
    sqlx::query("INSERT INTO lab_execution_runs (id,experiment_id,owner_id,request_hash,comparison,target,github_minutes,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(&body.id).bind(&body.experiment_id).bind(owner).bind(hash).bind(body.comparison).bind(&body.target).bind(body.github_minutes).bind(now())
        .execute(&mut *tx).await?;
    for (unit, requests) in units.into_iter().take(if body.comparison {
        body.sample_units
    } else {
        usize::MAX
    }) {
        let requests = serde_json::to_string(&requests).map_err(anyhow::Error::from)?;
        for target in &targets {
            sqlx::query("INSERT INTO lab_worker_jobs (id,run_id,unit,target,requests,expected_build) VALUES (?,?,?,?,?,?)")
                .bind(new_id()).bind(&body.id).bind(unit).bind(target).bind(&requests).bind(&expected).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(body.id.clone())
}

fn source(runner: &str) -> &str {
    runner.split('/').next().unwrap_or(runner)
}

fn work_minutes(requests: &[Request]) -> i64 {
    requests.iter().fold(2i64, |sum, r| {
        sum.saturating_add(
            i64::try_from(r.spec.max_seconds.saturating_mul(4).saturating_add(89) / 60)
                .unwrap_or(i64::MAX),
        )
    })
}
fn compatible(expected: &Build, offered: &Build) -> bool {
    expected.engine == offered.engine
        && expected.card_data == offered.card_data
        && source(&expected.runner) == source(&offered.runner)
        && offered.runner.contains("/isolated-")
}

#[derive(Deserialize)]
struct Claim {
    worker_id: String,
    build: Build,
    ready: bool,
    #[serde(default)]
    execution_id: Option<String>,
}

#[derive(Serialize)]
struct Lease {
    id: String,
    job_id: String,
    expires: i64,
    heartbeat_seconds: u32,
    requests: Value,
    build: Build,
}

async fn claim_handler(
    State(st): State<AppState>,
    worker: Worker,
    Json(body): Json<Claim>,
) -> AppResult<Json<Option<Lease>>> {
    let build = st
        .lab
        .ready()
        .map(|sim| super::worker::current_build(sim.as_ref()));
    Ok(Json(claim(&st.pool, &worker, body, build.as_ref()).await?))
}

async fn claim(
    pool: &SqlitePool,
    worker: &Worker,
    body: Claim,
    current: Option<&Build>,
) -> AppResult<Option<Lease>> {
    if uuid::Uuid::parse_str(&body.worker_id).is_err()
        || body
            .execution_id
            .as_ref()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_err())
        || body.build.runner.len() > 300
        || body.build.engine.len() > 200
        || body.build.card_data.len() > 128
    {
        return Err(AppError::bad("Invalid worker identity or build"));
    }
    let clock = chrono::Utc::now().timestamp();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let held: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lab_worker_jobs WHERE worker_id=? AND expires>? AND result IS NULL)")
        .bind(&body.worker_id).bind(clock).fetch_one(&mut *tx).await?;
    let build = serde_json::to_string(&body.build).map_err(anyhow::Error::from)?;
    let historical: Option<f64> = sqlx::query_scalar(
        "SELECT AVG(json_extract(j.result,'$.wall_seconds') / json_array_length(j.result,'$.results'))
         FROM lab_worker_jobs j JOIN lab_execution_runs r ON r.id=j.run_id JOIN lab_worker_instances w ON w.id=j.worker_id
         WHERE r.owner_id=? AND w.target=? AND j.build=? AND j.result IS NOT NULL
           AND NOT EXISTS(SELECT 1 FROM json_each(j.result,'$.results') x WHERE json_extract(x.value,'$.end') NOT IN ('win','draw','turn_cap','action_cap'))")
        .bind(&worker.owner).bind(&worker.target).bind(&build).fetch_one(&mut *tx).await?;
    // A worker UUID belongs permanently to one key; a different owner cannot take it over.
    let changed = sqlx::query("INSERT INTO lab_worker_instances (id,token_id,owner_id,target,build,ready,seen,seconds_per_game,execution_id) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET build=excluded.build,ready=excluded.ready,seen=excluded.seen,seconds_per_game=excluded.seconds_per_game,execution_id=excluded.execution_id WHERE token_id=excluded.token_id")
        .bind(&body.worker_id).bind(&worker.token).bind(&worker.owner).bind(&worker.target).bind(&build).bind(body.ready && !held).bind(clock)
        .bind(historical.unwrap_or(120.0).clamp(0.1,86400.0))
        .bind(&body.execution_id)
        .execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Err(AppError::Conflict(
            "Worker UUID belongs to another key".into(),
        ));
    }
    if !body.ready || held {
        tx.commit().await?;
        return Ok(None);
    }
    let failed_until: i64 =
        sqlx::query_scalar("SELECT failed_until FROM lab_worker_instances WHERE id=?")
            .bind(&body.worker_id)
            .fetch_one(&mut *tx)
            .await?;
    let mut after = 0i64;
    loop {
        let jobs: Vec<(String,String,String,String,i64,i64,bool,String,i64)> = sqlx::query_as(
        "SELECT j.id,j.requests,j.expected_build,j.target,r.github_minutes,r.github_reserved,r.comparison,r.id,j.rowid
         FROM lab_worker_jobs j JOIN lab_execution_runs r ON r.id=j.run_id JOIN lab_experiments e ON e.id=r.experiment_id
         WHERE r.owner_id=? AND r.cancelled_at IS NULL AND j.result IS NULL AND (j.expires IS NULL OR j.expires<=?)
           AND e.status!='cancelled' AND (r.comparison=1 OR e.status IN ('queued','running'))
           AND (j.target=? OR j.target='auto') AND (? IS NULL OR r.id=?) AND j.rowid>? ORDER BY j.rowid LIMIT 100")
        .bind(&worker.owner).bind(clock).bind(&worker.target).bind(&body.execution_id).bind(&body.execution_id).bind(after).fetch_all(&mut *tx).await?;
        if jobs.is_empty() {
            break;
        }
        for (job_id, mut requests, expected, target, budget, reserved, comparison, run_id, rowid) in
            jobs
        {
            after = rowid;
            let mut expected: Build =
                serde_json::from_str(&expected).map_err(anyhow::Error::from)?;
            if let Some(current) = current
                && !compatible(&expected, current)
            {
                if comparison {
                    sqlx::query("UPDATE lab_execution_runs SET cancelled_at=?,cancel_reason='runtime_changed' WHERE id=?")
                    .bind(now()).bind(&run_id).execute(&mut *tx).await?;
                    continue;
                }
                // Pending production pods adopt the current runtime as a whole. Completed pods retain
                // their recorded build; a stale in-flight attempt is still fenced by its lease ID.
                expected = current.clone();
                expected.runner = source(&expected.runner).to_string();
                let mut updated: Vec<Request> =
                    serde_json::from_str(&requests).map_err(anyhow::Error::from)?;
                for request in &mut updated {
                    request.card_data = expected.card_data.clone();
                }
                requests = serde_json::to_string(&updated).map_err(anyhow::Error::from)?;
                sqlx::query("UPDATE lab_worker_jobs SET expected_build=?,requests=? WHERE id=?")
                    .bind(serde_json::to_string(&expected).map_err(anyhow::Error::from)?)
                    .bind(&requests)
                    .bind(&job_id)
                    .execute(&mut *tx)
                    .await?;
            }
            if !comparison && failed_until > clock {
                continue;
            }
            if !compatible(&expected, &body.build) {
                continue;
            }
            let parsed: Vec<Request> =
                serde_json::from_str(&requests).map_err(anyhow::Error::from)?;
            // Reserve the full outer deadlines plus two minutes of setup. This bounds leased work,
            // not billed workflow startup/storage. Account spending controls remain separate.
            let minutes = work_minutes(&parsed);
            if worker.target == "github" && reserved + minutes > budget {
                continue;
            }
            if target == "auto" {
                let candidates: Vec<(String,String,String,f64)> = sqlx::query_as(
                "SELECT w.id,w.target,w.build,w.seconds_per_game FROM lab_worker_instances w JOIN api_tokens t ON t.id=w.token_id
                 WHERE w.owner_id=? AND w.ready=1 AND w.seen>? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?)
                 AND (w.execution_id IS NULL OR w.execution_id=?)
                 AND w.failed_until<=?
                 AND NOT EXISTS(SELECT 1 FROM lab_worker_jobs j WHERE j.worker_id=w.id AND j.result IS NULL AND j.expires>?) ORDER BY w.id")
                .bind(&worker.owner).bind(clock-ONLINE_SECONDS).bind(now()).bind(&run_id).bind(clock).bind(clock).fetch_all(&mut *tx).await?;
                let chosen = candidates
                    .into_iter()
                    .filter_map(|(id, t, b, pace)| {
                        let b: Build = serde_json::from_str(&b).ok()?;
                        (compatible(&expected, &b)
                            && (t != "github" || reserved + minutes <= budget))
                            .then_some((id, pace))
                    })
                    .min_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
                if chosen.is_some_and(|(id, _)| id != body.worker_id) {
                    continue;
                }
            }
            let lease_id = new_id();
            let expires = clock + LEASE_SECONDS;
            sqlx::query("UPDATE lab_worker_jobs SET lease_id=?,worker_id=?,expires=?,leased_at=?,build=? WHERE id=?")
            .bind(&lease_id).bind(&body.worker_id).bind(expires).bind(now()).bind(&build).bind(&job_id).execute(&mut *tx).await?;
            sqlx::query("UPDATE lab_worker_instances SET ready=0 WHERE id=?")
                .bind(&body.worker_id)
                .execute(&mut *tx)
                .await?;
            if worker.target == "github" {
                sqlx::query("UPDATE lab_execution_runs SET github_reserved=github_reserved+? WHERE id=(SELECT run_id FROM lab_worker_jobs WHERE id=?)")
                .bind(minutes).bind(&job_id).execute(&mut *tx).await?;
            }
            sqlx::query("UPDATE lab_experiments SET status='running',started_at=COALESCE(started_at,?),updated_at=? WHERE id=(SELECT r.experiment_id FROM lab_execution_runs r JOIN lab_worker_jobs j ON j.run_id=r.id WHERE j.id=? AND r.comparison=0)")
            .bind(now()).bind(now()).bind(&job_id).execute(&mut *tx).await?;
            tx.commit().await?;
            return Ok(Some(Lease {
                id: lease_id,
                job_id,
                expires,
                heartbeat_seconds: 30,
                requests: serde_json::from_str(&requests).map_err(anyhow::Error::from)?,
                build: body.build,
            }));
        }
    }
    tx.commit().await?;
    Ok(None)
}

async fn live_lease(
    conn: &mut SqliteConnection,
    worker: &Worker,
    id: &str,
) -> AppResult<(String, String, String, bool)> {
    let row = sqlx::query_as(
        "SELECT j.id,j.requests,r.experiment_id,r.comparison FROM lab_worker_jobs j JOIN lab_execution_runs r ON r.id=j.run_id
         JOIN lab_worker_instances w ON w.id=j.worker_id JOIN lab_experiments e ON e.id=r.experiment_id
         WHERE j.lease_id=? AND w.token_id=? AND r.owner_id=? AND j.result IS NULL AND j.expires>?
           AND r.cancelled_at IS NULL AND e.status!='cancelled'")
        .bind(id).bind(&worker.token).bind(&worker.owner).bind(chrono::Utc::now().timestamp()).fetch_optional(conn).await?;
    row.ok_or_else(|| AppError::Conflict("Lease expired, released or cancelled".into()))
}

async fn heartbeat_handler(
    State(st): State<AppState>,
    worker: Worker,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    live_lease(&mut tx, &worker, &id).await?;
    let expires = chrono::Utc::now().timestamp() + LEASE_SECONDS;
    sqlx::query("UPDATE lab_worker_jobs SET expires=? WHERE lease_id=?")
        .bind(expires)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"expires":expires})))
}

async fn release_handler(
    State(st): State<AppState>,
    worker: Worker,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let mut tx = st.pool.begin_with("BEGIN IMMEDIATE").await?;
    live_lease(&mut tx, &worker, &id).await?;
    sqlx::query("UPDATE lab_worker_jobs SET expires=0,lease_id=NULL WHERE lease_id=?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"released":true})))
}

#[derive(Deserialize, Serialize)]
struct Submission {
    results: Vec<GameResult>,
    wall_seconds: f64,
    peak_rss_bytes: u64,
    #[serde(default)]
    setup_seconds: f64,
}

fn validate(requests: &[Request], body: &Submission, build: &Build) -> AppResult<()> {
    if requests.len() != body.results.len()
        || !body.wall_seconds.is_finite()
        || !(0.0..=86400.0).contains(&body.wall_seconds)
        || !body.setup_seconds.is_finite()
        || !(0.0..=86400.0).contains(&body.setup_seconds)
    {
        return Err(AppError::bad(
            "Submit every game in the lease with finite timing measurements",
        ));
    }
    for (q, r) in requests.iter().zip(&body.results) {
        if r.game != q.spec.game
            || r.seed != q.spec.seed
            || r.decks != q.spec.decks
            || r.difficulty != q.spec.difficulty
            || r.pilots != q.spec.pilots
            || r.engine != build.engine
            || r.card_data != build.card_data
            || r.runner != build.runner
        {
            return Err(AppError::bad(
                "Result does not match the leased schedule and build",
            ));
        }
        let n = q.spec.decks.len();
        let seats: Vec<_> = r.placements.iter().flatten().copied().collect();
        let scored = matches!(r.end, End::Win | End::Draw | End::TurnCap | End::ActionCap);
        if r.winner.is_some_and(|s| s as usize >= n)
            || r.eliminations.iter().any(|e| e.seat as usize >= n)
            || r.first_seat.is_some_and(|s| s as usize >= n)
            || seats.iter().any(|s| *s as usize >= n)
            || seats.iter().collect::<std::collections::HashSet<_>>().len() != seats.len()
            || (scored
                && (seats.len() != n
                    || r.final_life.len() != n
                    || (r.end == End::Win) != r.winner.is_some()))
        {
            return Err(AppError::bad("Invalid result seats or scored outcome"));
        }
    }
    Ok(())
}

async fn submit_handler(
    State(st): State<AppState>,
    worker: Worker,
    Path(id): Path<String>,
    Json(body): Json<Submission>,
) -> AppResult<Json<Value>> {
    submit(&st.pool, &worker, &id, &body).await?;
    Ok(Json(json!({"accepted":true})))
}

async fn submit(pool: &SqlitePool, worker: &Worker, id: &str, body: &Submission) -> AppResult<()> {
    let text = serde_json::to_string(body).map_err(anyhow::Error::from)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    // Lost acknowledgments are safe even after lease expiration. A conflicting retry is an error.
    let previous: Option<String>=sqlx::query_scalar(
        "SELECT j.result FROM lab_worker_jobs j JOIN lab_execution_runs r ON r.id=j.run_id JOIN lab_worker_instances w ON w.id=j.worker_id
         WHERE j.submitted_lease=? AND r.owner_id=? AND w.token_id=?")
        .bind(id).bind(&worker.owner).bind(&worker.token).fetch_optional(&mut *tx).await?;
    if let Some(previous) = previous {
        return if previous == text {
            Ok(())
        } else {
            Err(AppError::Conflict(
                "Different results already submitted for this lease".into(),
            ))
        };
    }
    let (job, requests, experiment, comparison) = live_lease(&mut tx, worker, id).await?;
    let build: String = sqlx::query_scalar("SELECT build FROM lab_worker_jobs WHERE id=?")
        .bind(&job)
        .fetch_one(&mut *tx)
        .await?;
    let requests: Vec<Request> = serde_json::from_str(&requests).map_err(anyhow::Error::from)?;
    let build: Build = serde_json::from_str(&build).map_err(anyhow::Error::from)?;
    validate(&requests, body, &build)?;
    if !comparison {
        for result in &body.results {
            sqlx::query("UPDATE lab_experiment_games SET result=?,end_kind=?,finished_at=? WHERE experiment_id=? AND game=? AND result IS NULL")
                .bind(result.to_line()).bind(result.end.as_str()).bind(now()).bind(&experiment).bind(&result.game).execute(&mut *tx).await?;
        }
        super::worker::refresh(&mut tx, &experiment, false).await?;
    }
    sqlx::query("UPDATE lab_worker_jobs SET result=?,submitted_lease=?,finished_at=?,expires=NULL WHERE id=?")
        .bind(text).bind(id).bind(now()).bind(&job).execute(&mut *tx).await?;
    let pace = (body.wall_seconds / (body.results.len().max(1) as f64)).clamp(0.1, 86400.0);
    let healthy = body
        .results
        .iter()
        .all(|r| matches!(r.end, End::Win | End::Draw | End::TurnCap | End::ActionCap));
    let clock = chrono::Utc::now().timestamp();
    sqlx::query("UPDATE lab_worker_instances SET seconds_per_game=CASE WHEN ? THEN ? ELSE seconds_per_game END,seen=?,failed_until=?,ready=0 WHERE id=(SELECT worker_id FROM lab_worker_jobs WHERE id=?)")
        .bind(healthy).bind(pace).bind(clock).bind(if healthy {0} else {clock+300}).bind(&job).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

async fn report_handler(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    Ok(Json(report(&st.pool, &user.id, &id).await?))
}

async fn cancel_handler(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> AppResult<Json<Value>> {
    let experiment = cancel(&st.pool, &user.id, &id).await?;
    if let Some(experiment) = experiment {
        st.lab.settle(&experiment).await?;
    }
    Ok(Json(report(&st.pool, &user.id, &id).await?))
}

#[derive(Deserialize)]
struct BudgetChange {
    id: String,
    github_minutes: i64,
}

async fn budget_handler(
    State(st): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<BudgetChange>,
) -> AppResult<Json<Value>> {
    if !user.is_admin {
        return Err(AppError::Forbidden(
            "Remote execution is an admin pilot".into(),
        ));
    }
    increase_budget(&st.pool, &user.id, &id, &body).await?;
    Ok(Json(report(&st.pool, &user.id, &id).await?))
}

async fn increase_budget(
    pool: &SqlitePool,
    owner: &str,
    id: &str,
    body: &BudgetChange,
) -> AppResult<()> {
    if uuid::Uuid::parse_str(&body.id).is_err() || !(1..=10_000).contains(&body.github_minutes) {
        return Err(AppError::bad(
            "Use an operation UUID and 1–10000 total GitHub work minutes",
        ));
    }
    let payload = json!({"execution":id,"github_minutes":body.github_minutes}).to_string();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let owned: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM lab_execution_runs WHERE id=? AND owner_id=?)",
    )
    .bind(id)
    .bind(owner)
    .fetch_one(&mut *tx)
    .await?;
    if !owned {
        return Err(AppError::NotFound("execution"));
    }
    let prior: Option<(String, String)> =
        sqlx::query_as("SELECT kind,payload FROM applied_ops WHERE owner_id=? AND op_id=?")
            .bind(owner)
            .bind(&body.id)
            .fetch_optional(&mut *tx)
            .await?;
    if let Some((kind, original)) = prior {
        return if kind == "lab_budget" && original == payload {
            Ok(())
        } else {
            Err(AppError::Conflict(
                "Operation id already used for another change".into(),
            ))
        };
    }
    sqlx::query("UPDATE lab_execution_runs SET github_minutes=MAX(github_minutes,?) WHERE id=? AND owner_id=?")
        .bind(body.github_minutes).bind(id).bind(owner).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO applied_ops(op_id,owner_id,kind,payload,applied_at) VALUES (?,?,'lab_budget',?,?)")
        .bind(&body.id).bind(owner).bind(payload).bind(now()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

async fn cancel(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<Option<String>> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row: Option<(String, bool)> = sqlx::query_as(
        "SELECT experiment_id,comparison FROM lab_execution_runs WHERE id=? AND owner_id=?",
    )
    .bind(id)
    .bind(owner)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((experiment, comparison)) = row else {
        return Err(AppError::NotFound("execution"));
    };
    sqlx::query("UPDATE lab_execution_runs SET cancelled_at=COALESCE(cancelled_at,?),cancel_reason=COALESCE(cancel_reason,'owner_cancelled') WHERE id=?")
        .bind(now()).bind(id).execute(&mut *tx).await?;
    if !comparison {
        sqlx::query("UPDATE lab_experiments SET status='cancelled',finished_at=COALESCE(finished_at,?),updated_at=? WHERE id=? AND status IN ('queued','running')")
            .bind(now()).bind(now()).bind(&experiment).execute(&mut *tx).await?;
        super::worker::refresh(&mut tx, &experiment, false).await?;
    }
    tx.commit().await?;
    Ok((!comparison).then_some(experiment))
}

async fn report(pool: &SqlitePool, owner: &str, id: &str) -> AppResult<Value> {
    let row:Option<(String,bool,String,i64,i64,Option<String>,Option<String>)>=sqlx::query_as("SELECT experiment_id,comparison,target,github_minutes,github_reserved,cancelled_at,cancel_reason FROM lab_execution_runs WHERE id=? AND owner_id=?")
        .bind(id).bind(owner).fetch_optional(pool).await?;
    let Some((experiment, comparison, target, budget, reserved, cancelled_at, cancel_reason)) = row
    else {
        return Err(AppError::NotFound("execution"));
    };
    let rows:Vec<(i64,String,Option<String>,Option<String>,Option<String>,Option<String>)>=sqlx::query_as(
        "SELECT j.unit,COALESCE(w.target,j.target),j.result,j.leased_at,j.finished_at,j.build FROM lab_worker_jobs j LEFT JOIN lab_worker_instances w ON w.id=j.worker_id WHERE j.run_id=? ORDER BY j.unit,j.finished_at IS NULL,j.finished_at,j.target")
        .bind(id).fetch_all(pool).await?;
    let mut jobs = Vec::new();
    let mut measurements: BTreeMap<String, TargetMeasurement> = BTreeMap::new();
    let mut reference: BTreeMap<i64, Value> = BTreeMap::new();
    let mut matched = 0;
    let mut mismatched = 0;
    for (unit, target, result, leased, finished, build) in rows {
        let result: Option<Value> = result
            .map(|r| serde_json::from_str(&r))
            .transpose()
            .map_err(anyhow::Error::from)?;
        if let Some(ref value) = result {
            let measured: Submission =
                serde_json::from_value(value.clone()).map_err(anyhow::Error::from)?;
            let aggregate = measurements.entry(target.clone()).or_default();
            aggregate.pods += 1;
            aggregate.games += measured.results.len();
            aggregate.unscored_games += measured
                .results
                .iter()
                .filter(|r| matches!(r.end, End::TimeCap | End::Panic | End::Error))
                .count();
            aggregate.wall_seconds += measured.wall_seconds;
            aggregate.setup_seconds += measured.setup_seconds;
            aggregate.peak_rss_bytes = aggregate.peak_rss_bytes.max(measured.peak_rss_bytes);
        }
        let mut agreement = Value::Null;
        if comparison && let Some(ref result) = result {
            let mut signature = result["results"].clone();
            if let Some(results) = signature.as_array_mut() {
                for r in results {
                    if let Some(o) = r.as_object_mut() {
                        o.remove("ms");
                        o.remove("runner");
                    }
                }
            }
            if let Some(first) = reference.get(&unit) {
                let same = *first == signature;
                if same {
                    matched += 1;
                } else {
                    mismatched += 1;
                }
                agreement = json!(same);
            } else {
                reference.insert(unit, signature);
            }
        }
        jobs.push(json!({"unit":unit,"target":target,"leased_at":leased,"finished_at":finished,"build":build.and_then(|b|serde_json::from_str::<Value>(&b).ok()),"measurement":result,"agrees_with_first_completed_target":agreement}));
    }
    for item in measurements.values_mut() {
        item.games_per_minute =
            (item.wall_seconds > 0.0).then_some(item.games as f64 * 60.0 / item.wall_seconds);
    }
    Ok(
        json!({"id":id,"experiment_id":experiment,"comparison":comparison,"target":target,"github_work_minutes":budget,"github_reserved_minutes":reserved,"cancelled_at":cancelled_at,"cancel_reason":cancel_reason,
        "agreement":{"matched":matched,"mismatched":mismatched},"targets":measurements,"jobs":jobs}),
    )
}

#[derive(Default, Serialize)]
struct TargetMeasurement {
    pods: usize,
    games: usize,
    unscored_games: usize,
    wall_seconds: f64,
    setup_seconds: f64,
    peak_rss_bytes: u64,
    games_per_minute: Option<f64>,
}

/// Metadata and downloads expose only the executable and the engine export, never the database,
/// configuration, images or rules documents. Workers verify full hashes before executing.
pub(crate) fn runtime_info(path: &std::path::Path) -> anyhow::Result<Value> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    fn file(path: &std::path::Path) -> anyhow::Result<Value> {
        let mut input = std::fs::File::open(path)?;
        let size = input.metadata()?.len();
        let mut hash = Sha256::new();
        let mut bytes = [0u8; 65536];
        loop {
            let n = input.read(&mut bytes)?;
            if n == 0 {
                break;
            }
            hash.update(&bytes[..n]);
        }
        Ok(json!({"sha256":hex::encode(hash.finalize()),"bytes":size}))
    }
    let card_data = file(path)?;
    let label = yama_play::lab::card_data_hash(path);
    anyhow::ensure!(
        label != "unknown"
            && card_data["sha256"]
                .as_str()
                .is_some_and(|h| h.starts_with(&label)),
        "card-data filename does not match its SHA-256"
    );
    Ok(
        json!({"protocol":1,"platform":format!("{}-{}",std::env::consts::OS,std::env::consts::ARCH),
        "build":{"engine":yama_play::lab::ENGINE,"card_data":label,"runner":super::process::runner()},
        "card_data":card_data,"binary":file(&std::env::current_exe()?)?}),
    )
}

async fn runtime_handler(State(st): State<AppState>, _worker: Worker) -> AppResult<Json<Value>> {
    let path = st
        .cfg
        .engine_card_data
        .clone()
        .ok_or_else(|| AppError::Unavailable("Engine card data is unavailable".into()))?;
    Ok(Json(
        tokio::task::spawn_blocking(move || runtime_info(&path))
            .await
            .map_err(anyhow::Error::from)??,
    ))
}

async fn download_handler(
    State(st): State<AppState>,
    _worker: Worker,
    Path(kind): Path<String>,
) -> AppResult<axum::response::Response> {
    use tokio::io::AsyncReadExt;
    let path = match kind.as_str() {
        "binary" => std::env::current_exe().map_err(anyhow::Error::from)?,
        "card-data" => st
            .cfg
            .engine_card_data
            .clone()
            .ok_or_else(|| AppError::Unavailable("Engine card data is unavailable".into()))?,
        _ => return Err(AppError::NotFound("worker runtime")),
    };
    let file = tokio::fs::File::open(path)
        .await
        .map_err(anyhow::Error::from)?;
    let stream = futures_util::stream::try_unfold(file, |mut file| async move {
        let mut bytes = vec![0u8; 65536];
        let n = file.read(&mut bytes).await?;
        bytes.truncate(n);
        Ok::<_, std::io::Error>(if n == 0 { None } else { Some((bytes, file)) })
    });
    Ok(axum::response::Response::builder()
        .header("cache-control", "no-store")
        .header("content-type", "application/octet-stream")
        .body(axum::body::Body::from_stream(stream))
        .map_err(anyhow::Error::from)?)
}

#[cfg(test)]
mod tests;
