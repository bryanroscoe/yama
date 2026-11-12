// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { ResearchBundle } from "../research/api";
const mock=vi.hoisted(()=>({save:vi.fn().mockResolvedValue({}),fetch:vi.fn().mockResolvedValue({settings:[{effective_from:"2026-11-02",origin:"yama",note:null,rules:{local_buy:{max_usd:2,always_ok_usd:0.5,tiers:[{market_under:null,max_multiple:1.1}]},sealed_max_usd:65}}]}),view:{today:"2026-11-11",b:{settings:[{effective_from:"2026-11-02",origin:"yama",note:null,rules:{local_buy:{max_usd:2,always_ok_usd:0.5,tiers:[{market_under:null,max_multiple:1.5}]},sealed_max_usd:51}}],stores:[{key:"shop",name:"Shop",kind:"local",homepage:"https://shop.example"}]}}}));
vi.mock("./PlanLayout",()=>({usePlanOutlet:()=>({view:mock.view,userId:"owner"})}));
vi.mock("./api",()=>({saveShoppingRules:mock.save,fetchBundle:mock.fetch,storeCatalogs:vi.fn().mockResolvedValue({catalogs:[]}),checkStores:vi.fn(),storeSnapshots:vi.fn().mockResolvedValue({snapshots:[]})}));
import { Portfolio } from "./Sourcing";
const bundle:ResearchBundle={revision:1,updated_at:"2026-11-11",target_hashes:{},reviews:[],document:{schema:"yama-research/1",id:"cap",title:"Cap",generated_at:"2026-11-10",decks:[{key:"d",name:"Deck",commander:"Commander",builds:[{id:"b3",label:"B3",bracket:3,list:"1 Commander\n1 Card"}]}],local_sources:[{name:"Card",uses:[{id:"d-copy",deck:"d",deck_name:"Deck",category:"unresolved"}],offers:[{store:"Shop",price:3,market:3,condition:"Near Mint",qty:null,url:"https://shop.example/card",variant_id:"123",qualifies:false,rule_reason:"over $2 ceiling"}]}]}};
describe("sourcing cap controls",()=>{
 it("previews a raised cap, saves the existing rule shape only on request, and removes over-cap carts",async()=>{
  (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  try{
   await act(async()=>root.render(<QueryClientProvider client={client}><MemoryRouter><Portfolio bundle={bundle}/></MemoryRouter></QueryClientProvider>));
   const input=host.querySelector<HTMLInputElement>('.source-cap input')!;expect(input.value).toBe("2");expect(host.querySelectorAll('.source-card')).toHaveLength(0);
   const enter=async(value:string)=>act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));});
   await enter("3");expect(host.querySelectorAll('.source-card')).toHaveLength(1);expect(mock.save).not.toHaveBeenCalled();
   const button=(name:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===name)!;
   await act(async()=>button("Add all matching cards").click());expect(host.textContent).toContain("0 selected copies");
   const manual=host.querySelector<HTMLInputElement>(".source-qty input")!;
   await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(manual,"1");manual.dispatchEvent(new Event("input",{bubbles:true}));});expect(host.textContent).toContain("1 selected copy");
   expect([...host.querySelectorAll("button")].filter(b=>b.textContent?.startsWith("Add "))).toHaveLength(1);
   const stockFilter=[...host.querySelectorAll("label")].find(l=>l.textContent?.includes("Exclude unknown stock counts"))!.querySelector("input")!;
   await act(async()=>stockFilter.click());expect(host.querySelectorAll(".source-card")).toHaveLength(0);expect(host.textContent).toContain("0 selected copies");
   await act(async()=>stockFilter.click());expect(host.querySelectorAll(".source-card")).toHaveLength(1);
   let complete!: (value: unknown) => void;mock.save.mockReturnValueOnce(new Promise(resolve => { complete=resolve; }));
   await act(async()=>{button("Save cap as default").click();});
   expect(input.disabled).toBe(true);await act(async()=>complete({}));
   await vi.waitFor(async()=>{await act(async()=>{});expect(input.disabled).toBe(false);});
   expect(mock.save).toHaveBeenCalledWith({effective_from:"2026-11-11",local_buy:{max_usd:3,always_ok_usd:0.5,tiers:[{market_under:null,max_multiple:1.1}]},sealed_max_usd:65,note:"Local per-card cap set from sourcing"});
   expect(input.value).toBe("3");
   await enter("4");mock.fetch.mockRejectedValueOnce(new Error("Could not read fresh rules"));await act(async()=>button("Save cap as default").click());expect(mock.save).toHaveBeenCalledTimes(1);await vi.waitFor(async()=>{await act(async()=>{});expect(host.textContent).toContain("Could not read fresh rules");});
   await enter("1");expect(host.querySelectorAll('.source-card')).toHaveLength(0);expect(host.textContent).toContain("0 selected copies");
  }finally{await act(async()=>root.unmount());host.remove();client.clear();}
 });
});
