-- The operator's choice of simulation for rating v2 (server/src/precon_evidence): one engine's games
-- from one or more tournaments, pooled and re-read as they play. Only pods of four current stock
-- lists count, and only games whose engine version starts with `build` (e.g. 'forge 2.0.16-745401a4'),
-- so harness-only rebuilds pool but an engine upgrade doesn't. Every row shares one engine and build.
-- Without rows the public pages rank with real games alone; the published Phase benchmark no longer
-- feeds rating v2 (Bryan, 31 Oct 2026: Forge tracks real results better).
CREATE TABLE precon_evidence_simulation (
    experiment_id TEXT PRIMARY KEY REFERENCES lab_experiments(id) ON DELETE CASCADE,
    engine        TEXT NOT NULL CHECK (engine IN ('phase','forge')),
    build         TEXT NOT NULL,
    chosen_at     TEXT NOT NULL
);
