# Public precon reference

27 October 2026. Implemented in this checkout: anonymous stock-precon pages, dedicated public APIs, explicit ranking publication and a shared rights notice. Production release and actual ranking publication are separate actions. The design pass adds an experimental, explicitly defined meta rank and atomic multi-engine publication. No new scraping pipeline is enabled. ARCHITECTURE.md is the plan of record.

## Public pages

Help someone answer: which stock precons interest me, how do they compare, how much evidence supports that comparison, and what do they cost?

| Page | Public content |
|---|---|
| `/precons` | Search and filters for name, set, year and colors; the meta rank, the Phase model and real games, each sortable from its heading (real games also by the commander's figure for any list, from Mythic Tools); dated sealed and singles market references |
| `/precons/:slug` | Stock list, commander and credited art, simulation results and limitations, separately sourced real-game results, market references, links to reviews and upgrade guides, copy/download stock list |
| `/precons/methodology` | What each ranking measures, the opponent field, engine and AI versions, scored and excluded games, uncertainty, source dates, publication date and known limitations |

Keep the entire catalog browsable even when a deck is unrated or an engine cannot judge it. A missing result means "not rated" or "insufficient evidence," never last place. Start with the simulation ranking clearly named; offer real-game evidence separately. The experimental meta rank described below is an ordinal consensus with declared editorial weights, not a definitive power ranking or a calibrated win-rate forecast.

Public pages carry Yama's frame (the five tabs and You); the precon pages light Decks and list My decks, Precons and Commanders under it, and the footer links the methodology. The current root and signed-in Lab links keep working. A visitor can read, select/copy and download a stock list without an account. "Sign in to save this deck" and "Sign in to try a change" open the corresponding existing authenticated route, retaining the selected precon through sign-in. These actions use the existing owner checks, idempotent writes and allowances.

Use Night table tokens, readable mobile rows, ordinary sentence-case labels and source links beside their figures. Card images load from Scryfall at runtime without filters; art crops carry the artist and copyright. Keep the free, unofficial, not-endorsed-by-Wizards notice.

Commander rankings, user submissions, upgrades ranked as stock lists, public experiments and anonymous simulation jobs are outside this first release.

Personal decks and collections are shared separately, only by their owners: see ARCHITECTURE.md, Sharing and deck configurations (2026-10-28).

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

The Rust Docker build stage copies `web/src/styles.css`, `web/public/precons.css`, `web/public/site-frame-v1.css` and `web/public/site-notice.html`, since the public renderer embeds them with `include_str!`. They must be present during server compilation, independently of the frontend build stage.

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

## Experimental Yama meta ranking (design pass)

"Meta ranking" here means combining rankings/evidence across sources. A ranking against a particular local metagame would be a separate experiment with that field specified.

The public page now offers an experimental meta rank alongside the original source results. The versioned method is `common-cohort-percentiles-v1`:

1. Take the intersection of current stock lists with at least 20 real-game records and 20 simulated appearances in every explicitly published engine. Require at least four decks. Compute this cohort before search/filter/pagination.
2. Re-rank real four-player-normalised rates and each engine's fitted strengths within that same cohort. For n decks, percentile = 100 × (number below + (number equal − 1) / 2) / (n − 1). Ties receive the average rank.
3. Score = 0.5 × real percentile + 0.5 × mean engine percentile. With Phase alone the weights are 50/50; with Phase and Forge, 50/25/25. These are transparent editorial weights, not optimised or validated prediction weights. Additional runs from one engine cannot add votes.
4. Rank by descending score; ties share a rank. Missing data stays unranked, not zero. Source dates are visible but there is no age weighting. Scores use the current dated real-game cache and can change after refresh while the simulation snapshot stays frozen. Confidence warnings are displayed, not used to filter or weight: some already include real-game residuals and would favour agreement by construction.

A score of 70 is not a 70% chance of winning. It has no calibration interval. Different original opponent fields remain a limitation despite re-ranking on the shared subset. The separate model rates retain their run-specific fields and game-bootstrap intervals; human results retain their source/date and normalisation. No blended real-world win-rate estimate ships without an independently held-out validation target and calibration uncertainty. Historical local summaries show weak rank agreement with the real-game ordering (`precons-2` Spearman 0.125, Forge calibration 0.162 across 84 mapped decks), so further games and calibration research are warranted. These are historical descriptive checks, not independent validation of the consensus.

For publication, add `"comparisons": ["forge-publication.json"]` to the primary manifest. The referenced manifest has the same reviewed-source fields and its own original stock index; nested comparisons are rejected. The entire bundle passes the existing public stock/run/build validation and commits atomically. Imported or private results never contribute automatically. Existing single-engine snapshots need no migration. Legacy Forge imports can carry a generic Easy difficulty label without recording the actual Forge profile; the public metadata calls it a recorded label rather than asserting an unverified profile. Add independently reviewed provenance notes or rerun when the profile is missing. Withdraw removes the bundle together.

## Design and Forge review draft

The design pass restores the Night table wordmark, Big Shoulders Display and Atkinson Hyperlegible Next, pill controls, 1120px content, credited commander art and uncertainty graphics. The index shows 24 decks per page with preserved GET filters. Mobile rows keep source labels and a compact evidence grid. Detail and methodology pages use the same type, surfaces and controls. The generated `/precon-fonts/` directory is served by the existing static asset handler; dev/build copies the font files and OFL notices from the installed dependencies.

Bryan chose to stage the Forge pilot before running it. [The review draft](experiments/public-precons-forge-pilot-20261027.json) selects eight stock lists in one shared field, 32 appearances per list per engine, 64 four-player games per engine (128 total), Phase Easy and Forge Default. It spans historical disagreements among precons with human data and no current catalog partial-support flags. It is a diagnostic convenience sample, not a representative benchmark. The file contains the `start_lab_run` arguments and stock text hashes; it has not been submitted, approved, charged or started. At approval, recheck server list identity, engine support, schedule rounding, versions and queue budget. Results require a separate publication review and a supported public analysis format; an owner-scoped tournament is not automatically a publishable global benchmark.

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

## Design-pass verification (27 October 2026)

The full Rust suite passed against the pinned production engine `9b2073b0986fe580d495fce2fa58b5762e24e3eb` in a disposable source copy, including 369 server tests and 13 public-reference checks. Coverage includes atomic two-engine publication, rollback and withdrawal, private/unpublished-source exclusion, shared-cohort weighting, pagination/filter preservation, unchanged stock validation and missing uncertainty intervals. A missing interval is shown as unavailable, rather than drawn as zero uncertainty.

`npm test` passed (495 tests, 6 optional fixture tests skipped); typecheck and the production web build passed. The build contains all four public font files and both OFL notices. Rendered HTML using the published catalog and historical source results was inspected at desktop and phone widths from 320px to 1280px, including two-engine layout, source cautions, market dates and deck details; the inspected views had no horizontal overflow. The current published data yields 84 meta-ranked decks within a 174-deck catalog. Historical Forge data was used for layout inspection only, not newly published. The Forge pilot remains a review draft; no games were submitted or started in this pass. These checks do not constitute a production deployment.
