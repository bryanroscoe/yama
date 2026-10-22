-- The printing a deck names for a card, from an import (Moxfield's "(SET) 123 *F*", Archidekt's
-- edition, a CSV's set and number): exports and the deck page name it when you don't own a copy.
-- One row per card per deck; a later import replaces it. Goes with the deck.
CREATE TABLE deck_prints (
    deck_id           TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    oracle_id         TEXT NOT NULL,
    set_code          TEXT NOT NULL,
    collector_number  TEXT,
    finish            TEXT NOT NULL DEFAULT 'nonfoil',  -- nonfoil | foil | etched
    PRIMARY KEY (deck_id, oracle_id)
);
