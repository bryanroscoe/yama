# Private deck research

Research lives under **Decks, Research**. It is separate from installed decks, collection cards,
the legacy upgrade planner and pending executable changes. Saving a document or preferring a
build approves none of those actions. Bracket alternatives are complete, mutually exclusive
lists. Gameplay profiles explain setup, pressure, finishers, interaction, consistency, recovery and weaknesses. They are editorial judgments, never inferred win rates. Official Commander brackets run from 1 to 5; 5 is cEDH.

MCP `save_research({document})` and session `POST /api/research` store a private
`yama-research/1` report. `research()` lists reports; `research({id,deck?,build?})` reads a report
and its reviews. A focused deck read excludes unrelated global shopping scenarios and narrows
store evidence. The same file can be imported on the Research page or with
`yama-server import-research FILE --owner EMAIL [--dry-run]`.

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
  Scenarios carry id, label, note, deck_count, buys, prints, buy_total, print_count and optional
  sealed_purchases. Sealed product prerequisites have separate prices and market references;
  they are excluded from the singles buy_total and the $2 singles ceiling.
- A scenario with `purpose: "permanent_real_wishlist"` is a standing watchlist, shown outside
  acquisition choices and order totals. Its `buys` entries use existing typed card/reason/detail/URL
  fields; quantities, local offers and purchase approvals are not inferred. Printed-copy history
  belongs in the detail text, not a quantity to buy. It remains private research, separate from
  inventory. Print artwork preferences can be retained in the report's method notes.
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
