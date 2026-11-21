import { renderToStaticMarkup } from "react-dom/server";
import { it, expect } from "vitest";
import type { PlanBundle, Store } from "@yama/core/plan";
import { buylistName, buylistStore, OfferSummary, SellOffers } from "./SellOffers";

const store = (over: Partial<Store> = {}): Store => ({
  key: "mothership", name: "Mothership Books and Games", short: "Mothership", kind: "local", cart_url_template: null, homepage: "https://mothershipatx.com", location: null, note: null,
  print_tiers: null, sort: 1, origin: "import", retired: false, retired_at: null, ...over,
});

it("offers an explicit local lookup with saved checks and no sale submission", () => {
  const html=renderToStaticMarkup(<SellOffers store={store()} cards={[]} qty={(c)=>c.qty} onChoose={() => undefined} />);
  expect(html).toContain("Check 0 cards with Mothership");
  expect(html).toContain("Checks are saved to your account");
  expect(html).toContain("No sale is submitted here");
  expect(html).not.toContain("$0.00");
  // The sheet's fold is the heading: it isn't printed again inside.
  expect(html).not.toContain("<h3");
  expect(html).toContain('aria-label="Buylist offers from Mothership Books and Games (Austin, TX)"');
});

it("is for an account that has the store among its own, and hasn't ruled it out", () => {
  const bundle = (stores: Store[], prefs: PlanBundle["store_prefs"] = {}) => ({ stores, store_prefs: prefs });
  expect(buylistStore(bundle([store()]))?.key).toBe("mothership");
  expect(buylistStore(bundle([store({ key: "ms", homepage: "https://buylist.mothershipatx.com/retailer/buylist" })]))?.key).toBe("ms");
  // Another city's account, a new account, or no plan at all: not offered.
  expect(buylistStore(bundle([store({ key: "pats", name: "Pat's Games", homepage: "https://patsgames.com" })]))).toBeNull();
  expect(buylistStore(bundle([]))).toBeNull();
  expect(buylistStore(undefined)).toBeNull();
  expect(buylistStore(bundle([store({ homepage: null })]))).toBeNull();
  expect(buylistStore(bundle([store({ homepage: "https://notmothershipatx.com" })]))).toBeNull();
  // A store that is gone, or one the account won't go to.
  expect(buylistStore(bundle([store({ retired: true })]))).toBeNull();
  expect(buylistStore(bundle([store()], { mothership: { preference: "never", note: null, updated_at: "2026-11-02T14:47:59Z" } }))).toBeNull();
  expect(buylistName(store())).toBe("Mothership Books and Games (Austin, TX)");
});

it("labels partial credit separately from the complete cash total", () => {
  const total = { copies: 2, cash: 2, credit: 1.15, creditUnknown: 1, unchecked: 0, quantities: new Map<string, number>() };
  const html = renderToStaticMarkup(<OfferSummary total={total} />);
  expect(html).toContain("2 copies: $2.00 cash");
  expect(html).toContain("known store credit subtotal: $1.15");
  expect(html).toContain("credit unknown for 1 copy");
  expect(html).not.toContain("or $1.15 store credit");
  const known = renderToStaticMarkup(<OfferSummary total={{ ...total, creditUnknown: 0 }} />);
  expect(known).toContain("or $1.15 store credit");
  expect(known).not.toContain("subtotal");
  const unknown = renderToStaticMarkup(<OfferSummary total={{ ...total, creditUnknown: 2, credit: 0 }} />);
  expect(unknown).toContain("credit unknown for 2 copies");
  expect(unknown).not.toContain("$0.00");
});
