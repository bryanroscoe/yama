// Which of the scanner's models run in the Android app's own code rather than the web view's
// (docs/plans/scanner-match-cardvision.md, stages 3 and 4): a per-device choice under Scan
// settings, Models, beside the model each slot runs. The card finder in native code
// (NativeFinder.java) runs the same file the slot names, with ONNX Runtime for Android on the CPU,
// on every frame the app's camera analyses; it needs the app's own camera, and an APK whose
// processor ONNX Runtime ships for (arm64-v8a and x86_64; Bryan, 22 Nov 2026).
//
// Records name what really ran: a slot run in the app is recorded as its option id with
// NATIVE_SUFFIX (`yama-corners-20261120-native`), so Scanner diagnostics' timing records and the
// speed test set it beside the same model in the web view. Anything that keeps the app's model
// from loading or running gives the slot back to the web view for the rest of the session, and the
// records say so (`finder_fallback`).

export type NativeSlot = "detector";
export const NATIVE_SLOTS: readonly NativeSlot[] = ["detector"];

/** What a slot's option is recorded as when the app's own code ran it. */
export const NATIVE_SUFFIX = "-native";
export const nativeId = (id: string): string => `${id}${NATIVE_SUFFIX}`;
/** What ran a model in the app: ONNX Runtime for Android on the CPU (the speed test's `runtime`). */
export const NATIVE_RUNTIME = "native-cpu";

/**
 * On by default where the app can run it: the emulator's parity check ran the native finder and the
 * web view's on the same frames with the same model (docs/scanner.md, "The card finder in the app"),
 * and a failure falls back by itself. The phone check is Bryan's (the PR says what to look at).
 */
export const NATIVE_DEFAULT: Record<NativeSlot, boolean> = { detector: true };

export const NATIVE_KEY = "yama.scan.native";

/** This device's choice per slot; none means the default. */
export type NativeChoices = Partial<Record<NativeSlot, boolean>>;

let chosen: NativeChoices | null = null;
const listeners = new Set<() => void>();

export function savedNative(): NativeChoices {
  if (chosen) return { ...chosen };
  try {
    const raw = JSON.parse(localStorage.getItem(NATIVE_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: NativeChoices = {};
    for (const slot of NATIVE_SLOTS) {
      const v = (raw as Record<string, unknown>)[slot];
      if (typeof v === "boolean") out[slot] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Run `slot` in the app (true), in the web view (false), or as the default (null), on this device. */
export function saveNative(slot: NativeSlot, on: boolean | null) {
  const next = { ...savedNative() };
  if (on === null) delete next[slot];
  else next[slot] = on;
  chosen = next;
  try {
    localStorage.setItem(NATIVE_KEY, JSON.stringify(next));
  } catch {
    /* storage off: the choice holds until the page is reloaded */
  }
  for (const l of listeners) l();
}

export function onNativeChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether this device wants `slot` run in the app (where the app can). */
export const nativeWanted = (slot: NativeSlot, choices: NativeChoices): boolean => choices[slot] ?? NATIVE_DEFAULT[slot];
