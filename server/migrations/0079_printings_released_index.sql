-- Sorting a card search by first release (order=released) reads each match's earliest printing
-- date. With this index that is one seek per card instead of reading the card's printings: a
-- search of every card went from about 300 ms a page to about 30 on a copy of production.
CREATE INDEX printings_oracle_released ON printings(oracle_id, released_at);
