import { describe, expect, it } from "vitest";
import { AUTO_MAX, AutoZoom, autoCeiling, CLOSE_MAX, CLOSE_MS, closeupZoom, LENS_SWITCH, LOST_FRAMES, LOST_MS, maySwitchLens, STEADY, STEP_MS, WIDE_AFTER_MS, WIDE_BACK_MS, WIDE_GLARE_MS, WIDE_MAX_MS, WideOnStruggle } from "./zoomPolicy";
import { cardHeight, LETTER_SHARE, letterPx, tooFar } from "./closer";
import { rectQuad } from "./image";

describe("auto-zoom", () => {
  it("never goes past the lens-switch cap, or under 1×", () => {
    expect(autoCeiling({ min: 1, max: 10 })).toBe(AUTO_MAX);
    expect(autoCeiling({ min: 1, max: 2 })).toBe(2);
    expect(autoCeiling({ min: 0.5, max: 8 })).toBe(AUTO_MAX);
    expect(maySwitchLens({ min: 1, max: 10 })).toBe(true);
    expect(maySwitchLens({ min: 1, max: 4 })).toBe(false);
    expect(maySwitchLens(null)).toBe(false);
  });

  it("steps in gently while the card is small, after a few steady frames and a pause", () => {
    const z = new AutoZoom({ min: 1, max: 10 });
    const steps: (number | null)[] = [];
    for (let i = 0; i < STEADY; i++) steps.push(z.frame(0.3, 1, i * 100));
    expect(steps.slice(0, -1)).toEqual(Array(STEADY - 1).fill(null));
    expect(steps.at(-1)).toBe(1.15);
    // No second step before the pause, even with steady frames.
    for (let i = 0; i < STEADY; i++) expect(z.frame(0.35, 1.15, 300 + i * 100)).toBeNull();
    let zoom = 1.15;
    for (let t = 1000; t < 20000; t += 100) {
      const next = z.frame(0.25, zoom, t);
      if (next) zoom = next;
    }
    expect(zoom).toBe(AUTO_MAX);
  });

  it("doesn't overshoot the share aimed for, steps out when the card is cut off, and rests in between", () => {
    const z = new AutoZoom({ min: 1, max: 10 });
    let out: number | null = null;
    for (let i = 0; i < STEADY; i++) out = z.frame(0.44, 1, i * 10);
    // 0.44 → 0.6 needs 1.36×, more than a step: one step.
    expect(out).toBe(1.15);
    const back = new AutoZoom({ min: 1, max: 10 });
    for (let i = 0; i < STEADY; i++) out = back.frame(0.95, 2, i * 10);
    expect(out).toBeCloseTo(1.75, 2);
    const still = new AutoZoom({ min: 1, max: 10 });
    for (let i = 0; i < 10; i++) expect(still.frame(0.6, 1.5, i * STEP_MS)).toBeNull();
    // No card: nothing, and the run starts again.
    expect(still.frame(null, 1.5, 99999)).toBeNull();
  });
});

describe("move closer", () => {
  it("estimates the collector letters from the card's height", () => {
    expect(LETTER_SHARE).toBeCloseTo(0.0128, 4);
    expect(cardHeight(rectQuad(0, 0, 1000, 1397))).toBeCloseTo(1397, 3);
    expect(letterPx(rectQuad(0, 0, 1000, 1397))).toBeCloseTo(17.9, 1);
  });

  it("asks to move closer until the letters are about 20 px tall", () => {
    // A card 1,250 px tall: 16 px letters. 1,600 px: 20.5 px.
    expect(tooFar(rectQuad(0, 0, 895, 1250))).toBe(true);
    expect(tooFar(rectQuad(0, 0, 1146, 1600))).toBe(false);
  });
});

describe("whether auto-zoom has room left (so the distance hints wait for it)", () => {
  it("can zoom in up to its ceiling and out down to 1× or the camera's least", () => {
    const az = new AutoZoom({ min: 0.5, max: 30 });
    expect(az.canZoomIn(1)).toBe(true);
    expect(az.canZoomIn(AUTO_MAX)).toBe(false);
    expect(az.canZoomOut(1)).toBe(false);
    expect(az.canZoomOut(1.5)).toBe(true);
    const fixed = new AutoZoom({ min: 1, max: 1 });
    expect(fixed.canZoomIn(1)).toBe(false);
    expect(fixed.canZoomOut(1)).toBe(false);
  });
});

