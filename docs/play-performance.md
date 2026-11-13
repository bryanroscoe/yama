# Play performance

Measured 2026-10-24 on Bryan's Mac (Apple M3 Pro, 11 cores, 18 GB, macOS 26.6.2) with release builds: phase v0.113.0 with Yama's patches 0001-0008 (the fork at 678e4be) and card data eb309108. Other agents were compiling Rust on the same machine the whole time (load average 7 to 14 on 11 cores), so engine, AI and view times are the game thread's CPU time, which doesn't count time another process had the core. Even CPU time ran 20 to 40% slower under that load than in a quieter run earlier the same day, so read the numbers as upper bounds. Times that include the database are wall-clock time and are the ones the load affects most.

## Budgets

| What | Budget | Where it stands |
|---|---|---|
| A person's move, from the `act` message received to every seat's view sent, not counting AI thinking | p95 under 100 ms | Within it with one person and three AI seats: p50 9 ms, p95 17 ms, max 23 ms. With four people, over it: p50 27 ms, p95 117 ms, max 0.6 s, almost all of it passing for the other three people and re-issuing their decisions (below). |
| Building one seat's view (board, event feed, decision with `pending`, card details) | under 20 ms per seat | Within it: p50 3 to 4.5 ms, p95 5 to 7 ms; the slowest single view 36 to 50 ms (a deciding seat with a big board), about 1 in 2,000 views over 20 ms. |

## A person's move on the server

The server's `play::bench`, two games per row (seeds 31 and 32, Medium AI), wall-clock times in ms over every move a person made (53 moves with one person, 294 with four). "Move to every view sent" is what the budget is about; the rows under it are its parts, in CPU time.

| | 1 person, 3 AI (now) | 1 person, board shown at every hand-over | 1 person, loop detection off | 4 people |
|---|---|---|---|---|
| Move to every view sent, p50 / p95 / max | 9.2 / 17.0 / 22.9 | 14.1 / 37.5 / 50.1 | 11.4 / 20.9 / 27.3 | 26.9 / 117 / 627 |
| the move itself | 4.4 / 9.0 / 12.0 | 5.5 / 13.3 / 22.0 | 4.8 / 10.1 / 18.7 | 4.9 / 23.2 / 82.5 |
| passing for the people with nothing to do | 0.4 / 2.2 / 7.9 | 0.4 / 3.5 / 13.9 | 0.4 / 2.3 / 7.7 | 5.8 / 80.1 / 533 |
| of the two above: telling everyone what happened | 1.8 / 2.7 / 10.1 | 2.1 / 5.3 / 12.8 | 2.0 / 3.6 / 15.9 | 2.3 / 8.9 / 12.8 |
| of the two above: re-issuing people's decisions | 0.3 / 1.9 / 3.0 | 0.2 / 2.4 / 3.4 | 0.4 / 2.3 / 7.0 | 2.4 / 35.9 / 233 |
| every view (a spectator's and each person's) | 4.5 / 6.5 / 7.5 | 6.5 / 10.7 / 13.6 | 5.0 / 8.7 / 9.4 | 12.6 / 25.6 / 69.9 |
| one connection's message | 0.09 / 0.15 / 0.24 | 0.11 / 0.28 / 0.87 | 0.09 / 0.16 / 0.32 | 0.09 / 0.27 / 23 |
| saving the game after it (not before the views) | 0.30 / 0.52 / 3.6 | 0.43 / 4.9 / 8.2 | 0.31 / 1.4 / 44 | 0.29 / 0.92 / 122 |
| the computer's turns: views and saves, total | 0.9 s in 96 batches | 6.6 s in 553 | 4.0 s in 570 | |
| from a move to the person's next decision, AI thinking included | 48 ms / 2.4 s / 20 s | 83 ms / 3.7 s / 24 s | 52 ms / 10 s / 42 s | 1.4 / 32 / 175 |

The three one-person columns are the same games (the same 1,617 and 1,210 actions with loop detection on), so the second column is only the old way of showing the computer's turns. Loop detection off plays slightly different games (its passes are the AI's stack sessions).

With four people every pass is a person's, so after each move Yama passes for up to three people, and each pass re-issues the decision of everyone still to act, to tell whether it changed (`Match::remark`). On a big board issuing a decision (the engine's list of legal actions, checked against the rules) takes tens of milliseconds, which is the p95. Passing no longer issues the decision it passes twice (`Match::choose_issued`), but the re-issue per pass is still there; it keeps a person's answer valid while someone else acts (PP-06), so it wasn't cut.

