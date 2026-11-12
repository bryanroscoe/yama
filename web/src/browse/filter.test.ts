import { describe, expect, it } from "vitest";
import { NO_FILTER, apiQuery, colorsOf, isFiltered, readFilter, toggleColor, writeFilter } from "./filter";

describe("the Browse filters in the address", () => {
  it("reads what is set and nothing else", () => {
    expect(readFilter(new URLSearchParams(""))).toEqual(NO_FILTER);
    expect(readFilter(new URLSearchParams("q=goblins&commander=krenko&colors=gr&bracket=3&precon=any&page=2"))).toEqual({
      q: "goblins",
      commander: "krenko",
      colors: "RG",
      bracket: "3",
      precon: "any",
      page: 1,
    });
    // What makes no sense is no filter, so an old or mistyped link still shows decks.
    expect(readFilter(new URLSearchParams("colors=xyz&bracket=9&page=zero"))).toEqual(NO_FILTER);
  });

  it("writes only what is set, with pages counted from 1", () => {
    expect(writeFilter(NO_FILTER).toString()).toBe("");
    expect(writeFilter({ ...NO_FILTER, q: "  " }).toString()).toBe("");
    expect(writeFilter({ ...NO_FILTER, q: "atraxa", colors: "WU", page: 2 }).toString()).toBe("q=atraxa&colors=WU&page=3");
    const round = { q: "100%", commander: "Atraxa, Praetors' Voice", colors: "C", bracket: "4", precon: "goblin-precon", page: 4 };
    expect(readFilter(writeFilter(round))).toEqual(round);
  });

  it("asks the listing for the same filters, with pages counted from 0 and typed text trimmed", () => {
    expect(apiQuery(NO_FILTER)).toBe("");
    expect(apiQuery({ ...NO_FILTER, q: " goblins ", precon: "any", page: 1 })).toBe("?q=goblins&precon=any&page=1");
  });

  it("knows when anything narrows the list; a page alone does not", () => {
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ ...NO_FILTER, page: 3 })).toBe(false);
    expect(isFiltered({ ...NO_FILTER, precon: "any" })).toBe(true);
    expect(isFiltered({ ...NO_FILTER, colors: "C" })).toBe(true);
  });
});

describe("the color toggles", () => {
  it("keep colors in WUBRG order", () => {
    expect(colorsOf("gw")).toBe("WG");
    expect(toggleColor("WG", "U")).toBe("WUG");
    expect(toggleColor("WUG", "W")).toBe("UG");
  });

  it("treat colorless as a choice of its own", () => {
    expect(toggleColor("WU", "C")).toBe("C");
    expect(toggleColor("C", "C")).toBe("");
    expect(toggleColor("C", "R")).toBe("R");
  });
});
