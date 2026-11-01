import { describe, expect, it } from "vitest";
import type { PlanBundle } from "@yama/core/plan";
import type { BuildFamily } from "./buildCatalog";
import { researchWhere } from "./buildCatalog";
import { CURRENT, cardsTarget, entryWhere, listTarget, swapPool, targetOptions } from "./checkTargets";
import { BUZZ, TONES } from "./checkSound";
import {
  cardKey, classify, insteadOf, loadCheck, newCheck, stillMissing, storeCheck, takeOut, tally, toScanDraft, verdictText,
  type CheckDraft, type CheckTarget,
} from "./deckCheck";
import { addCard, fixCard, removeCard } from "./deckScan";

const target: CheckTarget = {
  id: "t",
  label: "B2 build",
  cards: [
    { name: "Rootha, Mastering the Moment", qty: 1, commander: true },
    { name: "Sol Ring", qty: 1, commander: false },
    { name: "Reliquary Tower", qty: 1, commander: false, where: "Yours, in Spares." },
    { name: "Brazen Borrower // Petty Theft", qty: 1, commander: false },
    { name: "Island", qty: 2, commander: false },
  ],
  pairs: [
    // The build's own swap: Reliquary Tower goes in for Ancient Tomb.
    { out: "Ancient Tomb", in: "Reliquary Tower", where: null },
    // A plan swap the other way round: The One Ring in for Brazen Borrower.
    { out: "Brazen Borrower", in: "The One Ring", where: "Print, ordered." },
  ],
};

const check = (names: string[], t = "x"): CheckDraft => names.reduce((d, name, i) => addCard(d, name, { at: i, key: `k${i}` }), { ...newCheck("deck-1", ["Rootha, Mastering the Moment"]), target: t });

describe("checking a deck", () => {
  it("says belongs, take out or already seen for each card as it's scanned", () => {
    const v = classify(target, check(["Sol Ring", "Ancient Tomb", "Sol Ring", "Rootha, Mastering the Moment"]).cards);
    expect(v.map((x) => [x.name, x.kind, x.copy, x.wanted])).toEqual([
      ["Sol Ring", "belongs", 1, 1],
      ["Ancient Tomb", "out", 1, 0],
      ["Sol Ring", "duplicate", 2, 1],
      ["Rootha, Mastering the Moment", "belongs", 1, 1],
    ]);
    expect(verdictText(v[2]!).title).toBe("Already seen");
    expect(verdictText(v[1]!).title).toBe("Take out");
  });

  it("counts basics against the list's quantity", () => {
    const v = classify(target, check(["Island", "Island", "Island", "Forest"]).cards);
    expect(v.map((x) => x.kind)).toEqual(["belongs", "belongs", "extra", "out"]);
    expect(verdictText(v[1]!).detail).toBe("Copy 2 of 2.");
    expect(verdictText(v[2]!)).toEqual({ title: "Take out", detail: "One too many: the list has 2." });
  });

  it("matches a double-faced card by its front face, in any case", () => {
    expect(cardKey("Brazen Borrower // Petty Theft")).toBe(cardKey("brazen borrower"));
    expect(classify(target, check(["brazen borrower"]).cards)[0]!.kind).toBe("belongs");
  });

  it("pairs a card to take out with the card that goes in, either way round, only when that card is in the list", () => {
    expect(insteadOf("Ancient Tomb", target)).toEqual([{ out: "Ancient Tomb", in: "Reliquary Tower", where: "Yours, in Spares." }]);
    // The plan swap Brazen Borrower to The One Ring, read backwards: the Ring comes out for the Borrower.
    expect(insteadOf("The One Ring", target).map((p) => p.in)).toEqual(["Brazen Borrower // Petty Theft"]);
    // Nothing known, or the other card isn't in the list.
    expect(insteadOf("Mystical Tutor", target)).toEqual([]);
    expect(insteadOf("Brazen Borrower", { ...target, cards: target.cards.filter((c) => !c.name.startsWith("Brazen")) })).toEqual([]);
    // Duplicates of a swap aren't listed twice.
    expect(insteadOf("Ancient Tomb", { ...target, pairs: [...target.pairs, target.pairs[0]!] })).toHaveLength(1);
    expect(classify(target, check(["Ancient Tomb"]).cards)[0]!.instead[0]!.in).toBe("Reliquary Tower");
  });

  it("tallies, lists what to take out and what's still missing with what it replaces", () => {
    const v = classify(target, check(["Sol Ring", "Ancient Tomb", "Sol Ring", "Island", "Island", "Island"]).cards);
    expect(tally(target, v)).toEqual({ checked: 6, belongs: 3, out: 3, duplicates: 1, missing: 3, total: 6 });
    expect(takeOut(v).map((g) => [g.name, g.kind, g.count])).toEqual([
      ["Island", "extra", 1],
      ["Sol Ring", "duplicate", 1],
      ["Ancient Tomb", "out", 1],
    ]);
    expect(stillMissing(target, v)).toEqual([
      { name: "Rootha, Mastering the Moment", missing: 1, commander: true, where: null, replaces: [] },
      { name: "Brazen Borrower // Petty Theft", missing: 1, commander: false, where: null, replaces: [] },
      { name: "Reliquary Tower", missing: 1, commander: false, where: "Yours, in Spares.", replaces: ["Ancient Tomb"] },
    ]);
  });

  it("fixes and removes a misread card the scan page's way", () => {
    let d = check(["Sol Rang", "Sol Ring", "Sol Ring"]);
    d = fixCard(d, "k0", "Ancient Tomb");
    d = removeCard(d, "k2");
    expect(d.target).toBe("x");
    expect(classify(target, d.cards).map((x) => x.kind)).toEqual(["out", "belongs"]);
  });

  it("keeps the check on the device, never as a scan until asked", () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const d = check(["Sol Ring"]);
    storeCheck(d, storage);
    expect([...mem.keys()]).toEqual(["yama.deckCheck.deck-1"]);
    expect(loadCheck("deck-1", storage)).toEqual(d);
    expect(loadCheck("deck-2", storage)).toBeNull();
    // A chosen target alone is kept; an empty check on the current list isn't.
    storeCheck({ ...d, cards: [] }, storage);
    expect(loadCheck("deck-1", storage)?.target).toBe("x");
    storeCheck({ ...d, cards: [], target: null }, storage);
    expect(loadCheck("deck-1", storage)).toBeNull();
    mem.set("yama.deckCheck.deck-1", "{not json");
    expect(loadCheck("deck-1", storage)).toBeNull();
    expect(toScanDraft(d)).toEqual({ v: 1, deckId: "deck-1", cards: d.cards, commanders: ["Rootha, Mastering the Moment"] });
    // Saved as a scan, the commander is the target's: a configuration can lead with another card.
    expect(toScanDraft(d, { ...target, cards: [{ name: "Veyran, Voice of Duality", qty: 1, commander: true }] }).commanders).toEqual(["Veyran, Voice of Duality"]);
    expect(toScanDraft(d, { ...target, cards: [] }).commanders).toEqual(["Rootha, Mastering the Moment"]);
  });

  it("has a distinct sound and buzz for a card to take out", () => {
    expect(TONES.out.notes).not.toEqual(TONES.belongs.notes);
    expect(TONES.duplicate.notes).not.toEqual(TONES.out.notes);
    expect(BUZZ.belongs).toBeNull();
    expect(BUZZ.out?.length).toBeGreaterThan(0);
  });
});

