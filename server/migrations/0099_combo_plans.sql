-- What the computer learned about a list's combos before playing it (server/src/combo_plans.rs):
-- for each combo Commander Spellbook lists in the list, whether a practice game of the list
-- won with it (`yama_play::ComboPlan`). Worked out once per list and engine, in the background,
-- and handed to every computer seat that plays the list, so no game spends turns rehearsing.
-- Keyed by the list's hash (deck_checks::list_hash), so saved decks, precons and guests' lists
-- share it. Game data about card lists; nothing here belongs to an account.
CREATE TABLE combo_plans (
    list_hash  TEXT NOT NULL,
    engine     TEXT NOT NULL,   -- yama_play::ENGINE_VERSION the rehearsals ran on
    combos     TEXT NOT NULL,   -- JSON: [yama_play::SeatCombo] with each one's plan
    learned_at TEXT NOT NULL,
    PRIMARY KEY (list_hash, engine)
) WITHOUT ROWID;
