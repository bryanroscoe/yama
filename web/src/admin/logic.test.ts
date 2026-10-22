import { describe, expect, it } from "vitest";
import type { UsageRow } from "./api";
import { advisorLine, ago, bytes, confirms, deleteSummary, holdings, nearLimits, searchAccounts, today } from "./logic";

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  id: "u1",
  email: "pat@gmail.com",
  display_name: "Pat",
  is_admin: false,
  limited: true,
  disabled: false,
  decks: 2,
  collection_cards: 0,
  games_logged: 1,
  games_played: 3,
  has_plan: false,
  lab_games_today: 0,
  lab_games_queued: 0,
  lab_runs_unfinished: 0,
  advisor_today: 0,
  advisor_total: 0,
  advisor_own_key: false,
  advisor_mode: null,
  watch_running: 0,
  limits: { lab_games_per_day: 300, lab_runs_at_a_time: 1, advisor_per_day: 30, watch_at_a_time: 1 },
  ...over,
});

describe("admin words", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  it("say how long ago", () => {
    expect(ago(null, now)).toBe("never");
    expect(ago("2026-10-22T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-10-22T11:15:00Z", now)).toBe("45 minutes ago");
    expect(ago("2026-10-22T09:00:00Z", now)).toBe("3 hours ago");
    expect(ago("2026-10-22T11:00:00Z", now)).toBe("1 hour ago");
    expect(ago("2026-10-21T10:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-10-17T12:00:00Z", now)).toBe("5 days ago");
    expect(ago("2026-09-01T12:00:00Z", now)).toBe("Sep 1, 2026");
  });

  it("size files", () => {
    expect(bytes(512)).toBe("512 bytes");
    expect(bytes(1536)).toBe("1.5 KB");
    expect(bytes(48 * 1024 * 1024)).toBe("48 MB");
    expect(bytes(null)).toBe("unknown");
  });

  it("find accounts by every word", () => {
    const list = [row({ email: "pat@gmail.com", display_name: "Pat Kim" }), row({ email: "sam@example.com", display_name: "Sam" })];
    expect(searchAccounts(list, "").length).toBe(2);
    expect(searchAccounts(list, "kim pat").map((a) => a.display_name)).toEqual(["Pat Kim"]);
    expect(searchAccounts(list, "EXAMPLE").map((a) => a.display_name)).toEqual(["Sam"]);
  });

  it("need the exact email to delete", () => {
    expect(confirms("pat@gmail.com", " PAT@gmail.com ")).toBe(true);
    expect(confirms("pat@gmail.com", "pat@gmail.co")).toBe(false);
    expect(confirms("", "")).toBe(false);
  });

  it("say who is near a limit", () => {
    expect(nearLimits(row())).toEqual([]);
    expect(nearLimits(row({ lab_games_today: 240, advisor_today: 30, lab_runs_unfinished: 1 }))).toEqual([
      "Lab: 240 of 300 games today",
      "Lab: 1 of 1 run at a time",
      "Ask Claude: 30 of 30 questions today",
    ]);
    // Admins have no limits.
    const admin = row({ is_admin: true, advisor_today: 500, limits: { lab_games_per_day: null, lab_runs_at_a_time: null, advisor_per_day: null, watch_at_a_time: null } });
    expect(nearLimits(admin)).toEqual([]);
  });

  it("sum up an account in plain lines", () => {
    expect(holdings(row({ has_plan: true, collection_cards: 1200 }))).toBe("2 decks, 1 game logged, 3 games played, 1,200 cards in the collection, a deck plan.");
    expect(today(row())).toBe("");
    expect(today(row({ advisor_today: 1, lab_games_queued: 40 }))).toBe("Today: 40 games waiting in the lab, 1 question to Claude.");
    for (const s of [holdings(row()), today(row({ advisor_today: 2 }))]) expect(s).not.toContain("·");
  });

  it("say whose Claude an account asks on", () => {
    expect(advisorLine(row({ advisor_mode: "subscription" }))).toBe("Asks Claude on the server's subscription.");
    expect(advisorLine(row({ advisor_mode: "own_key" }))).toBe("Asks Claude with its own API key.");
    expect(advisorLine(row({ advisor_reason: "off" }))).toBe("Ask Claude is off on this server.");
    expect(advisorLine(row({ advisor_reason: "needs_key" }))).toBe("Can't ask Claude yet: no API key of its own.");
  });

  it("confirm a deletion in sentences", () => {
    const s = deleteSummary({
      email: "pat@gmail.com",
      rows_deleted: 42,
      games_kept: 2,
      games_deleted: 1,
      seats_anonymised: 3,
      online_games_removed: 0,
      playgroups_passed_on: 1,
      playgroups_deleted: 0,
    });
    expect(s).toBe(
      "Deleted pat@gmail.com and 42 rows it owned. 2 games it logged stay for the other players, without its name. 1 game only it played was deleted. 3 seats in other people's games no longer name it. 1 playgroup passed to another member.",
    );
  });
});
