# Yama documentation

Where everything is written down. New here? Read the [README](../README.md), then
[features.md](features.md) for what Yama does and [ARCHITECTURE.md](../ARCHITECTURE.md) for how
it is built.

Four kinds of page live in this folder, and it helps to know which you are reading:

- **Guides and formats** describe how something works now. They are kept current.
- **Designs** record what was decided and why, before or while it was built. The code may have
  moved on in details; [ARCHITECTURE.md](../ARCHITECTURE.md) holds the latest decision.
- **Dated reports** (a date in the filename) are a measurement or review from that day. They
  are evidence, and are never updated.
- **Future plans** ([plans/](plans/README.md)) describe work not yet built or approved: how it
  would look, how to build it, and the decisions still open.

## Start here

| Page | What it covers |
|---|---|
| [features.md](features.md) | Everything Yama does today, area by area. |
| [ARCHITECTURE.md](../ARCHITECTURE.md) | The system with diagrams, then the dated record of every decision. |
| [development.md](development.md) | Running Yama locally, the server's commands, sign-in, and the checks. |
| [AGENTS.md](../AGENTS.md) | The working rules for the coding agents that build Yama. |
| [SECURITY.md](../SECURITY.md) | How to report a vulnerability. |

## Assistants (MCP)

| Page | What it covers |
|---|---|
| [MCP feature and setup guide](https://yama.ing/docs/mcp/) | The public guide: what the tools do and how to connect an assistant. |
| [mcp-design.md](mcp-design.md) | Design of Yama's MCP server and its OAuth connection. |
| [mcp-parity.md](mcp-parity.md) | Which Magic MCP capabilities Yama's tools cover, and how to use them. |
| [ui-mcp-parity.md](ui-mcp-parity.md) | What the pages can do against what the tools can do. |
| [mcp-tool-notes.md](mcp-tool-notes.md) | Longer notes the tools serve to assistants: precon evidence, lab runs, shopping rules, prices. |
| [codex-plugin.md](codex-plugin.md) | The Codex and ChatGPT plugin in `plugins/yama/`. |

## Cards, collection and prices

| Page | What it covers |
|---|---|
| [scanner.md](scanner.md) | How the camera scanner recognises a card and picks its printing. |
| [mythic-bridge.md](mythic-bridge.md) | Notes on Mythic Tools' API for the import bridge. |
| [shopping-design.md](shopping-design.md) | Design of store shopping: stock checks, rules and trips. |
| [local-shopping-workflow.md](local-shopping-workflow.md) | Buying a deck configuration's cards from local stores, step by step. |

## Decks and plans

| Page | What it covers |
|---|---|
| [deck-import.md](deck-import.md) | Deck sources and formats, and what each site allows. |
| [deck-stats.md](deck-stats.md) | The mana stats on a deck page and the research behind them. |
| [deck-analysis.md](deck-analysis.md) | How a deck's power level and its vectors are worked out. |
| [planner-design.md](planner-design.md) | The per-user deck planner: final design. |
| [planner-design-critique.md](planner-design-critique.md) | A critique of that design from 18 October 2026. |
| [plan-format.md](plan-format.md) | The plan file format, `yama-plan/1`. |
| [research-format.md](research-format.md) | Private deck research: what a note holds, and what sharing one shows. |

## Game night

| Page | What it covers |
|---|---|
| [table-parity.md](table-parity.md) | The life counter compared with Lifetap and Mythic Tools. |
| [history-corrections.md](history-corrections.md) | The audited command for correcting recorded game history. |

## Online play and the engine

| Page | What it covers |
|---|---|
| [engine-integration.md](engine-integration.md) | How the Phase engine is embedded, pinned and upgraded, and how its card data is built. |
| [game-engines-and-checkpoints.md](game-engines-and-checkpoints.md) | The contract for engine choice and saved game points. |
| [gameplay-validation.md](gameplay-validation.md) | The full-game checks that `cargo test` leaves out. |
| [card-coverage.md](card-coverage.md) | What the engine supports for each card in the tested decks (generated; data in `card-coverage.json`). |
| [play-performance.md](play-performance.md) | How fast a move is, and where the time goes. |
| [play-polish-requirements.md](play-polish-requirements.md) | Requirements for the online board's polish. |
| [game-interactions-design-backlog.md](game-interactions-design-backlog.md) | Design backlog for in-game decisions. |
| [../runtime/README.md](../runtime/README.md) | The frozen runtime that reopens games saved on an older engine. |
| [../referee/README.md](../referee/README.md) | Rules scenarios run in both Phase and Forge. |

## Lab and evidence

| Page | What it covers |
|---|---|
| [lab-workers.md](lab-workers.md) | Running Lab games on the server, a laptop or GitHub Actions. |
| [datasets.md](datasets.md) | Importing historical real-game evidence as immutable datasets. |
| [public-precons.md](public-precons.md) | The public precon reference and how results are published. |
| [precon-upgradeability.md](precon-upgradeability.md) | How precon upgradeability is sourced and graded. |
| [star-trek-precons.md](star-trek-precons.md) | The Star Trek stock precon lists. |
| [public-precon-publication.example.json](public-precon-publication.example.json) | An example publication manifest. |
| [experiments/](experiments/) | Recorded Lab pilots. |
| [../forge-worker/README.md](../forge-worker/README.md) | Forge as a second Lab engine. |

## Building and releasing

| Page | What it covers |
|---|---|
| [ci.md](ci.md) | GitHub CI: what runs, the local equivalent, and when CI may be skipped. |
| [release-trains.md](release-trains.md) | Landing several pull requests through one gate and one deploy. |
| [../deploy/RELEASING.md](../deploy/RELEASING.md) | The release rules: what may deploy, and from where. |
| [../deploy/RUNNER.md](../deploy/RUNNER.md) | The deploy workflow, the host's release gate, pause and recovery. |
| [../deploy/README.md](../deploy/README.md) | Running Yama on its host: layout, sign-in setup, sidecars, backups. |
| [../relay/README.md](../relay/README.md) | The shared table's Cloudflare relay and how it deploys. |
| [mobile.md](mobile.md) | The Android app and the plan for Google Play. |
| [play-release-guide.html](play-release-guide.html) | The Google Play release walkthrough (open it in a browser). |
| [polish.md](polish.md) | Screenshots of every page at every size, with layout and copy checks. |

## Design

| Page | What it covers |
|---|---|
| [../design/tokens.md](../design/tokens.md) | The "Night table" design system: colour, type, spacing and copy rules. |
| [../design/README.md](../design/README.md) | The design handoff: screens, components and the logo. |
| [redesign/](redesign/) | The site plan, the plans redesign and the deck page spec. |
| [research/](research/) | Surveys of other Magic apps and of Arena's interface, from 18 October 2026. |

## Future plans

| Page | What it covers |
|---|---|
| [plans/README.md](plans/README.md) | What goes in the plans folder, and every plan with its status. |
| [plans/forge-in-multiplayer.md](plans/forge-in-multiplayer.md) | Choosing Forge or Phase when hosting a game, then moving a game between them. Proposed. |

## Dated reports

| Page | What it covers |
|---|---|
| [game-interactions-review-2026-10-23.md](game-interactions-review-2026-10-23.md) | Design review of in-game interactions. |
| [engine-recovery-2026-10-25.md](engine-recovery-2026-10-25.md) | Recovering the engine after gameplay failures. |
| [phase-performance-2026-10-27.md](phase-performance-2026-10-27.md) | A Phase AI performance measurement. |
| [simulator-performance-2026-10-27.md](simulator-performance-2026-10-27.md) | Where simulation time and memory go. |
| [engine-upgrade-acceptance-2026-10-30.md](engine-upgrade-acceptance-2026-10-30.md) | Acceptance evidence for the engine upgrade. |
| [engine-acceptance-fixes-2026-10-30.md](engine-acceptance-fixes-2026-10-30.md) | The fixes that acceptance required. |

## Keeping this tidy

- The [README](../README.md) is the front page. Keep it short: what Yama is, the diagram, how
  to run it, and links.
- A shipped or changed feature goes in [features.md](features.md).
- A decision goes in [ARCHITECTURE.md](../ARCHITECTURE.md), dated, under the decision record.
  If it changes how the system fits together, update the overview and its diagrams too.
- A plan for work not yet built goes in [plans/](plans/README.md) with a status line, and moves
  into ARCHITECTURE.md once Bryan approves it.
- A new page in this folder gets a row here.
