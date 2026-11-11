# Private deck research

Research lives under **Decks, Research**. It is separate from installed decks, collection cards,
the legacy upgrade planner and pending executable changes. Saving a document or preferring a
build approves none of those actions. Bracket alternatives are complete, mutually exclusive
lists. Gameplay profiles explain setup, pressure, finishers, interaction, consistency, recovery and weaknesses. They are editorial judgments, never inferred win rates. Official Commander brackets run from 1 to 5; 5 is cEDH.

MCP `save_research({document})` and session `POST /api/research` store a private
`yama-research/1` report. Through the MCP, a document that drops a deck or build one of your plans
tracks is refused, and nothing is saved, unless the call also passes `stop_plans: true`: saving it
would archive that plan and retire its swaps. `get_research()` lists reports; `get_research({id,deck?,build?})` reads a report
and its reviews. A focused deck read excludes unrelated global shopping scenarios and narrows
store evidence. The same file can be imported on the Research page or with
`yama-server import-research FILE --owner EMAIL [--dry-run]`.

**Sharing (2026-10-31).** A note starts private. Its owner can share it like a deck: `link`
(anyone with `/r/<token>`) or `public` (that, and listed under "Plans" on their profile),
from "Share this plan" on the plan's page, `PUT /api/research/{id}/sharing {visibility}`, or
`yama-server research share --owner EMAIL --id ID --visibility link [--reset-link]` on the
server. `POST /api/research/{id}/share-link` makes a new link and ends the old one. Refreshing
a note keeps its visibility and link. The public pages show only the guide part of the
document, through an allow-list (`deck_research::public_view`): title, summary, and per
deck its name, commander, summary, warnings, mechanics, sources, recommended build, pilot notes
and builds (label, bracket, why, risks, Game Changers and their reasons, gameplay profile, swaps
with their reasons, and the full list). Review answers and notes, ownership, installed state,
acquisition evidence, scenarios, accounting, local checks, `method` (which often carries
acquisition rules and price ceilings), combos and any other field stay private. Free text in the
fields shown is published as written, so an owner should read summaries before sharing. Each deck page shows one build (`/r/<token>/<deck>?build=<id>`) with its changes as a
table and the list as stacks or a list; `/r/<token>/<deck>/<build>-{names,moxfield}.txt`
downloads it. The shopping lists on the note and deck pages price the added cards three ways
(`?get=` empty, `buy` or `print`); the default buys cards up to a limit and prints the rest. The
reader sets that limit with the dollar field under the choices (`?upto=<dollars>`, $0 to $1,000,
$2.00 when absent, at most two decimals), and every link on the page keeps it. The owner's plan
pages in the app have the same field (`/api/research/<id>/view?upto=`). It is the reader's own
choice, never the owner's acquisition rules.

**The owner's pages (2026-11-04).** In the app a note is a plan (Decks, Plans) and its pages
show the shared pages' sections in their order, from the same Rust: `GET /api/research/{id}/view`
(`?build=`, `?builds=all`, `?get=buy|print`) gives each deck's commander art and the shopping list,
and `GET /api/research/{id}/view/{deck}` (`?build=`, `?vs=`, `?get=`) the changes with card images,
what the added cards cost at market and the list as cards; `GET /api/research-plans` gives every
note's tile (deck count, who it was copied from, up to four commanders' art). All are the owner's,
private or not. The owner's page adds sharing, answers and the agent's evidence when the note has it.

**Tracking a build as the deck's plan (2026-11-04).** A note's deck becomes a plan when one of
its builds is tracked: `POST /api/plan/from-note` (the plan page's "Track this build" is coming next), or MCP
`track_build` (staged). Its swaps, store offers and lists are derived from that build into the
planner (ARCHITECTURE.md, "Plans from notes"), so Buy, Trip, prints and marks work on it; saving the
note again updates them. Give swaps stable `id`s: a swap's marks and answers follow its id across
revisions. A swap's source comes from its `acquisition` (else the build's acquisition lists), so
record each card as owned, bought (with store, price and checked date) or printed.

An id-only MCP read is a compact overview. Use `deck`/`build` for one complete audit,
`scenario` for one global acquisition list, or explicit `full:true` for the complete document.
`review_research` records a person's stated choice or note using the same review operation as
the browser; it never infers approval to modify decks or buy cards.

Required document fields: `schema`, stable slug `id`, `title`, `generated_at` and `decks`.
Each deck needs `key`, `name`, `commander`, `builds`. Each build needs `id`, `label` and a
plain-text full `list` with Commander and Deck sections. Optional fields supported by the page:

- Deck: `ownership`, `installed_state`, `summary`, `recommended_build`, `pilot`, `sources`,
  `combo_playbook` (full entries stored once) and `competitive_path` (status, summary,
  commander_change, sources).
- Build: nullable `bracket`, `prospective`, `why`, `risks`, `game_changers`, `gc_choices`
  (card, reason, cut), `stats`, `swaps`, `acquisition`, `combos` and `gameplay_profile`
  (plan, setup array, pressure, finishers array, interaction, consistency, recovery, weaknesses
  array, pace, ceiling, confidence). Legacy `power` data is accepted but numeric ratings are
  not displayed. Build combos may be lightweight references to the deck playbook.
