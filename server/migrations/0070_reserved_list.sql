-- Scryfall's `reserved` flag (Wizards' Reserve List: cards it has promised never to reprint),
-- from oracle_cards (Bryan, 2026-11-07: say how many of a deck's cards are on the Reserve List,
-- and let it count toward the power estimate). NULL means not loaded yet: every card starts
-- that way until the next oracle import, which version 4 of oracle_cards does on its next pass,
-- and the app says so instead of reading it as "not on the list".
ALTER TABLE cards ADD COLUMN reserved INTEGER;
