# Precon upgradeability

Public precon pages, private Lab pages, catalog APIs and MCP use the same assessment. This describes improvement options for a **declared commander configuration while retaining the precon’s main theme**. It is an editorial judgment by Yama, with supporting sources. A publisher's review grade is labelled separately and retained in its original scale.

On 27 October 2026 we withdrew the first 174 grades. They were generated estimates without adequate source support. Matching their stock-list snapshots established list identity, not the validity of their judgments. Method `source-backed-upgradeability-v4` does not carry those grades forward.

The package inventory covers 174 stock lists and 619 colour-compatible in-box commander configurations, including checked legal pair mechanisms. Six configurations are blocked by banned stock cards. Three Clara Oswald configurations require a pregame colour choice that the simulation list format cannot preserve; these are inventoried but have no simulation download. The other 610, plus the separately scoped Koma option, provide 611 prepared lists. Inventory is not a grade: 18 configurations have supported assessments, while the others remain ungraded. Individual commander observations retain their source/fetch dates and do not become pair results.

A package verdict must account for the included commanders. The table names the highest supported **in-box upgrade grade** and shows assessed/total coverage. This summarises only assessed options, not a claim that the unassessed options are worse or that the number measures stock power. Whole-package publisher reviews retain their own scale; actual simulations retain their exact commander/list identity. Outside swaps are excluded from the package summary.

## What 1–5 means

| Grade | Meaning |
|---|---|
| 1 Minimal | Individual replacements do little for the main plan; its limiting mechanism remains. |
| 2 Narrow | Useful replacements exist, but a commander or theme restriction blocks most further gains. |
| 3 Workable | A documented package improves the plan, with a persistent setup, combat or card-pool limit. |
| 4 Broad | Several compatible packages improve the plan and its finish; important restrictions still apply. |
| 5 Exceptional | The commander supplies repeatable resources and a direct finish; on-theme additions strengthen both. |

A grade requires a published upgrade discussion covering the same commander configuration, two or more legal nonstock card examples, and original reasons describing **card support, commander payoff and restrictions**. The published author supplies evidence, not Yama's number. These are ordinal categories, without equal power steps or predicted win-rate gains. No distribution across levels is required. Generic ramp/removal upgrades alone do not establish a high grade.

Effort is separate: **Targeted** refines the main package; **Moderate** replaces several packages; **Substantial** removes much of the shell. These describe work, not spending, purchase priority or Commander brackets. No cards are installed or ordered by an assessment.

For example, Y'shtola's damage can trigger on successive qualifying casts and pairs with damage-to-draw cards. Tidus's combat draw/proliferate happens only once each turn. These restrictions matter more than calling both engines “scalable.” Quantum Quandrix's token doubling still needs token production and a finish. The linked guides and individual rationales explain each grade.

## Commander choices and theme

Commander configuration is checked explicitly. A different commander from the box gets its own assessment and exact comparison list. An outside commander can qualify when it retains the precon’s main theme and card packages. Explain the retained engine and cards, the change in payoff, and the number of card copies retained. Replacing the strategy is a separate build, outside this grade. Card overlap alone does not establish theme continuity.

Fantastic Four has four featured commanders: Invisible Woman, Mister Fantastic, Human Torch and The Thing. Crystal, Inhuman Princess and Power Pack are also legal in-box leaders for the complete stock pool. All six are listed. Their current source-backed upgrade assessments are 3/5, 4/5, 4/5 and 3/5 for the featured four respectively; Crystal and Power Pack remain ungraded. The package view therefore reports a supported 4/5 with 4/6 configurations graded, naming Mister Fantastic and Human Torch. This does not rank their stock performance.

The EDHREC package guide covers all six plans, so it can support the named assessments alongside checked nonstock card examples. The earlier MTGGoldfish guide supports Mister Fantastic’s configuration only. Counter Intelligence likewise keeps Inspirit and Kilo’s evidence separate. The inventory checks all eligible legendary cards and supported pairs, rather than assuming every box has only one alternate.

## Win rates, reviews and deck quality

Stock-precon results and reviewed simulation results retain their existing sources and methods. Upgradeability, commander observations and review opinions have **no weight in the stock meta rank**. The new data does not establish a commander ranking.

