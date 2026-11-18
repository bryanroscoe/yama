import { describe, expect, it } from "vitest";
import { NameIndex } from "./fuzzy";
import { fuseTitle, needsTitle, titleRead } from "./fuse";

const m = (name: string, score: number) => ({ name, score });

describe("art and title together", () => {
  it("reads the title only when the art isn't sure or two cards are close", () => {
    expect(needsTitle([m("Sol Ring", 0.93), m("Mind Stone", 0.4)])).toBe(false);
    expect(needsTitle([m("Sol Ring", 0.58)])).toBe(true);
    expect(needsTitle([m("Sol Ring", 0.9), m("Mind Stone", 0.88)])).toBe(true);
    // Two printings of the same card aren't a close call.
    expect(needsTitle([m("Sol Ring", 0.9), m("Sol Ring", 0.89)])).toBe(false);
    expect(needsTitle([])).toBe(false);
  });

  it("settles a card in the stuck band when the title names it", () => {
    const matches = [m("Sol Ring", 0.57), m("Mind Stone", 0.52)];
    expect(fuseTitle(matches, { name: "Sol Ring", score: 0.96, margin: 0.3 })).toEqual({ kind: "art", match: matches[0] });
    // The title can pick the second art match, too.
    expect(fuseTitle(matches, { name: "Mind Stone", score: 0.9, margin: 0.2 })).toEqual({ kind: "art", match: matches[1] });
  });

  it("vetoes the art when a clear title names another card", () => {
    expect(fuseTitle([m("Sol Ring", 0.7)], { name: "Arcane Signet", score: 0.95, margin: 0.4 })).toEqual({ kind: "title", name: "Arcane Signet" });
  });

  it("matches either face of a two-faced card", () => {
    const matches = [m("Invasion of Tolvada // The Broken Sky", 0.6)];
    expect(fuseTitle(matches, { name: "Invasion of Tolvada", score: 0.9, margin: 0.2 }).kind).toBe("art");
  });

  it("settles a card when a fairly clear title agrees with one of the art's matches", () => {
    const matches = [m("Bridge from Below", 0.675), m("Mind Stone", 0.6)];
    const agree = { agree: true };
    expect(fuseTitle(matches, { name: "Bridge from Below", score: 0.72, margin: 0.1 }, agree)).toEqual({ kind: "art", match: matches[0] });
    expect(fuseTitle(matches, { name: "Mind Stone", score: 0.7, margin: 0.04 }, agree)).toEqual({ kind: "art", match: matches[1] });
    // Fairly clear but naming a card the art doesn't have: no veto, nothing.
    expect(fuseTitle(matches, { name: "Arcane Signet", score: 0.8, margin: 0.2 }, agree)).toEqual({ kind: "none" });
    // Only when asked (identity-only scans): the collection still needs a clear title.
    expect(fuseTitle(matches, { name: "Bridge from Below", score: 0.72, margin: 0.1 })).toEqual({ kind: "none" });
  });

  it("ignores an unclear title, and art too weak to count", () => {
    expect(fuseTitle([m("Sol Ring", 0.6)], { name: "Sol Ring", score: 0.69, margin: 0.3 }, { agree: true })).toEqual({ kind: "none" });
    expect(fuseTitle([m("Sol Ring", 0.6)], { name: "Sol Ring", score: 0.95, margin: 0.02 })).toEqual({ kind: "none" });
    expect(fuseTitle([m("Sol Ring", 0.45)], { name: "Sol Ring", score: 0.8, margin: 0.3 }, { agree: true })).toEqual({ kind: "none" });
    expect(fuseTitle([m("Sol Ring", 0.3)], { name: "Sol Ring", score: 0.95, margin: 0.3 })).toEqual({ kind: "title", name: "Sol Ring" });
    expect(fuseTitle([m("Sol Ring", 0.6)], null)).toEqual({ kind: "none" });
  });

  // Bryan's foil Westvale Abbey, 15 Nov 2026: the art locked Wei Night Raiders at 0.658 on two
  // frames; the title "Westvale Abbey" was perfectly readable.
  it("lets a readable title overrule a weak art lock, matching the two-faced card by its front face", () => {
    const matches = [m("Wei Night Raiders", 0.658), m("Rally the Peasants", 0.55)];
    expect(needsTitle(matches)).toBe(true);
    expect(fuseTitle(matches, { name: "Westvale Abbey // Ormendahl, Profane Prince", score: 1, margin: 0.4 })).toEqual({ kind: "title", name: "Westvale Abbey // Ormendahl, Profane Prince" });
  });

  it("resolves the card from an art match of either face", () => {
    const title = { name: "Westvale Abbey // Ormendahl, Profane Prince", score: 1, margin: 0.4 };
    const front = [m("Westvale Abbey // Ormendahl, Profane Prince", 0.6)];
    const back = [m("Ormendahl, Profane Prince", 0.6)];
    expect(fuseTitle(front, title)).toEqual({ kind: "art", match: front[0] });
    expect(fuseTitle(back, title)).toEqual({ kind: "art", match: back[0] });
  });

  it("reads a title of just the front face as the two-faced card's full name", () => {
    const full = "Westvale Abbey // Ormendahl, Profane Prince";
    const names = new NameIndex(["Westvale Abbey", "Ormendahl, Profane Prince", "Wei Night Raiders", "Westvale Cult Leader"]);
    const catalog = { fullName: (n: string) => (n === "Westvale Abbey" || n === "Ormendahl, Profane Prince" ? full : n) };
    const t = titleRead(["", "Westvale Abbey"], { names, catalog });
    expect(t).toMatchObject({ name: full });
    expect(fuseTitle([m("Wei Night Raiders", 0.658)], t)).toEqual({ kind: "title", name: full });
  });
});
