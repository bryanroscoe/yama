# Store shopping in Yama: design

Bryan, 1 Nov 2026: "We should find a way to put this into Yama." Today the shopping work lives in
the commander-decks repo as Python scripts and dated JSON (`scripts/shopping/buylist.py`,
`data/prices/local-*/`, `docs/local-stores.md`). This note says how Yama takes it over: stores and
how he feels about each, dated stock snapshots, one shopping list, and a trip planner that picks
the fewest stores. Slice 1 (below) is built on branch `feature/shopping-trips-20261101`.

It builds on the planner ([planner-design.md](planner-design.md): `plan_stores`, `plan_quotes`,
dated rule sets, the buy list in `packages/core/src/plan/buy.ts`) and on private research
([research-format.md](research-format.md): the `permanent_real_wishlist` scenario). Proposal
review's acquisition view (branch `feature/proposal-acquisition-20261027`, one commit, not merged
on 1 Nov 2026) answers a different question, "do I own this or must I buy it", for one staged
change; it reads `collection_items` and the same cheapest-market rule. The trip reuses that market
rule and doesn't duplicate the ownership count; a later slice feeds "must buy" cards from it into
the shopping list.

## What it answers

1. **Which stores to go to.** Bryan wants to visit as few stores as possible. Given everything he
   wants to buy and each store's dated listings, the trip picks the fewest stores covering the most
   cards under his buy rule, and shows each store's cards, its cart total and cart link, the best
   choice with fewer stores, and what is left to print, with the reason.
2. **His stores, his way.** Each person marks each store: **favourite, support them**, **fine to
   go**, **maybe, one trip** or **won't go**, puts them in order of how easy they are to get to, and
   can give a favourite a premium ("up to $0.25 more a card here"). Bryan, 1 Nov 2026: Black Castle
   Gamez (Cedar Park, 3.6 mi) is his favourite, "the most convenient by far and I want to support
   them... use them as much as possible"; Mothership (6.9 mi) is second closest; Pat's Games (11.7
   mi) "has the most stuff" but is "the most pain in the ass to get to"; Multiverse Hobbies (Hutto,
   13.4 mi) is "pretty good" and he is "pretty flexible"; "I can go to any four of those"; Alpha
   Strike (San Marcos, 44 mi) stays "won't go". On the Trip page he also ticks which stores he's
   going to this time, and the trip optimizes over those.
3. **One shopping list**: plan buy rows, approved pickups, cards for Yama decks that aren't in a plan
   (his cEDH "Kraum & Tymna" deck has four local buys), the long-term real-card wishlist by price
   tier, and sealed precons he might buy.
4. **Sealed precons at a store**, set against the sealed market and the singles inside
   (`server/src/deck_prices.rs` already has both).

## Rules carried over

- A listing is a **dated quote**, never a purchase or proof of stock now. A missing price is
  unknown, never $0, and is never summed. Nothing infers that something was bought: a card leaves
  the list only when the plan records its order, or he marks it bought (a claim, as today).
- **The buy rule is his, dated, and per user** (`plan_settings`). The trip judges every listing by
  the rule set in force **on the trip's day**: it is a decision made today. (The buy list's price
  flags still judge a listing by the rules of its check date, as the planner design says.)
- **Bryan's rule from 28 Oct 2026**, as a `local_buy` rule (new, optional, in the rule set's JSON):

  ```json
  "local_buy": {"max_usd": 2.0, "always_ok_usd": 0.5,
                "tiers": [{"market_under": 1.0, "max_multiple": 2.0}, {"market_under": null, "max_multiple": 1.5}]}
  ```

  At most $2.00; $0.50 or less whatever the market; otherwise at most 2× market when market is
  under $1, and 1.5× from $1. An unknown market qualifies only at $0.50 or less. Over $2: print it,
  and it stays on the real-card wishlist. Market is the listing's own printing when Yama knows it,
  else the cheapest non-foil copy, else the plan's recorded benchmark (`rules.ts`, as the buy list
  does). Foil and etched listings never qualify: the rule is for a plain copy.
