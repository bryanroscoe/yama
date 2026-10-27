use super::*;
use crate::testutil;
use axum::http::{Method, StatusCode};

fn build(policy: &str) -> Build {
    Build {
        engine: "phase-test".into(),
        card_data: "abc123".into(),
        runner: format!("source-1/{policy}"),
    }
}

async fn create(pool: &SqlitePool, owner: &str, body: &NewExecution) -> AppResult<String> {
    super::create(pool, owner, body, &build("isolated-local-v1")).await
}

async fn claim(pool: &SqlitePool, worker: &Worker, body: Claim) -> AppResult<Option<Lease>> {
    super::claim(pool, worker, body, Some(&build("isolated-local-v1"))).await
}

async fn fixture() -> (SqlitePool, Worker, String) {
    let pool = crate::db::test_pool().await;
    let (owner, _) = testutil::user(&pool, "worker-owner@example.com").await;
    sqlx::query("UPDATE users SET is_admin=1 WHERE id=?")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let token = new_id();
    sqlx::query("INSERT INTO api_tokens(id,owner_id,name,token_hash,scopes,created_at) VALUES (?,?, 'worker', ?, '[\"lab:worker:laptop\"]',?)")
        .bind(&token).bind(&owner).bind(sha256_hex("worker-key")).bind(now()).execute(&pool).await.unwrap();
    let list = |id: &str| json!({"id":id,"label":id,"source":{},"sha256":id,"cards":[{"name":"Forest","qty":100}]});
    let frozen = json!({"version":1,"mode":"compare","seed":7,"pod":2,"pods":1,"difficulty":"Easy",
        "limits":{"max_turns":10,"max_actions":100,"max_seconds":5,"turn_action_cap":50},
        "base":list("base"),"variant":list("variant"),"opponents":[{"id":"field","label":"field","source":{},"sha256":"field","cards":[{"name":"Forest","qty":100}],"pods":1}],"warnings":[],
        "display":{"base":{"label":"base","commanders":[],"color_identity":"","source":{}},
        "field":{"kind":"my_decks","ids":[],"label":"field","decks":1}}});
    let experiment = new_id();
    sqlx::query("INSERT INTO lab_experiments(id,owner_id,name,status,spec,games_total,engine,card_data,runner,difficulty,created_at,updated_at) VALUES (?,?,'private','queued',?,2,'phase-test','abc123','source-1/isolated-linux-2g-v1','Easy',?,?)")
        .bind(&experiment).bind(&owner).bind(frozen.to_string()).bind(now()).bind(now()).execute(&pool).await.unwrap();
    for (ord, id) in ["base", "variant"].iter().enumerate() {
        let spec = json!({"game":format!("game-{ord}"),"seed":7,"decks":[id,"field"],"difficulty":"Easy","max_turns":10,"max_actions":100,"max_seconds":5});
        sqlx::query("INSERT INTO lab_experiment_games(experiment_id,game,ord,spec,engine) VALUES (?,?,?,?,'phase')")
            .bind(&experiment).bind(format!("game-{ord}")).bind(ord as i64).bind(spec.to_string()).execute(&pool).await.unwrap();
    }
    (
        pool,
        Worker {
            owner,
            token,
            target: "laptop".into(),
        },
        experiment,
    )
}

fn execution(experiment: &str) -> NewExecution {
    NewExecution {
        id: new_id(),
        experiment_id: experiment.into(),
        target: "laptop".into(),
        comparison: false,
        targets: vec![],
        sample_units: 1,
        github_minutes: 0,
    }
}
fn offer(id: &str) -> Claim {
    Claim {
        worker_id: id.into(),
        build: build("isolated-local-v1"),
        ready: true,
        execution_id: None,
    }
}
fn submission(lease: &Lease) -> Submission {
    let requests: Vec<Request> = serde_json::from_value(lease.requests.clone()).unwrap();
    Submission {
        results: requests
            .iter()
            .map(|q| {
                let mut r = GameResult::new(&q.spec, &q.card_data);
                r.engine = lease.build.engine.clone();
                r.runner = lease.build.runner.clone();
                r.end = End::Win;
                r.winner = Some(0);
                r.first_seat = Some(0);
                r.placements = vec![vec![0], vec![1]];
                r.final_life = vec![40, 0];
                r.turns = 3;
                r.actions = 12;
                r
            })
            .collect(),
        wall_seconds: 2.0,
        peak_rss_bytes: 1000,
        setup_seconds: 1.0,
    }
}

