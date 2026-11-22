// The card's border colour, read from its edge in the frame (docs/plans/scanner-match-cardvision.md,
// item 24): a black-bordered card can't be a white-bordered printing, and the other way round, so a
// border read surely rules those printings out. Measured on Bryan's own scan photos before it was
// trusted (docs/scanner.md, "Border colour"); it says nothing unless every side agrees, and only
// black against white (a borderless card's edge is its art, which can be any colour).

import type { Printing } from "../api";
import { applyH, squareToQuad } from "./image";
import type { Quad, RgbaImage } from "./types";

export type Border = "black" | "white";

/** What the band just inside the card's edge looked like, side by side, for diagnostics. */
export interface BorderRead {
  /** The colour, when every side agrees and is plainly dark or plainly light; null otherwise. */
  border: Border | null;
  /** Each side's median brightness (0 to 255), top, right, bottom, left. */
  sides: number[];
  /** Each side's spread (the middle half of its brightness, high less low). */
  spread: number[];
  /** Each side's median colourfulness (the largest channel less the smallest). */
  chroma: number[];
  /** Each side's median brightness just outside the card (null where that's out of the frame). */
  outside: (number | null)[];
}

/**
 * Where the band is, as a share of the card's width from its edge: inside the border of any black-
 * or white-bordered card (about 3% wide), clear of the edge itself, which the finder's outline may
 * miss by a little.
 */
export const BAND = { from: 0.012, to: 0.024 } as const;
/** And what lies just outside it (the table, a sleeve's margin), which the band must differ from. */
export const OUTSIDE = { from: -0.03, to: -0.012 } as const;
/** How far along each side the band runs (the corners are rounded, and the type line can touch the frame). */
const ALONG = { from: 0.18, to: 0.82 } as const;
/** Samples along each side, and across the band. */
const STEPS = { along: 24, across: 3 } as const;

/**
 * The thresholds, set from the real photos (docs/scanner.md, "Border colour"): a side is dark at a
 * median brightness under DARK and light over LIGHT with little colour, and either only when it's
 * even (a spread under EVEN). Art or a frame's edge is neither. [measured on 117 of Bryan's photos]
 */
export const BORDER_RULE = { dark: 95, light: 165, even: 45, grey: 40, contrast: 40, sides: 3 } as const;

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const quartiles = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length * 3) / 4)]! - s[Math.floor(s.length / 4)]! : 0;
};

/**
 * Read the border from a card's corners in an image (top-left, top-right, bottom-right,
 * bottom-left as the card stands, which the finder gives). Never throws: a quad partly out of
 * the image reads only what's inside it, and says nothing when a side has too little.
 */
export function readBorder(image: RgbaImage, quad: Quad): BorderRead {
  const h = squareToQuad(quad);
  const { width, height, data } = image;
  /** Brightness and colourfulness along one side, at depths `band` (shares of the card's width; negative is outside). */
  const along = (side: number, band: { from: number; to: number }) => {
    const lum: number[] = [];
    const chr: number[] = [];
    for (let i = 0; i < STEPS.along; i++) {
      const t = ALONG.from + ((ALONG.to - ALONG.from) * (i + 0.5)) / STEPS.along;
      for (let j = 0; j < STEPS.across; j++) {
        const k = band.from + ((band.to - band.from) * (j + 0.5)) / STEPS.across;
        // The depth as a share of the card's height too: the card is 63 by 88.
        const ku = k;
        const kv = (k * 63) / 88;
        // (u, v) in the card's own square: top, right, bottom, left.
        const [u, v] = side === 0 ? [t, kv] : side === 1 ? [1 - ku, t] : side === 2 ? [t, 1 - kv] : [ku, t];
        const [x, y] = applyH(h, u, v);
        const xi = Math.round(x);
        const yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= width || yi >= height) continue;
        const o = (yi * width + xi) * 4;
        const r = data[o]!;
        const g = data[o + 1]!;
        const b = data[o + 2]!;
        lum.push(0.299 * r + 0.587 * g + 0.114 * b);
        chr.push(Math.max(r, g, b) - Math.min(r, g, b));
      }
    }
    return { lum, chr, enough: lum.length >= (STEPS.along * STEPS.across) / 2 };
  };
  const sides: number[] = [];
  const spread: number[] = [];
  const chroma: number[] = [];
  const outside: (number | null)[] = [];
  let short = false;
  for (let side = 0; side < 4; side++) {
    const band = along(side, BAND);
    if (!band.enough) short = true;
    sides.push(Math.round(median(band.lum)));
    spread.push(Math.round(quartiles(band.lum)));
    chroma.push(Math.round(median(band.chr)));
    const out = along(side, OUTSIDE);
    outside.push(out.enough ? Math.round(median(out.lum)) : null);
  }
  return { border: short ? null : judge(sides, spread, chroma, outside), sides, spread, chroma, outside };
}

/**
 * Black or white only when all four sides say so, each plainly and evenly, and at least
 * BORDER_RULE.sides of them differ from what lies just outside the card: a band that looks like
 * the table may be the table (an outline a little wide, or a sleeve's clear margin).
 */
function judge(sides: number[], spread: number[], chroma: number[], outside: (number | null)[]): Border | null {
  if (!spread.every((s) => s < BORDER_RULE.even)) return null;
  const apart = sides.filter((l, i) => outside[i] != null && Math.abs(l - outside[i]!) >= BORDER_RULE.contrast).length;
  if (apart < BORDER_RULE.sides) return null;
  if (sides.every((l) => l < BORDER_RULE.dark)) return "black";
  if (sides.every((l, i) => l > BORDER_RULE.light && chroma[i]! < BORDER_RULE.grey)) return "white";
  return null;
}

/**
 * The printings a border read leaves: a black border rules out white-bordered printings, a white
 * one black-bordered printings. A printing whose border the card data doesn't say, or any other
 * border (borderless, silver, gold), is never ruled out; nor is anything when every printing would be.
 */
export function byBorder<P extends Pick<Printing, "border_color">>(printings: readonly P[], border: Border | null): P[] {
  if (!border) return [...printings];
  const other: Border = border === "black" ? "white" : "black";
  const kept = printings.filter((p) => p.border_color !== other);
  return kept.length > 0 ? kept : [...printings];
}
