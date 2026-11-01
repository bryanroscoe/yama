-- How each person feels about going to each of their stores (docs/shopping-design.md): their own
-- setting, made in Yama, kept apart from plan_stores so a plan import never overwrites it. Keyed by
-- the store's key, so a store retired and brought back by a later import keeps its preference.
-- A store with no row is "ok". The trip planner never sends anyone to a "never" store.
CREATE TABLE plan_store_prefs (
    owner_id    TEXT NOT NULL REFERENCES users(id),
    store_key   TEXT NOT NULL,
    preference  TEXT NOT NULL CHECK (preference IN ('default', 'ok', 'maybe', 'never')),
    note        TEXT CHECK (note IS NULL OR length(note) <= 500),
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, store_key)
);
