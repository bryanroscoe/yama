import { describe, expect, it } from "vitest";
import type { DeckSummary, ProfileDeck } from "../api";
import type { PreconItem } from "../lab/api";
import { canPair, deckPicks, handlePrefix, type DeckPick } from "./pickers";

const mine = (name: string, commanders: string[]) => ({ id: name, name, commanders, color_identity: "W", commander_image: null, commander_artist: null }) as unknown as DeckSummary;
const theirs = (name: string, commanders: string[]): ProfileDeck => ({ name, commanders, color_identity: "G", art: null, artist: null, card_count: 100, version_id: `v-${name}` });
const precon = (id: string, name: string, commanders: string[], same_list_as: string | null = null) => ({ id, name, commanders, color_identity: "WR", same_list_as, art: null, released: "2023-06-23" }) as unknown as PreconItem;

const names = (p: DeckPick[]) => p.map((x) => (x.kind === "mine" || x.kind === "theirs" ? `${x.kind}:${x.deck.name}` : `precon:${x.precon.name}`));

const decks = {
  mine: [mine("Eternal Might", ["Varina, Lich Queen"]), mine("Rohan night", ["Éomer, King of Rohan"])],
  theirs: [theirs("Riders", ["Éowyn, Shieldmaiden"])],
  precons: [
    precon("ltc-rohan", "Riders of Rohan", ["Éowyn, Shieldmaiden"]),
    precon("ltc-rohan-again", "Riders of Rohan", ["Éowyn, Shieldmaiden"], "ltc-rohan"),
    precon("ltc-food", "Food and Fellowship", ["Frodo, Adventurous Hobbit", "Sam, Loyal Attendant"]),
  ],
};

describe("deckPicks", () => {
  it("offers their public decks first on their seat, then yours to lend, then precons", () => {
    expect(names(deckPicks("rohan", { ...decks, handle: "sam", yours: false }))).toEqual(["mine:Rohan night", "precon:Riders of Rohan"]);
    expect(names(deckPicks("eowyn", { ...decks, handle: "sam", yours: false }))).toEqual(["theirs:Riders", "precon:Riders of Rohan"]);
  });

  it("matches every word against the deck and its commanders, and shows a reprinted precon once", () => {
    expect(names(deckPicks("sam loyal", { ...decks, yours: true }))).toEqual(["precon:Food and Fellowship"]);
    expect(names(deckPicks("riders", { ...decks, yours: true }))).toEqual(["precon:Riders of Rohan"]);
  });

  it("lists your decks before anything is typed, and precons only once two letters are", () => {
    expect(names(deckPicks("", { ...decks, yours: true }))).toEqual(["mine:Eternal Might", "mine:Rohan night"]);
    expect(names(deckPicks("r", { ...decks, yours: true }))).toEqual(["mine:Eternal Might", "mine:Rohan night"]);
    // Your own seat never shows "their" decks, even with your handle on it.
    expect(names(deckPicks("", { ...decks, handle: "saget", yours: true }))).toEqual(["mine:Eternal Might", "mine:Rohan night"]);
  });
});

describe("deckPicks and configurations", () => {
  it("lists a deck once; its stock and after-prints lists are picked after it", () => {
    const main = mine("Riders of Rohan", ["Éowyn, Shieldmaiden"]);
    const stock = { ...mine("Riders of Rohan (stock)", ["Éowyn, Shieldmaiden"]), parent_id: main.id, configuration: "stock" } as DeckSummary;
    expect(names(deckPicks("", { mine: [main, stock], yours: true }))).toEqual(["mine:Riders of Rohan"]);
    expect(names(deckPicks("stock", { mine: [main, stock], yours: true }))).toEqual([]);
  });
});

describe("canPair", () => {
  const card = (name: string, oracle_text: string, type_line = "Legendary Creature") => ({ name, oracle_text, type_line });
  it("pairs partners, Backgrounds, Doctors and named partners, and nothing else", () => {
    expect(canPair(card("Tana", "Partner"), card("Tymna", "Partner"))).toBe(true);
    expect(canPair(card("Wilson", "Choose a Background"), card("Raised by Giants", "", "Legendary Enchantment — Background"))).toBe(true);
    expect(canPair(card("The Tenth Doctor", "", "Legendary Creature — Time Lord Doctor"), card("Rose Tyler", "Doctor's companion"))).toBe(true);
    expect(canPair(card("Pir, Imaginative Rascal", "Partner with Toothy, Imaginary Friend"), card("Toothy, Imaginary Friend", "Partner with Pir, Imaginative Rascal"))).toBe(true);
    expect(canPair(card("Pir, Imaginative Rascal", "Partner with Toothy, Imaginary Friend"), card("Tymna", "Partner"))).toBe(false);
    expect(canPair(card("Tana", "Partner"), card("Will", "Friends forever"))).toBe(false);
    // A precon's face commander and its alternate: a choice, not a pair.
    expect(canPair(card("Éowyn, Shieldmaiden", "First strike"), card("Éomer, King of Rohan", "Double strike"))).toBe(false);
  });
});

describe("deckPicks as a dropdown", () => {
  it("lists every deck with nothing typed, and the first twenty matches once something is", () => {
    const many = Array.from({ length: 30 }, (_, i) => mine(`Deck ${i + 1}`, ["Test Commander"]));
    expect(deckPicks("", { mine: many, yours: true })).toHaveLength(30);
    expect(deckPicks("deck", { mine: many, yours: true })).toHaveLength(20);
  });
});

describe("handlePrefix", () => {
  it("is what a handle could start with, never a display name", () => {
    expect(handlePrefix(" @SaG")).toBe("sag");
    expect(handlePrefix("s")).toBeNull();
    expect(handlePrefix("Sam Smith")).toBeNull();
  });
});
