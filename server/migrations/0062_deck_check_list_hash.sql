-- A deck check's answer depends only on the card list it sends (2026-11-02,
-- server/src/deck_checks.rs): the commander and main cards, each oracle id with its quantity.
-- A version whose list matches one already answered (a save that changed only printings, a
-- reverted list, the same precon in many accounts) reuses that answer instead of asking
-- Commander Spellbook again. NULL for checks queued before this.
ALTER TABLE deck_version_checks ADD COLUMN list_hash TEXT;
CREATE INDEX deck_version_checks_list ON deck_version_checks (source, list_hash, checked_at) WHERE list_hash IS NOT NULL;
