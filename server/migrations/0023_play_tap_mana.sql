-- Paying mana by hand (2026-10-24, the game interactions review's build plan section 9): the
-- "Tap mana for me" setting, saved with the turn controls. NULL is the usual: automatic, asking
-- before sacrificing a source such as a Treasure. 'auto' always pays automatically; 'manual' opens
-- the payment for the person to tap.
ALTER TABLE play_prefs ADD COLUMN tap_mana TEXT;
