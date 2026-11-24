import { describe, expect, it } from "vitest";
import { cardShaped, quadShape } from "./cardShape";
import { rectQuad } from "./image";
import type { Quad } from "./types";

describe("only a card-shaped outline is a card (cardShape.ts)", () => {
  it("takes a card, upright, sideways, turned and in perspective", () => {
    expect(cardShaped(rectQuad(10, 10, 630, 880))).toBe(true);
    expect(cardShaped(rectQuad(10, 10, 880, 630))).toBe(true);
    // Tilted away (the far side shorter), as a card held at an angle.
    const tilted: Quad = [[120, 100], [520, 100], [600, 700], [40, 700]];
    expect(quadShape(tilted).convex).toBe(true);
    expect(cardShaped(tilted)).toBe(true);
    // Turned 30 degrees.
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    const turned = rectQuad(-315, -440, 630, 880).map(([x, y]) => [500 + x * c - y * s, 500 + x * s + y * c]) as Quad;
    expect(cardShaped(turned)).toBe(true);
  });

  it("refuses a column of overlapping cards, a sliver, a square and a crossed outline", () => {
    // A column of cards outlined as one: 1.9 to 1.
    expect(cardShaped(rectQuad(0, 0, 630, 1200))).toBe(false);
    // A sliver, as behind Bryan's Whiteout misread (about 12 to 1).
    const sliver: Quad = [[100, 100], [700, 120], [705, 160], [104, 130]];
    expect(quadShape(sliver).ratio).toBeGreaterThan(10);
    expect(cardShaped(sliver)).toBe(false);
    // Card-like sides, but a corner of about 52 degrees.
    const sharp: Quad = [[0, 0], [630, 500], [600, 880], [0, 880]];
    const sh = quadShape(sharp);
    expect(sh.convex).toBe(true);
    expect(sh.ratio).toBeGreaterThan(1.1);
    expect(sh.minAngle).toBeLessThan(55);
    expect(cardShaped(sharp)).toBe(false);
    expect(cardShaped(rectQuad(0, 0, 500, 500))).toBe(false);
    const crossed: Quad = [[0, 0], [630, 880], [630, 0], [0, 880]];
    expect(quadShape(crossed).convex).toBe(false);
    expect(cardShaped(crossed)).toBe(false);
    // Concave, with card-like sides and no corner under 55 degrees: refused for that alone (Codex review of #213).
    const dent: Quad = [[49, 138], [377, 767], [487, 588], [798, 169]];
    const d = quadShape(dent);
    expect(d.convex).toBe(false);
    expect(d.ratio).toBeGreaterThan(1.1);
    expect(d.ratio).toBeLessThan(1.8);
    expect(d.minAngle).toBeGreaterThanOrEqual(55);
    expect(cardShaped(dent)).toBe(false);
  });
});
