import { describe, expect, it } from "vitest";
import { allChoices, sourceCarts, sourceCards } from "./sourcing-model";
import { capDraft, pricedRows, readCap } from "./source-pricing";
import type { RuleSet } from "@yama/core/plan";
const settings = [{effective_from:"2026-11-02",rules:{local_buy:{max_usd:2,always_ok_usd:0.5,tiers:[{market_under:null,max_multiple:1.5}]},sealed_max_usd:51},origin:"yama"}] as RuleSet[];
const rows=()=>sourceCards([{name:"Card",uses:[{id:"copy",deck:"deck",deck_name:"Deck",category:"unresolved"}],offers:[{store:"Store",price:3,market:3,qty:1,condition:"Near Mint",url:"https://shop.example/products/card",variant_id:"123",qualifies:false,rule_reason:"over $2 ceiling"}]}]);
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
  for(const change of [{rule_reason:"condition rejected"},{rule_reason:undefined},{finish:"foil"},{condition:"Near Mint Foil"},{language:"Japanese"},{title:"Card (Signed)"},{title:"Card (Foil)"}]){
   const offers=rows();Object.assign(offers[0]!.offers[0]!,change);expect(pricedRows(offers,capDraft(settings,"2026-11-11",5).local_buy)[0]!.offers[0]!.qualifies).toBe(false);
  }
 });
});

it("re-evaluates structured non-price eligibility without depending on legacy prose",()=>{
 const offers=rows();Object.assign(offers[0]!.offers[0]!,{rule_reason:undefined,non_price_eligible:true});
 expect(pricedRows(offers,capDraft(settings,"2026-11-11",3).local_buy)[0]!.offers[0]!.qualifies).toBe(true);
 Object.assign(offers[0]!.offers[0]!,{language:"Japanese",finish:"foil"});
 expect(pricedRows(offers,capDraft(settings,"2026-11-11",3).local_buy)[0]!.offers[0]!.qualifies).toBe(true);
 offers[0]!.offers[0]!.non_price_eligible=false;
 expect(pricedRows(offers,capDraft(settings,"2026-11-11",3).local_buy)[0]!.offers[0]!.qualifies).toBe(false);
});
it("reconstructs complete legacy facts and labels incomplete unexplained rejects",()=>{
 const offers=rows();Object.assign(offers[0]!.offers[0]!,{rule_reason:undefined,finish:"nonfoil",language:"English"});
 expect(pricedRows(offers,capDraft(settings,"2026-11-11",3).local_buy)[0]!.offers[0]!.qualifies).toBe(true);
 offers[0]!.offers[0]!.language=undefined;
 const pending=pricedRows(offers,capDraft(settings,"2026-11-11",3).local_buy);
 expect(pending[0]!.offers[0]!.qualifies).toBe(false);expect(pending[0]!.offers[0]!.eligibility_unknown).toBe(true);
});

describe("prefer foil at about the same price",()=>{
 const rule=capDraft(settings,"2026-11-12",2).local_buy;
 const plain={store:"Store",price:0.5,market:0.5,qty:2,condition:"Near Mint",url:"https://shop.example/products/card",variant_id:"1",qualifies:true,rule_reason:"50 cents or less; market exception"};
 const foil=(price:number,variant="2")=>({store:"Store",price,market:price,qty:1,condition:"Near Mint Foil",title:"Card (Foil) [Set]",url:"https://shop.example/products/card-foil",variant_id:variant,qualifies:false,rule_reason:"foil; a plain version exists",non_price_eligible:true});
 const card=(foils:object[])=>sourceCards([{name:"Card",uses:[{id:"a",deck:"d",deck_name:"D",category:"unresolved"},{id:"b",deck:"d2",deck_name:"D2",category:"unresolved"}],best_offer_per_store:[plain],foil_offer_per_store:foils}]);
 it("reads foil alternatives but never shops them unless foil is preferred",()=>{
  const off=pricedRows(card([foil(0.6)]),rule,true,false);
  expect(off[0]!.offers.map(o=>[o.foil_alternative ?? false,o.qualifies])).toEqual([[false,true],[true,false]]);
  expect(allChoices(off).Card).toEqual([{offer:"https://shop.example/products/card#variant=1",qty:2}]);
 });
 it("picks a foil first when it costs at most $0.25 or 10% more than the cheapest plain copy",()=>{
  const on=pricedRows(card([foil(0.75)]),rule,true,true);
  expect(on[0]!.offers[1]!.qualifies).toBe(true);
  const carts=sourceCarts(on,allChoices(on,true),new Map());
  expect(carts[0]!.rows.map(r=>[r.offer.variant_id,r.qty])).toEqual([["2",1],["1",1]]);
  expect(pricedRows(card([foil(0.76)]),rule,true,true)[0]!.offers[1]!.qualifies).toBe(false);
 });
 it("still applies the buy rule and needs a qualifying plain copy to compare with",()=>{
  expect(pricedRows(card([{...foil(0.75),market:0.3}]),rule,true,true)[0]!.offers[1]!.qualifies).toBe(false);
  const noPlain=sourceCards([{name:"Card",uses:[],best_offer_per_store:[{...plain,qty:0}],foil_offer_per_store:[foil(0.5)]}]);
  expect(pricedRows(noPlain,rule,true,true)[0]!.offers[1]!.qualifies).toBe(false);
 });
});
