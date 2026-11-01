// The deck check's sounds (DeckCheckPage): a soft tick for a card that belongs, a low two-note
// alert for one to take out, two quick mid notes for a second copy. Web Audio, made on the device
// (no sound files). Browsers keep audio silent until a tap, so `unlockSound` runs on the page's
// first taps. iOS Safari has no vibration, and its silent switch also silences these sounds; the
// colours still say it.

import type { VerdictKind } from "./deckCheck";

type Ctx = AudioContext;
let ctx: Ctx | null = null;

function audio(): Ctx | null {
  if (ctx) return ctx;
  if (typeof window === "undefined") return null;
  const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  try {
    ctx = new C();
  } catch {
    return null;
  }
  return ctx;
}

/** Call from a tap: lets later sounds play. True when audio was already running (resuming
 *  finishes a moment after the tap). */
export function unlockSound(): boolean {
  const a = audio();
  if (!a) return false;
  if (a.state === "running") return true;
  if (a.state === "closed") {
    // Closed for good: start a new one on this tap.
    ctx = null;
    return unlockSound();
  }
  // "suspended", or Safari's "interrupted" after another app or a locked screen took the audio.
  void a.resume().catch(() => undefined);
  try {
    // iOS also wants something started inside the tap itself.
    const src = a.createBufferSource();
    src.buffer = a.createBuffer(1, 1, 22050);
    src.connect(a.destination);
    src.start(0);
  } catch {
    // Not started; the next tap tries again.
  }
  return false;
}

/** The notes for each verdict: [frequency Hz, start s, length s], with a wave and a loudness. */
export const TONES: Record<VerdictKind, { wave: OscillatorType; gain: number; notes: [number, number, number][] }> = {
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
  const a = audio();
  if (!a || a.state !== "running") return;
  const t = TONES[kind];
  const now = a.currentTime;
  for (const [freq, start, length] of t.notes) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = t.wave;
    osc.frequency.value = freq;
    // A quick rise and fall, so notes don't click.
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(t.gain, now + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + length);
    osc.connect(gain).connect(a.destination);
    osc.start(now + start);
    osc.stop(now + start + length + 0.02);
  }
}
