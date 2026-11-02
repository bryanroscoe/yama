-- Public research answers kept between restarts and shared between people (2026-11-02;
-- server/src/mcp/research/client.rs). Only GETs of public data: a deck list sent to Commander
-- Spellbook is never stored. Each answer keeps its provider and when it was fetched, and goes
-- when its provider's time is up or, least recently used first, when the table passes 32 MiB.
CREATE TABLE research_cache (
    key        TEXT PRIMARY KEY,  -- the request URL
    provider   TEXT NOT NULL,     -- scryfall | spellbook | edhrec | moxfield | archidekt | rules
    fetched_at TEXT NOT NULL,     -- RFC 3339, when Yama fetched it
    expires_at INTEGER NOT NULL,  -- unix seconds
    used_at    INTEGER NOT NULL,  -- unix seconds, for least-recently-used eviction
    body       BLOB NOT NULL
);
