-- A public "looking for" list (Bryan, 8 Nov 2026: "all the cards that I'm looking for to have a
-- public buy list that I can send to my friends"): the cards on the shopping list, shown at
-- /u/<handle>/wants. Off until the owner turns it on, like the collection.
ALTER TABLE users ADD COLUMN wants_public INTEGER NOT NULL DEFAULT 0;
