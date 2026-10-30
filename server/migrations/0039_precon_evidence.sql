-- Shared precon evidence derived from datasets (server/src/precon_evidence). An operator's row
-- here is the explicit choice that per-precon figures derived from that owner's datasets from this
-- source may show on the signed-in precon pages. The datasets themselves stay private, and every
-- figure is derived on read from their active revisions, so a new upload updates it.
CREATE TABLE precon_evidence_sources (
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_name TEXT NOT NULL,
    enabled_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, source_name)
);

-- Operator corrections to the automatic precon-to-entity match: `manual` links a catalog precon
-- to a source entity, `exclude` forbids the pair. Not tied to a dataset revision.
CREATE TABLE precon_evidence_links (
    precon_id  TEXT NOT NULL,
    entity     TEXT NOT NULL,
    rule       TEXT NOT NULL CHECK (rule IN ('manual', 'exclude')),
    note       TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (precon_id, entity)
);
