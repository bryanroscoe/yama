import { describe, expect, it } from "vitest";
import { scrollPageOf } from "./App";

describe("which addresses are one page for scrolling", () => {
  it("a deck's four tabs are, so changing tab keeps the page where it is", () => {
    for (const tab of ["", "/stats", "/plan", "/history", "/stats/"]) expect(scrollPageOf(`/decks/d1${tab}`)).toBe("/decks/d1");
    // Its other pages open at the top.
    expect(scrollPageOf("/decks/d1/edit")).toBe("/decks/d1/edit");
  });

  it("a plan or a browse page named like a tab is a page of its own", () => {
    for (const path of ["/decks/plans/history", "/decks/plans/stats", "/decks/plans/plan", "/decks/browse/history"]) expect(scrollPageOf(path)).toBe(path);
    expect(scrollPageOf("/decks/plans")).toBe("/decks/plans");
    // A deck whose id only starts like one of those is still a deck.
    expect(scrollPageOf("/decks/plans-of-mine/stats")).toBe("/decks/plans-of-mine");
  });
});
