# Yama (Yet Another Magic App): architecture proposal

A private Magic app for Bryan and friends, on phone (iOS and Android) and in the browser. It does two jobs on one account:

- **Play:** Commander online against friends or AI, with every game stored and replayable.
- **Companion:** what Mythic Tools does today (life counter, playgroups and stats, card scanner, collection, prices, card lookup and decks), plus links to Play that Mythic Tools can't offer.

Status: proposal written 2026-10-17; building started 2026-10-18. See README.md for what works today. Repo and app-store facts below were checked on 2026-10-17.

**Changed 2026-10-18:** the database is SQLite (WAL mode), not Postgres. At friend-group scale one file next to one server process is simpler to run and back up (e.g. Litestream to object storage), and this machine has no Docker. The schema avoids Postgres-only features, so moving later is a migration, not a rewrite.

## 1. What we're building

| Area | Features | Matches Mythic Tools | Beyond Mythic Tools |
|---|---|---|---|
| **Play** | Online Commander (2 to 4 players), AI seats, lobby and invites, replays | n/a | The whole area |
| **Table** (life counter) | Life, poison, commander damage, monarch, initiative, day/night, energy and other counters, turn timer and chess clock, themes | ✓ | Every phone at the table joins one shared game by QR code. Works offline. |
| **Playgroups and stats** | Friends, guest players with no account, game log, win rates by deck, player and commander | ✓ | In-person and online games feed the same stats |
| **Scanner** | Camera scanning straight into the collection, with set, finish and condition | ✓ | Open model, runs on the phone |
| **Collection** | Containers (binders, decks, lists, boxes), condition, finish, language, purchase price, bulk edit, CSV import and export | ✓ | Imports Mythic Tools CSV losslessly. Shows owned/needed for each deck, spares and proxies. |
| **Prices** | Daily market prices from Scryfall (TCGplayer, Cardmarket), with history | ✓ | Dated snapshots kept, never shown as $0 when missing (same rules as `commander-decks`) |
| **Cards** | Scryfall-style search, Oracle text, rulings, legality | ✓ | Works offline |
| **Decks** | Deck list, folders, precons, coverage check, playtesting | ✓ | Test a deck against AI with the real rules engine (Play). |

Getting off Mythic Tools has to be painless. Mythic Tools has no API, but its CSV export (`commander-decks/data/collection/mythic-tools-export-*.csv`) has everything we need: Scryfall ID, set, collector number, quantity, condition, finish, language, altered/signed/misprint/proxy flags, container type and name, and purchase price. Import should map every column and make no guesses.

## 2. Apps and code layout

**One React and TypeScript codebase for web and mobile, with Capacitor wrapping it as the iOS and Android apps.**

Why not the alternatives:

- **React Native or Expo** gives better native camera access. But the game board we want to reuse from phase is React DOM (Tailwind, Framer Motion). We would end up writing the UI twice.
- **Tauri mobile** is what phase uses for Android. Its plugin ecosystem (camera, Google sign-in, offline database, push) is thinner than Capacitor's.
- **PWA only** can't get offline storage or the camera reliably enough on iOS for a scanner and life counter people rely on.

Capacitor lets us drop to native code where the web view is too slow. The scanner is the one likely place (section 6).

```
yama/
  apps/web/            React + Vite: the whole UI
  apps/mobile/         Capacitor shell: same build + native plugins (camera, SQLite, Google sign-in, haptics, keep-awake)
  packages/core/       TS domain logic: life counter state machine, collection ops, deck validation, search query parser
  packages/api/        TS types generated from the Rust server (tsify / OpenAPI)
  packages/board/      Game board, forked from phase's client
  server/              Rust workspace: api, game-host, jobs (card data, prices, scanner catalog)
  engine/              phase-rs fork (git submodule), pinned
  scanner/             Model, catalog build pipeline, eval set of our own card photos
```

**Distribution to friends without a public store listing:**

- **iOS:** TestFlight. This needs the Apple Developer Program ($99/yr). External testers need a one-time beta review.
- **Android:** a direct APK, or Play internal testing.
- **Web:** everything works in the browser too.

Keeping Yama out of the public stores also keeps it private, which matters for the legal side (section 11).

