# Per-user deck planner in Yama: final design

I checked this read-only on 2026-10-18. Yama `main` is at 3570ee1, with migrations 0001 to 0005. The `yama-planner` worktree (branch `planner`) is clean. The `yama-lab` worktree has another thread's uncommitted runner work: `play/src/bin/lab.rs`, `deploy/lab.sh`, `deploy/Dockerfile.lab`, `play/build.rs`, plus edits to `Cargo.lock`, `play/Cargo.toml` and `play/src/lib.rs`. commander-decks is at 6dc79d6 (guide v6). Another thread has uncommitted work there too: `.gitignore`, `scripts/sim/`, `data/sim/decks/`. I changed no files.

**How this design was put together.** It starts from Design 1, which all three judges picked. It adds Design 3's sync and token rules and Design 2's owner-scoped foreign keys and "retire, don't delete". I checked every error the judges raised against the code. Section 15 lists what I verified and how each one is fixed.

---

## 1. Summary

Yama gets a **Plan** area under the Decks tab. Every user has the same per-user planner tables. Each plan deck records where it came from:
- `source = 'import'`: an outside export manages it. Today that is Bryan's commander-decks repo.
- `source = 'yama'`: it was made in Yama. Friends get this later, and Bryan can use it if he ever moves over.

**Bryan, now:**
- **The repo stays the source of truth for plan content.** That covers decks, swaps, proposals, orders, prices and rules. Agents keep editing JSON. `check_project.py`, git history and every AGENTS.md rule keep working.
- **The repo exports.** A new `scripts/planner/export.py` writes one file, `data/planner/plan.json`, in the format `yama-plan/1`. It reads only through `swapdata.load()` and `library.build()`, so it can't disagree with the guides.
- **The file gets into Yama two ways.** At first Bryan uploads it in the browser under his own sign-in. From slice 4, `publish.py` sends it with a scoped script key.
- **Yama stores it as his ordinary rows.** The import is idempotent: the same content writes nothing.
- **His taps flow back.** Review answers, "installed" ticks, "bought it" marks and ideas go into an inbox in Yama. `pull.py` merges them back into the repo.

**Where views are computed.** Every derived view (diffs, review list, buy list, print list, spares, bracket lists, copy text) is pure TypeScript in `packages/core`. It runs from one per-user bundle that is cached on the phone. So the buy list works in a store with no signal, and friends' plans reuse the same code.

**What Bryan sees, and when:**

| After | About | He has |
|---|---|---|
| Deploy 1 | 5½ working days | His 8 decks on his phone, read-only: the 7 wired decks plus Multiverse Reforged as proposals only. Stock, now and after lists, every swap with its reason and where the card came from, bracket bags, and copy buttons. |
| Deploy 2 | 8½ days | Review on the phone, with the loop back to the repo closed (`pull.py`). The Mac review site becomes read-only. |
| Deploy 3 | 11 days | Buy list with cart links and price flags, prints, spares, and installed ticks. This replaces the `~/Downloads` guides for day-to-day use. |
| Later | about 15 days | Friends make their own plans from their Yama decks. |

---

## 2. Decisions (with reasons)

1. **Everyone gets the same per-user tables, with a `source` flag on each plan deck.** Reason: Bryan's decision 3 says every user gets the tools on their own data. Bryan's data goes into the same tables a friend fills by hand. If he later moves his plans into Yama, that is one column per deck, not a rewrite.

2. **For imported plans, the repo owns plan content and Yama shows it read-only.** Edit attempts return `409`. Reason: agents keep working, the repo keeps its history, and Yama can always be rebuilt from the repo. `docs/deck-lab-plan.md` already says this.

3. **One import path, and the owner always comes from sign-in.** It works with the web session first and a scoped key later. The document has no owner field, and the server never looks a user up by email. No admin path is involved. Reason: this keeps the planner per-user, and nothing has to be copied into saget's `/data`.

4. **Python stays the only engine for imported plans' lists.** Yama stores the stock, now and after lists that `library.build()` produced, as immutable rows identified by a hash of their contents. Reason: Yama can't disagree with the guides, and there is no second state engine on the critical path. A Yama engine (`states.ts`) comes only with friends' plans (slice 7). It is checked against Python on Bryan's real data.

5. **Plan lists live in `plan_states`, not `deck_versions`.** Reason: `DeckCard.oracle_id` is a required `String` (decks.rs:32-37), so a list containing a card Yama doesn't know yet (Star Trek) can't be a deck version. This also keeps proposed builds apart from installed decks. A Yama deck is made from a plan list only when the user taps "Make this a Yama deck". Imports never create or change decks.

6. **Derived views are TypeScript in `packages/core`, computed from one bundle.** Reason: the server stays thin, views work offline, the same code serves friends, and it is easy to test with vitest.

7. **Idempotency compares content against the current head only.** The exporter writes the plan body as byte-deterministic JSON. The server hashes the exact bytes of that body; metadata such as `generated_at` and the git commit sits outside it. If the hash equals the owner's current head, nothing is written. Otherwise the import applies, even if that hash was imported long ago. Reason: a rebuild with no changes stays a no-op. Re-uploading an older file is never silently ignored while the database holds newer content, which was a bug in every draft.

8. **Imported rows are retired, not deleted, and aliases follow renames.** A swap, order or store missing from a new document gets `retired_at`, and comes back if the document brings it back. Rows can carry `was` (old keys) and `from_candidate`, which become aliases. Reason: review answers, ticks and lab references survive agent edits.

9. **User input is an op inbox.** Ops have client-made ids. Each op runs in its own savepoint. The pull cursor is a global `AUTOINCREMENT` sequence, and rejected ops are recorded. Reason: Yama's AGENTS.md requires offline-first writes as idempotent ops. Per-op savepoints fix the weakness in `collection.rs:110-126`, where one bad op rolls back the whole batch. A global sequence can't collide when two devices sync at once.

10. **Review answers and installed ticks are last-writer-wins full records, with tombstones, in UTC.** Reason: the result doesn't depend on arrival order, and an answer cleared in Yama can't come back from a stale export.

11. **"Bought it" marks and ideas are claims, never orders or plan changes.** Reason: AGENTS.md says not to infer purchases, and deck-lab-plan says a bought tap becomes an order only after Bryan confirms the receipt.

12. **Script keys live in their own `api_tokens` table, with a scope (`plan:sync`), behind a new `SyncUser` extractor.** `CurrentUser` never accepts them, and they are never admin. Reason: today `CurrentUser` accepts any session token as Bearer and on WebSocket `?token=` (auth.rs:50-73), so a session-row key would carry the whole account, including Bryan's admin rights. Session rows are also wiped by `yama-server user add` and `remove-password` (auth.rs:245, 256).

13. **Prices stay separate by meaning.** NULL never becomes 0, and every price shows its date and source.
    - Market prices are read only from `price_snapshots`.
    - Store stock checks and recorded benchmarks go in `plan_quotes`.
    - Paid prices go on `plan_order_items`.
    - Proxy cost comes from settings.

14. **Shopping rules are per user, dated, and only produce flags.** Bryan's rows start **2026-10-08** and **2026-10-10**, matching the headings in `notes/decisions.md`. Each flag uses the rule set in force on its date.

15. **Owner isolation is enforced twice.**
    - Every handler binds `owner_id` and returns 404 for anyone else's id.
    - Links that cascade use composite foreign keys on `(parent_id, owner_id)`, so the database itself refuses a cross-owner link.
    - Links that `SET NULL` use the id alone. In SQLite, `SET NULL` on a composite key would also set `owner_id` to NULL and break NOT NULL. Those links are owner-checked in code.

16. **The planner lives under the Decks tab, so the phone nav keeps six tabs.** Reason: `.nav` is `repeat(6, 1fr)` and a 390 px phone is tight. The routes are `/decks/plan/...`, and static segments outrank `/decks/:id` in react-router.

17. **The lab follows the lab branch's runner contract.** Inputs are deck `.txt` files plus `schedule.jsonl`; output is `results-saget.jsonl`. The runner is a separate `yama-lab` image. The web app never gets the Docker socket. An admin approves each job. The lab tables come in a later migration, agreed with the lab thread.

18. **The schema change is additive.** One migration, `0006_planner.sql`, adds all planner tables, including script keys. The only change to an existing table is a new unique index on `decks(id, owner_id)`.

---

## 3. Source of truth and sync (Bryan's repo vs Yama)

### 3.1 Who owns what

| Data | Imported plan (Bryan today) | Yama-made plan (friends, later) | Copy kept elsewhere |
|---|---|---|---|
| Plan content: decks, commander, owner changes, swaps, stand-ins, moves with `got`, proposals, bracket bags, orders, store checks and benchmarks, stores, shopping rules | **Repo**, through the export. Read-only in Yama (409). | **Yama**, through ops | The last 10 uploaded documents, gzipped, in `plan_imports` |
| Stock, now and after lists | **Repo** (`library.build()`) | **Yama** (`states.ts`, slice 7) | `plan_states` history |
| Review answers | **Both.** Last writer wins by timestamp. | Yama | Repo `data/shopping/review.json`, via `pull.py` |
| Installed ticks | **Yama** | Yama | Repo `data/planner/installed.json`, a pulled copy |
| "Bought it" marks, ideas | **Yama inbox.** An agent acts only after Bryan confirms. | Yama (one tap turns them into an order or a proposal) | Repo `data/planner/inbox/inbox-DATE.jsonl` |
| Derived views | Yama, in TypeScript, from the stored lists and rows | Same | The repo's guides, until Bryan stops using them |
| Card data, market prices | Yama's global tables | Same | The repo's dated snapshots |

### 3.2 Publishing (repo to Yama)

1. **Export.** `build.sh` runs `export.py` after `version.py`, because it needs the new guide version. The line is non-fatal: `python3 -I ../planner/export.py || echo "Planner export failed; the guides are fine."`. That way an export bug can't block another thread's guide rebuild under `set -e`. The output is `data/planner/plan.json`, which is gitignored: it is derived and contains prices paid.

2. **Upload, slices 1 to 3: the browser.** Bryan goes to Decks, then Plans, then "Import a plan file", and picks `plan.json`.
   - Yama first runs a dry run and shows the report.
   - It shows the file's guide version and commit next to the current ones.
   - It warns if the file's guide version is lower than what Yama already has.
   - "Import" applies it.

3. **Upload, slice 4 on: `scripts/planner/publish.py`.** It is separate from `build.sh`, which never sends anything off the Mac. In order, it:
   - runs `check_project.py` and stops if it fails;
   - stops if any exporter input has uncommitted changes, unless `--allow-dirty` is given. The inputs are an explicit list (section 6.1). Unrelated work, such as another thread's untracked `data/sim/decks/`, doesn't block it;
   - calls `GET /api/plan/head`, gets the commit Yama's head came from, and stops unless `git merge-base --is-ancestor <head_sha> HEAD` succeeds. This catches a stale worktree that would roll the plan back. `--force` overrides it;
   - with `--dry-run`, posts `?dry_run=1` and prints the report;
   - otherwise posts the file with the key from the macOS Keychain (`security find-generic-password -s yama-plan-sync -w`) or `YAMA_TOKEN`, then prints the report and Yama's revision.

4. **The server.** It hashes the body. If the hash equals the head, the import is `unchanged` and nothing is written. Otherwise it applies the document in one short transaction (section 6.5).

