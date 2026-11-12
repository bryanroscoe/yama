-- Moderation of what people make public (public by default, 12 Nov 2026).
--
-- content_reports: a report anyone can send about a shared deck or a profile, with no account.
-- Nothing about who sent it is kept: no address, no account. It belongs to the account whose
-- page was reported and goes when that account is deleted. (A deck its owner deletes is
-- archived, not removed, so its reports stay for the admin until then.)
CREATE TABLE content_reports (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('deck', 'profile')),
    owner_id TEXT NOT NULL REFERENCES users(id),
    -- The deck, for a deck report.
    deck_id TEXT REFERENCES decks(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN ('spam', 'hateful', 'sexual', 'personal', 'other')),
    -- What the reporter wrote, if anything.
    details TEXT,
    created_at TEXT NOT NULL,
    -- Set together when an admin deals with it.
    resolved_at TEXT,
    resolution TEXT CHECK (resolution IN ('taken_down', 'dismissed')),
    resolved_by TEXT REFERENCES users(id),
    note TEXT
);
CREATE INDEX content_reports_open ON content_reports(created_at) WHERE resolved_at IS NULL;
CREATE INDEX content_reports_owner ON content_reports(owner_id);
CREATE INDEX content_reports_deck ON content_reports(deck_id);

-- deck_takedowns: an admin made a deck and its configurations private, who and why, recorded
-- against the main deck. They stay private (their owner cannot share them again) until an admin
-- restores them.
CREATE TABLE deck_takedowns (
    id TEXT PRIMARY KEY,
    deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id),
    -- The admin; NULL once that account is deleted.
    admin_id TEXT REFERENCES users(id),
    reason TEXT NOT NULL,
    -- What the deck's visibility was, for the record.
    was_visibility TEXT NOT NULL,
    created_at TEXT NOT NULL,
    restored_at TEXT
);
CREATE INDEX deck_takedowns_deck ON deck_takedowns(deck_id);
CREATE INDEX deck_takedowns_owner ON deck_takedowns(owner_id);

-- Set while a takedown stands, to the takedown's time, on every deck it covers: the deck is
-- private and may not be shared.
ALTER TABLE decks ADD COLUMN taken_down_at TEXT;
