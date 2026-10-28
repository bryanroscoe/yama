import { describe, expect, it } from "vitest";
import { hold, holdRead } from "./hold";

const A = { name: "A", confidence: 0.9 };
const weakB = { name: "B", confidence: 0.6 };

describe("holding a card added by its text", () => {
  it("ignores the held card, and single misses or misreads", () => {
    const h = hold("A");
    expect([A, undefined, A, weakB, A, undefined, undefined, A].map((r) => holdRead(h, r))).toEqual(Array(8).fill("held"));
  });
  it("lets go after three empty reads in a row", () => {
    const h = hold("A");
    expect([undefined, undefined, undefined].map((r) => holdRead(h, r))).toEqual(["held", "held", "free"]);
  });
  it("lets go for another card read twice in a row, or once near-certainly", () => {
    const h = hold("A");
    expect([weakB, weakB].map((r) => holdRead(h, r))).toEqual(["held", "free"]);
    expect(holdRead(hold("A"), { name: "B", confidence: 0.97 })).toBe("free");
    const g = hold("A");
    expect([weakB, { name: "C", confidence: 0.6 }, weakB].map((r) => holdRead(g, r))).toEqual(["held", "held", "held"]);
  });
});
