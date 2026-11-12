-- The Advanced switch (Bryan, 12 Nov 2026: the Workshop tab, with plans, getting the cards, swap
-- sheets, simulations, datasets and Mythic Tools, shows only with Advanced on).
--   NULL  no choice made: on for an admin, a power user, and an account that already has a plan,
--         a lab run, a Mythic link or a wish (`auth::advanced`), so nothing disappears for anyone
--         already using those pages; off for everyone else
--   1, 0  the account's own choice in Settings
ALTER TABLE users ADD COLUMN advanced INTEGER;
