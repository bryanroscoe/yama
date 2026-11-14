-- The operator's chosen simulation (precon_evidence_simulation, migration 0041) pools games by
-- engine version. Since 13 Nov 2026 lab games play with the engine's loop detection (their
-- engine label ends in "+loops"), within the same engine version as the games before. Whether
-- the chosen games played with it is kept here, so the two kinds never pool. A choice made
-- before this keeps the games it had: 0, without loop detection.
ALTER TABLE precon_evidence_simulation ADD COLUMN loops INTEGER NOT NULL DEFAULT 0;
