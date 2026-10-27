# Public precon reference

27 October 2026. Implemented in this checkout: anonymous stock-precon pages, dedicated public APIs, explicit ranking publication and a shared rights notice. Production release and actual ranking publication are separate actions. No new scraping pipeline or combined ranking is enabled. ARCHITECTURE.md is the plan of record.

## Public pages

Help someone answer: which stock precons interest me, how do they compare, how much evidence supports that comparison, and what do they cost?

| Page | Public content |
|---|---|
| `/precons` | Search and filters for name, set, year and colors; simulated rankings with games and uncertainty; a separate real-game sort; dated sealed and singles market references |
| `/precons/:slug` | Stock list, commander and credited art, simulation results and limitations, separately sourced real-game results, market references, links to reviews and upgrade guides, copy/download stock list |
| `/precons/methodology` | What each ranking measures, the opponent field, engine and AI versions, scored and excluded games, uncertainty, source dates, publication date and known limitations |

Keep the entire catalog browsable even when a deck is unrated or an engine cannot judge it. A missing result means "not rated" or "insufficient evidence," never last place. Start with the simulation ranking clearly named; offer real-game evidence separately. Do not label either a definitive power ranking or invent an overall score for launch.

Public navigation offers Precons, Methodology and Open Yama. The current root and signed-in Lab links keep working. A visitor can read, select/copy and download a stock list without an account. "Sign in to save this deck" and "Sign in to try a change" open the corresponding existing authenticated route, retaining the selected precon through sign-in. These actions use the existing owner checks, idempotent writes and allowances.

Use Night table tokens, readable mobile rows, ordinary sentence-case labels and source links beside their figures. Card images load from Scryfall at runtime without filters; art crops carry the artist and copyright. Keep the free, unofficial, not-endorsed-by-Wizards notice.

Commander rankings, user submissions, public personal decks, upgrades ranked as stock lists, public experiments and anonymous simulation jobs are outside this first release.

## Existing foundation and exposure boundary

These are source observations from this checkout, not a new production audit:

- `server/src/lab.rs` already serves the catalog, ratings, confidence reasons, stock cards and model matchups. `list_precons` and `get_precon` require `CurrentUser`. The current rating selection is the newest global imported precon-ratings run.
- A global import already refuses non-precon references, and model matchup rows are restricted to catalog precons. That is a useful guard, but global still means readable by signed-in users. The check recognizes the precon ID prefix; publication should also validate actual catalog membership and the frozen stock lists.
- `web/src/App.tsx` requires sign-in before its routes render. `web/src/lab/Precons.tsx` merges stock precons with the caller's own paired runs and planner data through `useMyLists`. Public pages need a component that reads only public data.
- `PreconDetail.tsx` includes private actions, Ask Claude and a card sheet that uses authenticated APIs. Public stock-list inspection must not silently depend on those endpoints.
- Raw run metadata, notes and source fields can contain file paths, analysis details or other internal text. Reusing the complete current response is not an adequate publication boundary.
- `server/src/deck_prices.rs` already provides dated singles replacement estimates and sealed market references. These are independent of what a user owns or paid.

Allow public reads only of the curated catalog and its published results. Keep personal decks and versions, collection/owned counts, purchase prices, containers, plans, playgroups, games, experiments, advisor conversations, account details, admin state and worker/queue diagnostics on the existing authenticated routes. A signed-in visitor receives the same public response as a signed-out visitor.

In particular, do not publish a private tournament by filtering its output down to precon rows. Its opponent field and fitted strengths can still depend on personal upgraded lists. The public benchmark needs a stock-precon field of its own, or a separately specified public experiment with explicitly public entrants.

## Implementation

