# UI and MCP parity

Bryan, 2026-11-09: "Anything we can do in the UI we can do in the MCP and anything we can do in the
MCP we can do in the UI, for the most part. It doesn't need to be perfect, but someone using mostly
the UI can do most of the things the MCP can do. A potential superset." He also asked to keep track
of the things we don't have good designs for as we go.

This is the working map. [mcp-parity.md](mcp-parity.md) is a different comparison (Yama's MCP against
other Magic MCP servers); [mcp-design.md](mcp-design.md) is how the MCP works. Update this file
whenever a page or a tool gains or loses a capability.

## Rules for closing a gap

- **Same code, two doors.** A new tool calls the function the page's route calls (refactor the
  handler into a `pub(crate)` function taking the pool and owner id, as `games::history_page`,
  `games::game_detail`, `collection::summary_for`, `collection::containers_for`,
  `playgroups::groups_for` and `playgroups::stats_for` do), so owner
  checks and numbers can't drift apart.
- **Writes from the MCP are staged** (mcp-design.md, "Changes are staged, then reviewed"). A page
  action that changes decks, collection, plans, shopping or the lab becomes a staged change, never
  a direct write. Research notes and review answers are the existing exceptions.
- **A UI version of an MCP tool needs a design first.** Anything listed under "No good design yet"
  stays MCP-only until it has one (design/tokens.md, the Night table rules in AGENTS.md); don't
  bolt a raw tool form onto a page.
- **Some things stay one-sided on purpose** (see the last section). Say so here rather than
  leaving a silent gap.

Legend: **Both** (each side can do it), **UI only**, **MCP only**, **Partial** (one side does
part of it). "Gap" rows are the backlog, in rough priority order inside each area.

## Cards and prices

| Capability | UI | MCP | Status |
|---|---|---|---|
| Search Yama's card catalog (local grammar) | Cards | `search_cards` | Both |
| One card: Oracle text, legality, rulings, owned copies | Card view | `get_cards` | Both |
| One card: which of your decks run it, and its combos in them (kept Commander Spellbook checks) | Card view | — (`get_deck` per deck) | **Gap (MCP)** for the across-decks view |
| Printings and their prices | Card view | `list_card_printings` | Both |
| Price history over time | Card view (PriceHistory) | `get_price_history` | Both |
| Add a copy of a printing from the card | Card view | `add_to_collection` (staged) | Both |
| Release calendar; watch a set | Cards (Upcoming) | — | **Gap (MCP)**, read the calendar; watching is a small staged write |
| Full online Scryfall search (complete grammar) | — | `search_scryfall` | MCP only. Gap: see "No good design yet" |
| Official rules, subrules, glossary lookup | — | `search_rules` | MCP only. Gap: no design |
| Data sources, freshness, limits | What's new / footer notes (partial) | `get_research_sources` | Partial |

## Decks

