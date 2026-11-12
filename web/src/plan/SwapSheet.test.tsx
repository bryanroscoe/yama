import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SheetThumbnail, SwapSheetPage } from "./SwapSheet";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import type { PlanView } from "./view";
import type { PlanDeck } from "@yama/core/plan";

vi.mock("./PlanLayout", async (original) => ({
  ...await original<typeof import("./PlanLayout")>(),
  PlansHead: () => null,
}));

describe("swap-sheet pictures", () => {
  it("loads pictures for every printed page, including rows never scrolled into view", () => {
    const html = renderToStaticMarkup(<SheetThumbnail name="Brainstorm" card={{ image_small: "https://cards.scryfall.io/thumb.webp" }} />);
    expect(html).toContain('loading="eager"');
    expect(html).not.toContain('loading="lazy"');
    expect(html).toContain('data-print-card="Brainstorm"');
  });

  it("uses the full card when a saved bundle has no thumbnail URL", () => {
    const html = renderToStaticMarkup(<SheetThumbnail name="Brainstorm" card={{ image_small: null, image_normal: "https://cards.scryfall.io/card.webp" }} />);
    expect(html).toContain('<img');
    expect(html).toContain('src="https://cards.scryfall.io/card.webp"');
  });
});

// Render the selected sheet through its actual route context, without API calls or private data.
function selectedSheet(query = "", extraDecks = false) {
  const deck: PlanDeck = {
    key: "test", name: "Test deck", status: "active", commander: [], sort: 0,
    source: "import", product: null, color_identity: null, owner_changes: [], bracket: null, groups: [], notes: [], deck_id: null, updated_at: "",
    states: {
      now: { id: "now", content_hash: "", computed_by: "test", updated_at: "", log: [], unresolved: [], cards: [{ name: "Old card", qty: 1, board: "main" }] },
      after: { id: "after", content_hash: "", computed_by: "test", updated_at: "", log: [], unresolved: [], cards: [{ name: "New card", qty: 1, board: "main", kind: "print", replaces: "Old card", swap: "swap" }] },
    },
  };
  const decks = extraDecks ? [deck, { ...deck, key: "second", name: "Second deck" }, { ...deck, key: "third", name: "Third deck" }] : [deck];
  const view = {
    b: { decks, swaps: [{ key: "swap", deck: deck.key, stage: "planned", in: "New card", out: "Old card", why: "Adds card draw.", why_out: "Costs too much mana." }], marks: {}, names: {}, cards: {} },
    markBy: new Map(),
    deck: (key: string) => decks.find((d) => d.key === key),
    card: () => ({ image_small: "https://cards.scryfall.io/test.webp" }),
    oracleId: () => undefined,
    answers: new Map(),
    planOf: () => ({ state: "in_progress" }),
  } as unknown as PlanView;
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/sheet${query}`]}><Routes>
      <Route element={<Outlet context={{ view }} />}><Route path="sheet" element={<SwapSheetPage />} /></Route>
    </Routes></MemoryRouter>,
  );
}

describe("choosing what goes on a swap sheet", () => {
  it("can print only the sorting checklist, without deck tables or instructions", () => {
    const html = selectedSheet("?omit=instructions,swaps");
    expect(html).toContain('class="ss-sort"');
    expect(html).not.toContain('class="ss-deck"');
    expect(html).not.toContain('class="ss-how"');
  });

  it("can print deck tables with reasons and no pictures", () => {
    const html = selectedSheet("?omit=instructions,sort,pictures&reasons=1");
    expect(html).toContain('ss-decks-only');
    expect(html).toContain('class="ss-deck"');
    expect(html).not.toContain('class="ss-sort"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('class="no-print ss-why"');
    expect(html).toContain('Adds card draw.');
    expect(html).toContain('Costs too much mana.');
  });

  it("applies picture and reason choices to the alphabetical takeout sheet too", () => {
    const html = selectedSheet("?sheet=alphabetical&omit=pictures&reasons=1");
    expect(html).toContain('class="ss-takeouts"');
    expect(html).not.toContain('<img');
    expect(html).toContain('Costs too much mana.');
    expect(html).toContain('spares box');
  });

  it("prints each reason in its own card's column in the full sheet", () => {
    const html = selectedSheet("?omit=instructions,sort,pictures&reasons=1");
    const cells = html.split('class="ss-steps"')[1]!.split("<tbody>")[1]!.split("</tbody>")[0]!.match(/<td[\s\S]*?<\/td>/g)!;
    expect(cells[1]).toContain("Adds card draw.");
    expect(cells[1]).not.toContain("Costs too much mana.");
    expect(cells[2]).toContain("Costs too much mana.");
    expect(cells[2]).not.toContain("Adds card draw.");
  });

  it("keeps cut and add reasons with their cards in the reversed takeout layout", () => {
    const html = selectedSheet("?sheet=alphabetical&omit=pictures&reasons=1");
    const cells = html.split('class="ss-takeouts"')[1]!.split("<tbody>")[1]!.split("</tbody>")[0]!.match(/<td[\s\S]*?<\/td>/g)!;
    expect(cells[1]).toContain("Costs too much mana.");
    expect(cells[1]).not.toContain("Adds card draw.");
    expect(cells[3]).toContain("Adds card draw.");
    expect(cells[3]).not.toContain("Costs too much mana.");
  });

  it("prints any deck subset with matching sorting copy counts", () => {
    const html = selectedSheet("?deck=test&deck=second&deckScope=selected", true);
    const printed = html.split('<h1 class="print-only">')[1]!;
    expect(html).toContain("Decks to print (2 of 3)");
    expect(printed).toContain("Test deck");
    expect(printed).toContain("Second deck");
    expect(printed).not.toContain("Third deck");
    expect(printed).toContain('class="num">2</td>');
  });

  it("filters alphabetical takeouts by the same subset", () => {
    const html = selectedSheet("?sheet=alphabetical&deck=test&deck=second", true);
    const printed = html.split('<h1 class="print-only">')[1]!;
    expect(printed).toContain("Test deck");
    expect(printed).toContain("Second deck");
    expect(printed).not.toContain("Third deck");
    expect(printed.match(/class="ss-tick"/g)).toHaveLength(2);
  });

  it("preserves old single-deck links and distinguishes clearing all decks", () => {
    const one = selectedSheet("?deck=test", true);
    expect(one).toContain("Decks to print (1 of 3)");
    expect(one.split('<h1 class="print-only">')[1]).not.toContain("Second deck");
    const none = selectedSheet("?deckScope=selected", true);
    expect(none).toContain("Decks to print (0 of 3)");
    expect(none).toContain("Choose at least one deck to print.");
    expect(none).toMatch(/<button type="button" disabled="" aria-busy="false">Print<\/button>/);
    expect(none).not.toContain('class="ss-steps"');
    expect(selectedSheet("", true)).toContain("Decks to print (3 of 3)");
  });

  it("disables Print when every full-sheet section is omitted", () => {
    const html = selectedSheet("?omit=instructions,sort,swaps");
    expect(html).toMatch(/<button type="button" disabled="" aria-busy="false">Print<\/button>/);
    expect(html).toContain('Choose at least one section to print.');
    expect(html).not.toContain('class="ss-sort"');
    expect(html).not.toContain('class="ss-deck"');
  });
});
