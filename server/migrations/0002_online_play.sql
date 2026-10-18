-- Online games played on the rules engine. The `games` row holds the shared fields
-- (mode = 'online'); this holds the lobby and the engine's replay log.
CREATE TABLE online_games (
    game_id     TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    code        TEXT NOT NULL UNIQUE,
    host_id     TEXT NOT NULL REFERENCES users(id),
    stage       TEXT NOT NULL CHECK (stage IN ('lobby','live','over')),
    seats       TEXT NOT NULL,   -- JSON: [{seat, kind, user_id, name, deck_id, deck_version_id, deck_name, color_identity, difficulty}]
    replay      TEXT,            -- engine replay log (header + actions); reproduces the game from its seed
    revision    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
