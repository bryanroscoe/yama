import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MaybeEntry } from "../api";
import { Considering, consideringOwned } from "./Considering";
import { deckListText, withConsidering } from "./editList";
import { checks, toSave, type Draft, type ImportCard } from "./importLogic";

const maybe = (name: string, over: Partial<MaybeEntry> = {}): MaybeEntry => ({ oracle_id: name, name, qty: 1, card: null, owned: 0, proxies: 0, ...over });
const page = (cards: MaybeEntry[]) => renderToStaticMarkup(<MemoryRouter><Considering cards={cards} deckId="d1" onOpen={() => {}} /></MemoryRouter>);

describe("Considering, on the deck page", () => {
  it("lists the cards with what you own, and says they count toward nothing", () => {
    const html = page([maybe("Opt", { owned: 2, card: { type_line: "Instant", image_small: null } as MaybeEntry["card"] }), maybe("Swan Song", { qty: 2, proxies: 1 }), maybe("Negate")]);
    expect(html).toContain("Considering <span class=\"dim num\">4</span>");
    expect(html).toContain("4 cards you&#x27;re thinking about. They aren&#x27;t in the deck, so they don&#x27;t count toward its legality, stats, prices or exports.");
    expect(html).toContain('href="/decks/d1/edit"');
    expect(html).toContain("Instant. You own 2");
    expect(html).toContain("2 Swan Song");
    expect(html).toContain("Proxy only");
    expect(html).toContain("Not owned");
  });

  it("speaks of one card as one", () => {
    expect(page([maybe("Opt")])).toContain("1 card you&#x27;re thinking about. It isn&#x27;t in the deck, so it doesn&#x27;t count");
  });

  it("is nothing for a deck that considers nothing", () => {
    expect(page([])).toBe("");
    expect(consideringOwned({ owned: 0, proxies: 0 })).toBe("Not owned");
  });
});

describe("the Considering list in the editor's text", () => {
  const deck = { cards: [{ qty: 1, name: "Omo, Queen of Vesuva", board: "commander" }, { qty: 1, name: "Sol Ring", board: "main" }], maybe: [{ qty: 1, name: "Opt" }] };

  it("is a section of the deck's text", () => {
    expect(deckListText(deck)).toBe("Commander\n1 Omo, Queen of Vesuva\n\nDeck\n1 Sol Ring\n\nConsidering\n1 Opt");
    expect(deckListText({ cards: deck.cards })).toBe("Commander\n1 Omo, Queen of Vesuva\n\nDeck\n1 Sol Ring");
  });

  it("is put under another list that is loaded over the deck, unless that list brings its own", () => {
    expect(withConsidering("1 Island\n", deck.maybe)).toBe("1 Island\n\nConsidering\n1 Opt");
    expect(withConsidering("1 Island\n\nMaybeboard\n1 Negate", deck.maybe)).toBe("1 Island\n\nMaybeboard\n1 Negate");
    expect(withConsidering("1 Island", [])).toBe("1 Island");
    expect(withConsidering("1 Island", undefined)).toBe("1 Island");
  });
});

describe("saving a list that has a maybeboard", () => {
  const card = (name: string, over: Partial<ImportCard> = {}): ImportCard =>
    ({ oracle_id: name, name, qty: 1, board: "main", maybe: false, type_line: "Instant", color_identity: "", can_be_commander: false, any_number: false, set_code: null, collector_number: null, finish: null, print_found: null, ...over }) as ImportCard;
  const draft: Draft = {
    name: "Brewing",
    unknown: [],
    commanderMarked: true,
    commanderGuessed: false,
    cards: [
      card("Omo, Queen of Vesuva", { board: "commander" }),
      card("Sol Ring"),
      card("Negate", { board: "side" }),
      card("Opt", { board: "side", maybe: true, set_code: "eld", collector_number: "59", print_found: true }),
      card("Opt", { board: "side", maybe: true, qty: 2 }),
      card("Sol Ring", { board: "side", maybe: true, set_code: "cmm", collector_number: "410", print_found: true }),
    ],
  };

  it("sends the maybeboard as the Considering list, never as the deck's cards or its sideboard", () => {
    const body = toSave(draft);
    expect(body.cards.map((c) => `${c.qty} ${c.name} ${c.board}`)).toEqual(["1 Omo, Queen of Vesuva commander", "1 Sol Ring main", "1 Negate side"]);
    expect(body.maybe).toEqual([{ oracle_id: "Opt", name: "Opt", qty: 3 }, { oracle_id: "Sol Ring", name: "Sol Ring", qty: 1 }]);
  });

  it("keeps a printing for a card in the deck, not for one only being considered", () => {
    expect(toSave(draft).prints.map((p) => p.oracle_id)).toEqual([]);
    const printed = { ...draft, cards: [...draft.cards, card("Sol Ring", { set_code: "c21", collector_number: "263", print_found: true })] };
    expect(toSave(printed).prints.map((p) => `${p.oracle_id} ${p.set_code}`)).toEqual(["Sol Ring c21"]);
  });

  it("counts it apart from the deck and the sideboard", () => {
    const c = checks(draft);
    expect(c.total).toBe(2);
    expect(c.sideboard).toBe(1);
    expect(c.considering).toBe(4);
    // A second Sol Ring under Considering isn't a duplicate in the deck.
    expect(c.duplicates).toEqual([]);
  });
});