### 3.3 The inbox (Yama to repo)

- **Recording taps.** Every tap in the Plan area is an op: `{op_id: crypto.randomUUID(), device_id, kind, at, ...}`. The web outbox follows `web/src/table/store.ts`: it retries on `online` and every 20 s, and posts to `POST /api/plan/inputs`.
- **What reaches the repo.** Ops aimed at an imported deck get `for_export = 1`. Ops on Yama-made decks take effect directly and never reach the repo.
- **`scripts/planner/pull.py`** works in this order:
  1. Takes a lock file (`data/planner/.pull.lock`, gitignored).
  2. Stops if the review site is still accepting answers on port 8765, so `review.json` never has two writers.
  3. Calls `GET /api/plan/inbox` with the script key. The server returns `for_export` ops after its own `pulled_through` cursor, so the repo needs no cursor file.
  4. Appends every op to `data/planner/inbox/inbox-YYYY-MM-DD.jsonl` (committed; old files are kept).
  5. Merges review answers into `review.json` by key. The newer answer wins, and Yama's UTC time is written back in the review site's local, timezone-less format so the file stays uniform. A tombstone that is newer than the repo's entry replaces it with the same tombstone, which the review site and every reader of `review.json` treat as no answer. Nothing is deleted.
  6. Rewrites `data/planner/installed.json` (committed, labelled "pulled copy; don't edit"), only if it changed.
  7. Prints what needs an agent and Bryan: bought marks, ideas, and answers that match no swap.
  8. Calls `POST /api/plan/inbox/ack {through}`.
- **Closing the loop.** When an agent acts on a bought mark or an idea, it records the outcome in `data/planner/inbox-resolutions.json` (committed). Two examples: "Recorded as order pats-2026-10-21" after Bryan confirmed the receipt, or "Declined: over the $3 ceiling". The next export carries these as `inbox_resolved`, and Yama shows the outcome. Yama also notices on its own when a newer import gives the marked swap an order item. It then shows "Recorded as order X".

### 3.4 Conflict rules

| Case | Rule |
|---|---|
| The same content is uploaded again | `unchanged`. No writes, no revision bump, no new list rows. |
| An older file is uploaded after a newer one | Browser: a warning, then Bryan decides. `publish.py`: refused by the ancestor check unless `--force`. Never silently skipped. |
| A review answer is given in Yama and also in the repo (review site or agent) | Last writer wins per key. Times are compared in UTC; the exporter converts `review.json`'s naive local times with the Mac's time zone. Ties go to the Yama answer. Times are kept to whole seconds, and a device time more than 5 minutes in the future is clamped to the time it was received. |
| An answer is cleared in Yama | Stored as a tombstone: decision, note and cut all null, with a time. An older answer in a later export doesn't bring it back. |
| An answer is cleared on the Mac review site | Since 2026-10-19 `server.py` keeps the key as a tombstone (decision, note and cut null, with the time), the export carries it, and Yama replaces its older copy. A key missing from the export is never read as a clear. |
| An agent renames a swap's in or out | The row carries `was: [old key]`, which becomes an alias, and answers and ticks follow it. Without an alias, the answer is kept and listed under "Answers for swaps no longer in the plan". It is never dropped. |
| A candidate is promoted | The new swap row carries `from_candidate: <id>`, so the "want" follows it. Until then Yama shows "Waiting for your planner". Yama never promotes for an imported plan. |
| A swap leaves the plan but has an installed tick | The swap is retired, and the tick stays. The overview shows "Installed, but no longer in the plan" for Bryan to settle. |
| "No" on an existing plan swap | Stored as an answer. The page says: "You said no. Nothing changes until you and your planner decide what to do with this swap." Nothing is ever cut silently. |
| "Bought it" | Inbox only. Never an order. It doesn't change the now list and doesn't count as owned. |
| A content edit on an imported plan | `409`: "This plan is managed by your commander-decks export." The page offers "Suggest a change", which creates an `idea` op. |

---

## 4. Data model

### 4.1 Migration `server/migrations/0006_planner.sql`

```sql
-- Deck planner, per user. Every table carries owner_id and every query binds the caller's id.
-- A plan deck either comes from an outside export (source 'import', read-only here; Bryan's
-- commander-decks repo) or is made in Yama (source 'yama').
-- Prices: NULL means unknown, never 0. Dates are YYYY-MM-DD; times are RFC 3339 UTC (util::now);
-- ids are util::new_id; JSON lives in TEXT.
--
-- Owner-scoped links: a child link that cascades uses a composite key (parent_id, owner_id), so the
-- database refuses a link to another user's row. A link that is SET NULL on delete uses the id
-- alone, because SQLite's SET NULL would also null owner_id; the code checks those owners.

-- Parent key for plan_decks.deck_id. Decks are archived, never deleted.
CREATE UNIQUE INDEX decks_id_owner ON decks(id, owner_id);

-- ── per-user head and cache key ────────────────────────────────────────────
CREATE TABLE plan_meta (
    owner_id        TEXT PRIMARY KEY REFERENCES users(id),
    revision        INTEGER NOT NULL DEFAULT 0,  -- +1 on every applied import or input; bundle cache key
    head_import_id  TEXT,                        -- the applied import now in force
    head_hash       TEXT,                        -- its content hash; equal hash = unchanged
    head_git_sha    TEXT,                        -- from its meta; publish.py's ancestor check
    pulled_through  INTEGER NOT NULL DEFAULT 0,  -- highest plan_inputs.seq the export side acknowledged
    pulled_at       TEXT,
    updated_at      TEXT NOT NULL
);

CREATE TABLE plan_imports (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    content_hash  TEXT NOT NULL,                 -- sha256 of the exact bytes of the document's "plan" value
    format        TEXT NOT NULL,                 -- 'yama-plan/1'
    meta          TEXT NOT NULL,                 -- JSON {app, guide_version, guide_date, git_sha, dirty, generated_at}
    via           TEXT NOT NULL CHECK (via IN ('web','token','cli')),
    forced        INTEGER NOT NULL DEFAULT 0,
    report        TEXT NOT NULL,                 -- JSON import report (section 6.6)
    document_gz   BLOB,                          -- the upload, gzipped; kept for the newest 10 per owner
    imported_at   TEXT NOT NULL
);
CREATE INDEX plan_imports_owner ON plan_imports(owner_id, imported_at);

-- ── rules and stores ───────────────────────────────────────────────────────
-- Each row is the complete rule set in force from its date, so a purchase is judged by the rules of its day.
CREATE TABLE plan_settings (
    owner_id        TEXT NOT NULL REFERENCES users(id),
    effective_from  TEXT NOT NULL,               -- YYYY-MM-DD
    rules           TEXT NOT NULL,               -- JSON, section 9
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
    short_name         TEXT,                     -- 'Pat''s' (the src value in swaps.json)
    kind               TEXT NOT NULL CHECK (kind IN ('local','online','printer')),
    cart_url_template  TEXT,                     -- https only, contains {items}; items = 'variant:qty' joined by ','
    homepage           TEXT,
    location           TEXT,                     -- 'San Marcos, 44 mi'
    note               TEXT,                     -- 'In store only; no online stock'
    print_tiers        TEXT,                     -- printers: JSON [n, ...]; NULL unknown
    sort               INTEGER NOT NULL DEFAULT 0,
    origin             TEXT NOT NULL CHECK (origin IN ('import','yama')),
    import_id          TEXT,
    retired_at         TEXT,
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
    commander        TEXT NOT NULL,              -- JSON [{name, oracle_id|null}]: the plan's commander, not the box face
    color_identity   TEXT,                       -- WUBRG order: 'WUR'
    owner_changes    TEXT NOT NULL DEFAULT '[]', -- JSON [{out, in, note}] made before any plan
    bracket          TEXT,                       -- JSON, see 4.2
    notes            TEXT NOT NULL DEFAULT '[]', -- JSON [{kind: 'open_question'|'warning'|'note', text}]
    deck_id          TEXT,                       -- the user's Yama deck for this physical deck, if linked
    base_version_id  TEXT REFERENCES deck_versions(id),  -- 'yama' plans: the list the plan starts from (owner checked in code)
    sort             INTEGER NOT NULL DEFAULT 0,
    import_id        TEXT,                       -- last import that wrote it; NULL if made in Yama
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (owner_id, key),
    UNIQUE (id, owner_id),
    FOREIGN KEY (deck_id, owner_id) REFERENCES decks(id, owner_id)
);

-- Immutable lists. A changed list is a new row; `current` marks the one pages show.
-- Lab jobs and Yama decks made from a list point at exact rows, so old rows are kept.
CREATE TABLE plan_states (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id),
    plan_deck_id  TEXT NOT NULL,
    state         TEXT NOT NULL CHECK (state IN ('stock','now','after','proposal','bracket3','bracket2')),
    content_hash  TEXT NOT NULL,                 -- sha256 of the canonical cards JSON
    cards         TEXT NOT NULL,                 -- JSON [Slot], see 4.2
    log           TEXT NOT NULL DEFAULT '[]',    -- JSON [{swap, status}]: done|standin|fill|waiting|print|moved|waiting-move|spare
    unresolved    TEXT NOT NULL DEFAULT '[]',    -- names not in Yama's card data yet (kept, never dropped)
    computed_by   TEXT NOT NULL,                 -- 'commander-decks library.py, guide v6' | 'yama plan engine 1'
    current       INTEGER NOT NULL DEFAULT 0,
    import_id     TEXT,
    created_at    TEXT NOT NULL,
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
    oracle_id                  TEXT,             -- NULL when not in Yama's card data (kept, reported)
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
    received                   INTEGER,          -- 1 yes, 0 never arrived, NULL unknown
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
    ext_key         TEXT NOT NULL,               -- imports: the review site's id (6.2); made in Yama: 'y|<id>'
    stage           TEXT NOT NULL CHECK (stage IN ('proposed','planned')),
    role            TEXT NOT NULL CHECK (role IN ('swap','standin','optional')),
    parent_id       TEXT REFERENCES plan_swaps(id) ON DELETE SET NULL,  -- standin -> the print swap it holds
    src             TEXT NOT NULL CHECK (src IN ('buy','print','owned')),
    src_declared    TEXT,                        -- Tricky Terrain: src as written in tricky-terrain.json, when it differs
    store_label     TEXT,                        -- buy rows: the store as written ('Pat''s')
    out_name        TEXT,                        -- NULL: optional extra with no slot, or proposal with no cut
    out_oracle_id   TEXT,
    in_name         TEXT NOT NULL,
    in_oracle_id    TEXT,                        -- NULL when not in Yama's card data yet (kept, reported)
    plan_card       TEXT,                        -- differs from in_name for a budget substitute
    later_out       TEXT,                        -- cut to use if out has already left (shown as recorded)
    after_print     INTEGER NOT NULL DEFAULT 0,
    tier            TEXT,                        -- the user's gameplay priority label: 'T1', 'FF land', 'Core'
    band            TEXT CHECK (band IN ('B2','B3','B4')),
    sort            INTEGER NOT NULL DEFAULT 0,
    game_changer    INTEGER,                     -- 1/0/NULL unknown
    got             TEXT,                        -- JSON {how:'bought',order} | {how:'pulled',product,date?} | {how:'deck',deck,origin}
    order_item_id   TEXT REFERENCES plan_order_items(id) ON DELETE SET NULL,
    print_order_id  TEXT REFERENCES plan_orders(id) ON DELETE SET NULL,
    listing         TEXT,                        -- the 'version' text from swaps.json
    group_label     TEXT,
    when_text       TEXT,
    advice          TEXT,
    why             TEXT,
    why_out         TEXT,
    note            TEXT,
    content_hash    TEXT,                        -- sha256 of the row's canonical JSON; unchanged rows aren't rewritten
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
    id               TEXT PRIMARY KEY,
    owner_id         TEXT NOT NULL REFERENCES users(id),
    swap_id          TEXT REFERENCES plan_swaps(id) ON DELETE CASCADE,
    card_name        TEXT NOT NULL,
    oracle_id        TEXT,
    kind             TEXT NOT NULL CHECK (kind IN ('stock_check','market_benchmark')),
    store_id         TEXT REFERENCES plan_stores(id) ON DELETE SET NULL,
    store_label      TEXT,                       -- as recorded: 'Alpha Strike Games (San Marcos, 44 mi)'
    checked_on       TEXT NOT NULL,
    result           TEXT,                       -- stock note as recorded
    in_stock         INTEGER,                    -- 1/0/NULL unclear
    price            REAL CHECK (price IS NULL OR price >= 0),  -- NULL = no price
    price_from_text  INTEGER NOT NULL DEFAULT 0, -- 1: price parsed from the stock note, as buylist.listing_price does
    currency         TEXT NOT NULL DEFAULT 'USD',
    printing         TEXT,                       -- 'Forgotten Realms Commander (AFC) #175' | '2X2 #173'
    set_code         TEXT,
    collector_number TEXT,
    printing_from_text INTEGER NOT NULL DEFAULT 0,
    scryfall_id      TEXT,
    variant          TEXT,                       -- cart line id (Shopify variant): makes it cart-able
    url              TEXT,
    source           TEXT NOT NULL,              -- 'TCGplayer market via Scryfall, cheapest non-foil' | 'Pat''s Games website'
    import_id        TEXT,
    created_at       TEXT NOT NULL
);
CREATE INDEX plan_quotes_swap ON plan_quotes(swap_id);

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
-- For publish.py / pull.py. Accepted only by the SyncUser extractor, never by CurrentUser; never admin.
CREATE TABLE api_tokens (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,                 -- 'commander-decks on the Mac'
    token_hash    TEXT NOT NULL UNIQUE,          -- sha256 of 'yama_pat_<32 random bytes, base64url>'
    scopes        TEXT NOT NULL,                 -- JSON ["plan:sync"]
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    expires_at    TEXT,                          -- default 365 days
    revoked_at    TEXT
);
CREATE INDEX api_tokens_owner ON api_tokens(owner_id);
```

