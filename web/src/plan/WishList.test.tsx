import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { PlanBundle } from "@yama/core/plan";
import fixture from "../../../packages/core/src/plan/fixtures/trip.json";
import { planView } from "./view";
import { WishListPage } from "./WishList";

const outlet = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./PlanLayout", () => ({ usePlanOutlet: () => outlet.value, PlanLayout: () => null, PlansHead: ({ title }: { title: string }) => <h1>{title}</h1> }));

/** The wish list page for an account, with `wants` on its list. */
function page(me: object, wants: object[]) {
  const b = {
    rev: "1", revision: 1, head: null, notes: [], game_changers: null, library: null, orders: [], unresolved: [], cards: {},
    inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] },
    ...fixture.bundle,
    shopping_wants: wants,
  } as unknown as PlanBundle;
  outlet.value = { view: { ...planView(b), today: "2026-11-12" }, userId: "u1" };
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], { id: "u1", email: "pat@example.com", display_name: "Pat", is_admin: false, ...me });
  client.setQueryData(["decks"], []);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/collection/wishlist"]}>
        <WishListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

const want = { id: "w1", kind: "card", name: "Sol Ring", qty: 2, priority: "along", deck_id: null, deck_name: "Riders of Rohan", why: "For the new build", source: "owner" };

describe("Collection, Wish list", () => {
  it("shows the list with a way to add to it and take from it, for an account with Advanced off", () => {
    const html = page({ advanced: false }, [want]);
    expect(html).toContain("Wish list</h1>");
    expect(html).toContain("Sol Ring");
    expect(html).toContain("×2");
    expect(html).toContain("only along the way, for Riders of Rohan. For the new build");
    expect(html).toContain("Remove");
    expect(html).toContain("Add to the list");
    // The store trip is a Workshop page: no way into it from here without Advanced.
    expect(html).not.toContain("/decks/plans");
  });

  it("starts empty with the form, and offers the store trip only with Advanced on", () => {
    const empty = page({ advanced: false }, []);
    expect(empty).toContain("Add to the list");
    expect(empty).not.toContain("Remove");
    expect(page({ advanced: true }, [want])).toContain('href="/decks/plans/get/trip"');
  });
});
