-- The Mythic Tools bridge (ARCHITECTURE.md, "Mythic Tools bridge"; server/src/bridges/mythic).
-- Only bridge tables: removing the bridge drops these two, and the games it made stay as ordinary
-- logged games.

-- What a Mythic record was linked to, per account, so importing again updates instead of adding.
-- kind 'game': a Mythic game and the Yama game made from it (or matched to it); 'player': a Mythic
-- player and the playgroup member they are (the importer's own Mythic account links to the
-- importer's user id). `mythic_changed` fingerprints the Mythic record as last imported.
CREATE TABLE mythic_links (
    owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('game', 'deck', 'list', 'player')),
    mythic_id       TEXT NOT NULL,
    yama_id         TEXT NOT NULL,
    mythic_changed  TEXT,
    synced_at       TEXT NOT NULL,
    PRIMARY KEY (owner_id, kind, mythic_id)
);
CREATE UNIQUE INDEX mythic_links_yama ON mythic_links(owner_id, kind, yama_id);

-- A Mythic game's note and tags, for the importer alone. They don't go in games.note, which every
-- seated account can read.
CREATE TABLE mythic_game_notes (
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    note        TEXT,
    tags        TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (owner_id, game_id)
);
