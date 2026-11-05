# Saving a research note

Prefer the server's current `yama://research/format` resource when the host exposes
MCP resources. This packaged reference describes the required portable subset.
Consult each tool's current schema before calling it.

`save_research` takes one object, `document`, with:

- `schema`: `"yama-research/1"`.
- `id`: a stable report slug. Reuse the existing ID when refreshing that report.
- `title`: a human-readable title.
- `generated_at`: the actual generation time as an ISO 8601 timestamp.
- `decks`: an array of deck objects. Each needs a stable `key`, a `name`, a
  `commander` string and a `builds` array.
- Each build needs a stable `id`, a `label` and a full plain-text `list` using
  Commander and Deck headers. Supply the actual complete researched list;
  never send placeholders as if they were card names.

Useful optional deck fields are `summary`, `recommended_build`, `pilot`,
`sources` and `warnings`. Useful optional build fields are `bracket`, `why`,
`risks`, `swaps`, `gameplay_profile`, `game_changers` and `prospective`.
Sources contain a `title`, an HTTP(S) `url` and optionally an `accessed` date.
Each swap can carry a stable `id`, `card_in`, `card_out`, `why` and `why_out`.
Stable IDs preserve review targets and marks when a note is refreshed.

Do not assert `owned_now` acquisition status or fabricate accounting totals.
Only make ownership claims after individually allocating real copies and
confirmed arrived proxies across the complete portfolio. Omit optional evidence
you cannot support rather than inventing it. Prices, stock, allocations and
source dates must reflect observed evidence. A missing price is unknown.

The server accepts at most 4 MiB per report, 20 reports per account, 100 decks per
report and 12 builds per deck. A successful import validates document structure;
it does not prove Commander legality, card count, power, ownership or prices.
Validate playable lists separately with `check_list` and `deck_analysis`. Label
prospective or unknown cards explicitly and do not claim their list is legal.

Before updating an existing report, read `research` with its `id` and `full=true`
so an upsert preserves unrelated decks, evidence, allocations and sources. Keep
report, deck, build and swap IDs stable. A tracked plan follows its updated
research build; explain substantive changes. `save_research` does not save a
playable deck, change inventory, approve purchases, order prints or start games.

Read the saved report back with `research` (optionally narrowed to a deck/build)
before reporting persistence. A timeout is not proof of failure; read the report
before retrying. An unchanged document is idempotent by content hash.

`review_research` is for a person's stated preference, using `id`, a new UUID
`op_id`, the exact `target`, `target_hash`, `expected_version`, `decision` and
`note` from a current read. Reuse the same op ID unchanged on retry. A preferred
build is a preference, not approval to track, install or buy it.
