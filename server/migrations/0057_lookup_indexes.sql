-- Indexes for lookups that read whole tables (2026-11-02; each checked with EXPLAIN QUERY PLAN
-- against the queries that use it). SQLite indexes a primary key or UNIQUE column itself, but not
-- a foreign key: deleting a parent row, or listing a parent's rows, otherwise reads every row.
-- decks_id_owner starts with id, so it doesn't help a deck list.

-- An account's decks (the deck list, folders, deck boxes, imports).
CREATE INDEX decks_owner ON decks(owner_id, archived);
-- A deck's versions, oldest first (history, results); and a deck's deletion.
CREATE INDEX deck_versions_deck ON deck_versions(deck_id, created_at);
-- Seats someone played (games played, their games list, account deletion).
CREATE INDEX game_seats_user ON game_seats(user_id);
-- Seats a deck version played (a deck's results on the deck list and deck page).
CREATE INDEX game_seats_deck_version ON game_seats(deck_version_id);
-- Games someone logged, and a playgroup's games, newest first.
CREATE INDEX games_created_by ON games(created_by, started_at);
CREATE INDEX games_playgroup ON games(playgroup_id, started_at);
-- An account's sessions (sign out everywhere, turning an account off, last sign-in).
CREATE INDEX sessions_user ON sessions(user_id);
-- What's in a box or binder (the collection's containers, emptying one).
CREATE INDEX collection_items_container ON collection_items(container_id);

-- Each date prices are stored under, so the newest is one lookup: MAX(date) over price_snapshots
-- reads that table's whole index (0.4 s on saget at 1.6 million rows). The card import adds a
-- date in the transaction that stores its prices.
CREATE TABLE price_dates (date TEXT PRIMARY KEY) WITHOUT ROWID;
INSERT INTO price_dates SELECT DISTINCT date FROM price_snapshots;
