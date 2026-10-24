-- End of a game (2026-10-24, the game interactions review's build plan section 11): a finished
-- online game remembers the rematch its host started, so the other people in it can join that
-- lobby from their game-over screen. NULL until a rematch is started.
ALTER TABLE online_games ADD COLUMN rematch_id TEXT REFERENCES online_games(game_id) ON DELETE SET NULL;
