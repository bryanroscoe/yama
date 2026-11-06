import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { Bracket, PlanDeck } from "@yama/core/plan";
import { SwapCardsPage } from "./SwapCards";
import type { PlanView } from "./view";

vi.mock("./PlanLayout", async (original) => ({
  ...await original<typeof import("./PlanLayout")>(),
  PlansHead: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

const deck = (key: string, bracket: Bracket | null, extra: Partial<PlanDeck> = {}): PlanDeck => ({
  key, name: `${key[0]!.toUpperCase()}${key.slice(1)} deck`, sort: 0, source: "import", status: "active", product: null, commander: ["Quintorius, History Chaser"],
  color_identity: null, owner_changes: [], bracket, groups: [], notes: [], deck_id: null, updated_at: "", states: {}, ...extra,
});
const lorehold = deck("lorehold", {
  target: 3, box: 2,
  bags: { "3": [], "2": [{ out: "Teferi's Protection", in: "Clever Concealment" }, { out: "The One Ring", in: "Thrilling Discovery" }] },
  extras: ["Smothering Tithe", "Esper Sentinel"],
});
const riders = deck("riders", { target: 4, bags: { "3": [{ out: "Rhystic Study", in: "Call for Aid" }], "2": [] } });

function page(query: string, decks: PlanDeck[]) {
  const view = {
    b: { decks, head: { guide_version: 27 }, game_changers: { checked_on: "2026-10-09", source: "test", names: ["Teferi's Protection", "The One Ring", "Smothering Tithe", "Rhystic Study"] } },
    deck: (key: string) => decks.find((d) => d.key === key),
  } as unknown as PlanView;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/cards${query}`]}><Routes>
      <Route element={<Outlet context={{ view }} />}><Route path="cards" element={<SwapCardsPage />} /></Route>
    </Routes></MemoryRouter>,
  );
}

describe("bracket swap cards page", () => {
  it("prints every deck's card with the box bracket, each step down, Game Changers and extras", () => {
    const html = page("", [lorehold, riders, deck("plain", null)]);
    expect(html).toContain("<h1>Swap cards</h1>");
    expect(html.match(/class="sc-card"/g)).toHaveLength(2);
    expect(html).toContain("In the box: Bracket 2. Going up, do the swaps in reverse.");
    expect(html).toContain("In the box: Bracket 4. Going up, do the swaps in reverse.");
    expect(html).toContain("Bracket 3 → 2");
    expect(html).toContain("Bracket 4 → 3");
    expect(html).not.toContain("Bracket 3 → 3");
    expect(html).toContain(`Teferi&#x27;s Protection\u00a0<abbr class="sc-gc" title="Game Changer">GC</abbr>`);
    expect(html).toContain("Bracket 4 extras (not in any build)");
    expect(html).toMatch(/Smothering Tithe\u00a0<abbr class="sc-gc"[^>]*>GC<\/abbr><\/span><span>, Esper Sentinel<\/span>/);
    expect(html).toContain("GC = Game Changer. Guide v27.");
    expect(html).not.toContain("Plain deck");
  });

  it("shows one deck's card from its own link, with the way back", () => {
    const html = page("?deck=lorehold", [lorehold, riders]);
    expect(html).toContain("<h1>Lorehold deck swap card</h1>");
    expect(html.match(/class="sc-card"/g)).toHaveLength(1);
    expect(html).toContain('href="/decks/plans/lorehold?tab=brackets"');
    expect(html).toContain('href="/decks/plans/get/swap-cards"');
    expect(html).not.toContain("Riders deck");
  });

  it("lays out nine cards to a printed page", () => {
    const decks = [...Array(10).keys()].map((i) => deck(`deck${i}`, { target: 3 }));
    const html = page("", decks);
    const pages = html.split('class="sc-page"').slice(1);
    expect(pages.map((p) => p.match(/class="sc-card"/g)?.length)).toEqual([9, 1]);
    expect(html).toContain("No bracket swaps.");
  });

  it("says why there is nothing to print", () => {
    expect(page("?deck=plain", [deck("plain", null)])).toContain("This plan has no bracket swaps.");
    expect(page("?deck=gone", [lorehold])).toContain("There&#x27;s no plan deck called &quot;gone&quot;");
    const none = page("", [deck("plain", null)]);
    expect(none).toContain("None of your plan decks has bracket swaps yet.");
    expect(none).toMatch(/<button class="primary" disabled="">Print<\/button>/);
  });
});

describe("swap card print CSS", () => {
  const css = readFileSync(new URL("./swapcards.css", import.meta.url), "utf8");
  const source = readFileSync(new URL("./SwapCards.tsx", import.meta.url), "utf8");
  const print = css.slice(css.indexOf("@media print"));

  it("prints cards at exactly 2.5 by 3.5 inches, three by three, inside the page's margins", () => {
    expect(print).toMatch(/grid-template-columns: repeat\(3, 2\.5in\)/);
    expect(print).toMatch(/grid-auto-rows: 3\.5in/);
    // Every card size is in em, and 1em is 0.1 inch on paper.
    expect(css).toMatch(/\.sc-card \{[^}]*width: 25em;[^}]*height: 35em;/);
    expect(print).toMatch(/\.sc-card \{[^}]*font-size: 0\.1in;/);
    for (const rule of [css.match(/@page swap-cards \{[^}]*\}/)![0], source.match(/@page \{[^}]*\}/)![0]]) {
      expect(rule).toContain("size: letter");
      const margin = Number(rule.match(/margin: ([\d.]+)in/)![1]);
      expect(3 * 2.5 + 2 * margin).toBeLessThanOrEqual(8.5);
      expect(3 * 3.5 + 2 * margin).toBeLessThanOrEqual(11);
    }
  });

  it("leaves the app's navigation and footer off the paper, and breaks a page after every nine", () => {
    expect(print).toContain("body:has(.sc-sheet) :not(:has(.sc-sheet)):not(.sc-sheet):not(.sc-sheet *) {\n    display: none !important;");
    // swapsheet.css hides every element in the app on paper; the cards must win over that.
    expect(readFileSync(new URL("./swapsheet.css", import.meta.url), "utf8")).toContain("body * {\n    visibility: hidden;");
    expect(print).toContain(".sc-sheet,\n  .sc-sheet * {\n    visibility: visible !important;");
    expect(print).toMatch(/\.sc-page \{[^}]*break-after: page;/);
    expect(print).toMatch(/\.sc-page:last-child \{\s*break-after: auto;/);
  });
});
