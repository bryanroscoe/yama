-- A deck's description: a short text its owner writes about it. Unlike a version's note, which
-- stays private, it shows on the deck's shared page to anyone who can see the deck, so it is its
-- own column and nothing else is ever copied into it. NULL: no description.
ALTER TABLE decks ADD COLUMN description TEXT;
