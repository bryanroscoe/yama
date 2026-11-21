// The placement gate (docs/plans/scanner-match-cardvision.md, items 6 to 11): when to read a card.
// Without it the scanner reads every frame and settles on rules that count frames. With it, a card
// is read when it has come to rest, once, from the sharpest frame of its stay:
//
//   - moving or still: the card's speed over the last 100 ms;
//   - a placement: one stay of a card at rest. It is read after a short wait for a sharper frame,
//     from the sharpest frame seen, and tried again (50 ms apart) up to five times; then
//     "No match, move the card";
//   - latched: a placement that was named isn't read again, however long the card lies there. A small
//     grey thumbnail of the card tells the same card (shifted, nudged, lost for a frame) from another
//     card put in its place, so neither needs a count of frames or a wait;
//   - the same card named again within 3 s, without having left the view, is not reported again.
//
// Pure: no DOM, no camera, no clock. Its input is a `GateObservation` (the card finder's corners at a
// time, with each card's sharpness and thumbnail where the source has them), so the browser camera and
// the native Android camera feed the same gate (docs/scanner.md, "The placement gate").

import { alignCorners } from "./outline";
import type { Point, Quad } from "./types";

/** One card in one pass of a card finder. `F` is whatever the source needs to read that frame later. */
export interface GateCard<F = unknown> {
  /** Corners in the source's own pixels, in any consistent order. */
  quad: Quad;
  /** How sharp this frame's picture of the card is (any scale, higher is sharper; `frameSharpness`). */
  sharpness?: number;
  /** A THUMB_SIDE × THUMB_SIDE grey picture of the card, upright as the corners give it (`cardThumb`). */
  thumb?: Uint8Array | Uint8ClampedArray;
  /** The frame itself, or a handle to it, handed back with a "read" decision. The gate never looks inside. */
  frame?: F;
}

/** One pass of a card finder: the gate's whole input. */
export interface GateObservation<F = unknown> {
  /** When the frame was taken: milliseconds on any steady clock. */
  at: number;
  /** Every card the finder sees, none when it sees none. */
  cards: readonly GateCard<F>[];
}

/** Something that feeds a gate: the browser camera's read loop, or the native camera plugin. */
export interface GateSource<F = unknown> {
  /** Start sending observations; returns the stop. */
  watch(onObservation: (o: GateObservation<F>) => void): () => void;
}

export const THUMB_SIDE = 48;
/** Passes in a row a latched card's thumbnail must differ before it's taken for another card in its place. */
export const SWAP_PASSES = 2;

export interface GateOptions {
  /** The window the card's speed is measured over. */
  speedWindowMs: number;
  /** A reference older than this can't measure speed (the finder stalled): not still yet. */
  staleMs: number;
  /** Still at or under this speed, in card short sides a second. */
  stillSpeed: number;
  /** How long a placement waits for a sharper frame before its first read, and the most frames it waits for. */
  sharpWaitMs: number;
  sharpWaitFrames: number;
  /** A frame at least this sharp is read at once (0: always wait). */
  sharpEnough: number;
  /** The least time between two reads of a placement. */
  retryMs: number;
  /** Reads of one placement before "No match, move the card". */
  maxAttempts: number;
  /** The same card isn't reported again within this, unless it left the view. */
  suppressMs: number;
  /**
   * The view has been empty this long, over passes that followed one another: the card has left.
   * A gap between two passes (the scanner paused, a slow read) counts for at most `gapMs`, so one
   * empty pass after a pause isn't the card leaving.
   */
  awayMs: number;
  gapMs: number;
  /**
   * With nothing recent to measure speed from (a read took longer than `staleMs`), the card is
   * still where it was if no corner is further than this from its last sighting, in short sides.
   */
  stay: number;
  /**
   * Two thumbnails are the same card at this correlation or more (−1 to 1). High on purpose: taking
   * the same card for another only costs a read (the caller still knows the card it just filed by
   * its art), while taking another card for the same would leave it unread.
   */
  sameThumb: number;
}

export const GATE_DEFAULTS: GateOptions = {
  speedWindowMs: 100,
  staleMs: 500,
  stillSpeed: 0.35,
  sharpWaitMs: 120,
  sharpWaitFrames: 3,
  sharpEnough: 0,
  retryMs: 50,
  maxAttempts: 5,
  suppressMs: 3000,
  awayMs: 350,
  gapMs: 150,
  stay: 0.08,
  sameThumb: 0.85,
};

