// Foil or not, from its sheen (Bryan, 23 Nov 2026: "Let's detect foils by the rainbow sheen. That'd
// be amazing. We maybe have a confidence score but it should be easier to switch between foil and
// not foil"; "sleeve cards are going to look a little bit like that too but they'll be a whiter
// less rainbowy sheet"). Measured on his 23 Nov scans, the 640 px frames the phone read, against
// the finish each card was filed with (docs/scanner.md, "Foil by its sheen"):
// - A foil's rainbow shows on the card's text box, whose paper is otherwise one colour. The spread
//   of that paper's colour (Lab a and b) told the filed finish apart with AUC 0.98.
// - A coloured box, warm light or a sleeve's white sheen spreads too, but over one or two hues; a
//   foil's rainbow spans several. Spread FOIL_SPREAD or more over FOIL_HUES or more hues called 20 of
//   24 foils foil and 3 of 290 non-foils (one of them a foil filed as non-foil, two cut upside down).
//   On 125 sleeved photos from 15 Nov it called 5 foil, all five plainly foils.
// - A printing with no text box (full art, borderless) has art where the box would be: not judged.

import type { Quad, RgbaImage } from "./types";

/** The text box of a modern frame, as shares of the card. */
const BOX = { x0: 0.1, y0: 0.64, x1: 0.9, y1: 0.87 } as const;
const GX = 32;
const GY = 12;
/** The paper's colour spread (std of Lab a plus std of b) at or above which it may be a foil's rainbow. */
export const FOIL_SPREAD = 10;
/** And over this many hues (60° sectors of the paper's colour away from its own cast). */
export const FOIL_HUES = 3;
/** A hue counts with this share of the paper's points at least HUE_CHROMA away from its cast. */
const HUE_SHARE = 0.06;
const HUE_CHROMA = 10;

/** One frame's sheen: the paper's colour spread and how many hues it spans. */
export interface Sheen {
  spread: number;
  hues: number;
}

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB (0 to 255) to CIE Lab, D65. */
export function lab(r: number, g: number, b: number): [number, number, number] {
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};
const std = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

/**
 * The sheen of the card's text box on this frame, `quad` its corners (top left first, clockwise):
 * 384 points over the box, each a 3 × 3 mean, the brighter half of them (the paper, not the
 * letters) in Lab.
 */
export function cardSheen(img: RgbaImage, quad: Quad): Sheen {
  const [a, b, c, d] = quad;
  const { width: w, height: h, data } = img;
  const pts: [number, number, number][] = [];
  for (let j = 0; j < GY; j += 1) {
    const v = BOX.y0 + ((BOX.y1 - BOX.y0) * (j + 0.5)) / GY;
    for (let i = 0; i < GX; i += 1) {
      const u = BOX.x0 + ((BOX.x1 - BOX.x0) * (i + 0.5)) / GX;
      const x = (1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0]);
      const y = (1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1]);
      const xi = Math.floor(x + 0.5);
      const yi = Math.floor(y + 0.5);
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = Math.min(h - 1, Math.max(0, yi + dy));
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = Math.min(w - 1, Math.max(0, xi + dx));
          const k = (yy * w + xx) * 4;
          r += data[k]!;
          g += data[k + 1]!;
          bl += data[k + 2]!;
        }
      }
      pts.push(lab(r / 9, g / 9, bl / 9));
    }
  }
  const lMid = median(pts.map((p) => p[0]));
  const paper = pts.filter((p) => p[0] >= lMid);
  const A = paper.map((p) => p[1]);
  const B = paper.map((p) => p[2]);
  const spread = std(A) + std(B);
  const am = median(A);
  const bm = median(B);
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < paper.length; i += 1) {
    const da = A[i]! - am;
    const db = B[i]! - bm;
    if (Math.hypot(da, db) < HUE_CHROMA) continue;
    const deg = ((Math.atan2(db, da) * 180) / Math.PI + 360) % 360;
    counts[Math.min(5, Math.floor(deg / 60))]! += 1;
  }
  const hues = counts.filter((n) => n / paper.length >= HUE_SHARE).length;
  return { spread, hues };
}

/** One frame that looks foil. */
export const looksFoil = (s: Sheen) => s.spread >= FOIL_SPREAD && s.hues >= FOIL_HUES;

/** Whether a printing has a text box to judge (not full art, not borderless). */
export const hasTextBox = (t: { full_art?: boolean | null; border_color?: string | null } | null | undefined) => !t || (!t.full_art && t.border_color !== "borderless");

/** What the frames of one card said about its sheen. */
export interface FoilVerdict {
  /** It looks foil on at least one frame. */
  foil: boolean;
  /** Sure: on two frames or more, or over four hues or more on one. */
  sure: boolean;
  /** Frames judged, and of them how many looked foil. */
  frames: number;
  foilFrames: number;
  /** The most spread and hues seen on one frame. */
  spread: number;
  hues: number;
}

/** The sheen of the frames of the card in view, until it's filed or gone. */
export class SheenWatch {
  private n = 0;
  private yes = 0;
  private spread = 0;
  /** The most hues on a frame that looked foil, and on any frame. */
  private foilHues = 0;
  private anyHues = 0;

  add(s: Sheen | null | undefined): void {
    if (!s) return;
    this.n += 1;
    if (looksFoil(s)) {
      this.yes += 1;
      this.foilHues = Math.max(this.foilHues, s.hues);
    }
    this.spread = Math.max(this.spread, s.spread);
    this.anyHues = Math.max(this.anyHues, s.hues);
  }

  verdict(): FoilVerdict {
    const foil = this.yes > 0;
    return { foil, sure: foil && (this.yes >= 2 || this.foilHues >= FOIL_HUES + 1), frames: this.n, foilFrames: this.yes, spread: Math.round(this.spread * 10) / 10, hues: foil ? this.foilHues : this.anyHues };
  }

  reset(): void {
    this.n = 0;
    this.yes = 0;
    this.spread = 0;
    this.foilHues = 0;
    this.anyHues = 0;
  }
}
