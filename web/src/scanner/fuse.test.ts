import { describe, expect, it } from "vitest";
import { NameIndex } from "./fuzzy";
import { artDecides, artLead, fuseTitle, LEAD_FRAMES, leadRun, leads, needsTitle, titleRead } from "./fuse";

const m = (name: string, score: number) => ({ name, score });

describe("art and title together", () => {
  it("reads the title only when the art isn't sure or two cards are close", () => {
    expect(needsTitle([m("Sol Ring", 0.93), m("Mind Stone", 0.4)])).toBe(false);
    expect(needsTitle([m("Sol Ring", 0.58)])).toBe(true);
    expect(needsTitle([m("Sol Ring", 0.7), m("Mind Stone", 0.65)])).toBe(true);
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
  // frames; the title "Westvale Abbey" was perfectly readable. On his saved photo of it the next
  // card, Honor the Fallen, scored 0.034 behind: no lead.
  it("lets a readable title overrule a weak art lock, matching the two-faced card by its front face", () => {
    const matches = [m("Wei Night Raiders", 0.658), m("Honor the Fallen", 0.624)];
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

// Bryan, 18 Nov 2026: right cards score a median 0.78 by art on his real photos, so most waited on
// the title. Art that leads every other card by 0.10 (at 0.65 or more) settles which card.
describe("art that leads every other card", () => {
  it("settles the card without the title at 0.65 and 0.10 ahead", () => {
    const matches = [m("Sol Ring", 0.7), m("Mind Stone", 0.59), m("Arcane Signet", 0.55)];
    expect(artLead(matches)).toBeCloseTo(0.11);
    expect(leads(0.7, artLead(matches))).toBe(true);
    expect(leads(0.65, 0.1)).toBe(true);
    expect(needsTitle(matches)).toBe(false);
  });

  it("doesn't count other printings or illustrations of the same card as rivals", () => {
    const matches = [m("Sol Ring", 0.72), m("Sol Ring", 0.71), m("Sol Ring", 0.7), m("Mind Stone", 0.6), m("Arcane Signet", 0.5)];
    expect(artLead(matches)).toBeCloseTo(0.12);
    expect(needsTitle(matches)).toBe(false);
    // Either face of a two-faced card is the same card.
    const faces = [m("Westvale Abbey // Ormendahl, Profane Prince", 0.7), m("Ormendahl, Profane Prince", 0.69), m("Mind Stone", 0.58)];
    expect(artLead(faces)).toBeCloseTo(0.12);
  });

  it("reads the title when a different card scores within 0.10", () => {
    const matches = [m("Sol Ring", 0.72), m("Sol Ring", 0.7), m("Mind Stone", 0.63), m("Arcane Signet", 0.5)];
    expect(leads(0.72, artLead(matches))).toBe(false);
    expect(needsTitle(matches)).toBe(true);
  });

  it("reads the title below 0.65, however far ahead", () => {
    const matches = [m("Sol Ring", 0.64), m("Mind Stone", 0.3)];
    expect(artLead(matches)).toBeCloseTo(0.34);
    expect(needsTitle(matches)).toBe(true);
  });

  it("takes anything the search didn't list as scoring up to its lowest listed score", () => {
    // Five illustrations of one card fill the search's list: the next card may score just under the fifth.
    const lands = [0.74, 0.72, 0.7, 0.69, 0.68].map((s) => m("Forest", s));
    expect(artLead(lands)).toBeCloseTo(0.06);
    expect(needsTitle(lands)).toBe(true);
    // With the set lock's pool merged in below the search's cutoff, the cutoff is passed.
    const merged = [...lands, m("Forest", 0.55)];
    expect(artLead(merged, merged[0], 0.68)).toBeCloseTo(0.06);
    expect(needsTitle(merged, 0.68)).toBe(true);
    // A lone listed match is no evidence of a lead.
    expect(needsTitle([m("Sol Ring", 0.75)])).toBe(true);
  });

  it("measures the lead of the match the set lock chose, not of the best anywhere", () => {
    const matches = [m("Mind Stone", 0.75), m("Sol Ring", 0.7), m("Arcane Signet", 0.5)];
    expect(artLead(matches, matches[1])).toBeCloseTo(-0.05);
  });

  it("keeps a sure match as it was: no title unless another card is within 0.03", () => {
    expect(needsTitle([m("Sol Ring", 0.85), m("Mind Stone", 0.8)])).toBe(false);
    expect(needsTitle([m("Sol Ring", 0.85), m("Mind Stone", 0.83)])).toBe(true);
    expect(artDecides(0.85, 0)).toBe("sure");
  });

  it("decides on the live camera only once the same artwork has led two frames in a row", () => {
    expect(LEAD_FRAMES).toBe(2);
    let run = leadRun(0, true, false);
    expect(artDecides(0.7, run)).toBeNull();
    run = leadRun(run, true, true);
    expect(artDecides(0.7, run)).toBe("leads");
    // Another artwork leading starts the count again; a frame that doesn't lead ends it.
    expect(leadRun(1, true, false)).toBe(1);
    expect(leadRun(1, false, true)).toBe(0);
    expect(artDecides(0.7, leadRun(leadRun(1, false, true), true, true))).toBeNull();
    // A still photo has one frame, and one is enough.
    expect(artDecides(0.7, 1, 1)).toBe("leads");
  });
});
