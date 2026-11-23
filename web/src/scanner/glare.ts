// Glare on the card's art (Bryan, 23 Nov 2026: "the glare is really killing me. It was really bad
// for foils"). Measured on his 392 named scans and 104 struggle records that day
// (docs/scanner.md, "Glare and foils"):
// - No filter on one picture gets the art back. Fourteen were tried against the art model (filling
//   the glare in, contrast, highlight compression, gamma, white balance, taking the white sheen out,
//   greying the rainbow): none locked more right cards, and filling the glare in locked 79% against 89%.
// - Two views beat one cleaned view: of two scans of the same printing, the better one was named
//   99.3% of the time, and the two merged so each spot came from the one with less glare 93 to 95%.
//   So the scanner's way past glare is another view of the card: tilted, from the wide lens, or
//   without the flashlight.
// - The flashlight was the glare. With it on, a median 2.3% of the art was blown out (0.0% with it
//   off), always in the same place, left of the art's middle, where the flash's reflection lands.
// - Blown out here is ARTGLARE_HOT or brighter, as a 3 × 3 mean; GLARE_ART of the art's points
//   blown out is glare: at that share the art model's top match was right 87% of the time against
//   97% below it (at 0.04, 71%).

import type { Quad, RgbaImage } from "./types";

/** The art box of a modern frame, as shares of the card (the region the glare is measured in). */
const ART = { x0: 0.08, y0: 0.11, x1: 0.92, y1: 0.56 } as const;
/** The grid of points sampled over the art box. */
const GX = 24;
const GY = 16;
/** A point this bright (luminance, 3 × 3 mean) is blown out. */
export const ARTGLARE_HOT = 235;
/** This share of the art's points blown out is glare. */
export const GLARE_ART = 0.03;

/**
 * The share of the art box's points that are blown out on this frame, with `quad` the card's
 * corners in the image (top left first, clockwise). Cheap: 384 points, nine pixels each.
 */
export function artGlare(img: RgbaImage, quad: Quad): number {
  const [a, b, c, d] = quad;
  const { width: w, height: h, data } = img;
  let hits = 0;
  for (let j = 0; j < GY; j += 1) {
    const v = ART.y0 + ((ART.y1 - ART.y0) * (j + 0.5)) / GY;
    for (let i = 0; i < GX; i += 1) {
      const u = ART.x0 + ((ART.x1 - ART.x0) * (i + 0.5)) / GX;
      const x = (1 - v) * ((1 - u) * a[0] + u * b[0]) + v * ((1 - u) * d[0] + u * c[0]);
      const y = (1 - v) * ((1 - u) * a[1] + u * b[1]) + v * ((1 - u) * d[1] + u * c[1]);
      const xi = Math.round(x);
      const yi = Math.round(y);
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = Math.min(h - 1, Math.max(0, yi + dy));
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = Math.min(w - 1, Math.max(0, xi + dx));
          const k = (yy * w + xx) * 4;
          sum += 0.299 * data[k]! + 0.587 * data[k + 1]! + 0.114 * data[k + 2]!;
        }
      }
      if (sum / 9 >= ARTGLARE_HOT) hits += 1;
    }
  }
  return hits / (GX * GY);
}

/** Glare on this card this long while it goes unnamed: say so ("tilt it"). */
export const GLARE_HINT_MS = 1000;

/**
 * Whether the card being looked for has glare on its art, frame by frame: on two of the last
 * three frames read, or far over the line on one (a glare spot comes and goes as the hand moves).
 * `seeking` is a card in view the scanner is still trying to name; anything else starts it again.
 */
export class GlareWatch {
  private recent: boolean[] = [];
  private since: number | null = null;
  /** The most glare seen on the card being looked for (for its timing record). */
  peak = 0;

  frame(glare: number | null, seeking: boolean, now: number): { glary: boolean; hint: boolean } {
    if (!seeking || glare == null) {
      this.reset();
      return { glary: false, hint: false };
    }
    this.peak = Math.max(this.peak, glare);
    this.recent.push(glare >= GLARE_ART);
    if (this.recent.length > 3) this.recent.shift();
    const glary = glare >= 2 * GLARE_ART || this.recent.filter(Boolean).length >= 2;
    if (!glary) this.since = null;
    else this.since ??= now;
    return { glary, hint: glary && now - this.since! >= GLARE_HINT_MS };
  }

  /** A new card, or none: nothing seen yet. */
  reset(): void {
    this.recent = [];
    this.since = null;
    this.peak = 0;
  }
}

/** Glare this long on an unnamed card with the flashlight on: the flashlight goes off. */
export const TORCH_GLARE_MS = 600;

/**
 * The flashlight off when it's what puts the glare on the art: the glare has stayed on a card the
 * scanner can't name for TORCH_GLARE_MS with the flashlight on. Once a session: turned back on by
 * the person after that, it's theirs, and stays on (the camera then only says to tilt the card).
 * `frame` asks for it once; `answered` says whether the camera took it (a camera that refused, or
 * closed meanwhile, isn't asked again this session).
 */
export class TorchOnGlare {
  private since: number | null = null;
  /** Asked the camera to turn it off (once a session). */
  private asked = false;
  /** The camera turned it off. */
  private turnedOff = false;
  /** Seen off since (the camera's state lags its answer). */
  private seenOff = false;
  private kept = false;

  /** Whether it turned the flashlight off this session (and the person hasn't turned it back on). */
  get off(): boolean {
    return this.turnedOff && !this.kept;
  }

  /** One frame: true when the flashlight should go off now. */
  frame(glary: boolean, torchOn: boolean, now: number): boolean {
    // Back on after it was seen off: the person wants it. (On before then is the camera's state
    // not having caught up.)
    if (this.turnedOff && !torchOn) this.seenOff = true;
    if (torchOn && this.seenOff) this.kept = true;
    if (!torchOn || this.asked || !glary) {
      this.since = null;
      return false;
    }
    this.since ??= now;
    if (now - this.since < TORCH_GLARE_MS) return false;
    this.asked = true;
    this.since = null;
    return true;
  }

  /** The camera's answer to turning it off: taken, or not (then not asked again). */
  answered(ok: boolean): void {
    if (ok) this.turnedOff = true;
  }
}
