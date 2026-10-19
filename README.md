# Yama

Yet Another Magic App: a private Magic: The Gathering app for Bryan's playgroup. It has a life counter for game night, card search, a collection (with Mythic Tools import), decks that know what you own, and playgroup stats. Online play against friends and AI is the next big piece; see [ARCHITECTURE.md](ARCHITECTURE.md).

Unofficial fan software. Not affiliated with, endorsed by, or sponsored by Wizards of the Coast. Card data and images come from [Scryfall](https://scryfall.com); images load from Scryfall at runtime and are never stored or re-hosted here.

## What works today

| Area | Status |
|---|---|
| Sign-in | Google ID tokens with an invite list; email-only dev login for local use |
| Card data | Scryfall bulk import: ~36.5k cards, ~116k printings, daily prices kept by date |
| Card search | Subset of Scryfall syntax (`t:` `o:` `c:` `id<=` `mv` `pow` `f:` `kw:` `is:commander`, `-`, `or`, parentheses). Works offline from a 5 MB card bundle kept on the device |
| Collection | Binders, boxes, decks and lists; add from card search; move, condition, proxy; idempotent offline ops; Mythic Tools CSV import and export |
| Decks | Paste any common list format; edit as text with versions; Commander validation; owned/needed with cheapest market price; sample hands with mulligans |
| Life counter | 1–6 players, rotated panels, commander damage and tax, poison and counters, monarch, initiative, day/night, undo, works offline and syncs later |
| Shared table | Every phone joins the game by QR code; the host phone stays in charge and works offline |
| Playgroups | Join codes, guests without accounts, game history, logging games played without Yama, win rates by player and commander |
| Install | Installable web app (home screen, offline shell); Capacitor config for native apps (docs/mobile.md) |
| Prices | Daily Scryfall snapshots kept by date (`YAMA_AUTO_IMPORT=1`) |
| Online play | Commander on the phase-rs rules engine (`play/`): lobby, friends join by code, AI seats (Easy/Medium/Hard), legal options only, auto-pass, per-seat hidden information, replay log saved after every move, games resume after a restart, final boards rebuilt from replays. Readable board: hover a card for a full-size preview (desktop), tap for the card with its rules text and your options for it (phone); on phones your options and hand sit in a dock at the bottom. Needs the engine card data (below) |
| Scanner | In progress (docs/scanner.md) |
| Deck planner | In progress (docs/planner-design.md). Importing a plan file works, from the browser (Decks, then Plans, then "Import a plan file") or with `import-plan` below. The pages are built: an overview and a page per plan deck with its changes, stock, now and after-prints lists, bracket builds, copy buttons, "Make this a Yama deck" and a link to your Yama deck; a Review page for answering every swap (offline too) and "Suggest a change"; Settings with script keys for commander-decks' `publish.py` and `pull.py`; a Buy page (cards by store with cart links, dated prices and rule flags, "Mark bought", each order A to Z for sorting a delivery), Prints (each print order and the next one, with tiers and double-faced backs) and Spares; and "I've put this in the deck" ticks |

## Run it locally

Needs Rust (stable) and Node 22+.

```sh
cp .env.example .env               # set YAMA_ADMIN_EMAILS to your email; YAMA_DEV_LOGIN=1 for local
cargo build -p yama-server
./target/debug/yama-server import-cards     # ~2 min: downloads Scryfall bulk data (~105 MB, deleted after)
./target/debug/yama-server serve            # API on http://127.0.0.1:8787

npm install
npm run dev                                  # web app on http://localhost:5173 (proxies /api)
```

Online play needs the local phase fork and its card data (see docs/engine-integration.md):

```sh
git clone --depth 1 --branch v0.113.0 https://github.com/phase-rs/phase ../yama-phase
git -C ../yama-phase apply ../yama/patches/phase/*.patch   # drops 3 nightly-only lines so it builds on stable
mkdir -p data/engine && curl -o data/engine/card-data-eb309108eb0df708.json \
  https://data.phase-rs.dev/card-data-eb309108eb0df708.json   # 101 MB; sha256 eb309108eb0df708…
./target/debug/soak                     # all-AI game with Bryan's decks; checks replay determinism
```

Optional:

```sh
./target/debug/yama-server import-decks ../commander-decks/decks --owner you@example.com
./target/debug/yama-server import-plan ../commander-decks/data/planner/yama-plan.json --owner you@example.com --dry-run
                                        # prints the import report; drop --dry-run to import
./target/debug/yama-server invite friend@gmail.com
```

### Signing in locally

Google sign-in only works on origins added to the OAuth client, so locally use one of these:

- **Dev login** (`YAMA_DEV_LOGIN=1`): any email, no password. Handy for playing as several people in different browsers. It only works while the server listens on localhost (`YAMA_BIND` 127.0.0.1); on any other address it's ignored.
- **Password accounts**: `./target/debug/yama-server user add debug@example.com --admin` prints a generated password (or pipe one in with `--password-stdin`). The login screen then offers "Sign in with a password". These skip the invite list and work on any server, including saget. `user list` shows every account; `user remove-password EMAIL` turns one off and signs it out.

To debug with real data, stop the local server and run `./deploy/pull-db.sh`. It copies saget's newest backup to `data/yama.db` and keeps your old local database beside it. It only reads from saget unless you pass `--fresh`, which writes a new backup there first. Then sign in as yourself with dev login, or give your account a password with `user add`.

To serve the built web app from the Rust server (one process, as in production): `npm run build`, then `YAMA_WEB_DIST=web/dist ./target/debug/yama-server serve`.

### Google sign-in

Create an OAuth client ID (type "Web application") in Google Cloud Console, add your origin (e.g. `http://localhost:5173`) to its authorized JavaScript origins, and set `YAMA_GOOGLE_CLIENT_IDS`. Native apps will add their own client IDs to the same comma-separated list.

## Checks

```sh
cargo test            # server
npm test              # packages/core
npm run typecheck     # core + web
```

## Layout

```
server/            Rust (Axum, SQLite via sqlx). One binary: serve, import-cards, import-decks, import-plan, invite.
  migrations/      Schema
  src/cards/       Scryfall import and search
  src/plan/        Deck planner: plan file import, the per-user bundle, deck links, inputs and the inbox, script keys
play/              Online play on the phase-rs engine (local fork at ../yama-phase), soak test.
packages/core/     Shared TypeScript: life counter, offline search, sample hands, mana colors, deck lists;
                   src/plan/ is the planner's logic (@yama/core/plan)
web/               React app (Vite). Also the future Capacitor phone app. Planner pages in src/plan/.
data/              SQLite database and downloads (git-ignored)
docs/              Design notes
```
