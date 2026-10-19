-- Quick wins from the 2026-10-18 app survey (branch quickwins). Later batches append here.

-- ── batch "cards" ──────────────────────────────────────────────────────────

-- Scryfall's `game_changer` flag (the Commander Game Changers list), from oracle_cards.
ALTER TABLE cards ADD COLUMN game_changer INTEGER NOT NULL DEFAULT 0;

-- Scryfall's rulings bulk file. Replaced as a whole on each import, so there is no key of
-- its own; oracle_id isn't a foreign key because rulings also cover cards we skip.
CREATE TABLE rulings (
    oracle_id     TEXT NOT NULL,
    source        TEXT NOT NULL,   -- wotc | scryfall
    published_at  TEXT NOT NULL,   -- YYYY-MM-DD
    comment       TEXT NOT NULL
);
CREATE INDEX rulings_oracle ON rulings(oracle_id, published_at);
