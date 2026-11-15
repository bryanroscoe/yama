-- Which Yama build each signed-in device runs (Bryan, 15 Nov 2026: agents must be able to tell
-- which build is on his phone without the phone). The Android app and the web app send
-- `X-Yama-Client` ("android/0.2.100 (100) web/638954329799 native/…", or "web/638954329799");
-- `client_builds.rs` keeps the last one per account and session. `device_key` is derived from the
-- session token's hash (it is not a credential and can't be turned back into one), so a new
-- sign-in on the same phone is a new row. `device` is a label read from the User-Agent ("Pixel 10
-- Pro (Android 16)", "Chrome on Mac"); the User-Agent itself isn't kept. `first_seen_at` is when
-- this device first reported this exact client string, so it says how long the build has been on
-- it. Rows go with the account (admin/delete.rs) and at most 20 are kept per account.
CREATE TABLE client_builds (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_key    TEXT NOT NULL,
    client        TEXT NOT NULL,
    device        TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, device_key)
);
