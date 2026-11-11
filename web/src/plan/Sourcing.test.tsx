import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ResearchBundle } from "../research/api";

vi.mock("./PlanLayout",()=>({PlansHead:()=>null,usePlanOutlet:()=>({userId:"owner",view:{b:{stores:[{key:"mothership",name:"Mothership",kind:"local",homepage:"https://mothershipatx.com",cart_url_template:"https://mothershipatx.com/cart/{items}"},{key:"black-castle",name:"Black Castle Gamez",kind:"local",homepage:"https://blackcastlegamez.tcgplayerpro.com"}]}}})}));
import { Sourcing } from "./Sourcing";

const bundle:ResearchBundle={revision:2,updated_at:"2026-11-11",target_hashes:{},reviews:[],document:{schema:"yama-research/1",id:"source",title:"Local sourcing",generated_at:"2026-11-10",decks:[{key:"a",name:"Deck A",commander:"Commander",builds:[{id:"b2",label:"B2",bracket:2,list:"1 Commander\n1 Sol Ring"}]}],local_sources:[{name:"Sol Ring",status:"qualifying",uses:[{id:"a-ring",deck:"a",deck_name:"Deck A",category:"unresolved gameplay source"}],best_offer_per_store:[{store:"Mothership",url:"https://mothershipatx.com/products/ring",variant_id:"123",price:0.5,qty:null,condition:"Near Mint",checked_at:"2026-11-10",qualifies:true}]}]}};
function render(value:ResearchBundle){const client=new QueryClient();client.setQueryData(["research","owner"],[{id:"source",title:"Local sourcing",revision:2,updated_at:"2026-11-11"}]);client.setQueryData(["research","owner","source"],value);const html=renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter><Sourcing/></MemoryRouter></QueryClientProvider>);client.clear();return html;}
describe("all-deck sourcing page",()=>{
  it("shows the saved portfolio, direct offers, all-store searches and honest snapshot limits",()=>{
    const html=render(bundle);
    expect(html).toContain("1 card name / 1 copy wish");
    expect(html).toContain("Deck A");expect(html).toContain("Quantity unknown");
    expect(html).toContain("Nov 10, 2026");expect(html).toContain("Select all known-stock copies");
    expect(html).toContain('href="https://mothershipatx.com/products/ring"');expect(html).toContain('blackcastlegamez.tcgplayerpro.com/search/products?');expect(html).toContain("/decks/plans/get/trip");expect(html).toContain("does not regenerate");expect(html).not.toContain('>Apply</button>');
  });
  it("keeps unsupported or malformed research from crashing or becoming a zero-cost cart",()=>{
    const html=render({...bundle,document:{...bundle.document,local_sources:{malformed:true}}});expect(html).toContain("no portfolio source rows");expect(html).not.toContain("$0.00");
  });
});