1. **Dedicated public projection.** `GET /api/public/precons` and `GET /api/public/precons/{slug}` return typed public catalog facts, published results, source links/dates and market references. They share pricing calculations but never serialize a raw run summary or an owner-aware response. No arbitrary run or matchup-matrix endpoint is exposed. Invalid slugs return a real 404.
2. **Explicit snapshots.** Migration 0031 stores reviewed public results and method metadata as immutable documents with publication IDs, content hashes and dates. `publish-precons MANIFEST` validates and publishes atomically; importing a newer global run does not publish it. Results are copied because importing a newer summary can replace the existing run in place. A failed publish preserves the last good version. `withdraw-precons` clears the current publication. Before the first publication the catalog works and says no simulation ranking has been published.
3. **Keep clocks separate.** Simulation results name their frozen lists, run dates and method version. Catalog revisions and refreshed market prices have their own dates. If a stock list changes, do not present the old list's simulation as a rating of the new list. When the catalog adds a deck after publication, show it as unrated. External source refreshes do not silently alter a published simulation result.
4. **Server HTML before the app's auth gate.** The Rust router serves the public pages independently of React, with ordinary GET form filters and public stock-list detail data. Public reads never load the planner, private caches, `/api/me` or `/api/lab/runs`. Card rows open Scryfall for full details. The personal Lab retains its existing actions and data.
5. **Useful shared links.** Pages carry titles, descriptions and canonical/Open Graph URLs when `YAMA_PUBLIC_URL` is configured. Meaningful content is present in the initial HTML. `/sitemap.xml` lists only public reference pages and requires that configured URL; it never trusts the Host header. Images remain runtime Scryfall links.
6. **Inexpensive reads.** Public requests read imported caches, use ETags and `public, max-age=60, must-revalidate`, and count against 120 reads/minute per client address. They never fetch an outside site, start a simulation or change an account. Account/view-as cookies do not affect these responses. The service worker leaves public pages, exports and the sitemap out of the private app-shell cache.
7. **Release verification.** On deployment, confirm the public hostname and any proxy/Cloudflare Access policy permit the public paths without Google sign-in while private APIs still enforce auth. Public About/privacy/terms wording now distinguishes reference data from private user data. No live policy change has been made by implementation.

The Rust Docker build stage copies `web/src/styles.css`, `web/public/precons.css` and `web/public/site-notice.html`, since the public renderer embeds them with `include_str!`. They must be present during server compilation, independently of the frontend build stage.

## Publishing a ranking

Import a global stock-precon `summary.json` with `import-lab` as before, and keep its original deck index and adjacent `precons/*.txt` files. Copy [the manifest example](public-precon-publication.example.json) to a local file outside version control (for example `data/public-precons.json`). Set its run ID and original stock-index path. Relative paths resolve from the manifest's directory. Fill in the reviewed title, engine, card-data, runner and difficulty labels; the four build/AI labels must match the imported run exactly. `notes` and per-slug `reasons` are deliberately public text you review, not raw warnings or confidence strings copied automatically from the analysis.

```sh
CARGO_BUILD_JOBS=4 cargo build -p yama-server
./target/debug/yama-server publish-precons data/public-precons.json
./target/debug/yama-server withdraw-precons
```

Publication requires an ownerless precon-ratings run, a four-player Plackett-Luce analysis with an interval level, one engine/card-data/runner version, four-player games only, game-cluster bootstrap intervals, time caps excluded and turn/action caps retained, no pending games or recorded schedule inconsistencies, distinct catalog entrants and a matching complete model field. Each entrant must be a precon in the original index; the index date must match the run's recorded input date; commander metadata must agree; and original list contents must match the catalog's 100-card list, including commander/main boards. The public confidence level is projected from the analysis; reasons are reviewed manifest text or a public explanation of that level. Internal paths, raw warnings, error messages, private run names and other summary fields never enter the publication document.

Legacy summaries record an index date, not cryptographic per-game list hashes. The original index/lists supplied by the operator are a provenance requirement: matching those files does not independently prove which historical lists a game engine loaded. Preserve the actual inputs, and rerun or reanalyse if they are unavailable or ambiguous. Publishing a mixed personal tournament by removing its private rows is refused.

Replacing or deleting the imported run cannot change the publication. A changed catalog list no longer receives the old result; a new catalog deck is unrated. Withdrawal takes effect at the origin immediately, with public caches allowed up to their existing 60-second lifetime. This first release shows published results and rank intervals; public model matchups and observed finish-ahead tables remain a follow-on.

## Rights notice

The shared `web/public/site-notice.html` appears on the server-rendered public reference, sign-in and the app shell. The static About, Privacy and Terms pages repeat the notice. It reads: “© 2026 Bryan Roscoe. All rights reserved in Yama’s original software, written analysis and presentation.” Third-party ownership and the unofficial Wizards notice remain beside it. `COPYRIGHT` records the same boundary in the repository.

