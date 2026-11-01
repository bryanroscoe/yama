import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { PlanBundle } from "@yama/core/plan";
import fixture from "../../../packages/core/src/plan/fixtures/trip.json";
import { planView } from "./view";
import { Trip } from "./Trip";

const outlet = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./PlanLayout", () => ({ usePlanOutlet: () => outlet.value, PlansHead: ({ title }: { title: string }) => <h1>{title}</h1> }));

function page(today: string) {
  const b = {
    rev: "1", revision: 1, head: null, notes: [], game_changers: null, library: null, orders: [], unresolved: [], cards: {},
    inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] },
    ...fixture.bundle,
  } as unknown as PlanBundle;
  outlet.value = { view: { ...planView(b), today }, userId: "owner" };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/decks/plan/trip"]}>
        <Trip />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the Trip page", () => {
  const html = page("2026-11-01");

  it("lists the stores in order with their preference, cards and totals", () => {
    expect(html).toContain("1. Pat&#x27;s Games");
    expect(html).toContain("Your usual store. 2 cards, $1.50 before tax");
    expect(html).toContain("3. Multiverse Hobbies");
    expect(html).toContain("Maybe, one trip. 1 card, $0.75 before tax. Hutto, 13.4 mi");
    expect(html).toContain("4</b><span>of 11 cards to buy, from 3 stores");
  });

  it("says what to print and why, and offers fewer stores", () => {
    expect(html).toContain("Only at Alpha Strike Games, where you won&#x27;t go ($0.25 at Alpha Strike Games).");
    expect(html).toContain("Over your limit ($90.00 at Pat&#x27;s Games). Print it; it stays on your real-card wishlist.");
    expect(html).toContain("Pat&#x27;s Games and Mothership Books and Games: 3 of 11 cards, $2.75");
  });

  it("shows each store's preference, and the wishlist by tier", () => {
    expect(html).toMatch(/<option value="never" selected="">Won&#x27;t go<\/option>/);
    expect(html).toContain("Has 1 card you need.");
    expect(html).toContain("$200 and up");
  });
});
