import { describe, expect, it } from "vitest";
import { swapCard, swapCardPages, swapCards } from "./swapcards";
import type { Bracket, PlanDeck } from "./types";

const deck = (key: string, bracket: Bracket | null, extra: Partial<PlanDeck> = {}): PlanDeck => ({
  key, name: `${key} deck`, sort: 0, source: "import", status: "active", product: null, commander: ["Quintorius, History Chaser"],
  color_identity: null, owner_changes: [], bracket, groups: [], notes: [], deck_id: null, updated_at: "", states: {}, ...extra,
});
const bag = (out: string, inn: string) => ({ out, in: inn, from: "Came in this precon" });

describe("bracket swap cards", () => {
  it("steps down from the full build, skipping empty bags, with the box bracket and extras", () => {
    // Lorehold as exported on 2026-10-29: built at 3, kept at 2, an empty Bracket 3 bag.
    const card = swapCard(
      deck("lorehold", {
        target: 3, box: 2,
        bags: { "3": [], "2": [bag("Teferi's Protection", "Clever Concealment"), bag("The One Ring", "Thrilling Discovery")] },
        extras: ["Smothering Tithe", "Esper Sentinel"],
        game_changers: { "3": ["Teferi's Protection", "The One Ring"] },
      }),
      ["Smothering Tithe"],
    )!;
    expect(card.box).toBe(2);
    expect(card.commander).toBe("Quintorius, History Chaser");
    expect(card.steps).toEqual([{
      from: 3, to: 2, swaps: [
        { out: "Teferi's Protection", in: "Clever Concealment", outGc: true, inGc: false },
        { out: "The One Ring", in: "Thrilling Discovery", outGc: true, inGc: false },
      ],
    }]);
    expect(card.extras).toEqual([{ name: "Smothering Tithe", gc: true }, { name: "Esper Sentinel", gc: false }]);
  });

  it("names each step from the bracket before it, and the box defaults to the full build", () => {
    // Fantastic Four: the Bracket 3 bag is empty, so its only step still reads 3 → 2, as the reference card does.
    const ff = swapCard(deck("ff", { target: 4, bags: { "2": [bag("Teferi's Protection", "Lightning Greaves")], "3": [] } }))!;
    expect(ff.box).toBe(4);
    expect(ff.steps.map((s) => [s.from, s.to])).toEqual([[3, 2]]);
    expect(ff.extras).toEqual([]);
    const full = swapCard(deck("riders", { target: 4, bags: { "3": [bag("Rhystic Study", "Call for Aid")], "2": [bag("The One Ring", "Vanquisher's Banner")] } }), ["Rhystic Study"])!;
    expect(full.steps.map((s) => [s.from, s.to, s.swaps[0]!.outGc])).toEqual([[4, 3, true], [3, 2, false]]);
    expect(swapCard(deck("none", {}))).toMatchObject({ target: 4, box: 4, steps: [] });
  });

  it("joins partner commanders and skips decks without a bracket plan or not active", () => {
    const cards = swapCards({
      game_changers: null,
      decks: [
        deck("a", { target: 3 }, { commander: ["Reed Richards", "Sue Storm"] }),
        deck("b", null),
        deck("c", { target: 3 }, { status: "proposals_only" }),
      ],
    });
    expect(cards.map((c) => [c.key, c.commander])).toEqual([["a", "Reed Richards & Sue Storm"]]);
  });

  it("lays out nine cards to a page", () => {
    expect(swapCardPages([...Array(10).keys()]).map((p) => p.length)).toEqual([9, 1]);
    expect(swapCardPages([])).toEqual([]);
  });
});
