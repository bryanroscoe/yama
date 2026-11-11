# Developing Yama locally

The [README](../README.md#run-it-locally) has the short path from a clone to a running app. This
page has the rest: the server's other commands, signing in, working with a copy of real data,
and the checks that `cargo test` leaves out.

Running Yama needs the permission described in [LICENSE](../LICENSE).

## What you need

- Rust, stable, 2024 edition. CI uses 1.98.1, and `scripts/local-ci.sh` insists on it.
- Node 22 or newer.
- The engine beside this repository, at the pinned commit. `play/Cargo.toml` depends on
  `../yama-phase` by path, and a local build checks that the checkout is clean and its HEAD
  equals `deploy/phase-rev` before it stamps that identity into the binary:

  ```sh
  git clone https://github.com/bryanroscoe/yama-phase.git ../yama-phase
  git -C ../yama-phase checkout "$(cat deploy/phase-rev)"
  ```

- Disk. A debug build of the workspace is several gigabytes, most of it the engine. The
  workspace keeps debug information low and incremental builds off to hold that down
  (`Cargo.toml`).

## Start from an empty database

```sh
cp .env.example .env                         # set YAMA_ADMIN_EMAILS to your email; keep YAMA_DEV_LOGIN=1
cargo build -p yama-server
./target/debug/yama-server import-cards      # about 2 minutes: Scryfall bulk data and rulings (~110 MB, deleted after)
./target/debug/yama-server serve             # API on http://127.0.0.1:8787

npm install
npm run dev                                  # web app on http://localhost:5173, proxying /api
```

[`.env.example`](../.env.example) lists the common settings with their defaults; the rest are
read in `server/src/config.rs`.

To serve the built web app from the Rust server (one process, as in production): `npm run build`,
then `YAMA_WEB_DIST=web/dist ./target/debug/yama-server serve`.

## Signing in

Google sign-in only works on origins added to the OAuth client, so locally use one of these:

- **Development login** (`YAMA_DEV_LOGIN=1`): any email, no password. Handy for playing as
  several people in different browsers. It only works while the server listens on localhost
  (`YAMA_BIND` 127.0.0.1); on any other address it's ignored.
- **Password accounts:** `./target/debug/yama-server user add debug@example.com --admin` prints a
  generated password (or pipe one in with `--password-stdin`). The sign-in page then offers
  "Sign in with a password". These skip the invite list and work on any server. `user list`
  shows every account; `user remove-password EMAIL` turns one off and signs it out;
  `user disable EMAIL` and `user enable EMAIL` turn a whole account off and on. No route in the
  app makes a password account, and `YAMA_PASSWORD_LOGIN=0` turns password sign-in off.
- **Google:** create an OAuth client ID (type "Web application") in Google Cloud Console, add
  your origin (for example `http://localhost:5173`) to its authorized JavaScript origins, and set
  `YAMA_GOOGLE_CLIENT_IDS`. A native Android app asks Google for ID tokens for this same web
  client ID; its own Android OAuth client only identifies the app ([mobile.md](mobile.md)).

## Server commands

`yama-server` is one binary. With no arguments, or `serve`, it runs the server. The rest are
one-off commands against the same database:

```sh
./target/debug/yama-server import-decks ../commander-decks/decks --owner you@example.com [--update]
                                        # --update: a file named like a deck becomes its new version
./target/debug/yama-server import-mythic export.csv --owner you@example.com --dry-run   # [--remove-missing]
./target/debug/yama-server collection add-deck --owner you@example.com --deck "Riders of Rohan" --dry-run
./target/debug/yama-server deck rename --owner you@example.com --deck "riders of rohan" --to "Rohan"   # or: deck archive
./target/debug/yama-server import-calendar  # upcoming sets and Commander precon lists, once (daily with YAMA_AUTO_IMPORT=1)
./target/debug/yama-server import-plan ../commander-decks/data/planner/yama-plan.json --owner you@example.com --dry-run
                                        # prints the import report; drop --dry-run to import
./target/debug/yama-server invite friend@gmail.com
./target/debug/yama-server import-precons ../commander-decks/data/sim/decks/index.json   # precon catalog
./target/debug/yama-server import-deck-prices  # sealed market prices; cached for 24 hours
./target/debug/yama-server import-lab ../commander-decks/data/sim/runs/pilot-2/summary.json  # a global rating run
```

`commander-decks` is a separate, private repository of deck lists and scripts; the paths above
show the shapes these commands read. Other commands (`import-dataset`, `commander-evidence`,
`publish-precons`, `prices`, `backup`) are described where they are used:
[datasets.md](datasets.md), [public-precons.md](public-precons.md) and
[deploy/README.md](../deploy/README.md). `server/src/main.rs` lists them all.

## Online play and the Lab

Both need the engine's card data in `data/engine/`. The file is an export from Yama's pinned
parser, it must match `deploy/phase-rev`, and it is not published for download.
[engine-integration.md](engine-integration.md) describes how to build
`card-data-cbd552b41f962f5b.json` from the archived inputs; `deploy/engine-data.json` records the
expected SHA-256.

```sh
mkdir -p data/engine                    # put the card data file here
cargo run -p yama-play --bin soak -- data/engine/card-data-cbd552b41f962f5b.json 8 7 Easy path/to/decks
                                        # an all-AI game; checks replay determinism
```

`soak` takes the card data, a turn limit, a seed or range, a difficulty and a folder of deck
lists. With no folder it reads `../commander-decks/decks`, a private repository of Bryan's decks,
so pass your own.

Forge as a second Lab engine and Ask Claude are optional sidecars. Their settings are in
`.env.example`; [forge-worker/README.md](../forge-worker/README.md) and
[deploy/README.md](../deploy/README.md) explain how to run them.

## With a copy of production's data (maintainers)

This needs SSH access to the production host, whose address lives in
`~/.config/yama/deploy.env` and never in a tracked file.

`npm run local` copies the newest production backup to `data/yama.db` (only when it's missing;
`-- --refresh` copies again), builds the server and starts it and the web app with every
background job off and `YAMA_OFFLINE=1` (nothing a request would fetch from outside: previews,
store checks, Ask Claude, research, MTGJSON lists, the scanner's files), then prints how to sign
in. `npm run local -- --shots` also takes screenshots of every page once it's up, and
`--dry-run` prints the plan. It works from any worktree. See
[.claude/skills/yama-local/SKILL.md](../.claude/skills/yama-local/SKILL.md).

`./deploy/pull-db.sh` does only the copy: stop the local server, run it, and it puts the newest
backup at `data/yama.db`, keeping your old local database beside it. It only reads from the host
unless you pass `--fresh`, which writes a new backup there first. Then sign in as yourself with
the development login, or give your account a password with `user add`.

**The copy holds real people's data.** Keep it out of git, pull requests and uploads, and delete
`data/yama*.db` when you're done.

`npm run polish -- shoot --as you@example.com` takes screenshots of every page at three sizes,
with layout and copy checks ([polish.md](polish.md)).

## Checks

```sh
cargo test            # server and play
npm test              # TypeScript unit tests: packages/core, web, relay
npm run typecheck     # packages/core and web
npm run build         # production web build
```

`scripts/local-ci.sh --no-amend` runs everything CI runs on the current commit; without
`--no-amend` it records a passing run on the commit so pull-request CI can skip the same tree
([ci.md](ci.md)). On a machine with little memory, set `CARGO_BUILD_JOBS=1`.

`cargo test` includes the per-card tests (`play/src/card_tests/`): a smoke test for every card in
Bryan's decks, and specific tests for the commanders, the cards the decks are built around and
the cards Phase only partly implements or parses with warnings. What Phase supports for each
card, and the engine bugs the tests found, are in [card-coverage.md](card-coverage.md).
Regenerate it, and the tests' card fixture, with:

```sh
cargo run -p yama-play --bin coverage -- data/engine/card-data-cbd552b41f962f5b.json ../commander-decks \
    --fixture play/tests/fixtures/deck-cards.json --smoke play/src/card_tests/smoke_cards.rs
```

### Full-game checks

`cargo test` skips full-game tests by default. These run them, in release, on the games people
play ([play-performance.md](play-performance.md)):

```sh
cargo build --release -p yama-play --bins
./target/release/soak data/engine/card-data-cbd552b41f962f5b.json 80 1-20   # 20 full games, loop detection as online
./target/release/playbench data/engine/card-data-cbd552b41f962f5b.json --games 2   # AI, engine and view times
YAMA_ENGINE_CARD_DATA=data/engine/card-data-cbd552b41f962f5b.json \
  cargo test --release -p yama-play --test integration -- --ignored determinism::          # same games twice, and resumed
YAMA_ENGINE_CARD_DATA=data/engine/card-data-cbd552b41f962f5b.json \
  CARGO_BUILD_JOBS=1 cargo test -p yama-play --test integration lab_regressions_candidate:: -- --ignored --nocapture --test-threads=1 # unchanged seeded inputs on the candidate runtime
YAMA_ENGINE_CARD_DATA=data/engine/card-data-cbd552b41f962f5b.json \
  cargo test --release -p yama-server play::bench -- --ignored --nocapture   # a person's move, act to views sent
```

The determinism checks fail on an AI stop or missing card data. The candidate regression suite
requires normal error-free completion of the unchanged seeded scenarios. Historical fixtures and
their winner/turn/action control remain separate and immutable; the old schema must run with its
matching historical runtime. See [gameplay validation](gameplay-validation.md). A healthy
isolated worker is evidence of server reliability; it does not establish rules or AI correctness.

## Working on the repository

Changes land through pull requests into `main`, and a green `main` deploys itself
([deploy/RELEASING.md](../deploy/RELEASING.md)). The rules the coding agents follow, including
worktrees, reviews and release trains, are in [AGENTS.md](../AGENTS.md).