describe("what to check against", () => {
  const family: BuildFamily = {
    key: "saved:d1",
    name: "Prismari Artistry",
    planKeys: ["prismari"],
    choices: [
      { id: "saved:d1", label: "Current (saved deck)", kind: "current", savedDeck: "d1", source: "Saved", href: "", warnings: [] },
      { id: "saved:d2", label: "Original", kind: "original", savedDeck: "d2", source: "Saved", href: "", warnings: [] },
      { id: "plan:prismari:after", label: "Legacy: after prints", kind: "legacy", list: "Commander\n1 Rootha\n\nDeck\n1 Sol Ring", source: "Plan v28", href: "", warnings: [], pairs: [{ out: "Resculpt", in: "Counterspell", where: "Print, ordered." }] },
      { id: "plan:prismari:b2", label: "[2] Plan (availability unchecked)", kind: "bracket", list: "Commander\n1 Rootha\n\nDeck\n1 Sol Ring", source: "Plan v28", href: "", warnings: [] },
      { id: "research:r1:prismari-artistry:b2-owned-now", label: "[2] Buildable now", kind: "bracket", list: "Commander\n1 Rootha\n\nDeck\n1 Sol Ring", source: "Buildable now, revision 3, 2026-10-31", href: "", warnings: [] },
      { id: "research:r1:prismari-artistry:current", label: "Research starting snapshot (2026-10-31)", kind: "legacy", list: "Commander\n1 Rootha", source: "Buildable now, revision 3, 2026-10-31", href: "", warnings: [] },
    ],
  };

  it("offers the current list first, then configurations, earlier versions, the plan and research builds", () => {
    const opts = targetOptions({ id: "d1", name: "Prismari Artistry", version_id: "v2" }, family, [
      { id: "v2", note: "Installed", created_at: "2026-10-31T10:00:00Z" },
      { id: "v1", note: null, created_at: "2026-10-20T10:00:00Z" },
    ]);
    expect(opts.map((o) => [o.id, o.group])).toEqual([
      [CURRENT, "This deck"],
      ["saved:d2", "This deck"],
      ["version:v1", "Earlier versions"],
      ["plan:prismari:after", "Plan"],
      ["plan:prismari:b2", "Plan"],
      ["research:r1:prismari-artistry:b2-owned-now", "Research: Buildable now"],
    ]);
    expect(opts.find((o) => o.id === "plan:prismari:after")?.label).toBe("Plan: after prints");
    expect(opts.find((o) => o.id === "plan:prismari:b2")?.label).toBe("Plan: [2] Plan");
    // On a configuration, the main deck's list is offered too.
    expect(targetOptions({ id: "d2", name: "Prismari Artistry (stock)", version_id: null }, family).map((o) => o.label).slice(0, 2)).toEqual(["The deck's current list", "Main deck's current list"]);
    // No plan or research: just the deck's own lists.
    expect(targetOptions({ id: "d9", name: "Other", version_id: null }, undefined).map((o) => o.id)).toEqual([CURRENT]);
  });

  it("reads a list's cards, set codes and sideboard aside, and a saved list with where your copies are", () => {
    const t = listTarget("x", "X", "Commander\n1 Rootha (STX) 1\n\nDeck\n1 Counterspell\n7 Island\n\nSideboard\n1 Mana Drain", [{ out: "Resculpt", in: "Counterspell", where: "Print, ordered." }]);
    expect(t.cards).toEqual([
      { name: "Rootha", qty: 1, commander: true, where: null },
      { name: "Counterspell", qty: 1, commander: false, where: "Print, ordered." },
      { name: "Island", qty: 7, commander: false, where: null },
    ]);
    const saved = cardsTarget("y", "Y", [
      { oracle_id: "a", name: "Sol Ring", qty: 1, board: "main", owned: 2, locations: { "Prismari box": 1, Spares: 1 }, proxies: 0 },
      { oracle_id: "b", name: "Mana Drain", qty: 1, board: "main", owned: 0, locations: {}, proxies: 1 },
      { oracle_id: "c", name: "Sideboard card", qty: 1, board: "side" },
    ], []);
    expect(saved.cards.map((c) => [c.name, c.where])).toEqual([["Sol Ring", "Yours, in Prismari box, Spares."], ["Mana Drain", "A proxy stands in for it."]]);
    expect(entryWhere({ owned: 0, proxies: 0 })).toBe("Not in your collection.");
    expect(entryWhere({ owned: 3, locations: { Spares: 3 } })).toBe("Yours, in Spares ×3.");
  });

  it("says where a research swap's card comes from without copy ids", () => {
    expect(researchWhere({ detail: "real: Spares. Copy yama:3ca0:0.", kind: "keep" })).toBe("Yours, in Spares.");
    expect(researchWhere({ detail: "real: Fantastic Four. Copy x. Transfer from Fantastic Four.", kind: "transfer", transfer: true, source_deck: "Fantastic Four" })).toBe("From Fantastic Four.");
    expect(researchWhere({ detail: "arrived_print: Arrived MPC order. Copy mpc:1.", kind: "arrived_print" })).toBe("A print that has arrived.");
    expect(researchWhere(undefined)).toBeNull();
  });

  it("knows the plan's planned swaps and bracket bags for the deck, not other decks' or retired ones", () => {
    const swap = (key: string, deck: string, out: string, inn: string, extra = {}) => ({ key, deck, stage: "planned", out, in: inn, src: "owned", got: null, retired: false, why: null, ...extra });
    const plan = {
      orders: [], stores: [],
      decks: [{ key: "prismari", name: "Prismari Artistry", owner_changes: [], bracket: { bags: { "3": [{ out: "Ancient Tomb", in: "Reliquary Tower" }] } } }, { key: "other", name: "Other", owner_changes: [], bracket: null }],
      swaps: [
        swap("a", "prismari", "Resculpt", "Counterspell"),
        swap("b", "prismari", "Opt", "Ponder", { retired: true }),
        swap("c", "prismari", "Shock", "Bolt", { stage: "proposed" }),
        swap("d", "other", "Duress", "Thoughtseize"),
      ],
    } as unknown as PlanBundle;
    const pool = swapPool(family, plan);
    expect(pool.map((p) => `${p.out}>${p.in}`)).toEqual(["Resculpt>Counterspell", "Resculpt>Counterspell", "Ancient Tomb>Reliquary Tower"]);
    expect(pool[1]!.where).toBe("A card you own.");
  });
});
