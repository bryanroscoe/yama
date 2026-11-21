import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SellSheet, type SellItem } from "./SellSheet";

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });

const item = (over: Partial<SellItem> = {}): SellItem => ({
  id: "i1",
  scryfall_id: "s1",
  name: "Sol Ring",
  set_code: "c21",
  set_name: "Commander 2021",
  collector_number: "263",
  qty: 1,
  condition: "NM",
  finish: "nonfoil",
  lang: "en",
  proxy: false,
  container_kind: "binder",
  unit_price_usd: null,
  price_date: null,
  ...over,
});
const mothership = { name: "Mothership Books and Games", short: "Mothership" };
const html = (items: SellItem[], buylist: typeof mothership | null = null) => renderToStaticMarkup(<SellSheet items={items} from="Trade binder" inDeckBox={false} buylist={buylist} onClose={() => undefined} />);

describe("the sell list sheet", () => {
  it("never shows a missing price as $0", () => {
    const h = html([item(), item({ id: "i2", name: "Arcane Signet" })]);
    expect(h).toContain("No market price for any of them.");
    expect(h).not.toContain("$0.00");
  });

  it("totals known prices with their date and counts the rest", () => {
    const h = html([item({ unit_price_usd: 1.5, price_date: "2026-11-01", qty: 2 }), item({ id: "i2", name: "Arcane Signet" })]);
    expect(h).toContain("$3.00 market value (TCGplayer market via Scryfall, Nov 1), 1 with no price.");
    const span = html([item({ unit_price_usd: 1, price_date: "2026-10-30" }), item({ id: "i2", unit_price_usd: 2, price_date: "2026-11-01" })]);
    expect(span).toContain("$3.00 market value (TCGplayer market via Scryfall, Oct 30 to Nov 1).");
  });

  it("leaves deck boxes and proxies out by default, and says how many a deck box would add", () => {
    const h = html([item(), item({ id: "d", name: "Cyclonic Rift", container_kind: "deck", qty: 2 }), item({ id: "p", name: "Mana Crypt", proxy: true })]);
    expect(h).toContain("Include 2 cards in deck boxes");
    expect(h).not.toContain("Cyclonic Rift");
    expect(h).toContain("Mana Crypt: a proxy");
    expect(h).toMatch(/<b class="num">1 card<\/b>/);
  });
});

it("checks etched copies at Mothership independently of Card Kingdom's export restrictions", () => {
  vi.stubGlobal("localStorage", { getItem: () => "cardkingdom", setItem: () => undefined });
  try {
    const h=html([item({name:"Panharmonicon",finish:"etched"})], mothership);
    expect(h).toContain("Check 1 card with Mothership");
    expect(h).toContain("Card Kingdom");
  } finally {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  }
});

it("offers a store's buylist check only to an account that has that store, under one heading", () => {
  const without = html([item()]);
  // No store: nothing offers to ask it, but checks saved on the account before can still be read.
  expect(without).not.toMatch(/Check \d+ cards? with/);
  expect(without).not.toContain("Buylist offers from");
  expect(without).not.toContain("buylist offers");
  expect(without).not.toContain("One request to the store");
  expect(without).toContain("<summary>Saved buylist checks</summary>");
  expect(without).toContain("Nothing is asked of the store here.");
  expect(without).toMatch(/<button[^>]*>Saved checks<\/button>/);
  const withStore = html([item()], mothership);
  expect(withStore.split("Buylist offers from Mothership Books and Games (Austin, TX)")).toHaveLength(3); // the fold's label and the section's name
  expect(withStore).not.toContain("Local buylist offers");
});

it("says the tick boxes are how cards are chosen", () => {
  const h = html([item()]);
  expect(h).toContain("From Trade binder. Untick what you&#x27;re keeping. Proxies are never included.");
  expect(h).not.toContain("move them into a list");
});
