-- Card Kingdom's retail and buylist prices and Mana Pool's lowest listings, from MTGJSON's daily
-- price file (2026-11-02; ARCHITECTURE.md, "Price history"; server/src/prices/mtgjson.rs). They
-- don't duplicate Scryfall's TCGplayer, Cardmarket and Cardhoarder series, so MTGJSON's copies of
-- those aren't read. One feed per provider, so a provider missing from a day's file leaves a gap
-- for it alone. Each value keeps its provider, kind and date; providers are never combined into
-- one number, and none of them is a store's quote.
INSERT INTO price_series (id, feed, provider, kind, finish, currency, label) VALUES
    (20, 'mtgjson:cardkingdom', 'cardkingdom', 'retail', 'nonfoil', 'USD', 'Card Kingdom retail via MTGJSON'),
    (21, 'mtgjson:cardkingdom', 'cardkingdom', 'retail', 'foil', 'USD', 'Card Kingdom retail via MTGJSON'),
    (22, 'mtgjson:cardkingdom', 'cardkingdom', 'retail', 'etched', 'USD', 'Card Kingdom retail via MTGJSON'),
    (23, 'mtgjson:cardkingdom', 'cardkingdom', 'buylist', 'nonfoil', 'USD', 'Card Kingdom buylist via MTGJSON'),
    (24, 'mtgjson:cardkingdom', 'cardkingdom', 'buylist', 'foil', 'USD', 'Card Kingdom buylist via MTGJSON'),
    (25, 'mtgjson:cardkingdom', 'cardkingdom', 'buylist', 'etched', 'USD', 'Card Kingdom buylist via MTGJSON'),
    (26, 'mtgjson:manapool', 'manapool', 'listing', 'nonfoil', 'USD', 'Mana Pool lowest listing via MTGJSON'),
    (27, 'mtgjson:manapool', 'manapool', 'listing', 'foil', 'USD', 'Mana Pool lowest listing via MTGJSON'),
    (28, 'mtgjson:manapool', 'manapool', 'listing', 'etched', 'USD', 'Mana Pool lowest listing via MTGJSON');