describe("going wide when a card struggles", () => {
  const pixel = { min: 0.507, max: 30 };
  it("steps out to the wide lens once a steady card goes unnamed, and back to 1x once the view is empty", () => {
    const w = new WideOnStruggle(pixel);
    expect(w.can).toBe(true);
    let t = 0;
    for (; t < WIDE_AFTER_MS; t += 100) expect(w.frame(0.6, true, false, 1, t)).toBeNull();
    expect(w.frame(0.6, true, false, 1, t)).toBe(0.5);
    expect(w.isWide).toBe(true);
    // Gone: back to 1x after a moment.
    expect(w.frame(null, false, false, 0.5, (t += 100))).toBeNull();
    expect(w.frame(null, false, false, 0.5, (t += WIDE_BACK_MS))).toBe(1);
    expect(w.isWide).toBe(false);
    // Gone, with the finder's "cards" jumping on the empty table: back to 1x all the same.
    const v = new WideOnStruggle(pixel);
    let u = 0;
    for (; u <= WIDE_AFTER_MS; u += 100) v.frame(0.6, true, false, 1, u);
    expect(v.isWide).toBe(true);
    expect(v.frame(0.9, false, false, 0.5, (u += 100))).toBeNull();
    expect(v.frame(0.4, false, false, 0.5, (u += WIDE_BACK_MS))).toBe(1);
  });

  it("never for a 'card' that jumps (nothing there), a card named quickly, or a camera with no wider lens", () => {
    // The finder's "cards" on an empty table: steady now and then, jumping on most frames.
    const w = new WideOnStruggle(pixel);
    for (let t = 0; t < 3 * WIDE_AFTER_MS; t += 100) expect(w.frame(0.6, t % 300 === 0, false, 1, t)).toBeNull();
    const named = new WideOnStruggle(pixel);
    for (let t = 0; t < 3 * WIDE_AFTER_MS; t += 100) expect(named.frame(0.6, true, true, 1, t)).toBeNull();
    const one = new WideOnStruggle({ min: 1, max: 8 });
    expect(one.can).toBe(false);
    for (let t = 0; t < 3 * WIDE_AFTER_MS; t += 100) expect(one.frame(0.6, true, false, 1, t)).toBeNull();
  });

  it("steps out when a card held at 1x overfills the view for a moment, not on a few frames", () => {
    const w = new WideOnStruggle(pixel);
    expect(w.frame(0.9, true, false, 1, 0)).toBeNull();
    expect(w.frame(0.9, true, false, 1, 33)).toBeNull();
    expect(w.frame(0.9, true, false, 1, 66)).toBeNull();
    // Back inside the view: the moment starts again.
    expect(w.frame(0.7, true, false, 1, 100)).toBeNull();
    expect(w.frame(0.9, true, false, 1, 133)).toBeNull();
    expect(w.frame(0.9, true, false, 1, 133 + CLOSE_MS - 1)).toBeNull();
    expect(w.frame(0.9, true, false, 1, 133 + CLOSE_MS)).toBe(0.5);
  });

  it("comes back to 1x as soon as the card is named, and isn't stuck wide while cards keep coming (23 Nov 2026)", () => {
    const w = new WideOnStruggle(pixel);
    let t = 0;
    for (; t < WIDE_AFTER_MS; t += 100) w.frame(0.6, true, false, 1, t);
    expect(w.frame(0.6, true, false, 1, t)).toBe(0.5);
    // Named at 0.5x, still in view: back to 1x now, not once the view has emptied.
    expect(w.frame(0.3, true, true, 0.5, (t += 100))).toBe(1);
    expect(w.isWide).toBe(false);
    // Held while it lies there: no step out.
    for (let i = 0; i < 50; i += 1) expect(w.frame(0.6, true, true, 1, (t += 100))).toBeNull();
    // The next card slid on without an empty view, struggling: it may go wide in its turn.
    for (let i = 0; i < WIDE_AFTER_MS / 100; i += 1) expect(w.frame(0.6, true, false, 1, (t += 100))).toBeNull();
    expect(w.frame(0.6, true, false, 1, (t += 100))).toBe(0.5);
  });

  it("takes turns for a card it can't name: 0.5x for a while, 1x for a while, then 0.5x again (23 Nov 2026, after #207)", () => {
    const w = new WideOnStruggle(pixel);
    let t = 0;
    for (; t < WIDE_AFTER_MS; t += 100) w.frame(0.6, true, false, 1, t);
    expect(w.frame(0.6, true, false, 1, t)).toBe(0.5);
    const went = t;
    for (t += 100; t < went + WIDE_MAX_MS; t += 100) expect(w.frame(0.3, true, false, 0.5, t)).toBeNull();
    expect(w.frame(0.3, true, false, 0.5, t)).toBe(1);
    // A turn at 1x, the struggle's wait again, then wide again: each lens sees the card from its own spot.
    const back = t;
    for (t += 100; t < back + 100 + WIDE_AFTER_MS; t += 100) expect(w.frame(0.6, true, false, 1, t)).toBeNull();
    expect(w.frame(0.6, true, false, 1, t)).toBe(0.5);
    // Named meanwhile: back to 1x, and it stays.
    expect(w.frame(0.3, true, true, 0.5, (t += 100))).toBe(1);
    for (let i = 0; i < 2 * (WIDE_AFTER_MS / 100); i += 1) expect(w.frame(0.6, true, true, 1, (t += 100))).toBeNull();
  });

  it("isn't put off by a missed frame or two: a glary card the finder loses now and then still goes wide (23 Nov 2026, after #205)", () => {
    const w = new WideOnStruggle(pixel);
    let t = 0;
    // One frame in five without a steady card (a glare frame the finder missed, a twitch).
    for (; t < WIDE_AFTER_MS; t += 100) expect(w.frame(0.6, t % 500 !== 400, false, 1, t)).toBeNull();
    expect(w.frame(0.6, true, false, 1, t)).toBe(0.5);
    // Two misses in a row, then the card again: the same struggle.
    const v = new WideOnStruggle(pixel);
    let u = 0;
    for (; u < WIDE_AFTER_MS; u += 100) v.frame(0.6, u !== 1000 && u !== 1100, false, 1, u);
    expect(v.frame(0.6, true, false, 1, u)).toBe(0.5);
  });

  it("starts the struggle again once the card has been gone a while (LOST_FRAMES over LOST_MS)", () => {
    const w = new WideOnStruggle(pixel);
    let t = 0;
    for (; t < WIDE_AFTER_MS - 500; t += 100) w.frame(0.6, true, false, 1, t);
    // Gone for LOST_FRAMES frames spread over LOST_MS.
    const gap = Math.ceil(LOST_MS / (LOST_FRAMES - 1));
    for (let i = 0; i < LOST_FRAMES; i += 1) w.frame(null, false, false, 1, (t += gap));
    // Back: the 3 s count from here.
    const back = (t += 100);
    for (; t < back + WIDE_AFTER_MS; t += 100) expect(w.frame(0.6, true, false, 1, t)).toBeNull();
    expect(w.frame(0.6, true, false, 1, t)).toBe(0.5);
  });

  it("goes wide sooner when glare is what keeps the card from being named", () => {
    const w = new WideOnStruggle(pixel);
    let t = 0;
    for (; t < WIDE_GLARE_MS; t += 100) expect(w.frame(0.6, true, false, 1, t, true)).toBeNull();
    expect(w.frame(0.6, true, false, 1, t, true)).toBe(0.5);
    expect(WIDE_GLARE_MS).toBeLessThan(WIDE_AFTER_MS);
  });

  it("forgets a struggle when the read loop stops, and comes back from 0.5x", () => {
    const w = new WideOnStruggle(pixel);
    let t = 0;
    for (; t < WIDE_AFTER_MS - 100; t += 100) w.frame(0.6, true, false, 1, t);
    // A pause (Scan settings) of a minute: not time spent struggling.
    expect(w.reset()).toBeNull();
    t += 60_000;
    for (let i = 0; i < WIDE_AFTER_MS / 100; i += 1) expect(w.frame(0.6, true, false, 1, (t += 100))).toBeNull();
    expect(w.frame(0.6, true, false, 1, (t += 100))).toBe(0.5);
    // Into a close-up while wide: back to 1x.
    expect(w.reset()).toBe(1);
    expect(w.isWide).toBe(false);
  });
});

