-- Commander Spellbook's combos, kept locally for the computer's seats (server/src/combos.rs).
-- Spellbook publishes every combo as one file and asks tools that want the whole set to read
-- that file rather than page through its API. Yama keeps, of each combo it can use, its id, how
-- popular it is and which cards it is made of: enough to say which combos a list holds without
-- sending the list anywhere. Public data: nothing here belongs to an account.
--
-- Cards and combos are joined by Spellbook's own card number and a local combo number, not by
-- oracle id text, so the join table (several hundred thousand rows) stays small.
CREATE TABLE spellbook_cards (
    n          INTEGER PRIMARY KEY,   -- Spellbook's number for the card
    oracle_id  TEXT NOT NULL UNIQUE
);

CREATE TABLE spellbook_combos (
    n          INTEGER PRIMARY KEY,
    id         TEXT NOT NULL UNIQUE,  -- Spellbook's variant id: https://commanderspellbook.com/combo/{id}/
    cards      INTEGER NOT NULL,      -- how many cards it is made of
    popularity INTEGER,               -- Spellbook's count of decks with it; NULL when it has none
    run        TEXT NOT NULL          -- the import that last saw it (import_runs.id); older ones are deleted
);

CREATE TABLE spellbook_combo_cards (
    card   INTEGER NOT NULL,          -- spellbook_cards.n
    combo  INTEGER NOT NULL REFERENCES spellbook_combos(n) ON DELETE CASCADE,
    PRIMARY KEY (card, combo)
) WITHOUT ROWID;
CREATE INDEX spellbook_combo_cards_combo ON spellbook_combo_cards (combo);
