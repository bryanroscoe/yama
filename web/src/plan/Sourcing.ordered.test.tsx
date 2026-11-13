// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ResearchBundle } from "../research/api";

const ORIGIN = "https://mothershipatx.com";
const mock = vi.hoisted(() => ({
  live: vi.fn(),
  view: {
    markBy: new Map(), today: "2026-11-13",
    b: {
      swaps: [],
      // Placed the day after the list was saved, and one from long before it.
      orders: [
        { key: "pats-56001", kind: "real", status: "received", vendor: "Pat's Games", order_number: "56001", date_ordered: "2026-11-13", items: [{ line: 1, card: "Path to Exile", qty: 1, deck: "d" }] },
        { key: "pats-55912", kind: "real", status: "received", vendor: "Pat's Games", order_number: "55912", date_ordered: "2026-10-08", items: [{ line: 1, card: "Sol Ring", qty: 1, deck: "d" }] },
      ],
      settings: [{ effective_from: "2026-11-02", origin: "yama", note: null, rules: { local_buy: { max_usd: 2, always_ok_usd: 0.5, tiers: [{ market_under: null, max_multiple: 1.5 }] }, sealed_max_usd: 51 } }],
      stores: [{ key: "mothership", name: "Mothership", kind: "local", homepage: "https://mothershipatx.com", cart_url_template: "https://mothershipatx.com/cart/{items}" }],
    },
  },
}));
vi.mock("./PlanLayout", () => ({ usePlanOutlet: () => ({ view: mock.view, userId: "owner" }) }));
vi.mock("./api", () => ({ saveShoppingRules: vi.fn(), fetchBundle: vi.fn(), storeCatalogs: vi.fn().mockResolvedValue({ catalogs: [] }), checkStores: vi.fn(), storeSnapshots: vi.fn().mockResolvedValue({ snapshots: [] }), liveStock: mock.live }));
import { Portfolio } from "./Sourcing";

const offer = (slug: string, variant_id: string, price: number, title: string) => ({ store: "Mothership", price, market: price, condition: "Near Mint", finish: "nonfoil", language: "English", qty: null, url: `${ORIGIN}/products/${slug}`, variant_id, checked_at: "2026-11-10", qualifies: true, title });
const bundle: ResearchBundle = {
  revision: 1, updated_at: "2026-11-12", target_hashes: {}, reviews: [],
  document: {
    // Midday, so the list's day is the same on any machine's calendar.
    schema: "yama-research/1", id: "ordered", title: "Ordered", generated_at: "2026-11-12T12:00:00.000Z",
    decks: [{ key: "d", name: "Deck", commander: "Commander", builds: [{ id: "b3", label: "B3", bracket: 3, list: "1 Commander\n1 Path to Exile\n1 Sol Ring" }] }],
    local_sources: [
      { name: "Path to Exile", uses: [{ id: "d-path", deck: "d", deck_name: "Deck", category: "unresolved" }], best_offer_per_store: [offer("path-ac", "111", 1.5, "Path to Exile [Assassin's Creed]")] },
      { name: "Sol Ring", uses: [{ id: "d-sol", deck: "d", deck_name: "Deck", category: "unresolved" }], best_offer_per_store: [offer("sol-c21", "222", 1.75, "Sol Ring [Commander 2021]")] },
    ],
  },
};

describe("sourcing page and orders placed since its list was saved", () => {
  it("leaves an ordered copy out of the cards, the carts and the store rereads, and says which order covers it", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mock.live.mockResolvedValue({ at: "2026-11-13T12:00:00.000Z", reread_hours: 8, offline: false, reading: false, hurry_left: 0, stores: [], answers: [], markets: {}, unknown: [], hurried: 0 });
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const settled = (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check(); }, { timeout: 3000 });
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><Portfolio bundle={bundle} /></MemoryRouter></QueryClientProvider>));
      expect(host.textContent).toContain("1 copy already ordered or marked bought is left out");
      expect(host.textContent).toContain("Pat's Games order 56001 of Nov 13, 2026: Path to Exile.");
      // The October order was before the list: its Sol Ring is still wanted.
      expect(host.textContent).not.toContain("55912");
      expect(host.textContent).toContain("$1.75"); expect(host.textContent).not.toContain("$1.50");
      // A card already ordered is no longer asked of the stores.
      await settled(() => expect(mock.live).toHaveBeenCalledWith({ cards: ["Sol Ring"], hurry: [], since: null }));
      const button = (name: string) => [...host.querySelectorAll("button")].find(b => b.textContent === name)!;
      await act(async () => button("Add all matching cards").click());
      expect(host.textContent).toContain("1 selected copy");
      await settled(() => expect(host.querySelector<HTMLAnchorElement>(".source-cart a[href*='/cart/']")?.href).toBe(`${ORIGIN}/cart/222:1`));
    } finally { await act(async () => root.unmount()); host.remove(); client.clear(); }
  });
});
