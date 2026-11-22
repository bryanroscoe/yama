// Cutting a scan photo (samples.ts) from the view of the camera frame the card was found in: the
// photo, at most 640 px with everything outside the card blanked, and the full-resolution crops of
// the card (crops.ts), each warped upright from its corners at the card's own resolution in the
// frame, never enlarged:
//
//   - `symbol`, the set symbol's area, and `strip`, the collector strip (since 20 Nov 2026), for a
//     printing model and replaying collector-line reads;
//   - `card`, the whole card, at most CARD_CROP_MAX tall (since 22 Nov 2026), for a whole-card art
//     model (one crop per read: docs/plans/scanner-match-cardvision.md, item 17) and the printing
//     look's whole-card half.
//
// Runs in the scan photo worker (photo.worker.ts) so scanning never waits on it, or on the page
// where a worker or OffscreenCanvas isn't there. Only a canvas: no API, no document beyond one.

import { cardOf, stripOf, symbolOf, type Shot } from "./crops";
import type { Quad, RgbaImage } from "./types";

/** Longest side of a kept photo. */
export const LONG_SIDE = 640;
/** JPEG quality of the photo. */
const PHOTO_QUALITY = 0.8;
/** How far past the detected corners the kept photo reaches, as a share of the card's size. */
const CARD_MARGIN = 0.04;
/** JPEG quality of the crops: what a model or a replay reads, so a little above the photo's. */
export const CROP_QUALITY = 0.85;
/** The largest crop the server takes (scan_samples.rs, MAX_CROP): a larger one is left out, not the photo. */
export const MAX_CROP_BYTES = 1024 * 1024;
/** The whole card crop's tallest (Bryan, 22 Nov 2026: "capped around 1,100 px tall, never enlarged"). */
export const CARD_CROP_MAX = 1100;

export type CropName = "symbol" | "strip" | "card";

/** A crop kept with a photo: base64 JPEG and its size. */
export interface Crop {
  name: CropName;
  image: string;
  width: number;
  height: number;
}

/** A photo cut and encoded: the JPEG (base64), the card's quad in it, and its crops. */
export interface Cut {
  image: string;
  quad: Quad;
  crops: Crop[];
}

/** The quad grown away from its centre by `margin` of its size. */
export function cardOutline(quad: Quad, margin: number): Quad {
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
  const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  return quad.map(([x, y]) => [cx + (x - cx) * (1 + margin), cy + (y - cy) * (1 + margin)]) as Quad;
}

/** Each crop and how it's cut from a shot, in the order they're kept. */
export const CROPS: readonly (readonly [CropName, (shot: Shot) => RgbaImage])[] = [
  ["symbol", symbolOf],
  ["strip", stripOf],
  ["card", (shot) => cardOf(shot, CARD_CROP_MAX)],
];

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Context = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** A canvas to draw on: an OffscreenCanvas where there is one (always, in a worker). */
function canvasOf(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

function contextOf(c: AnyCanvas): Context {
  const ctx = c.getContext("2d") as Context | null;
  if (!ctx) throw new Error("No 2D canvas here");
  return ctx;
}

async function jpegOf(c: AnyCanvas, quality: number): Promise<Uint8Array | null> {
  const blob = "convertToBlob" in c ? await c.convertToBlob({ type: "image/jpeg", quality }) : await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/jpeg", quality));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export function base64Of(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function drawn(img: RgbaImage): AnyCanvas {
  const c = canvasOf(img.width, img.height);
  contextOf(c).putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

/** The shot as a JPEG no longer than LONG_SIDE, with everything outside the card blanked and the quad scaled to match. */
export async function encodePhoto(shot: Shot): Promise<{ image: string; quad: Quad } | null> {
  const { width, height } = shot.image;
  const k = Math.min(1, LONG_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const out = canvasOf(w, h);
  const ctx = contextOf(out);
  ctx.drawImage(drawn(shot.image), 0, 0, w, h);
  // Only the card: everything outside its outline (grown a little, as the detector's corners can
  // be a few percent in) is blanked, so nothing else in view is kept or shared.
  const q = cardOutline(shot.quad.map(([x, y]) => [x * k, y * k]) as Quad, CARD_MARGIN);
  ctx.save();
  ctx.globalCompositeOperation = "destination-in";
  ctx.beginPath();
  q.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  const bytes = await jpegOf(out, PHOTO_QUALITY);
  return bytes ? { image: base64Of(bytes), quad: shot.quad.map(([x, y]) => [x * k, y * k]) as Quad } : null;
}

/**
 * The card's set symbol area, collector strip and whole card, warped upright from its corners at
 * the card's own resolution in the shot (never enlarged): only the card, never the frame around
 * it. A crop that can't be made, or is over MAX_CROP_BYTES, is left out; the photo still goes.
 */
export async function cropsOf(shot: Shot): Promise<Crop[]> {
  const out: Crop[] = [];
  for (const [name, cut] of CROPS) {
    try {
      const img = cut(shot);
      const bytes = await jpegOf(drawn(img), CROP_QUALITY);
      if (bytes && bytes.length <= MAX_CROP_BYTES) out.push({ name, image: base64Of(bytes), width: img.width, height: img.height });
    } catch (e) {
      console.warn(`Couldn't cut the ${name} crop`, e);
    }
  }
  return out;
}

/** The photo and its crops, or null when the photo can't be encoded here. */
export async function cutPhoto(shot: Shot): Promise<Cut | null> {
  const photo = await encodePhoto(shot);
  if (!photo) return null;
  return { ...photo, crops: await cropsOf(shot) };
}

/** What the scan photo worker is asked (photo.worker.ts). */
export interface CutRequest {
  id: number;
  shot: Shot;
}

/** What it answers. */
export interface CutReply {
  id: number;
  cut?: Cut | null;
  error?: string;
}
