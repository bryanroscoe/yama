import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CardInDecksView, checkedSpan, deckUseWords, groupDecks, templateWords, type CardInDecksData, type DeckCombo, type DeckUse } from "./CardInDecks";

const combo = (over: Partial<DeckCombo> = {}): DeckCombo => ({
  id: "1-2", cards: ["Sol Ring", "Dramatic Reversal"], templates: [], results: ["Infinite colorless mana"], definitely_two_card: true, arguably_two_card: true,
  mana_needed: null, flags: [], bracket_tag: null, decks: [{ deck_id: "d2", name: "Atraxa" }], checked_at: "2026-11-01T00:00:05Z", ...over,
});
const data: CardInDecksData = {
  decks: [
    { deck_id: "d2", name: "Atraxa", qty: 1, board: "main", checked: true },
    // A configuration's name already carries its label.
    { deck_id: "d/3", name: "Omo (stock)", qty: 1, board: "commander", checked: true },
  ],
  combos: [combo()],
  more_combos: 0,
};
const view = (d: CardInDecksData) => renderToStaticMarkup(<MemoryRouter><CardInDecksView data={d} /></MemoryRouter>);

describe("a card's place in your decks", () => {
  it("links each deck that runs it and says how", () => {
    const html = view(data);
    expect(html).toContain("In your decks");
    expect(html).toMatch(/<a [^>]*href="\/decks\/d2"[^>]*>Atraxa<\/a><span class="cp-deck-use">main deck<\/span>/);
    // The name as the deck has it, once: not "Omo (stock) (stock)".
    expect(html).toMatch(/<a [^>]*href="\/decks\/d%2F3"[^>]*>Omo \(stock\)<\/a><span class="cp-deck-use">its commander<\/span>/);
    expect(html).not.toContain("(stock) (stock)");
    expect(deckUseWords({ qty: 3, board: "main" })).toBe("3 in the main deck");
    expect(deckUseWords({ qty: 1, board: "side" })).toBe("sideboard");
    expect(deckUseWords({ qty: 2, board: "side" })).toBe("2 in the sideboard");
    expect(deckUseWords({ qty: 2, board: "commander" })).toBe("its commander");
  });

  it("lists each combo once with every deck it is in, the source and when it was found", () => {
    const both = view({ ...data, combos: [combo({ decks: [{ deck_id: "d2", name: "Atraxa" }, { deck_id: "d/3", name: "Omo (stock)" }] })] });
    expect(both).toContain("Combos with it in your decks");
    expect(both.match(/Sol Ring \+ Dramatic Reversal/g)).toHaveLength(1);
    expect(both).toContain("Infinite colorless mana");
    expect(both).toMatch(/In <a [^>]*href="\/decks\/d2"[^>]*>Atraxa<\/a> and <a [^>]*href="\/decks\/d%2F3"[^>]*>Omo \(stock\)<\/a>\./);
    // Credited and linked, as Commander Spellbook asks, and dated: it is that day's answer.
    expect(both).toMatch(/<a href="https:\/\/commanderspellbook.com\/combo\/1-2\/"[^>]*>How it works, on Commander Spellbook<\/a>/);
    expect(both).toMatch(/Combos from <a href="https:\/\/commanderspellbook.com\/"[^>]*>Commander Spellbook<\/a>, found in these decks&#x27; lists when each was last checked \(Nov 1\)/);
    expect(checkedSpan([combo(), combo({ checked_at: "2026-11-09T10:00:00Z" })])).toBe("Nov 1 to Nov 9");
    // A requirement that isn't a named card keeps its card names' capitals; a long list of results is cut.
    const long = view({ ...data, combos: [combo({ templates: ["A way to untap Isochron Scepter"], results: ["a", "b", "c", "d", "e"] })] });
    expect(long).toContain("Sol Ring + Dramatic Reversal, plus a way to untap Isochron Scepter");
    expect(long).toContain("a, b, c, d, and more");
    expect(templateWords(["A creature", "An Island"])).toBe("a creature, an Island");
  });

  it("says when there are more combos than it lists, and which decks haven't been checked", () => {
    const html = view({
      decks: [...data.decks, { deck_id: "d4", name: "Brand new", qty: 1, board: "main", checked: false }],
      combos: [combo()],
      more_combos: 12,
    });
    expect(html).toContain("And 12 more combos in these decks; each deck&#x27;s page lists its own.");
    // No combos shown for a deck that was never checked isn't "none".
    expect(html).toContain("Not checked for combos yet: Brand new.");
    expect(view(data)).not.toContain("Not checked");
    expect(view(data)).not.toContain("more combo");
  });

  it("puts a deck's other lists on its line, and shows five decks until asked for all", () => {
    const use = (deck_id: string, name: string, board: DeckUse["board"] = "main"): DeckUse => ({ deck_id, name, qty: 1, board, checked: true });
    // One of a deck's other lists: the server says whose it is and what it is called.
    const list = (deck_id: string, parent_id: string, parent_name: string, configuration: string, board: DeckUse["board"] = "main"): DeckUse => ({
      ...use(deck_id, `${parent_name} (${configuration})`, board), parent_id, parent_name, configuration,
    });
    const decks = [
      use("a", "Ahoy Mateys"), list("a2", "a", "Ahoy Mateys", "Bracket 2"), list("a3", "a", "Ahoy Mateys", "Bracket 3", "side"), list("as", "a", "Ahoy Mateys", "stock"),
      // A deck whose own name ends in a parenthesis, and its list.
      use("b", "Berserk (custom, B3)"), list("b2", "b", "Berserk (custom, B3)", "Bracket 2"),
      // Only its other lists run the card: still one line, under the deck's name.
      list("e3", "e", "Eternal Might", "Bracket 3"), list("e4", "e", "Eternal Might", "Bracket 4"),
      // Only one of a deck's other lists runs it: a line of its own.
      list("o2", "o", "Omo", "stock"),
      use("k", "Kraum & Tymna (cEDH)"),
    ];
    const groups = groupDecks(decks);
    expect(groups.map((g) => [g.name, g.main?.deck_id ?? null, g.lists.map((l) => l.label).join("|")])).toEqual([
      ["Ahoy Mateys", "a", "Bracket 2|Bracket 3|stock"],
      ["Berserk (custom, B3)", "b", "Bracket 2"],
      ["Eternal Might", null, "Bracket 3|Bracket 4"],
      ["Omo (stock)", "o2", ""],
      ["Kraum & Tymna (cEDH)", "k", ""],
    ]);
    const html = view({ decks: decks.filter((d) => d.deck_id !== "o2"), combos: [], more_combos: 0 });
    expect(html).toMatch(/<a [^>]*href="\/decks\/a"[^>]*>Ahoy Mateys<\/a><span class="cp-deck-lists">Also in its lists: <a [^>]*href="\/decks\/a2"[^>]*>Bracket 2<\/a> \(main deck\), <a [^>]*href="\/decks\/a3"[^>]*>Bracket 3<\/a> \(sideboard\), /);
    expect(html).toMatch(/<span class="cp-deck-name">Eternal Might<\/span><span class="cp-deck-lists">In its lists: <a [^>]*href="\/decks\/e3"[^>]*>Bracket 3<\/a>, <a [^>]*href="\/decks\/e4"[^>]*>Bracket 4<\/a><\/span>/);
    // Four decks: no button. Seven: five, and the rest behind "Show all 7 decks".
    expect(html).not.toContain("Show all");
    const many = view({ decks: ["A", "B", "C", "D", "E", "F", "G"].map((n) => use(n, `Deck ${n}`)), combos: [], more_combos: 0 });
    expect(many).toContain("Show all 7 decks");
    expect(many).toContain("Deck E");
    expect(many).not.toContain("Deck F");
  });

  it("keeps decks apart whatever their names look like", () => {
    const use = (deck_id: string, name: string): DeckUse => ({ deck_id, name, qty: 1, board: "main", checked: true });
    // Two decks both called "Elves", one with a list; the list arrives before its deck.
    const stock: DeckUse = { ...use("e1s", "Elves (stock)"), parent_id: "e1", parent_name: "Elves", configuration: "stock" };
    const groups = groupDecks([stock, use("e1", "Elves"), use("e2", "Elves"), use("x", "Other")]);
    expect(groups.map((g) => [g.name, g.main?.deck_id ?? null, g.lists.map((l) => l.use.deck_id).join("|")])).toEqual([
      ["Elves", "e1", "e1s"],
      ["Elves", "e2", ""],
      ["Other", "x", ""],
    ]);
    // Unrelated decks whose names share a start and end in a parenthesis are not one deck's lists.
    expect(groupDecks([use("p", "Atraxa (Poison)"), use("c", "Atraxa (Counters)")]).map((g) => [g.name, g.main?.deck_id, g.lists.length])).toEqual([
      ["Atraxa (Poison)", "p", 0],
      ["Atraxa (Counters)", "c", 0],
    ]);
    const html = view({ decks: [use("e1", "Elves"), use("e2", "Elves")], combos: [], more_combos: 0 });
    expect(html).toMatch(/href="\/decks\/e1"[^>]*>Elves</);
    expect(html).toMatch(/href="\/decks\/e2"[^>]*>Elves</);
  });

  it("draws nothing when no deck runs the card, and no combo heading without combos", () => {
    expect(view({ decks: [], combos: [], more_combos: 0 })).toBe("");
    const html = view({ ...data, combos: [] });
    expect(html).toContain("In your decks");
    expect(html).not.toContain("Combos");
    expect(html).not.toContain("Commander Spellbook");
  });
});
