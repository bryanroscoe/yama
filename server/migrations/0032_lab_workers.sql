-- Opt-in Phase worker pilot. Existing experiments keep their original saget dispatcher.
CREATE TABLE lab_execution_runs (
    id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL REFERENCES lab_experiments(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id),
    request_hash TEXT NOT NULL,
    comparison INTEGER NOT NULL,
    target TEXT NOT NULL CHECK(target IN ('auto','saget','laptop','github')),
    github_minutes INTEGER NOT NULL DEFAULT 0,
    github_reserved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    cancel_reason TEXT
);
CREATE UNIQUE INDEX lab_execution_production ON lab_execution_runs(experiment_id) WHERE comparison = 0;
CREATE TABLE lab_worker_instances (
    id TEXT PRIMARY KEY,
    token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id),
    target TEXT NOT NULL,
    build TEXT NOT NULL,
    execution_id TEXT,
    ready INTEGER NOT NULL,
    seen INTEGER NOT NULL,
    seconds_per_game REAL NOT NULL DEFAULT 120,
    failed_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE lab_worker_jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES lab_execution_runs(id) ON DELETE CASCADE,
    unit INTEGER NOT NULL,
    target TEXT NOT NULL,
    requests TEXT NOT NULL,
    expected_build TEXT NOT NULL,
    build TEXT,
    lease_id TEXT,
    worker_id TEXT REFERENCES lab_worker_instances(id),
    expires INTEGER,
    leased_at TEXT,
    result TEXT,
    submitted_lease TEXT,
    finished_at TEXT,
    UNIQUE(run_id, unit, target)
);
CREATE INDEX lab_worker_pending ON lab_worker_jobs(run_id, unit) WHERE result IS NULL;
