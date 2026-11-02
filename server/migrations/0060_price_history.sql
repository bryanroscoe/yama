-- Price history, kept as changes (2026-11-02; ARCHITECTURE.md, "Price history").
-- price_snapshots kept every price of every printing every day: 222 MB for 15 days, growing about
-- 15 MB a day. These tables keep a row only when a value changes, as whole cents, about 1 MB a
-- day. Both are written until a later migration drops price_snapshots, so a rollback still finds
-- every day there.

CREATE TABLE price_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- Integer keys for printings, given out once and never reused or renumbered (a rowid alias
-- survives VACUUM).
CREATE TABLE price_printing (
    id          INTEGER PRIMARY KEY,
    scryfall_id TEXT NOT NULL UNIQUE
);

-- What a series is. Fixed ids, mirrored by constants in server/src/prices and checked by a test.
CREATE TABLE price_series (
    id       INTEGER PRIMARY KEY,
    feed     TEXT NOT NULL,   -- the file Yama reads: scryfall
    provider TEXT NOT NULL,   -- whose price: tcgplayer | cardmarket | cardhoarder
    kind     TEXT NOT NULL,   -- market
    finish   TEXT NOT NULL,   -- nonfoil | foil | etched
    currency TEXT NOT NULL,   -- USD | EUR | TIX
    label    TEXT NOT NULL    -- shown with the price
);
INSERT INTO price_series (id, feed, provider, kind, finish, currency, label) VALUES
    (1, 'scryfall', 'tcgplayer', 'market', 'nonfoil', 'USD', 'TCGplayer market via Scryfall'),
    (2, 'scryfall', 'tcgplayer', 'market', 'foil', 'USD', 'TCGplayer market via Scryfall'),
    (3, 'scryfall', 'tcgplayer', 'market', 'etched', 'USD', 'TCGplayer market via Scryfall'),
    (4, 'scryfall', 'cardmarket', 'market', 'nonfoil', 'EUR', 'Cardmarket via Scryfall'),
    (5, 'scryfall', 'cardmarket', 'market', 'foil', 'EUR', 'Cardmarket via Scryfall'),
    (6, 'scryfall', 'cardmarket', 'market', 'etched', 'EUR', 'Cardmarket via Scryfall'),
    (7, 'scryfall', 'cardhoarder', 'market', 'nonfoil', 'TIX', 'Cardhoarder (MTGO tickets) via Scryfall');

-- One row per feed per day Yama read it, written with the file's prices. Without one, that day
-- is unknown (a gap), not "no price".
CREATE TABLE price_observation (
    feed            TEXT NOT NULL,
    day             INTEGER NOT NULL,  -- days since 1970-01-01: the UTC date of the source file
    file_updated_at TEXT,              -- the source's own timestamp (Scryfall's bulk updated_at)
    observed_at     TEXT NOT NULL,     -- when Yama finished reading it
    import_run      TEXT,              -- import_runs.id
    printings       INTEGER NOT NULL,  -- printings in the file
    PRIMARY KEY (feed, day)
) WITHOUT ROWID;

-- The history: a row when a series' value changes, NULL cents meaning no price from that day on.
-- A value on an observed day is the newest row on or before it.
CREATE TABLE price_point (
    printing INTEGER NOT NULL,  -- price_printing.id
    series   INTEGER NOT NULL,  -- price_series.id
    day      INTEGER NOT NULL,
    cents    INTEGER,
    PRIMARY KEY (printing, series, day)
) WITHOUT ROWID;

-- Scryfall's prices as of its newest file, one row per printing that has ever had one. `date` is
-- the newest file it was read from or found missing in; `file` which file that was (an import run),
-- so a second file for the same day can tell the printings it left out. REAL = cents / 100.0, the
-- same double the old table held for the same decimal.
CREATE TABLE price_latest (
    scryfall_id TEXT PRIMARY KEY,
    date        TEXT NOT NULL,
    file        TEXT,
    usd REAL, usd_foil REAL, usd_etched REAL, eur REAL, eur_foil REAL, eur_etched REAL, tix REAL
) WITHOUT ROWID;

-- A file's printings as the import reads them, in cents, until the whole file is published in
-- one transaction (server/src/prices/write.rs). A reader sees a file whole or not at all; rows
-- left by a run that stopped part way are cleared by the next writer.
CREATE TABLE price_stage (
    file        TEXT NOT NULL,
    scryfall_id TEXT NOT NULL,
    usd INTEGER, usd_foil INTEGER, usd_etched INTEGER, eur INTEGER, eur_foil INTEGER, eur_etched INTEGER, tix INTEGER,
    PRIMARY KEY (file, scryfall_id)
) WITHOUT ROWID;
