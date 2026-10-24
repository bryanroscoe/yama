-- Turn controls in online games (2026-10-23, the game interactions review's build plan section 6):
-- where the game stops for a person and whether they want full control, saved per account so
-- they carry across games and devices. Pass modes and holding priority last only within a game
-- and aren't stored.
CREATE TABLE play_prefs (
    user_id       TEXT PRIMARY KEY REFERENCES users(id),
    -- JSON {"own": [...], "others": [...]}: phase's step names on your turns and on others'.
    -- NULL keeps the usual smart stops.
    stops         TEXT,
    full_control  INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL
);