### 4.2 JSON shapes

**Slot** (one entry in `plan_states.cards`) mirrors the slot dicts `library.build()` already makes (`scripts/collection/library.py:221-343`):

`{name, qty, board: "commander"|"main", kind, oracle_id|null, scryfall_id|null, set|null, num|null, replaces|null, source, from_deck|null, swap_key|null, note|null}`

`kind` is one of: `stock`, `owner`, `bought`, `standin`, `fill`, `print`, `moved`, `optional`.

**`plan_decks.bracket`:**

`{target: 4, keep_note, callouts: [text], bags: {"3": [{out, in, from}], "2": [...]}, game_changers: {"4": [names], "3": [...], "2": [...]}}`

The bags come from `brackets.builds()` and `apply()`. They are imported functions; `brackets.py` has a main guard. They are bags of swaps only, not full lists, because `builds()` works on sets of names built from `precons.json` and so loses basic-land counts.

### 4.3 Notes

- **No change to existing tables.** `deck_versions`, `price_snapshots` and `decks` keep their columns. The only addition is the `decks_id_owner` unique index. It is safe because `decks.id` is already the primary key.
- **Lab tables** come in a later migration (section 11). That migration is numbered when it merges, after the lab branch lands.
- **Migration numbering.** Whichever branch merges second renumbers its file before merging. A migration is never renumbered after it has been deployed, because sqlx checksums applied migrations.

---

## 5. Server API

The new module is `server/src/plan/`, with `mod.rs` (router), `import.rs`, `bundle.rs`, `inputs.rs`, `tokens.rs` and `model.rs`. It is declared with `mod plan;` in `main.rs` and merged in `routes.rs` before the `/api/{*rest}` catch-all.

### 5.1 Extractors and ownership

- **`CurrentUser`** is unchanged. It accepts sessions only, so a `yama_pat_` key fails its session lookup and gets 401.
- **`SyncUser`** is new and returns `{user_id, via: session|token}`.
  - If there is no `yama_pat_` Bearer, it delegates to `CurrentUser`, so cookie, Bearer session and Cloudflare Access all still work.
  - Otherwise it looks the key up by hash in `api_tokens`, requires `plan:sync`, not revoked and not expired, and updates `last_used_at` at most once a minute.
  - It never carries `is_admin`.
- **Ownership checks.**
  - Every query binds the caller's id.
  - `plan_deck(pool, owner, key)` runs `WHERE owner_id = ? AND key = ?` and returns `NotFound("plan deck")`, the same pattern as `owned_deck` (decks.rs:284).
  - Swaps, orders and states are looked up with `WHERE id = ? AND owner_id = ?`.
  - Anyone else's id gets 404, never 403.
- **Revoking an invite** (`delete_invite`, auth.rs:413-426) also sets `revoked_at` on that user's keys. That is a one-statement addition.
- **Error codes:** 400 for validation (naming the JSON path), 404 for a missing or foreign id, 409 for a managed plan or a key clash, 413 for a body over the limit.

### 5.2 Routes

