-- Sealed precons at stores, 1 Nov 2026 (docs/shopping-design.md, "Sealed precons"). A sealed want
-- may name the precon it is (so its sealed market and the singles inside can be shown), and a
-- store's dated price for one is a sealed quote: typed in Yama, never a purchase or proof of stock.
ALTER TABLE shopping_wants ADD COLUMN precon_id TEXT;

CREATE TABLE sealed_quotes (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    -- The want it's for (a sealed product on their list).
    want_id     TEXT NOT NULL,
    store_key   TEXT NOT NULL,
    -- NULL: in stock but the price wasn't given (ask).
    price       REAL CHECK (price IS NULL OR (price >= 0 AND price <= 100000)),
    in_stock    INTEGER NOT NULL DEFAULT 1,
    checked_on  TEXT NOT NULL,
    note        TEXT CHECK (note IS NULL OR length(note) <= 500),
    created_at  TEXT NOT NULL
);
CREATE INDEX sealed_quotes_owner ON sealed_quotes (owner_id, want_id, checked_on);

-- Every price id the page sent (kept 30 days), so a late retry of a price the history has since
-- pruned still saves nothing.
CREATE TABLE sealed_quote_ids (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL
);
CREATE INDEX sealed_quote_ids_owner ON sealed_quote_ids (owner_id, created_at);
