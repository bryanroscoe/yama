import { describe, expect, it } from "vitest";
import { buildFamilies, configurationLabel, duplexPages, exactChanges, familyKey, legacyConfiguration, printList, slotsText } from "./buildCatalog";
import type { ResearchBundle } from "../research/api";
import type { DeckSummary } from "../api";

const list = (commander = "Leader", lands = 99, extra = "") => `Commander\n1 ${commander}\n\nDeck\n${lands} Plains\n${extra}`;
const sorted = (cards: ReturnType<typeof printList>) => cards.map((c) => `${c.board}:${c.name}`).sort();

describe("exact reversible swap cards", () => {
  it("retains repeated basics and replaces only the exact quantity, in both directions", () => {
    const a = printList(list()), b = printList(list("Leader", 96, "2 Island\n1 Sol Ring"));
    const swaps = exactChanges(a, b);
    expect(swaps).toHaveLength(3);
    for (const [source, target, changes] of [[a, b, swaps], [b, a, swaps.map((s) => ({ in: s.out, out: s.in }))]] as const) {
      const copy = [...source];
      for (const s of changes) { const i = copy.findIndex((c) => c.name === s.out.name && c.board === s.out.board); expect(i).toBeGreaterThanOrEqual(0); copy.splice(i, 1); copy.push(s.in); }
      expect(sorted(copy)).toEqual(sorted(target));
    }
  });
  it("records commander/main board moves even when all card names match", () => {
    const a = printList(list("Leader", 98, "1 Partner"));
    const b = printList(list("Partner", 98, "1 Leader"));
    expect(exactChanges(a, b)).toHaveLength(2);
    expect(exactChanges(a, b).some((s) => s.out.board === "commander")).toBe(true);
  });
  it("blocks incomplete or unrecognised lists instead of silently dropping lines", () => {
    for (const text of [list("Leader", 98), list() + "\nSideboard\n1 Card", list() + "\ninvalid", "1 Leader\n99 Plains", list("Leader", 0)]) expect(() => printList(text)).toThrow();
  });
  it("ignores printing differences, and accepts canonical multiface names", () => {
    expect(exactChanges(printList(list("Leader (TST) 1", 98, "1 Front // Back (TST) 2 *F*")), printList(list("Leader", 98, "1 Front // Back")))).toEqual([]);
  });
  it("mirrors columns, preserves blank slots and pairs every continuation across multiple sheets", () => {
    const swaps = exactChanges(printList(list()), printList(`Commander\n1 Leader\nDeck\n99 Island`));
    const pages = duplexPages(swaps);
    expect(pages).toHaveLength(4);
    for (let i = 0; i < pages.length; i += 2) for (let j = 0; j < 9; j++) {
      const front = pages[i]![j], back = pages[i + 1]![Math.floor(j / 3) * 3 + 2 - j % 3];
      if (!front) expect(back).toBeNull();
      else { expect(back?.part).toBe(front.part); expect(back?.swaps).toEqual(front.swaps.map((s) => ({ in: s.out, out: s.in }))); }
    }
    expect(pages[2]?.filter(Boolean)).toHaveLength(8);
    expect(pages.filter((_, i) => i % 2 === 0).flat().filter(Boolean).reduce((n, c) => n + c!.swaps.length, 0)).toBe(99);
  });
  it("prints a no-change card and rejects invalid pagination", () => {
    expect(duplexPages([])[0]?.[0]?.swaps).toEqual([]);
    expect(() => duplexPages([], 0)).toThrow();
  });
});

describe("build catalog", () => {
  it("keeps current saved deck, original and legacy separate from research, without changing sources", () => {
    const research = { document: { id: "audit", title: "Audit", decks: [{ key: "scions-spellcraft", name: "Scions & Spellcraft", builds: [{ id: "current", label: "Current", list: list() }, ...[2, 3, 4].map((b) => ({ id: `b${b}`, label: `Bracket ${b}`, bracket: b, list: list() }))] }] }, revision: 2, updated_at: "2026-10-28" } as ResearchBundle;
    const deck = (id: string, parent_id: string | null, configuration: string | null) => ({ id, name: parent_id ? `Scions & Spellcraft (${configuration})` : "Scions & Spellcraft", parent_id, configuration, updated_at: "2026-10-30" }) as DeckSummary;
    const before = JSON.stringify(research);
    const f = buildFamilies([research], undefined, [deck("root", null, null), deck("stock", "root", "stock"), deck("old", "root", "after prints")]);
    expect(f).toHaveLength(1);
    expect(f[0]?.choices.filter((c) => c.kind === "bracket").map((c) => c.bracket)).toEqual([2, 3, 4]);
    expect(f[0]?.choices.filter((c) => c.kind === "current").map((c) => c.savedDeck)).toEqual(["root"]);
    expect(f[0]?.choices.find((c) => c.savedDeck === "stock")?.kind).toBe("original");
    expect(f[0]?.choices.filter((c) => c.kind === "legacy")).toHaveLength(2);
    expect(JSON.stringify(research)).toBe(before);
  });
  it("only hides historical labels, never the original or an arbitrary named build", () => {
    expect(legacyConfiguration("after prints")).toBe(true);
    expect(legacyConfiguration("Legacy: October upgrades")).toBe(true);
    for (const label of [null, "stock", "original", "[2]", "Bracket 4", "budget"]) expect(legacyConfiguration(label)).toBe(false);
    expect(configurationLabel("stock")).toBe("Original");
    expect(configurationLabel(null, true)).toBe("Current");
    expect(familyKey("Scions & Spellcraft")).toBe("scions-spellcraft");
  });
  it("serializes the full list including all basic copies", () => {
    expect(printList(slotsText([{ name: "Leader", qty: 1, board: "commander" }, { name: "Plains", qty: 99, board: "main" }]))).toHaveLength(100);
  });
});
