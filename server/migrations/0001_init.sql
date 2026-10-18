-- Yama schema, first cut. SQLite (WAL). IDs are UUID strings; times are RFC 3339 UTC strings.

-- ── identity ────────────────────────────────────────────────────────────────
CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    google_sub    TEXT UNIQUE,               -- NULL for dev-login users
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);

-- Who may sign in. Admin emails from config are always allowed.
CREATE TABLE invites (
    email       TEXT PRIMARY KEY COLLATE NOCASE,
    invited_by  TEXT REFERENCES users(id),
    created_at  TEXT NOT NULL
);

-- Only a SHA-256 of the token is stored.
CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);

-- ── cards (from Scryfall bulk data) ────────────────────────────────────────
CREATE TABLE cards (
    oracle_id       TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    mana_cost       TEXT,
    cmc             REAL NOT NULL DEFAULT 0,
    type_line       TEXT NOT NULL DEFAULT '',
    oracle_text     TEXT NOT NULL DEFAULT '',
    colors          TEXT NOT NULL DEFAULT '',   -- e.g. "WU"
    color_identity  TEXT NOT NULL DEFAULT '',
    power           TEXT,
    toughness       TEXT,
    loyalty         TEXT,
    keywords        TEXT NOT NULL DEFAULT '[]', -- JSON array
    legalities      TEXT NOT NULL DEFAULT '{}', -- JSON object, format -> legal|banned|...
    rarity          TEXT,
    layout          TEXT,
    edhrec_rank     INTEGER,
    default_printing TEXT,                      -- scryfall_id Scryfall picked for this card
    image_small     TEXT,
    image_normal    TEXT,
    image_art_crop  TEXT,
    back_image_normal TEXT,
    artist          TEXT,
    faces           TEXT,                       -- JSON array of faces for multi-face cards
    updated_at      TEXT NOT NULL
);
CREATE INDEX cards_name ON cards(name COLLATE NOCASE);

-- Names include each face of a multi-face card ("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki").
CREATE TABLE card_names (
    name       TEXT NOT NULL COLLATE NOCASE,
    oracle_id  TEXT NOT NULL REFERENCES cards(oracle_id) ON DELETE CASCADE,
    PRIMARY KEY (name, oracle_id)
);

CREATE VIRTUAL TABLE cards_fts USING fts5(name, type_line, oracle_text, content='cards', content_rowid='rowid');

CREATE TABLE printings (
    scryfall_id       TEXT PRIMARY KEY,
    oracle_id         TEXT NOT NULL,
    name              TEXT NOT NULL,
    set_code          TEXT NOT NULL,
    set_name          TEXT NOT NULL,
    collector_number  TEXT NOT NULL,
    lang              TEXT NOT NULL,
    rarity            TEXT,
    finishes          TEXT NOT NULL DEFAULT '[]', -- JSON array: nonfoil|foil|etched
    released_at       TEXT,
    image_normal      TEXT,
    image_small       TEXT,
    image_art_crop    TEXT,
    back_image_normal TEXT,
    artist            TEXT,
    updated_at        TEXT NOT NULL
);
CREATE INDEX printings_oracle ON printings(oracle_id);
CREATE INDEX printings_set_number ON printings(set_code, collector_number, lang);

-- One row per printing per day. A NULL means Scryfall had no price that day; it is never 0.
CREATE TABLE price_snapshots (
    scryfall_id  TEXT NOT NULL,
    date         TEXT NOT NULL,   -- YYYY-MM-DD of the Scryfall bulk file
    usd          REAL,
    usd_foil     REAL,
    usd_etched   REAL,
    eur          REAL,
    eur_foil     REAL,
    tix          REAL,
    PRIMARY KEY (scryfall_id, date)
);

CREATE TABLE import_runs (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,     -- oracle_cards | default_cards
    source_url   TEXT,
    source_updated_at TEXT,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    rows         INTEGER,
    error        TEXT
);

-- ── playgroups ─────────────────────────────────────────────────────────────
CREATE TABLE playgroups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    join_code   TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL
);

