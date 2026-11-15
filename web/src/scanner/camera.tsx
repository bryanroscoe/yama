// Flashlight and zoom on the camera view (Bryan, 2026-11-06). The flashlight is offered where the
// browser exposes the camera's torch (Chrome on Android; not Safari). Zoom uses the camera's own
// zoom where the browser exposes it, else a digital zoom: the view is enlarged and the recognizer
// is given the middle of the frame, so a small or far card is seen with more of the camera's pixels.

import { useCallback, useRef, useState } from "react";
import { Button } from "../components/ui";

export interface CameraCaps {
  torch: boolean;
  /** The camera's own zoom range, when the browser exposes it. */
  zoom: { min: number; max: number } | null;
}

const NO_CAPS: CameraCaps = { torch: false, zoom: null };
/** Zoom levels offered, kept to what the camera allows. */
const LEVELS = [1, 1.5, 2, 3, 4];
/** Digital zoom stops here: past it the frame is too few pixels to be worth it. */
const DIGITAL_MAX = 3;
/** + and a pinch stop here with the camera's own zoom: under a phone's switch to its telephoto at 5× (zoomPolicy.ts) [inferred]. */
export const HAND_MAX = 4;

/**
 * Constraint changes for one track, one at a time (review of #145: focus and zoom snapshotted the
 * settings before awaiting, so one overwrote the other). Each change is merged with whatever was
 * applied last, when it runs; a change for a track that is no longer current is dropped.
 */
export function serialApplier(apply: (t: MediaStreamTrack, all: Record<string, unknown>) => Promise<void>, current: () => MediaStreamTrack | null) {
  let applied: Record<string, unknown> = {};
  let chain: Promise<unknown> = Promise.resolve();
  return {
    /** Start over for a new track, with these settings as the base (sent with the next change). */
    reset(base: Record<string, unknown>) {
      applied = { ...base };
    },
    applied: () => applied,
    set(t: MediaStreamTrack, patch: Record<string, unknown>): Promise<void> {
      const run = async () => {
        if (current() !== t) throw new Error("The camera changed");
        const next = { ...applied, ...patch };
        await apply(t, next);
        if (current() === t) applied = next;
      };
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
  };
}

export function readCaps(track: MediaStreamTrack): CameraCaps {
  const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean; zoom?: { min?: number; max?: number } };
  const zoom = caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > (caps.zoom.min ?? 1) ? { min: caps.zoom.min ?? 1, max: caps.zoom.max } : null;
  return { torch: caps.torch === true, zoom };
}

/**
 * Where the + and − buttons go from `zoom`: the nearest level above and below it, which works
 * from a zoom a pinch left between levels. The camera's own top end (or the digital limit) is a
 * level too.
 */
export function zoomSteps(caps: CameraCaps, zoom: number): { above?: number; below?: number } {
  const levels = [...new Set([...zoomLevels(caps), zoomTop(caps)])].sort((a, b) => a - b);
  return { above: levels.find((z) => z > zoom + 1e-6), below: [...levels].reverse().find((z) => z < zoom - 1e-6) };
}

/**
 * The most + and a pinch zoom to: the camera's own top end, but never past HAND_MAX, below where a
 * phone switches to its telephoto (zoomPolicy.ts, LENS_SWITCH); or the digital limit.
 */
export function zoomTop(caps: CameraCaps): number {
  return caps.zoom ? Math.max(caps.zoom.min, Math.min(caps.zoom.max, HAND_MAX)) : DIGITAL_MAX;
}

/** The zoom levels to step through. */
export function zoomLevels(caps: CameraCaps): number[] {
  if (caps.zoom) {
    const { min, max } = caps.zoom;
    const levels = LEVELS.filter((z) => z >= min && z <= max);
    if (!levels.includes(min)) levels.unshift(min);
    return levels;
  }
  return LEVELS.filter((z) => z <= DIGITAL_MAX);
}

/**
 * The middle of a w × h frame a digital zoom of `z` shows. `view` is the size of the box the video
 * fills (object-fit: cover, so one axis is already cut): zoomed in, the region is what's on screen.
 * At 1× the whole frame is used, as before.
 */
