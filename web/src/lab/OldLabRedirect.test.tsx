import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { labPath } from "./OldLabRedirect";
import { LabHead } from "./LabLayout";
import { DECK_SECTIONS } from "../components/DeckTabs";

vi.mock("../auth", () => ({ useMe: () => ({ data: { id: "owner" } }) }));

describe("the Lab is its own section", () => {
  it("maps old /decks/lab links to the same page under /lab", () => {
    expect(labPath("/decks/lab")).toBe("/lab");
    expect(labPath("/decks/lab/")).toBe("/lab/");
    expect(labPath("/decks/lab/runs/abc")).toBe("/lab/runs/abc");
    expect(labPath("/decks/lab/runs/batch/xyz")).toBe("/lab/runs/batch/xyz");
    expect(labPath("/decks/lab/p/riders")).toBe("/lab/p/riders");
    expect(labPath("/somewhere/else")).toBe("/lab");
  });

  it("leaves the Decks sections and names Research as agent notes", () => {
    expect(DECK_SECTIONS.map((s) => s.label)).toEqual(["Decks", "Plans", "Agent notes", "Datasets"]);
    expect(DECK_SECTIONS.some((s) => s.to.includes("lab"))).toBe(false);
  });

  it("draws the Lab head with its own pages and no Decks control", () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/lab/runs"]}><LabHead title="My runs" /></MemoryRouter>);
    expect(html).toContain('href="/lab/try"');
    expect(html).toContain('href="/lab/runs"');
    expect(html).not.toContain("/decks/lab");
    expect(html).not.toContain("Decks sections");
    expect(html).not.toContain('href="/decks/plan"');
  });
});
