import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { DeckCheck, DeckEntry, DeckView } from "../api";
import { analysis, analysisView } from "./analysisFixture";
import { confidenceText, DeckStatsTab, PowerDial } from "./DeckStatsTab";

const entry = (name: string, cmc: number, type_line: string, mana_cost: string, board = "main", qty = 1, produced: string | null = null) =>
  ({ name, qty, board, oracle_id: name, produced_mana: produced, card: { cmc, type_line, mana_cost, image_small: `https://img/${encodeURIComponent(name)}.jpg`, image_normal: null } }) as unknown as DeckEntry;

const cards = [
  entry("Quintorius, History Chaser", 5, "Legendary Creature", "{3}{R}{W}", "commander"),
  entry("Sol Ring", 1, "Artifact", "{1}"),
  entry("Swords to Plowshares", 1, "Instant", "{W}"),
  entry("Sun Titan", 6, "Creature", "{4}{W}{W}"),
  entry("Plains", 0, "Basic Land", "", "main", 11, "W"),
  entry("Mountain", 0, "Basic Land", "", "main", 10, "R"),
];

const deck = {
  id: "deck",
  version_id: "v2",
  bracket: 3,
  cards,
  configurations: [],
  game_changers: [],
  game_changers_as_of: "2026-11-01",
  reserved_list: null,
  reserved_list_as_of: null,
  validation: { ok: true, warnings: [], errors: [] },
  ownership: { cards: 25, owned: 25, needed: 0, needed_cost_usd: 0, needed_without_price: 0, proxies: 0 },
  singles_value: undefined,
} as unknown as DeckView;

const check: DeckCheck = {
  enabled: true, version_id: "v2", source: "Commander Spellbook", source_url: "https://commanderspellbook.com/",
  pending: false, retrying: false, next_try_at: null, error: null, gave_up: false, archived: false, requested_at: "2026-11-01T00:00:00Z",
  result: {
    checked_at: "2026-11-01T00:00:00Z", bracket_tag: "C", bracket_label: "Core", bracket: 2,
    game_changers: [], mld: [], extra_turns: [], unrecognized: [],
    combos: [
      { id: "1-2", cards: ["Sun Titan", "Sol Ring"], templates: ["A sacrifice outlet"], results: ["Infinite ETB"], definitely_two_card: false, arguably_two_card: true, mana_needed: null, flags: [], bracket_tag: null },
    ],
  },
} as DeckCheck;