-- A member is either an account (user_id) or a guest with only a name.
CREATE TABLE playgroup_members (
    id            TEXT PRIMARY KEY,
    playgroup_id  TEXT NOT NULL REFERENCES playgroups(id) ON DELETE CASCADE,
    user_id       TEXT REFERENCES users(id),
    guest_name    TEXT,
    created_at    TEXT NOT NULL,
    CHECK ((user_id IS NULL) <> (guest_name IS NULL))
);
CREATE UNIQUE INDEX playgroup_members_user ON playgroup_members(playgroup_id, user_id) WHERE user_id IS NOT NULL;

-- ── decks ──────────────────────────────────────────────────────────────────
CREATE TABLE decks (
    id                  TEXT PRIMARY KEY,
    owner_id            TEXT NOT NULL REFERENCES users(id),
    name                TEXT NOT NULL,
    folder              TEXT,
    format              TEXT NOT NULL DEFAULT 'commander',
    current_version_id  TEXT,
    container_id        TEXT,          -- collection container holding the physical deck
    archived            INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- Immutable. Each edit makes a new version; games point at the version that was played.
CREATE TABLE deck_versions (
    id          TEXT PRIMARY KEY,
    deck_id     TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    cards       TEXT NOT NULL,   -- JSON: [{oracle_id, name, qty, board: commander|main|side}]
    note        TEXT,
    created_at  TEXT NOT NULL
);

-- ── collection ─────────────────────────────────────────────────────────────
CREATE TABLE containers (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    kind        TEXT NOT NULL CHECK (kind IN ('binder','deck','list','box')),
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (owner_id, kind, name)
);

CREATE TABLE collection_items (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL REFERENCES users(id),
    scryfall_id     TEXT NOT NULL,
    qty             INTEGER NOT NULL CHECK (qty >= 0),
    condition       TEXT NOT NULL DEFAULT 'NM',
    finish          TEXT NOT NULL DEFAULT 'nonfoil',
    lang            TEXT NOT NULL DEFAULT 'en',
    altered         INTEGER NOT NULL DEFAULT 0,
    signed          INTEGER NOT NULL DEFAULT 0,
    misprint        INTEGER NOT NULL DEFAULT 0,
    proxy           INTEGER NOT NULL DEFAULT 0,
    container_id    TEXT REFERENCES containers(id) ON DELETE SET NULL,
    purchase_price  REAL,
    purchase_currency TEXT,
    note            TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX collection_owner ON collection_items(owner_id, scryfall_id);
-- One row per distinct copy-kind in a container.
CREATE UNIQUE INDEX collection_identity ON collection_items(
    owner_id, scryfall_id, condition, finish, lang, altered, signed, misprint, proxy, IFNULL(container_id, ''));

-- Applied offline ops, so a retried sync never applies the same op twice.
CREATE TABLE applied_ops (
    op_id       TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    device_id   TEXT,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    applied_at  TEXT NOT NULL
);

-- ── games (in person now; online games reuse these tables later) ────────────
CREATE TABLE games (
    id              TEXT PRIMARY KEY,
    mode            TEXT NOT NULL CHECK (mode IN ('in_person','online')),
    playgroup_id    TEXT REFERENCES playgroups(id),
    created_by      TEXT NOT NULL REFERENCES users(id),
    format          TEXT NOT NULL DEFAULT 'commander',
    status          TEXT NOT NULL CHECK (status IN ('in_progress','finished','abandoned')),
    starting_life   INTEGER NOT NULL DEFAULT 40,
    engine_version  TEXT,
    seed            INTEGER,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    turns           INTEGER,
    winner_seat     INTEGER,      -- NULL = draw or unrecorded
    note            TEXT
);

CREATE TABLE game_seats (
    game_id          TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    seat             INTEGER NOT NULL,
    member_id        TEXT REFERENCES playgroup_members(id),
    user_id          TEXT REFERENCES users(id),
    guest_name       TEXT,
    ai_kind          TEXT,
    deck_version_id  TEXT REFERENCES deck_versions(id),
    deck_label       TEXT,        -- free text when the deck isn't in Yama ("Kenrith precon")
    commander_name   TEXT,
    final_life       INTEGER,
    eliminated_turn  INTEGER,
    eliminated_by_seat INTEGER,
    PRIMARY KEY (game_id, seat)
);

-- Append-only. In-person games log table events (life, poison, commander damage);
-- online games log engine actions.
CREATE TABLE game_events (
    game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    actor_seat  INTEGER,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (game_id, seq)
);
