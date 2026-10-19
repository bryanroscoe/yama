-- Simulation lab: the Commander precon catalog, imported rating runs, and per-user experiments.
-- Every simulated number here comes from phase's AI playing every seat. It is evidence about the
-- simulation, never about real games, and the app shows it apart from playgroup stats, labelled
-- with its engine, card data, AI level, games and date.

-- ── precon catalog (global, no owner) ─────────────────────────────────────────
-- Imported from commander-decks data/sim/decks/index.json (`yama-server import-precons`).
CREATE TABLE precons (
    id              TEXT PRIMARY KEY,               -- slug, e.g. "counterpunch"
    lab_id          TEXT NOT NULL UNIQUE,           -- the lab's deck id in schedules and results: "precons/counterpunch"
    name            TEXT NOT NULL,
    set_code        TEXT NOT NULL,                  -- as MTGJSON gives it ("CMD")
    set_name        TEXT,                           -- from Scryfall printings when Yama knows the set
    released        TEXT,                           -- YYYY-MM-DD
    commanders      TEXT NOT NULL,                  -- JSON array of names
    color_identity  TEXT NOT NULL DEFAULT '',       -- WUBRG order; '' = colorless
    cards           TEXT NOT NULL,                  -- JSON [{name, oracle_id|null, qty, board: commander|main}], commanders first
    same_list_as    TEXT,                           -- slug of an earlier precon with the same 100 cards
    playgroup_id    INTEGER,                        -- playgroup.gg commander id (its API is per commander)
    playgroup_name  TEXT,
    playgroup       TEXT,                           -- JSON real-game stats: {tier, win_rate_4p, games, rank, url, source, fetched, method}
    engine_support  TEXT,                           -- JSON: the index's phase_support (cards the engine only partly implements)
    notes           TEXT NOT NULL DEFAULT '[]',     -- JSON array: renames and exceptions from the index
    source          TEXT NOT NULL,                  -- where the list came from
    content_sha256  TEXT NOT NULL,                  -- of everything above, so a re-import changes nothing when nothing changed
    imported_at     TEXT NOT NULL
);

-- ── imported analysis runs ────────────────────────────────────────────────────
-- One row per analysed run (commander-decks scripts/sim/analyze.py summary.json), imported with
-- `yama-server import-lab`. owner_id NULL = global, readable by everyone signed in; otherwise only
-- the owner sees it.
CREATE TABLE lab_runs (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT REFERENCES users(id),
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL CHECK (kind IN ('precon-ratings','paired')),
    engine          TEXT,                           -- e.g. "phase-rs v0.113.0" (every label the results carry)
    card_data       TEXT,                           -- engine card data hash
    runner          TEXT,                           -- runner build stamp(s)
    difficulty      TEXT,                           -- AI level
    games           INTEGER NOT NULL,               -- games in the model
    created_at      TEXT NOT NULL,                  -- when the run was scheduled
    analysed_at     TEXT,                           -- when the summary was generated
    imported_at     TEXT NOT NULL,
    summary         TEXT NOT NULL,                  -- the summary JSON as imported
    summary_sha256  TEXT NOT NULL
);
CREATE UNIQUE INDEX lab_runs_owner_name ON lab_runs(IFNULL(owner_id, ''), name);
CREATE INDEX lab_runs_kind ON lab_runs(kind, created_at);

-- One row per rated deck in a run, from the summary's decks.
CREATE TABLE lab_ratings (
    run_id      TEXT NOT NULL REFERENCES lab_runs(id) ON DELETE CASCADE,
    deck_ref    TEXT NOT NULL,                      -- the deck id in the run ("precons/counterpunch", "bryan/...", a variant)
    strength    REAL,                               -- 1 = geometric mean of the field
    lo          REAL,                               -- interval on strength (the run's level, e.g. 90%)
    hi          REAL,
    win_rate    REAL,                               -- raw win rate in the main pod size
    wr_lo       REAL,                               -- Wilson interval on it
    wr_hi       REAL,
    games       INTEGER NOT NULL,
    avg_place   REAL,
    extra       TEXT NOT NULL DEFAULT '{}',         -- JSON: the summary's whole entry for the deck (rank, p4_field, flags, ...)
    PRIMARY KEY (run_id, deck_ref)
);

-- ── experiments ("Try a change") ──────────────────────────────────────────────
-- A user's own simulation: lists to compare and a field to play them against, run by the server
-- on the play crate's lab core. Always owner-scoped.
CREATE TABLE lab_experiments (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL REFERENCES users(id),
    op_id           TEXT,                           -- client-generated, so a retried create makes one experiment
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL DEFAULT 'paired' CHECK (kind IN ('paired')),
    status          TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
    spec            TEXT NOT NULL,                  -- JSON: lists (frozen cards), opponents, games, difficulty, limits, seed
    games_total     INTEGER NOT NULL,
    games_done      INTEGER NOT NULL DEFAULT 0,
    engine          TEXT NOT NULL,
    card_data       TEXT NOT NULL,
    runner          TEXT NOT NULL,
    difficulty      TEXT NOT NULL,
    summary         TEXT,                           -- JSON: per-list results, the paired difference with its interval
    error           TEXT,
    created_at      TEXT NOT NULL,
    started_at      TEXT,
    finished_at     TEXT,
    updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX lab_experiments_op ON lab_experiments(owner_id, op_id) WHERE op_id IS NOT NULL;
CREATE INDEX lab_experiments_owner ON lab_experiments(owner_id, created_at);
CREATE INDEX lab_experiments_status ON lab_experiments(status, created_at);

-- Every scheduled game of an experiment, written when it is created; result filled when played.
-- A restarted server plays the games whose result is still NULL, so runs resume.
CREATE TABLE lab_experiment_games (
    experiment_id   TEXT NOT NULL REFERENCES lab_experiments(id) ON DELETE CASCADE,
    game            TEXT NOT NULL,                  -- the schedule line's game id
    ord             INTEGER NOT NULL,               -- play order: a pod's paired games are adjacent, so partial results stay paired
    spec            TEXT NOT NULL,                  -- JSON schedule line (play crate lab::GameSpec)
    result          TEXT,                           -- JSON result line (lab::GameResult); NULL until played
    end_kind        TEXT,                           -- the result's end, for counting
    finished_at     TEXT,
    PRIMARY KEY (experiment_id, game)
);
CREATE INDEX lab_experiment_games_pending ON lab_experiment_games(experiment_id, ord) WHERE result IS NULL;
