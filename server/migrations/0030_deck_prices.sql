-- Public sealed market references, never seller quotes. A null price remains unknown.
CREATE TABLE sealed_deck_prices (
    precon_id TEXT PRIMARY KEY REFERENCES precons(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    usd REAL,
    price_date TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT NOT NULL
);
CREATE TABLE deck_price_imports (
    id TEXT PRIMARY KEY,
    checked_at TEXT NOT NULL,
    source_updated_at TEXT NOT NULL
);
