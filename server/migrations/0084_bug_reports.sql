-- Bug reports from signed-in people (bug_reports.rs), read in Admin, Bug reports. `context` is
-- what the report button saw: the page, the dialog it was opened from, the part of the screen
-- the person pointed at (its box and the words inside it), the window size and the app build.
-- Deleted with the account (admin/delete.rs).
CREATE TABLE bug_reports (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    page TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '{}',
    resolved_at TEXT
);
CREATE INDEX bug_reports_owner ON bug_reports(owner_id, created_at);
CREATE INDEX bug_reports_open ON bug_reports(resolved_at, created_at);
