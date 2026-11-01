-- Public commander ranking (server/src/public_commanders.rs). An operator's row here is the explicit
-- choice that per-commander scores derived from that owner's datasets from this source may show on
-- the public /commanders page. Separate from precon_evidence_sources, so a commander-only source
-- (Mythic Tools) never reaches the precon pages. The datasets stay private; every score is derived
-- on read from their active revisions, so a new upload updates it.
CREATE TABLE commander_evidence_sources (
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_name TEXT NOT NULL,
    enabled_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, source_name)
);
