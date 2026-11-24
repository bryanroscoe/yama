// Glare on the card's art (Bryan, 23 Nov 2026: "the glare is really killing me. It was really bad
// for foils"). Measured on his 392 named scans and 104 struggle records that day
// (docs/scanner.md, "Glare and foils"):
// - No filter on one picture gets the art back. Fourteen were tried against the art model (filling
//   the glare in, contrast, highlight compression, gamma, white balance, taking the white sheen out,
//   greying the rainbow): none locked more right cards, and filling the glare in locked 79% against 89%.
// - Two views beat one cleaned view: of two scans of the same printing, the better one was named
//   99.3% of the time, and the two merged so each spot came from the one with less glare 93 to 95%.
//   So the scanner's way past glare is another view of the card: tilted, from another lens, or in
//   another light.
// - Struggle records with the flashlight on had more of the art blown out (a median 2.3% against
//   0.0%), but that was Bryan turning it on for the hard foils, not the flashlight's glare: "The
//   flashlight made it better. The normal lights did it too" (23 Nov 2026). So the scanner turns it
//   on for a card it struggles with (TorchOnStruggle), never off.
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

/** A card the scanner can't name this long with the flashlight off: the flashlight goes on. */
export const TORCH_ON_MS = 1500;

/**
 * The flashlight on for a card the scanner struggles with (Bryan, 23 Nov 2026, after #207 turned it
 * off for glare: "The flashlight made it better ... It was hard to scan them with no flashlight on
 * too"). A card it's reading and can't name for TORCH_ON_MS with the flashlight off: on, once a
 * session. The person's choice stands: once they have used the flashlight button (`person`), or the
 * flashlight has been seen on and then off (the camera reopened), it's never turned on by itself
 * again that session. Not on a frame whose art may name the card this pass (`hold`): the next frame
 * that doesn't. `frame` asks once; `answered` says whether the camera took it.
 */
export class TorchOnStruggle {
  private since: number | null = null;
  /** Asked the camera to turn it on (once a session). */
  private asked = false;
  /** The camera turned it on this session (for the record, whatever happened after). */
  turnedOn = false;
  /** Seen on, by anyone, and then seen off. */
  private seenOn = false;
  private leftOff = false;

  /** One frame: `struggling`, a card being read and not yet named. True when the flashlight should go on now. */
  frame(struggling: boolean, torchOn: boolean, now: number, o: { person?: boolean; hold?: boolean } = {}): boolean {
    if (torchOn) this.seenOn = true;
    else if (this.seenOn) this.leftOff = true;
    if (torchOn || this.asked || this.leftOff || o.person || !struggling) {
      this.since = null;
      return false;
    }
    this.since ??= now;
    if (o.hold || now - this.since < TORCH_ON_MS) return false;
    this.asked = true;
    this.since = null;
    return true;
  }

  /** The camera's answer to turning it on: taken, or not (then not asked again). */
  answered(ok: boolean): void {
    if (ok) this.turnedOn = true;
  }
}

// Exposure down for glare (Bryan, 23 Nov 2026: "be nice to be able to change the exposure"; "you can
// make a new app install. Let's make this as good as possible"). A blown-out patch of art has no
// detail left for the art model; less exposure shrinks the blown-out area and keeps the detail under
// a foil's sheen, and is another view of the card besides. Where the camera can change its exposure
// (the app's own camera since #210; Chrome's where it offers it).

/** Glare this long on a card the scanner is reading: the exposure goes down. */
export const EXPOSE_GLARE_MS = 800;
/** By this much (EV), within the camera's range. */
export const GLARE_EV = 1;

/** The camera's exposure range, in EV. */
export interface ExposureRange {
  min: number;
  max: number;
  step: number;
}

/**
 * The exposure down while glare stays on the art of a card being read, and back to where the person
 * had it (Scan settings) once that card is named or gone. Theirs stands: moved while down, it's left
 * where they put it. `frame` says the exposure to set now (or null); `answered` whether it was taken.
 */
export class ExposureOnGlare {
  private since: number | null = null;
  /** Down: the exposure it went down from, and the one it set. */
  private down: { from: number; to: number } | null = null;

  /** Whether it has the exposure down now. */
  get isDown(): boolean {
    return !!this.down;
  }

  frame(glary: boolean, reading: boolean, now: number, exposure: number, range: ExposureRange | null): number | null {
    if (!range) {
      this.since = null;
      return null;
    }
    if (this.down) {
      if (reading) return null;
      const d = this.down;
      this.down = null;
      this.since = null;
      // Moved by the person meanwhile (neither where it was nor where it went): theirs stands.
      const near = (a: number, b: number) => Math.abs(a - b) <= range.step / 2;
      return near(exposure, d.to) || near(exposure, d.from) ? d.from : null;
    }
    if (!reading || !glary) {
      this.since = null;
      return null;
    }
    this.since ??= now;
    if (now - this.since < EXPOSE_GLARE_MS) return null;
    this.since = null;
    const lowest = range.min;
    const to = Math.max(lowest, exposure - GLARE_EV);
    // Already as low as it goes: nothing to do.
    if (to > exposure - range.step / 2) return null;
    this.down = { from: exposure, to };
    return to;
  }

  /** The camera's answer: not taken, so it isn't down. */
  answered(ok: boolean): void {
    if (!ok) this.down = null;
  }
}
