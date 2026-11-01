import { describe, expect, it } from "vitest";
import type { Build } from "./api";
import { isOwnedBuild, ownedBuildProblems } from "./availability";
import { buildFamilies, buildTargets } from "../decks/buildCatalog";
import type { ResearchBundle } from "./api";
const valid = (): Build => ({ id: "b2", label: "Buildable now", bracket: 2, list: "Commander\n1 Leader\nDeck\n99 Plains", acquisition: { track: "owned_now", scenario: "reserve", owned: [{ card: "Leader", kind: "arrived_print", qty: 1 }], basics: [{ card: "Plains", kind: "basic", qty: 99 }], buys: [], prints: [] }, accounting: { total: 100, commander: 1, main: 99, basics: 99, nonbasic: 1, unchanged: 100, added: 0, removed: 0, owned: 1, local_buys: 0, prints: 0 } });
describe("owned-build evidence", () => {
  it("accepts an exact allocated owned supply including arrived prints and counted basics", () => { expect(isOwnedBuild(valid())).toBe(true); });
  it.each([
    ["prospective", (b: Build) => { b.prospective = true; }],
    ["buy", (b: Build) => { b.acquisition!.buys = [{ card: "Leader" }]; }],
    ["print", (b: Build) => { b.acquisition!.prints = [{ card: "Leader" }]; }],
    ["sealed", (b: Build) => { b.acquisition!.sealed_purchases = [{ card: "Precon" }]; }],
    ["projected", (b: Build) => { b.accounting!.projected_stock = 1; }],
    ["future supply", (b: Build) => { b.acquisition!.owned![0]!.kind = "future_stock"; }],
    ["missing accounting", (b: Build) => { delete b.accounting; }],
    ["missing scenario", (b: Build) => { delete b.acquisition!.scenario; }],
    ["wrong card", (b: Build) => { b.acquisition!.owned![0]!.card = "Other"; }],
    ["missing copy", (b: Build) => { b.acquisition!.basics![0]!.qty = 98; }],
  ] as const)("keeps %s contradictions out of Buildable now", (_name, mutate) => {
    const b = valid(); mutate(b); expect(isOwnedBuild(b)).toBe(false); expect(ownedBuildProblems(b).length).toBeGreaterThan(0);
    const report = { document: { id: "audit", title: "Audit", decks: [{ key: "deck", name: "Deck", builds: [b] }] }, revision: 1, updated_at: "2026-10-30" } as ResearchBundle;
    const choices = buildFamilies([report], undefined, [])[0]!.choices;
    expect(buildTargets(choices, "owned_now")).toEqual([]);
    expect(choices[0]!.label).toContain("Ownership not verified");
  });
});
