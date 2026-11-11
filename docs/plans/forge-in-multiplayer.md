# Forge in multiplayer, and switching engines

**Status:** Proposed, 11 Nov 2026. Nothing here is built yet.

**Asked for:** Bryan, 30 Oct 2026: players choose Forge or Phase, resume either engine from an
earlier point, and eventually switch the engine of an ongoing game. Asked again 11 Nov 2026: "I
would like there to be the ability to switch between Phase and Forge engines in the multiplayer
mode." Going all in on Phase for play never ruled this out. It was recorded as a requirement
(ARCHITECTURE.md, "Engine choice and direct restoration") and left unbuilt.

**The rules it has to follow** are already written in
[game engines and saved points](../game-engines-and-checkpoints.md): privacy, consent, saved-point
guarantees and acceptance tests. This plan is how to build it and in what order. Where the two
disagree, the contract wins until Bryan changes it.

## What people would see

1. **Choosing the engine when hosting.** The new-game screen gets "Rules engine: Phase or Forge".
   It applies to the whole table. Beside each choice: how many cards in the seated decks that
   engine can't play, and its AI levels. A rematch keeps the engine unless the host changes it.
   Existing games are Phase games.
2. **Playing a Forge game** works like a Phase game: the same lobby, invites, AI seats, turn
   controls, watching, game log, results in game history and playgroup stats, each labelled with
   its engine.
3. **Starting over in the other engine** (proposed first step towards switching): from a game in
   progress or a finished game's timeline, "Continue this position in Forge/Phase" makes a *new*
   game from that position. The original game is untouched. Every human seat has to agree before
   the new game starts.
4. **Switching the live game** (last): the same thing in place, keeping the game's identity.
   It's only offered at positions the plan below calls clean, and says why when it isn't.

## What exists today

- **Phase plays every online game.** `server/src/play.rs` runs one Phase `Match` per game on its
  own thread (the `yama_play` crate, `play/`), saves a seed and action log, and serves two boards:
  Phase's own board (`/api/play/{id}/board`, `server/src/play/board.rs`) and Yama's own board
  (`web/src/play/`, from `yama_play`'s `View` and `Pending`).
- **Forge only plays whole AI games for the Lab.** `forge-worker/` is an HTTP front, in the
  `yama-forge` container on a private network, that plays a game from start to finish and reports
  the result. Since yama3 each slot keeps one long-lived JVM (`forge_serve.py`, `yama-serve.jar`).
  It has no way to stop and ask anyone a question.
- **An outside process can already make choices for a Forge seat.** The Forge LLM seat
  (`~/Developer/forge-referee/llm`, 4 Nov) puts a controller in a seat that asks Claude about
  priority plays, attacks, blocks, single targets and modes, and lets Forge's AI do the rest. That
  proves the plumbing but not the coverage: a person has to make every choice.
- **Forge already has network multiplayer.** Its desktop and mobile apps play remote games:
  a human seat's `PlayerControllerHuman` asks its questions through a GUI interface (`IGuiGame`,
  about 80 calls: choose from a list, order cards, pick a number, confirm, select cards on the
  board, pay mana, declare attackers and blockers), and Forge's server
  (`forge-gui/.../gamemodes/net`) sends those calls to remote clients and syncs the game view to
  them. This is the most important fact for the plan: by answering *those* calls instead of
  writing our own controller, every choice Forge would ask a person at its own table is covered.
- **The referee already loads one position into both engines.** `referee/` scenarios describe a
  board (life, zones in order, tapped, damage, counters, whose turn, which step) that both Phase and
  Forge set up. That format is the starting point for moving a game between engines.

## How we'd build it

### 1. A Forge program that plays with people (Forge side)

A new program beside `serve/` and `llm/` in forge-referee, say `play/`, built into Yama's Forge
distribution like `yama-serve.jar`. It's Forge code (GPL-3.0), so it lives there, not in Yama.

- Human seats use Forge's own `PlayerControllerHuman` with a Yama implementation of `IGuiGame`.
  Each call becomes a JSON *decision* (a decision id, the kind, the options with Forge's object
  ids, min and max, the prompt text) and blocks until the answer arrives. AI seats use Forge's AI
  at the chosen level.
- Each update sends each seat's view of the game: Forge's `GameView` as that player may see it
  (their own hand, public zones, revealed cards; never another player's hand or library order).
  The spike checks that Forge's own network play already filters this per player, and the
  privacy tests below check it again.
- One JVM per live game to start. yama3's JVMs reset Forge's process-wide state *between* games,
  which says running two games at once in one JVM isn't safe without more work.
- Commands are JSON lines over the JVM's stdin and stdout, as `forge_serve.py` does now. An answer
  carries its decision id; an answer to a decision that's no longer open is refused, never
  applied to the next one.

### 2. The worker's session API

`forge-worker/worker.py` gains live sessions next to batch games, on the same private network with
the same shared secret, and still with no account details or internet: start a game (decks,
seats, AI levels, seed), read each seat's latest view, submit an answer (command id and decision
id; a repeated command id is a no-op), concede a seat, end the game. It reports how many live
slots it has, separately from Lab slots.

### 3. One engine boundary in Yama's server

- `online_games` gets an `engine` column (`phase` or `forge`; every existing row `phase`), as the
  Lab's games did in migration 0017.
- The game thread talks to an engine through one interface: start, submit a seat's command, view
  for a viewer, public timeline entry, end, and later capture and restore. The Phase side wraps
  today's `Match`; the Forge side calls the worker. Engine-specific choices stay opaque, as the
  contract asks: Yama never squeezes Forge's decisions into Phase's legal-action list.
