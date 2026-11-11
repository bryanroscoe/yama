import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LoggedEvent } from "@yama/core";
import { clockFacts, clockLabel, TableClock } from "./TableClock";

const setup = { startedAt: "2026-11-11T19:00:00.000Z" };
const at = (min: number, sec = 0) => new Date(Date.parse(setup.startedAt) + (min * 60 + sec) * 1000);
const pass = (seq: number, when: Date): LoggedEvent => ({ seq, at: when.toISOString(), event: { type: "pass_turn" } });
const finish = (seq: number, when: Date): LoggedEvent => ({ seq, at: when.toISOString(), event: { type: "finish", winnerSeat: 0, endedAt: when.toISOString() } });

describe("the table's clock", () => {
  it("shows this turn's time over the game's at a table that counts turns", () => {
    const html = renderToStaticMarkup(<TableClock setup={setup} log={[pass(1, at(58))]} counting now={at(62, 10)} />);
    expect(html).toBe('<span class="table-clock" role="timer" aria-label="This turn 4 minutes 10 seconds. Game 1 hour 2 minutes."><b class="num table-clock-turn">4:10</b><span class="num table-clock-game">1:02:10</span></span>');
  });

  it("shows only the game's time where turns aren't counted", () => {
    const html = renderToStaticMarkup(<TableClock setup={setup} log={[]} counting={false} now={at(12, 5)} className="table-clock-bar" />);
    expect(html).toBe('<span class="table-clock table-clock-bar" role="timer" aria-label="Game 12 minutes 5 seconds."><span class="num table-clock-game">12:05</span></span>');
    expect(clockLabel({ game: 5_000, turn: 5_000 }, false)).toBe("Game 5 seconds.");
  });

  it("stands where a finished game ended, whatever the time is now", () => {
    const log = [pass(1, at(10)), finish(2, at(45))];
    const html = renderToStaticMarkup(<TableClock setup={setup} log={log} counting now={at(600)} />);
    expect(html).toContain(">35:00<");
    expect(html).toContain(">45:00<");
  });
});

describe("a finished game's times", () => {
  it("says how long it ran and how long turns took", () => {
    const log = [pass(1, at(4)), pass(2, at(9, 20)), finish(3, at(15))];
    expect(clockFacts(setup, log)).toEqual([
      "Ran 15 minutes from start to finish.",
      "3 turns were timed: 5 minutes each on average, the longest 5 minutes 40 seconds.",
    ]);
  });

  it("leaves turns out for a table that never passed, and says nothing of a game still going", () => {
    expect(clockFacts(setup, [finish(1, at(62))])).toEqual(["Ran 1 hour 2 minutes from start to finish."]);
    expect(clockFacts(setup, [pass(1, at(4))])).toEqual([]);
    expect(clockFacts(setup, [])).toEqual([]);
    // A result recorded with no time between start and finish (logged afterwards) has no length to give.
    expect(clockFacts(setup, [finish(1, at(0))])).toEqual([]);
  });
});
