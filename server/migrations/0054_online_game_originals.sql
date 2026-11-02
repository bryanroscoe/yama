-- First pre-continuation record for each saved game, immutable during play.
-- The FK follows account/game deletion; no new public access path.
CREATE TABLE online_game_originals (
    game_id TEXT PRIMARY KEY REFERENCES online_games(game_id) ON DELETE CASCADE,
    engine_version TEXT NOT NULL,
    replay TEXT,
    log TEXT,
    answers TEXT,
    revision INTEGER NOT NULL,
    stage TEXT NOT NULL,
    saved_at TEXT NOT NULL
);
