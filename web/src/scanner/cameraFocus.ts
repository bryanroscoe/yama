// Pinning the lens (docs/plans/scanner-match-cardvision.md, item 14). Where the browser exposes a
// manual focus mode and a focus distance (Chrome on Android), the camera view offers a focus
// control: off is continuous autofocus; on shows a slider and the lens stays where it's put, so it
// doesn't hunt between cards held at the same distance. Remembered on this device.

export interface FocusRange {
  /** The nearest and farthest the slider goes, in the browser's units (metres). */
  near: number;
  far: number;
  /** The mode that hands focus back to the camera. */
  auto: "continuous" | "single-shot";
}

/** On this device: whether the lens is pinned, and where. */
export const FOCUS_KEY = "yama.scan.focus";
/** The slider stops here: nobody scans a card from further off (the camera's range runs to infinity). */
export const FOCUS_FAR = 1;
/** A camera that reports a nearest distance of nothing gets this. */
const NEAREST = 0.03;

type FocusTrack = { getCapabilities?: () => MediaTrackCapabilities };

/** What this camera lets the slider do, or null where focus can't be pinned (or handed back). */
export function focusRange(track: FocusTrack | null): FocusRange | null {
  const caps = (track?.getCapabilities?.() ?? {}) as { focusMode?: string[]; focusDistance?: { min?: number; max?: number } };
  const modes = caps.focusMode ?? [];
  const auto = modes.includes("continuous") ? "continuous" : modes.includes("single-shot") ? "single-shot" : null;
  const d = caps.focusDistance;
  if (!modes.includes("manual") || !auto || !d || typeof d.min !== "number" || typeof d.max !== "number") return null;
  const near = Math.max(NEAREST, d.min);
  const far = Math.min(FOCUS_FAR, d.max);
  return far > near ? { near, far, auto } : null;
}

export const clampFocus = (r: FocusRange, d: number): number => Math.round(Math.min(r.far, Math.max(r.near, d)) * 1000) / 1000;

/**
 * The slider runs 0 (nearest) to 1 (farthest) evenly in the ratio of distances, so the close end,
 * where a few centimetres matter, gets as much of it as the far end.
 */
export const sliderToDistance = (r: FocusRange, t: number): number => clampFocus(r, r.near * (r.far / r.near) ** Math.min(1, Math.max(0, t)));
export const distanceToSlider = (r: FocusRange, d: number): number => Math.log(clampFocus(r, d) / r.near) / Math.log(r.far / r.near);

/** "12 cm", "1 m". */
export const fmtFocus = (d: number): string => (d >= 1 ? `${Math.round(d * 10) / 10} m` : `${Math.round(d * 100)} cm`);

export interface SavedFocus {
  pinned: boolean;
  distance: number;
}

export function savedFocus(): SavedFocus | null {
  try {
    const v = JSON.parse(localStorage.getItem(FOCUS_KEY) ?? "null") as SavedFocus | null;
    return v && typeof v.distance === "number" && Number.isFinite(v.distance) && v.distance > 0 ? { pinned: v.pinned === true, distance: v.distance } : null;
  } catch {
    return null;
  }
}

export function saveFocus(f: SavedFocus) {
  try {
    localStorage.setItem(FOCUS_KEY, JSON.stringify(f));
  } catch {
    /* storage off */
  }
}