**How the round trip came down.** The first run of the day, before the changes below, measured p50 84 ms and p95 216 ms for the one-person row, with the move itself at p50 47 ms. Most of that was telling every viewer what happened (five copies of the game per action) and issuing the same decision several times per pass. The machine was busier during that run than the last, so the drop isn't all the changes; the comparisons inside one run (the columns above, and the feed below) are the reliable ones.

## AI decisions by level

The playbench tables (this section, loop detection's cost and views) were measured before the feed and pass changes listed below, so their engine times per action are a little higher than now; AI and view times are unaffected.

CPU time of one AI decision (`Match::ai_thinking`), two 4-player games of 30 turns per level (seeds 1000 and 1001), loop detection on as online games have it. About 2,700 decisions per row.

| Level | p50 ms | p95 ms | max ms | CPU per game turn, p50 / p95 / max (s) |
|---|---|---|---|---|
| Easy | 0.4 | 7.5 | 446 | 0.15 / 0.63 / 1.5 |
| Medium (the default for AI seats) | 0.6 | 32 | 848 | 0.36 / 1.7 / 3.6 |
| Hard | 0.4 | 43 | 1,488 | 0.34 / 1.3 / 5.8 |
| VeryHard (not offered on the board) | 0.7 | 60 | 5,083 | 0.37 / 2.9 / 11.3 |

A turn here is every seat's AI decisions and the engine's work from one turn to the next, without building views. Most decisions are a pass with nothing else to do; the long ones are combat and main-phase plays with big boards.

**The AI's clock.** AI seats used to search against phase's 1.5-second wall-clock budget. They now search to their node and depth budgets only (`AI_CLOCK` off, as the lab always has), so every choice depends only on the game. In the first run of the day the same seeds played identical games with the clock on and off at Easy and Hard (the same 1,333 and 1,248 actions): the budget changes a decision only when the search reaches 1.5 seconds, which on Hard is one or two decisions in 2,600. Those few now run to the end: up to 1.7 s on Hard and 5 s on VeryHard here, under load.

## Loop detection's cost

The same seeds with phase's loop detection off and on (`Setup::loops`). With it on, every pass is an ordinary engine pass rather than the AI's stack session (`Match::plain_passes`), so games take about 3% more actions (8% at Easy), and the AI searches a copy of the game with the detector off.

| Level | CPU per action off (ms) | on (ms) | change |
|---|---|---|---|
| Easy | 3.6 | 4.7 | +29% |
| Medium | 14.1 | 12.7 | -10% |
| Hard | 15.8 | 14.0 | -11% |
| VeryHard | 21.9 | 20.0 | -9% |

The games split apart once a choice differs, so the higher levels' differences are noise; what's left is the engine's own sampling, which shows at Easy where the AI costs little: engine time per action 2.2 ms off, 2.7 ms on. Before the AI searched a copy with the detector off, an earlier run (wall-clock time) had Hard's AI taking about 60% longer with loop detection on: 17 s to 28 s of AI time over the same two games, which were otherwise identical.

## Views

Per seat, after every action of the games above (about 10,000 views per row, every seat's and a spectator's):

| Level | view p50 ms | p95 | max | of which the engine's filtered copy, p50 | derived presentation, p50 | JSON, p50 |
|---|---|---|---|---|---|---|
| Easy | 2.9 | 5.4 | 37 | 2.3 | 0.10 | 0.04 |
| Medium | 3.9 | 6.6 | 59 | 3.1 | 0.13 | 0.05 |
| Hard | 3.6 | 6.1 | 42 | 2.9 | 0.12 | 0.05 |
| VeryHard | 4.1 | 6.7 | 50 | 3.2 | 0.13 | 0.05 |

Views average 25 KB of JSON (the largest 106 KB). Most of a view's time is phase's `filter_state_for_viewer`, the copy of the game with what this seat may not see taken out. The deciding seat's view used to make that copy twice (once for the board, once for the decision's labels and `pending`); it now makes it once, which saves that seat 2.3 to 3.2 ms a view (the decision itself takes p95 4 to 6 ms on top).

## Changes made for speed

