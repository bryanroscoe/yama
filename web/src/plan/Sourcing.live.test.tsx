// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ResearchBundle } from "../research/api";
import type { LiveStock } from "./live-stock";

const ORIGIN = "https://mothershipatx.com";
const mock = vi.hoisted(() => ({
  live: vi.fn(),
  view: { today: "2026-11-13", b: { settings: [{ effective_from: "2026-11-02", origin: "yama", note: null, rules: { local_buy: { max_usd: 2, always_ok_usd: 0.5, tiers: [{ market_under: null, max_multiple: 1.5 }] }, sealed_max_usd: 51 } }], stores: [{ key: "mothership", name: "Mothership", kind: "local", homepage: "https://mothershipatx.com", cart_url_template: "https://mothershipatx.com/cart/{items}" }] } },
}));
vi.mock("./PlanLayout", () => ({ usePlanOutlet: () => ({ view: mock.view, userId: "owner" }) }));
vi.mock("./api", () => ({ saveShoppingRules: vi.fn(), fetchBundle: vi.fn(), storeCatalogs: vi.fn().mockResolvedValue({ catalogs: [] }), checkStores: vi.fn(), storeSnapshots: vi.fn().mockResolvedValue({ snapshots: [] }), liveStock: mock.live }));
import { Portfolio } from "./Sourcing";

const bundle: ResearchBundle = { revision: 1, updated_at: "2026-11-11", target_hashes: {}, reviews: [], document: { schema: "yama-research/1", id: "live", title: "Live", generated_at: "2026-11-10", decks: [{ key: "d", name: "Deck", commander: "Commander", builds: [{ id: "b3", label: "B3", bracket: 3, list: "1 Commander\n1 Path to Exile" }] }], local_sources: [{ name: "Path to Exile", uses: [{ id: "d-path", deck: "d", deck_name: "Deck", category: "unresolved" }], best_offer_per_store: [{ store: "Mothership", price: 1.5, market: 1, condition: "Near Mint", finish: "nonfoil", language: "English", qty: null, url: `${ORIGIN}/products/path-ac`, variant_id: "111", checked_at: "2026-11-10", qualifies: true, title: "Path to Exile [Assassin's Creed]" }] }] } };
const store = { key: "mothership", name: "Mothership", origin: ORIGIN, wanted: 1, read: 1, fresh: 1, hurrying: 0, oldest: "2026-11-13T12:00:00.000Z", newest: "2026-11-13T12:00:00.000Z", failed: 0, error: null };
const answer = (checked_at: string, price: number | null): LiveStock => ({
  at: checked_at, reread_hours: 8, offline: false, stores: [store], markets: {}, unknown: [], hurried: 0,
  answers: [{ origin: ORIGIN, card: "Path to Exile", checked_at, listings: price == null ? [] : [{ title: "Path to Exile [Assassin's Creed] - Near Mint", set: "Assassin's Creed", finish: "nonfoil", condition: "Near Mint", language: null, price, variant: "111", url: `${ORIGIN}/products/path-ac?variant=111` }] }],
});

describe("sourcing page with live store stock", () => {
  it("shows what the store lists now, rechecks the cart's cards first and says when a pick sold out", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mock.live.mockImplementation(async (body: { hurry: string[]; since: string | null }) =>
      body.hurry.length ? answer("2026-11-13T12:30:00.000Z", null) : body.since ? { ...answer(body.since, null), answers: [] } : answer("2026-11-13T12:00:00.000Z", 1.25));
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host), client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const settled = (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check(); }, { timeout: 3000 });
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><Portfolio bundle={bundle} /></MemoryRouter></QueryClientProvider>));
      expect(host.textContent).toContain("$1.50");
      await settled(() => expect(host.textContent).toContain("Live stock from Mothership"));
      expect(mock.live).toHaveBeenCalledWith({ cards: ["Path to Exile"], hurry: [], since: null });
      expect(host.textContent).toContain("Mothership: 1 of 1 cards read");
      expect(host.textContent).toContain("$1.25"); expect(host.textContent).not.toContain("$1.50");
      expect(host.textContent).toContain("In stock on the store’s site");
      expect(host.textContent).toContain("Market reference: $1.00");
      const button = (name: string) => [...host.querySelectorAll("button")].find(b => b.textContent === name)!;
      await act(async () => button("Add all matching cards").click());
      expect(host.textContent).toContain("1 selected copy");
      expect(host.querySelector<HTMLAnchorElement>(".source-cart a[href*='/cart/']")!.href).toBe(`${ORIGIN}/cart/111:1`);
      // The card in the cart is asked for first; the store has since sold it.
      await settled(() => expect(mock.live).toHaveBeenCalledWith({ cards: ["Path to Exile"], hurry: ["Path to Exile"], since: "2026-11-13T12:00:00.000Z" }));
      await settled(() => expect(host.textContent).toContain("1 selected card has sold out at the listing you chose and left the carts: Path to Exile."));
      expect(host.textContent).toContain("0 selected copies");
      expect(host.querySelector(".source-cart")).toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); client.clear(); }
  });
});
