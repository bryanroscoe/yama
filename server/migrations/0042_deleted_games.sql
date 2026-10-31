-- Table games their recorder deleted, by id only (random UUIDs, no account), so another device
-- that still has the game can't upload it again (games.rs `remove`, `create`).
CREATE TABLE deleted_games (
    id          TEXT PRIMARY KEY,
    deleted_at  TEXT NOT NULL
);
