import { describe, expect, it } from "vitest";
import { allChoices, sourceCarts, sourceCards } from "./sourcing-model";
import { capDraft, pricedRows, readCap } from "./source-pricing";
import type { RuleSet } from "@yama/core/plan";
const settings = [{effective_from:"2026-11-02",rules:{local_buy:{max_usd:2,always_ok_usd:0.5,tiers:[{market_under:null,max_multiple:1.5}]},sealed_max_usd:51},origin:"yama"}] as RuleSet[];
const rows=()=>sourceCards([{name:"Card",uses:[{id:"copy",deck:"deck",deck_name:"Deck",category:"unresolved"}],offers:[{store:"Store",price:3,market:3,qty:null,condition:"Near Mint",url:"https://shop.example/products/card",variant_id:"123",qualifies:false,rule_reason:"over $2 ceiling"}]}]);
describe("local sourcing dollar ceiling",()=>{
 it("accepts zero and no ceiling but rejects malformed or out-of-range prices",()=>{
  expect(readCap("0")).toEqual({value:0,valid:true});expect(readCap("")).toEqual({value:null,valid:true});
  for(const input of ["-1","NaN","Infinity","10001"])expect(readCap(input).valid).toBe(false);
 });
 it("reconsiders old price-only rejections and caps both bulk and manually selected carts",()=>{
  const raised=pricedRows(rows(),capDraft(settings,"2026-11-11",3).local_buy);
  const choices=allChoices(raised);expect(sourceCarts(raised,choices,new Map())[0]!.total).toBe(3);
  const lowered=pricedRows(rows(),capDraft(settings,"2026-11-11",2).local_buy);
  expect(sourceCarts(lowered,choices,new Map())).toEqual([]);expect(allChoices(lowered).Card).toEqual([]);
  expect(rows()[0]!.offers[0]!.qualifies).toBe(false);
 });
 it("preserves market limits, sealed limits and historical settings on save",()=>{
  const draft=capDraft(settings,"2026-11-11",5);expect(draft.sealed_max_usd).toBe(51);expect(draft.local_buy.tiers).toEqual(settings[0]!.rules.local_buy!.tiers);
  const offers=rows();offers[0]!.offers[0]!.market=1;
  expect(pricedRows(offers,draft.local_buy)[0]!.offers[0]!.qualifies).toBe(false);
  offers[0]!.offers[0]!.market=null;
  expect(pricedRows(offers,draft.local_buy)[0]!.offers[0]!.qualifies).toBe(false);
  expect(capDraft(settings,"2026-11-11",0.25).local_buy.always_ok_usd).toBe(0.25);expect(settings[0]!.rules.local_buy!.max_usd).toBe(2);
 });
 it("does not overturn non-price or unknown rejections, foil or language restrictions",()=>{
  for(const change of [{rule_reason:"condition rejected"},{rule_reason:undefined},{finish:"foil"},{condition:"Near Mint Foil"},{language:"Japanese"}]){
   const offers=rows();Object.assign(offers[0]!.offers[0]!,change);expect(pricedRows(offers,capDraft(settings,"2026-11-11",5).local_buy)[0]!.offers[0]!.qualifies).toBe(false);
  }
 });
});
