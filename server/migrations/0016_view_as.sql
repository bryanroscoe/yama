-- Admin "View as" (server/src/view_as.rs): an admin sees Yama as one other person does, read only,
-- for up to 30 minutes. Each row is one viewing session and stays as the audit log (Admin, People;
-- the viewed person sees theirs under Group, You). Tied to the admin's own session, which it never
-- replaces. Deleting either account deletes its rows (admin/delete.rs).
CREATE TABLE view_sessions (
    id                  TEXT PRIMARY KEY,
    token_hash          TEXT NOT NULL UNIQUE,
    admin_id            TEXT NOT NULL REFERENCES users(id),
    admin_session_hash  TEXT NOT NULL,
    target_id           TEXT NOT NULL REFERENCES users(id),
    started_at          TEXT NOT NULL,
    expires_at          TEXT NOT NULL,
    ended_at            TEXT,
    end_reason          TEXT CHECK (end_reason IN ('stopped', 'expired', 'signed out', 'replaced', 'ended'))
);
CREATE INDEX view_sessions_target ON view_sessions (target_id, started_at);
CREATE INDEX view_sessions_admin ON view_sessions (admin_id, started_at);
