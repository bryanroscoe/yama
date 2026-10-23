-- Collection fixes (2026-10-23): "Add to my collection" for a deck, and Mythic Tools re-imports
-- that update rather than double.

-- A deck can say a card is a proxy (an import's Proxy column, or an Archidekt "Proxy" category).
-- "Add to my collection" then adds a proxy copy. A proxy the import named no printing for is kept
-- with set_code '' (no printing to name in exports).
ALTER TABLE deck_prints ADD COLUMN proxy INTEGER NOT NULL DEFAULT 0;

-- Mythic Tools files already imported, by the SHA-256 of their text (byte-order mark removed).
-- Importing the same file again adds nothing, even after copies were moved or removed in Yama.
-- Files imported before this table existed are recognised by their op ids (mythic:<hash>:<row>).
CREATE TABLE mythic_imports (
    owner_id     TEXT NOT NULL REFERENCES users(id),
    file_hash    TEXT NOT NULL,
    imported_at  TEXT NOT NULL,
    report       TEXT NOT NULL,   -- JSON: the import's counts, as the import returned them
    PRIMARY KEY (owner_id, file_hash)
);
