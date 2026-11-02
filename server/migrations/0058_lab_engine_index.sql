-- A run's games by engine (2026-11-02): the lab list counts each run's Forge games, and read every
-- game of every run to do it (0.06 to 0.4 s per request on 45,000 games). This index answers the
-- count, and the pending-games indexes the rest.
CREATE INDEX lab_experiment_games_engine ON lab_experiment_games(experiment_id, engine);
