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

-- ── batch "decks" ──────────────────────────────────────────────────────────

-- The bracket the owner declares for a deck (1-5, the Commander brackets), for the pre-game
-- talk. NULL = not declared. Estimates live in deck_version_checks; neither overwrites the other.
ALTER TABLE decks ADD COLUMN bracket INTEGER CHECK (bracket BETWEEN 1 AND 5);

-- Colors of mana a card can make (Scryfall's produced_mana, in WUBRGC order), for the deck
-- page's land sources. '' = makes no mana; NULL = not loaded yet (oracle importer version 3).
ALTER TABLE cards ADD COLUMN produced_mana TEXT;

-- Outside checks of a deck version. Today the only source is Commander Spellbook's
-- estimate-bracket (source 'commander_spellbook'): its bracket tag, the cards it flags, and the
-- combos it finds. A row is queued when a version is saved and filled in by a background worker,
-- so saving never waits on the network. Versions are immutable, but the outside data changes
-- (new combos, Game Changer list updates), so "check again" re-queues the same row; an older
-- answer stays until a newer one arrives.
CREATE TABLE deck_version_checks (
    version_id       TEXT NOT NULL REFERENCES deck_versions(id) ON DELETE CASCADE,
    source           TEXT NOT NULL,
    requested_at     TEXT NOT NULL,   -- RFC 3339; pending while checked_at is NULL or older
    checked_at       TEXT,            -- RFC 3339, when the answer below came back
    bracket_tag      TEXT,            -- Spellbook: E C O P S R, or B for a banned card
    game_changers    TEXT,            -- JSON array of card names
    mld              TEXT,            -- JSON array: cards flagged as mass land denial
    extra_turns      TEXT,            -- JSON array: cards flagged as extra turns
    combos           TEXT,            -- JSON array of {id, cards, templates, results, ...}
    unrecognized     TEXT,            -- JSON array: deck cards the source didn't know
    attempts         INTEGER NOT NULL DEFAULT 0,  -- failed tries since the last request
    last_attempt_at  TEXT,
    error            TEXT,            -- why the last try failed; NULL once one succeeds
    PRIMARY KEY (version_id, source)
);
