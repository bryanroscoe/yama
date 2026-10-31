-- Research notes shared by link or on the profile (Bryan, 2026-10-31: send a friend the
-- upgrade suggestions made for his decks, and share them with anyone else). Same three levels as
-- decks: private (only the owner), link (anyone with /r/<share_token>), public (that, and listed
-- on the profile). Every existing note stays private; a token is made the first time a note is
-- shared, and a new one (reset link) ends every old link. Refreshing a note keeps both.
ALTER TABLE research_reports ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'link', 'public'));
ALTER TABLE research_reports ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX research_reports_share_token ON research_reports(share_token) WHERE share_token IS NOT NULL;