export type GateDecision<F = unknown> = (
  | { kind: "none" }
  | { kind: "moving" }
  /** At rest, and waiting: for a sharper frame, or between two reads. */
  | { kind: "steadying" }
  /** Read this frame now (the sharpest since the last read), then say `named` or `missed`. */
  | { kind: "read"; attempt: number; quad: Quad; frame: F | undefined; sharpness: number | undefined; placement: number }
  /** A read was asked for and hasn't been answered yet. */
  | { kind: "reading" }
  /** This placement was named already (as `key`): nothing to do while it lies there. */
  | { kind: "latched"; key: string }
  /** Every try failed: "No match, move the card". */
  | { kind: "no-match" }
) & {
  /**
   * The card that was latched is gone: the view emptied, or another card took its place. Said once,
   * on the first decision after.
   */
  released?: true;
  /** When the card in view was first seen this stay in the view (`at` of that observation). */
  since?: number;
};

interface Seen {
  at: number;
  quad: Quad;
}

interface Placement<F> {
  /** Which placement this is: a read is answered for the placement it was asked of. */
  id: number;
  /** When the card came to rest. */
  since: number;
  attempts: number;
  /** Frames seen since the placement began, or since its last read. */
  frames: number;
  /** The sharpest frame since the placement began, or since its last read. */
  best: GateCard<F> | null;
  lastRead: number | null;
  reading: boolean;
  gaveUp: boolean;
  thumb: Uint8Array | Uint8ClampedArray | null;
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const shortSide = (q: Quad) => Math.min(dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0]));
/** Twice the quad's area (shoelace), for choosing the nearest card. */
const area2 = (q: Quad) => Math.abs(q.reduce((sum, p, i) => sum + p[0] * q[(i + 1) % 4]![1] - q[(i + 1) % 4]![0] * p[1], 0));

/**
 * The card's speed between two sightings, in its own short sides a second: the corner that moved
 * furthest, so a turn or a tilt counts as well as a slide. Corners are matched by nearness, since the
 * finder's idea of the top can flip.
 */
export function cardSpeed(from: Seen, to: Seen): number {
  const dt = (to.at - from.at) / 1000;
  const side = shortSide(to.quad);
  if (!(dt > 0) || !(side > 0)) return Infinity;
  const was = alignCorners(from.quad, to.quad);
  const moved = Math.max(...to.quad.map((p, i) => dist(p, was[i]!)));
  return moved / side / dt;
}

/**
 * How alike two thumbnails are: their correlation (−1 to 1) after each is brought to its own mean and
 * spread, so a brighter or dimmer frame of the same card still matches. 0 when either is flat or
 * they differ in size.
 */
export function thumbLikeness(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray): number {
  const n = a.length;
  if (!n || n !== b.length) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i]!;
    mb += b[i]!;
  }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** How far the card's furthest corner is from where it was, in its own short sides. */
export function cardShift(from: Quad, to: Quad): number {
  const side = shortSide(to);
  if (!(side > 0)) return Infinity;
  const was = alignCorners(from, to);
  return Math.max(...to.map((p, i) => dist(p, was[i]!))) / side;
}

/** Whether the card is at rest: its speed over the window, from sightings kept by the caller. */
export class Motion {
  private seen: Seen[] = [];
  constructor(
    private readonly windowMs = GATE_DEFAULTS.speedWindowMs,
    private readonly staleMs = GATE_DEFAULTS.staleMs,
    private readonly stay = GATE_DEFAULTS.stay,
  ) {}

  reset() {
    this.seen = [];
  }

  /**
   * The card's speed now, in short sides a second, measured from the newest sighting at least the
   * window ago; null while there is none that old (so it can't be called still yet). When that
   * sighting is stale (nothing was seen for a while: a read that took over `staleMs`), speed can't
   * be measured, so the card counts as at rest (0) if it is where it was, and null if it isn't.
   */
  speed(at: number, quad: Quad): number | null {
    const now: Seen = { at, quad };
    // Keep the newest sighting that is a window old or more, and everything after it.
    const edge = at - this.windowMs;
    let from = -1;
    for (let i = this.seen.length - 1; i >= 0; i -= 1) {
      if (this.seen[i]!.at <= edge) {
        from = i;
        break;
      }
    }
    const ref = from >= 0 ? this.seen[from]! : null;
    if (from > 0) this.seen = this.seen.slice(from);
    this.seen.push(now);
    if (!ref) return null;
    if (at - ref.at > this.staleMs) return cardShift(ref.quad, quad) <= this.stay ? 0 : null;
    return cardSpeed(ref, now);
  }
}

