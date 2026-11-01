import { describe, expect, it } from "vitest";
import { addCard, changeText, copies, fixCard, groups, loadDraft, newDraft, progress, removeCard, sameCard, scanLines, storeDraft, toggleCommander, type ScanDraft } from "./deckScan";

const scan = (names: string[], commanders = ["Hearthhull, the Worldseed"]): ScanDraft =>
  names.reduce((d, name, i) => addCard(d, name, { at: i, key: `k${i}` }), newDraft("deck-1", commanders));

describe("scanning a deck", () => {
  it("counts every physical card toward 100 and notices the commander", () => {
    const d = scan(["Sol Ring", "Forest", "Forest", "Hearthhull, the Worldseed"]);
    expect(progress(d)).toEqual({ count: 4, left: 96, missingCommanders: [], duplicates: 0 });
    expect(progress(scan(["Sol Ring"])).missingCommanders).toEqual(["Hearthhull, the Worldseed"]);
  });

  it("lists cards newest first and flags a second copy of anything but a basic", () => {
    const d = scan(["Sol Ring", "Forest", "Forest", "Sol Ring", "Arcane Signet"]);
    const g = groups(d);
    expect(g.map((x) => [x.name, x.count, x.duplicate])).toEqual([
      ["Arcane Signet", 1, false],
      ["Sol Ring", 2, true],
      ["Forest", 2, false],
    ]);
    expect(progress(d).duplicates).toBe(1);
  });

  it("removes a duplicate and fixes a misread card", () => {
    let d = scan(["Sol Ring", "Sol Ring", "Sol Rang"]);
    d = removeCard(d, "k1");
    d = fixCard(d, "k2", "Arcane Signet");
    expect(groups(d).map((x) => [x.name, x.count])).toEqual([["Arcane Signet", 1], ["Sol Ring", 1]]);
    expect(d.cards.find((c) => c.key === "k2")?.typed).toBe(true);
    expect(d.cards).toHaveLength(2);
  });

  it("sends one line per card with the commander marked and first", () => {
    let d = scan(["Sol Ring", "Forest", "Forest", "Hearthhull, the Worldseed"]);
    expect(scanLines(d)).toEqual([
      { name: "Hearthhull, the Worldseed", qty: 1, commander: true },
      { name: "Forest", qty: 2, commander: false },
      { name: "Sol Ring", qty: 1, commander: false },
    ]);
    d = toggleCommander(d, "Hearthhull, the Worldseed");
    d = toggleCommander(d, "Sol Ring");
    expect(scanLines(d)[0]).toEqual({ name: "Sol Ring", qty: 1, commander: true });
  });

  it("matches a double-faced commander by its front face, in any case", () => {
    expect(sameCard("Esika, God of the Tree // The Prismatic Bridge", "esika, god of the tree")).toBe(true);
    expect(sameCard("Esika, God of the Tree", "Esika, God of the Tree // The Prismatic Bridge")).toBe(true);
    expect(sameCard("Forest", "Snow-Covered Forest")).toBe(false);
    const d = scan(["Esika, God of the Tree"], ["Esika, God of the Tree // The Prismatic Bridge"]);
    expect(progress(d).missingCommanders).toEqual([]);
    expect(scanLines(d)[0]?.commander).toBe(true);
  });

  it("keeps an unfinished scan on the device and drops it once empty", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const d = scan(["Sol Ring"]);
    storeDraft(d, storage);
    expect(loadDraft("deck-1", storage)).toEqual(d);
    expect(loadDraft("deck-2", storage)).toBeNull();
    storeDraft(removeCard(d, "k0"), storage);
    expect(loadDraft("deck-1", storage)).toBeNull();
    mem.set("yama.deckScan.deck-1", "{not json");
    expect(loadDraft("deck-1", storage)).toBeNull();
  });

  it("words the changes by copies", () => {
    const forest = { oracle_id: "f", name: "Forest", before: 30, after: 33 };
    expect(changeText(forest, "in")).toBe("3 Forest");
    expect(changeText(forest, "same")).toBe("30 Forest");
    expect(changeText({ ...forest, before: 1, after: 0 }, "out")).toBe("Forest");
    expect(copies([forest, { oracle_id: "s", name: "Sol Ring", before: 0, after: 1 }], "in")).toBe(4);
  });
});
