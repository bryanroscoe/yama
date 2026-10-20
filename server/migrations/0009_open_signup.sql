-- Open sign-up (YAMA_OPEN_SIGNUP, 2026-10-20): admins can turn an account off, and the lab
-- keeps what each experiment asked for so a day's allowance survives deleting runs.

-- Set by an admin (`yama-server user disable`, or Group, Accounts). NULL = the account works.
-- A disabled account has no sessions, its script keys and Cloudflare Access sign-ins are refused,
-- and its lab experiments wait until it is enabled again.
ALTER TABLE users ADD COLUMN disabled_at TEXT;

-- Games each lab experiment asked for when it was created. Kept when the experiment is deleted,
-- so deleting runs doesn't give an account a fresh daily allowance.
CREATE TABLE lab_usage (
    experiment_id TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    games         INTEGER NOT NULL,
    created_at    TEXT NOT NULL
);
CREATE INDEX lab_usage_owner ON lab_usage(owner_id, created_at);

INSERT INTO lab_usage (experiment_id, owner_id, games, created_at)
    SELECT id, owner_id, games_total, created_at FROM lab_experiments;
