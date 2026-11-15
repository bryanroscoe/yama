// The deck check's sounds (DeckCheckPage): a soft tick for a card that belongs, a low two-note
// alert for one to take out, two quick mid notes for a second copy. Web Audio, made on the device
// (no sound files). Browsers keep audio silent until a tap, so `unlockSound` runs on the page's
// first taps. iOS Safari has no vibration, and its silent switch also silences these sounds; the
// colours still say it.

import { playTone, unlockSound, type Tone } from "../sound";
import type { VerdictKind } from "./deckCheck";

export { unlockSound };

/** The notes for each verdict: [frequency Hz, start s, length s], with a wave and a loudness. */
export const TONES: Record<VerdictKind, Tone> = {
  belongs: { wave: "sine", gain: 0.12, notes: [[1320, 0, 0.06]] },
  out: { wave: "square", gain: 0.16, notes: [[392, 0, 0.14], [262, 0.17, 0.22]] },
  extra: { wave: "square", gain: 0.16, notes: [[392, 0, 0.14], [262, 0.17, 0.22]] },
  duplicate: { wave: "triangle", gain: 0.22, notes: [[660, 0, 0.08], [660, 0.12, 0.08]] },
};

/** Vibration where the browser has it (Android); a long double buzz for anything but "belongs". */
export const BUZZ: Record<VerdictKind, number[] | null> = { belongs: null, out: [140, 70, 140], extra: [140, 70, 140], duplicate: [60, 60, 60] };

export function playVerdict(kind: VerdictKind): void {
  const buzz = BUZZ[kind];
  if (buzz && typeof navigator !== "undefined") navigator.vibrate?.(buzz);
  playTone(TONES[kind]);
}
