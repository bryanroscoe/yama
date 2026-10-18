import { describe, expect, it } from "vitest";
import { bottom, draw, expandDeck, newHand, rng } from "./goldfish";

const deck = expandDeck([
  { oracle_id: "cmdr", name: "Omo", qty: 1, board: "commander" },
  { oracle_id: "forest", name: "Forest", qty: 40, board: "main" },
  ...Array.from({ length: 59 }, (_, i) => ({ oracle_id: `c${i}`, name: `Card ${i}`, qty: 1, board: "main" })),
]);

describe("goldfish", () => {
  it("leaves the commander out and deals 7 from 99", () => {
    expect(deck).toHaveLength(99);
    const g = newHand(deck, rng(1));
    expect(g.hand).toHaveLength(7);
    expect(g.library).toHaveLength(92);
    expect([...g.hand, ...g.library].some((c) => c.name === "Omo")).toBe(false);
  });

  it("is reproducible from a seed", () => {
    expect(newHand(deck, rng(42)).hand).toEqual(newHand(deck, rng(42)).hand);
  });

  it("London mulligan with the first one free", () => {
    let g = newHand(deck, rng(3), 1);
    expect(g.toBottom).toBe(0);
    g = newHand(deck, rng(3), 2);
    expect(g.toBottom).toBe(1);
    g = bottom(g, 0);
    expect(g.hand).toHaveLength(6);
    expect(g.library).toHaveLength(93);
    expect(draw(g).hand).toHaveLength(7);
  });
});
