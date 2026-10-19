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

-- Whether a printing exists only in a video game (Scryfall's `digital`: MTGO or Arena) and the
-- kind of set it's in (Scryfall's `set_type`: core, expansion, masters, memorabilia, promo, ...),
-- so a Moxfield export of a card you don't own names a paper printing. NULL = not loaded yet
-- (default_cards importer version 2).
ALTER TABLE printings ADD COLUMN digital INTEGER;
ALTER TABLE printings ADD COLUMN set_type TEXT;

-- ── batch "table-stats" ────────────────────────────────────────────────────

-- The seat that took the first turn; turn order runs clockwise (up the seat numbers) from it.
-- NULL = nobody said. In-person games get it from the table's set_first event (Roll for first,
-- "X goes first", or the finish sheet's question) or from Log a game; online games from the
-- rules engine's starting player. Passing the turn never fills it in.
ALTER TABLE games ADD COLUMN first_seat INTEGER;

-- How the winner won, if the table said. NULL = not recorded, and always NULL for a draw.
ALTER TABLE games ADD COLUMN win_condition TEXT CHECK (win_condition IN
    ('combat', 'commander_damage', 'combo', 'alternate', 'mill', 'poison', 'concession', 'other'));

-- How much fun each player had, 1 to 5, if they said. NULL = skipped.
ALTER TABLE game_seats ADD COLUMN fun INTEGER CHECK (fun BETWEEN 1 AND 5);

-- ── batch "calendar" ───────────────────────────────────────────────────────

-- Sets from Scryfall's /sets that release today or later, plus every set someone watches and the
-- sets under it (Star Trek Commander, trc, sits under Star Trek, trk). Refreshed once a day with
-- YAMA_AUTO_IMPORT=1, or by `yama-server import-calendar`; each refresh is logged in import_runs
-- (kind 'scryfall_sets'). A set that has come out drops off at the next refresh unless watched.
CREATE TABLE calendar_sets (
    code             TEXT PRIMARY KEY,   -- Scryfall's set code, lowercase
    name             TEXT NOT NULL,
    set_type         TEXT NOT NULL,      -- Scryfall's set_type: expansion, commander, token, ...
    released_at      TEXT,               -- YYYY-MM-DD as Scryfall has it; NULL = no date yet
    card_count       INTEGER NOT NULL,   -- cards Scryfall has in the set so far (previews before release)
    printed_size     INTEGER,            -- the printed set size, when Scryfall knows it; NULL = unknown
    parent_set_code  TEXT,
    digital          INTEGER NOT NULL DEFAULT 0,
    scryfall_uri     TEXT,
    checked_at       TEXT NOT NULL       -- RFC 3339, when Yama last read this set from Scryfall
);

-- Sets a person watches for their Commander precon lists. Not a foreign key: a watch outlives
-- the set's row if Scryfall ever drops or renames the code.
CREATE TABLE calendar_watches (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    set_code    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, set_code)
);

-- Commander precons that MTGJSON has lists for (DeckList.json entries of type 'Commander Deck'),
-- refreshed once a day (import_runs kind 'mtgjson_decklist'). A deck's own list is downloaded
-- from MTGJSON when it belongs to a watched set, or when someone starts a deck from it, and kept
-- here as a pasteable list. NULL list columns = not downloaded yet.
CREATE TABLE calendar_precons (
    file_name            TEXT PRIMARY KEY,  -- MTGJSON's fileName, e.g. MultiverseReforged_FRC
    set_code             TEXT NOT NULL,     -- lowercase, as Scryfall writes it
    name                 TEXT NOT NULL,
    release_date         TEXT,              -- YYYY-MM-DD, per MTGJSON
    source_url           TEXT,              -- where MTGJSON got the list (usually Wizards' announcement)
    first_seen_at        TEXT NOT NULL,     -- RFC 3339, when Yama first saw MTGJSON list it
    commanders           TEXT,              -- JSON array of the commanders' names
    list_text            TEXT,              -- the stock list, Commander and Deck sections, with set and number
    list_cards           INTEGER,           -- cards in the list, commanders included, sideboard not
    list_fetched_at      TEXT,              -- RFC 3339
    list_source_version  TEXT,              -- MTGJSON's meta.version of the downloaded file
    list_error           TEXT,              -- why the last download failed; NULL after a good one
    list_tried_at        TEXT               -- last download attempt, good or not, to pace retries
);
CREATE INDEX calendar_precons_set ON calendar_precons(set_code);
