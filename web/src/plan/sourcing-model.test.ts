import { describe, expect, it } from "vitest";
import { sourceCards, portfolioRows, sourceCarts, knownStockChoices, sourceSnapshot, allChoices, nearMint, offerRows, offerId } from "./sourcing-model";
import type { ResearchDocument } from "../research/api";

const offer = { store:"Mothership",price:0.5,qty:1,condition:"Near Mint",url:"https://mothershipatx.com/products/ring",variant_id:"123",checked_at:"2026-11-10",qualifies:true };
const use = (id:string,deck:string,category="unresolved gameplay source") => ({id,deck,deck_name:deck,category});
const raw = [{name:"Sol Ring",status:"qualifying",uses:[use("a-ring","a"),use("a-ring","a"),use("b-ring","b","arrived proxy: optional real-card wishlist")],best_offer_per_store:[null,offer]}];
const doc:ResearchDocument={schema:"yama-research/1",id:"source",title:"Snapshot",generated_at:"2026-11-10",decks:[{key:"a",name:"A",commander:"Commander",builds:[{id:"b2",label:"B2",bracket:2,list:"1 Commander\n1 Sol Ring"},{id:"b3",label:"B3",bracket:3,list:"1 Commander\n1 Sol Ring"}]},{key:"b",name:"B",commander:"Commander",builds:[{id:"b4",label:"B4",bracket:4,list:"1 Commander\n1 Sol Ring"}]}]};
describe("portfolio sourcing",()=>{
  it("rejects orphaned target demand in the all-brackets union while retaining explicit permanent wishes",()=>{
    const orphan=sourceCards([{...raw[0]!,name:"Removed Card",uses:[use("removed","a"),use("missing-deck","deleted")]}]);
    expect(portfolioRows(orphan,doc,new Set(["a","deleted"]),"","all")).toEqual([]);
    const wishes=sourceCards([{...raw[0]!,name:"Removed Card",uses:[use("wish","original-reservation","arrived proxy: optional real-card wishlist")]}]);
    const rows=portfolioRows(wishes,doc,new Set(["original-reservation"]),"","optional");
    expect(rows[0]!.uses[0]!.build_match).toBe(false);
    expect(portfolioRows(wishes,doc,new Set(["original-reservation"]),"","gaps")).toEqual([]);
    expect(portfolioRows(wishes,doc,new Set(["original-reservation"]),"2","all")).toEqual([]);
  });
  it("honors configured cart templates with custom checkout hosts, paths and queries",()=>{
    const carts=sourceCarts(sourceCards(raw),{"Sol Ring":[{offer:offer.url,qty:1}]},new Map([["https://mothershipatx.com","https://checkout.example/apps/cart/{items}?pickup=yes"]]));
    expect(carts[0]!.url).toBe("https://checkout.example/apps/cart/123:1?pickup=yes");
    expect(sourceCarts(sourceCards(raw),{"Sol Ring":[{offer:offer.url,qty:1}]},new Map([["https://mothershipatx.com","javascript:alert({items})"]]))[0]!.url).toBeUndefined();
  });
  it("matches supported import formats and excludes sideboard cards when selecting a bracket",()=>{
    for(const list of ["Commander\n1 Leader\nDeck\n1x Sol Ring", "1 Leader\n1 Sol Ring (C21) 263 *F*", "1 Leader\nSol Ring #tag", "1 Leader\n1x sol ring (C21) 263"]){
      const formatted={...doc,decks:[{...doc.decks[0]!,builds:[{id:"b2",label:"B2",bracket:2,list}]}]};
      expect(portfolioRows(sourceCards(raw),formatted,new Set(["a"]),"2","all")[0]!.uses).toHaveLength(1);
    }
    const side={...doc,decks:[{...doc.decks[0]!,builds:[{id:"b2",label:"B2",bracket:2,list:"Commander\nLeader\nDeck\nOther Card\nSideboard\n1 Sol Ring"}]}]};
    expect(portfolioRows(sourceCards(raw),side,new Set(["a"]),"2","all")).toEqual([]);
  });
  it("quarantines a stable copy ID reused for different cards or recipients",()=>{
    const snapshot=sourceSnapshot([{...raw[0]!,uses:[use("same","a")]},{...raw[0]!,name:"Different Card",uses:[use("same","b")]}]);
    expect(snapshot.conflicts).toEqual(["same"]);
    expect(portfolioRows(snapshot.cards,doc,new Set(["a","b"]),"","all")).toEqual([]);
  });
  it("handles prototype property names without inherited choices or prototype mutation",()=>{
    for(const name of ["constructor","__proto__","toString"]){
      const rows=sourceCards([{...raw[0]!,name}]);
      expect(sourceCarts(rows,{},new Map())).toEqual([]);
      expect(sourceCarts(rows,knownStockChoices(rows),new Map())[0]!.rows[0]!.qty).toBe(1);
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
    const carts=sourceCarts(rows,chosen,new Map([["https://mothershipatx.com","https://mothershipatx.com/cart/{items}"]]));
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
    expect(sourceCarts(cards,{"Sol Ring":[{offer:offer.url,qty:2}]},new Map([["https://mothershipatx.com","https://mothershipatx.com/cart/{items}"]]))).toEqual([]);
  });
  it("caps carts by both selected demand and known store stock; never allocates one listed copy twice",()=>{
    const rows=portfolioRows(sourceCards(raw),doc,new Set(["a","b"]),"","all");
    const carts=sourceCarts(rows,{"Sol Ring":[{offer:offer.url,qty:99}]},new Map([["https://mothershipatx.com","https://mothershipatx.com/cart/{items}"]]));
    expect(carts[0]!.rows[0]!.qty).toBe(1);expect(carts[0]!.total).toBe(0.5);expect(carts[0]!.url).toBe("https://mothershipatx.com/cart/123:1");
    expect(sourceCarts(portfolioRows(sourceCards(raw),doc,new Set(),"","all"),{"Sol Ring":[{offer:offer.url,qty:2}]},new Map())).toEqual([]);
  });
  it("keeps an unknown-quantity quote visible and only uses the quantity the person explicitly enters",()=>{
    const rows=sourceCards([{...raw[0]!,best_offer_per_store:[{...offer,qty:null}]}]);
    expect(rows[0]!.offers[0]!.qty).toBeNull();expect(sourceCarts(rows,{},new Map())).toEqual([]);
    const carts=sourceCarts(rows,{"Sol Ring":[{offer:offer.url,qty:1}]},new Map());
    expect(carts[0]!.rows[0]!.qty).toBe(1);expect(carts[0]!.url).toBeUndefined();
  });
  it("refuses automatic cart links for unknown hosts, nonnumeric variants and out-of-rule quotes",()=>{
    const selected={"Sol Ring":[{offer:offer.url,qty:1}]};
    expect(sourceCarts(sourceCards(raw),selected,new Map())[0]!.url).toBeUndefined();
    const bad=sourceCards([{...raw[0]!,best_offer_per_store:[{...offer,variant_id:"1/evil"}]}]);
    expect(sourceCarts(bad,selected,new Map([["https://mothershipatx.com","https://mothershipatx.com/cart/{items}"]]))[0]!.url).toBeUndefined();
    const no=sourceCards([{...raw[0]!,best_offer_per_store:[{...offer,qualifies:false}]}]);
    expect(sourceCarts(no,selected,new Map())).toEqual([]);
  });
});

describe("shopping clarity",()=>{
 it("labels each recipient with the brackets that actually contain the card",()=>{
  const rows=portfolioRows(sourceCards(raw),doc,new Set(["a","b"]),"","all");
  expect(rows[0]!.uses.map(u=>u.brackets)).toEqual([[2,3],[4]]);
  expect(portfolioRows(sourceCards(raw),doc,new Set(["a","b"]),"3","all")[0]!.uses[0]!.brackets).toEqual([3]);
 });
 it("defaults NM filtering without treating LP or unknown conditions as NM",()=>{
  expect(nearMint("NM")).toBe(true);expect(nearMint("Near Mint / English")).toBe(true);expect(nearMint("Lightly Played")).toBe(false);expect(nearMint("")).toBe(false);
  const rows=sourceCards([{...raw[0]!,offers:[offer,{...offer,condition:"Lightly Played",url:"https://other.test/card"}]}]);
  expect(offerRows(rows,"nm","")[0]!.offers).toHaveLength(1);
  expect(offerRows(rows,"any","")[0]!.offers).toHaveLength(2);
 });
 it("bulk fills unknown quantities as requested copies, while confirmed-only stays empty",()=>{
  const rows=sourceCards([{...raw[0]!,offers:[{...offer,qty:null}]}]);
  expect(knownStockChoices(rows)["Sol Ring"]).toEqual([]);
  const selected=allChoices(rows);expect(selected["Sol Ring"]![0]!.qty).toBe(2);
  expect(sourceCarts(rows,selected,new Map())[0]!.rows[0]!.offer.qty).toBeNull();
 });
 it("preserves exact printing market provenance and all saved variants",()=>{
  const rows=sourceCards([{...raw[0]!,offers:[{...offer,title:"Sol Ring [C21]",market:1.25,market_source:"https://scryfall.com/card/c21/263/sol-ring",market_evidence:{scryfall_id:"id",matching:"retailer image ID",checked_at:"2026-11-10"}},{...offer,url:"https://store.test/nm"}]}]);
  expect(rows[0]!.offers).toHaveLength(2);expect(rows[0]!.offers[0]!.market).toBe(1.25);expect(rows[0]!.offers[0]!.printing_id).toBe("id");
 });
});

it("keeps same-product Shopify variants distinct across NM/LP and carts the chosen variant",()=>{
 const lp={...offer,condition:"Lightly Played",variant_id:"111",price:0.25};
 const nm={...offer,condition:"Near Mint",variant_id:"222",price:0.50};
 const cards=sourceCards([{...raw[0]!,offers:[lp,nm]}]);
 const rows=portfolioRows(cards,doc,new Set(["a"]),"2","all");
 expect(rows[0]!.offers).toHaveLength(2);
 const filtered=offerRows(rows,"nm","");expect(filtered[0]!.offers[0]!.variant_id).toBe("222");
 const carts=sourceCarts(filtered,allChoices(filtered),new Map([["https://mothershipatx.com","https://mothershipatx.com/cart/{items}"]]));
 expect(carts[0]!.url).toBe("https://mothershipatx.com/cart/222:1");
 expect(sourceCarts(rows,{"Sol Ring":[{offer:offer.url,qty:1}]},new Map())).toEqual([]);
 expect(offerId(lp)).not.toBe(offerId(nm));
});

it("retains non-Shopify condition/printing variants when SKU IDs are missing",()=>{
 const lp={...offer,variant_id:"",condition:"Lightly Played",title:"Ring [A]",price:0.25};
 const nm={...offer,variant_id:"",condition:"Near Mint",title:"Ring [B]",price:0.50};
 const rows=portfolioRows(sourceCards([{...raw[0]!,offers:[lp,nm]}]),doc,new Set(["a","b"]),"","all");
 expect(rows[0]!.offers).toHaveLength(2);expect(offerId(lp)).not.toBe(offerId(nm));
 const carts=sourceCarts(rows,allChoices(rows),new Map());
 expect(carts[0]!.rows.map(r=>r.offer.condition)).toEqual(["Near Mint","Lightly Played"]);
 expect(sourceCarts(rows,{"Sol Ring":[{offer:offer.url,qty:2}]},new Map())).toEqual([]);
});
