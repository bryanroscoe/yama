import { describe, expect, it } from "vitest";
import { computerText, recordText, streakText } from "./statsText";

describe("recordText", () => {
  it("reads wins-losses with the game count, naming draws", () => {
    expect(recordText({ games: 5, wins: 3, losses: 2, draws: 0 })).toBe("3-2, 5 games");
    expect(recordText({ games: 4, wins: 1, losses: 2, draws: 1 })).toBe("1-2, 1 draw, 4 games");
    expect(recordText({ games: 1, wins: 1, losses: 0, draws: 0 })).toBe("1-0, 1 game");
    expect(recordText({ games: 0, wins: 0, losses: 0, draws: 0 })).toBe("no games yet");
  });
});

describe("computerText", () => {
  it("names solo games against the computer apart from the record", () => {
    expect(computerText({ vs_computer: { games: 5, wins: 4, losses: 1, draws: 0 } })).toBe("Against the computer: 4-1, 5 games");
    // None played, or an older server that doesn't send them: nothing to say.
    expect(computerText({ vs_computer: { games: 0, wins: 0, losses: 0, draws: 0 } })).toBe("");
    expect(computerText({})).toBe("");
  });
});

describe("streakText", () => {
  it("says wins in a row or games without a win", () => {
    expect(streakText({ kind: "win", games: 3 })).toBe("Won the last 3");
    expect(streakText({ kind: "win", games: 1 })).toBe("Won the last game");
    expect(streakText({ kind: "no_win", games: 4 })).toBe("No win in the last 4");
    expect(streakText(null)).toBe("");
  });
});
