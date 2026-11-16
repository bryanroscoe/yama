-- no-transaction
-- Sections (Bryan, 2026-11-15: "I have most of these in one box with lots of dividers and some of
-- those dividers have sub sections as well"). A container can sit inside another: a section in a
-- box, a sub-section in a section. `parent_id` is that container (NULL: top level).
--
-- Names were unique per owner and kind across the whole collection (UNIQUE(owner_id, kind, name));
-- now they are unique among siblings, so two boxes can each have a section called "Plains". SQLite
-- can't drop a table's UNIQUE constraint, so the table is rebuilt. Every existing container is top
-- level and kept the same, so no existing row can clash under the new rule.
--
-- The rebuild runs with foreign keys off, in its own transaction (SQLite's documented way to
-- rebuild a table: https://sqlite.org/lang_altertable.html#otheralter). With them on, dropping
-- the old table would be an implicit DELETE, and `collection_items.container_id ... ON DELETE SET
-- NULL` would unfile every card. `foreign_keys` can't change inside a transaction, hence
-- `no-transaction` above; the copy, drop and rename are still one transaction below.
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE containers_new (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    kind        TEXT NOT NULL CHECK (kind IN ('binder','deck','list','box')),
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    -- The container this one sits in. Deleting a container that still has sections is refused
    -- (collection.rs); deleting an account deletes all its containers in one statement.
    parent_id   TEXT REFERENCES containers(id),
    CHECK (parent_id IS NULL OR parent_id != id)
);
INSERT INTO containers_new (id, owner_id, kind, name, created_at)
    SELECT id, owner_id, kind, name, created_at FROM containers;
DROP TABLE containers;
ALTER TABLE containers_new RENAME TO containers;
-- Unique among siblings: same owner, kind and parent.
CREATE UNIQUE INDEX containers_sibling_name ON containers(owner_id, kind, IFNULL(parent_id, ''), name);
CREATE INDEX containers_parent ON containers(parent_id);
COMMIT;
PRAGMA foreign_keys = ON;
