# Yama

Swap cards and reversible deck-box inserts: Decks, Swap cards (`/decks/builds`) brings the deck as it is, its saved lists, tracked plans and plan builds together under plain names ("Bracket 3: Upgraded"). Pick two complete lists to see each change with its plan's reason, and print them as 2.5 × 3.5 inch duplex cards for the deck box. Older now/after-prints snapshots stay under Older snapshots.

Yet Another Magic App: a free Magic: The Gathering app with a public precon reference and private accounts for playing and tracking Commander. It has a life counter for game night, card search, a collection (with Mythic Tools import), decks that know what you own, and playgroup stats. Online play against friends and AI is the next big piece; see [ARCHITECTURE.md](ARCHITECTURE.md).

The engine is maintained in the public MIT/Apache-licensed [Yama Phase repository](https://github.com/bryanroscoe/yama-phase).
Clone it beside this repository as `../yama-phase`; releases fetch `deploy/phase-repo` and export
the exact published commit in `deploy/phase-rev`. Local Cargo builds require that sibling to be clean
and checked out at the pin. See [engine integration](docs/engine-integration.md).

Unofficial fan software. Not affiliated with, endorsed by, or sponsored by Wizards of the Coast. Card data and images come from [Scryfall](https://scryfall.com); images load from Scryfall at runtime and are never stored or re-hosted here.

Precon comparisons and detail pages show [source-backed upgradeability](docs/precon-upgradeability.md) for the whole package: all 619 stock-compatible in-box commander configurations across 174 precons are inventoried. Eighteen configurations have supported 1–5 assessments. The table names the highest supported in-box grade and shows how many options remain ungraded. Fantastic Four covers all four featured commanders plus Crystal and Power Pack. Legal comparison lists, source dates, whole-box reviews and raw commander observations remain distinct from measured list results. Public pages, Lab, APIs and MCP share the data.

Production: [yama.ing](https://yama.ing). Existing users should sync pending changes on the old
site before signing in at the new address; installed apps and MCP connectors need the new URL.

Click your name or Your profile to find your collection, wish list, decks, plans and account settings, and open or copy your public profile.

Sharing is reachable from the main app navigation and from Decks. It brings together your public profile, shared decks and alternate configurations, shared plans (groups of builds), copyable links and sharing settings. Precons and Commanders stay in the same navigation; assistant setup stays with connected apps.

## What works today

Historical evidence can be imported as private, immutable [datasets](docs/datasets.md)
from JSON or gzip, read through authenticated APIs and the `datasets`/`dataset` MCP
tools, and inspected with 180-day-default descriptive monthly weighting. Overlapping
snapshots, activity counts and undated ELO sequences keep their own meanings; imports
do not publish rankings or change decks and games.

Signed out, Yama opens as usual with its full navigation: the life counter and card search
work without an account, and pages that keep someone's own data (decks, collection, playgroup,
the Lab) ask them to sign in where the page would be. The sign-in page (`/signin`) highlights the
public precon reference and MCP guide, explains what an account adds, and keeps Google sign-in
directly accessible. OAuth and private links use a focused sign-in view.

| Area | Status |
|---|---|
| Sign-in | Google ID tokens with an invite list, or open to any verified Google account with `YAMA_OPEN_SIGNUP=1` (accounts without an invite get a smaller lab and online play allowance; see deploy/README.md). Password accounts only from the command line. Sign-in, searches, join codes, imports and new games are rate-limited; admins can disable or delete an account in the admin area (`/admin`), or disable one with `user disable`. Email-only dev login for local use |
| Card data | Scryfall bulk import: ~36.5k cards, ~116k printings, daily prices kept by date, rulings, the Game Changer flag. Images are Scryfall's WebP sizes (JPEG fallback for older files) |
| Card search | Subset of Scryfall syntax (`t:` `o:` `c:` `id<=` `mv` `pow` `f:` `kw:` `is:commander` `is:gamechanger`, `-`, `or`, parentheses). Works offline from a 5 MB card bundle kept on the device |
| Card sheet | Oracle text, Commander legality, Game Changer tag, rulings with dates and sources, printings with market prices and price history |
| Release calendar | Upcoming sets on the Cards page (Scryfall's `/sets`: release date, type, cards Scryfall has so far). Watch a set; once MTGJSON publishes a watched set's Commander precon lists, the Cards page names each deck and its commander (Collector's Editions under their deck) and starts a Yama deck from the stock list; four weeks after release the list folds away below the calendar. Refreshed daily with `YAMA_AUTO_IMPORT=1`, or `yama-server import-calendar` |
| What's new | A page listing what has shipped, in plain sentences, with a notice on each device until it's opened (Group, Account links to it too) |
| Collection | Mothership cash/credit offer checks with private dated history from the Sell list; binders, boxes, decks and lists; add from card search (a real copy or a proxy); move, condition, proxy; proxies kept out of market value, and a Real / Proxies filter; idempotent offline ops; Mythic Tools CSV import (with a preview; a newer export adds only what's new, and cards it no longer lists are removed only if you ask) and export; "Add to my collection" on a deck puts its cards in its deck box, in the printings the list names |
| Decks | Paste any common list format; edit as text with versions; version history with a diff between any two versions; Commander validation; owned/needed with cheapest market price; sample hands with mulligans; Game Changers count; how many cards online play supports; real-game results per version ("This version: 3-2, 5 games") |
| Suggested changes | Review suggestions from Yama’s assistant and external MCP apps before applying them. Deck proposals show separate cards in/out with quantities, card previews, readable reasons and deck checks; existing proposals use the same view |
| Plans | Every plan in one place (Decks, Plans): notes agents save, copies of plans others shared, and imported planner plans. A plan's page is the page its shared link (`/r/<token>`) shows, from the same server computations: each deck's builds, how to pilot it, changes with reasons, a shopping list at market prices (buy up to $2, print the rest; buy all; print all) and the lists to copy. Only the owner sees sharing, their answers for the agent (preferred builds, per-swap answers and notes, kept across refreshes and never applying deck changes) and the agent's evidence: allocations, dated local buys, store checks, combos and print lists. A plan can be shared by link (`/r/<token>`) or on your profile, never showing your answers, ownership or shopping evidence ([format](docs/research-format.md)) |
| Historical datasets | Lab, Datasets browses private imported commander/precon evidence, with name/type search, entity history, adjustable monthly recency summaries, source provenance and original downloads. Admins can upload prepared JSON/gzip datasets ([format](docs/datasets.md)) and switch a source on for the precon pages, which then show each precon's dated real-game history, recent rate and trend, updated by every new upload |
| Brackets | A declared bracket per deck (chips on the deck list, table setup and online lobby), shown beside a starting suggestion from Commander Spellbook's card-list signals: Game Changers, mass land denial, extra turns and combos. Unflagged lists start provisionally at Core (2); Exhibition (1) and cEDH (5) are chosen by the owner. The deck page explains why. Checked in the background after a save; turn off with `YAMA_DECK_CHECKS=0` |
| Deck stats and export | Mana curve (creatures and other spells), average mana value with and without lands, land count, colored pips and potential land access per color, without unsupported shortage verdicts ([method and research](docs/deck-stats.md)). Export as names only (EDHbots), Moxfield (set and number of your copy) or MTG Arena; copy or download |
| Life counter | 1–6 players, rotated panels with the commander's art behind each life total (artist and copyright credited on each panel; switch to mana colors per device), commander damage and tax, poison and counters, monarch, initiative, day/night, undo, works offline and syncs later. Roll for first or pick who goes first (passing the turn never guesses it); knocking someone out asks who did it; the finish sheet asks how the game was won and how fun it was, and takes a note (all optional) |
| Shared table | Every phone joins the game by QR code; the host phone stays in charge and works offline |
| Playgroups | Join codes (the owner can make a new one, and removing an account changes it), guests without accounts, a members list where anyone can leave and the owner renames the group, removes people, hands it on or deletes it, game history, logging games played without Yama (with game type, starting life, first player, knockouts, win condition, fun and a note), win rates by player and commander beside the share they'd win by chance, win rate by turn order (with playgroup.gg's 4-player figures until the group has 20 games), how games were won, head to head, archnemesis, first out and last out, streaks, fun. Every rate shows its count, under 5 games it's marked provisional, and the page says when it was computed. The computer's seats and games against only the computer stay out of players' records, table rounds and online player turns are averaged apart, and the commander table reads Commander games only |
| Game export | Every finished game you played or recorded, or a whole playgroup's, as JSON (shaped for commander-decks' `data/games.json`) or CSV (one row per seat), with each game's format and starting life and whether the computer played a seat. Dates are the local day in your time zone; other people's deck names and notes stay private |
| Install | Installable web app (home screen, offline shell); Capacitor config for native apps (docs/mobile.md) |
| Prices | Card Kingdom retail and buylist plus Mana Pool listing history via MTGJSON (90-day initial backfill), with individual dated buylist references for matching real copies, without an unverified resale total. Deck singles replacement estimates (with missing-copy counts and date ranges); precon sealed-deck market references via MTGJSON product IDs and TCGCSV, refreshed daily or with `import-deck-prices`. Daily Scryfall snapshots kept by date (`YAMA_AUTO_IMPORT=1`, which also refreshes the release calendar) |
| Online play | Commander on the phase-rs rules engine (`play/`): lobby, friends join by code (the host can cancel a table that hasn't started, and delete a game that's over), choose who goes first or roll for it, AI seats (Easy/Medium/Hard) on your decks or stock precons, legal options only, auto-pass, per-seat hidden information, replay log saved after every move, games resume after a restart, final boards rebuilt from replays. Readable board on the Night table design: opponents across the top on their commander art, hover a card for a full-size preview (desktop), right-click, long-press or tap for the card with its rules text and your options for it. One big button says what it will do ("To combat", "Attack (2)", "Resolve"); attack and block by clicking creatures, with any legal declaration (not only the engine's sample); pick a target on the board; pay mana automatically or by hand ("Tap mana for me", saved with your account), with Treasures, painlands, Phyrexian mana, convoke, delve, kicker and ward asked on the board; set your own stops on the phase ladder (saved with your account); pass until something happens, pass the rest of the turn or pass to your turn (Enter, Shift+Enter, P), full control (F), hold priority and Resolve all; game settings for trigger yields, remembered answers (turned off there or from the log), hand order and conceding; read any card with its Oracle text, its state on the battlefield and its rulings, flipping two-faced cards; every player's graveyard, exile and command zone, each card saying how it got there; reveals shown to the players allowed to see them; a game log of what happened, as each seat may know it, with filters (since your last turn, about you, spells, combat); knockouts with their cause (saved with the game, with who did it and how the game was won where the engine says, for playgroup stats), keep watching after you're out, and a game-over screen with standings, the game's numbers, the finish sheet's questions (how it was won, how fun it was) and Rematch; ways to cast asked as their own choices (what cascade and discover went through and found, an adventure's two halves, madness and miracle, a modal card's two faces, alternative costs, mutate over or under), with cards you can cast from exile or a graveyard beside your hand; the legend rule, clones, the Ring-bearer, equip and empower Jace picked on the board; proliferate, and moving or removing counters with steppers; decisions everyone takes part in, with each seat seeing the public part (votes cast in turn order with a tally, Fact or Fiction's piles split by one player and chosen by another, a villainous choice, coins and dice kept or ignored, a clash's revealed cards); choosing a player on their commander's art (a gift, an opponent who chooses or separates, who a permanent enters under); the library's top or bottom, the Cultivate split, Telling Time's top and bottom, manifest dread, learn, and "Done looking" after your own reveal; the rarer cards and rules (a morph cast face down, shown as a 2/2 with no name that only its controller can read, and turned face up for its cost; ninjutsu picked from your unblocked attackers; foretell; a companion revealed before the game and put into your hand for {3}; meld, cipher, Serum Powder at the mulligan, a dungeon chosen and its next room picked on the dungeon's map, time travel with remove one, leave or add one for each card, and loop shortcuts proposed and accepted or shortened); answers Yama remembers for you for the rest of a game ("Always pay" for Rhystic Study and other unless-costs in mana, your commander to the command zone), each logged with Turn off; and an art credit under every battlefield. Phones get opponent tabs, a hand drawer and a docked button. Needs the engine card data (below) |
| Scanner | Camera OCR in Collection; swap checks from Plans, Prints, Swap sheet or a plan deck: scan either card for its replacement, reasons and destination, or check a photo or typed name. Uses card identity across printings and either face; scans change nothing. Further recognition work in docs/scanner.md |
| Deck planner | In progress (docs/planner-design.md). Importing a plan file works, from the browser (Decks, then Plans, then "Import a plan file") or with `import-plan` below. The pages are built: an overview and a page per plan deck with its changes, stock, now and after-prints lists, bracket builds, copy buttons, "Make this a Yama deck" and a link to your Yama deck; answers beside each proposed swap on its deck's page (offline too) and a Review page listing the decks with answers waiting and "Suggest a change"; Settings with script keys for commander-decks' `publish.py` and `pull.py`; a Buy page (cards by store with cart links, dated prices and rule flags, "Mark bought", each order A to Z for sorting a delivery), Prints (each print order and the next one, with tiers and double-faced backs; Print with MakePlayingCards picks print-ready images from MPC Autofill and the Yama print helper for Chrome, `extension/mpc`, fills them into an MPC project, or writes MPC Autofill's order.xml; and a printable swap sheet: sort the prints into decks, then each deck's card in, card out and where the cut card goes) and Spares; "I've put this in the deck" ticks; and "Swap in the prints" per deck, which gives the linked Yama deck its after-prints list, puts the prints in its box as proxies, moves cut cards to the deck that takes them next, the deck's swap bag box or Spares, and ticks the swaps installed |
| Simulation lab | One shared-field tournament with 4–256 distinct deck lists, randomized four-player pods, games-per-deck targets, optional precon benchmarks and per-engine rankings/matchups. Batch runner for all-AI games (`play/src/bin/lab.rs`, core in `play/src/lab.rs`); the Commander precon catalog and analysed rating runs imported from commander-decks, with read APIs; "Try a change" experiments played by the server (`/api/lab/experiments`, YAMA_LAB_THREADS isolated game processes, default 1). Pages under Decks, Lab: the precon table and pages (with links to EDHREC's corresponding precon guide and related articles), "Try a change", and your runs, including your imported batch runs. Needs the engine card data |

The public precon reference (`/precons`) serves stock lists, experimental meta rankings, explicitly published Phase/Forge simulation evidence, attributed real-game results and dated market references without sign-in. The personal Lab still requires sign-in. Results are published with `publish-precons MANIFEST`; imports never publish automatically. See [public precons and publication](docs/public-precons.md). All rights reserved in Yama’s original software, written analysis and presentation; third-party rights remain with their owners (see [COPYRIGHT](COPYRIGHT)).

## Run it locally

Yama also exposes its own MCP at `/mcp` for Ask Claude and outside clients: private deck,
collection and planner tools; staged edits; full online card search, community recommendations,
combos, public deck imports and current rules; deck/budget analysis and bounded mana checks.
No other Magic MCP installation is needed for those workflows. See
the public [MCP feature and setup guide](https://yama.ing/docs/mcp/),
[capabilities and use](docs/mcp-parity.md) and [connection design](docs/mcp-design.md).
The private [Codex and ChatGPT plugin](docs/codex-plugin.md) packages this connection
with deck-building, collection-planning and research skills; it is not a public listing.

Needs Rust (stable) and Node 22+.

**Quickest, on production's data (2 Nov 2026):** `npm run local` copies saget's newest backup to
`data/yama.db` (only when it's missing; `-- --refresh` copies again), builds the server and starts it
and the web app with every background job off and `YAMA_OFFLINE=1` (nothing a request would fetch
from outside: previews, store checks, Ask Claude, research, MTGJSON lists, the scanner's files), then
prints how to sign in.
`npm run local -- --shots` also takes screenshots of every page once it's up, and `--dry-run` prints
the plan. It works from any worktree. The copy holds real people's data: keep it out of git, PRs and
uploads, and delete `data/yama*.db` when you're done. See
[.claude/skills/yama-local/SKILL.md](.claude/skills/yama-local/SKILL.md). Keep the primary checkout
(`~/Developer/yama`) on origin/main and do changes in worktrees; `scripts/sync-main.sh` refreshes it
after a merge.

To start from an empty database instead:

```sh
cp .env.example .env               # set YAMA_ADMIN_EMAILS to your email; YAMA_DEV_LOGIN=1 for local
cargo build -p yama-server
./target/debug/yama-server import-cards     # ~2 min: downloads Scryfall bulk data and rulings (~110 MB, deleted after)
./target/debug/yama-server serve            # API on http://127.0.0.1:8787

npm install
npm run dev                                  # web app on http://localhost:5173 (proxies /api)
npm run polish -- shoot --as you@example.com # screenshots of every page at three sizes (docs/polish.md)
```

Online play needs the local phase fork and its card data (see docs/engine-integration.md):

```sh
git clone https://github.com/bryanroscoe/yama-phase.git ../yama-phase
git -C ../yama-phase checkout "$(cat deploy/phase-rev)"
mkdir -p data/engine
  # Build card-data-cbd552b41f962f5b.json from the archived inputs as described in
  # docs/engine-integration.md (SHA-256 cbd552b41f962f5b…). This export from Yama's
  # pinned parser is not published on data.phase-rs.dev. It must match deploy/phase-rev.
./target/debug/soak                     # all-AI game with Bryan's decks; checks replay determinism
```

Checks on games people play (docs/play-performance.md), in release:

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

The gameplay checks above are separate from `cargo test`, which skips full-game tests by default.
The determinism checks fail on an AI stop or missing card data. The candidate regression suite requires normal error-free completion of the unchanged seeded
scenarios. Historical fixtures and their winner/turn/action control remain separate and immutable;
the old schema must run with its matching historical runtime. See [gameplay validation](docs/gameplay-validation.md). A healthy isolated
worker is evidence of server reliability; it does not establish rules or AI correctness.

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
./target/debug/yama-server import-deck-prices  # sealed market prices; cached for 24 hours
./target/debug/yama-server import-lab ../commander-decks/data/sim/runs/pilot-2/summary.json  # a global rating run
```

### Signing in locally

Google sign-in only works on origins added to the OAuth client, so locally use one of these:

- **Dev login** (`YAMA_DEV_LOGIN=1`): any email, no password. Handy for playing as several people in different browsers. It only works while the server listens on localhost (`YAMA_BIND` 127.0.0.1); on any other address it's ignored.
- **Password accounts**: `./target/debug/yama-server user add debug@example.com --admin` prints a generated password (or pipe one in with `--password-stdin`). The login screen then offers "Sign in with a password". These skip the invite list and work on any server, including saget. `user list` shows every account; `user remove-password EMAIL` turns one off and signs it out; `user disable EMAIL` and `user enable EMAIL` turn a whole account off and on. No route in the app makes a password account, and `YAMA_PASSWORD_LOGIN=0` turns password sign-in off.

To debug with real data, stop the local server and run `./deploy/pull-db.sh`. It copies saget's newest backup to `data/yama.db` and keeps your old local database beside it. It only reads from saget unless you pass `--fresh`, which writes a new backup there first. Then sign in as yourself with dev login, or give your account a password with `user add`.

To serve the built web app from the Rust server (one process, as in production): `npm run build`, then `YAMA_WEB_DIST=web/dist ./target/debug/yama-server serve`.

### Google sign-in

Create an OAuth client ID (type "Web application") in Google Cloud Console, add your origin (e.g. `http://localhost:5173`) to its authorized JavaScript origins, and set `YAMA_GOOGLE_CLIENT_IDS`. A native Android app asks Google for ID tokens for this same Web client ID; its own Android OAuth client only identifies the app (docs/mobile.md).

## Checks

GitHub CI tests are switched off while hosted Actions minutes are short (Bryan, 2 Nov 2026):
the `CI_TESTS` repository variable turns them back on, and until then agents run
`scripts/local-ci.sh --no-amend` before merging ([Tests on or off](docs/ci.md#tests-on-or-off)).
With tests on, [GitHub CI](docs/ci.md) runs the Rust and Python suites, web tests, typecheck and web build on
every ready PR into main and every main push. Both CI jobs must pass before merge, or be skipped
by the gate because `scripts/local-ci.sh` passed on that commit's tree (or the PR has the
`skip-ci` label). Draft PRs run no CI; see [Skip CI on a PR](docs/ci.md#skip-ci-on-a-pr).

The opt-in [lab worker pilot](docs/lab-workers.md) lets an admin route Phase pods to saget,
a laptop or GitHub-hosted Actions, choose among available workers, and compare matching samples.
It includes owner-scoped worker keys and a manual Actions workflow; activation and deployment
are separate steps.

```sh
cargo test            # server
npm test              # packages/core
npm run typecheck     # core + web
```

Successful CI on merged `main` automatically deploys through the dedicated saget runner
([operation and recovery](deploy/RUNNER.md)). Releases follow [deploy/RELEASING.md](deploy/RELEASING.md): fetch GitHub before merging, integrate the completed work into main, verify and publish main, then deploy that same commit from a clean main checkout. `./deploy/deploy.sh --check` checks readiness without contacting saget.

`cargo test` includes the per-card tests (play/src/card_tests/): a smoke test for every card in Bryan's decks and specific tests for the commanders, the cards the decks are built around and the cards phase only partly implements or parses with warnings. What phase supports for each card, and the engine bugs the tests found, are in [docs/card-coverage.md](docs/card-coverage.md); regenerate it, and the tests' card fixture, with `cargo run -p yama-play --bin coverage -- data/engine/card-data-cbd552b41f962f5b.json ../commander-decks --fixture play/tests/fixtures/deck-cards.json --smoke play/src/card_tests/smoke_cards.rs`.

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
play/              Online play on the phase-rs engine (local fork at ../yama-phase), soak test, playbench; the lab's
                   game core (src/lab.rs) and batch runner (src/bin/lab.rs).
packages/core/     Shared TypeScript: life counter, offline search, sample hands, mana colors, deck lists;
                   src/plan/ is the planner's logic (@yama/core/plan)
web/               React app (Vite). Also the future Capacitor phone app. Planner pages in src/plan/, lab pages
                   in src/lab/.
data/              SQLite database and downloads (git-ignored)
docs/              Design notes
```

Phase retry-tail progress shows the experiment's pending/retry counts and hides the normal-pace ETA when only slow retries remain. A completed Phase half is labeled while Forge continues. This is reporting, not a fix for engine stalls or changed timeout budgets.
