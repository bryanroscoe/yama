-- Shared deck pages show the plan's simulated win rates only when the owner turns this on
-- (Codex review of PR 14, 2026-10-28: sharing a deck isn't consent to publish plan results).
ALTER TABLE users ADD COLUMN share_lab_results INTEGER NOT NULL DEFAULT 0;
