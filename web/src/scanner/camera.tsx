// Flashlight and zoom on the camera view (Bryan, 2026-11-06). The flashlight is offered where the
// browser exposes the camera's torch (Chrome on Android; not Safari). Zoom uses the camera's own
// zoom where the browser exposes it, else a digital zoom: the view is enlarged and the recognizer
// is given the middle of the frame, so a small or far card is seen with more of the camera's pixels.

import { useCallback, useRef, useState } from "react";

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

export function readCaps(track: MediaStreamTrack): CameraCaps {
  const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean; zoom?: { min?: number; max?: number } };
  const zoom = caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > (caps.zoom.min ?? 1) ? { min: caps.zoom.min ?? 1, max: caps.zoom.max } : null;
  return { torch: caps.torch === true, zoom };
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

/** The middle of a w × h frame a digital zoom of `z` shows. */
export function digitalRegion(w: number, h: number, z: number): { x: number; y: number; w: number; h: number } {
  const k = Math.max(1, z);
  return { x: (w - w / k) / 2, y: (h - h / k) / 2, w: w / k, h: h / k };
}

export function useCameraControls() {
  const track = useRef<MediaStreamTrack | null>(null);
  const [caps, setCaps] = useState<CameraCaps>(NO_CAPS);
  const [torch, setTorchState] = useState(false);
  const [zoom, setZoomState] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const attach = useCallback((t: MediaStreamTrack | null) => {
    track.current = t;
    setCaps(t ? readCaps(t) : NO_CAPS);
    setTorchState(false);
    setZoomState(1);
    setError(null);
  }, []);
  const setTorch = useCallback(async (on: boolean) => {
    const t = track.current;
    if (!t) return;
    try {
      await t.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
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
          await t.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] });
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
  const levels = zoomLevels(caps);
  const at = levels.findIndex((z) => z >= zoom - 1e-6);
  const step = (d: 1 | -1) => {
    const next = levels[Math.min(levels.length - 1, Math.max(0, (at < 0 ? 0 : at) + d))];
    if (next != null && next !== zoom) void setZoom(next);
  };
  return {
    attach,
    caps,
    torch,
    setTorch,
    zoom,
    zoomIn: () => step(1),
    zoomOut: () => step(-1),
    canZoomIn: at < levels.length - 1,
    canZoomOut: at > 0,
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
        <button className={`scan-tool${c.torch ? " is-on" : ""}`} onClick={() => void c.setTorch(!c.torch)} aria-pressed={c.torch} aria-label={c.torch ? "Turn the flashlight off" : "Turn the flashlight on"}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 2h10v4l-3 4v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V10L7 6z" />
            {c.torch && <path d="M12 13v3" />}
          </svg>
        </button>
      )}
      <div className="scan-zoom-buttons" role="group" aria-label="Zoom">
        <button className="scan-tool" onClick={c.zoomIn} disabled={!c.canZoomIn} aria-label="Zoom in">
          +
        </button>
        <span className="scan-zoom-level" aria-live="polite">
          {fmt(c.zoom)}
        </span>
        <button className="scan-tool" onClick={c.zoomOut} disabled={!c.canZoomOut} aria-label="Zoom out">
          −
        </button>
      </div>
      {c.error && <span className="scan-tool-error">{c.error}</span>}
    </div>
  );
}
