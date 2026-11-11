import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CardInDecksView, checkedSpan, deckUseWords, type CardInDecksData, type DeckCombo } from "./CardInDecks";

const combo = (over: Partial<DeckCombo> = {}): DeckCombo => ({
  id: "1-2", cards: ["Sol Ring", "Dramatic Reversal"], templates: [], results: ["Infinite colorless mana"], definitely_two_card: true, arguably_two_card: true,
  mana_needed: null, flags: [], bracket_tag: null, deck_id: "d2", deck_name: "Atraxa", checked_at: "2026-11-01T00:00:05Z", ...over,
});
const data: CardInDecksData = {
  decks: [
    { deck_id: "d2", name: "Atraxa", configuration: null, qty: 1, board: "main" },
    { deck_id: "d/3", name: "Omo", configuration: "stock", qty: 1, board: "commander" },
  ],
  combos: [combo()],
};
const view = (d: CardInDecksData) => renderToStaticMarkup(<MemoryRouter><CardInDecksView data={d} /></MemoryRouter>);

describe("a card's place in your decks", () => {
  it("links each deck that runs it and says how", () => {
    const html = view(data);
    expect(html).toContain("In your decks");
    expect(html).toMatch(/<a [^>]*href="\/decks\/d2"[^>]*>Atraxa<\/a><span class="cp-deck-use">main deck<\/span>/);
    expect(html).toMatch(/<a [^>]*href="\/decks\/d%2F3"[^>]*>Omo \(stock\)<\/a><span class="cp-deck-use">its commander<\/span>/);
    expect(deckUseWords({ qty: 3, board: "main" })).toBe("3 in the main deck");
    expect(deckUseWords({ qty: 1, board: "side" })).toBe("sideboard");
    expect(deckUseWords({ qty: 2, board: "side" })).toBe("2 in the sideboard");
    expect(deckUseWords({ qty: 2, board: "commander" })).toBe("its commander");
  });

  it("lists the combos it is part of, with the deck, the source and when they were found", () => {
    const html = view(data);
    expect(html).toContain("Combos with it in your decks");
    expect(html).toContain("Sol Ring + Dramatic Reversal");
    expect(html).toContain("Infinite colorless mana");
    expect(html).toMatch(/In <a [^>]*href="\/decks\/d2"[^>]*>Atraxa<\/a>/);
    // Credited and linked, as Commander Spellbook asks, and dated: it is that day's answer.
    expect(html).toContain('href="https://commanderspellbook.com/combo/1-2/"');
    expect(html).toMatch(/Combos from <a href="https:\/\/commanderspellbook.com\/"[^>]*>Commander Spellbook<\/a>, found in these decks&#x27; lists when each was last checked \(Nov 1\)/);
    expect(checkedSpan([combo(), combo({ checked_at: "2026-11-09T10:00:00Z" })])).toBe("Nov 1 to Nov 9");
    // A requirement that isn't a named card, and a long list of results.
    const long = view({ ...data, combos: [combo({ templates: ["A creature that taps for mana"], results: ["a", "b", "c", "d", "e"] })] });
    expect(long).toContain("Sol Ring + Dramatic Reversal, plus a creature that taps for mana");
    expect(long).toContain("a, b, c, d, and more");
  });

  it("draws nothing when no deck runs the card, and no combo heading without combos", () => {
    expect(view({ decks: [], combos: [] })).toBe("");
    const html = view({ ...data, combos: [] });
    expect(html).toContain("In your decks");
    expect(html).not.toContain("Combos");
    expect(html).not.toContain("Commander Spellbook");
  });
});
