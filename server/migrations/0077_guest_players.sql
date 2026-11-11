-- Guest players (2026-11-11): someone with no account may play the computer online after a
-- Cloudflare Turnstile check. Each gets a throwaway `users` row with `guest = 1`, signed in by its
-- own cookie (`yama_guest`) that only the play routes accept (server/src/guests.rs). Guest rows
-- are deleted with everything they made a week after they were made.
ALTER TABLE users ADD COLUMN guest INTEGER NOT NULL DEFAULT 0;
CREATE INDEX users_guest_created ON users (created_at) WHERE guest = 1;
