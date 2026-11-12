import { describe, expect, it } from "vitest";
import { labPath } from "./OldLabRedirect";

describe("old Lab addresses", () => {
  it("maps old /decks/lab links to the same page under /lab", () => {
    expect(labPath("/decks/lab")).toBe("/lab");
    expect(labPath("/decks/lab/")).toBe("/lab/");
    expect(labPath("/decks/lab/runs/abc")).toBe("/lab/runs/abc");
    expect(labPath("/decks/lab/runs/batch/xyz")).toBe("/lab/runs/batch/xyz");
    expect(labPath("/decks/lab/p/riders")).toBe("/lab/p/riders");
    expect(labPath("/somewhere/else")).toBe("/lab");
    expect(labPath("/decks/datasets")).toBe("/lab/datasets");
    expect(labPath("/decks/datasets/playgroup-history")).toBe("/lab/datasets/playgroup-history");
  });
});
