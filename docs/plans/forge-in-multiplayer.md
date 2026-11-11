# Forge in multiplayer, and switching engines

**Status:** Proposed, 11 Nov 2026. Nothing here is built yet.

**Asked for:** Bryan, 30 Oct 2026: players choose Forge or Phase, resume either engine from an
earlier point, and eventually switch the engine of an ongoing game. Asked again 11 Nov 2026: "I
would like there to be the ability to switch between Phase and Forge engines in the multiplayer
mode." Moving online play onto Phase's engine and board didn't rule this out: ARCHITECTURE.md
says the Phase board "is a board integration, not interactive Forge support", and records engine
choice and switching as requirements not yet built ("Engine choice and direct restoration").

**The rules it has to follow** are already written in
[game engines and saved points](../game-engines-and-checkpoints.md): privacy, consent, saved-point
guarantees and acceptance tests. This plan is how to build it and in what order. Where the two
disagree, the contract wins until Bryan changes it.

## What people would see

1. **Choosing the engine when hosting.** The new-game screen gets "Rules engine: Phase or Forge".
   It applies to the whole table. Beside each choice: how many cards in the seated decks that
   engine can't play, and its AI settings (Phase's difficulty levels; Forge's AI profiles:
   Default, Cautious, Reckless, Experimental). A rematch keeps the engine unless the host changes
   it. Existing games are Phase games.
2. **Playing a Forge game** works like a Phase game: the same lobby, invites, AI seats, watching,
   game log, results in game history and playgroup stats, each labelled with its engine. Turn
   controls (stops, passing, full control) map onto Forge's own auto-pass and skip-step settings.
   Remembered answers need their own Forge version. Going back a step in a solo game isn't
   available for Forge until saved points exist (step 5).
3. **Starting over in the other engine** (proposed first step towards switching): from a game in
   progress or a finished game's timeline, "Continue this position in Forge/Phase" makes a *new*
   game from that position. The original game is untouched. Every human seat has to agree before
   the new game starts.
4. **Switching the live game** (last): the same thing in place, keeping the game's identity.
   It's only offered at positions the plan below calls clean, and says why when it isn't.

## What exists today

- **Phase plays every online game.** `server/src/play.rs` runs one Phase `Match` per live game on
  its own thread (the `yama_play` crate, `play/`), saves a seed and action log, and serves two
  boards: Phase's own board (`/api/play/{id}/board`, `server/src/play/board.rs`) and Yama's own
  board (`web/src/play/`, from `yama_play`'s `View` and `Pending`). Games saved by an older Phase
  build replay in a preserved older runtime in its own process (`spawn_historical`). Which runtime
  a game uses is decided by `games.engine_version`: an identity the server doesn't know is
  refused, and only the current build's identity is written back.
- **Forge only plays whole AI games for the Lab.** `forge-worker/` is an HTTP front, in the
  `yama-forge` container on a private network, that plays a game from start to finish and reports
  the result. Since yama3 each slot keeps one long-lived JVM (`forge_serve.py`, `yama-serve.jar`).
  It has no way to stop and ask anyone a question.
- **An outside process can already make choices for a Forge seat.** The Forge LLM seat
  (`~/Developer/forge-referee/llm`, 4 Nov) puts a controller in a seat that asks Claude about
  priority plays, attacks, blocks, single targets and modes, and lets Forge's AI do the rest. That
  proves the plumbing but not the coverage: a person has to make every choice.
- **Forge already has network multiplayer.** Its desktop and mobile apps play remote games. A human
  seat's `PlayerControllerHuman` asks for decisions in two ways:
  - **Dialogs** through its GUI interface, `IGuiGame`: choose from a list, choose several, order
    cards, pick a number, confirm, and so on. `IGuiGame` has about 80 methods, but most only
    update the display; in Forge's network play about 18 of them wait for an answer.
  - **Inputs** for everything click-driven: priority, casting and activating, targets, paying
    mana, attackers, blockers, mulligans, choosing cards on the board (`InputPassPriority`,
    `InputAttack`, `InputBlock`, `InputPayMana`, `InputSelectTargets`, `InputSelectCardsFromList`
    and others). An input shows a prompt and which cards and players can be picked, then waits
    while the player clicks cards, players, abilities and OK or Cancel through the other
    interface, `IGameController`.

  Forge's server (`forge-gui/.../gamemodes/net`) carries both to remote clients. This is the most
  important fact for the plan: by answering *those* two channels instead of writing our own
  controller, every choice Forge would ask a person at its own table is covered.
- **Forge's network play does not hide cards from other players.** It sends every client the
  whole game view, hands and libraries included, and each client hides what its player shouldn't
  see when it draws the screen. Yama can't work like that: our Forge program has to remove hidden
  cards for each seat before anything leaves it.
- **The referee loads simple positions into both engines.** `referee/` scenarios describe a
  two-player board (life, cards by name, library order, tapped, damage, counters, whose turn, a
  step before combat or the end step) that both Phase and Forge set up. Combat, multiplayer,
  the command zone, commander tax and attachments aren't in it yet, and its Forge runner is built
  against Forge 2.0.15 rather than Yama's Forge build. It's the starting point for moving a game
  between engines, not the finished format.

The Forge source read for this plan (`~/Developer/forge-src`) is the 2.0.15 release; production
runs Yama's build of a later master. The spike checks these facts on that build.

## How we'd build it

### 1. A Forge program that plays with people (Forge side)

A new program beside `serve/` and `llm/` in forge-referee, say `play/`, built into Yama's Forge
distribution like `yama-serve.jar`. It's Forge code (GPL-3.0), so it lives there, not in Yama.

- Human seats use Forge's own `PlayerControllerHuman` with Yama's implementations of `IGuiGame`
  and `IGameController`. Each blocking dialog becomes one *decision* (a decision id, the kind,
  the options with Forge's object ids, min and max, the prompt) and waits for the answer. Each
  input becomes a decision too: "pick from these cards, players or abilities, then OK or Cancel",
  answered one step at a time, as Forge's own client does it. AI seats use Forge's AI with the
  chosen profile.
- After every change, each seat gets its own view of the game, with everything that seat may not
  see removed by the program: other hands, library order, face-down cards. Forge's own visibility
  rules (`CardView.canBeShownTo`, `mayPlayerLook`) decide what that is. Decisions are checked the
  same way, since a choice can list cards (a search, a reveal).
- One JVM per live game to start. yama3's JVMs reset Forge's process-wide state *between* games,
  which says running two games at once in one JVM isn't safe without more work. A JVM takes about
  5 seconds to start.
- Commands go over the JVM's stdin and stdout, a line each, as `forge_serve.py` does now (it uses
  tab-separated fields; the live program would use JSON lines). An answer carries its decision
  id; an answer to a decision that's no longer open is refused, never applied to the next one.

### 2. The worker's session API

`forge-worker/worker.py` gains live sessions next to batch games, on the same private network with
the same shared secret, and still with no account details or internet: start a game (decks,
seats, AI profiles, seed), read each seat's latest view, submit an answer (command id and decision
id; a repeated command id is a no-op), concede a seat, end the game, list running sessions. It
reports live slots separately from Lab slots, and says what it can do as separate flags, as the
contract asks: interactive play, direct restore, and import from the other engine. Batch play
implies none of them.