| Capability | UI | MCP | Status |
|---|---|---|---|
| List decks | Decks | `get_overview` | Both |
| Read a deck: list, bracket, legality, Game Changers, results | Deck page | `get_deck` | Both |
| Stats: curve, colors, combos, bracket reasons, value | Deck page, Stats tab; Why this bracket | `get_deck_analysis` | Both (MCP has role hints, UI has the charts) |
| Edit the list (add/remove) | Edit list | `edit_deck` (staged) | Both |
| Create a deck from a pasted list | Import | `save_deck` (staged) | Both |
| Import a public Moxfield or Archidekt deck | Import | `get_public_deck` + `save_deck` | Both |
| Version history and differences | Deck page, History tab | `list_deck_versions`, `compare_decks` | Both |
| Restore an older version | History tab | `save_deck` with the old list | Both |
| Validate a list without saving | Import preview, Edit list | `check_deck_list` | Both |
| Delete a deck or configuration | Deck settings | `delete_deck` (staged) | Both |
| Rename, move to a box, declare a bracket | Deck settings, Declare bracket | `update_deck` (staged): name and declared bracket | Partial (2026-11-11): **Gap (MCP)** for moving a deck to a box |
| Export the list as text | Deck export (copy, .txt) | `get_deck` returns the list | Both |
| Bracket check (re-run) | Bracket, Why this bracket | `get_deck`, `get_deck_analysis` | Both |
| Configurations: save a copy as a new list, make a list the one in the box | Deck page | Read via `get_deck`; delete via `delete_deck` | **Gap (MCP)** for creating and switching |
| Add a deck's cards to the collection, optionally as proxies (Collect) | Collect sheet | — | **Gap (MCP).** Stage `collect_deck` |
| Deck check: scan or tick the cards physically in the box | Check, Scan pages | — | UI only (physical; camera) |
| Share a deck (visibility, new link) | Share deck | — | **Gap (MCP)**, privacy-sensitive: stage it, never apply from Ask Claude |
| Send a deck to Mythic Tools | Deck page | — | UI only (outside service hand-off) |
| Online play support (what the engine can't run) | Stats tab | — | **Gap (MCP)**, read |
| Sample opening hands, mulligan | Deck page, Sample hand | `sample_hands` (seeded, several hands) | Both |
| Exact draw probabilities | — | `get_mana_probability` | MCP only. Gap: no design |
| Land sequencing and colored-mana test | — | `test_mana` | MCP only. Gap: no design |
| Combos in the deck | Stats tab (combos, Why this bracket) | `search_combos(deck, share_list)` | Both |
| Search combos by card (not in a deck) | — | `search_combos(query)` | MCP only. Gap: no design |
| Commander recommendations (EDHREC) | Link out on precon pages | `get_commander_recommendations` | MCP only. Gap: no design |
| Game results for a deck | Stats tab, History tab | `get_deck` | Both |

## Collection

| Capability | UI | MCP | Status |
|---|---|---|---|
| Browse and filter copies | Collection | `list_collection_cards` | Both |
| Totals, market value, paid, per-container values | Collection | `get_collection_summary` | Both (added 2026-11-09) |
| Add copies | Collection, Scanner | `add_to_collection` (staged) | Both |
| Move copies between containers | Collection | `move_cards` (staged) | Both |
| Set condition | Collection item sheet | `set_condition` (staged) | Both |
| Edit one copy: finish, printing, price paid, proxy, remove | Collection item sheet | `edit_copies`, `remove_from_collection` (staged), by card and container | Both (2026-11-11) for copies in a binder, box or list; **Gap (MCP)** for changing the printing and for copies not in a container |
| Mark a copy signed or altered, or set its language | Collection item sheet | — | **Gap (MCP)**: `edit_copies` doesn't set them |
| Create or delete a binder, deck box or list | Collection | `create_container` (staged) | Partial (2026-11-11): **Gap (MCP)** for deleting one |
| Rename a binder, deck box or list | — (the server has `PATCH /api/containers/:id`) | — | **Gap (UI and MCP)** |
| Export CSV | Collection | — | UI only (a file download; the MCP reads the same rows) |
| Import from Mythic Tools export | Collection, Mythic import | — | UI only (file upload) |
| Import a pasted list or another app's export (ManaBox, Moxfield, Archidekt, Deckbox, Dragon Shield, TCGplayer) | Collection, Import cards | `add_to_collection` (staged), card by card | Partial: **Gap (MCP)** for a whole list or file |
| Scan cards with the camera | Scanner | — | UI only (camera) |
| Sell list (CSV) and local buylist offers (Mothership) | Sell sheet, Sell offers | — | **Gap (MCP)**, read the dated offers |

## Plans, shopping and stores

| Capability | UI | MCP | Status |
|---|---|---|---|
| Plans overview, one plan | Plans, plan page | `get_overview`, `get_plan` | Both |
| Use a note's build as the plan | Build choices, "Use a deck from it" | `track_build` (staged) | Both |
| Approve a plan version, or keep the earlier one | Plan page | `approve_plan` (staged, `action` keep) | Both |
| Archive, restore or undo a plan; clear refused decisions | Plan page | — | **Gap (MCP).** Stage plan actions |
| Link a plan to a Yama deck | Plan page | `track_build` links its own; none for imported plans | **Gap (MCP)** |
| Review queue, answer a swap | Plan page, Changes | `get_review_queue`, `answer_review` | Both |
| Propose a swap | Plan page | `propose_swap` | Both |
| Mark bought, installed; swap in prints | Plan page, Get cards | `mark_bought`, `mark_installed`, `swap_in_prints` | Both |
| Shopping list, add a want | Get cards | `get_shopping_list`, `add_wish` | Both |
| Remove a want; deck gaps as wants | Trip | `remove_wish` (staged) | Partial (2026-11-11): **Gap (MCP)** for adding a deck's gaps as wants |
| Store trip | Trip | `get_shopping_trip` | Both |
| Shopping rules, store preferences | Plan settings, Trip | `get_shopping_settings`, `set_shopping_rules`, `set_store_preference` | Both |
| Store order; remove a dated rule set | Trip, Plan settings | — | Gap (MCP), small |
| Check stores' stock, read it | Get cards | `check_stores`, `get_store_stock` | Both |
| Sealed product quotes: add, remove | Trip (sealed) | `get_shopping_list` shows them | Partial: **Gap (MCP)** for recording a quote |
| Print proxies (MPC sheet), swap sheet, swap cards | Get cards (mpc, swap-sheet, swap-cards) | `get_shopping_trip` names what to print | Partial. The sheets are printable pages: UI only by nature |
| Import a plan file | Plans (Import, with a dry run) | — | UI only: a file; the MCP equivalent is `save_research` + `track_build` |
| Archived plans and earlier versions | Archived | `get_research` lists notes | Partial: **Gap (MCP)** for archived plan versions |
| Compare with a friend | Sharing, compare | `compare_with_friend` | Both |

## Research notes

| Capability | UI | MCP | Status |
|---|---|---|---|
| Read notes, builds, scenarios | Research | `get_research` | Both |
| Save or refresh a note | Plans, Import (upload the JSON) | `save_research` | Both. Writing a note's content is assistant-only by design (`plan/howto.tsx`) |
| Record a preference or note | Research | `review_research` | Both |
| Share a note (visibility, new link) | Research | — | **Gap (MCP)**, privacy-sensitive |
| Save a copy of a shared note | Research (`?copy=`) | — | Gap (MCP), low priority |
| Build choices across notes | Build choices | `get_overview` | Both |

## Lab, precons and datasets

| Capability | UI | MCP | Status |
|---|---|---|---|
| Precon rankings, one precon with evidence | Lab, precon detail | `get_precon` (one) | Partial: **Gap (MCP)** for the ranked list |
| Save a precon as a deck | Precon detail | `get_precon` + `save_deck` | Both |
| Start a run, more games, run again, cancel | Lab Try / Compare, run page | `start_lab_run`, `add_lab_games`, `rerun_lab_run`, `cancel_lab_run` (staged, power users) | Both |
| Runs, one run, games and tables | Runs, run, deck and table pages | `list_lab_runs`, `get_lab_run`, `list_lab_games` | Both |
| Delete a run | Runs, run page | — | Gap (MCP), staged |
| Batches of runs | Batch page | — | **Gap (MCP)**, read |
| Check which engine supports a list | Compare | `get_deck_analysis` (partly) | Partial |
| Datasets: list, read | Datasets | `list_datasets`, `get_dataset` | Both |
| Datasets: import (admin), export | Datasets | — | UI only (file upload/download) |
| Lab pace and engine status | Lab | — | Gap (MCP), low priority |

## Games and playgroups

| Capability | UI | MCP | Status |
|---|---|---|---|
| Game history, search, unfinished and unnamed games | Game history | `list_games` | Both (added 2026-11-09) |
| One game, its event log or, for an online game, its log | Game detail | `get_game` | Both (added 2026-11-09; online log 2026-11-11) |
| Life counter, share the table live | Table | — | UI only (live) |
| Clock for the turn and the game (per device) | Table menu | — | UI only (live); a finished game's length is in its event times |
| Log a past game, edit a logged game | Table setup, game detail | — | **Gap (MCP).** Stage `log_game` |
| Delete a game | Game detail | — | Gap (MCP), staged |
| Playgroups: list, stats (commanders, players, rivalries) | Playgroup | `list_playgroups` | Both (added 2026-11-09). Assistants get names, never account or member ids |
| A playgroup's games, including ones you weren't in | Playgroup | `list_games` with `playgroup` (a member only; checked in the query) | Both (2026-11-11) |
| Playgroups: start, join, add a guest | Playgroup | — | Gap (MCP), staged; low priority |
| Export games as CSV or JSON | Playgroup | — | UI only (a file) |
| Mythic Tools: import games, send a deck | Mythic pages | — | UI only for now (file and outside service) |
| Play online against people or AIs; watch AIs | Play, Watch | — | UI only (interactive) |

## Account and sharing

| Capability | UI | MCP | Status |
|---|---|---|---|
| Changes waiting for review: list, apply, discard | Changes, Ask Claude panel | `list_changes`, `apply_change`, `discard_change` (outside clients) | Both |
| Sharing settings (profile, collection, want list, decks) | Sharing | — | UI only on purpose for now: changing who sees your data is a privacy decision |
| Script keys, connected apps, Ask Claude settings and conversations | Plans settings, You > Settings | — | UI only on purpose (credentials) |
| Delete account | Settings | — | UI only on purpose |
| Admin pages | Admin | — | UI only on purpose |

## No good design yet

These are capabilities with no agreed UI design. Each needs a design pass (a canvas in
`design/`, the Night table tokens, every size in `npm run polish`) before it gets built. Add to
this list whenever a gap is found that can't simply reuse an existing pattern.

| Capability | Where it might live | Open design questions |
|---|---|---|
| Draw probabilities and land sequencing (`get_mana_probability`, `test_mana`) | Deck page, Stats tab beside the pip chart, or the Sample hand | How to define "sources" without a form full of numbers; how to show model limits honestly |
| Rules lookup (`search_rules`) | Card view (rules for this card's keywords), a search box in Cards | A rules reader page vs inline results; showing the edition and source date |
| Full Scryfall search (`search_scryfall`) | Cards, as a "search everything online" fallback | When to leave the local catalog; rate limits and paging; outside results' prices vs Yama's dated ones |
| Commander recommendations (`get_commander_recommendations`) | Deck page (Plan or Stats tab), precon detail | Presenting popularity without implying it's proof of strength; owned-first filter; budget tiers |
| Combo search by card (`search_combos(query)`) | Card view ("combos with this card") | Prerequisites and steps on a small screen; Commander Spellbook credit |
| Logging a finished game from the MCP | — (the Table already logs games) | Not a UI design question; the staged change needs a review card that shows seats and the winner |
| Staged-change review cards for every new tool kind | Changes, Ask Claude panel | Each new staged kind needs a before/after card that reads well; a generic JSON card is not acceptable |
| Sell list in the MCP | — | What an assistant should say about selling: buylist cash vs credit (AGENTS.md, deck valuation) |
| Renaming a container | Collection, container tile | Inline rename on a tile vs a sheet; the server route exists, nothing calls it |
| Plan actions from an assistant (archive, restore, undo) | — | Each needs a staged-change card that shows what the plan returns to |

## Stays one-sided on purpose

- **UI only:** camera scanning and deck checks, live life counter and online play (Alpha), Watch AIs,
  file uploads and downloads (Mythic import and send, CSV export, dataset import/export, printable
  sheets, the MPC print), credentials and connected apps, sharing settings, account deletion,
  admin, sign-in.
- **MCP only:** writing a note's content (the UI uploads, reads and reviews notes), and
  `apply_change`/`discard_change` for outside clients (the UI has its own buttons).

## Loose ends found while mapping

- `makeYamaDeck` in `web/src/plan/api.ts` (`POST /api/plan/decks/:key/yama-deck`) has no caller.
- `PATCH /api/containers/:id` (rename) has no caller.
- Saving scan photos (`/api/scan/samples`) looks like a training-data tool exposed as a device setting.
