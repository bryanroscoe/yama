import { describe, expect, it } from "vitest";
import { KNOWN_ART, knownArtShare, leadCounts, readTitleFirst } from "./setlock";

describe("knownArtShare", () => {
  it("is the share of the asked artworks the index found", () => {
    expect(knownArtShare(0, { illustrations: ["a", "b"], ids: [] })).toBe(0);
    expect(knownArtShare(1, { illustrations: ["a", "b"], ids: [] })).toBe(0.5);
    expect(knownArtShare(5, { illustrations: ["a", "b"], ids: [] })).toBe(1);
  });
  it("counts nothing asked, or a failed pool, as known", () => {
    expect(knownArtShare(0, { illustrations: [], ids: [] })).toBe(1);
    expect(knownArtShare(-1, { illustrations: ["a"], ids: [] })).toBe(1);
  });
});

describe("readTitleFirst", () => {
  const base = { lockOnce: 0.82, locked: false, inSet: false, share: 1 };
  it("trusts a strong art match with no lock", () => {
    expect(readTitleFirst({ ...base, score: 0.9 })).toBe(false);
  });
  it("reads the title when the art match is weak (the old stuck band and below a lock)", () => {
    expect(readTitleFirst({ ...base, score: 0.55 })).toBe(true);
    expect(readTitleFirst({ ...base, score: 0.7 })).toBe(true);
  });
  it("trusts a fair match that leads every other card, but not locked to sets the art index mostly lacks", () => {
    expect(readTitleFirst({ ...base, score: 0.7, leads: true })).toBe(false);
    expect(readTitleFirst({ ...base, locked: true, inSet: true, share: 1, score: 0.7, leads: true })).toBe(false);
    // A card from the same set can lead for one the index doesn't know: the title decides there.
    expect(readTitleFirst({ ...base, locked: true, inSet: true, share: 0.3, score: 0.7, leads: true })).toBe(true);
    expect(readTitleFirst({ ...base, locked: true, inSet: false, share: 0.3, score: 0.7, leads: true })).toBe(true);
    expect(leadCounts({ locked: true, share: KNOWN_ART - 0.01 })).toBe(false);
    expect(leadCounts({ locked: true, share: KNOWN_ART })).toBe(true);
    expect(leadCounts({ locked: false, share: 0 })).toBe(true);
  });
  it("reads the title for a set the art index doesn't know, even on a strong outside match", () => {
    expect(readTitleFirst({ ...base, locked: true, inSet: false, share: 0, score: 0.95 })).toBe(true);
    expect(readTitleFirst({ ...base, locked: true, inSet: false, share: KNOWN_ART - 0.01, score: 0.95 })).toBe(true);
  });
  it("trusts a strong match among the locked sets' art, or any strong match when the set is known", () => {
    expect(readTitleFirst({ ...base, locked: true, inSet: true, share: 0.3, score: 0.9 })).toBe(false);
    expect(readTitleFirst({ ...base, locked: true, inSet: false, share: 1, score: 0.9 })).toBe(false);
  });
});

describe("sameCardName", async () => {
  const { sameCardName } = await import("./ScannerView");
  it("matches a name and its double-faced card's full name", () => {
    expect(sameCardName("Westvale Abbey", "Westvale Abbey // Ormendahl, Profane Prince")).toBe(true);
    expect(sameCardName("Westvale Abbey // Ormendahl, Profane Prince", "westvale abbey")).toBe(true);
    expect(sameCardName("Sol Ring", "Sol Ring")).toBe(true);
  });
  it("doesn't match different cards", () => {
    expect(sameCardName("Wei Night Raiders", "Westvale Abbey // Ormendahl, Profane Prince")).toBe(false);
  });
});
