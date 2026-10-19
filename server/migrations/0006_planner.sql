-- Deck planner, per user (docs/planner-design.md section 4, docs/plan-format.md). Every table
-- carries owner_id and every query binds the caller's id. A plan deck either comes from an outside
-- export (source 'import', read-only here; Bryan's commander-decks repo) or is made in Yama
-- (source 'yama').
--
-- Prices: NULL means unknown, never 0. Dates are YYYY-MM-DD; times are RFC 3339 UTC (util::now);
-- ids are util::new_id; JSON lives in TEXT.
--
-- Card names are the identity. No planner row stores an oracle id: names are resolved against
-- Yama's card data when the bundle is built, so a card Scryfall adds later (the Star Trek decks)
-- resolves without a new import, and learning a card's id never makes a "new" list.
--
-- Owner-scoped links: a child link that cascades uses a composite key (parent_id, owner_id), so the
-- database refuses a link to another user's row. A link that is SET NULL on delete uses the id
-- alone, because SQLite's SET NULL would also null owner_id; the code checks those owners.

-- Parent key for plan_decks.deck_id. Decks are archived, never deleted.
CREATE UNIQUE INDEX decks_id_owner ON decks(id, owner_id);

-- ── per-user head ──────────────────────────────────────────────────────────
CREATE TABLE plan_meta (
    owner_id        TEXT PRIMARY KEY REFERENCES users(id),
    revision        INTEGER NOT NULL DEFAULT 0,  -- +1 on every applied import or input batch; part of the bundle cache key
    head_import_id  TEXT,                        -- the applied import now in force
    head_hash       TEXT,                        -- its content hash; an upload with the same hash is unchanged
    head_git_sha    TEXT,                        -- from its meta; publish.py's ancestor check
    game_changers   TEXT,                        -- JSON {checked_on, source, names} from the head document
    library         TEXT,                        -- JSON {bought, scan, extra} from the head document (shown as given)
    notes           TEXT NOT NULL DEFAULT '[]',  -- JSON [{kind, text, deck?}]: plan-wide notes from the head document
    pulled_through  INTEGER NOT NULL DEFAULT 0,  -- highest plan_inputs.seq the export side acknowledged
    pulled_at       TEXT,
    updated_at      TEXT NOT NULL
);

CREATE TABLE plan_imports (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    content_hash  TEXT NOT NULL,                 -- sha256 of the exact bytes of the document's "plan" value
    format        TEXT NOT NULL,                 -- 'yama-plan/1'
    meta          TEXT NOT NULL,                 -- JSON meta as uploaded {app, guide_version, guide_date, git_sha, dirty, generated_at, ...}
    via           TEXT NOT NULL CHECK (via IN ('web','token','cli')),
    forced        INTEGER NOT NULL DEFAULT 0,
    report        TEXT NOT NULL,                 -- JSON import report (design section 6.6)
    document_gz   BLOB,                          -- the upload, gzipped; kept for the newest 10 per owner
    imported_at   TEXT NOT NULL
);
CREATE INDEX plan_imports_owner ON plan_imports(owner_id, imported_at);

-- ── rules and stores ───────────────────────────────────────────────────────
-- Each row is the complete rule set in force from its date, so a purchase is judged by the rules of its day.
CREATE TABLE plan_settings (
    owner_id        TEXT NOT NULL REFERENCES users(id),
    effective_from  TEXT NOT NULL,               -- YYYY-MM-DD
    rules           TEXT NOT NULL,               -- JSON, design section 9
    note            TEXT,                        -- 'Shopping decisions, 2026-10-08 to 10-09'
    origin          TEXT NOT NULL CHECK (origin IN ('import','yama')),
    created_at      TEXT NOT NULL,
    PRIMARY KEY (owner_id, effective_from)
);

CREATE TABLE plan_stores (
    id                 TEXT PRIMARY KEY,
    owner_id           TEXT NOT NULL REFERENCES users(id),
    key                TEXT NOT NULL,            -- 'pats'
    name               TEXT NOT NULL,            -- 'Pat''s Games'
    short_name         TEXT,                     -- 'Pat''s' (the store as written in swap rows)
    kind               TEXT NOT NULL CHECK (kind IN ('local','online','printer')),
    cart_url_template  TEXT,                     -- https only, contains {items}; items = 'variant:qty' joined by ','
    homepage           TEXT,
    location           TEXT,
    note               TEXT,
    print_tiers        TEXT,                     -- printers: JSON [n, ...]; NULL not checked
    sort               INTEGER NOT NULL DEFAULT 0,
    origin             TEXT NOT NULL CHECK (origin IN ('import','yama')),
    content_hash       TEXT,                     -- sha256 of the row as imported; unchanged rows aren't rewritten
    import_id          TEXT,
    retired_at         TEXT,                     -- gone from the latest document; restored if it returns
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    UNIQUE (owner_id, key),
    UNIQUE (id, owner_id)
);

-- ── plan decks and their lists ─────────────────────────────────────────────
CREATE TABLE plan_decks (
    id               TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL REFERENCES users(id),
    key              TEXT NOT NULL,              -- URL slug, as compare_lists.py names files: 'riders-of-rohan'
    name             TEXT NOT NULL,              -- 'Riders of Rohan' (the name inside legacy swap keys)
    source           TEXT NOT NULL CHECK (source IN ('import','yama')),
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposals_only','archived')),
    product          TEXT,                       -- 'Riders of Rohan (LTC)'
    commander        TEXT NOT NULL,              -- JSON [name]: the plan's commander, not the box face
    color_identity   TEXT,                       -- WUBRG order: 'WUR'
    owner_changes    TEXT NOT NULL DEFAULT '[]', -- JSON [{out, in, note}] made before any plan
    bracket          TEXT,                       -- JSON {target, keep_note, callouts, bags, game_changers}
    groups           TEXT NOT NULL DEFAULT '[]', -- JSON [{label, bracket, note}]: cumulative proposal groups
    notes            TEXT NOT NULL DEFAULT '[]', -- JSON [{kind: 'open_question'|'warning'|'note', text}]
    deck_id          TEXT,                       -- the user's Yama deck for this physical deck, if linked
    base_version_id  TEXT REFERENCES deck_versions(id),  -- 'yama' plans: the list the plan starts from (owner checked in code)
    sort             INTEGER NOT NULL DEFAULT 0,
    content_hash     TEXT,                       -- sha256 of the deck's fields as imported (lists excluded)
    import_id        TEXT,                       -- last import that wrote it; NULL if made in Yama
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (owner_id, key),
    UNIQUE (id, owner_id),
    FOREIGN KEY (deck_id, owner_id) REFERENCES decks(id, owner_id)
);

-- A list is identified by its cards reduced to [board, name, qty] (content_hash). A list with
-- different cards is a new row; `current` marks the one pages show. Lab jobs and Yama decks made
-- from a list point at exact rows, so old rows are kept. The slot details (printings, sources)
-- and the log are notes on the list: a newer import with the same cards refreshes them in place.
CREATE TABLE plan_states (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    plan_deck_id  TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('stock','now','after','proposal','bracket3','bracket2')),
    content_hash  TEXT NOT NULL,                 -- sha256 of the sorted [board, name, qty] list as compact JSON
    cards         TEXT NOT NULL,                 -- JSON [Slot], docs/plan-format.md
    log           TEXT NOT NULL DEFAULT '[]',    -- JSON [{swap, status}]: done|standin|fill|waiting|print|moved|waiting-move|spare
    computed_by   TEXT NOT NULL,                 -- 'commander-decks library.py, guide v6' | 'yama plan engine 1'
    current       INTEGER NOT NULL DEFAULT 0,
    import_id     TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE (plan_deck_id, state, content_hash),
    UNIQUE (id, owner_id),
    FOREIGN KEY (plan_deck_id, owner_id) REFERENCES plan_decks(id, owner_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX plan_states_current ON plan_states(plan_deck_id, state) WHERE current = 1;

-- ── orders: real purchases and print (proxy) orders ────────────────────────
-- Paid prices live here, never in price_snapshots.
CREATE TABLE plan_orders (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL REFERENCES users(id),
    ext_key         TEXT NOT NULL,               -- 'pats-games-55912'; made in Yama: 'y|<id>'
    kind            TEXT NOT NULL CHECK (kind IN ('real','proxy')),
    status          TEXT NOT NULL CHECK (status IN ('draft','placed','received','cancelled')),
    vendor          TEXT NOT NULL,
    store_id        TEXT REFERENCES plan_stores(id) ON DELETE SET NULL,
    order_number    TEXT,                        -- NULL: not recorded
    date_ordered    TEXT,                        -- NULL: not recorded
    placed_by       TEXT,                        -- latest date it was placed, when the exact date isn't recorded
    date_fulfilled  TEXT,
    fulfillment     TEXT,
    currency        TEXT NOT NULL DEFAULT 'USD',
    subtotal        REAL CHECK (subtotal IS NULL OR subtotal >= 0),
    subtotal_note   TEXT,                        -- what the subtotal is: 'Sum of cart prices verified 2026-10-10 ...'
    shipping        REAL CHECK (shipping IS NULL OR shipping >= 0),
    tax             REAL CHECK (tax IS NULL OR tax >= 0),
    total           REAL CHECK (total IS NULL OR total >= 0),
    card_stock      TEXT,                        -- proxy: 'S30' | 'S33'; NULL not recorded
    evidence        TEXT,                        -- a pointer only ('Receipt kept privately'); never the receipt
    issues          TEXT NOT NULL DEFAULT '[]',
    note            TEXT,
    origin          TEXT NOT NULL CHECK (origin IN ('import','yama')),
    content_hash    TEXT,                        -- sha256 of the order and its items as imported
    import_id       TEXT,
    retired_at      TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (owner_id, ext_key),
    UNIQUE (id, owner_id)
);

CREATE TABLE plan_order_items (
    id                         TEXT PRIMARY KEY,
    owner_id                   TEXT NOT NULL REFERENCES users(id),
    order_id                   TEXT NOT NULL,
    line                       INTEGER NOT NULL,
    card_name                  TEXT NOT NULL,
    qty                        INTEGER NOT NULL CHECK (qty > 0),
    listing                    TEXT,             -- store listing text as bought
    set_code                   TEXT,             -- printing the listing names; NULL unknown
    collector_number           TEXT,
    finish                     TEXT,
    scryfall_id                TEXT,
    received_set_code          TEXT,             -- the store sent another printing
    received_collector_number  TEXT,
    received_note              TEXT,
    deck_key                   TEXT,             -- plan deck it was bought for
    replaces                   TEXT,
    role                       TEXT,             -- 'plan card' | 'budget substitute for X' | 'temporary stand-in for X'
    unit_price                 REAL CHECK (unit_price IS NULL OR unit_price >= 0),  -- paid (real) or per-card cost (proxy)
    arrived                    INTEGER,          -- 1 yes, 0 never arrived, NULL unknown
    UNIQUE (order_id, line),
    UNIQUE (id, owner_id),
    FOREIGN KEY (order_id, owner_id) REFERENCES plan_orders(id, owner_id) ON DELETE CASCADE
);

-- ── swaps and proposals ────────────────────────────────────────────────────
-- Plan swaps and proposals in one table, kept apart by `stage`. A proposal is never part of the
-- stock/now/after lists. Only promotion changes stage (repo side for 'import' decks, slice 7 for 'yama').
CREATE TABLE plan_swaps (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL REFERENCES users(id),
    plan_deck_id    TEXT NOT NULL,
    ext_key         TEXT NOT NULL,               -- imports: the review site's id; made in Yama: 'y|<id>'
    stage           TEXT NOT NULL CHECK (stage IN ('proposed','planned')),
    role            TEXT NOT NULL CHECK (role IN ('swap','standin','optional')),
    parent_id       TEXT REFERENCES plan_swaps(id) ON DELETE SET NULL,  -- standin -> the print swap it holds
    src             TEXT NOT NULL CHECK (src IN ('buy','print','owned')),
    src_declared    TEXT,                        -- src as the source data wrote it, when the writer changed it
    store_label     TEXT,                        -- buy rows: the store as written ('Pat''s')
    out_name        TEXT,                        -- NULL: optional extra with no slot, or proposal with no cut
    in_name         TEXT NOT NULL,
    plan_card       TEXT,                        -- differs from in_name for a budget substitute
    later_out       TEXT,                        -- advice as recorded; never applied to a list
    after_print     INTEGER NOT NULL DEFAULT 0,
    tier            TEXT,                        -- the user's gameplay priority label: 'T1', 'FF land', 'Core'
    band            TEXT CHECK (band IN ('B2','B3','B4')),
    sort            INTEGER NOT NULL DEFAULT 0,
    game_changer    INTEGER,                     -- 1/0/NULL unknown
    got             TEXT,                        -- JSON {how:'bought',order} | {how:'pulled',product,date} | {how:'deck',deck,deck_name,origin}
    order_item_id   TEXT REFERENCES plan_order_items(id) ON DELETE SET NULL,
    print_order_id  TEXT REFERENCES plan_orders(id) ON DELETE SET NULL,
    listing         TEXT,                        -- the 'version' text from swaps.json
    group_label     TEXT,
    when_text       TEXT,
    advice          TEXT,
    why             TEXT,
    why_out         TEXT,
    note            TEXT,
    upgrade         TEXT,                        -- commander-decks: JSON {id, status} from data/upgrades.json, shown read-only
    content_hash    TEXT,                        -- sha256 of the row as imported; unchanged rows aren't rewritten
    import_id       TEXT,
    retired_at      TEXT,                        -- gone from the latest document; restored if it returns
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    CHECK (src != 'owned' OR got IS NOT NULL),
    UNIQUE (owner_id, ext_key),
    UNIQUE (id, owner_id),
    FOREIGN KEY (plan_deck_id, owner_id) REFERENCES plan_decks(id, owner_id) ON DELETE CASCADE
);
CREATE INDEX plan_swaps_deck ON plan_swaps(plan_deck_id, stage, sort);

-- Renamed or promoted keys, so answers and ticks follow (the item_aliases idea from 0004).
-- Kept when a later document drops them, so an answer never loses its row.
CREATE TABLE plan_key_aliases (
    owner_id    TEXT NOT NULL REFERENCES users(id),
    old_key     TEXT NOT NULL,
    new_key     TEXT NOT NULL,
    import_id   TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (owner_id, old_key)
);

-- Dated price evidence that isn't Scryfall history: store stock checks and recorded market benchmarks.
CREATE TABLE plan_quotes (
    id                 TEXT PRIMARY KEY,
    owner_id           TEXT NOT NULL REFERENCES users(id),
    swap_id            TEXT REFERENCES plan_swaps(id) ON DELETE CASCADE,
    card_name          TEXT NOT NULL,
    kind               TEXT NOT NULL CHECK (kind IN ('stock_check','market_benchmark')),
    store_id           TEXT REFERENCES plan_stores(id) ON DELETE SET NULL,
    store_label        TEXT,                     -- as recorded: 'Alpha Strike Games (San Marcos, 44 mi)'
    checked_on         TEXT NOT NULL,
    result             TEXT,                     -- stock note as recorded
    in_stock           INTEGER,                  -- 1/0/NULL unclear
    price              REAL CHECK (price IS NULL OR price >= 0),  -- NULL = no price
    price_from_text    INTEGER NOT NULL DEFAULT 0, -- 1: price read from the stock note
    currency           TEXT NOT NULL DEFAULT 'USD',
    printing           TEXT,                     -- 'Forgotten Realms Commander (AFC) #175' | '2X2 #173'
    set_code           TEXT,
    collector_number   TEXT,
    printing_from_text INTEGER NOT NULL DEFAULT 0,
    scryfall_id        TEXT,
    variant            TEXT,                     -- cart line id (Shopify variant): makes it cart-able
    url                TEXT,
    source             TEXT NOT NULL,            -- 'TCGplayer market via Scryfall, cheapest non-foil' | 'Pat''s Games website'
    origin             TEXT NOT NULL CHECK (origin IN ('import','yama')),
    import_id          TEXT,
    created_at         TEXT NOT NULL
);
CREATE INDEX plan_quotes_swap ON plan_quotes(swap_id);
CREATE INDEX plan_quotes_owner ON plan_quotes(owner_id, origin);

-- ── user input ─────────────────────────────────────────────────────────────
-- Every tap is an op with a client id. A retried sync is a no-op; a bad op is recorded as rejected
-- so it never blocks later ones. seq is global, so concurrent devices can't collide.
CREATE TABLE plan_inputs (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,  -- pull cursor
    owner_id     TEXT NOT NULL REFERENCES users(id),
    op_id        TEXT NOT NULL,
    device_id    TEXT,
    kind         TEXT NOT NULL,                  -- review | installed | bought | idea (later: swap.put, ...); checked in code
    swap_key     TEXT,                           -- may name a swap no longer in the plan; kept, never dropped
    deck_key     TEXT,
    payload      TEXT NOT NULL,                  -- JSON as sent
    status       TEXT NOT NULL CHECK (status IN ('applied','rejected')),
    error        TEXT,
    for_export   INTEGER NOT NULL DEFAULT 0,     -- 1: aimed at an imported deck; pull.py fetches it
    client_at    TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    outcome      TEXT,                           -- what the export side did with it ('Recorded as order ...')
    outcome_at   TEXT,
    UNIQUE (owner_id, op_id)
);
CREATE INDEX plan_inputs_export ON plan_inputs(owner_id, for_export, seq);

-- Current review answer per key. Last writer wins; a clear is a tombstone (all three fields null).
-- Keyed by text, not a foreign key: retiring or renaming a swap can't touch an answer.
CREATE TABLE plan_reviews (
    owner_id   TEXT NOT NULL REFERENCES users(id),
    swap_key   TEXT NOT NULL,
    decision   TEXT CHECK (decision IN ('want','unsure','no')),
    note       TEXT CHECK (note IS NULL OR length(note) <= 2000),
    cut        TEXT,
    deck_name  TEXT,                             -- as in review.json, so orphaned answers stay readable
    card       TEXT,
    at         TEXT NOT NULL,                    -- UTC, whole seconds
    origin     TEXT NOT NULL CHECK (origin IN ('yama','import')),
    op_id      TEXT,
    PRIMARY KEY (owner_id, swap_key)
);

-- Installed ticks and "bought it" marks: the user's claims, not orders or deck changes.
CREATE TABLE plan_marks (
    owner_id   TEXT NOT NULL REFERENCES users(id),
    swap_key   TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('installed','bought')),
    value      INTEGER NOT NULL,                 -- 1 set, 0 cleared (kept so last writer wins)
    payload    TEXT NOT NULL DEFAULT '{}',       -- bought: {store_key|null, store_label|null, price_paid|null, qty, on}
    at         TEXT NOT NULL,
    op_id      TEXT NOT NULL,
    PRIMARY KEY (owner_id, swap_key, kind)
);

-- ── script keys ────────────────────────────────────────────────────────────
-- For publish.py / pull.py (slice 4). Accepted only by the SyncUser extractor, never by
-- CurrentUser; never admin.
CREATE TABLE api_tokens (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,                 -- 'commander-decks on the Mac'
    token_hash    TEXT NOT NULL UNIQUE,          -- sha256 of 'yama_pat_' + util::random_token()
    scopes        TEXT NOT NULL,                 -- JSON ["plan:sync"]
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    expires_at    TEXT,                          -- default 365 days
    revoked_at    TEXT
);
CREATE INDEX api_tokens_owner ON api_tokens(owner_id);
