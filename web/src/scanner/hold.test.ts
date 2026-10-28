import { describe, expect, it } from "vitest";
import { hold, holdRead } from "./hold";

const A = { name: "A", confidence: 0.9 };
const B = { name: "B", confidence: 0.9 };
const weakB = { name: "B", confidence: 0.6 };
type Read = typeof A | undefined;
/** Reads one second apart. */
const run = (reads: Read[], emptyFrees: boolean) => {
  const h = hold("A", 0);
  return reads.map((r, i) => holdRead(h, r, (i + 1) * 1000, emptyFrees));
};

describe("holding a card added by its text", () => {
  it("ignores the held card, single misreads and empty reads", () => {
    expect(run([A, undefined, A, weakB, A, undefined, undefined, A], true)).toEqual(Array(8).fill("held"));
  });
  it("isn't freed by an OCR miss between wrong-orientation reads", () => {
    // Upside down (nothing), upright miss, upside down (nothing), then upright A again.
    expect(run([undefined, undefined, undefined, A], true)).toEqual(Array(4).fill("held"));
  });
  it("with the card detector, empty reads never free it (the card leaving the view does)", () => {
    expect(run(Array(10).fill(undefined), false)).toEqual(Array(10).fill("held"));
  });
  it("in text-only mode, frees after enough empty reads with the card unseen", () => {
    expect(run([undefined, undefined, undefined, undefined], true)).toEqual(["held", "held", "held", "free"]);
  });
  it("frees for another card read twice, even with empty reads between", () => {
    expect(run([B, undefined, B], true)).toEqual(["held", "held", "free"]);
    expect(run([B, undefined, B], false)).toEqual(["held", "held", "free"]);
    expect(run([{ name: "B", confidence: 0.97 }], false)).toEqual(["free"]);
  });
  it("starts over when the held card is read again, or a third card", () => {
    expect(run([weakB, A, weakB], false)).toEqual(["held", "held", "held"]);
    expect(run([weakB, { name: "C", confidence: 0.6 }, weakB], false)).toEqual(["held", "held", "held"]);
  });
});
