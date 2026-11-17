# Replaying earlier boards in online play

Status: Proposed, 17 Nov 2026. Asked for by Bryan, 17 Nov 2026, while playing the computer:
"Be nice if they could rewind when they had a timeline or something to go back to."

## What shipped first

The smallest useful version is built ([features](../features.md#online-play)):

- The computer's moves are shown one visible step at a time, with a rest scaled by your play
  speed, so an attack, the blocks and the damage each get their own board.
- A callout when another player's spell, ability or creature does something to you, with the
  card that did it.
- "What just happened": a timeline of every happening since your last turn that you can step
  back through, with the cards involved and, for an attack, a block or damage, its arrows drawn
  again on the live board. Rewind, where the game allows it, is a button away.

What the timeline can't do is show the board as it was. Cards that have since died have no tile
to point at, life totals show their current value, and the step's arrows land on today's
positions.

## The fuller version

Step back through actual earlier boards, read-only, while the game waits or goes on.

- **Source of boards.** The server already keeps the replay log (`online_games.replay`) and can
  rebuild any point by replaying it (`Engine::resume`, used on restart). A board at happening
  `seq` needs the action index that produced it: record `(seq, action index)` in the feed as
  each action is accepted (`Match::accepted`).
- **Endpoint.** `GET /api/play/{id}/at/{seq}` replays to that action on a worker thread and
  returns the viewer's own `View` (the same per-seat filtering as a live view, so no hidden
  information leaks). Cache the last few per game; a replay of a long game costs seconds, so
  bound it like history replays (`play_history.rs`).
- **Board.** The board renders a fetched `View` with a "Looking back" banner, input off, and the
  timeline's Earlier and Later buttons fetching neighbouring steps.
- **Cost.** A replay per step is CPU on saget: keep snapshots every N actions
  (engine-integration.md already suggests `game_snapshots`) before offering free scrubbing.

## Open decisions

1. Is looking at the timeline and the live board enough, or does Bryan want true earlier boards?
2. If earlier boards: should the game pause for you while you look back in a solo game?
