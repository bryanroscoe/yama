-- The operator's choice of simulation for rating v2 (server/src/precon_evidence): one engine's games
-- from one stock-only tournament, re-read as it plays. At most one row. Without it the public pages
-- rank with real games alone; the published Phase benchmark no longer feeds rating v2 (Bryan,
-- 31 Oct 2026: Forge tracks real results better).
CREATE TABLE precon_evidence_simulation (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    experiment_id TEXT NOT NULL REFERENCES lab_experiments(id) ON DELETE CASCADE,
    engine        TEXT NOT NULL CHECK (engine IN ('phase','forge')),
    chosen_at     TEXT NOT NULL
);
