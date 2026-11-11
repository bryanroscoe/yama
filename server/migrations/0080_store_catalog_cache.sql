-- Public storefront data only. Never stores a person's cart or collection.
CREATE TABLE store_catalog_cache (
    base TEXT PRIMARY KEY,
    fetched_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    product_count INTEGER NOT NULL,
    products_gz BLOB NOT NULL
);
