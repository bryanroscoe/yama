-- Op IDs are unique per user, not globally: two people importing the same Mythic Tools file
-- produce the same op IDs and both must apply.
CREATE TABLE applied_ops_new (
    owner_id    TEXT NOT NULL REFERENCES users(id),
    op_id       TEXT NOT NULL,
    device_id   TEXT,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    applied_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, op_id)
);
INSERT INTO applied_ops_new (owner_id, op_id, device_id, kind, payload, applied_at)
    SELECT owner_id, op_id, device_id, kind, payload, applied_at FROM applied_ops;
DROP TABLE applied_ops;
ALTER TABLE applied_ops_new RENAME TO applied_ops;

-- When an update merges one row into another, ops still pointing at the old row follow it here.
CREATE TABLE item_aliases (
    old_id      TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    new_id      TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