- A rule set **without** `local_buy` (every set Bryan's export sends on 1 Nov 2026) is read from its
  ceiling (`ceiling_other_usd`, else `ceiling_key_usd`, else `always_print_over_usd`) and
  `max_over_market_pct`, and the page says so. For his 28 Oct set that gives "at most $2, at most 2×
  market, unknown market doesn't qualify", which is looser than his real rule between $1 and $2
  and stricter at $0.50 and under. **commander-decks should add the `local_buy` object above to the
  2026-10-28 row of `data/planner/settings.json`**; the importer already keeps unknown rule keys.
- **Sealed precons: at most $51 per deck, before tax** (28 Oct 2026). The rule key
  `sealed_max_usd` carries it.

### Account-level rules (built 1 Nov 2026)

Bryan, 1 Nov 2026: "The rule for the price might be something you configure on an account level...
make it easy to change." Plan settings, Shopping rules, shows the rule in force today and **Change
your buy rule**: the most a card may cost, the always-fine price, the market ranges (under $X: at
most Y× market; the last may be "any market"), and the sealed cap. The form starts from the set in
force (its `local_buy`, else the rule read from its older fields).

- **A save is a new dated rule set.** `POST /api/plan/settings` copies the set in force on that day,
  replaces `local_buy` and `sealed_max_usd`, and saves it with `origin = 'yama'` from that day (the
  device's today; the server takes yesterday to tomorrow in UTC). A second save the same day
  replaces that day's set. Older checks keep the set of their own day. **Undo this one** removes
  the newest set when it was made in Yama (`DELETE /api/plan/settings/{date}`, Yama-made only).
- **Yama and the import side by side.** The import still replaces only the sets it made.
  - **Same date:** a set made in Yama is kept; the imported one for that date is not applied, and
    the import report says so. (Before 1 Nov 2026 the import replaced it.)
  - **An imported set dated after a Yama one** is a newer decision from his export, and applies
    from its own date, as any set does. Its report warns, the first time that set arrives or
    changes, that it follows the set he made in Yama, so it never takes over silently.
  - **An imported set dated before a Yama one** (commander-decks adding `local_buy` to its
    2026-10-28 set later) changes only the days before the Yama set.
- **Claude** reads it with `shopping_settings` and stages a change with `set_shopping_rules`,
  which makes the same dated set on the day he applies it.

## Data model

| What | Where | Status |
|---|---|---|
| Stores (name, kind, location, cart link template, note) | `plan_stores`, from the plan import (`data/planner/stores.json`); Yama-made stores in planner slice 6 | Exists |
| **Store preferences** | `plan_store_prefs (owner_id, store_key, preference, note, updated_at)`, migration 0049; migration 0050 renames `default` to `favorite` and adds `hassle` (his order, from 1) and `premium_usd` (0 to $10). Keyed by store key, apart from `plan_stores`, so an import never overwrites them and a retired store keeps its preference when it returns. No row: "fine to go". | Built (slice 1, v2) |
| **Rule sets made in Yama** | `plan_settings` rows with `origin = 'yama'`, from Settings or the staged `set_shopping_rules` (see "Account-level rules") | Built |
| Dated listings for plan cards | `plan_quotes` (`stock_check`: store, checked date, in stock, price, printing, cart variant, URL) | Exists |
| Real-card wishlist | Research scenarios with `purpose: permanent_real_wishlist` (`research_reports`), one entry per card | Exists; the bundle now carries it as `wishlist` |
| **Stock snapshots** | `store_snapshots (id, owner_id, store_key, source, query, fetched_at, status, raw_gz, item_count)` and `store_listings (snapshot_id, owner_id, card_name, oracle_id, set_code, number, finish, condition, language, price, qty, variant, url)`. One snapshot is one dated read of one store (a whole catalog, or the answers for a card list). Listings are never edited; a newer snapshot of the same store supersedes an older one, as `newestChecks` does for quotes. The raw response is kept gzipped (newest 10 per store) so a parse bug can be fixed without fetching again. | Slice 2 |
| **Shopping list** | Derived, not stored: `packages/core` `shoppingList(bundle, decks, collection)`. Only the wishlist and sealed wants need new rows: `shopping_wants (id, owner_id, kind: card/sealed, name, oracle_id, product_id, qty, tier, why, source, added_at, retired_at)`, for cards he adds by hand in Yama. | Slice 3 |
| Sealed products | `sealed_products`/sealed prices already in `deck_prices.rs`; store listings of sealed product go in `store_listings` with `product_id` | Slice 4 |

Everything is owner-only, like the rest of the planner: stores, preferences, quotes and
snapshots are never shown to a playgroup.

### Where each view is computed

As the planner design says, derived views are TypeScript in `packages/core`, from the bundle, so
they work offline on the phone in a store. The trip is `packages/core/src/plan/trip.ts`
(`planTrip`). Claude's `shopping_trip` tool runs in the Rust server, so `server/src/plan/trip.rs`
is a port of `planTrip` over the same bundle JSON. Both are checked against one fixture,
`packages/core/src/plan/fixtures/trip.json` (`tripSummary` and `trip::summary` must equal its
`expect`), so they can't drift apart silently. Change both, then the fixture.

## The trip planner

**What it plans for.**
- **Needed** (they decide the stores): planned buy rows with no order item and no "bought it"
  mark, and proposals to buy that he answered **want** (approved pickups). Later slices add Yama
  deck cards that aren't owned and aren't in a plan.
- **Along the way** (only from stores already on the trip, never a reason to add a store): buy
  proposals he hasn't decided on (or is unsure about), and wishlist cards. Proposals he said no to
  are left out.
- Each card's listings are each store's newest check (a newer "sold out" replaces an older "in
  stock"), at a non-retired store that isn't a printer, in stock, with a price, not foil. Only those
  that qualify under the rule count.

**Choosing stores** (store preferences v2, 1 Nov 2026). A store is a candidate when he'll go to it
(not "won't go"), it is local when his rule set says `buy_local_only`, it is ticked under "Going
this time" (all are, until he unticks one; `?stores=` on the page, `stores` on `shopping_trip`),
and it has a qualifying copy of a needed card.

- **A favourite with a qualifying needed card is on every trip.** "Use them as much as possible."
- The other candidates are searched exhaustively (up to 12; 4,095 subsets), each subset together
  with the favourites. With more than 12, a greedy cover picks the stores searched (the rest of a
  longer cover goes on every trip), so every coverable card is reached but the fewest stores is
  approximate. For each number of stores, the best subset
  covers the most needed cards, then has the fewest "maybe" stores, then is **easiest to get to**
  (the lowest sum of the stores' places in his order), then has the lowest total.
- The trip is the smallest set that covers as many cards as any set can; the smaller sets that
  cover fewer are shown as "with fewer stores" ("Black Castle alone: 2 cards, $1.50"), so he can
  decide that one card isn't worth a drive.
- **Each card goes to its cheapest qualifying copy among the chosen stores after each store's
  premium**: a favourite with a $0.25 premium gets a card listed at $0.75 when the cheapest other
  copy is $0.50. Ties go to the preferred store (favourite, fine, maybe), then the easier one, then
  store order. The premium never lets in a copy the rule refuses, and totals are listed prices.
- **The order.** `hassle` is his place for the store, from 1 (easiest). Stores he hasn't placed
  come after those he has, in the plan's store order. Moving a store on the Trip page saves every
  store's place, so the order is entirely his.

**What's left, and why** (each needed card not on the trip, first reason that applies):
only at stores he left off this trip (named); only at a store he won't go to (named); over the rule's limit (print it, keep it on the wishlist);
above the rule for its market; no market to judge it by; in stock with no price (ask); not in
stock at the last check; no check recorded. "Won't go" stores with cards he needs are listed with
the count, so the cost of the preference is visible.

**Wishlist tiers.** The wishlist is grouped by cheapest non-foil market: $200 and up, $50 to $200,
$10 to $50, $2 to $10, under $2, and no market price, each with its total at market (the cEDH
real-card wishlist of 31 Oct 2026 uses the same tiers).

## Store queries: what Yama's server can run, and what comes in an import

The server would run these itself (slice 2), only when the person asks ("Check stores" on the Trip
page, or a staged MCP change they apply), for their own stores, with the card names of their own
list. Hosts come from a fixed connector per store kind, never from a URL the person types, so it
isn't an open fetcher. One request at a time per host, a pause between requests, a daily cap per
account, and each response kept as a snapshot.

| Store kind | Query | Gives | Notes |
|---|---|---|---|
| Shopify storefronts (Pat's Games, Mothership) | `GET /search/suggest.json?q="<card>"&resources[type]=product&resources[limit]=10`, paging the storefront search for more printings, then `GET /products/<handle>.js` | Each printing's variants: condition, price, available, variant id (a cart line) | As commander-decks' `data/prices/local-2026-10-31-cedh/search.py`. Exact-name match, then set and number from the product title. |
| TCGplayer Pro storefronts (Multiverse Hobbies, Black Castle) | `POST /api/catalog/search` with `{"query":"","context":{"productLineName":"Magic: The Gathering"},"filters":{},"from":0,"size":5000}` | The whole in-stock catalog: product, set, `lowestPrice` only | No condition or variant, so no cart line and no per-condition price: listings are "from $X". Multiverse's 1 Nov catalog had 2,098 singles and no sealed product. Black Castle refuses scripts (works from a browser tab), so it comes as an import. |
| YesTCG (about 53 Austin stores; about 10 with searchable stock, Multiverse among them with conditions) | `GET https://yestcg.com/api/decksearch?q=<card>&market=austin&game=mtg` after loading `https://yestcg.com/` for its cookie, with `Referer` and `X-Requested-With` | Per store: name, set, condition, price, shipping for marketplace stores, matched market | A store that failed in a response is unknown stock, not absent. Uses an aggregator's undocumented API: run it only on request, at most 4 at once, and drop it if they object. |
| In store only (Card Gurus) and anything a script can't reach | — | — | Import only: a stock check typed in Yama, or `plan_quotes` from the export. |

Until slice 2, every listing comes from the plan import (`plan_quotes`), as today. A
`yama-store-snapshot/1` file (store key, source, fetched time, the query, listings) can also be
imported, so commander-decks' existing scripts keep working and their output lands in Yama.

## Sealed precons (slice 4)

For a sealed product at a store: the store's price (dated), the sealed market (`deck_prices::sealed`,
dated), and the singles inside (`deck_prices::singles`, priced and unpriced copies counted
separately, never $0 for unknown). It flags a price over `sealed_max_usd` ($51 for Bryan) and
says how it compares with the market. Gameplay value and purchase price stay separate, and the
singles value is a market estimate, not what he could sell them for (AGENTS.md's valuation rule).

## Claude's tools (MCP)

Read (built):

| Tool | Returns |
|---|---|
| `shopping_trip` (`today`, `stores` optional) | The trip in words: the rule and its date, check dates, each store with its preference, cards, cart link and total, what comes along, the best with fewer stores, what to print and why, skipped stores, and the wishlist by tier |
| `shopping_settings` | The rule in force today and every dated set with its origin, the sealed cap, and each store's preference, place in the order and premium |

Staged writes (built with migration 0050, which rebuilds `assistant_changes` for its `kind` CHECK),
applied by the person in Yama: `set_shopping_rules` (a new dated set on the day they apply it) and
`set_store_preference` (one store's level, place and premium; unspecified parts stay as they are).

Later, read: `shopping_list` (every want with its source and status), `store_stock` (one store's
newest snapshot for given cards). Staged: `check_stores` (fetch snapshots for a card list),
`add_wish`.

## Slices

1. **Built:** store preferences (table, `PUT /api/plan/stores/{key}/preference`, the bundle's
   `store_prefs`), the wishlist in the bundle (`wishlist`), `planTrip` with `local_buy` rules and
   wishlist tiers, the Trip page (`/decks/plan/trip`) with the store choices, and `shopping_trip`.
1b. **Built:** account-level rules (Settings, `shopping_settings`, `set_shopping_rules`) and store
   preferences v2 (favourite, order, premium, "Going this time", `set_store_preference`).
2. Stock snapshots: tables, the Shopify, TCGplayer Pro and YesTCG connectors on request, the
   snapshot import, and the trip reading snapshots beside `plan_quotes`.
3. One shopping list: Yama deck cards not owned and not in a plan (the cEDH deck), hand-added wants,
   and the list view with sources; the acquisition count from proposal review.
4. Sealed: store sealed prices against market and singles, and the $51 rule.
5. Staged MCP writes (`set_store_preference`, `check_stores`, `add_wish`).

## Open questions for Bryan

- Should a "maybe" store need more than one card to be worth the trip? Today one card is enough,
  and "with fewer stores" shows what skipping it costs.
- Should a favourite's premium be per card (today) or a percentage of the price?
- The trip uses today's rule for every listing. Is that right for listings checked under an older
  rule (the buy list keeps judging those by their own day)?
