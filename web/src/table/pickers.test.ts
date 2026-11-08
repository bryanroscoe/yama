import { describe, expect, it } from "vitest";
import type { DeckSummary, ProfileDeck } from "../api";
import type { PreconItem } from "../lab/api";
import { canPair, deckPicks, deckScopes, handlePrefix, type DeckPick } from "./pickers";
import type { PlayedDeck } from "./playedDecks";

const mine = (name: string, commanders: string[]) => ({ id: name, name, commanders, color_identity: "W", commander_image: null, commander_artist: null }) as unknown as DeckSummary;
const theirs = (name: string, commanders: string[]): ProfileDeck => ({ name, commanders, color_identity: "G", art: null, artist: null, card_count: 100, version_id: `v-${name}` });
const precon = (id: string, name: string, commanders: string[], same_list_as: string | null = null) => ({ id, name, commanders, color_identity: "WR", same_list_as, art: null, released: "2023-06-23" }) as unknown as PreconItem;

const names = (p: DeckPick[]) =>
  p.map((x) => (x.kind === "precon" ? `precon:${x.precon.name}` : x.kind === "named" ? `named:${x.name}` : x.kind === "played" ? `played:${x.deck.player}:${x.deck.name}` : `${x.kind}:${x.deck.name}`));

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

describe("deckPicks with decks played before", () => {
  const played = (player: string, name: string, commanders: string[], games: number, last: string, ids: Partial<PlayedDeck> = {}): PlayedDeck => ({
    key: `${player}|${name}`,
    name,
    named: name !== commanders.join(" and "),
    commanders,
    player,
    games,
    last,
    ...ids,
  });
  const history = [
    played("Matt", "Avengers Assemble", ["Captain America, Team Leader"], 3, "2026-10-20", { memberId: "m-matt" }),
    played("Matt", "Food and Fellowship", ["Frodo, Adventurous Hobbit"], 1, "2026-10-25", { memberId: "m-matt" }),
    played("Matt", "Jace, Multiverse Architect", ["Jace, Multiverse Architect"], 4, "2026-09-01"),
    played("Chris", "Prismari Artistry", ["Rootha, Mastering the Moment"], 2, "2026-10-26", { memberId: "m-chris" }),
    played("Bryan", "Eternal Might", ["Varina, Lich Queen"], 5, "2026-10-26", { userId: "me" }),
  ];
  const matt = { name: "Matt", memberId: "m-matt" };

  it("puts the player's own decks first, most played first, then everyone else's, then yours", () => {
    expect(names(deckPicks("", { ...decks, played: history, who: matt, me: "me", yours: false }))).toEqual([
      // Matt's member row and an older game's typed "Matt" are one person.
      "played:Matt:Jace, Multiverse Architect",
      "played:Matt:Avengers Assemble",
      "played:Matt:Food and Fellowship",
      "played:Chris:Prismari Artistry",
      // A deck you played that's one of yours by name is listed as yours.
      "mine:Eternal Might",
      "mine:Rohan night",
    ]);
  });

  it("finds a player's decks by their name, and filters to theirs, played, yours or precons", () => {
    expect(names(deckPicks("chris", { ...decks, played: history, who: matt, yours: false }))).toEqual(["played:Chris:Prismari Artistry"]);
    expect(names(deckPicks("", { ...decks, played: history, who: matt, yours: false, scope: "theirs" }))).toHaveLength(3);
    expect(names(deckPicks("", { ...decks, played: history, who: matt, yours: false, scope: "yours" }))).toEqual(["mine:Eternal Might", "mine:Rohan night"]);
    // The precons browse with nothing typed, newest first, a reprint once.
    expect(names(deckPicks("", { ...decks, played: history, who: matt, yours: false, scope: "precons" }))).toEqual(["precon:Riders of Rohan", "precon:Food and Fellowship"]);
    expect(names(deckPicks("fellowship", { ...decks, played: history, who: matt, yours: false }))).toEqual(["played:Matt:Food and Fellowship", "precon:Food and Fellowship"]);
  });

  it("keeps a friend's own copy of a deck that shares a name with yours", () => {
    const copy = played("Matt", "Eternal Might", ["Varina, Lich Queen"], 2, "2026-10-01", { memberId: "m-matt" });
    expect(names(deckPicks("", { ...decks, played: [copy], who: matt, me: "me", yours: false, scope: "theirs" }))).toEqual(["played:Matt:Eternal Might"]);
  });

  it("keeps two people of the same name apart when both are known", () => {
    const other = { name: "Matt", memberId: "m-other-matt" };
    expect(names(deckPicks("", { played: history, who: other, yours: false, scope: "theirs" }))).toEqual(["played:Matt:Jace, Multiverse Architect"]);
  });

  it("offers the player's filter only on someone else's seat", () => {
    expect(deckScopes({ who: matt, yours: false, played: true, mine: true }).map((s) => s.label)).toEqual(["All", "Matt's", "Played", "Yours", "Precons"]);
    expect(deckScopes({ who: { name: "Bryan Roscoe", userId: "me" }, yours: true, played: false, mine: true }).map((s) => s.label)).toEqual(["All", "Yours", "Precons"]);
  });
});