export class PlacementGate<F = unknown> {
  readonly options: GateOptions;
  private readonly motion: Motion;
  /** When the card in view was first seen, this stay in the view. */
  private since: number | null = null;
  /** Whether a card has been seen since the view was last empty for `awayMs`. */
  private present = false;
  /** The last observation's time, and how long the view has been empty over passes in a row. */
  private lastAt: number | null = null;
  private emptyFor = 0;
  private placements = 0;
  /** Passes in a row on which the card at rest hasn't looked like the latched one. */
  private unlike = 0;
  private placement: Placement<F> | null = null;
  /** The placement that was named: its key and thumbnail, until the card leaves or another takes its place. */
  private latch: { key: string; thumb: Uint8Array | Uint8ClampedArray | null } | null = null;
  /** The card last reported, when, and whether the view has emptied since. */
  private reported: { key: string; at: number; left: boolean } | null = null;
  private releasedPending = false;

  constructor(options: Partial<GateOptions> = {}) {
    this.options = { ...GATE_DEFAULTS, ...options };
    this.motion = new Motion(this.options.speedWindowMs, this.options.staleMs, this.options.stay);
  }

  /** Forget everything (another camera, the scanner reopened). */
  reset() {
    this.motion.reset();
    this.since = null;
    this.present = false;
    this.lastAt = null;
    this.emptyFor = 0;
    this.placement = null;
    this.latch = null;
    this.reported = null;
    this.releasedPending = false;
    this.unlike = 0;
  }

  /** The card the gate goes by when the finder sees several: the largest in the frame. */
  static primary<F>(cards: readonly GateCard<F>[]): GateCard<F> | null {
    let best: GateCard<F> | null = null;
    let bestArea = 0;
    for (const c of cards) {
      const a = area2(c.quad);
      if (Number.isFinite(a) && a > bestArea) {
        best = c;
        bestArea = a;
      }
    }
    return best;
  }

  private decide(d: GateDecision<F>): GateDecision<F> {
    if (this.releasedPending) {
      d.released = true;
      this.releasedPending = false;
    }
    if (this.since != null) d.since = this.since;
    return d;
  }

  private release() {
    if (this.latch) this.releasedPending = true;
    this.latch = null;
  }

  /** One pass of the finder. */
  observe(o: GateObservation<F>): GateDecision<F> {
    const o_ = this.options;
    const card = PlacementGate.primary(o.cards);
    const gap = this.lastAt == null ? 0 : Math.min(o_.gapMs, Math.max(0, o.at - this.lastAt));
    this.lastAt = o.at;
    if (!card) {
      // Nothing seen. A pass or two with nothing isn't the card leaving; `awayMs` of empty passes
      // one after another is (the time before the first of them doesn't count).
      this.emptyFor = this.emptyFor < 0 ? 0 : this.emptyFor + gap;
      if (this.present && this.emptyFor >= o_.awayMs) {
        this.release();
        this.placement = null;
        this.since = null;
        this.present = false;
        this.motion.reset();
        if (this.reported) this.reported.left = true;
      }
      return this.decide({ kind: "none" });
    }
    this.emptyFor = -1;
    this.present = true;
    this.since ??= o.at;
    const speed = this.motion.speed(o.at, card.quad);
    if (speed == null || speed > o_.stillSpeed) {
      // On the move: whatever placement there was is over. (A latch outlives it: the thumbnail
      // says, when the card comes to rest, whether it is still that card.) A read still out is
      // answered into nothing.
      this.placement = null;
      return this.decide({ kind: "moving" });
    }
    let p = this.placement;
    if (!p) {
      p = this.placement = { id: (this.placements += 1), since: o.at, attempts: 0, frames: 0, best: null, lastRead: null, reading: false, gaveUp: false, thumb: card.thumb ?? null };
      // The card that was named, come to rest again: still latched. Another card: the latch is over.
      if (this.latch && !this.sameCard(this.latch.thumb, card.thumb)) this.release();
    }
    if (this.latch) {
      // Another card in the very same place (swapped with no movement the finder saw): its
      // thumbnail says so. Two passes in a row, so one odd frame isn't one. (A hand held over the
      // card will be: that costs a read, which the caller's hold on the card it filed absorbs.)
      this.unlike = this.sameCard(this.latch.thumb, card.thumb) ? 0 : this.unlike + 1;
      if (this.unlike < SWAP_PASSES) return this.decide({ kind: "latched", key: this.latch.key });
      this.release();
      p = this.placement = { id: (this.placements += 1), since: o.at, attempts: 0, frames: 0, best: null, lastRead: null, reading: false, gaveUp: false, thumb: card.thumb ?? null };
    }
    this.unlike = 0;
    if (p.gaveUp) return this.decide({ kind: "no-match" });
    if (p.reading) return this.decide({ kind: "reading" });
    p.frames += 1;
    if (!p.best || (card.sharpness ?? 0) > (p.best.sharpness ?? 0)) p.best = card;
    const sharp = o_.sharpEnough > 0 && (p.best.sharpness ?? 0) >= o_.sharpEnough;
    const waited = p.lastRead == null ? sharp || o.at - p.since >= o_.sharpWaitMs || p.frames >= o_.sharpWaitFrames : o.at - p.lastRead >= o_.retryMs;
    if (!waited) return this.decide({ kind: "steadying" });
    const best = p.best;
    p.best = null;
    p.frames = 0;
    p.attempts += 1;
    p.reading = true;
    return this.decide({ kind: "read", attempt: p.attempts, quad: best.quad, frame: best.frame, sharpness: best.sharpness, placement: p.id });
  }

