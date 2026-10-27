import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AcquisitionItem, PowerSummary, ResearchPage } from "./Research";
import { changedAnswer, money, safeUrl, targetForSwap, type ResearchBundle } from "./api";

vi.mock("../auth",()=>({useMe:()=>({data:{id:"owner"}})}));
vi.mock("../components/DeckTabs",()=>({AreaHead:({title}:{title:string})=><h1>{title}</h1>}));

function fullPage(query="") {
  const build={id:"b3",label:"Bracket 3",bracket:3,power:{range:"6–7/10",label:"Strong casual"},list:"Commander\n1 Saheeli\nDeck\n1 Thought Monitor",swaps:[{id:"monitor",card_in:"Thought Monitor",card_out:"Glimmer of Genius",why:"Repeatable artifact draw",acquisition:{kind:"print",detail:"No qualifying offer verified"}}]};
  const b:ResearchBundle={document:{schema:"yama-research/1",id:"audit",title:"Deck review",generated_at:"2026-10-27",decks:[{key:"energy",name:"Living Energy",commander:"Saheeli",recommended_build:"b3",builds:[build,{...build,id:"b4-combo-option",label:"Bracket 4 combo option",bracket:4,base_build:"b4",option_swap:{card_in:"Combat Celebrant",card_out:"Call Forth the Tempest"}}]}]},revision:1,updated_at:"2026-10-27",target_hashes:{"deck:energy":"deckhash","swap:energy:b3:monitor":"swaphash"},reviews:[{target:"deck:energy",decision:"b3",note:"Keep friends games interactive",target_hash:"deckhash",version:1,updated_at:"2026-10-27"},{target:"swap:energy:b3:monitor",decision:"want",note:null,target_hash:"swaphash",version:1,updated_at:"2026-10-27"}]};
  const client=new QueryClient({defaultOptions:{queries:{staleTime:Infinity,retry:false}}});client.setQueryData(["research","owner","audit"],b);
  const html=renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/decks/research/audit/energy${query}`]}><Routes><Route path="/decks/research/:reportId/:deckKey" element={<ResearchPage/>}/></Routes></MemoryRouter></QueryClientProvider>);client.clear();return html;
}

describe("deck research evidence", () => {
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
    const html=renderToStaticMarkup(<PowerSummary power={{range:"6–7/10",label:"Strong casual",confidence:"Low to moderate",rationale:"Needs a board and combat.",speed:"No measured win-turn data.",vulnerabilities:["Graveyard hate"]}} />);
    expect(html).toContain("6–7/10");expect(html).toContain("Needs a board and combat.");expect(html).toContain("No measured win-turn data.");expect(html).toContain("Graveyard hate");
  });
  it("detects changed and retired review targets rather than reapproving them", () => {
    const target=targetForSwap("energy","b3","monitor");expect(target).toBe("swap:energy:b3:monitor");
    const review={target,decision:"want",note:null,target_hash:"old",version:1,updated_at:"2026-10-27"};
    const b={target_hashes:{[target]:"old"}} as unknown as ResearchBundle;expect(changedAnswer(b,review)).toBe(false);
    b.target_hashes[target]="new";expect(changedAnswer(b,review)).toBe(true);delete b.target_hashes[target];expect(changedAnswer(b,review)).toBe(true);
  });
  it("shows exact swaps, retained answers and alternatives without an Apply action",()=>{
    const html=fullPage();expect(html).toContain("Living Energy");expect(html).toContain("Thought Monitor");expect(html).toContain("Glimmer of Genius");expect(html).toContain("Repeatable artifact draw");expect(html).toContain("Preferred build ✓");expect(html).toContain("Keep friends games interactive");expect(html).toContain('aria-pressed="true"');expect(html).toContain("Download list");expect(html).not.toContain(">Apply</button>");expect(html).toContain("do not apply swaps");
  });
  it("makes an optional variant’s change from base B4 explicit",()=>{
    const html=fullPage("?build=b4-combo-option");expect(html).toContain("Optional change from base Bracket 4");expect(html).toContain("Combat Celebrant");expect(html).toContain("Call Forth the Tempest");expect(html).toContain("The exact changes below compare with the current reference");
  });
});
