import { describe, expect, it } from "vitest";
import type { CalendarSet, PreconSummary } from "../api";
import { daysBetween, hasDeckNamed, hostOf, isExtra, localToday, previewLine, releaseLine, setTypeLabel, watchedPrecons } from "./calendar";

const id = (d: string) => d;

function set(code: string, patch: Partial<CalendarSet> = {}): CalendarSet {
  return {
    code,
    name: `Set ${code}`,
    set_type: "expansion",
    released_at: "2026-11-13",
    card_count: 10,
    printed_size: null,
    parent_set_code: null,
    parent_name: null,
    digital: false,
    scryfall_uri: null,
    checked_at: "2026-10-19T12:00:00Z",
    watched: false,
    parent_watched: false,
    precons: [],
    ...patch,
  };
}

function precon(file_name: string, set_code: string): PreconSummary {
  return { file_name, set_code, name: file_name, release_date: "2026-11-13", source_url: null, first_seen_at: "2026-10-30T06:00:00Z", commanders: null, list_cards: null };
}

describe("release calendar", () => {
  it("counts days between local dates", () => {
    expect(localToday(new Date(2026, 9, 19, 23, 30))).toBe("2026-10-19");
    expect(daysBetween("2026-10-19", "2026-11-13")).toBe(25);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2); // across a daylight saving change
  });

  it("says when a set comes out", () => {
    expect(releaseLine("2026-11-13", "2026-10-19", id)).toBe("2026-11-13, in 25 days");
    expect(releaseLine("2026-10-20", "2026-10-19", id)).toBe("2026-10-20, tomorrow");
    expect(releaseLine("2026-10-19", "2026-10-19", id)).toBe("2026-10-19, out today");
    expect(releaseLine("2026-10-02", "2026-10-19", id)).toBe("Out since 2026-10-02");
    expect(releaseLine(null, "2026-10-19", id)).toBe("Release date not announced");
    expect(releaseLine(null, "2026-10-19", id, true)).toBe("release date not announced");
    expect(releaseLine("2026-10-02", "2026-10-19", (d) => `Oct ${d.slice(8)}`, true)).toBe("out since Oct 02");
    expect(releaseLine("2026-11-13", "2026-10-19", (d) => `Nov ${d.slice(8)}`, true)).toBe("Nov 13, in 25 days");
  });

  it("reports previews as Scryfall's count, never a made-up total", () => {
    expect(previewLine({ card_count: 41, printed_size: null }, false)).toBe("41 cards on Scryfall so far");
    expect(previewLine({ card_count: 1, printed_size: null }, false)).toBe("1 card on Scryfall so far");
    expect(previewLine({ card_count: 0, printed_size: null }, false)).toBe("No cards on Scryfall yet");
    expect(previewLine({ card_count: 120, printed_size: 281 }, false)).toBe("120 cards of 281 on Scryfall");
    expect(previewLine({ card_count: 300, printed_size: 281 }, true)).toBe("300 cards on Scryfall");
  });

  it("labels set types in sentence case", () => {
    expect(setTypeLabel("commander")).toBe("Commander decks");
    expect(setTypeLabel("something_new")).toBe("Something new");
  });

  it("tucks away tokens and promos unless watched or holding precons", () => {
    expect(isExtra(set("ttrk", { set_type: "token" }))).toBe(true);
    expect(isExtra(set("a26", { digital: true }))).toBe(true);
    expect(isExtra(set("trk"))).toBe(false);
    expect(isExtra(set("ttrk", { set_type: "token", parent_watched: true }))).toBe(true);
    expect(isExtra(set("ttrk", { set_type: "token", watched: true }))).toBe(false);
    expect(isExtra(set("sld", { set_type: "promo", precons: [precon("X_SLD", "sld")] }))).toBe(false);
  });

  it("lists watched precons once, grouped by their own set", () => {
    const trc = [precon("FederationFleet_TRC", "trc"), precon("WeAreTheBorg_TRC", "trc")];
    const sets = [
      set("trk", { name: "Star Trek", watched: true, precons: trc }),
      set("trc", { name: "Star Trek Commander", set_type: "commander", parent_set_code: "trk", parent_watched: true, precons: trc }),
      set("mdc", { precons: [precon("Darkhold_MDC", "mdc")] }), // not watched
    ];
    const groups = watchedPrecons(sets);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.setName).toBe("Star Trek Commander");
    expect(groups[0]!.precons.map((p) => p.file_name)).toEqual(["FederationFleet_TRC", "WeAreTheBorg_TRC"]);
    expect(watchedPrecons([set("trk")])).toEqual([]);
  });

  it("names a source's site, or nothing", () => {
    expect(hostOf("https://magic.wizards.com/en/news/announcements/x")).toBe("magic.wizards.com");
    expect(hostOf("https://www.example.com/a")).toBe("example.com");
    expect(hostOf("not a url")).toBeNull();
  });

  it("spots a precon already made into a deck", () => {
    expect(hasDeckNamed(["Riders of Rohan", " federation  fleet"], "Federation Fleet")).toBe(true);
    expect(hasDeckNamed(["Riders of Rohan"], "Federation Fleet")).toBe(false);
  });
});
