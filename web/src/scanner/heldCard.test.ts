import { describe, expect, it } from "vitest";
import { rectQuad } from "./image";
import { pickHeldQuad, quadArea, sameHeldCard } from "./heldCard";

describe("finding the held card by where it is", () => {
  it("measures a quad's area", () => {
    expect(quadArea(rectQuad(10, 20, 63, 88))).toBe(63 * 88);
  });

  it("prefers the large card in the middle over a small one or one at the edge", () => {
    const middle = rectQuad(400, 600, 300, 420);
    const small = rectQuad(500, 700, 100, 140);
    const edge = rectQuad(0, 0, 320, 450);
    expect(pickHeldQuad([small, edge, middle], 1080, 1920)).toBe(middle);
    expect(pickHeldQuad([], 1080, 1920)).toBeNull();
  });

  it("follows a card that drifts in the hand, and not one swapped in elsewhere or held much closer", () => {
    const held = rectQuad(400, 600, 300, 420);
    expect(sameHeldCard(held, rectQuad(430, 640, 310, 434))).toBe(true);
    expect(sameHeldCard(held, rectQuad(800, 1300, 300, 420))).toBe(false);
    expect(sameHeldCard(held, rectQuad(300, 450, 500, 700))).toBe(false);
  });
});
