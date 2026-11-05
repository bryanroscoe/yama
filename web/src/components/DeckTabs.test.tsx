import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { DeckTabs } from "./DeckTabs";

// The Plans count reads the plan store and the offline outbox; neither matters to these pages.
vi.mock("../plan/store", () => ({ usePlan: () => ({ bundle: null }) }));
vi.mock("../plan/outbox", () => ({ outbox: { localOps: () => [] }, useOutbox: () => ({}) }));

function current(path: string): string[] {
  const client = new QueryClient();
  client.setQueryData(["me"], null);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><DeckTabs /></MemoryRouter></QueryClientProvider>);
  return [...html.matchAll(/<a [^>]*aria-current="page"[^>]*href="([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("the Decks sections control", () => {
  it("marks exactly one section current on every page that shows it", () => {
    expect(current("/decks")).toEqual(["/decks"]);
    expect(current("/sharing")).toEqual(["/sharing"]);
    expect(current("/decks/builds")).toEqual(["/decks/builds"]);
    expect(current("/decks/plan/review")).toEqual(["/decks/plan"]);
    expect(current("/decks/research/abc")).toEqual(["/decks/research"]);
    expect(current("/decks/datasets/7")).toEqual(["/decks/datasets"]);
  });

  it("keeps Decks chosen while adding a deck or reading suggested changes", () => {
    expect(current("/decks/import")).toEqual(["/decks"]);
    expect(current("/decks/changes")).toEqual(["/decks"]);
  });
});
