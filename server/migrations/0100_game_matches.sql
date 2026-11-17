-- A game can be one game of a match (best of three, say: Limited is played that way). The games
-- stay games of their own, counted one by one; these tie them together. match_id is made on the
-- device that started the match (a UUID); match_game is which game of it this was, from 1;
-- match_best_of how many games the match could run to (3 or 5); match_wins the games each seat
-- had won before this one, by this game's seat numbers (a JSON array of numbers), and
-- match_draws the games before it nobody won. The score is kept per game, as the table had it,
-- because seats are renumbered from game to game and players can be renamed mid-match. All are
-- NULL for a game played on its own.
ALTER TABLE games ADD COLUMN match_id TEXT;
ALTER TABLE games ADD COLUMN match_game INTEGER;
ALTER TABLE games ADD COLUMN match_best_of INTEGER;
ALTER TABLE games ADD COLUMN match_wins TEXT;
ALTER TABLE games ADD COLUMN match_draws INTEGER;
CREATE INDEX games_match ON games(match_id) WHERE match_id IS NOT NULL;

-- Outside Commander a seat has no commander to color it: the colors its player picked for their
-- deck ("WU"), as the game started (later changes are the game's "seat" events). NULL otherwise.
ALTER TABLE game_seats ADD COLUMN colors TEXT;
