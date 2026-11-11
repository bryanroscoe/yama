import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LoggedEvent } from "@yama/core";
import { learnHostClock } from "./clock";
import { clockFacts, clockLabel, TableClock } from "./TableClock";

const setup = { startedAt: "2026-11-11T19:00:00.000Z" };
const at = (min: number, sec = 0) => new Date(Date.parse(setup.startedAt) + (min * 60 + sec) * 1000);
const pass = (seq: number, when: Date): LoggedEvent => ({ seq, at: when.toISOString(), event: { type: "pass_turn" } });
const finish = (seq: number, when: Date): LoggedEvent => ({ seq, at: when.toISOString(), event: { type: "finish", winnerSeat: 0, endedAt: when.toISOString() } });
const clock = (log: LoggedEvent[], counting: boolean, now: Date) => renderToStaticMarkup(<TableClock setup={setup} log={log} counting={counting} now={now} />);

describe("the table's clock", () => {
  it("names this turn's time and the game's at a table that counts turns", () => {
    const html = clock([pass(1, at(58))], true, at(62, 10));
    // A timer with its times in words for a screen reader, outside any button.
    expect(html).toContain('role="timer"');
    expect(html).toContain('aria-label="This turn 4 minutes 10 seconds. Game 1 hour 2 minutes."');
    expect(html).not.toContain("<button");
    // Each number says what it is.
    expect(html).toMatch(/This turn<\/span> <b class="num">4:10<\/b>/);
    expect(html).toMatch(/Game<\/span> <b class="num">1:02:10<\/b>/);
  });

  it("shows only the game's time where turns aren't counted, or before the first pass", () => {
    const off = clock([pass(1, at(2))], false, at(12, 5));
    expect(off).toContain('aria-label="Game 12 minutes 5 seconds."');
    expect(off).not.toContain("This turn");
    expect(off).toMatch(/Game<\/span> <b class="num">12:05<\/b>/);
    // Counting, but nobody has passed yet (turns may have been switched on mid-game): no turn to time.
    const early = clock([], true, at(47, 12));
    expect(early).not.toContain("This turn");
    expect(early).toContain(">47:12<");
    expect(clockLabel({ game: 5_000, turn: null })).toBe("Game 5 seconds.");
  });

  it("stands where a finished game ended, whatever the time is now", () => {
    const html = clock([pass(1, at(10)), finish(2, at(45))], true, at(600));
    expect(html).toContain(">35:00<");
    expect(html).toContain(">45:00<");
  });

  it("reads the host's clock on a phone following a shared table", () => {
    const now = Date.parse("2026-11-11T19:10:00.000Z");
    // The log as first loaded may end in an old event: nothing is learned from it.
    const first = learnHostClock(null, pass(3, at(2)), now);
    expect(first).toEqual({ seq: 3, at: at(2).toISOString(), offset: 0 });
    // A new event arrives stamped 40 seconds ahead of this phone: the host's clock is 40 s ahead.
    const next = learnHostClock(first, pass(4, at(10, 40)), now);
    expect(next?.offset).toBe(40_000);
    // The same event again, or an older one back at the end after an undo, teaches nothing.
    expect(learnHostClock(next, pass(4, at(10, 40)), now + 5_000)).toBe(next);
    expect(learnHostClock(next, pass(3, at(2)), now + 5_000)).toBe(next);
    // A change merged into the last event (same number, later time) does.
    expect(learnHostClock(next, pass(4, at(10, 50)), now + 5_000)?.offset).toBe(45_000);
    // An unreadable time keeps what was known; no log at all keeps it too.
    expect(learnHostClock(next, { seq: 5, at: "nonsense" }, now)?.offset).toBe(40_000);
    expect(learnHostClock(next, undefined, now)).toBe(next);
  });
});

describe("a finished game's times", () => {
  it("says how long it ran and how long players' turns took, pass to pass", () => {
    const log = [pass(1, at(4)), pass(2, at(9, 20)), pass(3, at(11)), finish(4, at(15))];
    expect(clockFacts(setup, log)).toEqual([
      "Ran 15 minutes from start to finish.",
      "2 player turns were timed: 3 minutes 30 seconds each on average, the longest 5 minutes 20 seconds.",
    ]);
    // Passes with no times of their own: the game's length stands, the turn figures aren't made up.
    expect(clockFacts(setup, log, false)).toEqual(["Ran 15 minutes from start to finish."]);
  });

  it("leaves turns out for a table that hardly passed, and says nothing when there is nothing true to say", () => {
    expect(clockFacts(setup, [finish(1, at(62))])).toEqual(["Ran 1 hour 2 minutes from start to finish."]);
    // One timed turn is no average.
    expect(clockFacts(setup, [pass(1, at(4)), pass(2, at(9)), finish(3, at(15))])).toEqual(["Ran 15 minutes from start to finish."]);
    // Still going.
    expect(clockFacts(setup, [pass(1, at(4))])).toEqual([]);
    expect(clockFacts(setup, [])).toEqual([]);
    // A result recorded with no time between start and finish (logged afterwards).
    expect(clockFacts(setup, [finish(1, at(0))])).toEqual([]);
    // Left overnight and finished the next day: 23 hours isn't how long it was played.
    expect(clockFacts(setup, [pass(1, at(30)), pass(2, at(40)), pass(3, at(22 * 60)), finish(4, at(23 * 60))])).toEqual([]);
  });
});
