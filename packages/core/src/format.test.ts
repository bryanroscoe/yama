import { afterEach, describe, expect, it } from "vitest";
import { ago, count, fmtDate, fmtDateTime, fmtMonth, fmtTime, fmtWeekday, fmtWhen, NO_PRICE, percent, plural, priceSource, shortDate, usd, usdWhole } from "./format";

describe("money", () => {
  it("writes dollars with cents, grouped", () => {
    expect(usd(1630.77)).toBe("$1,630.77");
    expect(usd(0.5)).toBe("$0.50");
    expect(usd(0)).toBe("$0.00");
    expect(usdWhole(1630.77)).toBe("$1,631");
  });

  it("never turns a missing price into $0", () => {
    expect(NO_PRICE).toBe("No price");
    expect(usd(null)).toBe("No price");
    expect(usd(undefined)).toBe("No price");
    expect(usd(Number.NaN)).toBe("No price");
    expect(usdWhole(null)).toBe("No price");
    expect(usd(null, "no price")).toBe("no price");
  });

  it("names a price's source and date", () => {
    expect(priceSource("2026-10-19")).toBe("TCGplayer market via Scryfall, Oct 19");
    expect(priceSource(null)).toBe("TCGplayer market via Scryfall, date unknown");
  });
});

describe("numbers", () => {
  it("groups thousands the same for everyone", () => {
    expect(count(1234567)).toBe("1,234,567");
    expect(count(12)).toBe("12");
  });

  it("counts things in words", () => {
    expect(plural(1, "card")).toBe("1 card");
    expect(plural(0, "card")).toBe("0 cards");
    expect(plural(1234, "card")).toBe("1,234 cards");
    expect(plural(2, "proxy", "proxies")).toBe("2 proxies");
  });

  it("writes a share as a percentage", () => {
    expect(percent(0.443)).toBe("44%");
    expect(percent(0.443, 1)).toBe("44.3%");
    expect(percent(1)).toBe("100%");
  });
});

describe("dates", () => {
  const tz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tz;
  });

  it("writes one US style", () => {
    expect(fmtDate("2026-10-08")).toBe("Oct 8, 2026");
    expect(fmtDate("2026-10-08", { year: false })).toBe("Oct 8");
    expect(fmtDate("2026-10-08", { month: "long" })).toBe("October 8, 2026");
    expect(fmtDate("2026-10-08", { weekday: "short" })).toBe("Thu, Oct 8, 2026");
    expect(fmtDate("2026-10-08", { weekday: "long", year: false })).toBe("Thursday, Oct 8");
    expect(shortDate("2026-10-19")).toBe("Oct 19");
    expect(fmtWeekday("2026-10-19")).toBe("Mon");
    expect(fmtWeekday("2026-10-19", "long")).toBe("Monday");
  });

  it("keeps a date as written, whatever the reader's zone", () => {
    for (const zone of ["America/Chicago", "Pacific/Auckland", "UTC"]) {
      process.env.TZ = zone;
      expect(fmtDate("2026-10-19")).toBe("Oct 19, 2026");
      // Without a zone it isn't a moment: the date as written.
      expect(fmtDate("2026-11-05 04:30:00")).toBe("Nov 5, 2026");
      expect(fmtTime("2026-11-05")).toBe("");
      expect(fmtDateTime("2026-11-05")).toBe("Nov 5, 2026");
    }
  });

  it("reads a moment on the reader's calendar, not UTC's", () => {
    // 02:30 UTC on Oct 19 is 9:30 pm on Oct 18 in Chicago.
    process.env.TZ = "America/Chicago";
    expect(fmtDate("2026-10-19T02:30:00.000Z")).toBe("Oct 18, 2026");
    expect(fmtDate("2026-11-05T04:30:00-06:00")).toBe("Nov 5, 2026");
    expect(shortDate("2026-10-19T02:30:00Z")).toBe("Oct 18");
    expect(fmtTime("2026-10-19T02:30:00Z")).toBe("9:30 PM");
    expect(fmtTime("2026-10-19T05:05:00Z")).toBe("12:05 AM");
    expect(fmtTime("2026-10-19T17:00:00Z")).toBe("12:00 PM");
    expect(fmtDateTime("2026-10-19T02:30:00Z")).toBe("Oct 18, 2026, 9:30 PM");
    expect(fmtDateTime("2026-10-19T02:30:00Z", { weekday: "long", year: false })).toBe("Sunday, Oct 18, 9:30 PM");
    expect(fmtDate(new Date("2026-10-19T02:30:00Z"))).toBe("Oct 18, 2026");
    expect(fmtDate(Date.parse("2026-10-19T02:30:00Z"))).toBe("Oct 18, 2026");
  });

  it("can read a moment on UTC's calendar, for a server's own days", () => {
    process.env.TZ = "America/Chicago";
    expect(fmtDate("2026-11-01T00:00:00Z", { utc: true, year: false, month: "long" })).toBe("November 1");
    expect(fmtTime("2026-11-01T00:00:00Z", { utc: true })).toBe("12:00 AM");
  });

  it("says the time alone only for today", () => {
    process.env.TZ = "America/Chicago";
    const now = new Date("2026-10-20T20:00:00Z");
    expect(fmtWhen("2026-10-20T14:30:00Z", now)).toBe("9:30 AM");
    expect(fmtWhen("2026-10-19T14:30:00Z", now)).toBe("Oct 19, 9:30 AM");
  });

  it("names the month, with the year when it isn't this one", () => {
    const now = new Date(2026, 10, 11);
    expect(fmtMonth("2026-10-19", now)).toBe("October");
    expect(fmtMonth("2025-10-19", now)).toBe("October 2025");
  });

  it("gives nothing for no date and returns what it can't read", () => {
    expect(fmtDate(null)).toBe("");
    expect(fmtDate(undefined)).toBe("");
    expect(fmtDate("")).toBe("");
    expect(fmtDate("soon")).toBe("soon");
    expect(fmtDate("2026-13-45")).toBe("2026-13-45");
    // A day the calendar doesn't have isn't turned into a neighbouring one.
    expect(fmtDate("2026-02-31")).toBe("2026-02-31");
    expect(fmtWeekday("2026-02-31")).toBe("2026-02-31");
    expect(fmtDate("2024-02-29")).toBe("Feb 29, 2024");
    expect(fmtDate("2026-02-29")).toBe("2026-02-29");
    expect(fmtDateTime("not a date")).toBe("not a date");
    expect(fmtTime(null)).toBe("");
    expect(shortDate(null)).toBeNull();
    expect(shortDate("soon")).toBeNull();
  });

  it("says how long ago", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    expect(ago(null, now)).toBe("never");
    expect(ago(undefined, now, "")).toBe("");
    expect(ago("not a date", now)).toBe("unknown");
    expect(ago("2026-10-22T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-10-22T11:15:00Z", now)).toBe("45 minutes ago");
    expect(ago("2026-10-22T11:00:00Z", now)).toBe("1 hour ago");
    expect(ago("2026-10-22T09:00:00Z", now)).toBe("3 hours ago");
    expect(ago("2026-10-21T10:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-10-17T12:00:00Z", now)).toBe("5 days ago");
    expect(ago("2026-09-01T12:00:00Z", now)).toBe("Sep 1, 2026");
  });
});
