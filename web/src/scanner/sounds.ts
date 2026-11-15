// The scanner's sounds (Bryan, 15 Nov 2026), next to its vibration: a short chime when a card is
// filed, a brighter three-note one when that card is worth at least the threshold (Scan settings,
// $5 by default, against its dated market price in that finish; a missing price never counts),
// and a low two-note tone when it needs you (a printing to tap, a set question). On by default,
// per device. Audio starts on a tap (sound.ts). Android's silent mode isn't visible to the web
// view, so the Sounds switch decides; iOS Safari's silent switch silences them by itself.

import { playTone, unlockSound, type Tone } from "../sound";
import { worthIt } from "./price";

export type ScanSound = "filed" | "valuable" | "needs-you";

export const SCAN_TONES: Record<ScanSound, Tone> = {
  filed: { wave: "sine", gain: 0.12, notes: [[1046, 0, 0.05], [1568, 0.05, 0.07]] },
  valuable: { wave: "triangle", gain: 0.24, notes: [[784, 0, 0.08], [1047, 0.09, 0.08], [1568, 0.18, 0.18]] },
  "needs-you": { wave: "square", gain: 0.14, notes: [[330, 0, 0.12], [247, 0.15, 0.2]] },
};

export const SOUNDS_KEY = "yama.scan.sounds";
export const WORTH_KEY = "yama.scan.worthIt";
export const DEFAULT_WORTH = 5;

/** Which sound a filed card makes: the louder one at or over the threshold. */
export const filedSound = (price: number | null, threshold: number): ScanSound => (worthIt(price, threshold) ? "valuable" : "filed");

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Sounds on this device: on unless turned off. */
export function soundsOn(): boolean {
  try {
    return store()?.getItem(SOUNDS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSoundsOn(on: boolean) {
  try {
    store()?.setItem(SOUNDS_KEY, on ? "1" : "0");
  } catch {
    /* storage off */
  }
}

/** The "worth it" threshold in dollars on this device; $5 unless set. */
export function worthThreshold(): number {
  try {
    const v = Number(store()?.getItem(WORTH_KEY));
    return store()?.getItem(WORTH_KEY) != null && Number.isFinite(v) && v >= 0 ? v : DEFAULT_WORTH;
  } catch {
    return DEFAULT_WORTH;
  }
}

export function setWorthThreshold(v: number) {
  try {
    if (Number.isFinite(v) && v >= 0) store()?.setItem(WORTH_KEY, String(v));
  } catch {
    /* storage off */
  }
}

export function playScanSound(kind: ScanSound) {
  playTone(SCAN_TONES[kind]);
}

export { unlockSound };
