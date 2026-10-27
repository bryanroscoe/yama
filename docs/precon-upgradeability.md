# Precon upgradeability

Yama shows one shared upgradeability assessment on public precon pages and comparisons, signed-in Lab pages and comparisons, public/private catalog APIs, and the advisor/MCP `precon` context. The field is distinct from stock simulations, Playgroup results, prices and future commander rankings.

The initial catalog covers all 174 currently imported, distinct stock precons. These are **provisional editorial assessments**, written October 27, 2026 against the saved MTGJSON stock lists. They are not upgraded-list test results or an external consensus. They do not establish that a particular swap improves a deck. No private collection, purchase or proposal data is included.

## Rubric

This is an ordinal rubric, not a calibrated power scale. A one-point difference is not a measured performance difference. The initial catalog does not force entries into every level.

| Score | Meaning |
|---|---|
| 1 Limited | Few coherent upgrade routes without replacing the identity |
| 2 Constrained | Worthwhile improvements, with structural commander or theme limits |
| 3 Good | Clear improvements, with meaningful setup or card-pool constraints |
| 4 High | A well-supported engine with several useful upgrade packages |
| 5 Very high | A deep, scalable engine with substantial room for focused optimization |

Every assessment retains the stock commander and theme. Commander swaps, cEDH conversion and abandoning the theme are not used to inflate the score. Color count, retail value, EDHREC popularity and simulated win rate are not score inputs. The assessment considers coherent upgrade routes, the ability of the engine to scale, and structural limitations. Each entry states an improvement path and a limiting factor so the judgment can be challenged.

Effort is separate from potential: **Targeted** refines an established engine; **Moderate** refocuses several packages; **Substantial** rebuilds much of the shell. These are qualitative amounts of work, not dollar budgets or exact card counts. Proxy use does not alter potential. No specific Commander bracket is implied.

Examples: Scions & Spellcraft has very high potential with substantial refocusing of the stock creature/Equipment packages. Counter Blitz has very high potential with targeted improvements to its existing counters engine. Quantum Quandrix has very high token-engine potential despite weak stock simulation results. The rubric does not claim one of these commanders is competitively strongest.

## Data and maintenance

`server/resources/precon-upgradeability.json` contains original Yama assessments, dates, a versioned method, MTGJSON stock-list links, and a name/quantity/board snapshot. It contains no images or copied rules text. `server/src/upgradeability.rs` loads it once and provides the common DTO.

Assessments match the exact stock identity by names, quantities and command zone, ignoring order, printing, name case and double-faced front/back notation. A changed stock list or commander gets `stock_list_changed` and no score. An unknown import gets `not_assessed` and no score. Missing never means zero. New catalog imports therefore remain visible without silently acquiring an invented grade. The same rules apply to public and signed-in reads. Personal upgraded lists do not inherit a stock assessment merely because their commander matches.

When assessing a new precon or revising a judgment, inspect the stock list, commander and proposed direction; update the dated evidence and retain the rubric version unless the rubric itself changes. Test stale-list detection, API agreement and sorting. Review claims before publishing. The frozen source lists allow an assessment to be reproduced, but they are not independent validation of the editorial verdict.

Commander rankings are deferred. They need their own method, evidence and interpretation; this field is not a substitute.
