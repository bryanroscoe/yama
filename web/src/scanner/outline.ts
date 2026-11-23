// The outline over each card the card finder sees (docs/plans/scanner-match-cardvision.md, item 1).
// The finder reports corners a few times a second; the screen redraws sixty. So each card is a
// track that eases towards the corners last reported and fades in and out, stepped once per screen
// frame by whoever draws it (CardOutline.tsx). Pure: no DOM, and time is passed in.
//
// It only draws. Nothing here feeds back into what the scanner decides.

import type { Point, Quad } from "./types";

/** Most cards outlined at once. */
export const MAX_OUTLINES = 4;
/** The drawn corners close this share of the gap to the reported ones every EASE_MS (1 − 1/e). */
export const EASE_MS = 70;
export const FADE_IN_MS = 120;
export const FADE_OUT_MS = 220;

export interface OutlineFrame {
  /** Where to draw it now, in the same pixels the corners were reported in. */
  quad: Quad;
  /** 0 to 1. */
  opacity: number;
}

interface Track {
  shown: Quad;
  target: Quad;
  opacity: number;
  /** Seen on the last pass: fading in or steady. Otherwise fading out. */
  live: boolean;
  /** Seen on two passes in a row about where and as big (`agrees`): only then is it drawn. */
  steady: boolean;
}

/**
 * Steadiness (Bryan, 23 Nov 2026: "The outline jumps around all over the place when there's nothing
 * there"): with no card in view the finder still sees a "card" on the table on many frames, at
 * another place and size each time; a real card stays put. A card is drawn once seen on two passes
 * in a row within STEADY_MOVE of its diagonal and STEADY_SIZE of its size (OutlineSteady.java, the
 * app's own outline, the same rule).
 */
export const STEADY_MOVE = 0.35;
export const STEADY_SIZE = 1.45;
/** An outline already drawn follows its card this far between passes (a card being moved), at the same size. */
export const FOLLOW_MOVE = 0.75;

const centre = (q: Quad): Point => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const diagonal = (q: Quad) => Math.max(dist(q[0], q[2]), dist(q[1], q[3]));
const finite = (q: Quad) => q.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

/** Whether `q` is about where (within `move` of the diagonal) and as big (STEADY_SIZE) as `like`. */
export function agrees(q: Quad, like: Quad, move = STEADY_MOVE): boolean {
  const dq = diagonal(q);
  const dl = diagonal(like);
  if (!(dq > 0) || !(dl > 0)) return false;
  const ratio = dq / dl;
  if (ratio > STEADY_SIZE || ratio < 1 / STEADY_SIZE) return false;
  return dist(centre(q), centre(like)) <= move * Math.max(dq, dl);
}

/**
 * `q` with its corners started from whichever one keeps each nearest the matching corner of `like`:
 * the finder's idea of the card's top can flip between passes, which would spin the outline.
 */
export function alignCorners(q: Quad, like: Quad): Quad {
  let best = q;
  let bestCost = Infinity;
  for (let turn = 0; turn < 4; turn += 1) {
    const t = [q[turn % 4]!, q[(turn + 1) % 4]!, q[(turn + 2) % 4]!, q[(turn + 3) % 4]!] as Quad;
    const cost = t.reduce((sum, p, i) => sum + dist(p, like[i]!), 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = t;
    }
  }
  return best;
}

export class OutlineTracker {
  private tracks: Track[] = [];
  private last: number | null = null;
  /** The size of the image the corners are in (the SVG's viewBox). */
  size: { w: number; h: number } = { w: 0, h: 0 };
  /** Called when there's something to draw again after going idle. */
  onWake: (() => void) | null = null;
  /** No easing or fading (prefers-reduced-motion): the outline is where the card is, or gone. */
  still = false;

