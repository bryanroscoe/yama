// Which camera the scanner uses (Bryan, 15 Nov 2026: the Pixel 10 Pro has a main, an ultrawide, a
// 5× telephoto and a front camera, and he couldn't choose). The list comes from
// enumerateDevices(), whose labels are empty until the camera is allowed, so it's read after the
// first stream opens. Labels differ by platform:
//
//   Chrome and the app's web view on Android: "camera2 0, facing back", "camera2 1, facing front".
//     Android hides the separate lenses of a phone behind one logical back camera, which switches
//     lens itself as it zooms, so a Pixel usually lists one back camera and one front [read:
//     Android's logical multi-camera docs; inferred for the Pixel 10 Pro, not seen]. Camera 0 is
//     the main back camera by Android's convention [read].
//   Safari on iPhone: "Back Camera" (the main wide lens), "Back Ultra Wide Camera", "Back
//     Telephoto Camera", "Back Dual Wide Camera" and "Back Triple Camera" (logical, switching
//     lens by distance), "Front Camera".
//
// For cards held close the main lens is best: an ultrawide focuses close but sees the card small,
// and a telephoto can't focus as close as a card is held.

export interface CameraDevice {
  deviceId: string;
  label: string;
}

export type Lens = "main" | "ultrawide" | "telephoto" | "logical" | "front" | "back" | "other";

export interface NamedCamera extends CameraDevice {
  /** What Scan settings calls it: "Main", "Ultrawide", "Telephoto", "Front", "Back camera 2". */
  name: string;
  lens: Lens;
  facing: "back" | "front" | null;
}

/** On this device, the camera chosen in Scan settings: its id and label (ids can change; labels rarely do). */
export const CAMERA_KEY = "yama.scan.camera";

const facingOf = (label: string): NamedCamera["facing"] =>
  /front|user|selfie|facetime/i.test(label) ? "front" : /back|rear|environment/i.test(label) ? "back" : null;

function lensOf(label: string, facing: NamedCamera["facing"]): Lens {
  if (facing === "front") return "front";
  if (/ultra ?wide/i.test(label)) return "ultrawide";
  if (/tele/i.test(label)) return "telephoto";
  if (/dual|triple/i.test(label)) return "logical";
  if (/^back camera$|\bwide\b|\bmain\b/i.test(label.trim())) return "main";
  return facing === "back" ? "back" : "other";
}

/** "camera2 3, facing back" → 3. */
const androidIndex = (label: string): number | null => {
  const m = /camera2?\s*(\d+)/i.exec(label);
  return m ? Number(m[1]) : null;
};

const NAMES: Record<Exclude<Lens, "back" | "other">, string> = { main: "Main", ultrawide: "Ultrawide", telephoto: "Telephoto", logical: "Back (switches lens)", front: "Front" };

/**
 * Plain names for the video inputs. On Android the lowest-numbered back camera is the main one;
 * other back cameras there say nothing of their lens, so they're named by number. Two cameras
 * that would share a name are told apart by number.
 */
export function nameCameras(devices: readonly CameraDevice[]): NamedCamera[] {
  const named: NamedCamera[] = devices.map((d) => {
    const facing = facingOf(d.label);
    return { deviceId: d.deviceId, label: d.label, facing, lens: lensOf(d.label, facing), name: "" };
  });
  // Android: the first back camera is the main lens.
  const androidBacks = named.filter((c) => c.lens === "back" && androidIndex(c.label) != null).sort((a, b) => androidIndex(a.label)! - androidIndex(b.label)!);
  if (androidBacks.length && !named.some((c) => c.lens === "main")) androidBacks[0]!.lens = "main";
  named.forEach((c, i) => {
    const n = androidIndex(c.label);
    if (c.lens === "back") c.name = `Back camera ${n ?? i + 1}`;
    else if (c.lens === "other") c.name = c.label.trim() || `Camera ${i + 1}`;
    else c.name = NAMES[c.lens];
  });
  const counts = new Map<string, number>();
  for (const c of named) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  named.forEach((c, i) => {
    if ((counts.get(c.name) ?? 0) > 1) c.name = `${c.name} ${androidIndex(c.label) ?? i + 1}`;
  });
  return named;
}

/** The camera to start with when none was chosen: the main back lens, else any back camera; null leaves it to `facingMode: environment`. */
export function defaultCamera(cameras: readonly NamedCamera[]): NamedCamera | null {
  return cameras.find((c) => c.lens === "main") ?? cameras.find((c) => c.lens === "logical") ?? cameras.find((c) => c.facing === "back" && c.lens !== "ultrawide" && c.lens !== "telephoto") ?? null;
}

export interface SavedCamera {
  id: string;
  label: string;
}

/** The saved camera if it's still there (by id, else by label); null when it went away. */
export function findSaved(cameras: readonly NamedCamera[], saved: SavedCamera | null): NamedCamera | null {
  if (!saved) return null;
  return cameras.find((c) => c.deviceId === saved.id) ?? (saved.label ? cameras.find((c) => c.label === saved.label) : undefined) ?? null;
}

/**
 * The saved camera among these, and what to remember now (review of #145: a device id that had
 * changed erased the choice before its label could find it). By id; else by label, remembered
 * again under its new id; else forgotten. `save` is "keep" when nothing changes.
 */
export function resolveSaved(cameras: readonly NamedCamera[], saved: SavedCamera | null): { camera: NamedCamera | null; save: SavedCamera | null | "keep" } {
  if (!saved) return { camera: null, save: "keep" };
  const byId = cameras.find((c) => c.deviceId === saved.id);
  if (byId) return { camera: byId, save: "keep" };
  const byLabel = saved.label ? cameras.find((c) => c.label === saved.label) : undefined;
  if (byLabel) return { camera: byLabel, save: { id: byLabel.deviceId, label: saved.label } };
  return { camera: null, save: null };
}

/** The camera to open: the one chosen if it's still there, quietly falling back to the default. */
export function pickCamera(cameras: readonly NamedCamera[], saved: SavedCamera | null): NamedCamera | null {
  return findSaved(cameras, saved) ?? defaultCamera(cameras);
}

export function savedCamera(): SavedCamera | null {
  try {
    const v = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? "null") as SavedCamera | null;
    return v && typeof v.id === "string" ? { id: v.id, label: typeof v.label === "string" ? v.label : "" } : null;
  } catch {
    return null;
  }
}

export function saveCamera(c: SavedCamera | null) {
  try {
    if (c) localStorage.setItem(CAMERA_KEY, JSON.stringify(c));
    else localStorage.removeItem(CAMERA_KEY);
  } catch {
    /* storage off */
  }
}

/** A short, stable stand-in for a device id in diagnostics (the id itself is per site and device, but needn't be kept). */
export function idHash(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}
