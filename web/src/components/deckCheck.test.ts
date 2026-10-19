import { afterEach, describe, expect, it } from "vitest";
import type { DeckCheck } from "../api";
import { checkStatus, estimateValue, localDay, pollAfter } from "./deckCheck";

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
  it("calls only Spellbook's B tag banned", () => {
    expect(estimateValue("R", 4).value).toBe("4");
    expect(estimateValue("B", null).value).toBe("Banned");
    const unknown = estimateValue("X", null);
    expect(unknown.value).toBe("Unknown");
    expect(unknown.sub("Unknown tag")).toContain('"X"');
  });
});

describe("local dates", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tz;
  });
  it("dates a check by the reader's day, not UTC's", () => {
    // 02:30 UTC on Oct 19 is 9:30 pm on Oct 18 in Chicago.
    process.env.TZ = "America/Chicago";
    const shown = localDay("2026-10-19T02:30:00.000Z");
    expect(shown).toMatch(/18/);
    expect(shown).not.toMatch(/19/);
    expect(localDay("not a date")).toBe("not a date");
  });
});
