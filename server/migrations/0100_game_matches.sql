-- A game can be one game of a match (best of three, say: Limited is played that way). The games
-- stay games of their own, counted one by one; these tie them together. match_id is made on the
-- device that started the match (a UUID); match_game is which game of it this was, from 1; and
-- match_best_of how many games the match could run to (3 or 5). All three are NULL for a game
-- that was played on its own.
ALTER TABLE games ADD COLUMN match_id TEXT;
ALTER TABLE games ADD COLUMN match_game INTEGER;
ALTER TABLE games ADD COLUMN match_best_of INTEGER;
CREATE INDEX games_match ON games(match_id) WHERE match_id IS NOT NULL;
