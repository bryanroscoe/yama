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

function page(today: string, search = "") {
  const b = {
    rev: "1", revision: 1, head: null, notes: [], game_changers: null, library: null, orders: [], unresolved: [], cards: {},
    inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] },
    ...fixture.bundle,
  } as unknown as PlanBundle;
  outlet.value = { view: { ...planView(b), today }, userId: "owner" };
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[`/decks/plans/get/trip${search}`]}>
        <Trip />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the Trip page", () => {
  const html = page("2026-11-01");

  it("lists the stores, the favourite first, with their preference, cards and totals", () => {
    expect(html).toContain("1. Black Castle Gamez");
    expect(html).toContain("Favourite, support them. 2 cards, $2.00 before tax. Cedar Park, 3.6 mi");
    expect(html).toContain("2. Mothership Books and Games");
    expect(html).toContain("3. Multiverse Hobbies");
    expect(html).toContain("Maybe, one trip. 1 card, $0.75 before tax. Hutto, 13.4 mi");
    expect(html).toContain("4</b><span>of 11 cards to buy, from 3 stores");
  });

  it("says what to print and why, and offers fewer stores", () => {
    expect(html).toContain("Only at Alpha Strike Games, where you won&#x27;t go ($0.25 at Alpha Strike Games).");
    expect(html).toContain("Over your limit ($90.00 at Pat&#x27;s Games). Print it; it stays on your real-card wishlist.");
    expect(html).toContain("Black Castle Gamez and Mothership Books and Games: 3 of 11 cards, $3.00");
  });

  it("gives lists to copy, search links where a store has no cart, and Mass Entry for what's left", () => {
    expect(html).toContain("Copy every store&#x27;s list");
    expect(html).toContain('href="https://blackcastlegamez.tcgplayerpro.com/search/products?q=Sol%20Ring&amp;productLineName=Magic%3A%20The%20Gathering&amp;sort=price-asc"');
    expect(html).toContain('href="https://www.tcgplayer.com/massentry?productline=Magic&amp;c=1%20Arcane%20Signet||');
    expect(html).toContain("Compare on TCGplayer");
    expect(page("2026-11-01", "?going=1&store=mothership")).toMatch(/<a[^>]*class="button primary buy-cart"[^>]*>Replace cart<\/a>/);
  });

  it("shows each store's preference in your order, the stores going this time, and the wishlist by tier", () => {
    expect(html).toMatch(/<option value="never" selected="">Won&#x27;t go<\/option>/);
    expect(html).toMatch(/<option value="favorite" selected="">Favourite, support them<\/option>/);
    expect(html).toContain("Has 1 card you need (you won&#x27;t go).");
    expect(html.indexOf("1. Black Castle Gamez</b><span class=\"dim\">")).toBeLessThan(html.indexOf("3. Pat&#x27;s Games</b>"));
    expect(html).toContain("Going this time");
    expect(html).toContain("$200 and up");
  });

  it("plans only the stores going this time, each its own parameter", () => {
    const only = page("2026-11-01", "?going=1&store=black-castle");
    expect(only).toContain("1. Black Castle Gamez");
    expect(only).not.toContain('aria-label="Mothership Books and Games"');
    expect(only).toContain("Over your limit ($90.00 at Pat&#x27;s Games).");
    expect(only).toContain("which you left off this trip");
    expect(page("2026-11-01", "?going=1")).toContain("No store has a card you need under your rule.");
  });
});