  /** The cards the finder sees now: every pass, with none when it sees none. */
  see(quads: readonly Quad[], size?: { w: number; h: number }) {
    if (size) this.size = size;
    const seen = quads.filter(finite).slice(0, MAX_OUTLINES);
    const free = new Set(this.tracks);
    const fresh: Track[] = [];
    for (const q of seen) {
      const c = centre(q);
      // The nearest track not yet taken that it agrees with (about where and as big).
      let near: Track | null = null;
      let nearDist = Infinity;
      for (const t of free) {
        const d = dist(centre(t.target), c);
        if (d < nearDist && agrees(q, t.target, t.steady ? FOLLOW_MOVE : STEADY_MOVE)) {
          near = t;
          nearDist = d;
        }
      }
      if (near) {
        free.delete(near);
        near.target = alignCorners(q, near.target);
        near.live = true;
        near.steady = true;
      } else fresh.push({ shown: q, target: q, opacity: 0, live: true, steady: false });
    }
    for (const t of free) t.live = false;
    // The cards seen now come first, so they are the ones kept and drawn when there are too many.
    const all = [...this.tracks, ...fresh];
    this.tracks = [...all.filter((t) => t.live), ...all.filter((t) => !t.live)].slice(0, MAX_OUTLINES * 2);
    if (this.tracks.length) this.onWake?.();
  }

  /** Nothing is seen any more (the scanner paused, a card was found): fade out what's drawn. */
  clear() {
    this.see([]);
  }

  /** Whether anything is still drawn or fading. */
  get active(): boolean {
    return this.tracks.length > 0;
  }

  /** Step to `now` (ms, any steady clock) and say what to draw. */
  frame(now: number): OutlineFrame[] {
    // A long gap (a hidden tab) counts as one frame.
    const dt = this.last == null ? 16 : Math.min(100, Math.max(0, now - this.last));
    this.last = now;
    const ease = this.still ? 1 : 1 - Math.exp(-dt / EASE_MS);
    for (const t of this.tracks) {
      t.shown = t.shown.map((p, i) => [p[0] + (t.target[i]![0] - p[0]) * ease, p[1] + (t.target[i]![1] - p[1]) * ease]) as Quad;
      // Only a steady card is drawn: one seen once is waited on, unseen.
      const on = t.live && t.steady;
      if (this.still) t.opacity = on ? 1 : 0;
      else t.opacity = on ? Math.min(1, t.opacity + dt / FADE_IN_MS) : Math.max(0, t.opacity - dt / FADE_OUT_MS);
    }
    this.tracks = this.tracks.filter((t) => t.live || t.opacity > 0);
    if (!this.tracks.length) this.last = null;
    // (A card seen once, not yet steady, is kept but not drawn.)
    return this.tracks
      .filter((t) => t.opacity > 0)
      .slice(0, MAX_OUTLINES)
      .map((t) => ({ quad: t.shown, opacity: t.opacity }));
  }
}

export type OutlineStyle = "corners" | "whole";

/** A card's corner radius and the length of each corner mark, as shares of its short side. */
const RADIUS = 0.05;
const ARM = 0.2;

const n1 = (v: number) => Math.round(v * 10) / 10;
const pt = (p: Point) => `${n1(p[0])} ${n1(p[1])}`;

/**
 * The SVG path of a card's outline: four rounded corner marks, or the whole rounded outline. The
 * corners are rounded like a card's, each with a curve through the corner the finder placed.
 */
export function outlinePath(quad: Quad, style: OutlineStyle = "corners"): string {
  const side = (i: number) => dist(quad[i]!, quad[(i + 1) % 4]!);
  const short = Math.min(side(0), side(1), side(2), side(3));
  if (!(short > 0) || !finite(quad)) return "";
  const r = short * RADIUS;
  const arm = short * ARM;
  /** From corner `i`, `d` pixels towards corner `j`. */
  const along = (i: number, j: number, d: number): Point => {
    const a = quad[i]!;
    const b = quad[j]!;
    const len = dist(a, b) || 1;
    return [a[0] + ((b[0] - a[0]) * d) / len, a[1] + ((b[1] - a[1]) * d) / len];
  };
  const parts: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const prev = (i + 3) % 4;
    const next = (i + 1) % 4;
    const curve = `Q${pt(quad[i]!)} ${pt(along(i, next, r))}`;
    if (style === "corners") parts.push(`M${pt(along(i, prev, arm))}L${pt(along(i, prev, r))}${curve}L${pt(along(i, next, arm))}`);
    else parts.push(`${i === 0 ? "M" : "L"}${pt(along(i, prev, r))}${curve}`);
  }
  return style === "whole" ? `${parts.join("")}Z` : parts.join("");
}
