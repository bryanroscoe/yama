-- Scan photos kept to improve the scanner (Bryan, 2026-11-06: "Saving the photos makes sense so
-- you can learn from it as well"). Only while the person has "Save scan photos" on. Each row is
-- the part of one camera frame around a card (a small JPEG), what the scanner thought it was, and
-- what the person said it was: confirmed by adding it, corrected, or marked as the wrong card.
-- Private to the account, capped per account, and deleted with it (admin/delete.rs).
CREATE TABLE scan_samples (
    id                    TEXT PRIMARY KEY,
    owner_id              TEXT NOT NULL REFERENCES users(id),
    created_at            TEXT NOT NULL,
    kind                  TEXT NOT NULL CHECK (kind IN ('added', 'corrected', 'wrong')),
    -- What the person said it is (null for 'wrong' when they didn't say).
    label_scryfall_id     TEXT,
    label_name            TEXT,
    -- What the scanner said, and how.
    guess_name            TEXT,
    guess_scryfall_id     TEXT,
    guess_illustration_id TEXT,
    method                TEXT,
    score                 REAL,
    -- The card's corners within the image, JSON [[x, y], ...], top-left first as printed.
    quad                  TEXT,
    -- The camera's delivered resolution and the recognition bundle, for comparing later.
    camera                TEXT,
    bundle                TEXT,
    image                 BLOB NOT NULL,
    bytes                 INTEGER NOT NULL
);
CREATE INDEX scan_samples_owner ON scan_samples (owner_id, created_at);