- Optional `accounting`: total, commander, main, basics, nonbasic, unchanged, added, removed,
  owned, projected_stock, local_buys and prints. Counts must match the exact 100-card list;
  owned + projected_stock + local_buys + prints + basics = 100. Swaps are differences,
  never additional cards. Projected stock is conditional on buying/receiving the sealed deck.
- Swap: stable `id`, `card_in`, `card_out`, `why`, `why_out`, `acquisition`, `pairing_note`.
- Acquisition: `scenario`, `note`, arrays `owned`, `buys`, `prints`, `basics`. Items carry card,
  qty, kind, source detail, reason; quotes carry store, price, matched market, printing,
  condition, checked date and URL. Unknown prices are null. `local_check` refers to a root
  `local_checks` entry with searched stores, unresolved errors, rejected offers, coverage and
  a separate cheapest market reference. No result is proof of no shelf stock.
- Combo: id, name, kind, cards, setup and steps arrays, outcome, stop_points array,
  bracket_fit, sources, present, missing_cards and is_caution. A caution can explain a
  nonworking claim; the presence of its cards is not proof that the claim works.
- Root: summary, method, local_checks, default_scenario_id and alternative shopping `scenarios`.
  Optional private `local_sources` rows support the all-deck sourcing preview
  (`/decks/plans/get/sourcing`). Each row has `name`, `status`, `uses` (stable per-copy
  `id`, `deck`, `deck_name`, `category`) and `best_offer_per_store` (nullable entries
  with store, price, qty, condition, URL, Shopify variant_id, checked_at and qualifies).
  Unknown price/quantity is null. A use is a source wish, not proof a card must be
  bought; categories keep unresolved sources and optional proxy/print replacements
  distinct. Count a recipient's union of bracket alternatives once and allocate
  each known SKU quantity only once across all recipients. Rows must match the
  report's exact builds and declared stock date. This extension is never included
  in the public research projection and does not update active trip snapshots.
  Scenarios carry id, label, note, deck_count, buys, prints, buy_total, print_count and optional
  sealed_purchases. Sealed product prerequisites have separate prices and market references;
  they are excluded from the singles buy_total and the $2 singles ceiling.
- A scenario with `purpose: "permanent_real_wishlist"` is a standing watchlist, shown outside
  acquisition choices and order totals. Its `buys` entries use existing typed card/reason/detail/URL
  fields; quantities, local offers and purchase approvals are not inferred. Printed-copy history
  belongs in the detail text, not a quantity to buy. It remains private research, separate from
  inventory. Print artwork preferences can be retained in the report's method notes.
  Purpose may be omitted (ordinary acquisition), `acquisition`, or `permanent_real_wishlist`;
  invalid strings and non-string values are rejected at import.
- Source: title, safe http(s) URL and optional accessed date.

Additional JSON fields are preserved. Displayed fields are type-checked; text is escaped and
links are restricted to http(s). Import validates document structure, not Commander legality:
future or unrecognized cards can be included as explicitly prospective research. Evidence of
count, singleton, legality, combos, ownership and prices must come from the research process.
Limit: 4 MiB per document, 20 reports per account, 100 decks and 12 builds per deck.

Browser reviews use `POST /api/research/{id}/reviews` with client `op_id`, target, decision,
note, expected_version and target_hash. A deck target (`deck:KEY`) records a preferred build id;
a swap target (`swap:KEY:BUILD:SWAP`) records want, unsure, no or null. The owner comes from
sign-in. Repeat op ids return the original receipt; reuse for different content conflicts.
Stale target hashes or review versions conflict. An explicit null is a retained cleared answer.
Reviews survive imports; changed evidence is flagged and removed targets stay in a retired
answers section. Writes acknowledge only after saving online; failed edits are never labeled
saved. MCP reads include all these answers for the next planning pass.

### Acquisition tracks

Optional `build.acquisition.track` is `owned_now` or `aspirational`. It is descriptive source
metadata, not an inventory operation. Writers must only use `owned_now` after validating the
complete portfolio against real, individually allocated copies and confirmed arrived prints,
including counted basic lands and donor-release dependencies. Every target has zero required
buys, new prints or future stock. Reserve the union across a deck’s bracket alternatives, then
sum across independent decks; never allocate one physical copy to two decks. Unmarked research
is treated as aspirational in the Builds page. Existing plans remain availability-unchecked
until an allocated research version is saved. Preserve the allocation scenario identifier and
dated evidence in the report; selecting a track changes no cards, orders, or installation ticks.

Builds and Research only display the owned badge when the declaration is internally consistent: no prospective flag, buys, new prints, sealed purchases or projected stock; an allocation scenario; explicit all-owned accounting; and positive, identified owned/basic quantities matching every card in the 100-card list. Contradictory or incomplete owned claims remain reviewable as availability-unchecked. This validates declared evidence, not live inventory or physical installation.