export function digitalRegion(w: number, h: number, z: number, view?: { width: number; height: number }): { x: number; y: number; w: number; h: number } {
  if (z <= 1) return { x: 0, y: 0, w, h };
  let vw = w;
  let vh = h;
  if (view && view.width > 0 && view.height > 0) {
    const s = Math.max(view.width / w, view.height / h);
    vw = Math.min(w, view.width / s);
    vh = Math.min(h, view.height / s);
  }
  const rw = vw / z;
  const rh = vh / z;
  return { x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh };
}

/** What the camera delivers and can do, for Scan settings and (later) Scanner diagnostics. */
export interface CameraInfo {
  label?: string;
  deviceId?: string;
  width?: number;
  height?: number;
  frameRate?: number;
  zoom?: number;
  zoomRange?: [number, number];
  facing?: string;
  focusMode?: string;
  focusModes?: string[];
  focusDistance?: number;
  focusDistanceRange?: [number, number];
  resizeMode?: string;
  maxWidth?: number;
  maxHeight?: number;
  torch?: boolean;
  pointsOfInterest?: boolean;
}

/** The track's settings and capabilities, in one plain object. */
export function cameraInfo(track: MediaStreamTrack): CameraInfo {
  const st = (track.getSettings?.() ?? {}) as MediaTrackSettings & { zoom?: number; focusMode?: string; focusDistance?: number; resizeMode?: string };
  const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
    zoom?: { min?: number; max?: number };
    focusMode?: string[];
    focusDistance?: { min?: number; max?: number };
    torch?: boolean;
  };
  const range = (r?: { min?: number; max?: number }): [number, number] | undefined => (r && typeof r.min === "number" && typeof r.max === "number" ? [r.min, r.max] : undefined);
  return {
    label: track.label || undefined,
    deviceId: st.deviceId,
    width: st.width,
    height: st.height,
    frameRate: st.frameRate,
    zoom: st.zoom,
    zoomRange: range(caps.zoom),
    facing: st.facingMode,
    focusMode: st.focusMode,
    focusModes: caps.focusMode,
    focusDistance: st.focusDistance,
    focusDistanceRange: range(caps.focusDistance),
    resizeMode: st.resizeMode,
    maxWidth: caps.width?.max,
    maxHeight: caps.height?.max,
    torch: caps.torch,
    pointsOfInterest: pointsOfInterestSupported(),
  };
}

const pointsOfInterestSupported = () => {
  try {
    return !!(navigator.mediaDevices?.getSupportedConstraints?.() as Record<string, boolean> | undefined)?.pointsOfInterest;
  } catch {
    return false;
  }
};

