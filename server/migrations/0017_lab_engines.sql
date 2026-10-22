-- Forge as a second engine for Lab runs (lab/forge.rs). Every scheduled game names the engine
-- that plays it: 'phase' (the server's own rules engine, the lab worker) or 'forge' (the Forge
-- worker container on the private network). A "both" experiment has every pod once per engine.
ALTER TABLE lab_experiment_games ADD COLUMN engine TEXT NOT NULL DEFAULT 'phase' CHECK (engine IN ('phase','forge'));
CREATE INDEX lab_experiment_games_pending_engine ON lab_experiment_games(engine, experiment_id, ord) WHERE result IS NULL;
-- The Forge half's summary in a "both" experiment (`summary` holds the phase half). A Forge-only
-- experiment keeps its summary in `summary`, like any other.
ALTER TABLE lab_experiments ADD COLUMN summary_forge TEXT;
