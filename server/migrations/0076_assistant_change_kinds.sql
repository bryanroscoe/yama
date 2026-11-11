-- assistant_changes.kind loses its CHECK. The table has been recreated nine times to add a kind
-- to that list (0026, 0028, 0029, 0051, 0055, 0067, 0069, 0071 and now), and once a tool shipped
-- without its kind (#165), so staging failed with a server error. The tool table in
-- server/src/mcp/tools.rs is the one list of kinds: a staging tool names the kind it stores and
-- the function that applies it, and applying a kind nothing applies is refused there
-- (mcp::registry::applier).
--
-- New with this migration: update_deck, remove_wish, create_container, remove_from_collection
-- and edit_copies. A later kind needs no migration.
CREATE TABLE assistant_changes_new (
    id               TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL REFERENCES users(id),
    kind             TEXT NOT NULL,
    summary          TEXT NOT NULL,
    detail           TEXT,
    payload          TEXT NOT NULL,
    via              TEXT NOT NULL CHECK (via IN ('question', 'key', 'oauth')),
    conversation_id  TEXT,
    message_id       TEXT,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'discarded')),
    error            TEXT,
    result           TEXT,
    created_at       TEXT NOT NULL,
    decided_at       TEXT,
    op_id            TEXT,
    op_hash          TEXT
);
INSERT INTO assistant_changes_new (id, owner_id, kind, summary, detail, payload, via, conversation_id, message_id, status, error, result, created_at, decided_at, op_id, op_hash)
    SELECT id, owner_id, kind, summary, detail, payload, via, conversation_id, message_id, status, error, result, created_at, decided_at, op_id, op_hash
    FROM assistant_changes;
DROP TABLE assistant_changes;
ALTER TABLE assistant_changes_new RENAME TO assistant_changes;
CREATE INDEX assistant_changes_owner ON assistant_changes (owner_id, status, created_at);
CREATE INDEX assistant_changes_conversation ON assistant_changes (owner_id, conversation_id);
CREATE UNIQUE INDEX assistant_changes_op ON assistant_changes (owner_id, op_id) WHERE op_id IS NOT NULL;
