-- Private evidence datasets. Importing never publishes facts or changes games/decks.
CREATE TABLE evidence_datasets (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    current_revision_id TEXT REFERENCES evidence_dataset_revisions(id) ON DELETE SET NULL,
    UNIQUE(owner_id, external_id)
);
CREATE TABLE evidence_dataset_revisions (
    id TEXT PRIMARY KEY,
    dataset_id TEXT NOT NULL REFERENCES evidence_datasets(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    metadata TEXT NOT NULL CHECK(json_valid(metadata)),
    document_gz BLOB NOT NULL,
    imported_at TEXT NOT NULL,
    UNIQUE(dataset_id, revision),
    UNIQUE(dataset_id, content_hash)
);
CREATE TABLE evidence_dataset_records (
    revision_id TEXT NOT NULL REFERENCES evidence_dataset_revisions(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity TEXT NOT NULL,
    search_label TEXT NOT NULL,
    document TEXT NOT NULL CHECK(json_valid(document)),
    PRIMARY KEY(revision_id, id)
);
CREATE INDEX evidence_dataset_entity ON evidence_dataset_records(revision_id, entity, kind, id);
CREATE INDEX evidence_dataset_kind ON evidence_dataset_records(revision_id, kind, id);
