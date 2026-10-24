-- Answers Yama remembers for people in an online game (2026-10-24, Bryan's decision 4: "Always pay
-- for Rhystic Study", "Always send my commander to the command zone"): a JSON list of
-- yama_play::YamaAnswer, saved with the game so a restart keeps them. Kept per game, not per
-- account. NULL when there are none.
ALTER TABLE online_games ADD COLUMN answers TEXT;
