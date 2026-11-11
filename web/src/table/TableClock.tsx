import { clockAt, clockText, clockWords, turnSpans, type LoggedEvent, type TableSetup } from "@yama/core";
import { useNow } from "./clock";

/** What the clock says in words: "This turn 4 minutes 12 seconds. Game 1 hour 2 minutes." */
export function clockLabel(times: { game: number; turn: number }, counting: boolean): string {
  return `${counting ? `This turn ${clockWords(times.turn)}. ` : ""}Game ${clockWords(times.game)}.`;
}

/**
 * The game's clock: how long this turn has run (at a table that counts turns) over how long the
 * game has. It ticks each second while the game is going and stands still once it's finished.
 * `now` is for tests; the screen leaves it out.
 */
export function TableClock({ setup, log, counting, className = "", now }: { setup: Pick<TableSetup, "startedAt">; log: LoggedEvent[]; counting: boolean; className?: string; now?: Date }) {
  const finished = log.some((l) => l.event.type === "finish");
  const ticking = useNow(!finished && !now);
  const times = clockAt(setup, log, now ?? ticking);
  return (
    <span className={`table-clock ${className}`.trim()} role="timer" aria-label={clockLabel(times, counting)}>
      {counting && <b className="num table-clock-turn">{clockText(times.turn)}</b>}
      <span className="num table-clock-game">{clockText(times.game)}</span>
    </span>
  );
}

/**
 * What a finished game's record says about time, for its page: how long it ran from start to
 * finish and, where the turn was passed, how long turns took. Nothing for a game still going or
 * one with no finish in its record (logged after it was played).
 */
export function clockFacts(setup: Pick<TableSetup, "startedAt">, log: LoggedEvent[]): string[] {
  const times = clockAt(setup, log, new Date(0));
  if (times.running || times.game < 1000) return [];
  const facts = [`Ran ${clockWords(times.game)} from start to finish.`];
  const spans = turnSpans(setup, log);
  if (spans.length > 1) {
    const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
    facts.push(`${spans.length} turns were timed: ${clockWords(mean)} each on average, the longest ${clockWords(Math.max(...spans))}.`);
  }
  return facts;
}