| Slice | Method and path | Auth | What it does | Ownership rule |
|---|---|---|---|---|
| 1 | `POST /api/plan/import[?dry_run=1&force=1]` | CurrentUser (slice 1), SyncUser (slice 4) | Imports a `yama-plan/1` document and returns the report. `DefaultBodyLimit::max(8 << 20)` on this route only. | Writes only the caller's rows; every upsert key includes `owner_id` |
| 1 | `GET /api/plan/head` | SyncUser | `{head_hash, git_sha, guide_version, imported_at, revision}` | Caller's `plan_meta` |
| 1 | `GET /api/plan/imports` | CurrentUser | The last 20 import reports | `owner_id = caller` |
| 1 | `GET /api/plan/bundle?rev=N` | CurrentUser | Everything the pages need (5.3), or `{unchanged: true}` if `rev` matches | `owner_id = caller` throughout |
| 3 | `PATCH /api/plan/decks/{key}` `{deck_id\|null, sort?}` | CurrentUser | Link the physical Yama deck | `plan_deck()`, and the deck must pass `owned_deck` |
| 3 | `POST /api/plan/decks/{key}/yama-deck` `{state}` | CurrentUser | Make a Yama deck from the **stored** list with `create_deck_with_cards`: folder "Plans", note "Made from the plan's now list, guide v6, 18 Oct 2026. A plan list, not a record of what's in your deck box." Returns 400 with the names if any card is unresolved. | `plan_deck()`; the new deck belongs to the caller |
| 4 | `POST /api/plan/inputs` `[Input]` | CurrentUser | Apply ops (5.4); returns `[{op_id, status: applied\|duplicate\|rejected, error?, seq}]` | `UNIQUE(owner_id, op_id)` |
| 4 | `GET /api/plan/inbox[?after=SEQ]` | SyncUser | `for_export` ops after `pulled_through` (or `after`), with each key resolved through aliases, an orphan flag, and deck and card names | `owner_id = caller` |
| 4 | `POST /api/plan/inbox/ack` `{through}` | SyncUser | Moves `pulled_through` | `owner_id = caller` |
| 4 | `GET\|POST /api/me/tokens`, `DELETE /api/me/tokens/{id}` | CurrentUser only (a key can't make keys) | List, create (shown once) and revoke | `owner_id = caller` |
| 6 | `GET\|PUT /api/plan/settings`, `GET\|PUT\|DELETE /api/plan/stores/{key}` | CurrentUser | Dated rule sets and stores; rows with `origin='import'` return 409 on edit | `owner_id = caller` |
| 6 | `GET /api/plan/export` | CurrentUser | The caller's planner as a `yama-plan/1` document: a backup for every user, and a way out | `owner_id = caller` |
| 7 | `POST /api/plan/decks` `{deck_id, name?}` | CurrentUser | New `source='yama'` plan; `base_version_id` = that deck's current version | `owned_deck` |
| 7 | Op kinds `swap.put`, `swap.retire`, `swap.promote`, `order.put`, `quote.add` through `/api/plan/inputs` | CurrentUser | Offline-first editing for Yama-made plans | Caller's rows; `rejected` with "managed by your export" on `source='import'` |
| 7 | `POST /api/plan/decks/{key}/states` `{state, cards}` | CurrentUser | Store a snapshot computed on the device, after `decks::validate` (already `pub`, decks.rs:501) plus the 100-card and singleton checks | `plan_deck()`, `source='yama'` |
| 8 | `POST /api/lab/jobs`, `GET /api/lab/jobs[/{id}]`, `POST /api/lab/jobs/{id}/cancel` | CurrentUser | Request, list and cancel runs | Lists must be the caller's `plan_states` or `deck_versions` |
| 8 | `POST /api/lab/jobs/{id}/approve` | CurrentUser + `require_admin` (made `pub(crate)`) | **The only admin-only planner route** | Admin |

**CLI arm** in `main.rs`: `yama-server import-plan FILE --owner EMAIL [--dry-run]`, for local development and recovery. It calls the same `import_doc`. It is not used on saget.

### 5.3 Bundle

`load_bundle(pool, owner)` returns:

```
{revision, head: {imported_at, guide_version, guide_date, git_sha, dirty} | null,
 settings: [...], stores: [...],
 decks: [{key, name, source, status, product, commander, color_identity, owner_changes, bracket, notes, deck_id,
          states: {stock, now, after}: {id, content_hash, computed_by, cards, log, unresolved}}],
 swaps: [... live and retired, retired flagged], aliases: {old: new},
 orders: [... with items], quotes: [...],
 reviews: {...}, marks: {...}, inputs: {pending_pull: n, outcomes: [{op_id, outcome, outcome_at}]},
 cards: {"<oracle_id>": {name, type_line, cmc, color_identity, layout, image_small, image_art_crop, faces?}},
 market: {"<oracle_id>": {usd, printing, scryfall_id, date, source: "TCGplayer market via Scryfall, cheapest non-foil"}},
 market_by_printing: {"<scryfall_id>": {usd, usd_foil, date}},
 prices_as_of}
```

- **Market prices** are read-only from `price_snapshots`.
  - Selection uses `json_each(?)` over a bound JSON array of ids, plus `ROW_NUMBER()` to get the latest snapshot per printing. No SQL is built at runtime, so no `AssertSqlSafe` is needed.
  - `market` is the cheapest non-foil `usd` across real, tournament-legal paper printings: World Championship Decks, Pro Tour Collector Set, Collectors' Edition, 30th Anniversary Edition and oversized sets are excluded by a constant set list in the static SQL (review of slices 0-2, 2026-10-19).
  - `market_by_printing` covers the printings named by quotes and order items.
  - A missing price is `null`, every price carries its date and source, and nothing is written to `price_snapshots`.
- **Size.** About 0.6 to 1 MB raw for Bryan, roughly 100 to 150 KB gzipped. The `CompressionLayer` is already on.

### 5.4 Inputs

- **Shape.** `Input = {op_id, device_id?, kind, at, ...payload}`. `at` is cut to whole seconds and clamped if it is more than 5 minutes in the future.
- **Kinds.** The client always sends the **full** record, taken from the answer it currently shows with pending ops overlaid, so last-writer-wins needs no per-field clocks:
  - `review`: `{swap_key, deck_key, decision: want|unsure|no|null, note: string ≤ 2000, cut: string|null}`. All empty means a clear, stored as a tombstone.
  - `installed`: `{swap_key, value: bool}`.
  - `bought`: `{swap_key, value: bool, store_key?, store_label?, price_paid?: number|null, qty: int ≥ 1, on: date}`.
  - `idea`: `{deck_key, in, out?, why?}`.
- **Processing.** One transaction for the batch, with a savepoint per op:
  1. `INSERT ... ON CONFLICT(owner_id, op_id) DO NOTHING`. If the op already exists, return `duplicate` with its original status.
  2. Validate. If it fails, roll back to the savepoint and store the op with `status='rejected'` and the error.
  3. Apply to `plan_reviews` or `plan_marks`, newest `at` wins.
  4. Set `for_export` when the target deck is `source='import'`, or when the key matches no deck.
  5. Bump `plan_meta.revision` once per batch.
- **Unknown keys.** A `swap_key` that matches nothing is accepted and kept as an orphan.

---

## 6. Importer for commander-decks

### 6.1 What `scripts/planner/export.py` reads

It reads only these, which are also `publish.py`'s list of inputs that must be committed:

- `swapdata.load()`, for swaps, plus `swapdata.got_text`;
- `library.build()` and `library.ORDER`, `OWNER_CHANGES`, `NOW_FILL`, `NOT_RECEIVED`, `PRINT_ORDER`, `wanted_printing`, `bought_slot`;
- `brackets.builds()` and `apply()` (imported functions; `brackets.py` has a main guard);
- the files `data/shopping/{swaps,candidates,review,tricky-terrain,multiverse-reforged,precons}.json`, `data/purchases.json`, `data/brackets.json`, `data/shopping/guide-version.json`, `data/planner/{stores,settings,inbox-resolutions}.json`;
- the code in `scripts/shopping/*.py`, `scripts/collection/library.py` and `scripts/planner/*.py`.

It does **not** import `compare_lists.py`, which has no main guard: importing it runs `L.build()` and rewrites every `decks/compare/*.txt`. It builds stock with `library.Deck` (the same 6 lines as `compare_lists.stock_deck`) and checks the result against `decks/compare/*-1-stock.txt`. It does not import `build.py`, `buylist.py`, `spares.py`, `printlist.py` or `swapguide.py` either. Those are top-level scripts that write files when imported, and Yama computes its own views anyway.

`python3 -I` drops the script's directory from `sys.path`, so `export.py` adds `scripts/`, `scripts/shopping` and `scripts/collection` itself, as the other scripts do.

### 6.2 Mapping

| commander-decks | Yama |
|---|---|
| `library.ORDER` decks, plus Multiverse Reforged (`multiverse-reforged.json`, `status: proposals_only`, stock = now = after) | `plan_decks`, with slug keys as in `compare_lists.slug`; `name` keeps the display name used inside legacy keys |
| Stock (`library.Deck` from `library.build()`'s stock), now and after from `library.build()`, with slot kind, printing, source and log status | `plan_states` (stock, now, after), `computed_by: "commander-decks library.py, guide v6"` |
| `OWNER_CHANGES`, `NOW_FILL` | `plan_decks.owner_changes`; `fill` slots and the log |
| swaps.json rows (`Pat's`/`Mothership` → `buy` with `store_label`, `PRINT` → `print`, `MOVE` → `owned` with `got`) | `plan_swaps`, stage `planned`, role `swap`, key `plan\|<deck>\|<inn>\|<out>` (as at `scripts/review/server.py:141`) |
| Tricky Terrain rows through `swapdata.tricky_rows()` | Same, but `band` comes from `tricky-terrain.json`, because `tricky_rows()` keeps only `tier = TIER[band]` (swapdata.py:51-70). `tricky_rows()` also turns an unbought `buy` row into `PRINT` and infers `after_print` from "print arrives"; `src_declared` and a report warning record both. |
| `opt` entries with `standin_for` | Role `standin`; parent = the PRINT row whose `standin` names this card. Key `standin\|<deck>\|<inn>`. The exporter asserts that the two records agree (21 today) and that the stand-in's `out` equals the parent's `out`. |
| Other `opt` entries (`out` may be null) | Role `optional`, key `opt\|<deck>\|<inn>` |
| `candidates.json` | Stage `proposed`, key = candidate id, with `group`, `when`, `advice`, `later_out` and `got`. A candidate with `out: null` (for example `rohan-flyers-aetherize`) is kept with `out_name` NULL. |
| Candidate `price` object `{market, printing, source, checked}` | A `market_benchmark` quote |
| Candidate `stock[]` entries | `stock_check` quotes. The store is matched to `stores.json` by name; otherwise only `store_label` is set. `variant` is kept. `price` comes from the entry, else is parsed from `result` the way `buylist.listing_price` does it, with `price_from_text = 1` (for example Settle the Wreckage at Pat's: variant set, price null, "$0.50" in the note). A printing written as `SET #num` in the note is parsed into `set_code`/`collector_number`, with `printing_from_text = 1`. |
| `purchases.json` orders and items, with printing from `wanted_printing`, `received_version`, and `NOT_RECEIVED` (Horn of the Mark → `received: 0`) | `plan_orders` (`kind real`, status `received`, `date_fulfilled` as recorded or NULL, `subtotal_note` kept, NULL tax and total kept) and `plan_order_items`. A buy swap's `order_item` uses the same (deck, card) one-copy-per-use match as `library.bought_slot`. |
| The placed MakePlayingCards order | See 6.4 |
| `brackets.json` b3/b2 and the Tricky Terrain bags from `brackets.builds()` | `plan_decks.bracket` |
| `review.json` (empty today), with naive local `at` converted to UTC | Document `reviews`, merged last-writer-wins |
| `notes/todo.md` open items: Mount Doom's source, the Karmic Guide clash, the stale Fantastic Four Scarlet Witch `later_out` | `plan_decks.notes` as open questions and warnings |
| `inbox-resolutions.json` | Document `inbox_resolved` |
| Swap rows' optional `was` and `from_candidate` fields (new; agents add them from now on) | Document `aliases` |
| `data/planner/stores.json` (new, hand-written once): Pat's and Mothership with cart templates (from `buylist.CART`), Card Gurus (in store only), Alpha Strike, the others in `docs/local-stores.md`, and MakePlayingCards as the printer | `plan_stores` |
| `data/planner/settings.json` (new; section 9) | `plan_settings`, `origin='import'` |

**Why the keys are the review site's ids.** Every past and future answer lines up. All 258 plan keys and 24 `opt` keys are unique today. Swaps have no stable ids yet; aliases cover renames. If Bryan wants, minting an `id` on every swaps.json row later is a one-time edit to a shared file. It is not needed for this build.

### 6.3 The document: `yama-plan/1`

Yama documents the format in `~/Developer/yama/docs/plan-format.md` (slice 0). The content hash covers only the `plan` value. The server reads it as a `serde_json::value::RawValue` (this needs the `raw_value` feature) and hashes its exact bytes, so `meta` never affects idempotency. The exporter writes `plan` with `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`, with no wall-clock times inside it.

```json
{
  "format": "yama-plan/1",
  "meta": {"app": "commander-decks", "guide_version": 6, "guide_date": "2026-10-18",
           "git_sha": "6dc79d6", "dirty": false, "generated_at": "2026-10-18T21:30:00Z"},
  "plan": {
    "settings": [{"effective_from": "2026-10-10", "rules": {"...": "section 9"}, "note": "Tricky Terrain local buys"}],
    "stores": [{"key": "pats", "name": "Pat's Games", "short": "Pat's", "kind": "local",
                "cart_url_template": "https://patsgames.com/cart/{items}", "homepage": "https://patsgames.com"}],
    "decks": [{
      "key": "riders-of-rohan", "name": "Riders of Rohan", "status": "active", "sort": 1,
      "product": "Riders of Rohan (LTC)", "commander": ["Éowyn, Shieldmaiden"], "color_identity": "WUR",
      "owner_changes": [{"out": "Field of Ruin", "in": "Mount Doom", "note": "Bryan's change before the plans"}],
      "notes": [{"kind": "open_question", "text": "Where did this Mount Doom come from? It isn't in the precon or any recorded order."}],
      "bracket": {"target": 4, "keep_note": "...", "callouts": [],
                  "bags": {"3": [{"out": "...", "in": "...", "from": "Came in this precon"}], "2": []},
                  "game_changers": {"4": ["..."], "3": ["..."], "2": []}},
      "states": {
        "stock": {"cards": ["Slot"]},
        "now":   {"cards": ["Slot"], "log": [{"swap": "plan|Riders of Rohan|Volcanic Island|Mount Doom", "status": "fill"}]},
        "after": {"cards": ["Slot"], "log": []}
      }
    }],
    "swaps": [
      {"key": "plan|Riders of Rohan|Coppercoat Vanguard|Harsh Mentor", "deck": "riders-of-rohan",
       "stage": "planned", "role": "swap", "parent": null, "src": "print", "src_declared": null, "store_label": null,
       "out": "Harsh Mentor", "in": "Coppercoat Vanguard", "plan_card": "Coppercoat Vanguard",
       "tier": "T1", "sort": 7, "band": null, "game_changer": null, "after_print": false,
       "got": null, "order_item": null, "print_order": "mpc-placed", "listing": null, "later_out": null,
       "group": null, "when": null, "advice": null, "why": "...", "why_out": "...", "note": null, "was": []},
      {"key": "standin|Riders of Rohan|Westfold Rider", "deck": "riders-of-rohan",
       "stage": "planned", "role": "standin", "parent": "plan|Riders of Rohan|Coppercoat Vanguard|Harsh Mentor",
       "src": "buy", "store_label": "Mothership", "out": "Harsh Mentor", "in": "Westfold Rider",
       "later_out": "Fiend Hunter", "order_item": {"order": "mothership-219780", "line": 0}}
    ],
    "aliases": [{"old": "...", "new": "..."}],
    "orders": [{"key": "pats-games-55912", "kind": "real", "status": "received", "vendor": "Pat's Games", "store": "pats",
                "order_number": null, "date_ordered": "2026-10-08", "placed_by": null, "date_fulfilled": null,
                "fulfillment": "in-store pickup", "subtotal": 124.0, "subtotal_note": null,
                "shipping": 0.0, "tax": 10.49, "total": 134.49,
                "evidence": "Receipt kept privately in commander-decks", "issues": ["..."],
                "items": [{"line": 1, "card": "Abstract Paintmage", "qty": 1,
                           "listing": "Abstract Paintmage [SOS - 171] — Near Mint / English / Normal",
                           "set": "sos", "num": "171", "finish": "nonfoil", "scryfall_id": null,
                           "received": {"set": null, "num": null, "note": null}, "arrived": true,
                           "deck": "prismari-artistry", "replaces": "Dance with Calamity",
                           "role": "plan card", "unit_price": 0.5}]}],
    "quotes": [
      {"swap": "jace-ashen-rider", "card": "Ashen Rider", "kind": "market_benchmark", "checked": "2026-10-18",
       "price": 0.51, "printing": "Forgotten Realms Commander (AFC) #175",
       "source": "TCGplayer market via Scryfall, cheapest non-foil"},
      {"swap": "jace-ashen-rider", "card": "Ashen Rider", "kind": "stock_check", "store": "mothership",
       "store_label": "Mothership Books and Games", "checked": "2026-10-18",
       "result": "In stock: 2X2 #173 Near Mint $0.75 (2); 2X2 market $0.53", "in_stock": true,
       "price": 0.75, "price_from_text": false, "set": "2x2", "num": "173", "printing_from_text": true,
       "variant": "42427719221416", "url": null, "source": "Store website"}
    ],
    "reviews": {"<swap key>": {"decision": "want", "note": "", "cut": null, "deck": "...", "card": "...",
                               "at": "2026-10-19T01:00:00Z"}},
    "inbox_resolved": [{"op_id": "...", "outcome": "Recorded as order pats-2026-10-21", "at": "2026-10-21T18:00:00Z"}]
  }
}
```

### 6.4 The placed print order

Today `library.py` labels **every** PRINT row "Print (MakePlayingCards order placed by 2026-10-15 (not arrived))" (library.py:44, 286). That is right only while PRINT rows number exactly the 180 that were ordered, which they do today.

- **Interim.** The exporter makes one `plan_orders` row: `ext_key 'mpc-placed'`, `kind proxy`, `status placed`, `vendor MakePlayingCards`, `placed_by 2026-10-15`, and order number, totals and `card_stock` all NULL, with a note listing what isn't recorded. Every PRINT row links to it, and the exporter **fails** if there aren't exactly 180 PRINT rows, with this message: "Record the placed MakePlayingCards order in data/purchases.json (type proxy) before adding prints; the guides would also show new prints as on the placed order."
  - The failure stops only the export. `build.sh` carries on, so the guides still rebuild.
  - The first approved print proposal is exactly the change that needs the fix in the repo too.
- **Proper fix**, with Bryan's confirmation (question 2): record the order in `purchases.json` as `type: "proxy"`, with its 180 lines from `docs/shopping/mtg-print-order.txt`. Then:
  - `library.py`'s bought list skips `type: proxy` orders;
  - a PRINT row is "on order X" only if X lists it;
  - PRINT rows on no placed order go to the next (draft) order;
  - the exporter drops its 180 check.

### 6.5 Import algorithm (`plan::import::import_doc(pool, owner, body, opts) -> AppResult<ImportReport>`)

**Before the transaction** (reads only, so SQLite's single write lock stays short; live game saves share it, with a 10 s busy timeout):

1. **Parse the envelope.** Return 400 if `format` is unknown.
2. **Check the head.** Compute `content_hash` over the raw `plan` bytes. If it equals `plan_meta.head_hash` and `force` is off, return the head's report with `unchanged: true`.
3. **Parse `plan` into typed structs and validate.** Each failure returns 400 and names the JSON path:
   - deck, swap, order and store keys are unique;
   - every swap's `deck` exists;
   - a `standin` has a `parent` with `src: print` in the same deck and the same `out`;
   - `got` matches one of its three shapes;
   - `order_item` and `print_order` point at orders in the document;
   - cart templates start with `https://` and contain `{items}`;
   - money is null or ≥ 0, and dates are `YYYY-MM-DD`;
   - an existing `source='yama'` deck with the same key is a 409.

   State checks (100 cards including the commander, singleton except basics) are warnings, because the Python build already asserts them.
4. **Resolve cards.**
   - Names go through `cards::resolve_names` (about 450 distinct names, one indexed query each).
   - Printings go by `scryfall_id`, else `(set, num, 'en')`, through a new `pub async fn cards::printing_by_set_number`, extracted from `lookup_printing` (cards/mod.rs:211-226).
   - Unknown names and printings are **kept** with NULL ids and listed. This is unlike `decks::resolve`, which drops them.
5. **Hash each state's canonical cards JSON and each swap's row JSON.**

**One transaction**, every statement binding `owner`:

6. Insert the `plan_imports` row (`via`, `forced`, `document_gz`).
7. **Stores, settings, decks, orders.**
   - Replace `origin='import'` settings rows. If a Yama-made row has the same date, the import replaces it and the report says so.
   - Upsert stores, decks (`source='import'`) and orders with `ON CONFLICT(owner_id, key|ext_key) DO UPDATE`, so ids stay stable. Clear `retired_at`.
8. **Order items.** Upsert by `(order_id, line)` and delete lines beyond the document's count. Swaps' `order_item_id` is `SET NULL` on delete.
9. **Swaps.** Upsert. A row whose `content_hash` is unchanged is not rewritten, so `updated_at` keeps meaning "changed in an import". A second pass sets `parent_id`, `order_item_id` and `print_order_id` by key.
10. **Quotes.** Delete this owner's imported quotes and insert the new ones. Nothing user-made refers to quotes.
11. **States.** Insert a `plan_states` row only when `(deck, state, content_hash)` is new, then move `current`: set the old row to 0 first, then the new row to 1, which the partial unique index requires.
12. **Retire what's gone.** Set `retired_at` on imported stores, orders and swaps not in this document, and `status='archived'` on imported decks not in it. Their lists stay, for lab and deck references.
13. **Aliases.** Upsert into `plan_key_aliases`.
14. **Reviews.** For each document review, insert it if no row exists, and replace the row only if the document's `at` is later (tombstones count). Nothing is deleted.
15. **Inbox outcomes.** Store `inbox_resolved` outcomes on the matching `plan_inputs` rows.
16. **Head.** Update `plan_meta`: head import, hash, git sha, `revision + 1`. Keep `document_gz` only on the newest 10 imports.
17. **Finish.** Commit, or roll back after building the report when `dry_run=1`.

### 6.6 Import report

```
{import_id, unchanged, dry_run, forced, guide_version, git_sha, dirty,
 counts: {decks|swaps|orders|stores: {added, changed, unchanged, retired, restored}, quotes, states_new},
 unknown_cards: [{name, where}], unknown_printings: [...],
 orphan_answers: [{swap_key, deck, card, decision, marks}],
 reviews: {from_document_applied, yama_newer_kept},
 existing_decks: [{id, name, folder}],
 warnings: [...]}
```

- **`orphan_answers`** are answers or ticks whose key matches no live swap, even through an alias.
- **`existing_decks`** lists the caller's Yama decks in folder "commander-decks". These are the stale "Fantastic Four Upgraded 100" and "Riders of Rohan Upgraded 100". They are listed, never touched.
- **`warnings`** cover state checks, Tricky Terrain `src`/`after_print` inferences, and open data problems.

### 6.7 What flows back

`pull.py` (section 3.3) brings back review answers (into `review.json`), installed ticks (`data/planner/installed.json`), and bought marks and ideas (`data/planner/inbox/*.jsonl`, plus a printed list). Agents act under the usual rules:
- a "want" moves a candidate into `swaps.json` with `from_candidate`;
- a bought mark becomes a `purchases.json` order only after Bryan confirms the receipt;
- "no" on a plan swap means asking Bryan.

### 6.8 Self-checks in `export.py`

If any of these fail, `export.py` exits 1 with a message, and `build.sh` prints a warning and carries on:
- each state has 100 cards and is singleton;
- stock matches `decks/compare/*-1-stock.txt` by name;
- keys are unique;
- the key set equals the review site's ids from `scripts/review/server.py` `build_data()` (that module has a main guard);
- every buy row, stand-in and optional extra has an order item;
- the stand-in pairs agree;
- the 180-print interim check (6.4).

`check_project.py` gains two light **warnings**:
- `plan.json`'s guide version differs from `guide-version.json`;
- a `review.json` key that is neither a live key nor an alias.

### 6.9 First import

1. **Locally.** Run Yama with dev login as `bryan@example.com`, then `yama-server import-plan data/planner/plan.json --owner bryan@example.com --dry-run`. Read the report, then do a real import.
2. **On saget.** After Deploy 1 (Bryan's go), he signs in as bryanroscoe@gmail.com, uploads with a dry run, reads the report, and imports. No email lookup and no `docker exec` are involved.

---

## 7. Derived views, and where each is computed

| View | Computed where | From | Rules |
|---|---|---|---|
| Stock, now, after (imported) | Python `library.build()`, in the repo | Stored `plan_states` | Shown as is. Labelled "Now: every swap whose card is in hand. This is the plan, not what's in your deck box." |
| Stock, now, after (Yama-made, slice 7) | `packages/core/src/plan/states.ts` on the device; stored as a snapshot only when needed (lab, "Make this a Yama deck") | Swaps, orders, base version | A port of `library.build()`: buys apply when in hand; prints apply after arrival; otherwise the stand-in if in hand, otherwise the fill card, otherwise the slot waits; optional extras; **moves run last in a single pass in deck order** (library.py:313-336), ready when the giving deck has released the card and the row isn't `after_print`; 100-card and singleton checks are warnings |
| Proposed build | `text.ts` `proposalBuild` | The after list plus proposals not answered "no" | Cut: the user's chosen cut, else the suggested `out` if still in the list, else `later_out`. A port of `server.export_text`. |
| Bracket 3 and 2 lists | `brackets.ts` | The after list plus `bracket.bags` | Applies bag swaps to the after slot list, so basic counts are kept. Warns if a bag's `out` isn't in the list. Shows each card's source and the Game Changer counts the export recorded. |
| Diffs | `text.ts` `deckDiff` | Any two lists | |
| Copy text | `text.ts` `exportText` | A list | Names only, matching `decks/compare/*` (EDHbots). With printings, matching `library.import_text`, basics last (Moxfield). |
| Review list | `views.ts` `reviewItems` | Swaps, quotes, reviews, aliases | Groups: swap in now; when prints arrive; stand-ins; optional extras; proposed. Answers with no live swap get their own section. |
| Buy list | `views.ts` `buyList` | Proposals with `src: buy` not answered "no", plus planned buy rows with no order item; quotes, reviews, marks, market, settings | The cheapest cart-able listing (has `variant` and `price`), grouped by store; replaces = your cut over the suggested one; total = sum of priced rows "before tax at listed prices", plus "N without a price", **never summed as 0** (unlike `buylist.py:56`); cart URL from the store template; sections "Not stocked at your stores" and "Left out (you said no)" |
| Price flags | `rules.ts` `rulesAt(date)`, `priceFlag` | Settings, the quote's date | Compares with the listing's own printing first (Yama's `market_by_printing`, or the printing parsed from the note); otherwise the cheapest non-foil benchmark, saying which one it used. Example: Ashen Rider at Mothership, $0.75 for 2X2 #173, against that printing's $0.53 market is 42% over, so the 25% rule flags it; the cheapest non-foil is $0.51 (AFC #175, 18 Oct 2026). With no market price the flag says "no market price to compare". |
| Print list | `views.ts` `printPlan` | Print swaps, proxy orders, the printer store's `print_tiers`, `cards.layout`/`faces` | Placed orders with their lines (print → what it replaces, or "takes out the stand-in X"). Next order (draft): planned prints on no placed order plus proposed prints answered "want". Tier: the smallest listed tier ≥ n, and free slots. Double-faced backs flagged. Proxy cost from settings, shown apart from market prices. |
| Spares | `views.ts` `spares` | The lists (library model), swaps, `got` | Out now = stock plus owner changes, minus the now list, minus cards moved to another deck. Out when prints arrive = now minus after (stand-ins leaving). Marks: "now used in X", "proposed for Y (not decided)". Follows `library.py`, so it **differs from today's `docs/spares.md`** for Sepulchral Primordial (library keeps it until Karmic Guide moves) and Mount Doom (library takes it out now for an Island). That is a correction; Bryan is told. |
| Overview counts | `views.ts` `overviewCounts` | All of the above | To review, to buy (with "N without a price"), prints on order, waiting to install, spares |
| Pending overlay | `overlay.ts` | Bundle plus outbox | Pages show taps not yet synced |
| Import report, orphans | Rust `import.rs` | | |
| Lab summaries | Rust ingest (section 11) | | |

---

## 8. Web pages

**Navigation.** The Decks tab gets a segmented control at the top: **Decks | Plans**. The Plans pages have a text sub-nav: Overview, Review, Buy, Prints, Spares, Settings.

**Routes** inside `<Shell>`: `decks/plan`, `decks/plan/review`, `decks/plan/buy`, `decks/plan/prints`, `decks/plan/spares`, `decks/plan/settings`, `decks/plan/d/:key`. Filters live in `useSearchParams`, as on the Cards page. Code is in `web/src/plan/` with `plan.css`; logic is in `packages/core/src/plan/`.

**Design rules:**
- Only the tokens and classes in `styles.css` (plus a `.tag.warn` on the existing `--warn` token), so the pending restyle applies.
- Deck headers and overview cards use the commander's Scryfall `image_art_crop` behind a solid, token-coloured overlay, with no decorative gradient. That matches Bryan's "commander art behind each deck" preference.
- Sentence case, no all-caps, and no middle-dot meta strings (the review site's `·` separators are not ported).
- `usd()` everywhere ("no price", never $0), with the date and source beside every price.
- Images load from Scryfall at runtime, and touch targets are at least 44 px.

**`CardSheet`** (Cards.tsx:120) gets a `readOnly` prop that hides +1/+F/+E in plan views. `GROUPS`, `groupOf` and `listText` move from `Decks.tsx` into `packages/core`.

**Source banner** on pages for imported plans, for example: "Planned in commander-decks. Imported 18 Oct 2026, guide v6, commit 6dc79d6. What you do here goes to its inbox: 3 items waiting to be picked up." If the import was dirty, it adds "with uncommitted changes".

| Page | Shows | Actions |
|---|---|---|
| Overview `/decks/plan` | Banner; `.figures` with to review, to buy (listed total plus "N without a price"), prints on order, waiting to install, spares; deck cards on art crops with counts and warnings; "Installed, but no longer in the plan" if any. Friends' empty state: "No plans yet", with "Import a plan file" (and from slice 7, "Start a plan from one of your decks"). | Import sheet: pick a file, read the dry-run report (unknown cards, orphan answers, warnings, existing decks, older-file warning), then Import |
| Deck `/decks/plan/d/:key` | Open questions first. Tabs: **Changes**, **Stock**, **Now**, **After prints**, **Brackets**, and later **Lab**. Changes is grouped into "Swap in now", "When your prints arrive", "Optional extras" and "Proposed, not in the plan". Each row shows out → in thumbnails, tier, a source sentence (a TypeScript port of `swapdata.got_text`, such as "From Lorehold Spirit (came in that precon)" or "Bought at Pat's Games, ordered 8 Oct 2026, $0.50"), status from the log (In hand, Stand-in now, Print on order, Waiting for Lorehold Spirit to free it, Basic land for now), the review answer and the installed tick. List tabs use the Decks grouping, with kind tags and "new since stock" markers. Brackets shows bags, sources and Game Changer counts. | "I've put this in the deck" tick. Copy names (EDHbots), Copy with printings (Moxfield), Copy the proposed build. Make this a Yama deck. Link a Yama deck. Suggest a change (`idea`). |
| Review `/decks/plan/review` | Deck chips with undecided and total counts. Filters: Not decided, Proposed only, Want, Unsure, Don't want, All. Search over reasons, stores and notes. Each item shows images, why and why_out, source, the recorded benchmark ("TCGplayer market via Scryfall: $0.51 for Forgotten Realms Commander (AFC) #175, checked 18 Oct 2026"), Yama's latest market with its date, and stock checks with dates and links, plus advice, when and `later_out`. Section "Answers for swaps no longer in the plan". For imported decks: "Your answers go to your commander-decks inbox. A want joins the plan when the plan is updated there." | Want / Unsure / Don't want (tap again to clear), cut picker over the after list (proposals), note saved on blur. "Saved on this phone, waiting to sync" while pending; "Picked up by commander-decks" after a pull. |
| Buy list `/decks/plan/buy` | "Stock and prices were checked 18 Oct 2026; recheck before going in. A market price isn't a quote from any store." Per store: cards, the total, "N without a price", and a cart button. Rows: card, deck, replaces, listing, listed price (with "from the stock note" when parsed), market with date, decision, flags judged by the rule set in force on the check date. Sections: In the plan, not bought yet; Not stocked at your stores; Left out (you said no). | Mark bought (store, price paid, date), shown as "You marked this bought on 19 Oct 2026 at Pat's for $3.50. It isn't an order until your plan records it." Then "Recorded as order X" once it is. |
| Prints `/decks/plan/prints` | "MakePlayingCards, placed by 15 Oct 2026, not arrived. Order number, cost and card stock not recorded." Lines by deck. Double-faced backs flagged. Next order (draft) with tier and free slots. Proxy cost "at least $0.30 each (your setting)", apart from market prices. | Copy the order (`N Name` lines, A to Z) |
| Spares `/decks/plan/spares` | Out now; out when prints arrive; stand-ins leaving; each with where it came from, "now used in X" and "proposed for Y (not decided)". "Check here before buying or printing." | — |
| Settings `/decks/plan/settings` | Rule sets with "Applies from" dates, stores, keys for scripts (slice 4), import history. Imported rows say "Managed by your commander-decks export". The unofficial notice. | Create and revoke keys (slice 4). Add a dated rule set and edit Yama-made stores (slice 6). Export my planner (slice 6). Clear plan data on this device. |

**Offline.**
- `web/src/plan/store.ts` caches the bundle in IndexedDB under `plan:<user_id>`. It uses the `idb` helpers, which slice 0 moves out of `offline/cards.ts` (they are module-private there) into an exported `offline/idb.ts`.
- The outbox lives in localStorage, keyed per user, following `table/store.ts`.
- Pages render the cached bundle with pending inputs overlaid.
- `useLogout` clears both, because plans contain prices paid.

---

## 9. Per-user settings (Bryan's rules as his defaults)

**Shape.** `plan_settings.rules` is JSON, and every rule is optional. A rule that isn't set produces no flag. The planner flags and never blocks or hides anything. Each row is the complete rule set from its date, so `rulesAt(date)` reads one row.

```json
{"currency": "USD", "market_source": "TCGplayer market via Scryfall",
 "compare_to": "listed_printing_else_cheapest_nonfoil",
 "buy_local_only": true, "max_over_market_pct": 25, "avoid_pricey_printing": true,
 "always_print_over_usd": 10.0, "shiny_only_if_no_plain": true, "budget_substitutes_ok": true,
 "ceiling_key_usd": 4.0, "ceiling_other_usd": 3.0, "ceiling_other_note": "about $2–3",
 "allow_standins": false, "spares_first": true,
 "proxy_cost_usd": 0.30, "proxy_cost_note": "at least $0.30",
 "needs_confirmation": ["never above market (AGENTS.md) vs within about 25% (decisions.md)", "$2–3 vs $3"]}
```

**Bryan's rows**, written to `data/planner/settings.json` from `notes/decisions.md`:

| From | Source | Rules |
|---|---|---|
| **2026-10-08** | "Shopping decisions, 2026-10-08 to 10-09" | Buy local; within 25% of market for that printing and not a pricey printing when a cheap one exists; print over about $10; shiny only if no non-foil version; budget substitutes allowed; stand-ins allowed (the October orders bought 21); proxy cost at least $0.30 (from "User direction") |
| **2026-10-10** | "Tricky Terrain local buys" | Everything in the 10-08 row, plus up to $4 for a card that really matters and about $2–3 for one that adds less; no stand-ins; spares first |

Notes:
- **Dating.** Both 2026-10-08 orders (Hallowed Fountain $6.75, Godless Shrine $8.25) are judged by the 10-08 row, so the later ceilings don't flag them.
- **Not imported as a rule.** The "$1 BUY REAL benchmark" is listed under "Assistant defaults requiring no purchase commitment" in decisions.md, so it is not Bryan's rule. The same goes for "one copy per sleeved deck", which the spares view assumes anyway.
- **Key vs other cards.** The planner doesn't know which cards "really matter", so the ceiling flag says: "Above about $3: fine only if this card really matters (limit $4)."
- **Print tiers.** The printer's tiers live on the MakePlayingCards store (`print_tiers`). decisions.md confirms 162 and 180 are tiers. Other steps are entered from MPC's order page when an agent next checks it, with a note "not checked", because MPC's smaller steps may not be multiples of 18.
- **New users** start with `{"currency": "USD"}`. Settings offers "Start from the house rules", which copies Bryan's current rule set without his stores, for them to edit.
- **Privacy.** Stores, quotes and prices paid are always owner-only.

---

## 10. Sharing

- **Owner-only from day one.** Every table has `owner_id` and every query binds the caller. Composite foreign keys refuse cross-owner links where links cascade. Anyone else's id gets 404. Deck links are checked with `owned_deck`, and lab lists must be the caller's.
- **No admin read path** for plans: they hold prices paid. Admin-only means lab approval only.
- **Script keys** belong to one account, are scoped to `plan:sync`, are refused by `CurrentUser`, are stored hashed, can be revoked, and show their last use.
- **Later (slice 10).** A migration adds `plan_decks.visibility` (`private` | `playgroup`) and `playgroup_id`, checked with `playgroups::is_member`. A shared view shows decks, lists, swaps and reasons only. It never shows orders, prices paid, stores, quotes, settings, marks or inputs.
- **Fixed early.** `games.rs:166-180` stores any `deck_version_id` a client sends. Slice 0 adds the check: the version's deck must belong to the game's creator or the seat's account, otherwise 404. That has to land before "Make this a Yama deck" can create versions that end up in "Log a game".

---

## 11. Lab on saget

This section covers the planner side only. The runner belongs to the lab thread (`~/Developer/yama-lab`), and this design follows its contract as it stands today.

- **Runner contract** (`play/src/bin/lab.rs`, `deploy/lab.sh`):
  - **Inputs.** `--decks-root <dir>` holds deck `.txt` files ("Commander" and "Deck" sections, names only). `--schedule <file.jsonl>` has one line per game: `{game, seed, decks: [2–6 ids = paths under the root without .txt], difficulty, max_turns, max_actions, max_seconds}`.
  - **Output.** `--out results-saget.jsonl`, one line per game: `{game, seed, difficulty, decks, first_seat, winner, placements, eliminations, end: win|draw|turn_cap|action_cap|time_cap|panic|error, turns, actions, ms, final_life, engine, card_data, runner, error}`.
  - **Resuming.** `--skip-done` skips games already written.
  - **Image and container.** Separate image `yama-lab:<rev>`, built on saget. `docker run --cpus N --cpu-shares 256 --memory 10g --user 99:100 --read-only --cap-drop ALL --network none`, with the engine card data mounted read-only.
- **A job is a snapshot.** `POST /api/lab/jobs` takes:
  - lists: `plan_states` ids (default stock, now and after of one deck) or `deck_versions` ids;
  - opponents: the user's own other plan decks' stock lists in v1, with a global precon field once an admin-only catalog exists;
  - games per list (default 300; non-admins capped at 2,000 per job, one active job each);
  - difficulty (default Medium).

  Lists with unresolved names, or names the engine card data doesn't know, are refused with the list of names. The job starts as `requested`.
- **Approval.** Bryan approves in the Lab section. That is the only admin route. On approval the server writes `${YAMA_DATA_DIR}/lab/jobs/<id>/decks/<label>.txt` and `.../schedule.jsonl` (paired seeds, seat rotation). This is the only planner write outside SQLite, and it lands in Yama's own data directory as user 99:100.
- **Running.** The lab thread adds `deploy/lab.sh start-job <id> <threads>`. It mounts `/mnt/user/appdata/yama/data/lab/jobs/<id>` read-only as decks and schedule, and `.../<id>/out` read-write for results. Bryan or an agent he asks runs it from the Mac.
  - `lab.sh` records that Bryan approved lab runs on saget on 2026-10-18. The approval click in Yama is the go for each job.
  - A long-running worker container that polls for approved jobs needs its own go.
  - The web app never gets the Docker socket, and the runner never opens SQLite.
- **Ingest.** While a job runs, the server reads `out/results-saget.jsonl` every minute and on page load. It tolerates a partial last line and inserts with `ON CONFLICT(job_id, game) DO NOTHING`, so ingest is idempotent and resumable. It computes win rates with Wilson intervals per list and pod size, and marks the job `done` when the result count equals the schedule.
- **Proposed tables** (number set at merge; adopt the lab thread's tables if they land first):
  - `lab_jobs(id, owner_id, plan_deck_id, status requested|approved|running|done|failed|cancelled, spec JSON, games_requested, engine, card_data, requested_at, approved_at, approved_by, started_at, finished_at, summary JSON, error)`;
  - `lab_job_lists(job_id, label, owner_id, plan_state_id, deck_version_id, content_hash, deck_file)`;
  - `lab_games(job_id, game, owner_id, line JSON, end, winner, turns, PRIMARY KEY (job_id, game))`.
- **Labels.** Every number on a page shows engine ("phase-rs v0.113.0"), card data hash, runner commit, games, AI level, date, and the list's content hash with the guide version it came from. Lab numbers sit on the owner's Deck page only and never mix with real games. Real games come through linked Yama decks.

---

## 12. Build slices, in order

Yama work is on branch `planner` in `~/Developer/yama-planner`. Before each Yama commit: `cargo test`, `npm test`, `npm run typecheck`, with `CARGO_BUILD_JOBS=4`. commander-decks work is on its own branch and runs `python3 scripts/check_project.py` before committing. In that repo, edits to shared files (`build.sh`, `check_project.py`, `AGENTS.md`, `README.md`, `notes/*`, `server.py`) are small and targeted, and another thread's changes are never committed. Every deploy needs Bryan's go (`deploy.sh` backs up the database; migrations apply at start).

### Slice 0: groundwork (Yama), 1 day
- **Files:**
  - `server/Cargo.toml`: dev-dependency `tower` with `util`; `serde_json` feature `raw_value`.
  - New `server/src/testutil.rs` (`#[cfg(test)]`): an `AppState` from `db::test_pool()` with `PlayHub::start(None, pool)`.
  - `auth.rs`: `require_admin` becomes `pub(crate)`.
  - `cards/mod.rs`: `pub async fn printing_by_set_number`.
  - `games.rs`: the seat version ownership check.
  - New `web/src/offline/idb.ts`, with `offline/cards.ts` importing from it.
  - New `docs/plan-format.md`.
- **Tests:** a foreign `deck_version_id` on a seat gets 404; a router `oneshot` test gets 401 when signed out; the printing lookup by set and number.

### Slice 1: storage, import, bundle (Yama server), 2 days
- **Files:**
  - `server/migrations/0006_planner.sql`.
  - `server/src/plan/{mod.rs, model.rs, import.rs, bundle.rs}`.
  - `routes.rs` merge; `main.rs` `mod plan;` and the `import-plan` CLI arm.
  - `ARCHITECTURE.md` §9 and README, which are the plan of record.
- **Tests:**
  - The import creates rows under the owner.
  - The same content gives `unchanged`, with no writes and no revision bump.
  - A changed `meta` alone gives `unchanged`.
  - A changed document updates rows in place, keeping ids for the same keys.
  - An older document after a newer one applies, not "unchanged".
  - A removed swap is retired, and restored when it returns.
  - A new list makes a new row and moves `current`; the old row survives.
  - A missing deck is archived.
  - Reviews merge newest-wins, a tombstone beats an older document answer, and an alias carries an answer to a renamed key.
  - A renamed swap without an alias shows up as an orphan.
  - Unknown names and printings are kept and reported.
  - Validation 400s: bad format, unknown deck, stand-in without a print parent, malformed `got`, `http://` or `{items}`-less template, negative money.
  - A body over 8 MB gets 413; a key clash with a `yama` deck gets 409.
  - Dry run commits nothing.
  - **Isolation:** two users import the same document; user B's bundle is empty; B gets 404 on A's keys.
  - **Prices:** NULL `unit_price`, `tax`, `total` and quote `price` come back as `null`; with no snapshot the market is `null` with no date; nothing writes `price_snapshots`.

### Slice 2: exporter (commander-decks, in parallel with slice 1), 1½ days
- **Files:**
  - New `scripts/planner/export.py` and `scripts/planner/test_export.py`.
  - New `data/planner/stores.json` and `data/planner/settings.json`.
  - One non-fatal line in `scripts/shopping/build.sh`, after `version.py`.
  - `scripts/check_project.py` warnings.
  - `.gitignore`: `data/planner/plan.json`, `data/planner/.pull.lock`.
  - AGENTS.md: a short "Yama planner" section.
  - README "Latest", `notes/todo.md`.
  - `docs/deck-lab-plan.md`: publishing is per user, not "admin only"; the export is non-fatal.
- **Tests:**
  - Two exports give byte-identical `plan` bytes.
  - Keys equal the review site's ids; stock equals `decks/compare/*-1-stock.txt`; 100-card and singleton checks.
  - Tricky Terrain `band` comes from `tricky-terrain.json`; stand-in pairs agree.
  - A price is parsed from a stock note (Settle the Wreckage); `review.json` local times become UTC.
  - The 180-print check.
- **Done when:** `plan.json` builds at guide v6, imports locally into `bryan@example.com` with no errors, and unknown names are listed.

### Slice 3: read-only web (Yama), 2 days
- **Files:**
  - `web/src/plan/{PlanLayout,Overview,DeckPlan,ImportSheet}.tsx`, `web/src/plan/{api,store}.ts`, `plan.css`.
  - `App.tsx` routes; `pages/Decks.tsx` segmented control; `pages/Cards.tsx` `readOnly`.
  - `packages/core/src/plan/{types,text,source,brackets}.ts`, with `GROUPS`, `groupOf` and `listText` moved into core.
  - Server: `PATCH /api/plan/decks/{key}`, `POST /api/plan/decks/{key}/yama-deck`.
- **Tests:**
  - vitest on a synthetic fixture (Bryan's data stays out of the Yama repo): `exportText` names-only and printings formats; `deckDiff`; `got` sentences; bracket bags keep basic counts and warn on a missing `out`.
  - Server: yama-deck with unresolved names gets 400 with the list; the new deck belongs to the caller; linking another user's deck gets 404.
- **Done when:** Bryan's 8 decks render at phone width.

### Deploy 1 (Bryan's go), ½ day
He imports from the Mac browser and checks the result on his phone. The plan is visible only on his account.

### Slice 4: inputs, review and the sync loop, 2½ days
- **Yama files:**
  - `server/src/plan/{inputs,tokens}.rs`: `SyncUser`; the inputs, inbox, ack and token routes; the import route switches to `SyncUser`.
  - `auth.rs` `delete_invite` also revokes keys.
  - `web/src/plan/Review.tsx`; the outbox and IndexedDB cache in `store.ts`; a Settings keys panel.
  - `packages/core/src/plan/{overlay,views}.ts` (`reviewItems`).
- **commander-decks files:**
  - New `scripts/planner/{publish,pull}.py` and their tests.
  - New `data/planner/inbox/`, `inbox-resolutions.json`, `installed.json`.
  - `scripts/review/server.py`: `/api/decide` returns 409 "Answer in Yama: yama.saget.org/decks/plan/review" behind a `--read-only` default, and the page shows a banner. Export text still works.
  - AGENTS.md rules (section 14 lists them).
- **Tests:**
  - A duplicate `op_id` returns `duplicate`.
  - A malformed op is `rejected` while the rest apply, and a retried rejected op returns the same rejection.
  - Full-record reviews; a clear writes a tombstone; installed toggles.
  - A permutation test: every order of {op, older document answer, newer document answer} ends in the same row.
  - A future `at` is clamped.
  - `seq` comes from a global sequence; the inbox returns only `for_export` ops after the cursor; ack moves the cursor.
  - **Keys:** a key works on `SyncUser` routes; it gets 401 on `CurrentUser` routes, including a WebSocket `?token=`; revoked and expired keys fail; listing never returns the key; revoking the invite revokes keys; `user add` doesn't touch keys.
  - `pull.py`: last-writer-wins with UTC conversion; never deletes except a newer tombstone; re-pulling writes nothing; refuses while port 8765 accepts answers; the lock file stops a second run.
  - `publish.py`: refuses dirty inputs, ignores `data/sim/`, refuses when Yama's head isn't an ancestor.
  - Answers survive airplane mode and sync once.

### Deploy 2 (Bryan's go), ½ day
He creates a key and saves it in the Keychain or 1Password. A want in Yama reaches `review.json`, an agent moves it through `candidates.json` to `swaps.json` with `from_candidate`, and the next import shows it planned with the answer attached.

### Slice 5: buy list, prints, spares, ticks and marks, 2 days
- **Files:** `packages/core/src/plan/{views,rules}.ts` (`buyList`, `printPlan`, `spares`, `overviewCounts`, `rulesAt`, `priceFlag`); `web/src/plan/{Buy,Prints,Spares}.tsx`; the installed tick and Mark bought UI.
- **Tests:**
  - `buyList` drops "no" answers, prefers the user's cut, picks the cheapest cart-able listing, builds cart URLs, and counts missing prices separately.
  - `priceFlag` picks the rule set by date: the 10-08 buys aren't judged by the 10-10 ceilings. No market means no flag. Ashen Rider is flagged at 42% against its printing.
  - `printPlan`: placed vs draft, tier choice from a list, double-faced backs.
  - `spares`: a release-gated move keeps the card in now (Sepulchral Primordial); a fill takes it out now (Mount Doom); stand-ins become spares after prints; reassigned and proposed-for marks.
  - A local-only vitest file reads `../commander-decks/data/planner/plan.json` when present (skipped otherwise) and compares `printPlan` with `docs/shopping/mtg-print-order.txt` (180 cards) and `buyList` with `docs/buy-list.md`. The deliberate differences are listed: no $0 totals, over-market flags, spares from the library model.

### Deploy 3 (Bryan's go), ½ day
The `~/Downloads` guides are no longer needed day to day. They keep being built until Bryan stops using them.

### Slice 6: settings, stores and export for every user, 1 day
- **Work:** `GET|PUT /api/plan/settings`, the stores routes, `GET /api/plan/export`, and the "Start from the house rules" template.
- **Tests:** imported rows get 409 on edit; export → import into a second account round-trips.

### Slice 7: friends' Yama-made plans, 3 days
- **Work:**
  - `POST /api/plan/decks` from a Yama deck.
  - The op kinds `swap.put`, `swap.retire`, `swap.promote` (needs a want, a cut, and an order item, a print or a valid `got`), `order.put`, `quote.add`.
  - `states.ts` (6.2 rules, single-pass moves); a snapshot endpoint after `decks::validate`; a parity panel.
- **Tests:**
  - Fixtures for every log status, plus the 100-card and singleton warnings.
  - Edit ops on an imported deck are rejected.
  - A second test account builds a plan from a pasted deck and gets review, buy, prints and spares with no import.
  - A local-only vitest runs `states.ts` on Bryan's exported swaps and compares it with Python's lists.

### Slice 8: lab hookup (planner side), 1 day plus the lab thread's work
Starts after the lab branch merges. Covers the lab migration, request, approve (writing the job directory), ingest, and the Lab tab.
- **Tests:** re-ingesting is idempotent; a partial last line is tolerated; a foreign list gets 404; a non-admin approval gets 403.

### Slice 9: collection-aware, 2 days
- **Work:**
  - A Mythic Tools snapshot import mode per container. It replaces each container's contents by diff instead of adding: today the op ids are `mythic:<file hash>:<row>` (collection.rs:778), so a newer full export double-counts.
  - A scan check per import against `plan_order_items`, ported from `scancheck.py`.
  - Spares and a ledger view using the collection.
- **Done when:** the 2026-10-18 export imports without doubling, and the scan check matches `data/collection/scan-check-2026-10-18.md`.

### Slice 10: read-only sharing with a playgroup, 1 day
- **Tests:** a member sees decks and reasons, never prices paid, stores or quotes.

### Totals
- Read-only planner deployed: about 5½ days.
- Review loop closed: about 8½ days.
- Full day-to-day replacement: about 11 days.
- Friends' own plans: about 15 days.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Two places to answer during the transition | Last writer wins on both sides; the review site becomes read-only at Deploy 2, as deck-lab-plan already planned. The Mac-side "clear" gap closes then too. |
| Name-derived keys orphan answers when agents rename rows | `was` and `from_candidate` aliases, an orphan section in the UI and the report, and a `check_project` warning. Stable ids in swaps.json stay an option. |
| A stale worktree or a dirty checkout publishes | `publish.py` checks ancestry against Yama's head, refuses uncommitted exporter inputs, and records `dirty` and `forced` in the banner. |
| An exporter bug blocks the mandated guide rebuild | The `build.sh` line is non-fatal; self-checks fail only the export. |
| Yama's views differ from the Python guides while both exist | Local comparisons on real data in slice 5. The deliberate differences are listed: no $0 totals, flags, spares from the library model (Sepulchral Primordial, Mount Doom). Bryan is told rather than the differences hidden. |
| Python and TypeScript engines drift (slice 7) | Imported plans always show Python's lists; a parity test and panel run on Bryan's real data. |
| The placed MPC order is linked by assumption | The interim 180 check fails the export the moment it's wrong; the proper record waits on question 2. |
| A leaked script key | Its own table, scope `plan:sync`, refused by `CurrentUser` and WebSockets, never admin, stored hashed, revocable, last use shown, kept in the Keychain or 1Password. |
| Plan data on a phone includes prices paid | Cleared on logout; "Clear plan data on this device". |
| SQLite's single writer | Parsing, name resolution and hashing happen before the transaction, so the import holds the write lock briefly. |
| Device clock skew affects last-writer-wins | Whole seconds; future times clamped. |
| Migration number clash with the lab branch | Renumber before merging, never after a deploy. The lab tables are a separate, later migration. |
| Cloudflare Access is turned on later | Scripts would also need an Access service token (header pair). Note it in `deploy/README.md`. |
| Cards not yet in Scryfall (Star Trek) | Kept as name-only rows; they block "Make this a Yama deck" and lab jobs, not views. |
| Mythic re-import double counting | Slice 9 lands before any collection-aware ownership is trusted. |
| Concurrent agent threads in both repos | Separate branches, targeted edits to shared files, `git status` before committing, never committing another thread's work. The only committed sync files change on real events (inbox pulls, resolutions, installed ticks). |
| saget actions | Every deploy and any new container needs Bryan's go. Lab runs follow his 2026-10-18 approval, with a per-job admin click. |

---

## 14. Open questions for Bryan

1. **Price rule.** Is it "never above market" (AGENTS.md) or "within about 25% of market for that printing" (decisions.md, and how Ashen Rider was judged)? And for cards that add less, is the ceiling about $2–3 or $3?
2. **The MakePlayingCards order.** Was it exactly `docs/shopping/mtg-print-order.txt` as it stands (180 cards)? If yes, an agent records it in `purchases.json` as a proxy order, with the order number, cost and card stock (S30 or S33) if you have them. Until then, approving a new print stops the planner export, and the guides would wrongly show that print as already on order.
3. **Publishing.** Should agents publish to Yama after every rebuild that changes the guide version, the way they copy guides to `~/Downloads`, or only when you ask?
4. **Lab.** May friends request lab runs (each one approved by you), or only you for now?

The AGENTS.md text proposed for commander-decks (slice 4), for Bryan to approve with that change:
- "Run `python3 scripts/planner/pull.py` before reading review.json or planning installs, buys or prints."
- "Publish with `scripts/planner/publish.py` [per question 3]; report the import result and Yama's revision with the guide version."
- "When you act on an inbox item, add its outcome to `data/planner/inbox-resolutions.json`. A bought mark becomes an order only after Bryan confirms the receipt."
- "When promoting a candidate, add `from_candidate: <id>` to the new swap row. When changing a row's inn or out, add its old key to `was`."
- "Install ticks live in Yama; `data/planner/installed.json` is a pulled copy, so don't edit it."

---

## 15. Corrections to the three drafts (each checked against the code)

1. **Rule dates.** decisions.md heads the shopping rules "2026-10-08 to 10-09", and both early orders in `purchases.json` are dated 2026-10-08, so the set starts 2026-10-08, not 10-09. The $1 benchmark sits under "Assistant defaults requiring no purchase commitment", so it isn't imported as Bryan's rule.
2. **Tricky Terrain.** `swapdata.tricky_rows()` (swapdata.py:51-70) drops `band` and turns an unbought `buy` into `PRINT`. Band now comes from `tricky-terrain.json`, and the conversion is recorded and warned about.
3. **compare_lists.py** has no main guard: it runs `L.build()` and writes files at import (lines 35-50). The exporter doesn't import it.
4. **`decks::validate`** is already `pub` (decks.rs:501).
5. **Example data.** The swap key is `plan|Riders of Rohan|Coppercoat Vanguard|Harsh Mentor`, and Westfold Rider is `standin|Riders of Rohan|Westfold Rider`. Éowyn's color identity is RUW (`card-info-2026-10-18.json`), written `WUR`.
6. **Ashen Rider.** The cheapest non-foil benchmark is $0.51 (AFC #175, 2026-10-18). $0.53 is the 2X2 printing's market from Mothership's note. 42% is against that printing, which is the rule's basis; against the cheapest it would be 47%.
7. **IndexedDB helpers.** `idb`, `idbGet` and `idbPut` are private in `web/src/offline/cards.ts` (lines 18-36). Slice 0 extracts them.
8. **Hash and metadata.** `generated_at` and `git_sha` inside the hashed body made every export "new". The hash now covers only the `plan` value's raw bytes.
9. **Cleared answers came back.** A cleared review was resurrected by "insert when absent". Clears are now tombstones, and records are last-writer-wins full records.
10. **Idempotency against history.** "Ever imported" idempotency hid an older re-upload (Designs 1 and 2), and deterministic bytes made it worse (Design 3). The server now compares with the head only.
11. **Session-row script keys.** `CurrentUser` accepts Bearer and WebSocket `?token=` session tokens (auth.rs:50-73), and `user add`/`remove-password` delete sessions (auth.rs:245, 256). Keys now get their own table and `SyncUser`.
12. **Every PRINT row on the placed order.** `library.py` does the same (lines 44, 286). There is now an interim check with a fix path, and the proper proxy-order record is question 2.
13. **The `games.rs` gap** (lines 166-180) is fixed in slice 0, not left alone.
14. **Per-owner `seq` as max+1** could collide. It is now a global `AUTOINCREMENT`.
15. **Replacing the review site at Deploy 2 before `pull.py` existed.** Keys, the inbox, `publish.py` and `pull.py` now ship in slice 4, before Deploy 2.
16. **`build.sh` runs `set -e`.** The export line is non-fatal.
17. **`subtotal_note` was lost.** It now has a column, so a cart sum isn't shown as a receipt figure.
18. **Stock-check prices inside the note text** are parsed as `buylist.listing_price` does and labelled.
19. **`buylist.py:56` sums a missing price as 0.** Yama computes its own buy list and doesn't ship the generator's view (Design 3's `plan_views` is not adopted).
20. **`brackets.builds()` returns name sets** from `precons.json`. Only bags are exported, and the bracket lists are derived from the after slot list.
21. **The generators (`build.py`, `buylist.py`, `spares.py`, ...) write files when imported.** The exporter uses only `library`, `swapdata` and `brackets` plus JSON.
22. **The lab contract follows `lab.rs` and `lab.sh`:** a separate `yama-lab` image, the `appdata/yama-lab` layout, `--memory 10g`, deck `.txt` files plus `schedule.jsonl`, and the `end` values listed above. There is no `yama-server lab-worker` subcommand, which would have needed `main.rs` restructured because it connects to the database before dispatching (main.rs:47).
23. **Composite foreign keys with `SET NULL`** would null `owner_id` in SQLite. Composite keys are used only on cascading links.
24. **`library.py` resolves moves in a single pass in deck order** (lines 313-336), not a fixpoint. `states.ts` ports that.
25. **Design 2 problems avoided:**
    - `out_name` is nullable for proposals, so `rohan-flyers-aetherize` imports.
    - Bought marks never change lists or create orders.
    - Answers are keyed by text, not a non-cascading foreign key.
    - Stock comes from the repo's lists, not a second catalog.
    - No user lookup by email.
26. **Auto-created Yama decks** (Designs 2 and 3) would put an uninstalled list in the slot that play reads. Here a deck is made only on an explicit tap.
27. **Committed sync-state churn** (Design 3's `bundle.meta.json` and others). `plan.json` and the lock are gitignored, and there is no meta file. Committed files change only on real events.
28. **The dirty guard** would have been blocked by unrelated untracked files. It now checks an explicit input list.
29. **`deck-lab-plan.md` says publishing is "admin only".** Slice 2 updates it to per-user.
30. **`yama-lab` is not clean.** Another thread's runner work is in progress there, so migration numbers and lab tables are settled with that thread at merge time.
