import { describe, expect, it } from "vitest";
import { artGlare, GLARE_ART, GLARE_HINT_MS, GlareWatch, TORCH_ON_MS, TorchOnStruggle } from "./glare";
import { rectQuad } from "./image";
import type { Quad, RgbaImage } from "./types";

/** A grey frame with a card at (x, y), w × h, and `paint` over it in card shares (0 to 1). */
function frame(paint: (u: number, v: number) => number, card = { x: 40, y: 60, w: 300, h: 419 }, size = { w: 380, h: 560 }): { img: RgbaImage; quad: Quad } {
  const data = new Uint8ClampedArray(size.w * size.h * 4);
  for (let y = 0; y < size.h; y += 1)
    for (let x = 0; x < size.w; x += 1) {
      const u = (x - card.x) / card.w;
      const v = (y - card.y) / card.h;
      const inside = u >= 0 && u < 1 && v >= 0 && v < 1;
      const l = inside ? paint(u, v) : 40;
      const k = (y * size.w + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = l;
      data[k + 3] = 255;
    }
  return { img: { width: size.w, height: size.h, data }, quad: rectQuad(card.x, card.y, card.w, card.h) };
}

/** A card: mid-grey art, a white text box below it (bright, but not glare), dark frame. */
const card = (u: number, v: number) => (v > 0.6 && v < 0.9 && u > 0.06 && u < 0.94 ? 245 : v > 0.11 && v < 0.56 ? 120 : 60);

describe("glare on the art (glare.ts)", () => {
  it("counts blown-out points in the art box only, not the card's white text box", () => {
    const plain = frame(card);
    expect(artGlare(plain.img, plain.quad)).toBe(0);
    // A flash's reflection: a round blown-out spot left of the art's middle (where his flashlight's landed).
    const spot = frame((u, v) => (Math.hypot(u - 0.36, (v - 0.33) * 1.4) < 0.12 ? 255 : card(u, v)));
    const g = artGlare(spot.img, spot.quad);
    expect(g).toBeGreaterThan(2 * GLARE_ART);
    expect(g).toBeLessThan(0.2);
    // The whole art washed out.
    const washed = frame((u, v) => (v > 0.1 && v < 0.6 ? 250 : card(u, v)));
    expect(artGlare(washed.img, washed.quad)).toBe(1);
  });

  it("follows the card's corners (turned or tilted) and stays inside the frame at its edges", () => {
    const { img } = frame(card);
    // The same card, its corners given from the bottom right (upside down): its art box is then the
    // text box's end of the card, which is white.
    const q = rectQuad(40, 60, 300, 419);
    const upsideDown = [q[2], q[3], q[0], q[1]] as Quad;
    expect(artGlare(img, upsideDown)).toBeGreaterThan(0.3);
    // Corners off the frame are clamped, not read out of bounds.
    expect(() => artGlare(img, rectQuad(-200, -300, 900, 1200))).not.toThrow();
  });
});

describe("GlareWatch", () => {
  it("calls glare on two of the last three frames, or one far over the line, and says it after a moment", () => {
    const w = new GlareWatch();
    expect(w.frame(GLARE_ART, true, 0)).toEqual({ glary: false, hint: false });
    expect(w.frame(0, true, 100).glary).toBe(false);
    expect(w.frame(GLARE_ART, true, 200).glary).toBe(true);
    expect(w.frame(GLARE_ART, true, 200 + GLARE_HINT_MS - 1).hint).toBe(false);
    expect(w.frame(GLARE_ART, true, 200 + GLARE_HINT_MS).hint).toBe(true);
    expect(w.peak).toBe(GLARE_ART);
    // Gone (or the card named): starts again.
    expect(w.frame(null, true, 5000)).toEqual({ glary: false, hint: false });
    expect(w.peak).toBe(0);
    expect(w.frame(2 * GLARE_ART, true, 5100).glary).toBe(true);
    expect(w.frame(2 * GLARE_ART, false, 5200)).toEqual({ glary: false, hint: false });
  });
});

describe("TorchOnStruggle", () => {
  it("turns the flashlight on once a card has struggled a moment, once a session", () => {
    const t = new TorchOnStruggle();
    expect(t.frame(true, false, 0)).toBe(false);
    expect(t.frame(true, false, TORCH_ON_MS - 1)).toBe(false);
    expect(t.frame(true, false, TORCH_ON_MS)).toBe(true);
    // On only once the camera has taken it.
    expect(t.on).toBe(false);
    t.answered(true);
    expect(t.on).toBe(true);
    // The camera's state still says off for a frame or two: that isn't the person turning it off.
    expect(t.frame(true, false, TORCH_ON_MS + 30)).toBe(false);
    expect(t.on).toBe(true);
    expect(t.frame(true, true, TORCH_ON_MS + 100)).toBe(false);
    // The person turns it off: theirs from now on.
    expect(t.frame(false, false, 5000)).toBe(false);
    expect(t.on).toBe(false);
    for (let at = 5000; at < 5000 + 4 * TORCH_ON_MS; at += 100) expect(t.frame(true, false, at)).toBe(false);
  });

  it("never once the person has turned it off themselves, and only for a struggle that lasts", () => {
    const t = new TorchOnStruggle();
    // On by the person, then off by the person: left off.
    t.frame(false, true, 0);
    t.frame(false, false, 100);
    for (let at = 200; at < 4 * TORCH_ON_MS; at += 100) expect(t.frame(true, false, at)).toBe(false);
    const u = new TorchOnStruggle();
    // A struggle that comes and goes starts the wait again.
    expect(u.frame(true, false, 10_000)).toBe(false);
    expect(u.frame(false, false, 10_000 + TORCH_ON_MS / 2)).toBe(false);
    expect(u.frame(true, false, 10_000 + TORCH_ON_MS)).toBe(false);
    expect(u.frame(true, false, 10_000 + 2 * TORCH_ON_MS)).toBe(true);
  });

  it("asks once: a camera that refused isn't asked again", () => {
    const t = new TorchOnStruggle();
    t.frame(true, false, 0);
    expect(t.frame(true, false, TORCH_ON_MS)).toBe(true);
    t.answered(false);
    expect(t.on).toBe(false);
    for (let at = TORCH_ON_MS; at < 5 * TORCH_ON_MS; at += 100) expect(t.frame(true, false, at)).toBe(false);
  });
});