  /**
   * Without thumbnails there's nothing to tell cards apart by: the card at rest is taken to be the
   * same one. Either way up: the finder may call the other end the top the next time it rests.
   */
  private sameCard(a: Uint8Array | Uint8ClampedArray | null, b: Uint8Array | Uint8ClampedArray | null | undefined): boolean {
    if (!a || !b) return true;
    return Math.max(thumbLikeness(a, b), thumbLikeness(a, Uint8Array.from(b).reverse())) >= this.options.sameThumb;
  }

  /** The placement a read's answer is for: the one at rest now, unless the read was asked of another. */
  private asked(placement?: number): Placement<F> | null {
    const p = this.placement;
    return p && (placement == null || placement === p.id) ? p : null;
  }

  /**
   * Whether naming `key` now would be the same card again: it was reported within `suppressMs` and
   * the view hasn't emptied since. Ask before showing a card; `named` latches it either way.
   */
  suppresses(key: string, at: number): boolean {
    const r = this.reported;
    return !!r && r.key === key && !r.left && at - r.at < this.options.suppressMs;
  }

  /**
   * The read named the card (or found it to be the card already held): the placement is latched
   * and won't be read again. Returns false when it's the same card again within `suppressMs` with
   * no empty view between, which the caller doesn't report. `placement` is the read's own (from
   * the "read" decision): an answer that comes after the card moved on latches nothing, since the
   * card at rest now may be another.
   */
  named(key: string, at: number, placement?: number): boolean {
    const fresh = !this.suppresses(key, at);
    const p = this.asked(placement);
    if (p) {
      p.reading = false;
      this.latch = { key, thumb: p.thumb };
    }
    if (fresh) this.reported = { key, at, left: false };
    return fresh;
  }

  /** The read named nothing: another is due after `retryMs`, until `maxAttempts`. */
  missed(at: number, placement?: number) {
    const p = this.asked(placement);
    if (!p) return;
    p.reading = false;
    p.lastRead = at;
    if (p.attempts >= this.options.maxAttempts) p.gaveUp = true;
  }

  /** The read was dropped without an answer (the scanner paused): it doesn't count as a try. */
  dropped(placement?: number) {
    const p = this.asked(placement);
    if (!p || !p.reading) return;
    p.reading = false;
    p.attempts = Math.max(0, p.attempts - 1);
  }

  /** Tries made on the placement at rest now. */
  get attempts(): number {
    return this.placement?.attempts ?? 0;
  }

  /** Let go of a latch from outside (the person asked to scan the same card again). */
  unlatch() {
    this.latch = null;
    this.releasedPending = false;
    if (this.reported) this.reported.left = true;
    if (this.placement) {
      this.placement.attempts = 0;
      this.placement.gaveUp = false;
      this.placement.lastRead = null;
      this.placement.best = null;
      this.placement.frames = 0;
    }
  }
}
