-- Quick wins from the 2026-10-18 app survey (branch quickwins). Later batches append here.

-- ── batch "cards" ──────────────────────────────────────────────────────────

-- Scryfall's `game_changer` flag (the Commander Game Changers list), from oracle_cards.
-- NULL means not loaded yet: every card starts that way until the next oracle import, and the
-- app says so instead of reading it as "not a Game Changer".
ALTER TABLE cards ADD COLUMN game_changer INTEGER;

-- Which version of Yama's importer wrote each run (NULL for runs before this migration, read
-- as 1). When an import starts reading a new field, its version goes up (import.rs,
-- importer_version) and a running server re-imports that kind on its next pass instead of
-- waiting for its usual age or a new Scryfall file. Version 2 of oracle_cards reads game_changer.
ALTER TABLE import_runs ADD COLUMN importer_version INTEGER;

-- Scryfall's rulings bulk file. Replaced as a whole on each import, so there is no key of
-- its own; oracle_id isn't a foreign key because rulings also cover cards we skip.
CREATE TABLE rulings (
    oracle_id     TEXT NOT NULL,
    source        TEXT NOT NULL,   -- wotc | scryfall
    published_at  TEXT NOT NULL,   -- YYYY-MM-DD
    comment       TEXT NOT NULL
);
CREATE INDEX rulings_oracle ON rulings(oracle_id, published_at);
