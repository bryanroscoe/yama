-- Private observations of public buylist offers. Never a sale or inventory mutation.
CREATE TABLE sell_offers (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scryfall_id TEXT NOT NULL,
    finish TEXT NOT NULL,
    condition TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    -- The complete normalized observation, including missing/ambiguous states and source.
    observation TEXT NOT NULL
);
CREATE INDEX sell_offers_history ON sell_offers(owner_id, scryfall_id, finish, condition, checked_at DESC);
