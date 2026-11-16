-- What makes a printing special, from Scryfall's default_cards: promo_types (JSON array, e.g.
-- ["surgefoil","universesbeyond"]), frame_effects (JSON array, e.g. ["showcase","extendedart"]),
-- border_color (black, borderless, white, ...) and full_art (0/1). The scanner, the card's
-- printing list and collection rows name special printings with them ("Surge foil, MSC 40").
-- NULL until the next default_cards import (importer version 5) fills them; an empty array means
-- Scryfall lists none.
ALTER TABLE printings ADD COLUMN promo_types TEXT;
ALTER TABLE printings ADD COLUMN frame_effects TEXT;
ALTER TABLE printings ADD COLUMN border_color TEXT;
ALTER TABLE printings ADD COLUMN full_art INTEGER;
