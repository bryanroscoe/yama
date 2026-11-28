-- Handing a shared table to another phone (Bryan, 27 Nov 2026: "Make a thing to migrate the host
-- of a match"). The phone running a life-counter game can hand it to a phone following it, and
-- that phone's account then keeps the game's record: it uploads the taps and the finish until the
-- game ends or is handed on again. The game stays the creator's (its history, its playgroup, who
-- may delete it); `kept_by` only says whose device writes it now. NULL: the creator's own.
ALTER TABLE games ADD COLUMN kept_by TEXT REFERENCES users(id) ON DELETE SET NULL;
