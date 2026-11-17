import { describe, expect, it } from "vitest";
import { allowedTarget, dropIndex, landing, shifts, type Box } from "./reorder";

// Three trigger rows, 80 px tall with an 8 px gap, the middle one taller (longer Oracle text).
const rows: Box[] = [
  { left: 0, top: 0, width: 600, height: 80 },
  { left: 0, top: 88, width: 600, height: 120 },
  { left: 0, top: 216, width: 600, height: 80 },
];

// Cards in a wrapping row: three to a row, 180 x 250 with 16 px gaps.
const card = (k: number): Box => ({ left: (k % 3) * 196, top: Math.floor(k / 3) * 266, width: 180, height: 250 });
const cards: Box[] = [0, 1, 2, 3, 4].map(card);

describe("where a dragged row lands", () => {
  it("stays put until the pointer passes a neighbour's middle", () => {
    expect(dropIndex(rows, 0, 10, 40, "y")).toBe(0);
    expect(dropIndex(rows, 0, 10, 147, "y")).toBe(0);
    expect(dropIndex(rows, 0, 10, 149, "y")).toBe(1);
  });
  it("goes first or last however far past the ends it's dropped", () => {
    expect(dropIndex(rows, 2, 10, -500, "y")).toBe(0);
    expect(dropIndex(rows, 0, 10, 5000, "y")).toBe(2);
    expect(dropIndex(rows, 1, 10, 5000, "y")).toBe(2);
    expect(dropIndex(rows, 1, 10, -5, "y")).toBe(0);
  });
  it("reads only up and down in a column", () => {
    expect(dropIndex(rows, 2, -900, 100, "y")).toBe(1);
    expect(dropIndex(rows, 2, 9000, 100, "y")).toBe(1);
  });
  it("lands anywhere in the middle", () => {
    expect(dropIndex(rows, 0, 0, 260, "y")).toBe(2);
    expect(dropIndex(rows, 2, 0, 60, "y")).toBe(1);
  });
  it("has one place in a list of one", () => {
    expect(dropIndex([rows[0]!], 0, 0, 900, "y")).toBe(0);
  });
});

describe("where a dragged card lands in a wrapping row", () => {
  it("counts the cards it's past on its own row", () => {
    expect(dropIndex(cards, 0, 300, 100, "x")).toBe(1);
    expect(dropIndex(cards, 0, 500, 100, "x")).toBe(2);
    expect(dropIndex(cards, 2, 10, 100, "x")).toBe(0);
  });
  it("counts every card on the rows above", () => {
    expect(dropIndex(cards, 0, 10, 300, "x")).toBe(2);
    expect(dropIndex(cards, 0, 200, 300, "x")).toBe(3);
    expect(dropIndex(cards, 4, 10, 10, "x")).toBe(0);
  });
  it("treats above and below the list as its first and last rows", () => {
    expect(dropIndex(cards, 4, 200, -400, "x")).toBe(1);
    expect(dropIndex(cards, 0, 9000, 9000, "x")).toBe(4);
    expect(dropIndex(cards, 0, 10, 9000, "x")).toBe(2);
  });
  it("only reads across in a single row, wherever the pointer is up or down", () => {
    const hand = [0, 1, 2, 3].map((k) => ({ left: k * 132, top: 0, width: 120, height: 168 }));
    expect(dropIndex(hand, 0, 350, -200, "x")).toBe(2);
    expect(dropIndex(hand, 0, 350, 600, "x")).toBe(2);
    expect(dropIndex(hand, 3, -50, 600, "x")).toBe(0);
    expect(dropIndex(hand, 0, 9000, 80, "x")).toBe(3);
  });
});

describe("a drop that can't cross a split pile", () => {
  // Top two stay on top, the rest stay on the bottom.
  const canMove = (from: number, to: number) => from < 2 === to < 2;
  it("stops at the edge of its own pile", () => {
    expect(allowedTarget(0, 4, canMove)).toBe(1);
    expect(allowedTarget(4, 0, canMove)).toBe(2);
    expect(allowedTarget(3, 2, canMove)).toBe(2);
    expect(allowedTarget(1, 0, canMove)).toBe(0);
  });
  it("goes anywhere with no rule", () => {
    expect(allowedTarget(0, 4)).toBe(4);
  });
});

describe("the others sliding aside", () => {
  it("moves the rows in between by the dragged row's height and the gap", () => {
    expect(shifts(rows, 0, 2, "y")).toEqual([{ dx: 0, dy: 0 }, { dx: 0, dy: -88 }, { dx: 0, dy: -88 }]);
    expect(shifts(rows, 2, 0, "y")).toEqual([{ dx: 0, dy: 88 }, { dx: 0, dy: 88 }, { dx: 0, dy: 0 }]);
    expect(shifts(rows, 1, 0, "y")).toEqual([{ dx: 0, dy: 128 }, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  });
  it("moves a row past a split marker between two places, not on top of it", () => {
    // Telling Time on a phone: two rows on top, a 40 px "Bottom of your library" line, two below.
    const split: Box[] = [0, 1, 2, 3].map((k) => ({ left: 0, top: k * 88 + (k >= 2 ? 40 : 0), width: 360, height: 80 }));
    // The first row dropped last: the second goes up into the first place, the third up above
    // the line into the second, the fourth up under the line.
    expect(shifts(split, 0, 3, "y").map((s) => s.dy)).toEqual([0, -88, -128, -88]);
    expect(landing(split, 0, 3, "y").top).toBe(304);
    expect(shifts(split, 3, 0, "y").map((s) => s.dy)).toEqual([88, 128, 88, 0]);
  });
  it("leaves everything still when it's back where it started", () => {
    expect(shifts(rows, 1, 1, "y").every((s) => s.dx === 0 && s.dy === 0)).toBe(true);
  });
  it("moves cards into the next slot, across a wrap", () => {
    const s = shifts(cards, 4, 1, "x");
    expect(s[1]).toEqual({ dx: 196, dy: 0 });
    expect(s[2]).toEqual({ dx: -392, dy: 266 });
    expect(s[3]).toEqual({ dx: 196, dy: 0 });
    expect(s[0]).toEqual({ dx: 0, dy: 0 });
  });
});

describe("the drop marker", () => {
  it("sits at the top of the first row or the bottom of the last", () => {
    expect(landing(rows, 2, 0, "y")).toEqual({ left: 0, top: 0, width: 600, height: 80 });
    expect(landing(rows, 0, 2, "y")).toEqual({ left: 0, top: 216, width: 600, height: 80 });
    expect(landing(rows, 0, 1, "y")).toEqual({ left: 0, top: 128, width: 600, height: 80 });
  });
  it("takes a card's slot", () => {
    expect(landing(cards, 0, 4, "x")).toEqual(card(4));
  });
});
