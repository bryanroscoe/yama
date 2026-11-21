-- Scanner diagnostics' timing records (Bryan, 20 Nov 2026: "We can get more"). The struggle
-- records (scan_diagnostics) keep only cards the scanner struggled with, so nothing measured how
-- fast ordinary scans settle, or how often each rule settles a card. While Scanner diagnostics is
-- on, the scanner now also sends one small record, with no images, for every card it settles: how
-- long the card took from appearing to being named, which rule named it, the art's top score and
-- lead, the frames read, then how its printing was settled and how long that took. Owner-only like
-- the struggle records, kept apart from them so they never push those out (their own cap), and
-- deleted with them ("Delete them") and with the account (admin/delete.rs).
CREATE TABLE scan_timings (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    -- How the card ended: filed, picked, wrong, skipped, left.
    outcome     TEXT NOT NULL,
    -- The rule that named the card: sure, leads, twice, title, text, closeup, typed.
    rule        TEXT NOT NULL,
    -- 'printing' (the collection: the printing is settled too) or 'identity' (deck and box scans).
    mode        TEXT NOT NULL,
    -- Read from a photo rather than the live camera.
    photo       INTEGER NOT NULL DEFAULT 0,
    -- Milliseconds from the card appearing in view to the card being named, and the frames read.
    ms          INTEGER,
    frames      INTEGER,
    -- The art's top score and its lead over the next different card, when the art was read.
    top         REAL,
    lead        REAL,
    -- How the printing was settled (only, set, collector, picked, corrected), and the milliseconds
    -- from the card being named to that. NULL where only the card matters.
    printing    TEXT,
    printing_ms INTEGER,
    -- The camera's delivered resolution, the bundle with the art model (scan.rs), and the option
    -- each scanner slot ran (art, look, text, lock: scan.rs `recorded_models`, as for scan photos).
    camera      TEXT,
    bundle      TEXT,
    models      TEXT,
    -- Anything else, as a small JSON object.
    detail      TEXT NOT NULL,
    bytes       INTEGER NOT NULL
);
CREATE INDEX scan_timings_owner ON scan_timings (owner_id, created_at);

-- Full-resolution crops kept with a scan photo (Bryan, 20 Nov 2026): the 640 px photo puts the set
-- symbol at about 20 px and the collector line at about 7 px, too small to train a printing model
-- on. So each photo also keeps the set symbol's area and the collector strip, warped upright from
-- the card's corners at the card's own resolution in the frame. Only the card, never the frame
-- around it. They're files under the data directory, scan-samples/<owner>/<id>/<name>.jpg, out of
-- the main database; these list them (JSON: name, width, height, bytes) and their bytes, total.
-- They go with their photo: the cap, Delete them, account deletion. Shared as their photo is.
-- When an account last used "Delete them" on its scan photos ('samples') or its scanner
-- diagnostics ('diagnostics', timing records included): an upload that began at or before that is
-- refused, so a photo or record still on its way can't arrive after the deletion (scan_clears.rs).
CREATE TABLE scan_clears (
    owner_id   TEXT NOT NULL REFERENCES users(id),
    kind       TEXT NOT NULL,
    cleared_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, kind)
);

ALTER TABLE scan_samples ADD COLUMN crops TEXT;
ALTER TABLE scan_samples ADD COLUMN crop_bytes INTEGER NOT NULL DEFAULT 0;
