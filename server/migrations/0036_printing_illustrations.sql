-- Scryfall's illustration ID for each printing's art (front face, and back face for transform and
-- modal cards). The card scanner recognises art, then tells apart only the printings that share it.
-- Filled by the next default_cards import (importer version 3).
ALTER TABLE printings ADD COLUMN illustration_id TEXT;
ALTER TABLE printings ADD COLUMN back_illustration_id TEXT;
CREATE INDEX printings_illustration ON printings (illustration_id) WHERE illustration_id IS NOT NULL;
CREATE INDEX printings_back_illustration ON printings (back_illustration_id) WHERE back_illustration_id IS NOT NULL;