#[tokio::test]
async fn production_claims_whole_pair_and_uploads_once() {
    let (pool, worker, experiment) = fixture().await;
    let body = execution(&experiment);
    create(&pool, &worker.owner, &body).await.unwrap();
    assert_eq!(create(&pool, &worker.owner, &body).await.unwrap(), body.id);
    let id = new_id();
    let lease = claim(&pool, &worker, offer(&id)).await.unwrap().unwrap();
    assert_eq!(lease.requests.as_array().unwrap().len(), 2);
    assert!(claim(&pool, &worker, offer(&id)).await.unwrap().is_none());
    let body = submission(&lease);
    submit(&pool, &worker, &lease.id, &body).await.unwrap();
    submit(&pool, &worker, &lease.id, &body).await.unwrap();
    let (done, status): (i64, String) =
        sqlx::query_as("SELECT games_done,status FROM lab_experiments WHERE id=?")
            .bind(&experiment)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(done, 2);
    assert_eq!(status, "done");
}

#[tokio::test]
async fn expired_lease_is_fenced_after_another_worker_claims() {
    let (pool, worker, experiment) = fixture().await;
    create(&pool, &worker.owner, &execution(&experiment))
        .await
        .unwrap();
    let first = claim(&pool, &worker, offer(&new_id()))
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE lab_worker_jobs SET expires=0")
        .execute(&pool)
        .await
        .unwrap();
    let second = claim(&pool, &worker, offer(&new_id()))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(first.id, second.id);
    assert!(matches!(
        submit(&pool, &worker, &first.id, &submission(&first)).await,
        Err(AppError::Conflict(_))
    ));
    submit(&pool, &worker, &second.id, &submission(&second))
        .await
        .unwrap();
}

#[tokio::test]
async fn schedule_build_and_partial_uploads_are_validated_before_any_write() {
    let (pool, worker, experiment) = fixture().await;
    create(&pool, &worker.owner, &execution(&experiment))
        .await
        .unwrap();
    let id = new_id();
    let mut wrong = offer(&id);
    wrong.build.runner = "different/isolated-local-v1".into();
    assert!(claim(&pool, &worker, wrong).await.unwrap().is_none());
    let lease = claim(&pool, &worker, offer(&id)).await.unwrap().unwrap();
    let mut body = submission(&lease);
    body.results[1].seed += 1;
    assert!(submit(&pool, &worker, &lease.id, &body).await.is_err());
    let mut body = submission(&lease);
    body.results.pop();
    assert!(submit(&pool, &worker, &lease.id, &body).await.is_err());
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM lab_experiment_games WHERE result IS NOT NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn comparison_reports_three_targets_without_changing_deck_results() {
    let (pool, worker, experiment) = fixture().await;
    let mut body = execution(&experiment);
    body.comparison = true;
    body.targets = TARGETS.iter().map(|s| s.to_string()).collect();
    body.github_minutes = 100;
    create(&pool, &worker.owner, &body).await.unwrap();
    for target in TARGETS {
        let w = Worker {
            target: target.into(),
            ..worker.clone()
        };
        let lease = claim(&pool, &w, offer(&new_id())).await.unwrap().unwrap();
        submit(&pool, &w, &lease.id, &submission(&lease))
            .await
            .unwrap();
    }
    let report = report(&pool, &worker.owner, &body.id).await.unwrap();
    assert_eq!(report["agreement"]["matched"], 2);
    assert_eq!(report["agreement"]["mismatched"], 0);
    assert_eq!(report["targets"]["laptop"]["games"], 2);
    assert_eq!(report["targets"]["saget"]["unscored_games"], 0);
    let done: i64 = sqlx::query_scalar("SELECT games_done FROM lab_experiments WHERE id=?")
        .bind(&experiment)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(done, 0);
}

#[tokio::test]
async fn owners_cancellation_and_worker_identity_are_isolated() {
    let (pool, worker, experiment) = fixture().await;
    let body = execution(&experiment);
    create(&pool, &worker.owner, &body).await.unwrap();
    assert!(matches!(
        report(&pool, "someone-else", &body.id).await,
        Err(AppError::NotFound(_))
    ));
    let (stranger, _) = testutil::user(&pool, "other@example.com").await;
    let other = Worker {
        owner: stranger,
        target: worker.target.clone(),
        token: worker.token.clone(),
    };
    assert!(
        claim(&pool, &other, offer(&new_id()))
            .await
            .unwrap()
            .is_none()
    );
    let lease = claim(&pool, &worker, offer(&new_id()))
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE lab_experiments SET status='cancelled' WHERE id=?")
        .bind(&experiment)
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        submit(&pool, &worker, &lease.id, &submission(&lease)).await,
        Err(AppError::Conflict(_))
    ));
}

