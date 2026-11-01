-- Shopping settings, 1 Nov 2026 (docs/shopping-design.md). SQLite can't change a CHECK in place, so
-- both tables are rebuilt with their rows.
--
-- Store preferences v2: "default" (your usual store) becomes "favorite" (a store you want to
-- support: on every trip it has a card for), and two settings join it: `hassle`, your order of how
-- easy the store is to get to (1 is the easiest), and `premium_usd`, how much more a card may cost
-- there and still come from it.
CREATE TABLE plan_store_prefs_new (
    owner_id     TEXT NOT NULL REFERENCES users(id),
    store_key    TEXT NOT NULL,
    preference   TEXT NOT NULL CHECK (preference IN ('favorite', 'ok', 'maybe', 'never')),
    note         TEXT CHECK (note IS NULL OR length(note) <= 500),
    hassle       INTEGER CHECK (hassle IS NULL OR hassle BETWEEN 1 AND 999),
    premium_usd  REAL CHECK (premium_usd IS NULL OR (premium_usd >= 0 AND premium_usd <= 10)),
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (owner_id, store_key)
);
INSERT INTO plan_store_prefs_new (owner_id, store_key, preference, note, updated_at)
    SELECT owner_id, store_key, CASE preference WHEN 'default' THEN 'favorite' ELSE preference END, note, updated_at
    FROM plan_store_prefs;
DROP TABLE plan_store_prefs;
ALTER TABLE plan_store_prefs_new RENAME TO plan_store_prefs;

-- Claude may stage a new buy rule ('set_shopping_rules') and one store's preference
-- ('set_store_preference') for the person to apply.
CREATE TABLE assistant_changes_new (
    id               TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL REFERENCES users(id),
    kind             TEXT NOT NULL CHECK (kind IN ('edit_deck', 'propose_swap', 'answer_review', 'mark_bought',
                                                   'mark_installed', 'start_lab_run', 'add_to_collection', 'move_cards',
                                                   'set_condition', 'more_lab_games', 'run_lab_again', 'cancel_lab_run',
                                                   'swap_in_prints', 'set_shopping_rules', 'set_store_preference')),
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
