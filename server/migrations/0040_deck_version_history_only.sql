-- A version saved for History only (a deck scan not made the deck's list, deck_scan.rs). It is
-- never the deck's list: restoring it saves a new current version. Logging a game skips it when
-- crediting the list played on a day (web/src/table/versions.ts).
ALTER TABLE deck_versions ADD COLUMN history_only INTEGER NOT NULL DEFAULT 0;