- **A seat's view makes its filtered copy of the game once** (`Match::decision_seen`), instead of again for the decision.
- **The computer's turns are shown and saved in batches** (`ai_batch` in server/src/play.rs): every 40 actions, and when a person has a decision. With every pass its own engine action, the old loop showed the board and saved the whole replay log at every hand-over between the computer and a pass made for a person: 553 times over the two games instead of 96, 6.6 s of views and saves instead of 0.9 s.
- **A connection's message is written straight to text** (`ViewMessage`), without building a JSON value of the whole view first, and without copying the view unless a decision has to be dressed with card details: p50 0.09 ms instead of 0.39, p95 0.15 instead of 1.06, measured on the same views.
- **The AI searches a copy with loop detection off** (above). Since 13 Nov 2026 a seat that has every card of a combo it was told about decides on the game itself in its own main phase with an empty stack, so those decisions pay for the detector again (ARCHITECTURE.md, "The computer knows its deck's combos").
- **Telling every viewer what happened names public cards from one copy of the game** (feed.rs, `Lens`). It used to make each viewer's own filtered copy for every action with something to tell, five per action at a 4-player table. Now the spectator's copy, made once per action, names every card a spectator can name (public cards look the same to everyone), and a seat's own copy is made only for a card it alone can see. On the same playbench games (Easy and Medium, played side by side): engine and bookkeeping time per action p95 18.9 to 11.5 ms (Easy) and 23.9 to 12.0 ms (Medium), and 25% less of it in total at Medium.
- **Passing for a person reuses the decision its rules were read from** (`Match::window_issued`, `choose_issued`) instead of issuing it twice more.

## Not changed, and why

- **The replay log is saved whole after every change** (`persist`). It grows with the game (80 to 134 KB at the end of these games); saving it took p50 0.3 ms and p95 under 5 ms on a file database. Saving only new actions would need a table of actions instead of one column; not worth a migration at these sizes.
- **The spectator's view is built on every publish** even when nobody watches; it is one view of 3 to 4 ms per publish. Skipping it needs the game thread to know who is connected; left for now.
- **The engine's filtered copy** is phase's own function and most of a view's cost. Making it cheaper is an engine change.

## How it's measured

- **`playbench`** (`play/src/bin/playbench.rs`): 4-player games with phase's AI on every seat, through `Match` as the server drives it, with four of Bryan's current plans, one per seat (Riders of Rohan, Prismari Artistry, Lorehold Spirit and World Shaper, `*-3-after-prints.txt`, copied to `play/tests/fixtures/decks`). After every action it builds every seat's view and a spectator's (`--profile` also times their parts). It plays the same seeds with loop detection off and on, and with the AI's clock off and on.
- **The server's `play::bench` test** (`server/src/play_bench.rs`, ignored by default): the same decks, with one person and three AI seats (Medium), and with four people. The AI chooses each person's move, untimed; then the server's own work is timed with the code the game thread and the sockets run: the move (`choose`, `declare_*` or `act`), passing for people (`auto_pass`), every view (`snapshot`), each connection's message (card details from SQLite, the dressed decision, the JSON; `view_message`), and saving the game (`persist`, to a file database in WAL mode, like the server's). It also times the wait from one of a person's moves to their next decision, AI thinking included.
- p50, p95 and max are over every action (or move, or turn) of every game in a run.

## Reproduce

```sh
cargo build --release -p yama-play --bins
./target/release/playbench data/engine/card-data-eb309108eb0df708.json --games 2 --clock off --loops both --profile
YAMA_ENGINE_CARD_DATA=data/engine/card-data-eb309108eb0df708.json \
  cargo test --release -p yama-server play::bench -- --ignored --nocapture
```

## Slow games the budgets don't cover

- **Big late-game boards.** In soak game 23 (Bryan's four plans, Easy), the last two turns, with World Shaper's board full, took about ten minutes: 342 s of the game's AI time and 40 s of engine time, with no single AI decision over 2.8 s. That is phase's AI and engine on a very large board, not Yama's part; a person facing that table would wait minutes between decisions.
- **Scute Swarm.** In soak game 21 Scute Swarm copies doubled on each landfall of a World Shaper turn. Every copy's trigger needs every player to pass, the board grows each time, and each action gets slower: the turn was still going after 50 minutes. Such a turn now stops the AI at 12,000 actions (`TURN_ACTION_LIMIT`), as a turn that changes nothing stops it at 3,000 (`STALL_ACTION_LIMIT`); before, online games had no limit at all. That bound is in actions, not time: replayed with it, the same turn was still short of it after 15 minutes, because each action gets slower as the board grows. A bound in CPU time would stop it sooner, at the cost of the stopping point depending on the machine; that's a decision for Bryan.
