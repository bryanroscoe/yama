-- Admin area (server/src/admin): when each account last used Yama. Written by the session check at
-- most once an hour per account, so it costs one small write an hour per active person.
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
