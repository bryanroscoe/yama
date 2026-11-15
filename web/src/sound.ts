// Short tones made on the device with Web Audio (no sound files), for the deck check
// (decks/checkSound.ts) and the scanner (scanner/sounds.ts). Browsers, and Android's web view, keep
// audio silent until a tap, so `unlockSound` runs on the page's taps. iOS Safari's silent switch
// also silences these; the web can't read Android's ringer mode, so there a page's own switch
// decides.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
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

/** A sound: notes as [frequency Hz, start s, length s], with a wave and a loudness. */
export interface Tone {
  wave: OscillatorType;
  gain: number;
  notes: [number, number, number][];
}

/** Play a tone now, if audio is running (silently nothing before the first tap). */
export function playTone(t: Tone): void {
  const a = audio();
  if (!a || a.state !== "running") return;
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

/** Pages using sound now (the scanner, the deck check): audio is paused when the last one goes. */
let users = 0;

/**
 * Hold audio while a page that plays sounds is open; returns the release. When nothing holds it,
 * the context is suspended, so it isn't left running through the rest of the app (it resumes on
 * the next page's tap through `unlockSound`).
 */
export function holdSound(): () => void {
  users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users = Math.max(0, users - 1);
    if (users === 0 && ctx && ctx.state === "running") void ctx.suspend().catch(() => undefined);
  };
}
