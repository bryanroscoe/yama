import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpgradeabilitySection, UpgradeabilitySummary } from "./Upgradeability";
import { sortPrecons } from "./logic";
import type { PreconItem, Upgradeability } from "./api";

const value: Upgradeability = {
  score: 5, label: "Very high", status: "provisional", effort: "Substantial",
  path: "Focus spells and repeatable life loss.", limitation: "Refocus conflicting packages.",
  assessed_on: "2026-10-27", source_url: "https://mtgjson.com/api/v5/decks/Test.json",
  method: "editorial-upgradeability-v1", basis: "Editorial, not a predicted win rate.", rubric: "1 Limited to 5 Very high; effort is not spending.",
};
describe("upgradeability evidence", () => {
  it("shows potential and effort separately, with date, basis and stock evidence", () => {
    const html=renderToStaticMarkup(<UpgradeabilitySection value={value} />);
    for (const text of ["5/5", "Substantial work", "Provisional", value.path!, value.limitation!, value.assessed_on!, value.source_url!, value.basis, value.rubric]) expect(html).toContain(text);
  });
  it("does not turn missing or stale evidence into a zero or inherit a score", () => {
    expect(renderToStaticMarkup(<UpgradeabilitySummary />)).toContain("Not assessed");
    const html=renderToStaticMarkup(<UpgradeabilitySection value={{...value,score:null,status:"stock_list_changed",label:"Needs reassessment",path:null}} />);
    expect(html).toContain("new assessment is needed");
    expect(html).not.toContain("5/5");expect(html).not.toContain("0/5");expect(html).not.toContain(value.path!);
  });
  it("sorts editorial potential independently of simulated strength and always leaves missing last", () => {
    const rows=[{name:"Missing"},{name:"High",upgradeability:{...value,score:4}},{name:"Very high",upgradeability:value} ] as PreconItem[];
    expect(sortPrecons(rows,"upgradeability",true).map(x=>x.name)).toEqual(["Very high","High","Missing"]);
    expect(sortPrecons(rows,"upgradeability",false).map(x=>x.name)).toEqual(["High","Very high","Missing"]);
  });
});
