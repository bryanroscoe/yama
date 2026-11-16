-- Swappable spares (Bryan, 15 Nov 2026): cards kept in a deck's box on top of its 100, such as the
-- bracket bag's cards and ready swaps (Talisman of Creativity rides in the Riders of Rohan box to
-- come in for Thought Vessel at Bracket 4). They are copies in their own container, linked to the
-- deck here, so nothing that reads the deck's list (size, legality, analysis, prices, games, the
-- lab) or its main box (`container_id`) ever counts them. One container per main deck; a
-- configuration uses its main deck's. The container keeps its kind and name.
ALTER TABLE decks ADD COLUMN spares_container_id TEXT;
CREATE UNIQUE INDEX decks_spares_container ON decks(spares_container_id) WHERE spares_container_id IS NOT NULL;

-- What a spare swaps for, as the owner wrote it (the plan's bracket bags say it too, and are read
-- live). Keyed by main deck and card; removing the card from the spares doesn't remove the note.
CREATE TABLE deck_spare_swaps (
    owner_id    TEXT NOT NULL REFERENCES users(id),
    deck_id     TEXT NOT NULL,
    oracle_id   TEXT NOT NULL,
    swaps_out   TEXT,              -- the card it comes in for
    bracket     INTEGER CHECK (bracket BETWEEN 1 AND 5),
    note        TEXT,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (deck_id, oracle_id)
);
CREATE INDEX deck_spare_swaps_owner ON deck_spare_swaps(owner_id);

-- The boxes the plan's swap-in made, "<deck> swap bag", become those decks' swappable spares when
-- exactly one live main deck of the owner has that name (ignoring case) and no live deck keeps its
-- 100 in it. Only the link is written:
-- no copy moves and no container changes, so undoing it is
--   UPDATE decks SET spares_container_id = NULL;
UPDATE decks SET spares_container_id = (
    SELECT c.id FROM containers c
    WHERE c.owner_id = decks.owner_id AND c.kind = 'box' AND lower(c.name) = lower(decks.name || ' swap bag')
      AND NOT EXISTS (SELECT 1 FROM decks b WHERE b.owner_id = c.owner_id AND b.archived = 0 AND b.container_id = c.id)
    ORDER BY c.created_at, c.id LIMIT 1)
WHERE archived = 0 AND parent_id IS NULL AND spares_container_id IS NULL
  AND (SELECT COUNT(*) FROM decks d2
       WHERE d2.owner_id = decks.owner_id AND d2.archived = 0 AND d2.parent_id IS NULL AND lower(d2.name) = lower(decks.name)) = 1
  AND EXISTS (SELECT 1 FROM containers c
              WHERE c.owner_id = decks.owner_id AND c.kind = 'box' AND lower(c.name) = lower(decks.name || ' swap bag')
                AND NOT EXISTS (SELECT 1 FROM decks b WHERE b.owner_id = c.owner_id AND b.archived = 0 AND b.container_id = c.id));