A session belongs to the worker, not to a connection, so it keeps running while the Yama server
restarts and Yama picks it up again by session id when it starts, as `resume_live` does for Phase
games.

### 3. One engine boundary in Yama's server

- `online_games` gets an `engine` column (`phase` or `forge`; every existing row `phase`), as the
  Lab's games did in migration 0017. `games.engine_version` keeps the exact build: Phase's
  identity for Phase games, the Forge program's label (like the Lab's
  `forge 2.0.16-…+yama3.…`) for Forge games. The runtime check that refuses unknown identities
  learns the Forge labels the worker reports, so a Forge game isn't mistaken for a Phase game with
  an unknown build.
- The game thread talks to an engine through one interface: start, submit a seat's command, view
  for a viewer, public timeline entry, end, and later capture and restore. The Phase side wraps
  both of today's Phase runtimes (the current `Match` and the preserved older one); the Forge side
  calls the worker. Engine-specific choices stay opaque, as the contract asks: Yama never squeezes
  Forge's decisions into Phase's legal-action list.
- Yama keeps everything that isn't rules: who may sit and act, quotas, command ids, stale-decision
  refusal, remembered answers, turn controls, the game log, results and account deletion.
- **Limits.** A live Forge table holds about 1.8 GB for as long as it lasts, so it needs its own
  cap on open Forge games; how much a Forge game counts against hosting limits is part of decision
  2 (the Lab's weight of 2 per Forge game is about CPU, not memory). The host form offers Forge
  only while the worker has a free live slot, the slot is taken when the game starts, and Start
  says so plainly when none is free rather than starting a game that can't run.

### 4. A board for Forge games

Phase's board speaks Phase's wire protocol and Phase's types, so it can't show a Forge game.
The proposal is to show Forge games on **Yama's own board** (`web/src/play/`) through an
engine-neutral table view (players, zones, cards, stack, combat, whose turn) and a small set of
generic decisions (choose N from a list, order a list, pick a number, yes or no, select cards or
players on the board then OK or Cancel, pay a cost, declare attackers, declare blockers). Forge's
dialogs map onto these closely; its inputs (attacks, blocks, paying mana) are step by step and
need the most board work. Phase games keep both boards. This keeps Yama's board alive, which
ARCHITECTURE.md had marked for retirement: that's open decision 1 below.

### 5. Reconnecting, restarts and history

- A browser that drops reconnects to the running game, as Phase games do.
- A Yama restart (every deploy) doesn't end a Forge game: the worker keeps it and Yama reattaches
  (section 2).
- Until saved points exist, a Forge game can't survive its JVM or the `yama-forge` container
  restarting. That includes a deploy that changes `forge-worker/` or the Forge build, which
  rebuilds the container. Such a game ends as abandoned and says so plainly, and the host can
  rematch. Releases that touch the worker should wait for live Forge games to finish, or say they
  will end them.
- Every Forge game still keeps its decision log for history, but the plan doesn't promise it
  replays exactly (Forge's randomness has to be checked first; yama2 already removed one source of
  it). Results go to game history and playgroup stats with the engine and its build label, like
  Lab results.

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

- **Format:** grow the referee scenario format into a versioned position: multiplayer, every zone
  in order (hidden zones included, kept private), each permanent's state, counters, attachments,
  face-down and transformed faces, the command zone, commanders and commander tax, commander
  damage, life, poison, emblems, whose turn and which step, with cards matched by Oracle id and
  printing rather than name.
- **Clean positions first:** start of a step, empty stack, no pending choice, no delayed triggers
  and no effects with a duration still running. Anything else is refused with the reason. Widen
  it with fixtures afterwards, as the contract says.
- **"Continue in the other engine" before "switch in place".** A new game from an exported
  position needs no change to the original game's identity, history or saves, and its consent
  step is simpler. Switching in place is the same export, plus the extra rules for keeping one
  game's identity across two engines.
- **Tests:** the referee's two-engine harness, moved onto Yama's Forge build, compares the position
  in both engines after the move and keeps playing both under scripted choices, per the contract's
  acceptance list.

## Order and when each step is done

| Step | Done when |
|---|---|
| 0. Spike | The Forge program plays a 2-player game on Yama's Forge build where one seat is answered by a script, and sends each seat a view with the others' hidden cards removed. The facts above are checked against that build. |
| 1. Forge program and worker sessions | Every blocking `IGuiGame` dialog and every input `PlayerControllerHuman` can raise, listed from Forge's source rather than from games seen, has a fixture, or the program refuses a game that would need it with a reason. Duplicate and stale answers are refused; no seat receives another seat's hidden cards, in views or in decisions; sessions survive a Yama restart. |
| 2. Engine boundary in Yama | Phase games, current and older builds, run through the new interface with no change in behaviour (existing play tests pass); Forge games start, take commands and end on the server; privacy, deletion and limit tests cover Forge games. |
| 3. Board | A Forge game plays start to finish on Yama's board, on a phone and a laptop, behind an admin-only flag. |
| 4. Hosting choice | The engine choice, coverage per engine, rematch, watching, history and playgroup stats work for whoever decision 3 names, and Start explains when no Forge slot is free. |
| 5. Saved points | The contract's acceptance evidence for both engines. |
| 6. Continue in the other engine | Clean positions move both ways with the referee harness's checks; unclean ones are refused with a reason. |
| 7. Switch in place | Consent from every human seat; the same checks as step 6. |

Steps 0 to 4 give Bryan engine choice at table creation. Step 6 is what most people mean by
switching; step 7 may not be worth its cost once step 6 exists.

## Costs and risks

- **Memory.** A Forge JVM peaks around 1.8 GB (1.5 GB of it heap). saget runs 6 Lab slots under a
  13 GB cap in its own compose override (`deploy/compose.yaml` itself says 3 slots and 7 GB). Each
  live Forge table holds a JVM for as long as the game lasts, which is much longer than a Lab game,
  because people think. Live tables either take memory from the Lab or need more.
- **Speed.** Forge's AI is slower than Phase's (whole Lab games average about 95 s against 20 s),
  so AI turns at a Forge table will feel slower.
- **Coverage.** The two engines can't play different cards; the host sees both before choosing.
- **Licence.** Forge stays a separate GPL program that Yama calls, as the Lab worker does now. The
  new Forge-side code lives in forge-referee and ships in Yama's Forge build, not in Yama.
- **Clean room.** Whoever reads Forge's source to build its side still doesn't write Phase specs
  or fixes (`referee/README.md`).

## Open decisions for Bryan

1. **Which board shows Forge games.** Keep Yama's own board alive for them (proposed), or build
   something new. Phase's board can't show them.
2. **Capacity.** How many live Forge tables at once, how much one counts against a person's hosting
   limit, and whether they take priority over Lab runs on saget or need their own memory (or a
   remote worker).
3. **Who gets it first.** Admins only, invited accounts, or everyone at step 4.
4. **Switching.** Whether "continue this position in the other engine" (step 6) is enough, or the
   in-place switch (step 7) is still wanted.
