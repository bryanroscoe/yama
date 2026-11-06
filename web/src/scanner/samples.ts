// Scan photos (Bryan, 2026-11-06): with "Save scan photos" on, the part of the frame around a card
// the scanner found is kept in the person's account with what they said it was, so the scanner
// can be measured on, and later trained with, real photos. Best effort: a photo that can't be
// sent is dropped, and nothing is kept while the switch is off. Server: server/src/scan_samples.rs.

import { api } from "../api";
import type { Quad, RgbaImage } from "./types";

/** On this device, "1" when the person turned Save scan photos on. Off by default. */
export const SAVE_PHOTOS_KEY = "yama.scan.savePhotos";
/** Longest side of a kept photo. */
const LONG_SIDE = 640;

export function savingPhotos(): boolean {
  try {
    return localStorage.getItem(SAVE_PHOTOS_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSavingPhotos(on: boolean) {
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
}

/** The shot as a JPEG (base64) no longer than LONG_SIDE, with the quad scaled to match. */
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
  out.getContext("2d")!.drawImage(source, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/jpeg", 0.8));
  if (!blob) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { image: btoa(bin), quad: shot.quad.map(([x, y]) => [x * k, y * k]) as Quad };
}

/** Keep a photo with its label, if the person has Save scan photos on. Never throws. */
export async function keepSample(shot: Shot | null | undefined, label: SampleLabel): Promise<void> {
  if (!shot || !savingPhotos()) return;
  try {
    const encoded = await encodeShot(shot);
    if (!encoded) return;
    await api("/api/scan/samples", { method: "POST", json: { ...label, ...encoded } });
  } catch (e) {
    console.warn("Couldn't keep the scan photo", e);
  }
}

export interface SampleSummary {
  count: number;
  bytes: number;
  keep: number;
}

export const sampleSummary = () => api<SampleSummary>("/api/scan/samples");
export const deleteSamples = () => api<{ deleted: number }>("/api/scan/samples", { method: "DELETE" });