function render(view = analysisView(5.4)) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, enabled: false } } });
  client.setQueryData(["deck-analysis", "deck", "v2"], view);
  client.setQueryData(["deck-check", "deck", "v2"], check);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DeckStatsTab deck={deck} onCard={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("DeckStatsTab", () => {
  it("shows the power level on a dial with its margin, what it plays like and how complete the inputs were", () => {
    const html = render();
    expect(html).toContain('aria-label="Power 5.4 of 10, give or take 0.7, in Bracket 3&#x27;s usual range"');
    expect(html).toContain("<b>5.4</b>");
    expect(html).toContain("±0.7");
    expect(html).toContain("Plays like Bracket 2 to 3");
    expect(html).toContain("Focused casual");
    expect(html).toContain("Every card read");
    expect(html).toContain('aria-label="Help: how power is measured"');
    expect(html).not.toContain("·");
  });

  it("draws the five scores as bars with the stock, Bracket 4 and cEDH marks, and Compare with", () => {
    const html = render();
    for (const v of ["Speed", "Consistency", "Interaction", "Mana base", "Threats"]) expect(html).toContain(`<b>${v}</b>`);
    expect(html.match(/class="vector"/g)).toHaveLength(5);
    for (const left of ["40%", "75%", "95%"]) expect(html).toContain(`class="mark" style="left:${left}"`);
    expect(html).toContain("40 a stock precon");
    expect(html).toContain('aria-label="Compare with"');
    for (const r of ["Nothing", "Stock", "Bracket 4", "cEDH"]) expect(html).toContain(`>${r}</button>`);
  });

  it("opens on the first score with the cards behind it and their points", () => {
    const html = render();
    expect(html).toMatch(/aria-pressed="true"[^>]*><span class="vector-name"><b>Speed<\/b>/);
    expect(html).toContain("Speed 51");
    expect(html).toContain("1 card counts toward it");
    expect(html).toContain("Fast mana");
    expect(html).toContain(">Sol Ring</button>");
    expect(html).toContain('<b class="point-num">9</b>');
  });

  it("says what holds the score down under the dial", () => {
    const v = analysisView(7.4);
    v.current = analysis(7.4, { caps: [{ at: 7, reason: "mana", note: "A weak mana base holds it at 7" }] });
    const html = render(v);
    expect(html).toContain("Holding it down");
    expect(html).toContain("A weak mana base holds it at 7");
  });

  it("shows the curve, color balance and themes open, with card pictures", () => {
    const html = render();
    expect(html).toContain("Mana curve");
    expect(html).toContain("Color balance");
    expect(html).toContain("Average");
    expect(html).toContain("5 or more");
    expect(html).toContain("White");
    expect(html).toContain("Graveyard");
    expect(html).toContain("Core, 27 cards");
    expect(html).toContain('src="https://img/Sun%20Titan.jpg"');
  });

  it("joins a combo's cards with + and leaves a dashed slot for what it also needs", () => {
    const html = render();
    expect(html).toContain("Two cards and a setup");
    expect(html).toMatch(/<span class="plus" aria-hidden="true">\+<\/span>/);
    expect(html).toContain('class="combo-pic slot">A sacrifice outlet');
    expect(html).toContain("Infinite ETB");
    expect(html).toContain('href="https://commanderspellbook.com/combo/1-2/"');
  });

  it("keeps the bracket panel open: no folds for its explanation, guide or combos", () => {
    const html = render();
    expect(html).toContain('id="bracket-head"');
    expect(html).toContain('aria-label="Help: bracket"');
    expect(html).not.toContain("<summary>Why this suggestion?</summary>");
    expect(html).not.toContain("<summary>How Commander brackets work</summary>");
    expect(html).not.toContain("Combos with more pieces");
  });

  it("shows power over saved versions and the lists side by side", () => {
    const html = render();
    expect(html).toContain("Power over time");
    expect(html).toContain("Version 1: 3.6. Version 2: 5.4.");
    expect(html).toContain('href="/decks/stock"');
    expect(html).toContain("This one");
  });

  it("leaves power over time out with one version and one list", () => {
    const v = analysisView(5.4);
    expect(render({ ...v, versions: v.versions.slice(0, 1), configurations: v.configurations.slice(0, 1) })).not.toContain("Power over time");
  });

  it("offers to check the deck on ScryCheck", () => {
    expect(render()).toContain("Check it on ScryCheck");
  });
});

describe("PowerDial", () => {
  it("marks the margin and lights the band the score is in", () => {
    const html = renderToStaticMarkup(<PowerDial analysis={{ power: 7.5, margin: 0.4, power_bracket: 4 }} />);
    expect(html).toContain('class="band b4 here"');
    expect(html).toContain('class="band b3"');
    expect(html).toContain('class="margin"');
    for (const t of [1, 5, 7, 10]) expect(html).toContain(`>${t}</text>`);
  });

  it("draws no margin arc for a zero margin", () => {
    expect(renderToStaticMarkup(<PowerDial analysis={{ power: 3, margin: 0, power_bracket: 2 }} />)).not.toContain('class="margin"');
  });
});

describe("confidenceText", () => {
  it("says why confidence is lower", () => {
    const a = analysis(5.4, { confidence: "medium", combos: { checked: false, lines: [], score: 0, families: 0, compact: 0, unrecognized: 0 } });
    expect(confidenceText(a)).toContain("Some inputs missing: Commander Spellbook hasn't checked this list for combos yet");
  });

  it("names cards Spellbook didn't know", () => {
    const a = analysis(5.4, { combos: { checked: true, lines: [], score: 0, families: 0, compact: 0, unrecognized: 2 } });
    expect(confidenceText(a)).toContain("Commander Spellbook didn't know 2 cards, so combos with them may be missing");
  });
});
