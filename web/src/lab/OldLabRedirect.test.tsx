import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { labPath } from "./OldLabRedirect";
import { LabHead } from "./LabLayout";
import { DECK_SECTIONS } from "../components/DeckTabs";

const power = vi.hoisted(() => ({ on: true, admin: false }));
vi.mock("../auth", () => ({ useMe: () => ({ data: { id: "owner", power: power.on, is_admin: power.admin } }), usePower: () => power.on }));

/** The Lab head at `path`, with `owned` as the account's datasets. */
function head(path: string, owned: unknown[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["datasets", "owner"], owned);
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><LabHead title="Lab" /></MemoryRouter></QueryClientProvider>);
}

describe("the Lab is its own section", () => {
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

  it("leaves the Decks sections and names Research as agent notes", () => {
    expect(DECK_SECTIONS.map((s) => s.label)).toEqual(["Decks", "Sharing", "Builds", "Plans", "Agent notes"]);
    expect(DECK_SECTIONS.some((s) => s.to.includes("lab") || s.to.includes("datasets"))).toBe(false);
  });

  it("draws the Lab head with its own pages and no Decks control", () => {
    const html = head("/lab/runs");
    expect(html).toContain('href="/lab/try"');
    expect(html).toContain('href="/lab/runs"');
    expect(html).not.toContain("/decks/lab");
    expect(html).not.toContain("Decks sections");
    expect(html).not.toContain('href="/decks/plan"');
  });

  it("leaves the pages that start simulations out for anyone but admins and power users", () => {
    power.on = false;
    try {
      const html = head("/lab/runs");
      expect(html).toContain('href="/lab/runs"');
      expect(html).not.toContain('href="/lab/try"');
      expect(html).not.toContain('href="/lab/compare"');
    } finally {
      power.on = true;
    }
  });

  it("lists Datasets for admins and for accounts that have one", () => {
    expect(head("/lab/runs")).not.toContain('href="/lab/datasets"');
    expect(head("/lab/runs", [{ id: "playgroup-history" }])).toContain('href="/lab/datasets"');
    expect(head("/lab/datasets")).toContain('href="/lab/datasets"');
    power.admin = true;
    try {
      expect(head("/lab/runs")).toContain('href="/lab/datasets"');
    } finally {
      power.admin = false;
    }
  });
});
