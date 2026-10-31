-- Table games deleted on purpose, so a device that still has one can't upload it again
-- (games.rs `remove`, `create`). Kept per account: a tombstone only refuses uploads from the
-- account that deleted it, so knowing a game's id (it's in the join link) doesn't let anyone
-- else block it. Account deletion removes an account's rows (admin/delete.rs).
CREATE TABLE deleted_games (
    id          TEXT NOT NULL,
    deleted_by  TEXT NOT NULL REFERENCES users(id),
    deleted_at  TEXT NOT NULL,
    PRIMARY KEY (id, deleted_by)
);
