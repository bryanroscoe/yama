-- Sharing and deck configurations (2026-10-28). Nothing becomes visible to anyone else unless
-- its owner shares it: every existing deck and collection stays private.

-- A handle someone picks for their profile (/u/<handle>), stored lowercase. Never the Google
-- display name, which is often a full real name.
ALTER TABLE users ADD COLUMN handle TEXT;
CREATE UNIQUE INDEX users_handle ON users(handle) WHERE handle IS NOT NULL;
-- What a new deck starts as.
ALTER TABLE users ADD COLUMN new_deck_visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (new_deck_visibility IN ('private', 'link', 'public'));
-- The collection's card list on the profile (never prices paid, notes, containers or proxies).
ALTER TABLE users ADD COLUMN collection_public INTEGER NOT NULL DEFAULT 0;

-- private: only the owner. link: anyone with /d/<share_token>. public: that too, and listed on
-- the owner's profile. A new token (reset link) ends every old link.
ALTER TABLE decks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'link', 'public'));
ALTER TABLE decks ADD COLUMN share_token TEXT;
UPDATE decks SET share_token = lower(hex(randomblob(10)));
CREATE UNIQUE INDEX decks_share_token ON decks(share_token) WHERE share_token IS NOT NULL;

-- Configurations: other builds of one deck ("Riders of Rohan" and its stock and after-prints
-- lists). One level only: a configuration's parent is a main deck of the same owner (checked in
-- code). `configuration` is the label ("stock"); NULL on a main deck reads as its main list.
ALTER TABLE decks ADD COLUMN parent_id TEXT REFERENCES decks(id);
ALTER TABLE decks ADD COLUMN configuration TEXT;
CREATE INDEX decks_parent ON decks(parent_id) WHERE parent_id IS NOT NULL;

-- Group what already reads as a configuration: "Name (label)" beside a live "Name" of the same
-- owner. Names stay as they are; ungrouping in Edit deck undoes it.
UPDATE decks SET
    parent_id = (SELECT p.id FROM decks p
                 WHERE p.owner_id = decks.owner_id AND p.archived = 0 AND p.id <> decks.id
                   AND p.name = substr(decks.name, 1, instr(decks.name, ' (') - 1)
                 ORDER BY p.created_at LIMIT 1),
    configuration = substr(decks.name, instr(decks.name, ' (') + 2, length(decks.name) - instr(decks.name, ' (') - 2)
WHERE archived = 0
  AND name LIKE '% (%)'
  AND length(decks.name) - instr(decks.name, ' (') - 2 > 0
  AND instr(substr(decks.name, instr(decks.name, ' (') + 2), '(') = 0
  AND EXISTS (SELECT 1 FROM decks p
              WHERE p.owner_id = decks.owner_id AND p.archived = 0 AND p.id <> decks.id
                AND p.name = substr(decks.name, 1, instr(decks.name, ' (') - 1));
-- A parent found that way is never itself a configuration ("A (x)" beside "A (x) (y)" and "A").
UPDATE decks SET parent_id = NULL, configuration = NULL
WHERE parent_id IN (SELECT id FROM decks WHERE parent_id IS NOT NULL);
