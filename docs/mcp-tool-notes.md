# Notes on Yama's tools

The longer notes that used to sit in tool descriptions. Tool descriptions say what a tool is for;
this says how to read what it returns. Served to assistants as the resource
`yama://guide/tool-notes`.

## Staged changes

A write tool stages a change. It waits in Yama (Decks, Suggested changes) for the person to apply
or discard, and nothing changes until then. Stage a change when they ask for it or agree to it,
not as a guess. Pass `op_id` (a new UUID for each change) so a retry after a lost reply stages
once. `list_changes` with an `id` shows one change whole; check it before `apply_change`.

## Games (`list_games`, `get_game`)

Each game has a `format`: `commander`, `standard` (Constructed), `limited` or `other`. A game
played as one game of a best-of-three or best-of-five match has `match_id`, `match_game` (which
game of the match, from 1) and `match_best_of`, and `match_wins` and `match_draws`: the score
before that game, by that game's seat numbers. Each game is still its own game, counted on its
own. `get_game` lists the match's games you can see (`match_games`, each with its winner's name).

## Precons (`get_precon`)

- Real results are playgroup.gg's, with dated history: the all-time rate, an approximate recent
  rate between snapshots and its trend, or the commander's own figure when the list isn't rated.
- `evidence.all_lists` adds Mythic Tools' wins over every list under the exact commanders. They
  count toward the rating only for a precon without stock games that passed the leave-one-out
  test.
- Upgradeability grades run from 1 to 5 and come with their reasons, card examples and named
  reviews. A grade without support is null: that is not a low grade.
- Each commander configuration has its own grade and comparison list. A swap that keeps the
  theme is the same build; replacing the strategy is a separate build.
- Commander win rates mix stock and modified lists. Never subtract one from another to claim an
  upgrade gain.

## Lab runs (`start_lab_run`, `get_lab_run`, `list_lab_games`)

- Simulated games are AI against AI in a rules engine. Read the paired difference with its
  interval, not one win rate. A game that ran out of CPU time, crashed or failed isn't scored.
- Games per engine are a size the account may run: 20 on the one short run a day every account
  gets (Phase only), 100, 200 or 400 for power users (more for admins). Left out, a new run takes
  the smallest. A refusal says the limit and what was used. For a tournament the number is
  appearances per deck, and the games actually scheduled are what the allowance is charged.
- A run on both engines plays every pod on each. Its ETA and queue position are for Phase;
  Forge has its own queue. Admins also see how many earlier Phase games are ahead in the
  shared queue. Other accounts' runs and decks are never shown.
- A game replays move for move from its schedule line on the same engine build
  (`list_lab_games` with `game`), unless a seat was told its list's combos (the server
  freezes them with the run; the command-line runner can't be given them yet).

## Shopping (`get_shopping_trip`, `set_shopping_rules`, `set_store_preference`, `check_stores`)

- Stores are the person's own list. The trip picks the fewest stores that cover the most cards
  under their buy rule: a favourite store is on every trip it has a card for; an ok store is used
  normally; a maybe store only for cards no other store has; a never store not at all.
- The buy rule: a listing qualifies at or under `always_ok_usd` whatever the market; otherwise it
  may cost at most `max_usd` and at most `max_multiple` times the market price, by the first tier
  whose `market_under` is above the market (null: any market). With tiers, a card whose market
  price is unknown qualifies only at or under `always_ok_usd`. A new rule set applies from the
  day it is applied, so older checks keep the rules of their own day.
- A listing is a dated quote from a snapshot, not a purchase and not proof the card is still
  there. `check_stores` stages a read of the stores' sites; it runs only when the person applies
  it. Read `yama://shopping/workflow` before treating research as a shopping list.

## Prints (`swap_in_prints`)

When printed proxies arrive and are sleeved in: the linked deck gets the plan's after-prints list
as a new version; the prints go into the deck's box as proxies; a card moving in from another
deck comes out of that deck's box; each card leaving goes to the deck that takes it next, to the
deck's box for cards that go back in at a lower bracket, or to a box called Spares; and the swaps
are ticked installed. The staged change's preview says exactly what applying does.

## Prices

A market price is a dated reference (TCGplayer market through Scryfall by default), not a store
quote and not proof of stock. A missing price is unknown: `null` beside a `null` date, never zero.
`get_price_history` reads one source at a time: TCGplayer market, Card Kingdom retail, Card
Kingdom buylist (what it was paying for near-mint copies, not what a seller will get) or Mana
Pool's lowest listing. Days Yama didn't read are gaps.

## Notes and plans (`save_research`, `track_build`)

A note is saved research: a deck's builds, each with swaps and reasons. `track_build` makes one
build the deck's plan straight away: nobody approves a plan (since 20 Nov 2026), so its changes go
in at once and feed the shopping list (nothing is bought until they mark it). A change whose cut
clashes (no card named, a cut the plan already makes, two changes cutting one card) is left out as
unsure, with the reason in its note, and the answer names it; fix the build and save the note
again. Saving the note again updates a plan that tracks it. A save that would stop a plan is refused unless
`stop_plans` is true.

## A plan's history (`get_plan_history`, `record_plan_history`)

Since 21 Nov 2026 (ARCHITECTURE.md, "Where a plan came from"). Before saying why a change is in a
plan, read `get_plan_history`, with `card` for one change: its group, when it arrived and from
which plan file (with its commit) or note, which version took it in or left it out and why, every
answer as it arrived and who gave it, and what assistants recorded about it or its group.

Record an entry whenever you make or change a plan's proposals, so the next assistant doesn't have
to dig through old conversations:

- `on` is the day it happened (the request, the audit), not the day you record it.
- `what` says what was made or changed and why, in a sentence or two.
- `asked` quotes the person's own words; leave it out rather than paraphrase.
- `conversation` says where to find the conversation (a thread's link or title, a session id);
  `work` where the work is (a commit, a file, a note id).
- `group` and `cards` tie it to a proposal group or to changes, as `get_plan` names them; a name
  the plan doesn't have is refused with the ones it does.
- `replaces` with an entry's id corrects it; `op_id` makes a retry record it once.

`track_build` takes `asked` and `conversation` and records them with the build it tracks.
