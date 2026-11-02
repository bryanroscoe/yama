-- Store stock snapshots, 1 Nov 2026 (docs/shopping-design.md, "Stock snapshots"). One snapshot is
-- one dated read of one store: its whole catalog (`cards` NULL) or the answers for a card list.
-- Listings are never edited; a newer snapshot of the same store supersedes an older one for the
-- cards it covers. The raw responses are kept gzipped for the newest snapshots of each store, so a
-- parse bug can be fixed without fetching again.
CREATE TABLE store_snapshots (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    store_key   TEXT NOT NULL,
    -- 'shopify', 'tcgplayer_pro', 'yestcg' (fetched by Yama) or 'import' (a yama-store-snapshot/1 file).
    source      TEXT NOT NULL CHECK (source IN ('shopify', 'tcgplayer_pro', 'yestcg', 'import')),
    -- JSON array of the card names asked about; NULL: the store's whole catalog.
    cards       TEXT,
    -- JSON array of the cards whose answer is unknown (a request failed): neither in stock nor out.
    failed      TEXT,
    -- A short description of the query (endpoint and parameters), for the record.
    query       TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    fetched_at  TEXT,
    status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'error')),
    error       TEXT CHECK (error IS NULL OR length(error) <= 2000),
    raw_gz      BLOB,
    item_count  INTEGER NOT NULL DEFAULT 0,
    -- How it was asked for: the Trip page, a change Claude staged and they applied, or an import.
    via         TEXT NOT NULL CHECK (via IN ('page', 'assistant', 'import'))
);
CREATE INDEX store_snapshots_owner ON store_snapshots (owner_id, store_key, requested_at);

CREATE TABLE store_listings (
    snapshot_id TEXT NOT NULL REFERENCES store_snapshots(id) ON DELETE CASCADE,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    -- The card asked about (the name as the person's list writes it), not the store's title.
    card_name   TEXT NOT NULL,
    -- The front face, trimmed and lowercased, for matching.
    card_key    TEXT NOT NULL,
    title       TEXT,
    set_code    TEXT,
    set_name    TEXT,
    number      TEXT,
    finish      TEXT CHECK (finish IS NULL OR finish IN ('nonfoil', 'foil', 'etched')),
    condition   TEXT,
    language    TEXT,
    price       REAL CHECK (price IS NULL OR price >= 0),
    -- True: the store said it's available; NULL: it didn't say.
    available   INTEGER,
    qty         INTEGER,
    -- 'from': the lowest price of a product whose condition and finish aren't given (TCGplayer Pro).
    price_kind  TEXT NOT NULL DEFAULT 'each' CHECK (price_kind IN ('each', 'from')),
    variant     TEXT,
    url         TEXT
);
CREATE INDEX store_listings_snapshot ON store_listings (snapshot_id);
CREATE INDEX store_listings_owner_card ON store_listings (owner_id, card_key);

-- Claude may stage a stock check ('check_stores') and a card for the shopping list ('add_wish').
CREATE TABLE assistant_changes_new (
    id               TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL REFERENCES users(id),
    kind             TEXT NOT NULL CHECK (kind IN ('edit_deck', 'propose_swap', 'answer_review', 'mark_bought',
                                                   'mark_installed', 'start_lab_run', 'add_to_collection', 'move_cards',
                                                   'set_condition', 'more_lab_games', 'run_lab_again', 'cancel_lab_run',
                                                   'swap_in_prints', 'set_shopping_rules', 'set_store_preference',
                                                   'check_stores', 'add_wish')),
    summary          TEXT NOT NULL,
    detail           TEXT,
    payload          TEXT NOT NULL,
    via              TEXT NOT NULL CHECK (via IN ('question', 'key', 'oauth')),
    conversation_id  TEXT,
    message_id       TEXT,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'discarded')),
    error            TEXT,
    result           TEXT,
    created_at       TEXT NOT NULL,
    decided_at       TEXT
);
INSERT INTO assistant_changes_new (id, owner_id, kind, summary, detail, payload, via, conversation_id, message_id, status, error, result, created_at, decided_at)
    SELECT id, owner_id, kind, summary, detail, payload, via, conversation_id, message_id, status, error, result, created_at, decided_at
    FROM assistant_changes;
DROP TABLE assistant_changes;
ALTER TABLE assistant_changes_new RENAME TO assistant_changes;
CREATE INDEX assistant_changes_owner ON assistant_changes (owner_id, status, created_at);
CREATE INDEX assistant_changes_conversation ON assistant_changes (owner_id, conversation_id);

-- Cards wanted by hand (the shopping list, slice 3): a card or a sealed product, with why.
CREATE TABLE shopping_wants (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    kind        TEXT NOT NULL CHECK (kind IN ('card', 'sealed')),
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    qty         INTEGER NOT NULL DEFAULT 1 CHECK (qty BETWEEN 1 AND 99),
    -- 'need': a reason to go to a store; 'along': only if a store on the trip has it.
    priority    TEXT NOT NULL DEFAULT 'need' CHECK (priority IN ('need', 'along')),
    -- The Yama deck it's for, when it is one, and a label for the deck either way (a deck not in Yama).
    deck_id     TEXT,
    deck_name   TEXT CHECK (deck_name IS NULL OR length(deck_name) <= 200),
    why         TEXT CHECK (why IS NULL OR length(why) <= 500),
    -- 'page' or 'assistant'.
    source      TEXT NOT NULL CHECK (source IN ('page', 'assistant')),
    added_at    TEXT NOT NULL,
    retired_at  TEXT
);
CREATE INDEX shopping_wants_owner ON shopping_wants (owner_id, retired_at);
