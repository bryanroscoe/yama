-- The scanner's art supplement (server/src/scan_art.rs, docs/scanner.md "Extending the gallery"):
-- one embedding per illustration the pinned art bundle doesn't know, made by that bundle's own
-- embedding graph from Scryfall's art crop. Only the vector is kept, never the image. Rows belong
-- to the bundle version whose graph made them: a vector from one bundle's weights means nothing
-- to another's, so a new pin starts over (the job deletes other versions' rows).
CREATE TABLE scan_arts (
    illustration_id  TEXT NOT NULL,
    bundle           TEXT NOT NULL,
    -- The printing whose art crop was embedded; `<id>-1` for a back face, as in the bundle.
    scryfall_id      TEXT NOT NULL,
    name             TEXT NOT NULL,
    set_code         TEXT NOT NULL,
    collector_number TEXT NOT NULL,
    layout           TEXT NOT NULL,
    -- Index into the bundle's manifest `constants.frame_names`, and the score penalty.
    frame            INTEGER,
    penalty          REAL,
    -- 128 little-endian float32s, L2-normalised. NULL while it failed (error says why).
    vector           BLOB,
    error            TEXT,
    tries            INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (illustration_id, bundle)
);
