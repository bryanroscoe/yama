import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ResearchPage } from "./Research";
import { AcquisitionItem, AgentShopping as Shopping, PrintedWishlist } from "./owner";
import { AccountingSummary, Gameplay, buildAccounting, listEntries, resolvedCombos } from "./details";
import { plainList, type DeckView, type NoteView } from "./view";
import { changedAnswer, money, safeUrl, targetForSwap, type ResearchBundle } from "./api";
import { changedSince } from "./about";
import type { DeckSummary } from "../api";

vi.mock("../auth",()=>({useMe:()=>({data:{id:"owner"}})}));
vi.mock("../components/DeckTabs",()=>({AreaHead:({title}:{title?:string})=>title?<h1>{title}</h1>:null,BackButton:({label}:{label:string})=><a>{label}</a>}));

function fullPage(query="") {
  const build={id:"b3",label:"Bracket 3",bracket:3,power:{range:"6–7/10",label:"Strong casual"},list:"Commander\n1 Saheeli\nDeck\n1 Thought Monitor\n1 Sol Ring\n97 Forest",gameplay_profile:{plan:"Copy artifacts and turn a developed board into combat pressure.",setup:["Three lands and an early rock"],finishers:["Cyberdrive Awakener after building artifact tokens"],interaction:"Keep Negate open",pace:"Needs an engine and a board; no measured finish-turn result.",confidence:"Structural review"},swaps:[{id:"monitor",card_in:"Thought Monitor",card_out:"Glimmer of Genius",why:"Repeatable artifact draw",acquisition:{kind:"print",detail:"No qualifying offer verified"}}]};
  const b:ResearchBundle={document:{schema:"yama-research/1",id:"audit",title:"Deck review",generated_at:"2026-10-27",decks:[{key:"energy",name:"Living Energy",commander:"Saheeli",recommended_build:"b3",builds:[build,{...build,id:"b4-combo-option",label:"Bracket 4 combo option",bracket:4,base_build:"b4",option_swap:{card_in:"Combat Celebrant",card_out:"Call Forth the Tempest"}}]}]},revision:1,updated_at:"2026-10-27",target_hashes:{"deck:energy":"deckhash","swap:energy:b3:monitor":"swaphash"},reviews:[{target:"deck:energy",decision:"b3",note:"Keep friends games interactive",target_hash:"deckhash",version:1,updated_at:"2026-10-27"},{target:"swap:energy:b3:monitor",decision:"want",note:null,target_hash:"swaphash",version:1,updated_at:"2026-10-27"}]};
  const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});client.setQueryData(["research","owner","audit"],b);
  const buildId=new URLSearchParams(query).get("build")??"b3";
  const view:DeckView={build:buildId,vs:null,vs_label:"the starting list",art:null,identity:"U",changes:[{add:"Thought Monitor",cut:"Glimmer of Genius",n:1,why:"Repeatable artifact draw",notes:[],add_image:null,cut_image:null,swap:"monitor"}],shopping:null,text:"Commander\n1 Saheeli\n\nDeck\n97 Forest\n1 Sol Ring\n1 Thought Monitor\n",cards:[{name:"Saheeli",qty:1,board:"commander",type_line:"Legendary Creature",cmc:2,image:null},{name:"Forest",qty:97,board:"main",type_line:"Basic Land — Forest",cmc:0,image:null}],cut:false,unknown:[]};
  client.setQueryData(["research","owner","audit","view",1,"energy",{build:buildId,vs:undefined,get:"split"}],view);
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/decks/research/audit/energy${query}`]}><Routes><Route path="/decks/research/:reportId/:deckKey" element={<ResearchPage/>}/></Routes></MemoryRouter></QueryClientProvider>);client.clear();return html;
}

describe("deck research evidence", () => {
  it("keeps permanent printed-card wishes separate from orders and unknown quotes",()=>{
    const wishlist={id:"printed-real",label:"Permanent real-card wishlist",purpose:"permanent_real_wishlist" as const,note:"A proxy never removes this wish.",buys:[{card:"Rhystic Study",reason:"3 arrived prints recorded",detail:"Real copies: 0 in dated snapshot",url:"javascript:alert(1)"}],buy_total:null};
    const html=renderToStaticMarkup(<MemoryRouter><PrintedWishlist scenarios={[wishlist]}/><Shopping defaultId="printed-real" scenarios={[wishlist,{id:"order",label:"Actual proposal",buys:[{card:"Other card",price:1}],buy_total:1}]}/></MemoryRouter>);
    expect(html).toContain("3 arrived prints recorded");expect(html).toContain("Quantity to buy: undecided");expect(html).toContain("Local price and stock: Unknown");expect(html).toContain('aria-label="Preview Rhystic Study"');expect(html).not.toContain("javascript:");expect(html).toContain("1 local singles; $1.00 before tax");expect(html).not.toContain('value="printed-real"');
    expect(renderToStaticMarkup(<Shopping scenarios={[wishlist]}/>)).toBe("");
  });
  it("keeps unknown prices unknown and store quotes apart from markets", () => {
    expect(money(null)).toBe("Unknown");expect(money(undefined)).toBe("Unknown");expect(money(0)).toBe("$0.00");
    const html=renderToStaticMarkup(<MemoryRouter><AcquisitionItem item={{card:"New Card",kind:"buy",store:"Pat’s",price:1.75,market:null,printing:"SET #1",checked:"2026-10-27",url:"https://example.com/card"}} /></MemoryRouter>);
    expect(html).toContain("$1.75");expect(html).toContain("Matched market: Unknown");expect(html).toContain("checked 2026-10-27");expect(html).toContain("SET #1");expect(html).not.toContain("$0.00");
  });
  it("escapes supplied notes and refuses executable links", () => {
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();expect(safeUrl("data:text/html,x")).toBeUndefined();expect(safeUrl("https://example.com")).toBe("https://example.com/");
    const html=renderToStaticMarkup(<MemoryRouter><AcquisitionItem item={{card:"<script>x</script>",kind:"print",detail:"<img src=x onerror=alert(1)>"}} /></MemoryRouter>);
    expect(html).toContain("&lt;script&gt;");expect(html).not.toContain("<script>");expect(html).not.toContain("<img src=x");
  });
  it("shows power reasoning and uncertainty without presenting a win rate", () => {
    const html=renderToStaticMarkup(<Gameplay legacy={{range:"6–7/10",label:"Strong casual",confidence:"Low to moderate",rationale:"Needs a board and combat.",speed:"No measured win-turn data.",vulnerabilities:["Graveyard hate"]}} />);
    expect(html).not.toContain("6–7/10");expect(html).toContain("Needs a board and combat.");expect(html).toContain("No measured win-turn data.");expect(html).toContain("Graveyard hate");
  });
  it("detects changed and retired review targets rather than reapproving them", () => {
    const target=targetForSwap("energy","b3","monitor");expect(target).toBe("swap:energy:b3:monitor");
    const review={target,decision:"want",note:null,target_hash:"old",version:1,updated_at:"2026-10-27"};
    const b={target_hashes:{[target]:"old"}} as unknown as ResearchBundle;expect(changedAnswer(b,review)).toBe(false);
    b.target_hashes[target]="new";expect(changedAnswer(b,review)).toBe(true);delete b.target_hashes[target];expect(changedAnswer(b,review)).toBe(true);
  });
  it("opens a copy of a shared note instead of the note list",()=>{
    const client=new QueryClient();
    const html=renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/decks/research?copy=abc123"]}><Routes><Route path="/decks/research" element={<ResearchPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
    expect(html).toContain("Saving a copy of the shared plan");
  });
  it("shows exact swaps, retained answers and alternatives without an Apply action",()=>{
    const html=fullPage();expect(html).toContain("Living Energy");expect(html).toContain("Thought Monitor");expect(html).toContain("Glimmer of Genius");expect(html).toContain("Repeatable artifact draw");expect(html).toContain("Preferred build ✓");expect(html).toContain("Keep friends games interactive");expect(html).toContain('aria-pressed="true"');expect(html).toContain("Download the list");expect(html).toContain("100 cards");expect(html).toContain("97 Forest");expect(html).toContain("Copy artifacts and turn a developed board into combat pressure.");expect(html).toContain('aria-label="Preview Thought Monitor"');expect(html).not.toContain(">Apply</button>");expect(html).toContain("They change no deck or order");
    // The shared page's sections, in its order: the build, how to pilot, how it plays, changes, the list.
    for (const [a,b] of [["How it plays","Changes from"],["Changes from","Decklist"]] as const) expect(html.indexOf(a)).toBeLessThan(html.indexOf(b));
    // A swap's own answer sits beside it in the changes table.
    expect(html).toContain("Don’t want");
    // No acquisition evidence (a copy of a shared plan has none): no empty acquisition section.
    expect(html).not.toContain("What to keep, move, buy or print");
  });
  it("makes an optional variant’s change from base B4 explicit",()=>{
    const html=fullPage("?build=b4-combo-option");expect(html).toContain("Optional change from base Bracket 4");expect(html).toContain("Combat Celebrant");expect(html).toContain("Call Forth the Tempest");
  });
  it("keeps the100-card total separate from a10-card swap and83 nonbasic copies",()=>{
    const list="Commander\n1 Hearthhull, the Worldseed\nDeck\n"+Array.from({length:82},(_,i)=>`1 Card ${i}`).join("\n")+"\n17 Forest\n";
    const build={id:"b2",label:"Bracket2",list,swaps:Array.from({length:10},(_,i)=>({id:String(i),card_in:`In ${i}`,card_out:`Out ${i}`})),acquisition:{owned:[{card:"assigned copies",qty:83}]}};
    const a=buildAccounting(build);expect(a.total).toBe(100);expect(a.basics).toBe(17);expect(a.owned).toBe(83);expect(a.added).toBe(10);expect(a.unchanged).toBe(90);
    const html=renderToStaticMarkup(<AccountingSummary build={build}/>);expect(html).toContain("100 cards total");expect(html).toContain("10 cards in, 10 cards out");expect(html).toContain("Swaps replace cards");expect(html).toContain("83");expect(html).toContain("17");
    expect(listEntries(list).filter((r)=>r.commander)).toHaveLength(1);
  });
  it("resolves deduplicated combo instructions with each build’s presence",()=>{
    const combo={id:"line",name:"Engine",cards:["Sol Ring"],steps:["Actual instructions"],outcome:"Finite"};
    const deck={key:"d",name:"D",commander:"C",builds:[],combo_playbook:[combo]};
    const resolved=resolvedCombos(deck,{id:"b3",label:"B3",list:"",combos:[{id:"line",name:"Engine",present:false,missing_cards:["Sol Ring"]}]});
    expect(resolved[0]?.steps).toEqual(["Actual instructions"]);expect(resolved[0]?.present).toBe(false);
  });
  it("selects the planned-purchase scenario and separates sealed prices from singles",()=>{
    const html=renderToStaticMarkup(<MemoryRouter><Shopping defaultId="future" scenarios={[{id:"default",label:"Owned only",buys:[],prints:[],buy_total:0},{id:"future",label:"After Final Fantasy purchase",sealed_purchases:[{kind:"sealed_purchase",card:"Limit Break",store:"Pat’s",price:47.01,market:50,detail:"Not bought"}],buys:[{card:"Single",price:1.25,market:1.3,store:"Pat’s"}],buy_total:1.25,print_count:12}]}/></MemoryRouter>);
    expect(html).toContain("Buy these precons first");expect(html).toContain("$47.01");expect(html).toContain("$1.25 before tax");expect(html).not.toContain("$48.26");expect(html).toContain("not cards you own now");
  });

  it("lists plans on Plans and keeps a plan's dated provenance",()=>{
    const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});
    const index=renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/decks/research"]}><Routes><Route path="/decks/research" element={<ResearchPage/>}/><Route path="/decks/plan" element={<p>PLANS</p>}/></Routes></MemoryRouter></QueryClientProvider>);
    client.clear();
    // The list of plans is on Plans: the old address sends there (a redirect, so nothing renders here).
    expect(index).not.toContain("Agent notes");expect(index).not.toContain("Import a note file");
    const b:ResearchBundle={document:{schema:"yama-research/1",id:"audit",title:"Deck review",generated_at:"2026-10-27",summary:"Builds for one deck.",copied_from:{link:"/r/0123456789abcdef01234567",by:"saget"},decks:[{key:"energy",name:"Living Energy",commander:"Saheeli",recommended_build:"b3",builds:[{id:"b3",label:"Bracket 3",list:"Commander\n1 Saheeli\nDeck\n1 Sol Ring\n98 Forest",swaps:[{id:"s",card_in:"Sol Ring",card_out:"Island"}]}]}]},revision:1,updated_at:"2026-10-27",target_hashes:{},reviews:[]};
    const totals={cards:1,buy:1,buy_cost:1.5,print:0,print_cost:0,worth:1.5,cost:1.5,unpriced:0,uncosted:0,buy_uncosted:0};
    const view:NoteView={lists:[{deck:"energy",build:"b3",text:"Commander\n1 Saheeli\n\nDeck\n98 Forest\n1 Sol Ring\n"}],which:"recommended",build:null,decks:[{key:"energy",art:null,identity:"G",label:"Bracket 3",builds:[{id:"b3",label:"Bracket 3"}],totals}],shopping:{get:"split",gets:[{id:"split",label:"Buy up to $2.00, print the rest"},{id:"buy",label:"Buy every card locally"},{id:"print",label:"Print every card"}],explain:"A card at $2.00 or less is worth buying.",prices_from:"2026-10-27",prices_to:"2026-10-27",total:totals,items:[{name:"Sol Ring",n:1,usd:1.5,date:"2026-10-27",image:null,decks:["Living Energy"],get:"buy",cost:1.5}]}};
    client.setQueryData(["research","owner","audit"],b);
    client.setQueryData(["research","owner","audit","view",1,{build:null,all:false,get:"split"}],view);
    const note=renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/decks/research/audit"]}><Routes><Route path="/decks/research/:reportId" element={<ResearchPage/>}/></Routes></MemoryRouter></QueryClientProvider>);
    client.clear();
    expect(note).toContain("Copied from");expect(note).toContain("@saget&#x27;s shared plan");expect(note).toContain("Saved 27 Oct 2026");
    expect(note).toContain("1 to buy locally: about $1.50");expect(note).toContain("as of 27 Oct 2026");expect(note).toContain("Shopping list");expect(note).toContain("Deck lists");
    expect(note).toContain("1 Sol Ring");expect(note).toContain('href="/decks/research/audit/energy"');
  });

  it("flags a note's deck when the deck changed after the note was saved",()=>{
    const d=(name:string,updated_at:string,parent_id:string|null=null)=>({id:name,name,updated_at,parent_id} as unknown as DeckSummary);
    const decks=[d("Living Energy","2026-10-28T10:00:00Z"),d("Riders of Rohan","2026-10-20T10:00:00Z"),d("Living Energy (stock)","2026-10-29T00:00:00Z","Living Energy")];
    expect(changedSince(decks,"living energy","2026-10-27")?.id).toBe("Living Energy");
    expect(changedSince(decks,"Riders of Rohan","2026-10-27")).toBeNull();
    expect(changedSince(decks,"Unknown deck","2026-10-27")).toBeNull();
  });

});

it("counts a colon-suffixed research commander in the same board as the printer", () => {
  const rows = listEntries("Commander:\n1 Leader\nDeck:\n99 Plains");
  expect(rows).toEqual([{ name: "Leader", qty: 1, commander: true }, { name: "Plains", qty: 99, commander: false }]);
});

it("shows a shared note's link and says what stays private", () => {
  vi.stubGlobal("location", { origin: "https://yama.ing" });
  const b: ResearchBundle = { document: { schema: "yama-research/1", id: "audit", title: "Deck review", generated_at: "2026-10-31", decks: [{ key: "energy", name: "Living Energy", commander: "Saheeli", builds: [{ id: "b3", label: "Bracket 3", list: "Commander\n1 Saheeli\nDeck\n99 Forest" }] }] }, revision: 1, updated_at: "2026-10-31", target_hashes: {}, reviews: [], visibility: "link", share_token: "0123456789abcdef01234567" };
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["research", "owner", "audit"], b);
  client.setQueryData(["sharing"], { handle: "saget", new_deck_visibility: "private", collection_public: false, share_lab_results: false, decks: { private: 0, link: 0, public: 0 } });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/decks/research/audit"]}><Routes><Route path="/decks/research/:reportId" element={<ResearchPage />} /></Routes></MemoryRouter></QueryClientProvider>);
  client.clear();
  vi.unstubAllGlobals();
  expect(html).toContain("Share this plan (anyone with the link)");
  expect(html).toContain("https://yama.ing/r/0123456789abcdef01234567");
  expect(html).toContain("Read them before sharing");
});

it("gives a build's list as the shared page's standard text", () => {
  expect(plainList("Commander\n1 Vrondiss\nDeck\n1 Sol Ring\n12 Mountain\n1 Arcane Signet (CMM) 297\n")).toBe("Commander\n1 Vrondiss\n\nDeck\n1 Arcane Signet\n12 Mountain\n1 Sol Ring\n");
});
