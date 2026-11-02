-- A deck check's answer depends only on the card list it sends (2026-11-02,
-- server/src/deck_checks.rs): the commander and main cards, each oracle id with its quantity.
-- A version whose list matches one already answered (a save that changed only printings, a
-- reverted list, the same precon in many accounts) reuses that answer instead of asking
-- Commander Spellbook again. NULL for checks queued before this.
-- `estimate` keeps Spellbook's answer as sent, so a reused one is summarized again against the
-- receiving deck's own cards: the names shown come from that deck or Spellbook, never from the
-- deck (or account) that asked first. Only answers with it are reused.
ALTER TABLE deck_version_checks ADD COLUMN list_hash TEXT;
ALTER TABLE deck_version_checks ADD COLUMN estimate TEXT;
CREATE INDEX deck_version_checks_list ON deck_version_checks (source, list_hash, checked_at) WHERE list_hash IS NOT NULL;
