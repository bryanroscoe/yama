import { describe, expect, it } from "vitest";
import { sheetCardMatches, swapSheet, takeoutLines, type SheetData } from "./swapsheet";
import type { PlanDeck, PlanState, Slot, Swap } from "./types";

const slot = (name: string, extra: Partial<Slot> = {}): Slot => ({ name, qty: 1, board: "main", ...extra });
const state = (cards: Slot[]): PlanState => ({ id: "s", content_hash: "", computed_by: "test", updated_at: "", cards, log: [], unresolved: [] });
const deck = (key: string, now: Slot[], after: Slot[]): PlanDeck => ({
  key, name: key, sort: 0, source: "import", status: "active", product: null, commander: [], color_identity: null,
  owner_changes: [], bracket: null, groups: [], notes: [], deck_id: null, updated_at: "", states: { now: state(now), after: state(after) },
});
const swap: Swap = {
  key: "print", deck: "Alpha", stage: "planned", role: "swap", parent: null, src: "print", src_declared: null, store_label: null,
  in: "Fable of the Mirror-Breaker", out: "Original Cut", plan_card: null, later_out: null, after_print: false, tier: null, band: null,
  group: null, sort: 0, game_changer: null, got: null, order_item: null, print_order: null, listing: null,
  when: null, advice: null, why: "Makes Treasure and filters cards.", why_out: "Too slow.", note: null,
  upgrade: null, retired: false, retired_at: null, updated_at: "",
};
const data = (): SheetData => ({
  decks: [
    deck("Alpha", [slot("Zebra Stand-in", { kind: "standin", replaces: "Original Cut" }), slot("Forest", { qty: 3 })], [
      slot("Fable of the Mirror-Breaker", { kind: "print", replaces: "Original Cut", swap: "print" }),
      slot("Forest"), slot("Beta Print", { qty: 2, kind: "print", replaces: "Forest" }),
    ]),
    deck("Beta", [slot("A Cut")], [slot("New Card", { kind: "print", replaces: "A Cut" })]),
    deck("No changes", [slot("Keep")], [slot("Keep")]),
  ],
  swaps: [swap], game_changers: null, marks: {},
  names: { "Fable of the Mirror-Breaker": "fable" },
  cards: { fable: { name: "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", type_line: "Enchantment", cmc: 3, color_identity: "R", layout: "transform", image_small: null, image_art_crop: null, faces: [] } },
});

describe("takeout sheets and card checks", () => {
  it("sorts by the actual outgoing card and preserves repeated copies and their destinations", () => {
    const sheet = swapSheet(data());
    expect(takeoutLines(sheet).map(({ deck, step: s }) => [deck.key, s.out, s.in, s.to])).toEqual([
      ["Beta", "A Cut", "New Card", "spares"],
      ["Alpha", "Forest", "Beta Print", "basics"],
      ["Alpha", "Forest", "Beta Print", "basics"],
      ["Alpha", "Zebra Stand-in", "Fable of the Mirror-Breaker", "spares"],
    ]);
    expect(takeoutLines(sheet, "Alpha")).toHaveLength(3);
    expect(takeoutLines(sheet, "No changes")).toEqual([]);
    // Sorting a takeout sheet doesn't change the original incoming-card order.
    expect(sheet.decks[0]!.steps[0]!.in).toBe("Beta Print");
  });

  it("recognizes either face of an incoming card and the stand-in actually coming out", () => {
    const b = data();
    const sheet = swapSheet(b);
    for (const name of ["Fable of the Mirror-Breaker", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki", "reflection of kiki-jiki"]) {
      expect(sheetCardMatches(sheet, b, name).map((m) => [m.deck.key, m.side, m.step.out, m.step.swap?.why])).toEqual([
        ["Alpha", "in", "Zebra Stand-in", "Makes Treasure and filters cards."],
      ]);
    }
    expect(sheetCardMatches(sheet, b, "Zebra Stand-in")[0]?.side).toBe("out");
    expect(sheetCardMatches(sheet, b, "Original Cut")).toEqual([]);
    expect(sheetCardMatches(sheet, b, "Keep")).toEqual([]);
    expect(sheetCardMatches(sheet, b, "Fable of the Mirror-Breaker", "Beta")).toEqual([]);
    expect(sheetCardMatches(sheet, b, "")).toEqual([]);
  });

  it("returns all decks and both sides of a card moving between them, including installed status", () => {
    const b = data();
    b.decks = [deck("Giver", [slot("Travelling Card")], [slot("Replacement", { kind: "print", replaces: "Travelling Card", swap: "print" })]),
      deck("Taker", [slot("Cut")], [slot("Travelling Card", { kind: "moved", from_deck: "Giver", replaces: "Cut" })])];
    b.marks.print = { installed: { value: true, at: "2026-10-25T12:00:00Z", payload: {} } };
    const matches = sheetCardMatches(swapSheet(b), b, "Travelling Card");
    expect(matches.map((m) => [m.deck.key, m.side, m.step.to])).toEqual([["Giver", "out", "deck"], ["Taker", "in", "spares"]]);
    expect(matches[0]!.step.toDeck?.key).toBe("Taker");
    expect(matches[0]!.step.installed).toBe(true);
  });

  it("keeps a standalone card separate from an adventure with the same face title", () => {
    const b = data();
    b.decks = [deck("Alpha", [slot("Brainstorm")], [slot("New Card", { kind: "print", replaces: "Brainstorm" })])];
    b.names.Brainstorm = "brainstorm";
    b.cards.brainstorm = { ...b.cards.fable!, name: "Brainstorm" };
    const sheet = swapSheet(b);
    expect(sheetCardMatches(sheet, b, "Brainstorm")).toHaveLength(1);
    expect(sheetCardMatches(sheet, b, "Harmonized Trio // Brainstorm")).toEqual([]);
  });
});
