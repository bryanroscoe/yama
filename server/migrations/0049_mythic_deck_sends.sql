-- The Mythic Tools bridge (server/src/bridges/mythic/decks.rs): decks sent to Mythic, waiting for
-- the send snippet to come back with the Mythic deck's id. Each row is a one-time code, so only a
-- send its owner started can link a deck. Removing the bridge drops this table with the others.
CREATE TABLE mythic_pushes (
    code        TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deck_id     TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    version_id  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX mythic_pushes_owner ON mythic_pushes(owner_id, created_at);
