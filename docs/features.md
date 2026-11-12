# What Yama does today

The detail behind the short list in the [README](../README.md): every area of the app and what
works in it now. [ARCHITECTURE.md](../ARCHITECTURE.md) explains how it is built and why. When a
feature ships or changes, update its entry here.

Online play is in alpha: expect bugs and slow turns.

- [Navigation](#navigation)
- [Accounts, sign-in and sharing](#accounts-sign-in-and-sharing)
- [Cards and prices](#cards-and-prices)
- [Collection](#collection)
- [Decks and plans](#decks-and-plans)
- [Game night](#game-night)
- [Online play](#online-play)
- [Lab and evidence](#lab-and-evidence)
- [Assistants (MCP)](#assistants-mcp)

## Navigation

Home (`/`, where the wordmark goes) is where Yama opens. Signed out it says what Yama is and
lists what works without an account: the life counter, a game against the computer, precons,
commanders and card search. Signed in it puts a life counter game in progress on top, then
starting a game, your four most recently changed decks and your playgroup's latest three games.
Opening Yama with a life counter game touched in the last 12 hours goes straight to that game.
The life counter's setup is at `/play/table` (it was `/`; `/table` redirects there).

Five tabs: Play (the life counter, online play, watching, game history), Decks (your decks,
precons, commanders), Cards, Collection (your cards, trading with a friend) and Playgroup. A
laptop has them in a left rail under the wordmark, which goes home, with you at the foot; a phone
has a top bar (wordmark, search, you) and the five tabs along the bottom. A tab with more than
one page lists them in a strip above the page. You (your avatar) opens your public profile,
Sharing settings, Settings, connecting an assistant, What's new, help and the admin area.
Workshop holds plans, getting the cards, swap sheets, simulations and datasets: a rail tab on a
laptop, a row on the You page on a phone. Every older address still opens its page
(`web/src/nav.tsx`).

## Accounts, sign-in and sharing

### Sign-in

Google ID tokens with an invite list, or open to any verified Google account with `YAMA_OPEN_SIGNUP=1` (an account gets the standard allowance, and an invite gives the larger one; see [deploy/README.md](../deploy/README.md#open-sign-up-anyone-with-a-google-account)). Password accounts only from the command line. Sign-in, searches, join codes, imports and new games are rate-limited; admins can disable or delete an account in the admin area (`/admin`), or disable one with `user disable`. Email-only dev login for local use.

### Signed out

Yama opens on Home with its full navigation: the life counter and card search work without an
account, and pages that keep someone's own data (decks, collection, playgroup, the Lab) ask them
to sign in where the page would be. The sign-in page (`/signin`) highlights the public precon
reference and MCP guide, explains what an account adds, and keeps Google sign-in directly
accessible. OAuth and private links use a focused sign-in view.

### Profile and sharing

You (your avatar) opens your public profile, Sharing settings and account settings.

Sharing settings (under You) brings together your public profile, shared decks and alternate
configurations, shared plans (groups of builds), copyable links and the account-wide switches;
each deck and plan has its own Share control. Trading with a friend is under Collection. A shared deck or collection never shows account details, prices paid,
notes, containers, proxies, planner plans or games.

Adding a deck asks who can see it (Public, Link only or Private) on the save step. The choice
starts as the account's default and is remembered as that default for the next deck; each deck's
Share button changes it afterwards. A first public deck asks for a handle (on the save step and
in the deck's Share sheet). Without one the deck is public by link; it joins the profile once a
handle is chosen.

Yama moved to [yama.ing](https://yama.ing) on 28 October 2026. Anyone still on the old address
should sync pending changes there before signing in at the new one; installed apps and MCP
connectors need the new URL.

### Install

Installable web app (home screen, offline shell); Capacitor config for native apps ([mobile.md](mobile.md)).

### Bug reports

Anyone signed in can report a bug from the little bug on every page head and dialog head (and
Report a bug at the foot of the laptop rail). The form asks what went wrong; Point at it hides
the form so they can drag a box round the problem, or tap it, and the report keeps the box with
the words, controls and card names inside it, the page's address, the dialog it came from, the
window size, the build and the browser. No screenshot is taken. Admins read, resolve and delete
reports in Admin, Bug reports. Reports are limited to 20 per account a day and go with the
account when it is deleted.

### What's new

A page listing what has shipped, in plain sentences, with a notice on each device about what shipped since its first visit, until the page is opened (Account settings links to it too).

## Cards and prices

### Card data

Scryfall bulk import: ~36.5k cards, ~116k printings, daily prices kept by date, rulings, the Game Changer flag. Cards, Commander legality and Game Changer flags refresh daily, so a new set is legal in Yama the day Scryfall marks it; rulings weekly. Images are Scryfall's WebP sizes (JPEG fallback for older files). Mana costs and symbols in rules text ({T}, {2}{G/U}, {W/P}) show as the symbols everywhere a card's cost or text appears, loaded from Scryfall at runtime and kept for offline use once seen; a symbol that can't load shows as its text.

### Card search

Subset of Scryfall syntax (`t:` `o:` `c:` `id<=` `mv` `pow` `f:` `kw:` `is:commander` `is:gamechanger`, `-`, `or`, parentheses; `set:` `a:` `year` `usd<` `is:reserved` and more `is:` values such as `is:partner` and `is:mdfc`; a card with no price never matches a price comparison). The search box suggests card names as you type, and picking one opens the card. Sorts by name, popularity, mana value, color, price or first release. Works offline from a 5 MB card bundle kept on the device, which has no printings or prices: there, searches by set, artist, year, price and the Reserve List say they need a connection.

### Card sheet

Oracle text, Commander legality, Game Changer tag, rulings with dates and sources, printings with market prices and price history. Which of your decks run the card, and the combos it is part of in them (from each deck's kept Commander Spellbook check; nothing new is sent).

### Release calendar

Upcoming sets on the Cards page (Scryfall's `/sets`: release date, type, cards Scryfall has so far). Watch a set; once MTGJSON publishes a watched set's Commander precon lists, the Cards page names each deck and its commander (Collector's Editions under their deck) and starts a Yama deck from the stock list; four weeks after release the list folds away below the calendar. Refreshed daily with `YAMA_AUTO_IMPORT=1`, or `yama-server import-calendar`.

### Prices

Card Kingdom retail and buylist plus Mana Pool listing history via MTGJSON (90-day initial backfill), with individual dated buylist references for matching real copies, without an unverified resale total. Deck singles replacement estimates (with missing-copy counts and date ranges); precon sealed-deck market references via MTGJSON product IDs and TCGCSV, refreshed daily or with `import-deck-prices`. Daily Scryfall snapshots kept by date (`YAMA_AUTO_IMPORT=1`, which also refreshes the release calendar).

### Scanner

Camera OCR in Collection; swap checks from Plans, Prints, Swap sheet or a plan deck: scan either card for its replacement, reasons and destination, or check a photo or typed name. Uses card identity across printings and either face; scans change nothing. How recognition works, and what is left, is in [scanner.md](scanner.md).

## Collection

- Mothership cash/credit offer checks with private dated history from the Sell list
- Binders, boxes, decks and lists
- Add from card search (a real copy or a proxy)
- Move, condition, proxy
- A copy's language and whether it is signed or altered, for the whole row or one copy split off, shown as tags on the copy
- Proxies kept out of market value, and a Real / Proxies filter
- Filters by set, color, type, rarity and finish, with the market value of what they leave; a list or a grid of card pictures
- Idempotent offline ops
- Import from a pasted list or a file exported by ManaBox, Moxfield, Archidekt, Deckbox, Dragon Shield or TCGplayer: set, number, finish, condition and language where the file has them; a preview of what matches, with lines that match nothing kept listed; into a box you choose; the same list twice adds nothing, and a newer export can add only the copies you don't have yet
- Mythic Tools CSV import (with a preview; a newer export adds only what's new, and cards it no longer lists are removed only if you ask) and export
- "Add to my collection" on a deck puts its cards in its deck box, in the printings the list names

## Decks and plans

### Decks

- The Decks list has folders (set in a deck's settings; imports set one too), a search by name or commander, filters by folder, color and declared bracket, and a sort by name, most recently changed or record (the Mythic Tools folder stays with the decks that import keeps up to date)
- Paste any common list format
- Edit as text with versions, with a card search on the edit page that adds or removes a card in one press and says whether it fits the commander's colors and whether you own it
- Version history with a diff between any two versions
- Commander validation
- Check cards: compare physical cards with the saved list without changes, scan a new version, or find cards missing from your collection; each menu action has its description on a separate line
- Owned/needed with cheapest market price
- The Cards tab shows the list as pictures, stacks (each group a column of overlapping cards with their name bars showing; pointing at or focusing one shows it whole), a list or a table, grouped by type or mana value
- Sample hands with mulligans
- Game Changers count
- How many cards online play supports
- Real-game results per version ("This version: 3-2, 5 games")

### Brackets

A declared bracket per deck (chips on the deck list, table setup and online lobby), shown beside a starting suggestion from Commander Spellbook's card-list signals: Game Changers, mass land denial, extra turns and combos. Unflagged lists start provisionally at Core (2); Exhibition (1) and cEDH (5) are chosen by the owner. The deck page explains why beside the cards: the 1 to 10 power level (its dial is on the Stats tab), the Game Changers and the cards in each two-card combo with what the combo does (roll over a chip to see the card). On the Stats tab, the five scores compare with the deck's own stock list, any earlier version or another of your decks, showing how far power moved, as well as with a typical precon, Bracket 4 or cEDH. Checked in the background after a save; turn off with `YAMA_DECK_CHECKS=0`.

### Deck stats and export

Mana curve (creatures and other spells), average mana value with and without lands, land count, colored pips and potential land access per color, without unsupported shortage verdicts ([method and research](deck-stats.md)). Export as names only (EDHbots), Moxfield (set and number of your copy) or MTG Arena; copy or download.

### Suggested changes

Review suggestions from Yama’s assistant and external MCP apps before applying them. Deck proposals show separate cards in/out with quantities, card previews, readable reasons and deck checks; existing proposals use the same view.

### Plans

Every plan in one place (Decks, Plans): notes agents save, copies of plans others shared, and imported planner plans. A plan's page is the page its shared link (`/r/<token>`) shows, from the same server computations: each deck's builds, how to pilot it, changes with reasons, a shopping list at market prices (buy up to $2, print the rest; buy all; print all) and the lists to copy. Only the owner sees sharing, their answers for the agent (preferred builds, per-swap answers and notes, kept across refreshes and never applying deck changes) and the agent's evidence: allocations, dated local buys, store checks, combos and print lists. A plan can be shared by link (`/r/<token>`) or on your profile, never showing your answers, ownership or shopping evidence ([format](research-format.md)).

Local sourcing shows all filtered cards and allocates recorded quantities across acceptable printings. A listing without a count supplies one copy (in stock means at least one); more need an explicit request and remain unconfirmed. A selected product variant's stock count is separate from a search badge that combines conditions or finishes. The sourcing page shows dated public Shopify catalog caches and can refresh them (some stores refuse full-catalog reads; a check then searches each card instead); assistants can request the same refresh with `check_stores(refresh_catalog: true)`. Complete catalogs persist across restarts; failed crawls preserve the last complete cache. A catalog refresh does not rewrite a private saved source report or alter a retailer cart. See the [local shopping workflow](local-shopping-workflow.md).

### Deck planner

The planner is in progress ([design](planner-design.md), [plan file format](plan-format.md)).

- Importing a plan file works, from the browser (Decks, then Plans, then "Import a plan file") or with `yama-server import-plan`.
- The pages are built: an overview and a page per plan deck with its changes, stock, now and after-prints lists, bracket builds, copy buttons, "Make this a Yama deck" and a link to your Yama deck
- Answers beside each proposed swap on its deck's page (offline too) and a Review page listing the decks with answers waiting and "Suggest a change"
- Settings with script keys for commander-decks' `publish.py` and `pull.py`
- A Buy page (cards by store with cart links, dated prices and rule flags, "Mark bought", each order A to Z for sorting a delivery), Prints (each print order and the next one, with tiers and double-faced backs; Print with MakePlayingCards picks print-ready images from MPC Autofill and the Yama print helper for Chrome, `extension/mpc`, fills them into an MPC project, or writes MPC Autofill's order.xml; and a printable swap sheet: sort the prints into decks, then each deck's card in, card out and where the cut card goes) and Spares
- "I've put this in the deck" ticks
- "Swap in the prints" per deck, which gives the linked Yama deck its after-prints list, puts the prints in its box as proxies, moves cut cards to the deck that takes them next, the deck's swap bag box or Spares, and ticks the swaps installed

### Swap cards and deck-box inserts

Decks, Swap cards (`/decks/builds`) brings the deck as it is, its saved lists, tracked plans and
plan builds together under plain names ("Bracket 3: Upgraded"). Pick two complete lists to see
each change with its plan's reason, and print them as 2.5 × 3.5 inch duplex cards for the deck
box. Older now/after-prints snapshots stay under Older snapshots.

## Game night

### Life counter

1–6 players, rotated panels with the commander's art behind each life total (artist and copyright credited on each panel; switch to mana colors per device), commander damage and tax, poison and counters, monarch, initiative, day/night, undo, works offline and syncs later. Roll for first or pick who goes first (passing the turn never guesses it); knocking someone out asks who did it; the finish sheet asks how the game was won and how fun it was, and takes a note (all optional). An optional clock (per device, off by default) shows how long the turn and the game have run; it reads the times the game already records, so it works offline and a finished game's page says how long it ran. If people sat down somewhere other than setup put them, Swap places in the table menu trades two players' panels mid-game; turns then go around in the new order, and each player keeps their totals and history.

### Shared table

Every phone joins the game by QR code; the host phone stays in charge and works offline.

### Playgroups

Join codes (the owner can make a new one, and removing an account changes it), guests without accounts, a members list where anyone can leave and the owner renames the group, removes people, hands it on or deletes it, game history, logging games played without Yama, offline too (with game type, starting life, first player, knockouts, win condition, fun and a note), win rates by player and commander beside the share they'd win by chance, win rate by turn order (with playgroup.gg's 4-player figures until the group has 20 games), how games were won, head to head, archnemesis, first out and last out, streaks, fun. Every rate shows its count, under 5 games it's marked provisional, and the page says when it was computed. The computer's seats and games against only the computer stay out of players' records, table rounds and online player turns are averaged apart, and the commander table reads Commander games only.

### Game export

Every finished game you played or recorded, or a whole playgroup's, as JSON (shaped for commander-decks' `data/games.json`) or CSV (one row per seat), with each game's format and starting life and whether the computer played a seat. Dates are the local day in your time zone; other people's deck names and notes stay private.

## Online play

Commander on the [Phase](https://github.com/bryanroscoe/yama-phase) rules engine (`play/`), in alpha. It needs the engine card data ([engine integration](engine-integration.md)).

- An account can have 3 games open at a time (10 with an invite, 1 for a guest); the refusal at the limit says so and how to free a place.
- Lobby, friends join by code (the host can close a table that hasn't started, and delete a game that's over), choose who goes first or roll for it, AI seats (Easy/Medium/Hard) on your decks or stock precons, legal options only, auto-pass, per-seat hidden information, replay log saved after every move, games resume after a restart, final boards rebuilt from replays.
- A live game saved on an engine build this server can never run (anything but the current engine or the preserved v0.113 runtime) is stranded: it takes no place among the games you may have open, and its host may delete it from its page (optional: deleting removes it from everyone's history). Games only waiting for their engine to load or be installed aren't stranded. Every engine upgrade strands the games still in progress on the old one.
- Readable board on the Night table design: opponents across the top on their commander art, hover a card for a full-size preview (desktop), right-click, long-press or tap for the card with its rules text and your options for it.
- One big button says what it will do ("To combat", "Attack (2)", "Resolve")
- Attack and block by clicking creatures, with any legal declaration (not only the engine's sample)
- Pick a target on the board
- Pay mana automatically or by hand ("Tap mana for me", saved with your account), with Treasures, painlands, Phyrexian mana, convoke, delve, kicker and ward asked on the board
- Set your own stops on the phase ladder (saved with your account)
- Pass until something happens, pass the rest of the turn or pass to your turn (Enter, Shift+Enter, P), full control (F), hold priority and Resolve all
- Game settings for trigger yields, remembered answers (turned off there or from the log), hand order and conceding
- Read any card with its Oracle text, its state on the battlefield and its rulings, flipping two-faced cards
- Every player's graveyard, exile and command zone, each card saying how it got there
- Reveals shown to the players allowed to see them
- A game log of what happened, as each seat may know it, with filters (since your last turn, about you, spells, combat)
- Knockouts with their cause (saved with the game, with who did it and how the game was won where the engine says, for playgroup stats), keep watching after you're out, and a game-over screen with standings, the game's numbers, the finish sheet's questions (how it was won, how fun it was) and Rematch
- Ways to cast asked as their own choices (what cascade and discover went through and found, an adventure's two halves, madness and miracle, a modal card's two faces, alternative costs, mutate over or under), with cards you can cast from exile or a graveyard beside your hand
- The legend rule, clones, the Ring-bearer, equip and empower Jace picked on the board
- Proliferate, and moving or removing counters with steppers
- Decisions everyone takes part in, with each seat seeing the public part (votes cast in turn order with a tally, Fact or Fiction's piles split by one player and chosen by another, a villainous choice, coins and dice kept or ignored, a clash's revealed cards)
- Choosing a player on their commander's art (a gift, an opponent who chooses or separates, who a permanent enters under)
- The library's top or bottom, the Cultivate split, Telling Time's top and bottom, manifest dread, learn, and "Done looking" after your own reveal
- The rarer cards and rules (a morph cast face down, shown as a 2/2 with no name that only its controller can read, and turned face up for its cost; ninjutsu picked from your unblocked attackers; foretell; a companion revealed before the game and put into your hand for {3}; meld, cipher, Serum Powder at the mulligan, a dungeon chosen and its next room picked on the dungeon's map, time travel with remove one, leave or add one for each card, and loop shortcuts proposed and accepted or shortened)
- Answers Yama remembers for you for the rest of a game ("Always pay" for Rhystic Study and other unless-costs in mana, your commander to the command zone), each logged with Turn off
- An art credit under every battlefield
- Phones get opponent tabs, a hand drawer and a docked button
- Watch the computer play (`/play/watch`, `server/src/watch.rs`): 2 to 4 seats on your decks or stock precons, each with its own level, at 1x, 2x, 4x or straight to the end, with pause, single steps and hands face up. Open to every signed-in account: 10 new games a day, one at a time (power users have no daily count and, with an invite, 3 at a time). The page says the limit and what is left of it.

## Lab and evidence

### Simulation lab

One shared-field tournament with 4–256 distinct deck lists, randomized four-player pods, games-per-deck targets, optional precon benchmarks and per-engine rankings/matchups. Batch runner for all-AI games (`play/src/bin/lab.rs`, core in `play/src/lab.rs`); the Commander precon catalog and analysed rating runs imported from commander-decks, with read APIs; "Try a change" experiments played by the server (`/api/lab/experiments`, YAMA_LAB_THREADS isolated game processes, default 1). Pages under Decks, Lab: the precon table and pages (with links to EDHREC's corresponding precon guide and related articles), "Try a change", and your runs, including your imported batch runs. Needs the engine card data ([engine integration](engine-integration.md)).

Every signed-in account can start a simulation: one short run a day (20 games on Phase, one at a time; `YAMA_LAB_SHORT_DAILY_GAMES`). Power users run 100 games (100, 200 or 400 with an invite) and may choose Forge. The Try a change and Compare decks pages say the account's limit and what is left of it, a refusal says the limit, and the daily count is checked in the transaction that stores the run, so requests arriving together can't both pass. The assistant's lab tools are listed for every account.

Phase retry-tail progress shows the experiment's pending/retry counts and hides the normal-pace
ETA when only slow retries remain. A completed Phase half is labeled while Forge continues. This
is reporting, not a fix for engine stalls or changed timeout budgets.

The opt-in [lab worker pilot](lab-workers.md) lets an admin route Phase pods to saget, a laptop
or GitHub-hosted Actions, choose among available workers, and compare matching samples. It
includes owner-scoped worker keys and a manual Actions workflow; activation and deployment are
separate steps.

### Historical datasets

Lab, Datasets browses private imported commander/precon evidence, with name/type search, entity history, adjustable monthly recency summaries, source provenance and original downloads. Admins can upload prepared JSON/gzip datasets ([format](datasets.md)) and switch a source on for the precon pages, which then show each precon's dated real-game history, recent rate and trend, updated by every new upload.

Historical evidence can be imported as private, immutable [datasets](datasets.md) from JSON or
gzip, read through authenticated APIs and the `datasets`/`dataset` MCP tools, and inspected with
180-day-default descriptive monthly weighting. Overlapping snapshots, activity counts and undated
ELO sequences keep their own meanings; imports do not publish rankings or change decks and games.

### Public commander ranking

`/commanders` ranks commanders by real games alone, without sign-in: no simulations and no precon
lists. It combines the dataset sources an admin enables (Playgroup.gg and Mythic Tools), leads
with observed win rates and their game counts, and keeps each source's own rate, sample size and
attribution one click away. Reported games can overlap across services, so nothing claims a
count of unique games.

### Public precon reference

The public precon reference (`/precons`) serves stock lists, experimental meta rankings,
explicitly published Phase/Forge simulation evidence, attributed real-game results and dated
market references without sign-in. The personal Lab still requires sign-in. Results are published
with `publish-precons MANIFEST`; imports never publish automatically. See
[public precons and publication](public-precons.md).

Precon comparisons and detail pages show [source-backed upgradeability](precon-upgradeability.md)
for the whole package: all 619 stock-compatible in-box commander configurations across 174
precons are inventoried. Eighteen configurations have supported 1–5 assessments. The table names
the highest supported in-box grade and shows how many options remain ungraded. Fantastic Four
covers all four featured commanders plus Crystal and Power Pack. Legal comparison lists, source
dates, whole-box reviews and raw commander observations remain distinct from measured list
results. Public pages, Lab, APIs and MCP share the data.

## Assistants (MCP)

Yama exposes its own MCP server at `/mcp` for Ask Claude and outside clients: private deck,
collection and planner tools; staged edits; full online card search, community recommendations,
combos, public deck imports and current rules; deck/budget analysis and bounded mana checks. No
other Magic MCP installation is needed for those workflows. Write tools stage a change that waits
in Yama for its owner to apply or discard. See the public
[MCP feature and setup guide](https://yama.ing/docs/mcp/), [capabilities and use](mcp-parity.md)
and [connection design](mcp-design.md). The private [Codex and ChatGPT plugin](codex-plugin.md)
packages this connection with deck-building, collection-planning and research skills; it is not a
public listing.
