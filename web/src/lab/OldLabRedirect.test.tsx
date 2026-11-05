import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { labPath } from "./OldLabRedirect";
import { LabHead } from "./LabLayout";
import { DECK_SECTIONS } from "../components/DeckTabs";

const power = vi.hoisted(() => ({ on: true }));
vi.mock("../auth", () => ({ useMe: () => ({ data: { id: "owner", power: power.on } }), usePower: () => power.on }));

describe("the Lab is its own section", () => {
  it("maps old /decks/lab links to the same page under /lab", () => {
    expect(labPath("/decks/lab")).toBe("/lab");
    expect(labPath("/decks/lab/")).toBe("/lab/");
    expect(labPath("/decks/lab/runs/abc")).toBe("/lab/runs/abc");
    expect(labPath("/decks/lab/runs/batch/xyz")).toBe("/lab/runs/batch/xyz");
    expect(labPath("/decks/lab/p/riders")).toBe("/lab/p/riders");
    expect(labPath("/somewhere/else")).toBe("/lab");
  });

  it("leaves the Decks sections, with agent notes under Plans", () => {
    expect(DECK_SECTIONS.map((s) => s.label)).toEqual(["Decks", "Sharing", "Swap cards", "Plans", "Datasets"]);
    expect(DECK_SECTIONS.find((s) => s.label === "Plans")?.also).toBe("/decks/research");
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

  it("leaves the pages that start simulations out for anyone but admins and power users", () => {
    power.on = false;
    try {
      const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/lab/runs"]}><LabHead title="My runs" /></MemoryRouter>);
      expect(html).toContain('href="/lab/runs"');
      expect(html).not.toContain('href="/lab/try"');
      expect(html).not.toContain('href="/lab/compare"');
    } finally {
      power.on = true;
    }
  });
});
