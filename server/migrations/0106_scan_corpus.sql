-- A training corpus from every card the scanner names (Bryan, 22 Nov 2026: "Can we turn on the
-- saving [by default] so we can have a better corpus of training photos? let's go ahead and do all
-- of this"; docs/scanner.md, "Scan photos"). Until now a photo was kept only when a card was filed,
-- corrected or marked wrong, and in Bryan's last session 41 of 42 cards ended with Skip or Scan
-- next, so almost nothing was kept. Now:
--
--   - `unconfirmed`: a card the scanner named and the person let go without filing (Skip, Scan
--     next, leaving the scanner), kept with the scanner's guess, its scores and the rule that
--     named it. A label the person gives later in the same placement updates the row
--     (`labelled_at`) rather than adding a photo.
--   - New photos are files beside their crops (scan-samples/<owner>/<id>/photo.jpg) and `image` is
--     NULL; photos saved before stay in the database, as they were.
--   - What the scanner knew: the camera (`source`: browser, native or photo), whether only the card
--     mattered (`mode`: printing or identity), the rule that named the card (`rule`), the art's
--     lead over the next different card (`lead`) and its best matches (`scores`, JSON).
--
-- SQLite can't change a CHECK constraint or drop NOT NULL in place, so the table is rebuilt with
-- the same rows. Nothing references scan_samples.
CREATE TABLE scan_samples_new (
    id                    TEXT PRIMARY KEY,
    owner_id              TEXT NOT NULL REFERENCES users(id),
    created_at            TEXT NOT NULL,
    kind                  TEXT NOT NULL CHECK (kind IN ('added', 'corrected', 'wrong', 'unconfirmed')),
    label_scryfall_id     TEXT,
    label_name            TEXT,
    guess_name            TEXT,
    guess_scryfall_id     TEXT,
    guess_illustration_id TEXT,
    method                TEXT,
    score                 REAL,
    quad                  TEXT,
    camera                TEXT,
    bundle                TEXT,
    -- The photo, for rows saved before 22 Nov 2026; NULL when it's the file photo.jpg.
    image                 BLOB,
    bytes                 INTEGER NOT NULL,
    shared                INTEGER NOT NULL DEFAULT 0,
    models                TEXT,
    crops                 TEXT,
    crop_bytes            INTEGER NOT NULL DEFAULT 0,
    source                TEXT,
    mode                  TEXT,
    rule                  TEXT,
    lead                  REAL,
    scores                TEXT,
    -- When the person's answer last changed the label of a photo already kept.
    labelled_at           TEXT
);
INSERT INTO scan_samples_new (id, owner_id, created_at, kind, label_scryfall_id, label_name, guess_name, guess_scryfall_id,
    guess_illustration_id, method, score, quad, camera, bundle, image, bytes, shared, models, crops, crop_bytes)
SELECT id, owner_id, created_at, kind, label_scryfall_id, label_name, guess_name, guess_scryfall_id,
    guess_illustration_id, method, score, quad, camera, bundle, image, bytes, shared, models, crops, crop_bytes
FROM scan_samples;
DROP TABLE scan_samples;
ALTER TABLE scan_samples_new RENAME TO scan_samples;
CREATE INDEX scan_samples_owner ON scan_samples (owner_id, created_at);
CREATE INDEX scan_samples_shared ON scan_samples (shared, created_at);
