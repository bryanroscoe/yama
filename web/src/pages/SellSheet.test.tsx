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
const html = (items: SellItem[]) => renderToStaticMarkup(<SellSheet items={items} from="Trade binder" inDeckBox={false} onClose={() => undefined} />);

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
