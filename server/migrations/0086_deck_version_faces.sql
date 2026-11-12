-- What a listing shows of a deck's list (Browse and the public listings): its commanders, their
-- colors, the first commander's art and its artist, how many cards, and the precon the list
-- reads as started from. Read once per version: a version's cards never change, so the row is
-- good for as long as the card data it was read from, and is read again after a while
-- (`browse.rs`). Nothing here is typed by anyone: it comes from card data and the precon lists.
CREATE TABLE deck_version_faces (
    version_id TEXT PRIMARY KEY REFERENCES deck_versions(id) ON DELETE CASCADE,
    commanders TEXT NOT NULL,          -- JSON array of names, as card data names them
    color_identity TEXT NOT NULL,      -- WUBRG order; '' = colorless
    card_count INTEGER NOT NULL,       -- commander and main deck
    art_url TEXT,                      -- Scryfall's art crop, only with its artist
    art_artist TEXT,
    art_card TEXT,
    precon_id TEXT,                    -- precons.id, when at least half the precon's own cards are in the list
    made_at TEXT NOT NULL
);
CREATE INDEX deck_version_faces_precon ON deck_version_faces(precon_id) WHERE precon_id IS NOT NULL;

-- The decks a listing starts from.
CREATE INDEX decks_public ON decks(owner_id) WHERE visibility = 'public' AND archived = 0;