Commander outcomes come from [Playgroup's documented public API](https://playgroup.gg/.well-known/openapi.yaml), whose [aggregate-data licence](https://playgroup.gg/legal) is CC BY 4.0, with attribution to Playgroup.gg / Arcane Digital B.V. Each observation preserves its individual endpoint, raw wins, games, fetch time and response hash. The displayed percentage is `100 * wins / games`. Zero games has no rate; below 20 games is labelled a small sample. Provider refresh time is unknown, not the fetch time.

These commander aggregates mix stock and modified lists, opponents, pilots, power levels and pod sizes. They are **not four-player normalised** and not a controlled upgrade trial. Partners are separate commander observations, never inferred pair outcomes. The bulk directory and individual endpoints can return different counts; each displayed fraction uses one endpoint's wins and games. Do not subtract a stock-precon percentage to estimate an upgrade's gain. A large sample does not remove selection bias.

Other sources were assessed rather than pooled indiscriminately:

- [EDHTop16](https://edhtop16.com/) measures competitive tournament participation and advancement. Conversion is not game win rate and does not describe a stock list. It remains a separate research link, with no imported competitive score or conversion-to-win transformation.
- [EDHREC's FAQ](https://edhrec.com/faq) describes deck inclusion data. Inclusion and popularity are not outcomes. This release does not add a bulk EDHREC dataset adapter. It links named articles, attributes short original summaries and retains dated evidence from the existing research snapshot.
- Published guides from MTGGoldfish and Card Kingdom provide named upgrade examples. Reviews can disagree with simulations or other authors. We retain their dates and scopes instead of averaging letter grades, popularity and win rates into a synthetic quality score.

Prepared downloads are exact 100-card inputs with command-zone-sensitive fingerprints. Use them as separate entrants in the same shared tournament when comparing commanders; do not transfer a reference result onto an alternate. The first authorized campaign selects 30 in-box configurations from the ten previously covered families, plus Koma and common benchmark precons, at 100 appearances per configuration per engine (Phase and Forge). A queued run is not a result. No stock-versus-commander conclusion or measured upgrade gain is assigned before matched results and uncertainty are available.

## Data and maintenance

`server/resources/precon-upgradeability.json` is the hand-reviewed input: original rationales, source metadata, exact commander coverage, checked example cards and MTGJSON name/quantity/board stock snapshots. Examples were checked against Scryfall for current Commander legality, colour identity and absence from the stock list on 27 October 2026. Rules links identify the checked card; no images or rules documents are bundled.

`server/resources/commander-evidence.json` contains only commander aggregate facts. It excludes public deck/player records, graphs, images and API keys. Refresh with:

```sh
python3 scripts/research/fetch_commander_evidence.py --missing-only
# Omit --missing-only for a full refresh.
python3 -m unittest discover -s scripts/research -p 'test_*.py'
```

The importer checks identity and wins/game consistency, uses a descriptive User-Agent and one request per second, and preserves old observations with their old dates when a refresh fails. Failures are recorded and cause a nonzero exit; they are not converted into zeros. Inspect the resulting diff before release. Refreshing game data never changes grades automatically.

Validate any new or edited comparison lists using a current public Scryfall snapshot mapping case-folded front-face names to card objects:

```sh
python3 scripts/research/validate_commander_paths.py --facts /path/to/public-card-facts.json
```

The validator writes dates and fingerprints only after every prepared list passes. Validation uses explicit exceptions, remains active under optimized Python, and checks every command-zone row has exactly one copy. It accepts individual eligible commanders, including legendary Vehicles/Spacecraft with printed power and toughness. Pairs require compatible Partner, named Partner with, Friends forever, Choose a Background, or Doctor’s companion rules; unrelated mechanisms cannot be mixed. Colour identity alone is insufficient. Individual partner statistics never become inferred pair results. The facts file is a local research input, not a bundled rules document.

`server/src/upgradeability.rs` supplies the shared DTO and rubric. Grades fail closed if source commander coverage, examples or written reasons are absent. Exact stock identity ignores order, printing, name case and double-faced back-face notation; changed names, quantities or command zone require a matching assessment. A recognized, validated alternative receives only its own evidence. Other changes invalidate the assessment and its attached evidence. Unknown imports and private variants do not inherit a stock grade. Missing grades sort last. Comparison sorting uses the highest supported in-box grade with visible assessed/total coverage. Outside swaps cannot supply a package grade. ID-only stock ratings, Playgroup results and Lab matchup entries are suppressed when a known family’s current list differs from its frozen reference, including recognized alternatives. Explicitly published simulation snapshots still require their own exact list hash. Alternative downloads require both a recognized current catalog snapshot and the exact validated fingerprint; they read no private tables.

When revising a grade, read the actual guide and commander rules, verify its configuration and current card examples, and record source publication/access dates separately from the assessment date. Do not use a review of another commander as support. Use concrete triggers, costs and restrictions in prose; remove unsupported superlatives and generic lists of “efficient” cards. Run Rust, web and importer checks. Re-evaluate the rubric version if the meanings change.

Commander ranking remains separate future work.

`inventory_precon_commanders.py --facts ...` rebuilds `precon-commander-roster.json`. It records the frozen reference fingerprint, every stock-compatible eligible commander/pair, rule links, legality blockers and other included legends needing card-pool changes. Runtime only expands matching frozen references; inventory-only options have no assessment date, rationale or inherited grade. Explicit authored assessments override inventory-only entries by commander configuration, independent of pair ordering.

`prepare_commander_tournament.py --output ...` prepares the first shared-field request and its input-fingerprint manifest. MCP `start_lab_run` accepts labelled `entrant_lists` for versus/tournament, combined with existing named entrants. These are frozen experiment inputs, never saved decks; normal validation, owner isolation, quotas and review/apply still govern creation.
