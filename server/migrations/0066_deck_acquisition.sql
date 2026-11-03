-- Owning a deck is an owner statement, not inferred from overlapping collection cards.
-- Private metadata: never part of the shared deck projection.
ALTER TABLE decks ADD COLUMN acquisition_status TEXT CHECK (acquisition_status IN ('owned', 'planned'));
