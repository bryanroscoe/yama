-- Store stock kept fresh in the background (server/src/plan/stock/live.rs): for each store Yama
-- reads card by card and each card somebody's sourcing page wants, the store's newest answer.
-- Public storefront data only, shared by every account like store_catalog_cache: it never says
-- who wanted a card, and holds no cart, collection or plan.
CREATE TABLE store_live (
    base        TEXT NOT NULL,   -- the store's https origin
    card_key    TEXT NOT NULL,   -- stock.rs card_key
    card_name   TEXT NOT NULL,   -- as asked of the store
    wanted_at   TEXT NOT NULL,   -- the last time a page asked for it; reads stop two weeks after
    rush_at     TEXT,            -- asked to be read first (a card about to be ordered)
    tried_at    TEXT,            -- the last read, answered or not
    checked_at  TEXT,            -- the last read that answered
    error       TEXT,            -- why the last read gave no answer
    listings    TEXT,            -- JSON array: the in-stock listings at checked_at
    PRIMARY KEY (base, card_key)
);
CREATE INDEX store_live_due ON store_live (base, checked_at);
