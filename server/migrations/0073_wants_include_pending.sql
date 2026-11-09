-- Showing upgrade ideas on a public want list is separate from approving a plan.
ALTER TABLE users ADD COLUMN wants_include_pending INTEGER NOT NULL DEFAULT 0 CHECK (wants_include_pending IN (0, 1));
