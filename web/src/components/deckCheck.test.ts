import { describe, expect, it } from "vitest";
import type { DeckCheck } from "../api";
import { checkStatus, estimateExplanation, estimateValue, gameChangerFloor, pollAfter } from "./deckCheck";


const NOW = new Date("2026-10-19T15:00:00Z");

const check = (over: Partial<DeckCheck> = {}): DeckCheck => ({
  enabled: true,
  version_id: "v1",
  source: "Commander Spellbook",
  source_url: "https://commanderspellbook.com/",
  pending: false,
  retrying: false,
  next_try_at: null,
  error: null,
  gave_up: false,
  archived: false,
  requested_at: "2026-10-19T14:00:00.000Z",
  result: null,
  ...over,
});

const answer = {
  checked_at: "2026-10-19T02:30:00.000Z",
  bracket_tag: "R",
  bracket_label: "Ruthless",
  bracket: 4,
  game_changers: [],
  mld: [],
  extra_turns: [],
  combos: [],
  unrecognized: [],
};

describe("check status", () => {
  it("shows a failed try with when it's tried again, not 'checking'", () => {
    const retry = check({ retrying: true, next_try_at: "2026-10-19T15:05:00.000Z", error: "Commander Spellbook answered 503 Service Unavailable" });
    const s = checkStatus(retry, NOW)!;
    expect(s).toMatch(/^Couldn't check: Commander Spellbook answered 503 Service Unavailable\. Trying again at /);
    expect(s).not.toMatch(/Checking/);
    expect(checkStatus({ ...retry, result: answer }, NOW)).toMatch(/^The last re-check failed: .*503/);
    expect(checkStatus(check({ pending: true, error: "no connection" }), NOW)).toBe("Couldn't check: no connection. Trying again now.");
    expect(checkStatus(check({ gave_up: true, error: "no connection" }), NOW)).toBe("Couldn't check: no connection. Stopped trying until you ask again.");
  });

  it("says checking only while a try is due, and nothing once answered", () => {
    expect(checkStatus(check({ pending: true }), NOW)).toMatch(/^Checking with Commander Spellbook/);
    expect(checkStatus(check({ pending: true, result: answer }), NOW)).toBe("Checking again with Commander Spellbook.");
    expect(checkStatus(check({ result: answer }), NOW)).toBeNull();
    expect(checkStatus(check({ enabled: false }), NOW)).toBe("Outside checks are off on this server.");
    expect(checkStatus(check({ archived: true, result: answer }), NOW)).toMatch(/archived/);
  });
});

describe("polling", () => {
  it("polls fast only while a try is due, then at the next try, else stops", () => {
    expect(pollAfter(check({ pending: true }), NOW.getTime())).toBe(3000);
    // Next try in five minutes: ask just after it.
    expect(pollAfter(check({ retrying: true, next_try_at: "2026-10-19T15:05:00.000Z" }), NOW.getTime())).toBe(5 * 60_000 + 2000);
    // Twelve hours away: look in now and then, not every three seconds.
    expect(pollAfter(check({ retrying: true, next_try_at: "2026-10-20T03:00:00.000Z" }), NOW.getTime())).toBe(15 * 60_000);
    expect(pollAfter(check({ gave_up: true, error: "x" }), NOW.getTime())).toBe(false);
    expect(pollAfter(check({ result: answer }), NOW.getTime())).toBe(false);
    expect(pollAfter(undefined)).toBe(false);
  });
});

describe("estimate value", () => {
  it("treats Spellbook's E fallback as provisional Core, including old cached E/1 results", () => {
    for (const bracket of [1, 2, null]) {
      const shown = estimateValue("E", bracket);
      expect(shown.value).toBe("2");
      expect(shown.sub("Exhibition")).toContain("Core starting point");
    }
    expect(estimateExplanation("E")).toContain("never assigns it automatically");
    expect(estimateExplanation("E")).toContain("may still belong above Core");
  });

  it("calls only Spellbook's B tag banned", () => {
    expect(estimateValue("R", 4).value).toBe("4");
    expect(estimateValue("B", null).value).toBe("Banned");
    const unknown = estimateValue("X", null);
    expect(unknown.value).toBe("Unknown");
    expect(unknown.sub("Unknown tag")).toContain('"X"');
    expect(estimateValue("X", 1).value).toBe("Unknown");
    expect(estimateValue("R", 5).value).toBe("Unknown");
    expect(estimateValue("B", 4).value).toBe("Banned");
  });
});

describe("Game Changer limits", () => {
  it("doesn't assign a bracket from a zero count or treat the allowance as a power rating", () => {
    expect(gameChangerFloor(0)).toContain("doesn't establish a bracket");
    expect(gameChangerFloor(1)).toContain("1 Game Changer: within bracket 3's limit");
    expect(gameChangerFloor(3)).toContain("deck may belong higher");
    expect(gameChangerFloor(4)).toContain("bracket 4 or 5");
  });
});

