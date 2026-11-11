import { describe, expect, it } from "vitest";
import { anyNumber, fitFor, identityOf, inListText, moreText, ownedText, type Hit } from "./cardFit";

const card = (over: Partial<Hit>): Hit => ({ name: "Sol Ring", type_line: "Artifact", oracle_text: "", color_identity: "", legalities: { commander: "legal" }, ...over }) as Hit;

describe("identityOf", () => {
  it("joins the commanders' colors in WUBRG order, and is null with no commander", () => {
    expect(identityOf([{ color_identity: "GU" }, { color_identity: "W" }])).toBe("WUG");
    expect(identityOf([{ color_identity: "" }])).toBe("");
    expect(identityOf([])).toBeNull();
  });
});

describe("fitFor", () => {
  it("says a card inside the commander's colors is legal in this deck", () => {
    expect(fitFor(card({ color_identity: "U" }), "WUG")).toEqual({ ok: true, text: "Legal in this deck" });
    expect(fitFor(card({}), "")).toEqual({ ok: true, text: "Legal in this deck" });
  });

  it("names the colors a card adds outside the commander's", () => {
    expect(fitFor(card({ color_identity: "UR" }), "WUG")).toEqual({ ok: false, text: "Outside your commander's colors (red)" });
    expect(fitFor(card({ color_identity: "BR" }), "")).toEqual({ ok: false, text: "Outside your commander's colors (black and red)" });
    expect(fitFor(card({ color_identity: "WUB" }), "G")).toEqual({ ok: false, text: "Outside your commander's colors (white, blue and black)" });
  });

  it("puts a ban or an illegal card before colors", () => {
    expect(fitFor(card({ legalities: { commander: "banned" }, color_identity: "R" }), "WUG")).toEqual({ ok: false, text: "Banned in Commander" });
    expect(fitFor(card({ legalities: { commander: "not_legal" } }), "WUG")).toEqual({ ok: false, text: "Not legal in Commander" });
  });

  it("speaks only for the format when no commander is chosen", () => {
    expect(fitFor(card({ color_identity: "R" }), null)).toEqual({ ok: true, text: "Legal in Commander" });
  });

  it("claims no legality for a card whose legality isn't known", () => {
    expect(fitFor(card({ legalities: {} }), null)).toEqual({ ok: true, text: "" });
    expect(fitFor(card({ legalities: {}, color_identity: "G" }), "G")).toEqual({ ok: true, text: "In your commander's colors" });
  });
});

describe("ownedText", () => {
  it("says how many you own and where, or that you own none", () => {
    expect(ownedText(card({ owned: 2, owned_in: "Trade binder" }))).toBe("You own 2 (in Trade binder)");
    expect(ownedText(card({ owned: 1, owned_in: null }))).toBe("You own 1");
    expect(ownedText(card({ owned: 0 }))).toBe("Not in your collection");
  });

  it("says nothing when ownership isn't known", () => {
    expect(ownedText(card({}))).toBe("");
  });
});

describe("anyNumber", () => {
  it("is true for basics and cards that say so", () => {
    expect(anyNumber(card({ type_line: "Basic Land — Forest" }))).toBe(true);
    expect(anyNumber(card({ type_line: "Basic Snow Land — Island" }))).toBe(true);
    expect(anyNumber(card({ type_line: "Creature — Rat", oracle_text: "A deck can have any number of cards named Rat Colony." }))).toBe(true);
    expect(anyNumber(card({ type_line: "Creature — Dwarf", oracle_text: "A deck can have up to seven cards named Seven Dwarves." }))).toBe(true);
    expect(anyNumber(card({}))).toBe(false);
    expect(anyNumber(card({ type_line: "Land" }))).toBe(false);
  });
});

describe("the small lines", () => {
  it("counts copies in the list and the matches not shown", () => {
    expect(inListText(1)).toBe("In the list");
    expect(inListText(3)).toBe("3 in the list");
    expect(moreText(1204, 12)).toBe("Showing the 12 most played of 1,204 matches.");
    expect(moreText(12, 12)).toBe("");
  });
});
