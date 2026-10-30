import { describe, expect, it } from "vitest";
import { buildFamilies, buildTargets, resolveBuildFamily, configurationLabel, duplexPages, exactChanges, legacyConfiguration, printList, slotsText } from "./buildCatalog";
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
  it("accepts colon-suffixed research sections without relaxing unknown-line or count checks", () => {
    const plain = printList(list());
    for (const deck of ["Deck:", "Mainboard:"]) {
      expect(printList(`Commander:\n1 Leader\n${deck}\n99 Plains`)).toEqual(plain);
    }
    expect(() => printList("Commander:\n1 Leader\nDeck:\n98 Plains")).toThrow();
    expect(() => printList(list() + "\nUnexpected:")).toThrow();
    expect(() => printList(list() + "\nSideboard:\n1 Card")).toThrow();
  });
  it("ignores printing differences, and accepts canonical multiface names", () => {
    expect(exactChanges(printList(list("Leader (TST) 1", 98, "1 Front // Back (TST) 2 *F*")), printList(list("Leader", 98, "1 Front // Back")))).toEqual([]);
  });
  it("treats front-only and canonical multiface names as the same physical card", () => {
    const front = printList(list("Leader", 97, "1 Fable of the Mirror-Breaker\n1 Ojer Taq, Deepest Foundation"));
    const both = printList(list("Leader", 97, "1 Fable of the Mirror-Breaker // Reflection of Kiki-Jiki\n1 Ojer Taq, Deepest Foundation // Temple of Civilization"));
    expect(exactChanges(front, both)).toEqual([]);
    expect(exactChanges(both, front)).toEqual([]);
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
  it("only marks explicitly allocated research as buildable now; bracket labels are not ownership proof", () => {
    const report = { document: { id: "owned", title: "Owned", decks: [{ key: "deck", name: "Deck", builds: [
      { id: "b2", label: "Bracket 2", bracket: 2, list: list(), acquisition: { track: "owned_now" } },
      { id: "b3", label: "Bracket 3", bracket: 3, list: list() },
    ] }] }, revision: 1, updated_at: "2026-10-30" } as ResearchBundle;
    const f = buildFamilies([report], undefined, []);
    expect(f[0]?.choices.map((c) => c.track)).toEqual(["owned_now", "aspirational"]);
  });

  it("only hides historical labels, never the original or an arbitrary named build", () => {
    expect(legacyConfiguration("after prints")).toBe(true);
    expect(legacyConfiguration("Legacy: October upgrades")).toBe(true);
    for (const label of [null, "stock", "original", "[2]", "Bracket 4", "budget"]) expect(legacyConfiguration(label)).toBe(false);
    expect(configurationLabel("stock", "Deck")).toBe("Original");
    expect(configurationLabel(null, "Deck", true)).toBe("Current");
  });
  it("preserves distinct deck names after child configuration labels are cleared", () => {
    expect(["Combat version", "Combo version"].map((name) => configurationLabel(null, name))).toEqual(["Combat version", "Combo version"]);
    expect(configurationLabel("", "Combat version")).toBe("Combat version");
    expect(configurationLabel("   ", "Combat version")).toBe("Combat version");
    expect(configurationLabel("[3]", "Combat version")).toBe("[3]");
    expect(configurationLabel(null, "Main deck", true)).toBe("Current");
  });
  it("preserves unequal family names and resolves a renamed linked deck by saved id", () => {
    const report = { document: { id: "audit", title: "Audit", decks: ["Scions & Spellcraft", "Scions Spellcraft"].map((name) => ({ key: name, name, builds: [{ id: "b2", bracket: 2, label: "[2] Buildable now", list: list() }] })) }, revision: 1, updated_at: "2026-10-30" } as ResearchBundle;
    const saved = { id: "saved-1", name: "My renamed deck", parent_id: null, configuration: null, updated_at: "2026-10-30" } as DeckSummary;
    const plan = { decks: [{ key: "scions", name: "Scions & Spellcraft", yama_deck: { id: saved.id }, states: {} }] } as unknown as Parameters<typeof buildFamilies>[1];
    const families = buildFamilies([report], plan, [saved]);
    expect(families).toHaveLength(2);
    expect(resolveBuildFamily(families, null, saved.id)?.name).toBe("Scions & Spellcraft");
    expect(resolveBuildFamily(families, "Scions Spellcraft", null)?.choices).toHaveLength(1);
    expect(families[0]?.choices[0]?.label).toBe("[2] Buildable now");
  });
  it("keeps plan-only and saved-only targets available without claiming ownership", () => {
    const decks = [
      { id: "root", name: "Deck", parent_id: null, configuration: null, updated_at: "2026-10-30" },
      { id: "b2", name: "Deck [2]", parent_id: "root", configuration: "[2]", bracket: 2, updated_at: "2026-10-30" },
    ] as DeckSummary[];
    const choices = buildFamilies([], undefined, decks)[0]!.choices;
    expect(buildTargets(choices, "owned_now")).toEqual([]);
    expect(buildTargets(choices, "aspirational")).toEqual([]);
    expect(buildTargets(choices, "saved").map((c) => c.savedDeck)).toEqual(["root", "b2"]);
    const planChoice = { ...choices[1]!, id: "plan:deck:b2", savedDeck: undefined };
    expect(buildTargets([planChoice], "saved")).toEqual([planChoice]);
    expect(buildTargets([planChoice], "owned_now")).toEqual([]);
  });
  it("keeps same-name saved roots and their configurations separate, with ambiguous research unlinked", () => {
    const decks = [
      { id: "a", name: "Twins", parent_id: null }, { id: "b", name: "Twins", parent_id: null },
      { id: "a2", name: "Twins [2]", parent_id: "a", configuration: "[2]" },
    ].map((d) => ({ configuration: null, updated_at: "2026-10-30", ...d })) as DeckSummary[];
    const report = { document: { id: "audit", title: "Audit", decks: [{ key: "twins", name: "Twins", builds: [{ id: "b2", bracket: 2, label: "B2", list: list() }] }] }, revision: 1, updated_at: "2026-10-30" } as ResearchBundle;
    const families = buildFamilies([report], undefined, decks);
    expect(families).toHaveLength(3);
    expect(resolveBuildFamily(families, null, "a")?.choices.map((c) => c.savedDeck)).toEqual(["a", "a2"]);
    expect(resolveBuildFamily(families, null, "b")?.choices.map((c) => c.savedDeck)).toEqual(["b"]);
    expect(resolveBuildFamily(families, "Twins", null)).toBeUndefined();
    expect(families.find((f) => f.key.startsWith("research:"))?.choices).toHaveLength(1);
    expect(buildFamilies([report], undefined, [...decks].reverse()).map((f) => f.key)).toEqual(families.map((f) => f.key));
  });
  it("follows explicit plan links among duplicate names and keeps unlinked plans distinct", () => {
    const decks = ["a", "b"].map((id) => ({ id, name: "Twins", parent_id: null, configuration: null, updated_at: "2026-10-30" })) as DeckSummary[];
    const plan = { decks: [
      { key: "first", name: "Twins", yama_deck: { id: "a" }, states: {} },
      { key: "second", name: "Twins", deck_id: "b", states: {} },
      { key: "unlinked", name: "Twins", states: {} },
    ] } as unknown as Parameters<typeof buildFamilies>[1];
    const families = buildFamilies([], plan, decks);
    expect(families).toHaveLength(3);
    expect(resolveBuildFamily(families, null, null, "first")?.key).toBe("saved:a");
    expect(resolveBuildFamily(families, null, null, "second")?.key).toBe("saved:b");
    expect(resolveBuildFamily(families, null, null, "unlinked")?.key).toBe("plan:unlinked");
    expect(resolveBuildFamily(families, "Twins", null)).toBeUndefined();
  });
  it("scopes unlinked research by report even when names and deck keys are identical", () => {
    const report = (id: string) => ({ document: { id, title: "Same title", decks: [{ key: "same-key", name: "Same name", builds: [{ id: "b2", label: "B2", bracket: 2, list: list(id) }] }] }, revision: 1, updated_at: "2026-10-30" }) as ResearchBundle;
    const families = buildFamilies([report("first"), report("second")], undefined, []);
    expect(families).toHaveLength(2);
    expect(new Set(families.map((f) => f.detail)).size).toBe(2);
    expect(families.map((f) => f.choices.length)).toEqual([1, 1]);
    expect(resolveBuildFamily(families, "Same name", null)).toBeUndefined();
    for (const family of families) expect(resolveBuildFamily(families, family.key, null)).toBe(family);
  });
  it("serializes the full list including all basic copies", () => {
    expect(printList(slotsText([{ name: "Leader", qty: 1, board: "commander" }, { name: "Plains", qty: 99, board: "main" }]))).toHaveLength(100);
  });
});
