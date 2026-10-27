-- Publication is explicit. A global Lab run is not automatically public, and later imports
-- cannot rewrite a published snapshot. No account, experiment or private deck references.
CREATE TABLE precon_publications (
    id TEXT PRIMARY KEY,
    published_at TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    document TEXT NOT NULL CHECK (json_valid(document))
);
CREATE TABLE precon_publication_head (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    publication_id TEXT REFERENCES precon_publications(id)
);
INSERT INTO precon_publication_head(singleton, publication_id) VALUES (1, NULL);
