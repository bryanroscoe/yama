import { describe, expect, it } from "vitest";
import { rectQuad } from "./image";
import { PEEK_REGION, peekSize } from "./peek";
import { WIDE_COLLECTOR_REGION } from "./pipeline";

describe("From your card", () => {
  it("cuts the text reader's wide corner, with the rarity line above it", () => {
    expect(PEEK_REGION).toMatchObject({ x0: WIDE_COLLECTOR_REGION.x0, x1: WIDE_COLLECTOR_REGION.x1, y1: WIDE_COLLECTOR_REGION.y1 });
    expect(PEEK_REGION.y0).toBeLessThan(WIDE_COLLECTOR_REGION.y0);
  });

  it("draws the corner at the card's own resolution in the frame, keeping its shape", () => {
    const { width, height } = peekSize(rectQuad(0, 0, 1000, 1397));
    expect(width).toBe(610);
    // 0.13 of the card's height over 0.61 of its width, on a 63 × 88 card.
    expect(height / width).toBeCloseTo((0.13 * 88) / (0.61 * 63), 2);
  });

  it("never draws a far card's corner below a readable minimum, or a close one past the sheet's need", () => {
    expect(peekSize(rectQuad(0, 0, 100, 140)).width).toBe(120);
    expect(peekSize(rectQuad(0, 0, 4000, 5587)).width).toBe(1200);
  });
});
