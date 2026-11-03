import { describe, it, expect } from "vitest";
import { canCheck, offerKey, offerTotals, type BuylistOffer } from "./buylistOffers";
import type { SellCard } from "./sellList";
const card = (over: Partial<SellCard> = {}): SellCard => ({ id: "i", scryfall_id: "printing", name: "Sol Ring", set_code: "c21", set_name: "Commander 2021", collector_number: "263", qty: 3, condition: "NM", finish: "nonfoil", lang: "en", proxy: false, ...over });
const offer = (over: Partial<BuylistOffer> = {}): BuylistOffer => ({ checked_at: new Date().toISOString(), source: "https://buylist.mothershipatx.com/retailer/buylist", store: "Mothership ATX", status: "accepting", cash_usd: 0.75, credit_usd: 0.86, quantity_limit: 4, product_id: "product", variant_id: "variant", title: "Sol Ring", note: "", ...over });
describe("local buylist offers", () => {
  it("caps one product across containers and recalculates with the chosen quantity", () => {
    const c = card(), other = card({ id: "other", qty: 5 });
    const results = new Map([[offerKey(c), offer()]]);
    const all = offerTotals([c,other],results,(x)=>x.qty);
    expect(all).toMatchObject({ copies: 4, cash: 3, credit: 3.44 });
    expect([...all.quantities]).toEqual([["i",3],["other",1]]);
    expect(offerTotals([c,other],results,(x)=>x.id === "other" ? 0 : 1)).toMatchObject({ copies: 1, cash: 0.75 });
  });
  it("keeps missing and ambiguous demand out of totals and tracks unchecked copies", () => {
    const c = card();
    for (const status of ["unmatched","check_printing","ambiguous","unknown","not_accepting"] as const) {
      expect(offerTotals([c],new Map([[offerKey(c),offer({status})]]),(x)=>x.qty).copies).toBe(0);
    }
    expect(offerTotals([c],new Map(),(x)=>x.qty).unchecked).toBe(3);
    const result = offerTotals([c],new Map([[offerKey(c),offer({credit_usd:null})]]),(x)=>x.qty);
    expect(result.creditUnknown).toBe(3); expect(result.cash).toBe(2.25);
  });
  it("does not reuse an offer for a different finish or condition", () => {
    const c=card(), results=new Map([[offerKey(c),offer()]]);
    expect(offerTotals([card({finish:"foil"}),card({condition:"LP"})],results,(x)=>x.qty).unchecked).toBe(6);
  });
  it("excludes special copies, proxies and unsupported languages", () => {
    const c=card();
    for (const extra of [{proxy:true},{signed:true},{altered:true},{misprint:true},{lang:"ja"}]) {
      const special=card(extra); expect(canCheck(special)).toBe(false);
      expect(offerTotals([special],new Map([[offerKey(c),offer()]]),(x)=>x.qty).copies).toBe(0);
    }
  });
});

it("keeps expired historical observations out of current totals and export quantities", () => {
  const c=card(), o=offer({checked_at:"2026-10-01T00:00:00Z"});
  const result=offerTotals([c],new Map([[offerKey(c),o]]),(x)=>x.qty,Date.parse("2026-11-02T00:00:00Z"));
  expect(result.copies).toBe(0); expect(result.unchecked).toBe(3); expect(result.quantities.size).toBe(0);
});