export function useCameraControls() {
  const track = useRef<MediaStreamTrack | null>(null);
  const [caps, setCaps] = useState<CameraCaps>(NO_CAPS);
  const [torch, setTorchState] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [error, setError] = useState<string | null>(null);
  /** Every setting applied so far, sent together (one applyConstraints can replace the last), one change at a time. */
  const applier = useRef(serialApplier((t, all) => t.applyConstraints({ advanced: [all as MediaTrackConstraintSet] }), () => track.current));
  const apply = (t: MediaStreamTrack, patch: Record<string, unknown>) => applier.current.set(t, patch);
  /** The person zoomed (+, − or a pinch): auto-zoom leaves it to them for the session. */
  const userZoomed = useRef(false);
  const attach = useCallback((t: MediaStreamTrack | null) => {
    track.current = t;
    const caps = (t?.getCapabilities?.() ?? {}) as { focusMode?: string[] };
    // Continuous focus, where offered, goes with every later setting too, and is applied now.
    const focus = caps.focusMode?.includes("continuous") ? { focusMode: "continuous" } : {};
    applier.current.reset({});
    if (t && focus.focusMode) void apply(t, focus).catch(() => undefined);
    setCaps(t ? readCaps(t) : NO_CAPS);
    setTorchState(false);
    setZoomState(1);
    setError(null);
  }, []);
  const setTorch = useCallback(async (on: boolean) => {
    const t = track.current;
    if (!t) return;
    try {
      await apply(t, { torch: on });
      setTorchState(on);
      setError(null);
    } catch {
      setError("The flashlight didn't turn on");
    }
  }, []);
  const setZoom = useCallback(
    async (z: number) => {
      const t = track.current;
      if (caps.zoom && t) {
        try {
          await apply(t, { zoom: z });
        } catch {
          setError("The camera didn't zoom");
          return;
        }
      }
      setZoomState(z);
      setError(null);
    },
    [caps.zoom],
  );
  /** Any zoom in the camera's range (or 1× to the digital limit), for a pinch. Camera calls are queued, newest wins. */
  const pending = useRef<{ busy: boolean; next: number | null }>({ busy: false, next: null });
  const zoomTo = useCallback(
    (z: number) => {
      userZoomed.current = true;
      const lo = caps.zoom ? caps.zoom.min : 1;
      const hi = zoomTop(caps);
      const want = Math.round(Math.min(hi, Math.max(lo, z)) * 100) / 100;
      const p = pending.current;
      p.next = want;
      if (p.busy) return;
      p.busy = true;
      void (async () => {
        while (p.next != null) {
          const v = p.next;
          p.next = null;
          await setZoom(v);
        }
        p.busy = false;
      })();
    },
    [caps.zoom, setZoom],
  );
  const { above, below } = zoomSteps(caps, zoom);
  const step = (d: 1 | -1) => {
    const next = d > 0 ? above : below;
    userZoomed.current = true;
    if (next != null) void setZoom(next);
  };
  /** Auto-zoom's step (zoomPolicy.ts): the camera's own zoom only, and never once the person has zoomed. */
  const autoZoom = useCallback(
    (z: number) => {
      if (!caps.zoom || userZoomed.current) return;
      void setZoom(z);
    },
    [caps.zoom, setZoom],
  );
  /** Focus on a point of the frame (0 to 1 across and down), where the browser lets it; else nothing. */
  const focusAt = useCallback((x: number, y: number) => {
    const t = track.current;
    if (!t || !pointsOfInterestSupported()) return;
    void apply(t, { pointsOfInterest: [{ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }] }).catch(() => undefined);
  }, []);
  return {
    attach,
    caps,
    torch,
    setTorch,
    zoom,
    autoZoom,
    focusAt,
    /** The camera's track, for a still photo (ImageCapture). */
    track: () => track.current,
    /** Whether the person has zoomed by hand this session. */
    userZoomed: () => userZoomed.current,
    zoomIn: () => step(1),
    zoomOut: () => step(-1),
    zoomTo,
    canZoomIn: above != null,
    canZoomOut: below != null,
    /** The zoom the scanner applies itself (1 when the camera zooms). */
    digital: caps.zoom ? 1 : zoom,
    error,
  };
}

export type CameraControlState = ReturnType<typeof useCameraControls>;

const fmt = (z: number) => `${Number.isInteger(z) ? z : z.toFixed(1)}×`;

export function CameraControls({ c, live }: { c: CameraControlState; live: boolean }) {
  if (!live) return null;
  return (
    <div className="scan-tools">
      {c.caps.torch && (
        <Button className={`scan-tool${c.torch ? " is-on" : ""}`} onClick={() => void c.setTorch(!c.torch)} aria-pressed={c.torch} aria-label={c.torch ? "Turn the flashlight off" : "Turn the flashlight on"}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 2h10v4l-3 4v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V10L7 6z" />
            {c.torch && <path d="M12 13v3" />}
          </svg>
        </Button>
      )}
      <div className="scan-zoom-buttons" role="group" aria-label="Zoom">
        <Button className="scan-tool" onClick={c.zoomIn} disabled={!c.canZoomIn} aria-label="Zoom in">
          +
        </Button>
        <span className="scan-zoom-level" aria-live="polite">
          {fmt(c.zoom)}
        </span>
        <Button className="scan-tool" onClick={c.zoomOut} disabled={!c.canZoomOut} aria-label="Zoom out">
          −
        </Button>
      </div>
      {c.error && <span className="scan-tool-error">{c.error}</span>}
    </div>
  );
}
