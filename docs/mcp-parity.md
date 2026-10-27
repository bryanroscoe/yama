# Commander MCP capability coverage

Bryan, 2026-10-27: bring useful Magic MCP capabilities into Yama, preferably by implementing the
ideas independently rather than copying their code. Yama stays the system of record for private
decks, collection, plans, changes and games. Both Ask Claude and outside MCP clients use the same
tools; installing a separate server is unnecessary for these capabilities.

## Implementation provenance

The comparison references were the public capability descriptions of
[nathanmartins/mtg-mcp](https://github.com/nathanmartins/mtg-mcp),
[j4th/mtg-mcp-server](https://github.com/j4th/mtg-mcp-server), and
[AlrikOlson/mtg-edh-mcp](https://github.com/AlrikOlson/mtg-edh-mcp), which describe MIT licensing.
The earlier feasibility discussion included reading some upstream source; this is an independently
authored implementation, **not a claim of formal separation between people who have and have not
seen upstream code**. No upstream implementation, dependency, tests or rule corpus was copied or
installed. New Rust code uses Yama's existing dependencies and domain functions, live public
provider responses, the official MCP specification and independently written tests.

Source contracts and attribution:

- [Scryfall API](https://scryfall.com/docs/api): cards, full search, printings, format legalities,
  original image URLs and market observations. `User-Agent` and `Accept` are sent; requests are
  paced at least 110 ms apart.
- [Commander Spellbook API](https://backend.commanderspellbook.com/schema/): combo variants and
  `find-my-combos`. Requests are at least four seconds apart. Required quantities, zones, faces,
  commander status, templates, setup, mana and steps are retained.
- [EDHREC](https://edhrec.com): community recommendations, categories, inclusion samples and synergy.
  Public JSON endpoints were observed directly; they are undocumented and may change.
- [Archidekt](https://archidekt.com) and [Moxfield](https://moxfield.com): public deck retrieval only.
  No private account credential or anti-bot bypass. A block or changed schema remains an error.
- [Wizards' rules page](https://magic.wizards.com/en/rules): discover the official `.txt` edition
  at runtime, index numbered rules and the glossary, and return bounded evidence. No edition is
  hardcoded and no rules document is shipped.
- MCP [prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts) and
  [resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).

## Coverage

This is workflow parity for the Commander use cases identified in the comparison, not a promise
that every advertised tool in three evolving projects has an identical implementation.

| Capability | Yama path |
|---|---|
| Card facts, rulings, owned copies, Game Changers | Existing `card`, `find_cards`, `check_list` |
| Full online Scryfall grammar and all-format card legality | `search_scryfall`, including page/offset continuation without skipping cards |
| Printings, regular/foil prices, original image URLs | `card_printings`; missing prices stay null; images load at runtime |
| Commander community recommendations, themes, budget tiers | `commander_recommendations`; optional own-list exclusion and owned filtering run locally |
| Arbitrary combo discovery | `find_combos(query)` |
| Included / nearly included combos, changes of colors or commanders | `find_combos(deck/list, share_list=true)`; retains separate provider categories and prerequisites |
| Public deck import | `public_deck(url)` then `save_deck(list, name)`; Moxfield and Archidekt supported; review before save |
| Exact current rules, subrules, glossary and keyword evidence | `rules_lookup`, with effective edition, source and retrieval time |
| Deck construction and upgrade workflow | `build_commander` / `review_deck` prompts compose research, collection, validation, comparison and staged save tools; the assistant makes card choices |
| Curve, colors, descriptive land access and role hints | `deck_analysis`; unknown mana data remains unknown; role labels are explicitly heuristic |
| Ownership and budget | `deck_analysis`, `collection_cards`; proxies separate, dates and missing-price counts explicit; owned does not mean unreserved |
| Cheaper printing selection | `deck_analysis` uses eligible nonfoil paper snapshots within three days of the card's newest snapshot; `card_printings` supplies current alternatives |
| Reproducible hands, London mulligan draw/bottom count | `sample_hands`; actual bottom/keep decisions stay with the caller |
| Exact qualifying-source draw probabilities | `mana_probability`; hypergeometric, with caller-defined sources and explicit assumptions |
| Early land sequencing and colored payment | `mana_test`; bounded seeded trials, tapped lands, distinct source assignments, coverage, trace, policy and sampling intervals |
| Persistent lists, snapshots, comparisons and restores | Existing immutable deck versions; `deck_history`, `deck_analysis(version)`, `compare_decks`, `save_deck` |
| Reviewable full-list construction or replacement | `save_deck`, with full validation, stale-version rejection, and deck plus applied marker committed atomically |
| Real-game results and gameplay simulation | Existing deck/plan tools and Phase / Forge lab tools; research popularity is not substituted for evidence |
| Discoverable workflows and addressable data | Three prompts; source resource and owner-checked deck/card resource templates |

The broad j4th server also covers Limited, tournament feeds and constructed metagame/sideboard
workflows. Those are outside this Commander change. No 17Lands, Spicerack or MTGGoldfish access is
advertised by Yama. Custom saved role overrides, a general optimal mana solver and persistent
structured playgroup policy are also not claimed; current tools expose reviewable role hints,
model assumptions and user goals in the workflow/version note instead.

## Privacy, limits and evidence

- The new public-data adapters are `server/src/mcp/research/`. Their HTTP client has no Yama
  credential/cookie, fixed provider hosts, redirects disabled, connect/request timeouts and
  streamed response caps (2 MiB JSON, 4 MiB rules). User URLs are parsed to a supported host and
  a bounded deck id; only that id is used to construct a request. Official rules links must be
  HTTPS on `wizards.com` or its subdomains, without credentials or a custom port.
- GETs have a one-hour in-memory cache, at most 16 entries / 8 MiB; there is no bulk-data download
  or second card database. Retrieval timestamps survive cache hits. Provider `Retry-After`
  produces a shared cooldown, without automatic retry storms or fabricated empty results.
- Spellbook deck matching resolves the caller's own deck before any request, requires
  `share_list=true`, and honors `YAMA_DECK_CHECKS=0`. Only card names and quantities are sent.
  Deck POSTs are never cached, and notes, deck names, inventory, tokens and other users' data
  are never attached. EDHREC receives only the public commander/theme; personal filtering is local.
- New tools use the search rate limit. Results are bounded by tool-specific counts and a
  100 kB output cap. Outside content is data, not instructions. Network tools declare
  `openWorldHint=true`; local tools declare false.
- A live Scryfall price response has an **observation timestamp**, not an asserted snapshot date.
  Local market totals use real stored snapshot dates, eligible nonfoil copies, basics and explicit
  missing-copy counts. No price implies stock, a store quote or the resale value of owned copies.
- `mana_test` is a lands-only model under a fixed greedy land policy. It cannot model ramp,
  fetches, filters, alternative costs, mulligans, conditional mana or actual spell availability.
  Unsupported sources stay in the draws but produce no modeled mana, and are listed. Sampling
  intervals cover trial noise only, not model error. Actual gameplay uses the existing engines.
- `save_deck` requires a fully resolved, validated 100-card Commander list. It stores the full
  list and before-version for review. Nothing is refetched at Apply. Creation/replacement and its
  applied marker share a transaction, so a lost reply cannot repeat creation. Ask Claude still
  has no Apply tool; outside callers still need approval of the exact change.

## Use

The endpoint and sign-in are unchanged. No extra MCP installation is required. Outside clients
may discover `review_deck`, `build_commander` and `rules_question` through `prompts/list`. Ask
Claude receives the same capabilities through its existing `mcp__yama` allowlist and updated
instructions. Its activity lines describe research and review in ordinary language.

Example requests:

- Review Riders of Rohan using owned cards first, preserving its theme and declared bracket;
  compare five exact swaps and their dated costs before staging them.
- Build a complete Commander deck from this commander/theme and budget, showing unresolved goals,
  missing prices and protected cards before proposing a save.
- Read this public deck URL, validate it and stage an import. Do not silently discard unknown names.
- Explain this interaction with current Oracle text, card rulings and numbered official rules;
  identify missing board-state facts and assumptions.

Deterministic checks live in `mcp/research/tests.rs`, `rules.rs`, `analysis.rs` and `mana.rs`. They
cover ownership isolation, saved-version access, staged writes and rollback, request consent,
public URL rejection, cache timestamps, pagination, source failures/cooldown, combo requirements,
seeded shuffles, mana assignment and MCP discovery. An ignored, opt-in
`live_public_research_contracts` test checks public providers without a real user's data, bulk
downloads, lab runs or a paid model call.

## Validation on 2026-10-27

- `cargo test -p yama-server`: **367 passed, 2 ignored** (the normal ignored engine benchmark
  and the opt-in external probe).
- Opt-in `live_public_research_contracts`: **passed** for Scryfall search, EDHREC, Spellbook
  search, Archidekt, Moxfield and official numbered rules. The separate public two-card Spellbook
  POST contract was inspected directly; deterministic tests cover its nested response and consent.
- `npm test`: **495 passed, 2 skipped**. `npm run typecheck`: **passed**.
- `git diff --check`: **passed**.
- Full `cargo test`: **failed in the unchanged play crate**, 159 passed / 928 failed / 35 ignored.
  Card tests fail loading `play/tests/fixtures/deck-cards.json`: unknown variant `Itself`, expected
  `Shared`, `EachController`, or `OtherBatchSource`. Both that fixture and its loader match the
  freshly fetched main used as this branch's base. The sibling Phase checkout was at `6e1c476`,
  while `deploy/phase-rev` pins `9b2073b`; no Phase source or fixture was changed for this work.
  This is not a green full-workspace Rust gate and is not release acceptance.

Work is local on `feature/mcp-parity-20261027`, based on main `2ecdd08`. No third-party MCP was
installed, no user list was uploaded for verification, and no push, merge, deployment, paid model
call or live lab run was performed.
