-- Commander Spellbook's answer for each public stock precon list (deck_checks/precons.rs), so
-- the precon pages can read combos, mass land denial and extra turns as a person's own deck
-- page does. A stock list is public catalog data: asking about one sends nothing of anyone's.
-- Kept apart from deck_version_checks in both directions: a person's check is never read for a
-- stock list, and these never answer for a person's deck.
--
-- Keyed by the list asked about (deck_checks::list_hash), so a corrected stock list gets its
-- own answer; the old one stops being read and is deleted when the new one arrives. A failed
-- try keeps the last good answer.
CREATE TABLE precon_checks (
    list_hash        TEXT NOT NULL,
    source           TEXT NOT NULL,              -- 'commander_spellbook'
    precon_id        TEXT NOT NULL,              -- the precon it was last asked for (precons.id)
    checked_at       TEXT,                       -- when the stored answer was asked for
    result           TEXT,                       -- JSON: bracket_tag, game_changers, mld, extra_turns, combos, unrecognized
    attempts         INTEGER NOT NULL DEFAULT 0, -- failed tries since the last answer
    last_attempt_at  TEXT,
    error            TEXT,
    PRIMARY KEY (list_hash, source)
);