describe("the close-ups zoom in themselves", () => {
  const pixel = { min: 0.507, max: 30 };
  it("zooms so the name would fill the box from where the card is, more for the set code and number", () => {
    // A card 60% of the view's height: about 1.3x for its name, 2.7x for the collector line.
    expect(closeupZoom("title", 0.6, 1, pixel)).toBeCloseTo(1.3, 1);
    expect(closeupZoom("collector", 0.6, 1, pixel)).toBeCloseTo(2.7, 1);
    // Further away (30%): more.
    expect(closeupZoom("title", 0.3, 1, pixel)).toBeCloseTo(2.6, 1);
    // Seen at 0.5x (gone wide): 30% there is 60% at 1x, about 1.3x; 60% there needs no more than 1x.
    expect(closeupZoom("title", 0.3, 0.5, pixel)).toBeCloseTo(1.3, 1);
    expect(closeupZoom("title", 0.6, 0.5, pixel)).toBeNull();
    // From 2x already, the share seen at 2x.
    expect(closeupZoom("title", 0.6, 2, pixel)).toBeCloseTo(2.6, 1);
  });

  it("stays short of the lens switch on a camera that has one, and goes as far as a camera without one zooms", () => {
    expect(closeupZoom("title", 0.15, 1, pixel)).toBe(CLOSE_MAX);
    expect(CLOSE_MAX).toBeLessThan(LENS_SWITCH);
    expect(closeupZoom("title", 0.15, 1, { min: 1, max: 3 })).toBe(3);
    // Close enough already, or nothing seen: nothing to do.
    expect(closeupZoom("title", 0.9, 1, pixel)).toBeNull();
    expect(closeupZoom("title", 0, 1, pixel)).toBeNull();
  });
});

