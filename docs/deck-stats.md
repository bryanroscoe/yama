# Deck stats and mana access

Reviewed October 26, 2026. Deck stats are pure functions in `packages/core/src/deckStats.ts`, rendered by `web/src/components/DeckStats.tsx`. The same deck and card data give the same result. No LLM, live web recommendation, random sampling or hidden power score is used for these stats. Card-data updates can change the inputs. Bracket suggestions separately use dated Commander Spellbook results and fixed interpretation rules; they are not a deterministic judgment of a deck's actual power.

## Mana counts are descriptive

Yama shows the nonland mana curve, average mana value, land count, creatures, and each color's spell-cost pips and potential land access. The pip and access bar columns scale independently, so their lengths compare colors within a column rather than imply a target ratio between different units. It does not label a color short or recommend adding lands from total pip ratios. The former `sources * 3 < pips` rule was arbitrary and is removed from both computation and UI. A land can be tapped again on later turns; total pips across the whole deck are not a simultaneous mana requirement.

Land access is potential, not a claim that the source is untapped and usable on a chosen turn. It includes land back faces and conditional producers from Scryfall's `produced_mana`. Fetches get credit only for matching land targets actually in the list, including the colors of typed dual lands. A spell-front/land-back card cannot be fetched as a land from the library. Basic-land searches count only basics present. One source may appear under several colors; those counts cannot simply be added together to count distinct lands. Nonland ramp, activated spell abilities, spending restrictions, fetch sequencing and target depletion are not modeled. Hybrid symbols appear in both colors, although either color may pay them. Missing source data stays missing.

## What would justify a castability warning

A future check should identify a particular spell and desired casting turn, then state its probability target, library size, draw/play assumptions, Commander mulligan rules, and treatment of ramp and tapped or conditional sources. Multicolor costs share sources; marginal probabilities cannot be multiplied as independent events. Optional costs, hybrid choices and alternative costs need explicit handling. It should show the spell, inputs, assumptions and calculation behind a warning. There is no universal three-pips-per-land target.

Frank Karsten's [2022 source-requirement study](https://www.tcgplayer.com/content/article/How-Many-Sources-Do-You-Need-to-Consistently-Cast-Your-Spells-A-2022-Update/dc23a7d2-0a16-4c0b-ad36-586fcca03ad8/) was read on the rendered TCGplayer page (listed as updated February 13, 2025; the text remains the 2022 update). It evaluates colored symbols by casting turn, conditional on sufficient total lands, with an explicit mulligan model. Its Commander tables assume 41 lands in 99 cards and include multiplayer's free mulligan and first draw. Its handling of fetches, pathways, ramp and tapped lands includes stated approximations. Yama does not apply its tables without those assumptions or claim that our descriptive counts reproduce that analysis.

## Product research

These are first-party feature descriptions, not independent validations of the products' math or a claim to have tested every screen.

- **Moxfield:** inspected its current [public precon deck page](https://moxfield.com/decks/n3QS3JZ_zkmwLhmLDTc8Sw) in the rendered browser on October 26 (site version 2026.10.26.1). It shows clickable curve bars with a card breakdown, average and median mana values with and without lands, color-symbol/production distributions, a hypergeometric calculator and sample hands. Its [official feature wiki](https://github.com/moxfield/moxfield-public/wiki/Features) also documents these feature families, but was last edited in 2020. The on-curve percentage was observed, not independently validated. Useful direction for Yama: readable summaries and drill-down, with distributions separate from castability estimates.
- **Archidekt:** the team's [playtester-log announcement](https://archidekt.com/news/13186079) documents charts of mana production, draws/mills, power and mana value of cast spells. Useful direction: observe mana development in playtests instead of inferring all consistency from aggregate pips. Yama's static deck counts are separate from engine results.
- **ManaBox:** the [official site](https://manabox.app/) advertises deck charts and a deck simulator. That page does not document a castability formula, so no algorithmic claim is inferred. Useful direction: concise mobile stats and a route to testing hands.
- **EDHcheck:** its [July 2026 mana-analysis announcement](https://edhcheck.com/updates/mana-base-analysis/) describes per-color probabilities at specified turns, pip/source comparisons, source requirements and land classification. This is the vendor's description, not an audit of the implementation. Useful direction: expose per-turn assumptions and distinguish descriptive counts from probability analysis.

## Verification

Core tests cover quantities, sideboard exclusion, averages, hybrids, missing data, available fetch targets, typed duals and land back faces. The UI regression test ensures even a large white-pip total does not produce a shortage badge. Repeated calculations and reordered input yield the same numerical stats. Tests and real deck previews use the implementation itself; a made-up preview is never evidence that a user's deck lacks a color.
