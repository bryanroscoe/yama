-- A deck's "Considering" list (maybeboard): cards its owner is thinking about, kept with each
-- saved version but apart from the version's cards, so nothing that reads a deck's list
-- (legality, stats, prices, exports, games, the lab) ever counts them. A JSON array of
-- {oracle_id, name, qty}; NULL: none.
ALTER TABLE deck_versions ADD COLUMN maybe TEXT;
