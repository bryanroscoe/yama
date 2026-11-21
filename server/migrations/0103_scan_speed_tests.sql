-- The scanner speed test (Bryan, 21 Nov 2026: the scanner should be as fast as CardVision, and "It
-- should work on any phone but mostly [care] about the Pixel one for now"). Every speed number so
-- far came from Chrome on a laptop; "Test scanner speed" in Scan settings times the scanner on the
-- device itself, without the camera, and keeps the result here so an agent can read a phone's real
-- timings (get_scan_speed_tests). Only when the person presses the button. Owner-only (every query
-- binds the owner), refused to an admin's View as (view_as.rs), the newest 50 per account, deleted
-- with the account (admin/delete.rs) and by the owner (DELETE /api/scan/speed-tests).
CREATE TABLE scan_speed_tests (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL,
    -- A short name for the device and browser ("Pixel 10 Pro, Android 16, Chrome 142").
    device      TEXT NOT NULL,
    -- The median tracked frame with the device's own models, and with the faster options, in ms.
    frame_ms    REAL,
    fast_ms     REAL,
    -- The whole report, as JSON (scanner speed.ts, `SpeedReport`).
    report      TEXT NOT NULL,
    bytes       INTEGER NOT NULL
);
CREATE INDEX scan_speed_tests_owner ON scan_speed_tests (owner_id, created_at);
