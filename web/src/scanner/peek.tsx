// "From your card" (Bryan, 15 Nov 2026: the sheet covers the bottom of the camera, where the set
// code and number are, so he couldn't read them himself while choosing a printing). The corner of
// the card with its collector line, cut from the camera's own frame the way the text reader cuts
// it, enlarged to the sheet's width at the top of the printing list. It's the person's own photo,
// shown as captured, in colour; while the scanner reads the held card it follows the latest frame.

import { useEffect, useRef } from "react";
import { warpRegionRgba, type CardRegion } from "./image";
import { WIDE_COLLECTOR_REGION } from "./pipeline";
import type { Quad, RgbaImage } from "./types";

/** The text reader's wider cut of the corner, with a little more above for the rarity line. */
export const PEEK_REGION: CardRegion = { ...WIDE_COLLECTOR_REGION, y0: 0.87 };
/** Widest the cut is drawn at; the sheet scales it to fit. */
const MAX_WIDTH = 1200;

/** Pixels across the cut at the card's own resolution in the frame (never enlarged), and its height. */
export function peekSize(quad: Quad, region: CardRegion = PEEK_REGION): { width: number; height: number } {
  const cardW = Math.max(Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]), Math.hypot(quad[2][0] - quad[3][0], quad[2][1] - quad[3][1]));
  const width = Math.max(120, Math.min(MAX_WIDTH, Math.round(cardW * (region.x1 - region.x0))));
  // The card is 63 × 88: a region's height in card widths is (y1 − y0) × 88 / 63.
  const height = Math.max(1, Math.round((width * ((region.y1 - region.y0) * 88)) / ((region.x1 - region.x0) * 63)));
  return { width, height };
}

export function CollectorPeek({ shot }: { shot: { image: RgbaImage; quad: Quad } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width, height } = peekSize(shot.quad);
    const cut = warpRegionRgba(shot.image, shot.quad, PEEK_REGION, width, height);
    canvas.width = width;
    canvas.height = height;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(cut.data), width, height), 0, 0);
  }, [shot]);
  return (
    <figure className="scan-peek">
      <canvas ref={ref} role="img" aria-label="The bottom-left corner of your card, with its set code and number" />
      <figcaption className="scan-note">From your card</figcaption>
    </figure>
  );
}
