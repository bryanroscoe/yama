import { describe, expect, it } from "vitest";
import { alignCorners, EASE_MS, FADE_IN_MS, FADE_OUT_MS, MAX_OUTLINES, OutlineTracker, outlinePath } from "./outline";
import type { Quad } from "./types";

// The outline over each card the finder sees (outline.ts): it fades in and out, glides between the
// finder's passes at the screen's rate, and never spins when the finder's "top" flips.

const card = (x: number, y: number, w = 126, h = 176): Quad => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

describe("the outline tracker", () => {
  it("fades a card in from nothing, where the finder placed it", () => {
    const t = new OutlineTracker();
    t.see([card(100, 100)], { w: 1920, h: 1080 });
    expect(t.size).toEqual({ w: 1920, h: 1080 });
    let f = t.frame(0);
    expect(f).toHaveLength(1);
    expect(f[0]!.quad).toEqual(card(100, 100));
    expect(f[0]!.opacity).toBeGreaterThan(0);
    expect(f[0]!.opacity).toBeLessThan(0.5);
    f = t.frame(FADE_IN_MS / 2);
    expect(f[0]!.opacity).toBeGreaterThan(0.5);
    f = t.frame(FADE_IN_MS * 2);
    expect(f[0]!.opacity).toBe(1);
  });

  it("glides towards the next pass's corners between passes, never past them", () => {
    const t = new OutlineTracker();
    t.see([card(100, 100)]);
    t.frame(0);
    t.see([card(160, 100)]);
    const xs: number[] = [];
    for (let now = 16; now <= 16 * 30; now += 16) xs.push(t.frame(now)[0]!.quad[0][0]);
    // Every screen frame is closer than the last, and it ends there.
    for (let i = 1; i < xs.length; i += 1) expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!);
    expect(xs[0]!).toBeGreaterThan(100);
    expect(xs[0]!).toBeLessThan(160);
    expect(xs[xs.length - 1]!).toBeGreaterThan(159);
    expect(Math.max(...xs)).toBeLessThanOrEqual(160);
    // About two thirds of the way after EASE_MS.
    const u = new OutlineTracker();
    u.see([card(0, 0)]);
    u.frame(0);
    u.see([card(100, 0)]);
    expect(u.frame(EASE_MS)[0]!.quad[0][0]).toBeCloseTo(63.2, 0);
  });

  it("fades out when the card goes, then is gone and idle", () => {
    const t = new OutlineTracker();
    t.see([card(100, 100)]);
    t.frame(0);
    t.frame(FADE_IN_MS * 2);
    t.see([]);
    const half = t.frame(FADE_IN_MS * 2 + FADE_OUT_MS / 2);
    expect(half).toHaveLength(1);
    expect(half[0]!.opacity).toBeGreaterThan(0.2);
    expect(half[0]!.opacity).toBeLessThan(0.8);
    expect(t.active).toBe(true);
    // (Steps are capped at 100 ms, so a hidden tab's gap doesn't jump.)
    t.frame(FADE_IN_MS * 2 + FADE_OUT_MS / 2 + 100);
    expect(t.frame(FADE_IN_MS * 2 + FADE_OUT_MS / 2 + 200)).toEqual([]);
    expect(t.active).toBe(false);
  });

  it("comes back in from where it faded to, if the card is seen again", () => {
    const t = new OutlineTracker();
    t.see([card(100, 100)]);
    t.frame(0);
    t.frame(200);
    t.see([]);
    const low = t.frame(300)[0]!.opacity;
    t.see([card(104, 100)]);
    const f = t.frame(316);
    expect(f).toHaveLength(1);
    expect(f[0]!.opacity).toBeGreaterThan(low);
  });

  it("keeps each of several cards its own outline, and starts a new one for a card somewhere else", () => {
    const t = new OutlineTracker();
    t.see([card(0, 0), card(400, 0)]);
    t.frame(0);
    t.frame(300);
    // Reported in the other order, each moved a little: no outline crosses to the other card.
    t.see([card(410, 0), card(8, 0)]);
    const f = t.frame(316);
    expect(f).toHaveLength(2);
    expect(f[0]!.quad[0][0]).toBeLessThan(20);
    expect(f[1]!.quad[0][0]).toBeGreaterThan(390);
    // A card far from both is a new outline, fading in, while the two it replaces fade out.
    t.see([card(900, 500)]);
    const g = t.frame(332);
    expect(g).toHaveLength(3);
    expect(g[2]!.quad[0]).toEqual([900, 500]);
    expect(g[2]!.opacity).toBeLessThan(0.3);
  });

  it(`draws at most ${MAX_OUTLINES} cards, and ignores corners that aren't numbers`, () => {
    const t = new OutlineTracker();
    t.see([card(0, 0), card(200, 0), card(400, 0), card(600, 0), card(800, 0), [[NaN, 0], [1, 0], [1, 1], [0, 1]]]);
    expect(t.frame(0)).toHaveLength(MAX_OUTLINES);
  });

  it("doesn't spin when the finder calls another corner the top", () => {
    const q = card(100, 100);
    const turned: Quad = [q[2], q[3], q[0], q[1]];
    expect(alignCorners(turned, q)).toEqual(q);
    const t = new OutlineTracker();
    t.see([q]);
    t.frame(0);
    t.see([turned]);
    // Already where it's going: nothing moves.
    expect(t.frame(16)[0]!.quad).toEqual(q);
  });

  it("neither eases nor fades with reduced motion", () => {
    const t = new OutlineTracker();
    t.still = true;
    t.see([card(0, 0)]);
    expect(t.frame(0)[0]!.opacity).toBe(1);
    t.see([card(50, 0)]);
    expect(t.frame(16)[0]!.quad[0][0]).toBe(50);
    t.see([]);
    expect(t.frame(32)).toEqual([]);
  });

  it("wakes whoever draws it when there's something to draw", () => {
    const t = new OutlineTracker();
    let woke = 0;
    t.onWake = () => (woke += 1);
    t.see([]);
    expect(woke).toBe(0);
    t.see([card(0, 0)]);
    expect(woke).toBe(1);
  });
});

describe("the outline's shape", () => {
  it("is four corner marks, each a curve through its corner with two short arms", () => {
    const d = outlinePath(card(100, 100, 100, 140));
    expect(d.match(/M/g)).toHaveLength(4);
    expect(d.match(/Q/g)).toHaveLength(4);
    expect(d).not.toContain("Z");
    // The top-left mark: up the left edge to the rounding, round the corner, along the top edge.
    expect(d.startsWith("M100 120L100 105Q100 100 105 100L120 100")).toBe(true);
  });

  it("can be the whole rounded outline", () => {
    const d = outlinePath(card(0, 0, 100, 140), "whole");
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.match(/Q/g)).toHaveLength(4);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("is nothing for a quad with no size", () => {
    expect(outlinePath([[5, 5], [5, 5], [5, 5], [5, 5]])).toBe("");
  });
});
