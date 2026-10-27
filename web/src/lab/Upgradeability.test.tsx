import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpgradeabilitySection, UpgradeabilitySummary } from "./Upgradeability";
import { sortPrecons } from "./logic";
import type { PreconItem, Upgradeability } from "./api";

const value: Upgradeability = {
  score: 5, label: "Exceptional", status: "reviewed", effort: "Substantial",
  path: "Replace secondary creature themes with spell-trigger payoffs.", limitation: "Commander removal stops the damage engine.",
  assessed_on: "2026-10-27", source_url: "https://mtgjson.com/api/v5/decks/Test.json",
  method: "source-backed-upgradeability-v2", basis: "Yama judgment; no upgrade win-rate estimate.", rubric: "Ordinal grades; missing evidence is ungraded.",
  levels: [{score:1,label:"Minimal",meaning:"A limiting mechanism remains."},{score:5,label:"Exceptional",meaning:"Repeatable resources and a direct finish."}],
  rationale: {support:"Spells provide interaction.",payoff:"Damage repeats on qualifying casts.",constraints:"Mana value three or more."},
  examples: [{name:"Curiosity",role:"Damage-to-draw payoff",url:"https://scryfall.com/card/test",oracle_id:"example",legal_checked_on:"2026-10-27",basis:"Named in the linked upgrade guide"}],
  sources:[{title:"Guide",author:"Named author",publisher:"Publisher",published_on:"2025-06-16",checked_on:"2026-10-27",accessed_on:"2026-10-26",url:"https://example.com/guide",summary:"Describes spell upgrades.",kind:"upgrade_guide",rating:"B",commander_configurations:[["Example"]]}],
  commander_cards:[],commander_results:[{name:"Example",url:"https://playgroup.gg/commanders/1",api_url:"https://playgroup.gg/api/public/v1/commanders/1.json",games:10,wins:3,raw_win_rate_percent:30,fetched_at:"2026-10-27T12:00:00Z",provider_updated_at:null,population:"Mixed lists"}],
  commander_caveat:"Raw rates mix stock and modified lists and pod sizes. No upgrade gain can be inferred.",attribution:"Playgroup.gg CC BY 4.0",gap:null,
};
describe("upgradeability evidence", () => {
  it("shows reasons, review grades, commander counts and the level meanings separately", () => {
    const html=renderToStaticMarkup(<UpgradeabilitySection value={value} />);
    for (const text of ["5/5", "Substantial changes", value.path!, value.assessed_on!,value.rationale!.constraints,"Curiosity","Publisher’s overall review grade","Named author","2025-06-16","2026-10-27","Commander results","30.0% raw wins (3 / 10 games)","small sample","What 1–5 means","Minimal","Exceptional",value.commander_caveat]) expect(html).toContain(text);
    expect(html).not.toContain("Provisional");
  });
  it("keeps a missing grade distinct from zero and still shows the available sources", () => {
    expect(renderToStaticMarkup(<UpgradeabilitySummary />)).toContain("Ungraded");
    const html=renderToStaticMarkup(<UpgradeabilitySection value={{...value,score:null,status:"insufficient_evidence",label:"Ungraded",rationale:null,examples:[],gap:"Guide changes commander."}} />);
    expect(html).toContain("Guide changes commander.");expect(html).toContain("Commander results");expect(html).toContain("Named author");
    expect(html).not.toContain("5/5");expect(html).not.toContain("0/5");expect(html).not.toContain(value.path!);
  });
  it("withdraws legacy grades even in an offline catalog cache", () => {
    const legacy={...value,method:"editorial-upgradeability-v1"};
    expect(renderToStaticMarkup(<UpgradeabilitySummary value={legacy} />)).toContain("Needs refreshed evidence");
    const html=renderToStaticMarkup(<UpgradeabilitySection value={legacy} />);
    expect(html).toContain("unsupported grades have been withdrawn");expect(html).not.toContain("5/5");
  });
  it("does not display a zero-game observation as a zero win rate", () => {
    const html=renderToStaticMarkup(<UpgradeabilitySection value={{...value,commander_results:[{...value.commander_results[0]!,games:0,wins:0,raw_win_rate_percent:null}]}} />);
    expect(html).toContain("No recorded games");expect(html).not.toContain("0.0% raw");
  });
  it("does not rank a retired cached grade", () => {
    const rows=[{name:"Retired",upgradeability:{...value,method:"editorial-upgradeability-v1"}},{name:"Current",upgradeability:{...value,score:3}}] as PreconItem[];
    expect(sortPrecons(rows,"upgradeability",true).map(x=>x.name)).toEqual(["Current","Retired"]);
  });
  it("sorts grades independently of strength and leaves ungraded lists last", () => {
    const rows=[{name:"Ungraded"},{name:"Broad",upgradeability:{...value,score:4}},{name:"Exceptional",upgradeability:value}] as PreconItem[];
    expect(sortPrecons(rows,"upgradeability",true).map(x=>x.name)).toEqual(["Exceptional","Broad","Ungraded"]);
    expect(sortPrecons(rows,"upgradeability",false).map(x=>x.name)).toEqual(["Broad","Exceptional","Ungraded"]);
  });
});
