import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { setGuestActive } from "../guest";
import { CardHover, CardRef, CardText, cardTextParts, listenForPreviewControl, lookupPreview, previewDetailsUrl, previewPosition } from "./CardRef";

vi.mock("../api", () => ({ api: vi.fn() }));

describe("shared card references", () => {
  beforeEach(() => vi.mocked(api).mockReset());
  it("gives text references keyboard/tap controls without loading cards before interaction", () => {
    const html=renderToStaticMarkup(<CardRef name="Sol Ring"/>);
    expect(html).toContain('type="button"');expect(html).toContain('aria-label="Preview Sol Ring"');expect(html).toContain('aria-haspopup="dialog"');expect(html).toContain('data-card-name="Sol Ring"');expect(api).not.toHaveBeenCalled();
    const existing=renderToStaticMarkup(<button type="button"><CardHover name="Sol Ring"/></button>);
    expect(existing.match(/<button/g)).toHaveLength(1);
  });
  it("finds the exact local card or front face, never accepts an unrelated fuzzy hit",async()=>{
    const card={oracle_id:"a",name:"Malakir Rebirth // Malakir Mire",image_normal:"https://cards.scryfall.io/normal/a.jpg",oracle_text:"Rules"};
    vi.mocked(api).mockResolvedValue({cards:[{...card,name:"Malakir Familiar"},card]});
    expect((await lookupPreview("Malakir Rebirth"))?.oracle_id).toBe("a");
    expect(vi.mocked(api).mock.calls[0]?.[0]).toBe('/api/cards/search?q=!%22Malakir%20Rebirth%22');
    vi.mocked(api).mockResolvedValueOnce({cards:[{...card,name:"Malakir Familiar"}]}).mockResolvedValueOnce(null);
    expect(await lookupPreview("Not a real card")).toBeNull();
    expect(vi.mocked(api).mock.calls.at(-1)?.[0]).toBe('/api/cards/preview?name=Not%20a%20real%20card');
    expect(vi.mocked(api).mock.calls.every(([url])=>url.startsWith("/api/cards/"))).toBe(true);
  });
  it("signed out, previews through the guest search only",async()=>{
    const card={oracle_id:"ring",name:"Sol Ring",image_normal:"https://cards.scryfall.io/normal/ring.jpg",oracle_text:"Add two"};
    vi.mocked(api).mockResolvedValue({cards:[card]});
    setGuestActive(true);
    try {
      expect((await lookupPreview("Sol Ring","ring"))?.oracle_id).toBe("ring");
      expect(vi.mocked(api).mock.calls.map(([url])=>url)).toEqual(['/api/guest/cards/search?q=!%22Sol%20Ring%22']);
    } finally {
      setGuestActive(false);
    }
  });
  it("can preview a new public card missing from the local Oracle snapshot",async()=>{
    const fresh={oracle_id:"borg",name:"The Borg Queen",image_normal:"https://cards.scryfall.io/normal/borg.jpg",back_image_normal:null,oracle_text:"Assimilate.",type_line:"Legendary Artifact Creature",mana_cost:"{W}{U}{B}"};
    vi.mocked(api).mockResolvedValueOnce({cards:[]}).mockResolvedValueOnce(fresh);
    const card=await lookupPreview("The Borg Queen");
    expect(card).toEqual({...fresh,remote:true});
    expect(previewDetailsUrl("The Borg Queen",card)).toBe("https://scryfall.com/search?q=!%22The%20Borg%20Queen%22");
    expect(previewDetailsUrl("Sol Ring",{...fresh,name:"Sol Ring",oracle_id:"ring"})).toBe("/cards?q=!%22Sol%20Ring%22&card=ring");
    expect(vi.mocked(api).mock.calls.map(([url])=>url)).toEqual(['/api/cards/search?q=!%22The%20Borg%20Queen%22','/api/cards/preview?name=The%20Borg%20Queen']);
  });
  it("shares a lazy name lookup through the query cache",async()=>{
    vi.mocked(api).mockResolvedValue({cards:[{oracle_id:"ring",name:"Sol Ring"}]});
    const q=new QueryClient();const options={queryKey:["card-preview","sol ring"],queryFn:()=>lookupPreview("Sol Ring"),staleTime:Infinity};
    await q.fetchQuery(options);await q.fetchQuery(options);expect(api).toHaveBeenCalledTimes(1);q.clear();
  });
  it("listens to the surrounding control’s focus and preserves its existing activation",()=>{
    const listeners=new Map<string,()=>void>();let keyboard=false;const control={matches:(q:string)=>q===":focus-visible"&&keyboard,addEventListener:(n:string,f:()=>void)=>listeners.set(n,f),removeEventListener:(n:string)=>listeners.delete(n)};
    const node={parentElement:{closest:()=>control}} as unknown as HTMLElement;const open=vi.fn();const close=vi.fn();
    const cleanup=listenForPreviewControl(node,open,close);
    // Focus handed back by a closing dialog (not from the keyboard) doesn't open the preview.
    listeners.get("focus")!();expect(open).not.toHaveBeenCalled();
    keyboard=true;listeners.get("focus")!();expect(open).toHaveBeenCalledOnce();listeners.get("click")!();expect(close).toHaveBeenCalledOnce();listeners.get("blur")!();expect(close).toHaveBeenCalledTimes(2);cleanup();expect(listeners.size).toBe(0);
  });
  it("clamps previews to narrow and short viewports",()=>{
    const p=previewPosition({left:305,right:340,top:650,bottom:680},360,700);
    expect(p.left).toBeGreaterThanOrEqual(12);expect(p.left+p.width).toBeLessThanOrEqual(348);expect(p.top+p.maxHeight).toBeLessThanOrEqual(688);
    const small=previewPosition({left:2,right:20,top:2,bottom:20},180,160);expect(small.width).toBe(156);expect(small.maxHeight).toBe(136);
  });
  it("annotates complete known names in guide prose and escapes supplied HTML",()=>{
    const text="Sol Ring and The One Ring work. Sol Rings is not that name.";
    expect(cardTextParts(text,["Ring","Sol Ring","The One Ring"]).filter((p)=>p.card).map((p)=>p.card)).toEqual(["Sol Ring","The One Ring"]);
    const html=renderToStaticMarkup(<CardText text={'<script>x</script> Sol Ring'} names={["Sol Ring"]}/>);
    expect(html).toContain("&lt;script&gt;");expect(html).toContain('data-card-name="Sol Ring"');expect(html).not.toContain("<script>");
  });
});
