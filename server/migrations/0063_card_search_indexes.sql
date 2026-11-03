-- Card search orders that an index can walk, so a page of a broad search doesn't sort every
-- matching card first (2026-11-02, measured on a copy of production's 36,747 cards: 14-144 ms
-- down to about 1 ms). The default name order uses cards_name (NOCASE, 0001).
CREATE INDEX cards_edhrec ON cards (edhrec_rank IS NULL, edhrec_rank, name);
CREATE INDEX cards_cmc ON cards (cmc, name);

-- Built on every import but never queried. Searching with it measured no faster than the
-- plain scan it would replace (14 ms either way for o:draw), and a trigram index that could
-- serve name and o: substrings weighs 28.6 MB for a millisecond or two.
DROP TABLE cards_fts;
