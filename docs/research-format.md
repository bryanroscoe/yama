# Private deck research

Research lives under **Decks, Research**. It is separate from installed decks, collection cards,
the legacy upgrade planner and pending executable changes. Saving a document or preferring a
build approves none of those actions. Bracket alternatives are complete, mutually exclusive
lists. Power ranges are attributed editorial estimates, never inferred win rates.

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

- Deck: `ownership`, `installed_state`, `summary`, `recommended_build`, `pilot`, `sources`.
- Build: nullable `bracket`, `prospective`, `power` (range, label, confidence, rationale, speed,
  vulnerabilities), `why`, `risks`, `game_changers`, `stats`, `swaps`, `acquisition`, `combos`.
- Swap: stable `id`, `card_in`, `card_out`, `why`, `why_out`, `acquisition`, `pairing_note`.
- Acquisition: `scenario`, `note`, arrays `owned`, `buys`, `prints`, `basics`. Items carry card,
  qty, kind, source detail, reason; quotes carry store, price, matched market, printing,
  condition, checked date and URL. Unknown prices are null. `local_check` refers to a root
  `local_checks` entry with searched stores, unresolved errors, rejected offers, coverage and
  a separate cheapest market reference. No result is proof of no shelf stock.
- Combo: id, name, kind, cards, setup and steps arrays, outcome, stop_points array,
  bracket_fit, sources, present, missing_cards and is_caution. A caution can explain a
  nonworking claim; the presence of its cards is not proof that the claim works.
- Root: summary, method, power_scale, local_checks and alternative shopping `scenarios`.
  Scenarios carry id, label, note, deck_count, buys, prints, buy_total and print_count.
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
