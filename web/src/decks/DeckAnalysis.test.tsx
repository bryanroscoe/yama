import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { DeckEntry } from "../api";
import { analysis, analysisView } from "./analysisFixture";
import { DeckAnalysisPanel, powerBracketText } from "./DeckAnalysis";

function render(view = analysisView(5.4)) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(["deck-analysis", "deck", "v2"], view);
  const cards = [{ name: "Quintorius, History Chaser", qty: 1, board: "commander" }] as DeckEntry[];
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DeckAnalysisPanel deckId="deck" versionId="v2" cards={cards} onCard={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("DeckAnalysisPanel", () => {
  it("shows the power level with its margin, label and the five vectors", () => {
    const html = render();
    expect(html).toContain("5.4");
    expect(html).toContain("±0.4");
    expect(html).toContain("Focused casual");
    for (const v of ["Speed", "Consistency", "Interaction", "Mana base", "Threats"]) expect(html).toContain(v);
    expect(html).toContain("about 40 is a typical stock precon");
    expect(html).toContain("High confidence");
    expect(html).not.toContain("·");
  });

  it("names the themes and how every card adds up, keeping a land's count", () => {
    const html = render();
    expect(html).toMatch(/11 <button[^>]*><span[^>]*>Plains<\/span><\/button> <span class="dim">6\.0<\/span>/);
    expect(html).toContain("Graveyard");
    expect(html).toContain("Core, 27 cards");
    expect(html).toContain("How it adds up");
    expect(html).toContain("Fast mana");
    expect(html).toContain("A land&#x27;s points are its quality");
  });

  it("shows power over saved versions and the configurations side by side", () => {
    const html = render();
    expect(html).toContain("Over time");
    expect(html).toContain("Version 1: 3.6. Version 2: 5.4.");
    expect(html).toContain("Configurations");
    expect(html).toContain('href="/decks/stock"');
    expect(html).toContain("This one");
  });

  it("leaves history out with one version and no configurations", () => {
    const v = analysisView(5.4);
    const html = render({ ...v, versions: v.versions.slice(0, 1), configurations: v.configurations.slice(0, 1) });
    expect(html).not.toContain("Over time");
    expect(html).not.toContain("Configurations");
  });

  it("offers to check the deck on ScryCheck", () => {
    expect(render()).toContain("Check it on ScryCheck");
  });

  it("widens the margin's explanation for cards Spellbook didn't know", () => {
    const v = analysisView(5.4);
    v.current = analysis(5.4, { confidence: "medium", margin: 0.5, combos: { checked: true, lines: [], score: 0, families: 0, compact: 0, unrecognized: 2 } });
    expect(render(v)).toContain("Commander Spellbook didn&#x27;t know 2 cards, so combos with them may be missing");
  });

  it("says why confidence is lower", () => {
    const v = analysisView(5.4);
    v.current = analysis(5.4, { confidence: "medium", margin: 0.5, combos: { checked: false, lines: [], score: 0, families: 0, compact: 0, unrecognized: 0 } });
    expect(render(v)).toContain("Medium confidence: Commander Spellbook hasn&#x27;t checked this list for combos yet");
  });
});

describe("powerBracketText", () => {
  it("places the score in a bracket's usual range and leaves the choice to the owner", () => {
    expect(powerBracketText({ power: 5.4, power_bracket: 3 })).toContain("Bracket 3's usual range (above 5, up to 7)");
    expect(powerBracketText({ power: 4.2, power_bracket: 2 })).toContain("(up to 5)");
    expect(powerBracketText({ power: 7.6, power_bracket: 4 })).toContain("yours to choose");
  });
});
