-- A phase game cut short by the machine (the CPU-time cap, a hang, the wall-clock safety net)
-- plays once more after the run's other games (lab/worker.rs). `retried` marks a game already put
-- back once, so it is never put back twice; retried games come last in the queue.
ALTER TABLE lab_experiment_games ADD COLUMN retried INTEGER NOT NULL DEFAULT 0;
CREATE INDEX lab_experiment_games_pending_retry ON lab_experiment_games(engine, experiment_id, retried, ord) WHERE result IS NULL;
