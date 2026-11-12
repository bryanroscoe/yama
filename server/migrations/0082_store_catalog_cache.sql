-- Public storefront data only. Never stores a person's cart or collection.
CREATE TABLE store_catalog_cache (
    base TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    product_count INTEGER NOT NULL,
    products_gz BLOB NOT NULL
);

-- Catalog price evidence and variant quantity evidence may have different dates.
ALTER TABLE store_listings ADD COLUMN quantity_checked_at TEXT;
ALTER TABLE store_snapshots ADD COLUMN catalog_fetched_at TEXT;