- Yama keeps everything that isn't rules: who may sit and act, quotas, command ids, stale-decision
  refusal, remembered answers, turn controls, the game log, results and account deletion. A Forge
  game counts as more than one against hosting limits (the Lab counts a Forge game as 2), and the
  host form only offers Forge while the worker has a free live slot.

### 4. A board for Forge games

Phase's board speaks Phase's wire protocol and Phase's types, so it can't show a Forge game.
The proposal is to show Forge games on **Yama's own board** (`web/src/play/`) through an
engine-neutral table view (players, zones, cards, stack, combat, whose turn) and a small set of
generic decisions (choose N from a list, order a list, pick a number, yes or no, select cards on
the board, pay a cost, declare attackers, declare blockers). Forge's prompts are already generic,
so most map one to one. Phase games keep both boards. This keeps Yama's board alive, which
ARCHITECTURE.md had marked for retirement: that's open decision 1 below.

### 5. Reconnecting, restarts and history

A browser that drops reconnects to the running JVM, as Phase games do. Until saved points exist,
a Forge game can't survive the worker or its JVM restarting: it ends as abandoned and says so
plainly, and the host can rematch. Every Forge game still keeps its decision log for history, but
the plan doesn't promise it replays exactly (Forge's randomness has to be checked first; yama2
already removed one source of it). Results go to game history and playgroup stats with the engine
and its build label, like Lab results.

### 6. Saved points (contract step 3)

Resume any recorded point without replaying earlier moves, for both engines, as
[the contract](../game-engines-and-checkpoints.md) specifies. Phase has a checked restore boundary
(`PersistedGameState`). Forge doesn't: its in-memory snapshot and board import don't cover a
suspended choice, so this needs real persistence work inside Forge, kept in forge-referee with its
own tests.

### 7. Moving a game between engines

The contract's rule: never relabel one engine's internal state as the other's. Export what the
position *means*, check the other engine can hold all of it, and refuse otherwise without touching
the source game.

- **Format:** grow the referee scenario format into a versioned position: every zone in order
  (hidden zones included, kept private), each permanent's state, counters, attachments, face-down
  and transformed faces, commanders and commander tax, commander damage, life, poison, emblems,
  whose turn and which step, with cards matched by Oracle id and printing.
- **Clean positions first:** start of a step, empty stack, no pending choice, no delayed triggers
  and no effects with a duration still running. Anything else is refused with the reason. Widen
  it with fixtures afterwards, as the contract says.
- **"Continue in the other engine" before "switch in place".** A new game from an exported
  position needs no change to the original game's identity, history or saves, and its consent
  step is simpler. Switching in place is the same export, plus the extra rules for keeping one
  game's identity across two engines.
- **Tests:** the referee's two-engine harness compares the position in both engines after the
  move and keeps playing both under scripted choices, per the contract's acceptance list.

## Order and when each step is done

| Step | Done when |
|---|---|
| 0. Spike | The Forge program plays a 2-player game where one seat is answered by a script, and a list of every `IGuiGame` call seen across a few dozen real precon games exists. Per-player filtering of Forge's view is confirmed or ruled out. |
| 1. Forge program and worker sessions | Every decision kind seen in the spike has a fixture; duplicate and stale answers are refused; a seat never receives another seat's hidden cards. |
| 2. Engine boundary in Yama | Phase games run through the new interface with no change in behaviour (existing play tests pass); Forge games start, take commands and end on the server; privacy, deletion and quota tests cover Forge games. |
| 3. Board | A Forge game plays start to finish on Yama's board, on a phone and a laptop, behind an admin-only flag. |
| 4. Hosting choice | The engine choice, coverage per engine, rematch, watching, history and playgroup stats work for everyone, and the host form hides Forge when there's no free slot. |
| 5. Saved points | The contract's acceptance evidence for both engines. |
| 6. Continue in the other engine | Clean positions move both ways with the referee harness's checks; unclean ones are refused with a reason. |
| 7. Switch in place | Consent from every human seat; the same checks as step 6. |

Steps 0 to 4 give Bryan engine choice at table creation. Step 6 is what most people mean by
switching; step 7 may not be worth its cost once step 6 exists.

## Costs and risks

- **Memory.** A Forge JVM peaks around 1.5 to 1.8 GB. saget's `yama-forge` runs 6 Lab slots under a
  13 GB cap. Each live Forge table takes a slot's worth of memory for as long as the game lasts,
  which is much longer than a Lab game, because people think. Live tables either take slots from the
  Lab or need their own cap and more memory.
- **Speed.** Forge's AI is slower than Phase's (Lab games average about 95 s against 20 s), so AI
  turns at a Forge table will feel slower.
- **Coverage.** The two engines can't play different cards; the host sees both before choosing.
- **Licence.** Forge stays a separate GPL program that Yama calls, as the Lab worker does now. The
  new Forge-side code lives in forge-referee and ships in Yama's Forge build, not in Yama.
- **Clean room.** Whoever reads Forge's source to build its side still doesn't write Phase specs
  or fixes (`referee/README.md`).

## Open decisions for Bryan

1. **Which board shows Forge games.** Keep Yama's own board alive for them (proposed), or build
   something new. Phase's board can't show them.
2. **Capacity.** How many live Forge tables at once, and whether they take priority over Lab runs
   on saget or need their own memory (or a remote worker).
3. **Who gets it first.** Admins only, invited accounts, or everyone at step 4.
4. **Switching.** Whether "continue this position in the other engine" (step 6) is enough, or the
   in-place switch (step 7) is still wanted.