`/tos/#rights` permits browsing, sharing links and stock-list downloads for deckbuilding, reserves reproduction rights in protected original material, preserves uses permitted by law and disclaims exclusive ownership of facts, game rules, ideas, card lists and third-party material. This is a rights notice, not technical copy prevention. The [U.S. Copyright Office](https://www.copyright.gov/help/faq/faq-protect.html) distinguishes original expression from unprotected facts and ideas.

## Evidence shown with a ranking

The main result should answer a precise question: "How did this stock list perform against this precon field under this simulation setup?" A short note should say that AI games are evidence about the simulation, with specific known limitations where relevant.

- Show games, interval level, rank/rank range where available, field size, and the analysis date. Explain the model's four-player win probability separately from the raw observed win rate.
- Preserve existing doubtful/unreliable confidence levels and their reasons. A deck with a known broken strategy stays in the catalog, outside the trusted simulated ordering. Many games do not remove systematic AI or engine bias.
- Name the engine, card data, AI level/profile, runner and rules/settings. Keep Phase and Forge results separate, and show disagreements when comparable data exists. Do not pool engine versions, different fields or AI difficulties into one unlabeled estimate.
- Report scored games, no-winner games and failures/timeouts separately. A failed game is not a deck loss. Use the run's existing scoring and interval methods rather than introducing a different public-only calculation.
- The existing matrix is model-implied one-on-one odds. Label it that way if shown; it is not observed multiplayer head-to-head evidence. Prefer observed four-player finish-ahead results when an appropriate public run supplies them later.
- A source's real-game results can have different opponents, pilot distributions and stock definitions. Show that method and date rather than assuming its win rate is directly comparable with our closed precon field.
- Show missing prices, missing-copy counts and dates explicitly. Sealed market references and the singles replacement estimate answer different questions; neither proves availability or a checkout price.

## Outside sources

Use scheduled source adapters and cached dated snapshots. Each observation should retain source name/URL, source update date when available, fetch date, deck identity, metric definition, stock/upgrade status, sample size and original rank/cohort size where relevant. Retain the last successful data with its original date if refreshing fails. Reject ambiguous mappings instead of guessing by commander name alone. Record how collection and public display are supported for each source before adding an automated adapter; a readable page alone is not evidence of a supported bulk API.

| Source | Contribution | Proposed treatment |
|---|---|---|
| MTGJSON, with Wizards decklist/errata references | Stock list identity, set, release and product variants | Reuse structured deck data; preserve corrections, original product/source links and list versions |
| Yama's Phase/Forge lab | Reproducible precon performance experiments | Publish only validated stock-precon benchmark snapshots; use a balanced common field and seat rotation |
| Playgroup.gg | Observed stock-deck results | Refresh the existing source integration with its method/date; expose attributed aggregate facts only through the public projection after checking public reuse support |
| Scryfall and TCGCSV | Card identity/images, singles and sealed market references | Reuse the existing daily caches, product matching and price provenance |
| EDHREC | Common additions/cuts and links to reviews/upgrade guides | Keep the existing outbound links for launch; its deckbuilding statistics are not win rates. A new numeric adapter needs a supported collection/reuse path |
| Other reviewers and tier lists | Opinion, themes, ease of play and qualitative comparisons | Discover/link useful guides first. Later store attributed structured judgments with date and rubric where supported, rather than republishing articles |

Source checks on 27 October 2026:

- [MTGJSON's deck model](https://mtgjson.com/data-models/deck/) includes commanders, main/side boards, release date and sealed-product identifiers. It is a catalog input, not performance evidence.
- [Playgroup.gg's precon methodology](https://playgroup.gg/commander/precons) describes stock matching by non-basic card list, ignoring printing/basic-land changes; a four-player baseline; and eligibility of at least 20 stock games and 10 distinct registered pilots. It reports 87 qualifying precons and 25,640 stock games at the page's 27 October update. These are source-reported counts, not Yama's simulation totals or a claim that its local cache is current.
- [EDHREC's FAQ](https://edhrec.com/faq) defines its statistics in terms of decklist inclusion. Its [Fantastic Four precon page](https://edhrec.com/precons/the-fantastic-four) lists additions and cuts. Neither establishes that an upgrade improves a deck's win rate.
- [TCGCSV](https://tcgcsv.com/) supplies product and market-price data in CSV/JSON and advertises daily updates. Continue to label market references with their actual cached dates.

The existing `docs/deck-import.md` records source restrictions and disabled link importers. This proposal does not enable those importers or treat a blocked endpoint as a scraping route.

## Path to a Yama consensus ranking

"Meta ranking" here means combining rankings/evidence across sources. A ranking against a particular local metagame would be a separate experiment with that field specified.

First publish distinct simulated and observed rankings with provenance. Then use disagreement to prioritize engine fixes, more balanced games and better source coverage. EDHREC popularity can help find upgrades to test or guides to link; it should not make a stock deck more powerful in the rating. Keep price/value and reviewer opinion as separate views too.

A later experimental consensus can combine comparable performance evidence, but its method must define:

- The same stock list/commander configuration, cohort and target four-player setting. Reprints with identical lists should not become independent performance entries; a different commander choice must be labeled.
- How to normalize different ranking scales and fields, account for sample size, uncertainty, age and engine/AI limitations, and handle decks missing from a source without treating absence as a zero.
- How to avoid counting the same underlying games twice. A mirror of another site's ranking is not another independent source. Real results already used to calibrate our simulation confidence are not an independent validation set for a combined score.
- How weights are chosen and tested against held-out real results. Do not launch an arbitrary percentage blend just because the inputs are available. Without adequate validation, call any aggregation an experimental consensus and expose its components and source coverage.

Stock precons are a useful first unit because the list is fixed. Commander rankings would need explicit bracket, budget, archetype and list choices; a precon commander's result cannot be generalized to every deck led by that card.

## Acceptance for the first implementation

- Signed-out and signed-in readers can open the three public page types and receive the same public data, including when `/api/me` is unauthorized. Public reading uses no planner or private-run requests.
- Public API projections and initial HTML are tested with private decks, owned runs, mixed tournaments, internal paths and injected note/summary content present in the fixture. None appears publicly. Merely importing another global run does not change the publication.
- Existing signed-out private-route checks and cross-owner privacy tests continue to pass. Anonymous deck creation, experiment creation and arbitrary run access stay unauthorized; successful signed-in writes retain their existing idempotency.
- No publication, unrated decks, unsupported strategies, missing/old prices, source failures and changed stock lists have explicit useful states. Mobile filters and detail links work, and shared links identify the right deck and publication context.
- The selected publication can be replaced or withdrawn without releasing personal runs or erasing private results. Public caching never stores personalized responses.
- Before committing implementation: `CARGO_BUILD_JOBS=4 cargo test`, `npm test`, and `npm run typecheck`; also build the web app. Push and deployment follow the release process only when requested, with a signed-out check of the public hostname.

## Initial implementation verification (27 October 2026)

`cargo check -p yama-server`, the full `CARGO_BUILD_JOBS=4 cargo test`, `npm run typecheck`, and `npm run build` passed. The public-reference coverage includes eight Rust integration tests and two frontend tests for rights notices and exclusion from the private offline shell.

A disposable local database imported the real 174-precon catalog and `precons-2` analysis, then published all 174 results from 6,856 scored games. Anonymous catalog/detail/methodology HTML, the JSON API, stock-list download, stylesheet and sitemap answered successfully; no account cookie or internal source path appeared; private deck access stayed 401; withdrawal removed the published ratings. No production database was touched and no games were started.

Default `npm test` encountered an unrelated optional local-only planner comparison: `packages/core/src/plan/real-plan.test.ts` expects a section absent from the current external `commander-decks/docs/buy-list.md` (`elsewhere.rows` is undefined). With optional external fixtures disabled via `YAMA_COMMANDER_DECKS=/tmp/yama-no-local-fixture`, the JavaScript suite passed (489 passed, 6 skipped at that run). The external documents and planner test were left unchanged. This is not a production deployment or a signed-out check of the public hostname.

For release integration, the feature was separated onto freshly fetched main without the original checkout's unrelated work. Default `npm test` passed there (495 passed, 6 optional tests skipped because their external fixture files are absent), along with typecheck and the production web build. The full Rust suite passed on the same source with the production engine pin `9b2073b0986fe580d495fce2fa58b5762e24e3eb` exported from git, including all eight public-reference tests and the existing privacy tests. This is separate evidence from testing against the development engine checkout.
