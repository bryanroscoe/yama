import { clockAt, clockText, clockWords, longBreak, turnSpans, type LoggedEvent, type TableSetup } from "@yama/core";
import { useHostOffset, useNow } from "./clock";

/** What the clock says in words: "This turn 4 minutes 12 seconds. Game 1 hour 2 minutes." */
export function clockLabel(times: { game: number; turn: number | null }): string {
  return `${times.turn !== null ? `This turn ${clockWords(times.turn)}. ` : ""}Game ${clockWords(times.game)}.`;
}

/**
 * The game's clock, as a strip under the table's top bar: how long this turn has run (at a table
 * that counts turns, once the turn has been passed) and how long the game has. It ticks each
 * second while the game is going and stands still once it's finished. On a phone following a
 * shared table the times are the host's, so `following` corrects for the two phones' clocks
 * disagreeing. `now` is for tests; the screen leaves it out.
 */
export function TableClock({ setup, log, counting, following = false, now }: { setup: Pick<TableSetup, "startedAt">; log: LoggedEvent[]; counting: boolean; following?: boolean; now?: Date }) {
  const finished = log.some((l) => l.event.type === "finish");
  const ticking = useNow(!finished && !now);
  const offset = useHostOffset(log, following);
  const times = clockAt(setup, log, now ?? new Date(ticking.getTime() + offset));
  const shown = { game: times.game, turn: counting ? times.turn : null };
  return (
    <div className="table-clock" role="timer" aria-label={clockLabel(shown)}>
      {shown.turn !== null && (
        <span>
          <span className="table-clock-what">This turn</span> <b className="num">{clockText(shown.turn)}</b>
        </span>
      )}
      <span>
        <span className="table-clock-what">Game</span> <b className="num">{clockText(shown.game)}</b>
      </span>
    </div>
  );
}

/** A gap this long with nothing recorded is a game left on the table, not one being played. */
const LEFT_FOR = 3 * 3_600_000;

/**
 * What a finished game's record says about time, for its page: how long it ran from start to
 * finish and, where the turn was passed, how long players' turns took. Nothing for a game still
 * going, one with no time between start and finish (logged after it was played), or one left
 * for hours in the middle (its start-to-finish time isn't how long it was played). `timed` is
 * false when the record's passes have no times of their own: then no turn figures are given.
 */
export function clockFacts(setup: Pick<TableSetup, "startedAt">, log: LoggedEvent[], timed = true): string[] {
  const times = clockAt(setup, log, new Date(0));
  if (times.running || times.game < 1000 || longBreak(setup, log, LEFT_FOR)) return [];
  const facts = [`Ran ${clockWords(times.game)} from start to finish.`];
  const spans = timed ? turnSpans(setup, log) : [];
  if (spans.length > 1) {
    const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
    facts.push(`${spans.length} player turns were timed: ${clockWords(mean)} each on average, the longest ${clockWords(Math.max(...spans))}.`);
  }
  return facts;
}
