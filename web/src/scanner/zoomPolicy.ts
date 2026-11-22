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
