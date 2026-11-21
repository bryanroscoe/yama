// Scan photos (Bryan, 2026-11-06): with "Save scan photos" on, the part of the frame around a card
// the scanner found is kept in the person's account with what they said it was, so the scanner
// can be measured on, and later trained with, real photos. Since 15 Nov 2026 the switch is on by
// default and the photos it saves are shared with Yama's developer (Bryan: "I want them to send it
// to me"); the switch says so. Best effort: a photo that can't be
// sent is dropped, and nothing is kept while the switch is off. Server: server/src/scan_samples.rs.
//
// Since 20 Nov 2026 each photo also keeps two full-resolution crops of the card, warped upright
// from its corners (Bryan: a printing model needs the set symbol, about 20 px in the 640 px
// photo): the set symbol's area and the collector strip (`cropsOf`). Only the card; made once per
// photo kept, never per frame.

import { accountSignal, api } from "../api";
import { encodeJpeg, stripOf, symbolOf } from "./diagnostics";
import type { Quad, RgbaImage } from "./types";

/**
 * On this device, "0" when the person turned Save scan photos off. On by default (Bryan, 15 Nov
 * 2026: the kept photos are the evidence the scanner's misread work needs); a device that turned
 * it off keeps it off.
 */
export const SAVE_PHOTOS_KEY = "yama.scan.savePhotos";
/** Longest side of a kept photo. */
const LONG_SIDE = 640;

/** The switch as set on this page: wins over storage, so turning it off holds even if storage can't be written. */
let chosen: boolean | null = null;

export function savingPhotos(): boolean {
  if (chosen !== null) return chosen;
  try {
    return localStorage.getItem(SAVE_PHOTOS_KEY) !== "0";
  } catch {
    // Without storage the choice can't be remembered, so a switch turned off couldn't stay off.
    return false;
  }
}

export function setSavingPhotos(on: boolean) {
  chosen = on;
  try {
    localStorage.setItem(SAVE_PHOTOS_KEY, on ? "1" : "0");
  } catch {
    /* storage off */
  }
}

/** A frame region and the card's quad within it. */
export interface Shot {
  image: RgbaImage;
  quad: Quad;
}

export interface SampleLabel {
  kind: "added" | "corrected" | "wrong";
  label_scryfall_id?: string;
  label_name?: string;
  guess_name?: string;
  guess_scryfall_id?: string;
  guess_illustration_id?: string;
  method?: string;
  score?: number;
  camera?: string;
  /** The art model's embed graph that ran (`ArtRecognizer.embed`), or "none" reading text only; the server records the model by it. */
  embed?: string;
  /** The option each of the scanner's slots ran (models.ts): art, look, text and lock. */
  models?: Record<string, string>;
}

/** How far past the detected corners the kept photo reaches, as a share of the card's size. */
const CARD_MARGIN = 0.04;

/** The quad grown away from its centre by `margin` of its size. */
export function cardOutline(quad: Quad, margin: number): Quad {
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4;
  const cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  return quad.map(([x, y]) => [cx + (x - cx) * (1 + margin), cy + (y - cy) * (1 + margin)]) as Quad;
}

/** The shot as a JPEG (base64) no longer than LONG_SIDE, with everything outside the card blanked and the quad scaled to match. */
export async function encodeShot(shot: Shot): Promise<{ image: string; quad: Quad } | null> {
  const { width, height } = shot.image;
  const k = Math.min(1, LONG_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  source.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(shot.image.data), width, height), 0, 0);
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(source, 0, 0, w, h);
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
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", 0.8));
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { image: btoa(bin), quad: shot.quad.map(([x, y]) => [x * k, y * k]) as Quad };
}

/** A crop kept with a photo: base64 JPEG and its size. */
export interface Crop {
  name: "symbol" | "strip";
  image: string;
  width: number;
  height: number;
}

/** JPEG quality of the crops: what a model or a replay reads, so a little above the photo's. */
const CROP_QUALITY = 0.85;
/** The largest crop the server takes (scan_samples.rs, MAX_CROP): a larger one is left out, not the photo. */
const MAX_CROP_BYTES = 1024 * 1024;

/**
 * The card's set symbol area and collector strip, warped upright from its corners at the card's
 * own resolution in the shot (never enlarged): what a printing model and a collector-line replay
 * read. Only the card, never the frame around it.
 */
export async function cropsOf(shot: Shot): Promise<Crop[]> {
  const out: Crop[] = [];
  for (const [name, cut] of [
    ["symbol", symbolOf],
    ["strip", stripOf],
  ] as const) {
    // A crop that can't be made is left out; the photo still goes.
    try {
      const img = cut(shot);
      const enc = await encodeJpeg(img, Math.max(img.width, img.height), CROP_QUALITY);
      if (enc && (enc.data.length * 3) / 4 <= MAX_CROP_BYTES) out.push({ name, image: enc.data, width: enc.width, height: enc.height });
    } catch (e) {
      console.warn(`Couldn't cut the ${name} crop`, e);
    }
  }
  return out;
}

/** Moves on with each "Delete them": a photo begun before it is never sent. */
let photoGen = 0;
/** Photo uploads on their way: "Delete them" waits for their answers before it deletes. */
const sending = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  sending.add(p);
  p.then(
    () => sending.delete(p),
    () => sending.delete(p),
  );
  return p;
}

/** Keep a photo with its label, if the person has Save scan photos on. Never throws. */
export async function keepSample(shot: Shot | null | undefined, label: SampleLabel): Promise<void> {
  if (!shot || !savingPhotos()) return;
  // The account signed in now: if it changes while the photo is made, it isn't sent under the other.
  const account = accountSignal();
  const gen = photoGen;
  try {
    const encoded = await encodeShot(shot);
    if (!encoded) return;
    const crops = await cropsOf(shot);
    // Turned off, signed out, or deleted ("Delete them") while the crops were made: nothing is sent.
    if (!savingPhotos() || account.aborted || gen !== photoGen) return;
    // `shared`: this scanner tells the person, next to the switch, that saved photos are shared
    // with Yama's developer (server/src/scan_samples.rs keeps older photos out of that).
    await track(api("/api/scan/samples", { method: "POST", signal: account, json: { ...label, ...encoded, crops, shared: true } }));
  } catch (e) {
    console.warn("Couldn't keep the scan photo", e);
  }
}

export interface SampleSummary {
  count: number;
  bytes: number;
  crop_bytes?: number;
  keep: number;
}

export const sampleSummary = () => api<SampleSummary>("/api/scan/samples");
/**
 * "Delete them": no photo begun before is sent, and those already on their way are answered
 * first, so none arrives after the deletion (the server also refuses one that began before it).
 */
export async function deleteSamples(): Promise<{ deleted: number }> {
  photoGen += 1;
  await Promise.allSettled([...sending]);
  return api<{ deleted: number }>("/api/scan/samples", { method: "DELETE" });
}
