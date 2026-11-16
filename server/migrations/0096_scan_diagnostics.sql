-- Scanner diagnostics (Bryan, 15 Nov 2026: printings read wrong on his Pixel 10 Pro, and the
-- scanner consult's first item: a replayable record of what the scanner saw). Only while the
-- person has "Scanner diagnostics" on, on that device; owner-only, never shared. One row per card
-- the scanner struggled with: how it ended, the camera, and everything it read, as JSON. The
-- images (the card's full-resolution bottom strip, a 640 px photo) are files under the data
-- directory, scan-diagnostics/<owner>/<id>/<name>.jpg, out of the main database; this row lists
-- them. Capped per account, deleted on request and with the account (admin/delete.rs).
CREATE TABLE scan_diagnostics (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    -- How it ended: filed, picked, wrong, skipped, left.
    outcome     TEXT NOT NULL,
    card_name   TEXT,
    engine      TEXT,
    camera      TEXT,
    detail      TEXT NOT NULL,
    bundle      TEXT,
    -- The images' names, sizes and dimensions, as JSON; their bytes, total.
    images      TEXT NOT NULL,
    bytes       INTEGER NOT NULL
);
CREATE INDEX scan_diagnostics_owner ON scan_diagnostics (owner_id, created_at);