## 3. Rules engine (Play)

Unchanged from the first draft. Build on **[phase-rs](https://github.com/phase-rs/phase)** (MIT or Apache-2.0). It's a Rust engine that compiles to WASM, with a React client.

- It supports 92.5% of Commander cards: 30,494 of 32,950.
- It has replays as seed plus action log, reconnect, spectators, and both heuristic and LLM AI seats.
- Our two full 100-card lists each have one card it can't run yet: **Negative Zone Portal** (Fantastic Four) and **Combat Celebrant** (Riders of Rohan).

The alternatives:

- **Forge** (GPL-3.0, Java): the best AI and coverage, but a desktop app.
- **XMage** (MIT, Java): self-hostable, but a desktop client and a weak AI.
- **manabrew** (AGPL-3.0): a Rust port of Forge, still early.
- **Writing our own:** years of work before it can run real decks.

Put the engine behind a `RulesEngine` trait (new game, legal actions, apply, per-player view) so it can be swapped later.

Where our own rules work goes:

- Implementing the cards our decks need and sending them upstream.
- Our own multiplayer AI (section 7).
- House rules.

## 4. Backend

```
 Phone app (Capacitor)  ─┐                ┌─────────────────────────────────────────────┐
 Browser                ─┼── HTTPS ──────▶│ Rust server (Axum, Tokio, sqlx)             │
                         └── WebSocket ──▶│  api:       auth, users, playgroups, decks, │
                                          │             collection, sync, search        │
                                          │  game-host: live online games (one task     │
                                          │             each) and live table rooms      │
                                          │  jobs:      Scryfall bulk import (weekly),  │
                                          │             price snapshot (daily),         │
                                          │             scanner catalog rebuild (per set)│
                                          └───────────────┬─────────────────────────────┘
                                                          │
                       SQLite ─ users, playgroups, games, events, decks, collection, cards, prices
                       Object storage (R2/S3) ─ scanner model + catalog, replay snapshots, CSV exports
                       Scryfall image CDN ─ card images (cached on device, never re-hosted)
```

- **One Rust server and one SQLite database.** At friend-group scale this runs on one Fly.io machine or a small VM.
- **Game state:** live games and table rooms sit in memory and are rebuilt from the event log after a restart.
- **Auth:** Google OIDC with an invite allowlist. Native Google sign-in on mobile; the server checks the ID token and issues our own session token. Password accounts (argon2id) are created only from the server's command line (`yama-server user add`), for debugging, test players, or when Google is unavailable. The email-only dev login works only when the server listens on localhost.
- **Play is server-authoritative.** The server sends each seat only what that seat may see, which protects hidden information. Clients send `{expected_revision, action}`. The server checks the action against the engine's legal list, applies it, appends the event and broadcasts filtered views. Details are in the first draft and carry over unchanged.

## 5. Offline-first data (Table, Collection, Cards)

Game night has bad wifi, so the companion features must work without a connection.

- **Local store:** SQLite on mobile (Capacitor SQLite plugin) and IndexedDB on web, behind one TS repository interface in `packages/core`.
- **Writes are operations, not overwrites.** Each change is an op with a client-generated UUID, such as `{op_id, entity, kind: "adjust_qty", delta: +1, at}`. Ops queue locally and sync when online. The server applies each op once, so retries are safe. Quantity deltas merge cleanly when two devices edit the same card. Plain fields (condition, container) use last-writer-wins.
- **Offline card data:** a compact card database (Oracle text, types, color identity, legality, image URLs) ships with the app and updates with each set. Size not yet measured; it will be tens of MB. Search runs locally on it, using our own parser for the subset of Scryfall syntax we use (`t:`, `o:`, `id:`, `c:`, `cmc`, `f:`, `is:`).
- **Prices** download as a daily delta. Every price carries its date and source. A missing price stays missing (shown as "no price"); it never becomes 0.

## 6. Scanner

The proven approach is: find the card's four corners, straighten the image, turn it into an embedding (a compact numeric fingerprint), and look up the nearest match in a catalog of every printing. Optionally, OCR the collector number to break ties between printings.

- **[CollectorVision](https://github.com/HanClinto/CollectorVision)** does exactly this. ONNX models (portable neural-net files) for corner detection and 128-number embeddings, a catalog of about 108,000 printings keyed by Scryfall ID (53 MB), under 100 ms per scan on a laptop CPU, and an experimental in-browser scanner. Its catalog updates regularly ([CollectorVisionCatalog](https://github.com/HanClinto/CollectorVisionCatalog), MIT).
- **Catch:** the CollectorVision code is **AGPL-3.0**, with a commercial license available. If Yama is open source under a compatible license, we can use it directly. If Yama stays private, we either write our own pipeline (the approach isn't hard; the trained models are the valuable part) or contact the author. Decide before we use any of it.
- **Plan:**
  1. Spike in the web view with `onnxruntime-web` (WebGPU or WASM) on Bryan's iPhone. Target: under 250 ms per frame, with a live box around the card and a beep or haptic when it locks on.
  2. If that's too slow, move inference to a native Capacitor plugin: Core ML on iOS, ONNX Runtime Mobile on Android.
- **Picking the right printing:** the embedding narrows it to a few printings. Then the collector-number and set-code OCR (iOS Vision or ML Kit), the user's recent set, and a one-tap correction pick the right one. Finish (foil or etched) and condition are user toggles; foil detection from a camera is unreliable.
- **Eval set:** photograph our real cards (the October purchases are a ready-made labeled set: `data/purchases.json` lists set and collector number) and track accuracy on every model or catalog update.

## 7. AI opponents (Play)

AI seats run on the server and go through the same legal-action path as humans.

1. **Day one:** phase's heuristic and search AI.
2. **Our project:** an MCTS (Monte Carlo tree search) seat that guesses the hidden cards and simulates many games ahead, with 4-player threat assessment and deck-aware plans. We tune it by running AI-vs-AI games in bulk with our real decks, which also finds engine bugs.
3. **Opt-in Claude seat:** using phase's `phase-llm` pattern, the model picks the index of a legal option and the engine checks it again.

## 8. Table mode (life counter)

- **State:** a pure reducer in `packages/core`: `apply(tableState, event)`. Events: life ±n, poison, commander damage (source commander → player), counters, monarch and initiative, turn pass, timer ticks.
- **One device:** works fully offline. The event log goes into the sync queue as an in-person game.
- **Shared table:** one phone hosts and shows a QR code; the others join a room over the same WebSocket infrastructure. Each player updates their own totals, and everyone sees the shared state. If the server drops, the host phone keeps going and syncs later.
- **Ending a game** records the winner, the decks (from the user's deck list), turn count and length. In-person games use the same `games` table as online ones (`mode = in_person`), so stats cover both. Results can be exported to `commander-decks/data/games.json`.

## 9. Data model (first cut)

```
-- identity
users(id, google_sub, email, display_name, invited_by, created_at)
playgroups(id, name, owner_id) ; playgroup_members(playgroup_id, user_id NULL, guest_name NULL)

-- cards and prices
cards(oracle_id, name, type_line, color_identity, legalities jsonb, oracle jsonb, updated_at)
printings(scryfall_id, oracle_id, set_code, collector_number, lang, finishes, image_uris jsonb)
price_snapshots(scryfall_id, date, source, usd, usd_foil, usd_etched, eur, eur_foil)  -- NULL = no price

-- collection
containers(id, owner_id, kind[binder|deck|list|box], name)
collection_items(id, owner_id, scryfall_id, qty, condition, finish, lang, altered, signed, misprint,
                 proxy, container_id, purchase_price, purchase_currency, acquired_at, source jsonb)
collection_ops(op_id PK, owner_id, device_id, payload jsonb, applied_at)          -- sync dedupe

-- decks
decks(id, owner_id, name, folder, commander_oracle_ids, current_version_id, container_id NULL)
deck_versions(id, deck_id, cards jsonb, created_at, engine_coverage jsonb)

-- games (online and in-person)
games(id, mode[online|in_person], playgroup_id, status, format, engine_version NULL, seed NULL,
      started_at, ended_at, result jsonb)
game_seats(game_id, seat, user_id NULL, guest_name NULL, ai_kind NULL, deck_version_id NULL,
           final_life, eliminated_at, eliminated_by)
game_events(game_id, seq, actor_seat, kind, payload jsonb, created_at)  -- engine actions or table events
game_snapshots(game_id, seq, state bytea)
```

A seat's `deck_version_id` must be a version of one of the game creator's decks (lending a deck counts) or of the seated account's own decks; anything else gets 404 when the game is logged (2026-10-18).

**Deck planner** (migration `0006_planner.sql`, `server/src/plan/`; design in `docs/planner-design.md`, file format in `docs/plan-format.md`). Every user gets the same tables on their own rows:

```
plan_meta(owner_id, revision, head_import_id, head_hash, ...)    -- head; revision is part of the bundle cache key
plan_imports(id, owner_id, content_hash, meta, via, report, document_gz)   -- the newest 10 keep their upload
plan_settings, plan_stores, plan_decks(key, source import|yama, status, commander, bracket, groups, notes)
plan_states(plan_deck_id, state, content_hash, cards, log, current)        -- lists, kept once per distinct list
plan_orders, plan_order_items, plan_swaps(ext_key, stage, role, src, got, ...), plan_key_aliases, plan_quotes
plan_inputs(seq global, op_id, kind, for_export, status), plan_reviews, plan_marks   -- taps as ops (slice 4)
api_tokens(owner_id, token_hash, scopes, expires_at, revoked_at)                  -- script keys (slice 4)
```

- An import is idempotent against the head only. The key is the SHA-256 of the exact bytes of the file's `plan` value. The same hash writes nothing; any other hash applies, even an older file.
- Rows keep their ids across imports by key. A row missing from a newer file is retired (decks are archived) and restored if it comes back. Answers and ticks are keyed by text and follow renamed keys through aliases.
- Planner rows store card names, never oracle ids. Names are resolved when the bundle is built, so a card Scryfall adds later resolves without a new import. A list's identity is its `[board, name, qty]` set.
- `GET /api/plan/bundle?rev=` returns everything the plan pages need. `rev` combines the plan revision with the finish time of the latest card or price import, so a daily price import makes phones fetch again, plus a tag for the owner, so one person's cached bundle never counts as current for another. The planner never writes `price_snapshots`. Its market price is the cheapest non-foil price among printings priced within three days of the card's newest price, given with its date and source. Only real, tournament-legal paper printings count: gold-bordered World Championship Decks and Pro Tour Collector Set cards, Collectors' Edition, 30th Anniversary Edition and oversized cards are left out by a fixed set list, because the printings table has no border, oversized or set-type column.
- Every query binds the caller's id. Cascading links use composite `(id, owner_id)` foreign keys, so the database refuses cross-owner links. `SET NULL` links are owner-checked in code.
- The pages (slice 3, read-only) live under the Decks tab: a Decks | Plans control (`web/src/plan/DeckTabs.tsx`; a section is one line), `/decks/plan` and `/decks/plan/d/:key`. Every derived view (copy text, diffs, change groups and statuses, bracket builds, the proposed build, "where it came from" sentences) is pure TypeScript in `packages/core/src/plan`, imported as `@yama/core/plan`. The bundle is cached in IndexedDB as `plan:<user id>`, so the pages open offline; signing out deletes it first, because it holds prices paid. Plan files are uploaded byte for byte.
- Taps on the plan pages are ops with client-made ids (`POST /api/plan/inputs`): review answers, installed ticks, "bought it" marks and ideas. The web outbox keeps them in localStorage per user until the server has them, so answers survive no signal; a retried op is answered `duplicate`. Each op runs in its own savepoint, so a bad one is stored as rejected and never blocks the rest. Answers and marks are full records, last writer wins: the later UTC `at` (whole seconds, clamped to five minutes after arrival), then Yama over an import, then the larger op id, so the result doesn't depend on arrival order. A clear is a tombstone. "Bought it" is a claim and never becomes an order by itself.
- Ops on an imported deck (or a key that matches nothing) are for the export side. Its scripts (commander-decks' `publish.py` and `pull.py`) use a script key: `yama_pat_` plus 64 hex digits, stored hashed in `api_tokens` with the scope `plan:sync`, accepted only by the `SyncUser` extractor on `/api/plan/import`, `/api/plan/head`, `/api/plan/inbox` and `/api/plan/inbox/ack`. `CurrentUser` never accepts one (it looks tokens up in `sessions`), so a key gets 401 everywhere else, including WebSockets; keys are never admin and can't make keys. People make and revoke keys in Plans, Settings; revoking someone's invite revokes theirs. The inbox cursor (`plan_meta.pulled_through`) lives in Yama, so the repo keeps none, and `seq` is a global AUTOINCREMENT.
- Buy, Prints and Spares (slice 5) are views computed on the device from the bundle (`packages/core/src/plan/{buy,prints,spares,rules,overview}.ts`), so they work in a store with no signal. The buy list takes proposals to buy that weren't answered no and planned buys with no order, and puts each in the store with the cheapest listing that can go in a cart, from each store's newest stock check (a newer "sold out" beats an older "in stock"). Totals add only known prices and count the rest as "without a listed price", never as $0. Price flags come from the owner's dated rule sets: a price is judged by the set in force on its check date (a purchase, on its order date), against Yama's price for the listing's own printing, else the cheapest non-foil copy, else the plan's recorded benchmark, and every flag names the price it used and its date. A market price more than three days older than Yama's newest price is shown as "last priced", and the Buy page says when Yama's prices stopped updating. Spares are read from the stored lists the way commander-decks' `library.py` builds them (stock with the owner's own changes, minus now; now minus after), so a card counts as out only when its list says so; a stand-in's recorded later cut is shown as a suggestion, not applied. Installed ticks and "bought it" marks are ops (above); a marked card leaves the buy list's totals and carts but isn't an order until the plan records one.
- Two routes change no plan content, so they work on imported plans too: `PATCH /api/plan/decks/{key}` links the owner's Yama deck (a plan's order stays with its export, 409), and `POST /api/plan/decks/{key}/yama-deck` makes a Yama deck in the folder "Plans" from a stored list. It refuses lists with cards Yama doesn't know (400 with the names), and its version note names the list's content hash, so asking twice returns the same deck.

Linking a deck to a container is what powers owned/needed: each deck list is checked against the collection, so you see what's in the binder, what's in another deck, and what still has to be bought or printed. That's the job the `commander-decks` scripts do today (`docs/spares.md`, scan checks). Yama could take it over later.

## 10. Milestones

0. **Now, no code:** keep using Mythic Tools and play on phase-rs.dev or XMage. Note what annoys us.
1. **Foundation:** monorepo; Rust server; Google login with allowlist; Scryfall card import; card search and lookup on web.
2. **Companion v1 (quick wins on mobile):** the Capacitor app, the offline life counter (single device), playgroups, guest players, game logging and stats. TestFlight build to friends.
3. **Collection:** Mythic Tools CSV import and export, containers, bulk edit, daily prices with history, decks with owned/needed. Import `commander-decks` deck lists.
4. **Play v1:** solo game vs AI in the browser, then 4-player online with friends: lobby, invites, reconnect, timers.
5. **Scanner:** web-view spike, then native fallback if needed; eval set from our purchases.
6. **Shared table mode and replays:** multi-phone life counter; replay viewer; stats across online and in-person games.
7. **Depth:** our own MCTS AI; Claude seat; card fixes upstream; deck playtesting from the deck page.

Companion comes before Play because it's smaller and we'd use it every game night. The foundation (auth, cards, decks) serves both.

### Progress (2026-10-18)

| Milestone | State |
|---|---|
| 1 Foundation | Done |
| 2 Companion v1 | Done on the web and as an installable web app. Native apps wait on Xcode and the Apple account |
| 3 Collection | Done, except bulk edit and a price-history view (the history is stored) |
| 4 Play v1 | Working: lobby, friends by code, AI seats, reconnect, restart recovery. No turn timers yet |
| 5 Scanner | Research spike in progress (docs/scanner.md) |
| 6 Shared table and replays | Shared table done. Final boards are rebuilt from replays; a step-through viewer isn't built |
| 7 Depth | Sample hands done; the rest not started |

### How online play ended up working

- **Engine:** phase v0.113.0 from a local fork (`../yama-phase`, one commit so it builds on stable Rust), wrapped by `play/` (`Engine`, `Match`). `soak` plays Bryan's decks AI-vs-AI and checks that the replay log reproduces the game.
- **Board:** we didn't fork phase's 1,400-file client. Each decision is the engine's own option list (`AiDecisionContract`), the same list the AI chooses from, shown as plain-language buttons. Tapping a card filters the list to options for that card. The server sends each card's full-size image and rules text with every view, so any card can be read at full size (hover preview on desktop, a card sheet on phones). Every option is legal by construction, every engine decision type works from day one, and the UI can grow special cases (drag to attack, mana payment) later.
- **Smart stops:** the server passes for a person unless:
  - it's their main phase,
  - the stack holds something they could answer (land abilities alone don't count),
  - or they could cast a spell at an opponent's end step.

  A full-control switch turns this off.
- **Runtime:** one OS thread per live game with a 32 MiB stack, because the AI search recurses deeply. Views go out over a `watch` channel and WebSocket. The replay log and public log lines are saved after every change, and live games resume after a restart by replaying the log.
- **Hidden information:** Yama's own view type never includes libraries or opponents' hands. phase's filtered state still names opponents' library cards internally, so never send the raw engine state to a client.

## 11. Risks

- **Legal and IP:**
  - Stay inside Wizards' Fan Content Policy: free, non-commercial, an "unofficial, not endorsed by Wizards" notice, no Wizards logos, and no card images or rules documents shipped. Images come from Scryfall at runtime, under its rules (keep the artist and copyright visible, no cropping or recoloring, no paywall).
  - Companion apps like Mythic Tools are common in the app stores. A full game client in a public store listing is a bigger target. Distributing through TestFlight and an APK keeps us private.
- **Engine maturity:** phase is seven months old, mostly from one maintainer, with about 1,559 open issues. Pin it, run AI soak tests before each upgrade, and keep the trait boundary.
- **Replay drift:** a replay only reproduces on the engine version that recorded it. Store `engine_version` and keep old WASM builds or snapshots.
- **Scanner:**
  - License (AGPL), and accuracy on foils, sleeves and bad lighting, especially when telling printings apart.
  - The eval set and one-tap correction contain this.
- **Prices:** Scryfall prices are market reference prices, not availability or checkout quotes. Label them that way. As far as I know, TCGplayer's own API is closed to new developers (not rechecked), so Scryfall is our price source.
- **Scope:** this is several apps. The milestones deliver something usable at each step; stop wherever it's good enough.

## 12. Questions for Bryan

Answered 2026-10-18:

- **Engine:** phase.
- **Repo:** private, with local git only.
- **Hosting:** Bryan's Unraid server, saget. The public route uses the existing Cloudflare tunnel; see deploy/README.md.
- **Phones:** Android only, with no Apple account. The installable web app is the phone app; Capacitor stays optional.

Still open:

1. Which Mythic Tools features do your friends actually use?
2. Should Yama eventually replace the `commander-decks` scripts, or stay separate and only export?
3. Sign-in: Cloudflare Access (recommended) or Google sign-in. Either one needs a few minutes of setup in Cloudflare Zero Trust or Google Cloud.

## Sources

- phase-rs: <https://github.com/phase-rs/phase>; coverage data `https://data.phase-rs.dev/coverage-data.json` (downloaded 2026-10-17)
- Forge <https://github.com/Card-Forge/forge>; XMage <https://github.com/magefree/mage>; manabrew <https://github.com/witchesofthehill/manabrew>
- Mythic Tools App Store listing: <https://apps.apple.com/app/id1669698500>
- CollectorVision: <https://github.com/HanClinto/CollectorVision>; catalog <https://github.com/HanClinto/CollectorVisionCatalog>
- Other scanners reviewed: <https://github.com/matteot11/open-card-collector> (MIT), <https://github.com/cfbender/oracle> (MPL-2.0), <https://github.com/GrimbiXcode/mtgscan> (GPL-3.0), <https://github.com/fortierq/mtgscan> (MIT)
- Scryfall API and bulk data: <https://scryfall.com/docs/api>, <https://scryfall.com/docs/api/bulk-data>
- Wizards Fan Content Policy: <https://company.wizards.com/en/legal/fancontentpolicy>
- Comprehensive Rules: <https://magic.wizards.com/en/rules> (latest edition found: effective 2026-06-19)