#[tokio::test]
async fn auto_uses_available_compatible_workers_and_github_budget() {
    let (pool, worker, experiment) = fixture().await;
    let mut body = execution(&experiment);
    body.target = "auto".into();
    create(&pool, &worker.owner, &body).await.unwrap();
    let github = Worker {
        target: "github".into(),
        ..worker.clone()
    };
    assert!(
        claim(&pool, &github, offer(&new_id()))
            .await
            .unwrap()
            .is_none(),
        "zero GH budget disables claims"
    );
    let mut unavailable = offer(&new_id());
    unavailable.ready = false;
    assert!(claim(&pool, &worker, unavailable).await.unwrap().is_none());
    assert!(
        claim(&pool, &worker, offer(&new_id()))
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn legacy_dispatcher_excludes_routed_phase_even_if_it_selected_before_routing() {
    use super::super::worker::{LabWorker, SimState};
    let (pool, worker, experiment) = fixture().await;
    let legacy = LabWorker::new(pool.clone(), 1, SimState::Missing("test".into()));
    let selected = legacy.next_jobs(2).await.unwrap();
    assert_eq!(selected.len(), 2);
    create(&pool, &worker.owner, &execution(&experiment))
        .await
        .unwrap();
    assert!(legacy.next_jobs(2).await.unwrap().is_empty());
    assert!(legacy.mark_started(&selected).await.unwrap().is_empty());
}

#[tokio::test]
async fn router_requires_worker_scope_and_disabled_keys_stop_working() {
    let (pool, worker, experiment) = fixture().await;
    create(&pool, &worker.owner, &execution(&experiment))
        .await
        .unwrap();
    let state = testutil::state_with(testutil::config(), pool.clone()).await;
    let app = crate::routes::app(state);
    sqlx::query("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,'9999-12-31T00:00:00Z')")
        .bind(sha256_hex("admin-session")).bind(&worker.owner).bind(now()).execute(&pool).await.unwrap();
    let body = json!({"worker_id":new_id(),"build":build("isolated-local-v1"),"ready":true});
    let path = "/api/lab/workers/claim";
    assert_eq!(
        testutil::send(&app, Method::POST, path, None, Some(body.clone()))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        testutil::send(
            &app,
            Method::POST,
            path,
            Some("admin-session"),
            Some(body.clone())
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        testutil::send(&app, Method::GET, "/api/me", Some("worker-key"), None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        testutil::send(
            &app,
            Method::POST,
            path,
            Some("worker-key"),
            Some(body.clone())
        )
        .await
        .0,
        StatusCode::OK
    );
    sqlx::query("UPDATE api_tokens SET revoked_at=? WHERE id=?")
        .bind(now())
        .bind(&worker.token)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        testutil::send(&app, Method::POST, path, Some("worker-key"), Some(body))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn a_busy_worker_cannot_change_the_build_of_its_existing_lease() {
    let (pool, worker, experiment) = fixture().await;
    create(&pool, &worker.owner, &execution(&experiment))
        .await
        .unwrap();
    let id = new_id();
    let lease = claim(&pool, &worker, offer(&id)).await.unwrap().unwrap();
    let mut changed = offer(&id);
    changed.build.runner = "other-source/isolated-local-v1".into();
    assert!(claim(&pool, &worker, changed).await.unwrap().is_none());
    submit(&pool, &worker, &lease.id, &submission(&lease))
        .await
        .unwrap();
}

#[tokio::test]
async fn restricted_workers_do_not_block_another_execution_in_auto_mode() {
    let (pool, worker, experiment) = fixture().await;
    let restricted_id = new_id();
    let mut restricted = offer(&restricted_id);
    restricted.execution_id = Some(new_id());
    assert!(claim(&pool, &worker, restricted).await.unwrap().is_none());
    let mut body = execution(&experiment);
    body.target = "auto".into();
    create(&pool, &worker.owner, &body).await.unwrap();
    assert!(
        claim(&pool, &worker, offer(&new_id()))
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn both_engine_labels_still_allow_phase_and_keep_forge_in_the_original_queue() {
    use super::super::worker::{LabWorker, SimState};
    let (pool, worker, experiment) = fixture().await;
    sqlx::query("UPDATE lab_experiments SET engine='phase-test, forge-test' WHERE id=?")
        .bind(&experiment)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO lab_experiment_games(experiment_id,game,ord,spec,engine) SELECT experiment_id,'forge-0',10,spec,'forge' FROM lab_experiment_games WHERE experiment_id=? AND ord=0")
        .bind(&experiment).execute(&pool).await.unwrap();
    create(&pool, &worker.owner, &execution(&experiment))
        .await
        .unwrap();
    assert!(
        claim(&pool, &worker, offer(&new_id()))
            .await
            .unwrap()
            .is_some()
    );
    let legacy = LabWorker::new(pool.clone(), 1, SimState::Missing("test".into()));
    assert!(legacy.next_jobs(2).await.unwrap().is_empty());
    assert_eq!(legacy.next_jobs_for("forge", 2).await.unwrap().len(), 1);
}

#[tokio::test]
async fn queued_experiments_use_the_available_runtime_instead_of_creation_metadata() {
    let (pool, worker, experiment) = fixture().await;
    sqlx::query("UPDATE lab_experiments SET engine='old-engine',card_data='old-data',runner='old-source' WHERE id=?")
        .bind(&experiment).execute(&pool).await.unwrap();
    create(&pool, &worker.owner, &execution(&experiment))
        .await
        .unwrap();
    let lease = claim(&pool, &worker, offer(&new_id()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.build.engine, "phase-test");
    assert_eq!(lease.requests[0]["card_data"], "abc123");
}

#[tokio::test]
async fn claims_wait_for_the_server_runtime_before_leasing_production_or_comparisons() {
    for comparison in [false, true] {
        let (pool, worker, experiment) = fixture().await;
        let mut body = execution(&experiment);
        body.comparison = comparison;
        body.targets = vec!["laptop".into(), "saget".into()];
        create(&pool, &worker.owner, &body).await.unwrap();
        assert!(super::claim(&pool, &worker, offer(&new_id()), None).await.unwrap().is_none());
        let leased: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM lab_worker_jobs WHERE lease_id IS NOT NULL")
            .fetch_one(&pool).await.unwrap();
        assert_eq!(leased, 0);
        // The same work remains available once the server can attest its current runtime.
        assert!(claim(&pool, &worker, offer(&new_id())).await.unwrap().is_some());
    }
}

#[tokio::test]
async fn unplayed_production_pods_adopt_a_new_runtime_without_mutating_their_schedule() {
    let (pool, worker, experiment) = fixture().await;
    let old = Build {
        engine: "old-engine".into(),
        card_data: "old-data".into(),
        runner: "old-source/isolated-local-v1".into(),
    };
    super::create(&pool, &worker.owner, &execution(&experiment), &old)
        .await
        .unwrap();
    let lease = claim(&pool, &worker, offer(&new_id()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lease.requests[0]["card_data"], "abc123");
    assert_eq!(lease.requests[0]["spec"]["game"], "game-0");
    assert_eq!(lease.requests[0]["spec"]["seed"], 7);
    assert_eq!(lease.requests[0]["decks"][0]["id"], "base");
}

#[tokio::test]
async fn a_runtime_change_cancels_a_comparison_instead_of_mixing_builds_or_hanging() {
    let (pool, worker, experiment) = fixture().await;
    let mut body = execution(&experiment);
    body.comparison = true;
    body.targets = vec!["saget".into(), "laptop".into()];
    create(&pool, &worker.owner, &body).await.unwrap();
    let mut current = build("isolated-local-v1");
    current.runner = "new-source/isolated-local-v1".into();
    let offered = Claim {
        build: current.clone(),
        ..offer(&new_id())
    };
    assert!(
        super::claim(&pool, &worker, offered, Some(&current))
            .await
            .unwrap()
            .is_none()
    );
    let r = report(&pool, &worker.owner, &body.id).await.unwrap();
    assert_eq!(r["cancel_reason"], "runtime_changed");
}

#[tokio::test]
async fn fast_failures_do_not_improve_auto_pace_and_quarantine_the_worker() {
    let (pool, worker, experiment) = fixture().await;
    for ord in 2..4 {
        let name = format!("later-{ord}");
        sqlx::query("INSERT INTO lab_experiment_games(experiment_id,game,ord,spec,engine) SELECT experiment_id,?,?,json_set(spec,'$.game',?),'phase' FROM lab_experiment_games WHERE experiment_id=? AND ord=?")
            .bind(&name).bind(ord).bind(&name).bind(&experiment).bind(ord-2).execute(&pool).await.unwrap();
    }
    sqlx::query("UPDATE lab_experiments SET games_total=4 WHERE id=?")
        .bind(&experiment)
        .execute(&pool)
        .await
        .unwrap();
    let mut body = execution(&experiment);
    body.target = "auto".into();
    create(&pool, &worker.owner, &body).await.unwrap();
    let bad_id = new_id();
    let lease = claim(&pool, &worker, offer(&bad_id))
        .await
        .unwrap()
        .unwrap();
    let mut failed = submission(&lease);
    failed.wall_seconds = 0.001;
    for r in &mut failed.results {
        r.end = End::Error;
        r.winner = None;
        r.error = Some("failed immediately".into());
    }
    submit(&pool, &worker, &lease.id, &failed).await.unwrap();
    let (pace, blocked): (f64, i64) =
        sqlx::query_as("SELECT seconds_per_game,failed_until FROM lab_worker_instances WHERE id=?")
            .bind(&bad_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(pace, 120.0);
    assert!(blocked > chrono::Utc::now().timestamp());
    assert!(
        claim(&pool, &worker, offer(&bad_id))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        claim(&pool, &worker, offer(&new_id()))
            .await
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn a_hundred_ineligible_jobs_cannot_hide_later_runnable_work() {
    let (pool, worker, experiment) = fixture().await;
    let mut blocked = execution(&experiment);
    blocked.target = "auto".into();
    create(&pool, &worker.owner, &blocked).await.unwrap();
    for unit in 1..102 {
        sqlx::query("INSERT INTO lab_worker_jobs(id,run_id,unit,target,requests,expected_build) SELECT ?,run_id,?,target,requests,expected_build FROM lab_worker_jobs WHERE run_id=? AND unit=0")
            .bind(new_id()).bind(unit).bind(&blocked.id).execute(&pool).await.unwrap();
    }
    let mut runnable = execution(&experiment);
    runnable.comparison = true;
    runnable.targets = vec!["github".into(), "laptop".into()];
    runnable.github_minutes = 100;
    create(&pool, &worker.owner, &runnable).await.unwrap();
    let gh = Worker {
        target: "github".into(),
        ..worker
    };
    let lease = claim(&pool, &gh, offer(&new_id())).await.unwrap().unwrap();
    let run: String = sqlx::query_scalar("SELECT run_id FROM lab_worker_jobs WHERE id=?")
        .bind(&lease.job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(run, runnable.id);
}

#[tokio::test]
async fn cancelling_comparisons_preserves_the_finished_source_and_completed_diagnostics() {
    let (pool, worker, experiment) = fixture().await;
    sqlx::query("UPDATE lab_experiments SET status='done' WHERE id=?")
        .bind(&experiment)
        .execute(&pool)
        .await
        .unwrap();
    let mut body = execution(&experiment);
    body.comparison = true;
    body.targets = vec!["saget".into(), "laptop".into()];
    create(&pool, &worker.owner, &body).await.unwrap();
    let saget = Worker {
        target: "saget".into(),
        ..worker.clone()
    };
    let done = claim(&pool, &saget, offer(&new_id()))
        .await
        .unwrap()
        .unwrap();
    submit(&pool, &saget, &done.id, &submission(&done))
        .await
        .unwrap();
    let pending = claim(&pool, &worker, offer(&new_id()))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        cancel(&pool, "stranger", &body.id).await,
        Err(AppError::NotFound(_))
    ));
    cancel(&pool, &worker.owner, &body.id).await.unwrap();
    cancel(&pool, &worker.owner, &body.id).await.unwrap();
    assert!(matches!(
        submit(&pool, &worker, &pending.id, &submission(&pending)).await,
        Err(AppError::Conflict(_))
    ));
    assert!(
        claim(&pool, &worker, offer(&new_id()))
            .await
            .unwrap()
            .is_none()
    );
    let state: String = sqlx::query_scalar("SELECT status FROM lab_experiments WHERE id=?")
        .bind(&experiment)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(state, "done");
    let r = report(&pool, &worker.owner, &body.id).await.unwrap();
    assert_eq!(r["targets"]["saget"]["games"], 2);
    assert_eq!(r["cancel_reason"], "owner_cancelled");
}

#[tokio::test]
async fn the_existing_stop_action_cancels_routed_reports_and_preserves_finished_diagnostics() {
    let (pool, worker, experiment) = fixture().await;
    let production = execution(&experiment);
    create(&pool, &worker.owner, &production).await.unwrap();
    let mut comparison = execution(&experiment);
    comparison.comparison = true;
    comparison.targets = vec!["saget".into(), "laptop".into()];
    create(&pool, &worker.owner, &comparison).await.unwrap();
    let saget = Worker { target: "saget".into(), ..worker.clone() };
    let done = claim(&pool, &saget, offer(&new_id())).await.unwrap().unwrap();
    submit(&pool, &saget, &done.id, &submission(&done)).await.unwrap();
    let pending = claim(&pool, &worker, offer(&new_id())).await.unwrap().unwrap();
    assert!(matches!(
        super::super::experiments::cancel(&pool, "stranger", &experiment, &|_: &str| false).await,
        Err(AppError::NotFound(_))
    ));
    assert!(report(&pool, &worker.owner, &production.id).await.unwrap()["cancelled_at"].is_null());
    for _ in 0..2 {
        super::super::experiments::cancel(&pool, &worker.owner, &experiment, &|_: &str| false).await.unwrap();
    }
    for run in [&production.id, &comparison.id] {
        let r = report(&pool, &worker.owner, run).await.unwrap();
        assert!(!r["cancelled_at"].is_null());
        assert_eq!(r["cancel_reason"], "experiment_cancelled");
    }
    assert_eq!(report(&pool, &worker.owner, &comparison.id).await.unwrap()["targets"]["saget"]["games"], 2);
    assert!(matches!(submit(&pool, &worker, &pending.id, &submission(&pending)).await, Err(AppError::Conflict(_))));
    assert!(claim(&pool, &worker, offer(&new_id())).await.unwrap().is_none());
}

#[tokio::test]
async fn github_admission_requires_the_entire_explicit_workload_budget() {
    let (pool, worker, experiment) = fixture().await;
    let mut body = execution(&experiment);
    body.target = "github".into();
    body.github_minutes = 1;
    let error = create(&pool, &worker.owner, &body).await.unwrap_err();
    assert!(matches!(error,AppError::Invalid{details,..} if details["required_github_minutes"]==4));
    for ord in 2..4 {
        let name = format!("more-{ord}");
        sqlx::query("INSERT INTO lab_experiment_games(experiment_id,game,ord,spec,engine) SELECT experiment_id,?,?,json_set(spec,'$.game',?),'phase' FROM lab_experiment_games WHERE experiment_id=? AND ord=?")
            .bind(&name).bind(ord).bind(&name).bind(&experiment).bind(ord-2).execute(&pool).await.unwrap();
    }
    body.comparison = true;
    body.targets = vec!["github".into(), "laptop".into()];
    body.sample_units = 2;
    body.github_minutes = 4;
    let error = create(&pool, &worker.owner, &body).await.unwrap_err();
    assert!(matches!(error,AppError::Invalid{details,..} if details["required_github_minutes"]==8));
    body.github_minutes = 8;
    create(&pool, &worker.owner, &body).await.unwrap();
}

#[tokio::test]
async fn exhausted_retry_budgets_can_be_increased_idempotently_by_the_owner() {
    let (pool, worker, experiment) = fixture().await;
    let mut body = execution(&experiment);
    body.target = "github".into();
    body.github_minutes = 4;
    create(&pool, &worker.owner, &body).await.unwrap();
    let gh = Worker {
        target: "github".into(),
        ..worker
    };
    claim(&pool, &gh, offer(&new_id())).await.unwrap().unwrap();
    sqlx::query("UPDATE lab_worker_jobs SET expires=0")
        .execute(&pool)
        .await
        .unwrap();
    assert!(claim(&pool, &gh, offer(&new_id())).await.unwrap().is_none());
    let change = BudgetChange {
        id: new_id(),
        github_minutes: 8,
    };
    assert!(matches!(
        increase_budget(&pool, "stranger", &body.id, &change).await,
        Err(AppError::NotFound(_))
    ));
    let (other_owner, _) = testutil::user(&pool, "other-budget-owner@example.com").await;
    sqlx::query("INSERT INTO applied_ops(op_id,owner_id,kind,payload,applied_at) VALUES (?,?,'unrelated','{}',?)")
        .bind(&change.id).bind(&other_owner).bind(now()).execute(&pool).await.unwrap();
    increase_budget(&pool, &gh.owner, &body.id, &change)
        .await
        .unwrap();
    increase_budget(&pool, &gh.owner, &body.id, &change)
        .await
        .unwrap();
    let mut conflict = change;
    conflict.github_minutes = 12;
    assert!(matches!(
        increase_budget(&pool, &gh.owner, &body.id, &conflict).await,
        Err(AppError::Conflict(_))
    ));
    assert!(claim(&pool, &gh, offer(&new_id())).await.unwrap().is_some());
    let (budget, reserved): (i64, i64) =
        sqlx::query_as("SELECT github_minutes,github_reserved FROM lab_execution_runs WHERE id=?")
            .bind(&body.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((budget, reserved), (8, 8));
}
