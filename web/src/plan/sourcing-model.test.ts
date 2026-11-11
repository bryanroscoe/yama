import { describe, expect, it } from "vitest";
import { sourceCards, portfolioRows, sourceCarts, knownStockChoices, sourceSnapshot } from "./sourcing-model";
import type { ResearchDocument } from "../research/api";

const offer = { store:"Mothership",price:0.5,qty:1,condition:"Near Mint",url:"https://mothershipatx.com/products/ring",variant_id:"123",checked_at:"2026-11-10",qualifies:true };
const use = (id:string,deck:string,category="unresolved gameplay source") => ({id,deck,deck_name:deck,category});
const raw = [{name:"Sol Ring",status:"qualifying",uses:[use("a-ring","a"),use("a-ring","a"),use("b-ring","b","arrived proxy: optional real-card wishlist")],best_offer_per_store:[null,offer]}];
const doc:ResearchDocument={schema:"yama-research/1",id:"source",title:"Snapshot",generated_at:"2026-11-10",decks:[{key:"a",name:"A",commander:"Commander",builds:[{id:"b2",label:"B2",bracket:2,list:"1 Commander\n1 Sol Ring"},{id:"b3",label:"B3",bracket:3,list:"1 Commander\n1 Sol Ring"}]},{key:"b",name:"B",commander:"Commander",builds:[{id:"b4",label:"B4",bracket:4,list:"1 Commander\n1 Sol Ring"}]}]};
describe("portfolio sourcing",()=>{
  it("quarantines a stable copy ID reused for different cards or recipients",()=>{
    const snapshot=sourceSnapshot([{...raw[0]!,uses:[use("same","a")]},{...raw[0]!,name:"Different Card",uses:[use("same","b")]}]);
    expect(snapshot.conflicts).toEqual(["same"]);
    expect(portfolioRows(snapshot.cards,doc,new Set(["a","b"]),"","all")).toEqual([]);
  });
  it("handles prototype property names without inherited choices or prototype mutation",()=>{
    for(const name of ["constructor","__proto__","toString"]){
      const rows=sourceCards([{...raw[0]!,name}]);
      expect(sourceCarts(rows,{},new Set())).toEqual([]);
      expect(sourceCarts(rows,knownStockChoices(rows),new Set())[0]!.rows[0]!.qty).toBe(1);
    }
  });
  it("retains explicitly declared cEDH targets whose older report omits numeric bracket metadata",()=>{
    const cedh={...doc,decks:[{key:"a",name:"cEDH",commander:"Commander",builds:[{id:"local-cedh",label:"Existing cEDH target — source check",list:"1 Commander\n1 Sol Ring"}]}]};
    expect(portfolioRows(sourceCards(raw),cedh,new Set(["a"]),"5","all")[0]!.uses).toHaveLength(1);
    expect(portfolioRows(sourceCards(raw),cedh,new Set(["a"]),"4","all")).toEqual([]);
  });
  it("splits one card’s demand across stores in a bulk known-stock selection",()=>{
    const rows=sourceCards([{...raw[0]!,best_offer_per_store:[offer,{...offer,store:"Other",url:"https://other.example/ring",price:0.75}]}]);
    const chosen=knownStockChoices(rows);
    expect(chosen["Sol Ring"]).toHaveLength(2);
    const carts=sourceCarts(rows,chosen,new Set(["https://mothershipatx.com"]));
    expect(carts.reduce((n,c)=>n+c.rows.reduce((n,r)=>n+r.qty,0),0)).toBe(2);
    expect(knownStockChoices(sourceCards([{...raw[0]!,best_offer_per_store:[{...offer,qty:null}]}]))["Sol Ring"]).toEqual([]);
  });
  it("counts one physical wish per recipient instead of summing bracket alternatives",()=>{
    const cards=sourceCards([...raw,...raw]);
    const rows=portfolioRows(cards,doc,new Set(["a","b"]),"","all");
    expect(rows).toHaveLength(1);expect(rows[0]!.uses).toHaveLength(2);
    expect(portfolioRows(cards,doc,new Set(["a","b"]),"2","all")[0]!.uses.map(u=>u.deck)).toEqual(["a"]);
    expect(portfolioRows(cards,doc,new Set(["a","b"]),"","optional")[0]!.uses.map(u=>u.deck)).toEqual(["b"]);
    expect(portfolioRows(cards,doc,new Set(["a","b"]),"","gaps")[0]!.uses.map(u=>u.deck)).toEqual(["a"]);
  });
  it("does not convert malformed snapshots, unsafe links or missing prices into buyable offers",()=>{
    expect(sourceCards({})).toEqual([]);
    const cards=sourceCards([{...raw[0]!,best_offer_per_store:[null,{...offer,url:"javascript:alert(1)"},{...offer,price:null}]}]);
    expect(cards[0]!.offers).toHaveLength(1);
    expect(sourceCarts(cards,{"Sol Ring":[{offer:offer.url,qty:2}]},new Set(["https://mothershipatx.com"]))).toEqual([]);
  });
  it("caps carts by both selected demand and known store stock; never allocates one listed copy twice",()=>{
    const rows=portfolioRows(sourceCards(raw),doc,new Set(["a","b"]),"","all");
    const carts=sourceCarts(rows,{"Sol Ring":[{offer:offer.url,qty:99}]},new Set(["https://mothershipatx.com"]));
    expect(carts[0]!.rows[0]!.qty).toBe(1);expect(carts[0]!.total).toBe(0.5);expect(carts[0]!.url).toBe("https://mothershipatx.com/cart/123:1");
    expect(sourceCarts(portfolioRows(sourceCards(raw),doc,new Set(),"","all"),{"Sol Ring":[{offer:offer.url,qty:2}]},new Set())).toEqual([]);
  });
  it("keeps an unknown-quantity quote visible and only uses the quantity the person explicitly enters",()=>{
    const rows=sourceCards([{...raw[0]!,best_offer_per_store:[{...offer,qty:null}]}]);
    expect(rows[0]!.offers[0]!.qty).toBeNull();expect(sourceCarts(rows,{},new Set())).toEqual([]);
    const carts=sourceCarts(rows,{"Sol Ring":[{offer:offer.url,qty:1}]},new Set());
    expect(carts[0]!.rows[0]!.qty).toBe(1);expect(carts[0]!.url).toBeUndefined();
  });
  it("refuses automatic cart links for unknown hosts, nonnumeric variants and out-of-rule quotes",()=>{
    const selected={"Sol Ring":[{offer:offer.url,qty:1}]};
    expect(sourceCarts(sourceCards(raw),selected,new Set())[0]!.url).toBeUndefined();
    const bad=sourceCards([{...raw[0]!,best_offer_per_store:[{...offer,variant_id:"1/evil"}]}]);
    expect(sourceCarts(bad,selected,new Set(["https://mothershipatx.com"]))[0]!.url).toBeUndefined();
    const no=sourceCards([{...raw[0]!,best_offer_per_store:[{...offer,qualifies:false}]}]);
    expect(sourceCarts(no,selected,new Set())).toEqual([]);
  });
});
