// Zooming in until the card fills the view (Bryan, 15 Nov 2026: the view "isn't zoomed in, even
// mildly"; and the scanner consult: auto-zoom until the card fills the view). Only the camera's
// own zoom, never the digital one: a digital zoom only enlarges the picture, so a card filling it
// is fewer of the frame's pixels, while the camera's zoom crops a sensor with more pixels than the
// stream and lets the card be held further away, where the main lens focuses [inferred]. Gentle
// steps, with a pause between them, and never past a lens switch: on a phone whose one back camera
// switches lens as it zooms (a Pixel Pro: the telephoto takes over at 5×), the telephoto can't
// focus as close as a card is held [read: Android logical multi-camera docs; inferred for the
// Pixel 10 Pro]. A pinch or + and − hands zoom to the person for the rest of the session.

/** The card's height, as a share of the visible view's height, that auto-zoom aims for. */
export const FILL_TARGET = 0.6;
/** Zoom in below this share, out above that one (hysteresis, so it doesn't hunt). */
export const FILL_LOW = 0.45;
export const FILL_HIGH = 0.85;
/** One step: this factor in or out, at most every STEP_MS. */
export const STEP = 1.15;
export const STEP_MS = 700;
/** Frames in a row asking for the same direction before a step. */
export const STEADY = 3;
/** Auto-zoom stops here, below where a phone switches to its telephoto. */
export const AUTO_MAX = 2.5;
/** Phones whose camera zooms this far likely switch lens on the way (Pixel Pro telephoto: 5×) [inferred]. */
export const LENS_SWITCH = 5;

export interface ZoomRange {
  min: number;
  max: number;
}

/** The most auto-zoom may reach with this camera's own zoom range. */
export function autoCeiling(range: ZoomRange): number {
  return Math.max(Math.max(1, range.min), Math.min(range.max, AUTO_MAX));
}

/** Whether zooming this camera far enough may switch it to another lens. */
export const maySwitchLens = (range: ZoomRange | null) => !!range && range.max >= LENS_SWITCH;

const round = (z: number) => Math.round(z * 20) / 20;

/**
 * Frame by frame: the zoom to step to, or null for none. `share` is the card's height over the
 * visible view's height (null when no card is in view).
 */
export class AutoZoom {
  private want: -1 | 0 | 1 = 0;
  private run = 0;
  private lastStep = -Infinity;

  constructor(private readonly range: ZoomRange) {}

  /** Whether auto-zoom can still zoom in from `zoom` (so "Move closer" can wait for it). */
  canZoomIn(zoom: number): boolean {
    return zoom < autoCeiling(this.range) - 0.05;
  }

  /** Whether auto-zoom can still zoom out from `zoom` (so "further away" can wait for it). */
  canZoomOut(zoom: number): boolean {
    return zoom > Math.max(1, this.range.min) + 0.05;
  }

  frame(share: number | null, zoom: number, now: number): number | null {
    const dir: -1 | 0 | 1 = share == null ? 0 : share < FILL_LOW ? 1 : share > FILL_HIGH ? -1 : 0;
    if (dir === 0) {
      this.want = 0;
      this.run = 0;
      return null;
    }
    this.run = dir === this.want ? this.run + 1 : 1;
    this.want = dir;
    if (this.run < STEADY || now - this.lastStep < STEP_MS) return null;
    const floor = Math.max(1, this.range.min);
    const ceiling = autoCeiling(this.range);
    // Not past the share aimed for: step by STEP, or less when that is enough.
    const aim = share! > 0 ? zoom * (FILL_TARGET / share!) : zoom * STEP;
    const next = round(Math.min(ceiling, Math.max(floor, dir > 0 ? Math.min(zoom * STEP, aim) : Math.max(zoom / STEP, aim))));
    if (Math.abs(next - zoom) < 0.05) return null;
    this.lastStep = now;
    this.run = 0;
    return next;
  }
}

// Wide when it struggles (Bryan, 23 Nov 2026: "Quite a few of the foils were hard to scan ... using
// the 0.5x camera worked better ... we're supposed to have something in there that switches camera
// lenses and zoomed in and zoomed out if we struggled"). His diagnostics that day: a foil (Jiang
// Yanggu) sat at art 0.55 to 0.64 for 21 s at 1x and was named at once at 0.5x (0.734, lead 0.175);
// cards at 0.5x were 1,020 to 1,190 px tall (about half of 1x), still well above the collector
// line's reading floor, and the 1x foils showed a blown highlight in the art that the 0.5x ones
// didn't [inferred: nearer the main lens's closest focus, and a different angle to the light].
// So: a card held steady in view and not named for WIDE_AFTER_MS, or held so close at 1x that it
// overfills the view, steps the camera out to its wide lens (WIDE_ZOOM) once; the view empty (no
// steady card) for WIDE_BACK_MS brings it back to 1x for the next card. Only on a camera that zooms
// out that far (a phone with an ultra-wide behind one logical camera), never once the person zoomed.

/** A steady card in view and not named this long goes wide. */
export const WIDE_AFTER_MS = 3000;
/** The zoom it goes to (the ultra-wide on a Pixel: 0.5×). */
export const WIDE_ZOOM = 0.5;
/** Only a camera whose zoom reaches this far out has a wider lens to go to. */
export const WIDE_MIN = 0.65;
/** The view empty this long after going wide: back to 1× for the next card. */
export const WIDE_BACK_MS = 1500;

export class WideOnStruggle {
  private since: number | null = null;
  private emptySince: number | null = null;
  private close = 0;
  private wide = false;

  constructor(private readonly range: ZoomRange) {}

  /** Whether the camera was sent wide and hasn't come back (auto-zoom waits meanwhile). */
  get isWide(): boolean {
    return this.wide;
  }

  /** Whether this camera can go wide at all. */
  get can(): boolean {
    return this.range.min <= WIDE_MIN;
  }

  /**
   * One frame: `share`, the card's height over the view's (null with no card in view); `steady`,
   * whether it's about where and as big as on the frame before (outline.ts `agrees`: the finder's
   * "card" on an empty table jumps); `named`, whether the card in view has been named. The zoom to
   * set now, or null.
   */
  frame(share: number | null, steady: boolean, named: boolean, zoom: number, now: number): number | null {
    if (!this.can) return null;
    if (this.wide) {
      // A card still there: seen steady (a "card" that jumps on an empty table isn't one).
      if (share != null && steady) {
        this.emptySince = null;
        return null;
      }
      this.emptySince ??= now;
      if (now - this.emptySince < WIDE_BACK_MS) return null;
      this.wide = false;
      this.since = null;
      this.emptySince = null;
      this.close = 0;
      return Math.max(1, this.range.min);
    }
    if (share == null || !steady || named) {
      this.since = null;
      this.close = 0;
      return null;
    }
    this.since ??= now;
    this.close = share > FILL_HIGH && zoom <= 1.05 ? this.close + 1 : 0;
    if (now - this.since < WIDE_AFTER_MS && this.close < STEADY) return null;
    this.wide = true;
    this.emptySince = null;
    return round(Math.max(this.range.min, WIDE_ZOOM));
  }
}
