-- Public game log lines, saved with the replay so a restarted server can show them.
ALTER TABLE online_games ADD COLUMN log TEXT;
