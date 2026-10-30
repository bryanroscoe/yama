import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SwapFace } from "./BuildChoices";
import { duplexPages, type BuildChoice } from "./buildCatalog";

const from: BuildChoice = { id: "a", label: "[2] Plan", kind: "bracket", list: "", source: "Plan v27", href: "/", warnings: [] };
const to: BuildChoice = { ...from, id: "b", label: "[3] Plan" };
const change = { out: { name: "Clever Concealment", board: "main" as const }, in: { name: "Teferi's Protection", board: "main" as const } };
describe("duplex card content", () => {
  it("renders full card names with previews, exact directions, part number and source", () => {
    const pages = duplexPages([change]);
    const front = renderToStaticMarkup(<SwapFace face={pages[0]![0]!} name="Lorehold Spirit" from={from} to={to} parts={1} versions={[]} />);
    const back = renderToStaticMarkup(<SwapFace face={pages[1]![2]!} name="Lorehold Spirit" from={from} to={to} parts={1} versions={[]} />);
    expect(front).toContain("[2] Plan → [3] Plan");
    expect(back).toContain("[3] Plan → [2] Plan");
    expect(front).toContain("Front · Part 1 of 1");
    expect(back).toContain("Back · Part 1 of 1");
    expect(front.indexOf("Clever Concealment")).toBeLessThan(front.indexOf("Teferi"));
    expect(back.indexOf("Teferi")).toBeLessThan(back.indexOf("Clever Concealment"));
    expect(front).toContain('class="card-ref"');
    expect(front).toContain("Plan v27");
  });
});
