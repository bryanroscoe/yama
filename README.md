# Yama

Yet Another Magic App: a private Magic: The Gathering app for Bryan's playgroup. It has a life counter for game night, card search, a collection (with Mythic Tools import), decks that know what you own, and playgroup stats. Online play against friends and AI is the next big piece; see [ARCHITECTURE.md](ARCHITECTURE.md).

Unofficial fan software. Not affiliated with, endorsed by, or sponsored by Wizards of the Coast. Card data and images come from [Scryfall](https://scryfall.com); images load from Scryfall at runtime and are never stored or re-hosted here.

## What works today

| Area | Status |
|---|---|
| Sign-in | Google ID tokens with an invite list, or open to any verified Google account with `YAMA_OPEN_SIGNUP=1` (accounts without an invite get a smaller lab and online play allowance; see deploy/README.md). Password accounts only from the command line. Sign-in, searches, join codes, imports and new games are rate-limited; admins can disable or delete an account in the admin area (`/admin`), or disable one with `user disable`. Email-only dev login for local use |
| Card data | Scryfall bulk import: ~36.5k cards, ~116k printings, daily prices kept by date, rulings, the Game Changer flag. Images are Scryfall's WebP sizes (JPEG fallback for older files) |
| Card search | Subset of Scryfall syntax (`t:` `o:` `c:` `id<=` `mv` `pow` `f:` `kw:` `is:commander` `is:gamechanger`, `-`, `or`, parentheses). Works offline from a 5 MB card bundle kept on the device |
| Card sheet | Oracle text, Commander legality, Game Changer tag, rulings with dates and sources, printings with market prices and price history |
| Release calendar | Upcoming sets on the Cards page (Scryfall's `/sets`: release date, type, cards Scryfall has so far). Watch a set; once MTGJSON publishes a watched set's Commander precon lists, the Cards page names each deck and its commander (Collector's Editions under their deck) and starts a Yama deck from the stock list; four weeks after release the list folds away below the calendar. Refreshed daily with `YAMA_AUTO_IMPORT=1`, or `yama-server import-calendar` |
| What's new | A page listing what has shipped, in plain sentences, with a notice on each device until it's opened (Group, Account links to it too) |
| Collection | Binders, boxes, decks and lists; add from card search; move, condition, proxy; idempotent offline ops; Mythic Tools CSV import (with a preview; a newer export adds only what's new, and cards it no longer lists are removed only if you ask) and export; "Add to my collection" on a deck puts its cards in its deck box, in the printings the list names |
| Decks | Paste any common list format; edit as text with versions; version history with a diff between any two versions; Commander validation; owned/needed with cheapest market price; sample hands with mulligans; Game Changers count; how many cards online play supports; real-game results per version ("This version: 3-2, 5 games") |
| Brackets | A declared bracket per deck (chips on the deck list, table setup and online lobby), shown beside Commander Spellbook's estimate for each saved version: its bracket, Game Changers, mass land denial, extra turns and combos. Checked in the background after a save; turn off with `YAMA_DECK_CHECKS=0` |
| Deck stats and export | Mana curve (creatures and other spells), average mana value with and without lands, land count, colored pips against land sources per color. Export as names only (EDHbots), Moxfield (set and number of your copy) or MTG Arena; copy or download |
| Life counter | 1–6 players, rotated panels with the commander's art behind each life total (artist and copyright credited on each panel; switch to mana colors per device), commander damage and tax, poison and counters, monarch, initiative, day/night, undo, works offline and syncs later. Roll for first or pick who goes first (passing the turn never guesses it); knocking someone out asks who did it; the finish sheet asks how the game was won and how fun it was (all optional) |
| Shared table | Every phone joins the game by QR code; the host phone stays in charge and works offline |
| Playgroups | Join codes, guests without accounts, game history, logging games played without Yama (with first player, win condition and fun), win rates by player and commander beside the share they'd win by chance, win rate by turn order (with playgroup.gg's 4-player figures until the group has 20 games), how games were won, head to head, archnemesis, first out and last out, streaks, fun. Every rate shows its count, under 5 games it's marked provisional, and the page says when it was computed |
| Game export | Every finished game you played or recorded, or a whole playgroup's, as JSON (shaped for commander-decks' `data/games.json`) or CSV (one row per seat). Dates are the local day in your time zone; other people's deck names and notes stay private |
| Install | Installable web app (home screen, offline shell); Capacitor config for native apps (docs/mobile.md) |
| Prices | Daily Scryfall snapshots kept by date (`YAMA_AUTO_IMPORT=1`, which also refreshes the release calendar) |
| Online play | Commander on the phase-rs rules engine (`play/`): lobby, friends join by code, AI seats (Easy/Medium/Hard), legal options only, auto-pass, per-seat hidden information, replay log saved after every move, games resume after a restart, final boards rebuilt from replays. Readable board on the Night table design: opponents across the top on their commander art, hover a card for a full-size preview (desktop), right-click, long-press or tap for the card with its rules text and your options for it. One big button says what it will do ("To combat", "Attack (2)", "Resolve"); attack and block by clicking creatures, with any legal declaration (not only the engine's sample); pick a target on the board; pay mana automatically or by hand ("Tap mana for me", saved with your account), with Treasures, painlands, Phyrexian mana, convoke, delve, kicker and ward asked on the board; set your own stops on the phase ladder (saved with your account); pass until something happens, pass the rest of the turn or pass to your turn (Enter, Shift+Enter, P), full control (F), hold priority and Resolve all; game settings for trigger yields, remembered answers (turned off there or from the log), hand order and conceding; read any card with its Oracle text, its state on the battlefield and its rulings, flipping two-faced cards; every player's graveyard, exile and command zone, each card saying how it got there; reveals shown to the players allowed to see them; a game log of what happened, as each seat may know it, with filters (since your last turn, about you, spells, combat); knockouts with their cause, keep watching after you're out, and a game-over screen with standings, the game's numbers and Rematch. Phones get opponent tabs, a hand drawer and a docked button. Needs the engine card data (below) |
| Scanner | In progress (docs/scanner.md) |
| Deck planner | In progress (docs/planner-design.md). Importing a plan file works, from the browser (Decks, then Plans, then "Import a plan file") or with `import-plan` below. The pages are built: an overview and a page per plan deck with its changes, stock, now and after-prints lists, bracket builds, copy buttons, "Make this a Yama deck" and a link to your Yama deck; a Review page for answering every swap (offline too) and "Suggest a change"; Settings with script keys for commander-decks' `publish.py` and `pull.py`; a Buy page (cards by store with cart links, dated prices and rule flags, "Mark bought", each order A to Z for sorting a delivery), Prints (each print order and the next one, with tiers and double-faced backs) and Spares; and "I've put this in the deck" ticks |
| Simulation lab | Batch runner for all-AI games (`play/src/bin/lab.rs`, core in `play/src/lab.rs`); the Commander precon catalog and analysed rating runs imported from commander-decks, with read APIs; "Try a change" experiments played by the server (`/api/lab/experiments`, YAMA_LAB_THREADS game threads, default 2). Pages under Decks, Lab: the precon table and pages, "Try a change", and your runs, including your imported batch runs. Needs the engine card data |

## Run it locally

Needs Rust (stable) and Node 22+.

```sh
cp .env.example .env               # set YAMA_ADMIN_EMAILS to your email; YAMA_DEV_LOGIN=1 for local
cargo build -p yama-server
./target/debug/yama-server import-cards     # ~2 min: downloads Scryfall bulk data and rulings (~110 MB, deleted after)
./target/debug/yama-server serve            # API on http://127.0.0.1:8787

npm install
npm run dev                                  # web app on http://localhost:5173 (proxies /api)
```

Online play needs the local phase fork and its card data (see docs/engine-integration.md):

```sh
git clone --depth 1 --branch v0.113.0 https://github.com/phase-rs/phase ../yama-phase
git -C ../yama-phase apply ../yama/patches/phase/*.patch   # 0001 drops 3 nightly-only lines so it builds on stable
                                                           # 0002-0008: AI fixes and free-for-all tempo changes (22 Oct 2026)
mkdir -p data/engine && curl -o data/engine/card-data-eb309108eb0df708.json \
  https://data.phase-rs.dev/card-data-eb309108eb0df708.json   # 101 MB; sha256 eb309108eb0df708…
./target/debug/soak                     # all-AI game with Bryan's decks; checks replay determinism
```

Optional:

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
./target/debug/yama-server import-lab ../commander-decks/data/sim/runs/pilot-2/summary.json  # a global rating run
```

### Signing in locally

Google sign-in only works on origins added to the OAuth client, so locally use one of these:

- **Dev login** (`YAMA_DEV_LOGIN=1`): any email, no password. Handy for playing as several people in different browsers. It only works while the server listens on localhost (`YAMA_BIND` 127.0.0.1); on any other address it's ignored.
- **Password accounts**: `./target/debug/yama-server user add debug@example.com --admin` prints a generated password (or pipe one in with `--password-stdin`). The login screen then offers "Sign in with a password". These skip the invite list and work on any server, including saget. `user list` shows every account; `user remove-password EMAIL` turns one off and signs it out; `user disable EMAIL` and `user enable EMAIL` turn a whole account off and on. No route in the app makes a password account, and `YAMA_PASSWORD_LOGIN=0` turns password sign-in off.

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
server/            Rust (Axum, SQLite via sqlx). One binary: serve, import-cards, import-calendar, import-decks, import-plan,
                   import-precons, import-lab, import-mythic, collection add-deck, deck (archive, rename), invite,
                   user (add, remove-password, disable, enable, list).
                   src/limits.rs holds the rate limits and the client address rules.
  migrations/      Schema
  src/cards/       Scryfall import and search
  src/plan/        Deck planner: plan file import, the per-user bundle, deck links, inputs and the inbox, script keys
  src/lab.rs, src/lab/  Simulation lab: precon catalog, rating runs, "Try a change" experiments and their worker
play/              Online play on the phase-rs engine (local fork at ../yama-phase), soak test; the lab's game core
                   (src/lab.rs) and batch runner (src/bin/lab.rs).
packages/core/     Shared TypeScript: life counter, offline search, sample hands, mana colors, deck lists;
                   src/plan/ is the planner's logic (@yama/core/plan)
web/               React app (Vite). Also the future Capacitor phone app. Planner pages in src/plan/, lab pages
                   in src/lab/.
data/              SQLite database and downloads (git-ignored)
docs/              Design notes
```
