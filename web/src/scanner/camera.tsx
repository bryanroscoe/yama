// Flashlight and zoom on the camera view (Bryan, 2026-11-06). The flashlight is offered where the
// browser exposes the camera's torch (Chrome on Android; not Safari). Zoom uses the camera's own
// zoom where the browser exposes it, else a digital zoom: the view is enlarged and the recognizer
// is given the middle of the frame, so a small or far card is seen with more of the camera's pixels.
// Exposure (23 Nov 2026) is offered where the camera says it can change it: Chrome's track as the
// browser exposes it, and the Android app's own camera (nativeCamera.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import { clampFocus, distanceToSlider, fmtFocus, focusRange, saveFocus, savedFocus, sliderToDistance, type FocusRange } from "./cameraFocus";

export interface CameraCaps {
  torch: boolean;
  /** The camera's own zoom range, when the browser exposes it. */
  zoom: { min: number; max: number } | null;
  /** Exposure compensation in EV (`exposureCompensation`), where the camera can change it. */
  exposure: ExposureCaps | null;
}

/** Exposure compensation in EV: from `min` to `max` in steps of `step`, 0 being the camera's own. */
export interface ExposureCaps {
  min: number;
  max: number;
  step: number;
}

const NO_CAPS: CameraCaps = { torch: false, zoom: null, exposure: null };

/**
 * A track that can itself be asked to change its exposure (the app's own camera, from Scan
 * settings: nativeCamera.ts). The camera controls hand it their setter, bound to that track, while
 * it's the one they control, so every change goes through the one serial applier and `exposure`
 * says what the camera was last set to.
 */
export interface ExposureBound {
  bindExposure?(set: ExposureSetter | null): void;
}

/**
 * Set the exposure (EV): whether the camera took it. `cancelled`, asked right before the change is
 * applied, drops it (Scan settings closed while it queued behind other camera changes).
 */
export type ExposureSetter = (ev: number, cancelled?: () => boolean) => Promise<boolean>;
/** Zoom levels offered, kept to what the camera allows. */
const LEVELS = [1, 1.5, 2, 3, 4];
/** Digital zoom stops here: past it the frame is too few pixels to be worth it. */
const DIGITAL_MAX = 3;
/** + and a pinch stop here with the camera's own zoom: under a phone's switch to its telephoto at 5× (zoomPolicy.ts) [inferred]. */
export const HAND_MAX = 4;

/**
 * Constraint changes for one track, one at a time (review of #145: focus and zoom snapshotted the
 * settings before awaiting, so one overwrote the other). Each change is merged with whatever was
 * applied last, when it runs. A change for a track that is no longer current, before or after it
 * runs, resolves false: its caller mustn't publish that state for whichever camera is current now.
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
    /**
     * Run `work` on the track by itself, between the queued changes: a constraint change of
     * another kind (the frame rate, frameRate.ts), which a browser won't take in the same call as
     * these and which replaces them. What was applied here is sent again after it. Undefined for
     * a track that is no longer current.
     */
    exclusive<T>(t: MediaStreamTrack, work: () => Promise<T>): Promise<T | undefined> {
      const run = async () => {
        if (current() !== t) return undefined;
        const out = await work();
        if (current() === t && Object.keys(applied).length > 0) await apply(t, applied).catch(() => undefined);
        return out;
      };
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
    /** `skip`: asked right before it's applied; true drops it (its caller went away while it queued). */
    set(t: MediaStreamTrack, patch: Record<string, unknown>, skip?: () => boolean): Promise<boolean> {
      const run = async () => {
        if (current() !== t || skip?.()) return false;
        // A setting given as undefined is taken out (a pinned focus distance, once focus is automatic).
        const next = Object.fromEntries(Object.entries({ ...applied, ...patch }).filter(([, v]) => v !== undefined));
        await apply(t, next);
        if (current() !== t) return false;
        applied = next;
        return true;
      };
      const p = chain.then(run, run);
      chain = p.catch(() => undefined);
      return p;
    },
  };
}

export function readCaps(track: MediaStreamTrack): CameraCaps {
  const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean; zoom?: { min?: number; max?: number }; exposureCompensation?: { min?: number; max?: number; step?: number } };
  const zoom = caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > (caps.zoom.min ?? 1) ? { min: caps.zoom.min ?? 1, max: caps.zoom.max } : null;
  const e = caps.exposureCompensation;
  // A camera that can't change it says a range of 0 to 0, or a step of 0.
  const exposure = e && fin(e.min) && fin(e.max) && fin(e.step) && e.step > 0 && e.max > e.min ? { min: e.min, max: e.max, step: e.step } : null;
  return { torch: caps.torch === true, zoom, exposure };
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * An exposure for this camera: the nearest step to `ev` (the steps count from 0, the camera's
 * own, as Android's and Chrome's do), within its range, to 3 decimals.
 */
export function clampExposure(range: ExposureCaps, ev: number): number {
  const stepped = Math.round(ev / range.step) * range.step;
  const within = Math.min(range.max, Math.max(range.min, stepped));
  return Math.round(within * 1000) / 1000 || 0;
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

/** A zoom for this camera: within its own range (or 1× to the digital limit) and the 4× cap, to two decimals. */
export function clampZoom(caps: CameraCaps, z: number): number {
  const lo = caps.zoom ? caps.zoom.min : 1;
  return Math.round(Math.min(zoomTop(caps), Math.max(lo, z)) * 100) / 100;
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
  /** The most frames a second the camera says it can deliver (at some size). */
  maxFrameRate?: number;
  zoom?: number;
  zoomRange?: [number, number];
  /** Exposure compensation now and its range, in EV, where the camera says. */
  exposure?: number;
  exposureRange?: [number, number];
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
  const st = (track.getSettings?.() ?? {}) as MediaTrackSettings & { zoom?: number; focusMode?: string; focusDistance?: number; resizeMode?: string; exposureCompensation?: number };
  const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
    zoom?: { min?: number; max?: number };
    exposureCompensation?: { min?: number; max?: number };
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
    maxFrameRate: caps.frameRate?.max,
    zoom: st.zoom,
    zoomRange: range(caps.zoom),
    exposure: st.exposureCompensation,
    exposureRange: range(caps.exposureCompensation),
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
  /** The exposure compensation the camera open now was last set to (EV; 0 is the camera's own). */
  const [exposure, setExposureState] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** Where the lens can be pinned on this camera (cameraFocus.ts), and where it is pinned now (null: autofocus). */
  const [focusCaps, setFocusCaps] = useState<FocusRange | null>(null);
  const [focus, setFocusState] = useState<number | null>(null);
  const focusRef = useRef<{ range: FocusRange | null; pinned: number | null }>({ range: null, pinned: null });
  /** Every setting applied so far, sent together (one applyConstraints can replace the last), one change at a time. */
  const applier = useRef(serialApplier((t, all) => t.applyConstraints({ advanced: [all as MediaTrackConstraintSet] }), () => track.current));
  const apply = (t: MediaStreamTrack, patch: Record<string, unknown>, skip?: () => boolean) => applier.current.set(t, patch, skip);
  /** The capabilities of the camera open now (the state above is for rendering). */
  const capsRef = useRef<CameraCaps>(NO_CAPS);
  /** The person zoomed (+, − or a pinch): auto-zoom leaves it to them for the session. */
  const userZoomed = useRef(false);
  /**
   * Set the exposure compensation (EV, kept to the camera's range and step; 0 is the camera's own):
   * whether `t`, the camera open now, took it (false: another camera by then, none to change, or refused).
   */
  const exposeOn = useCallback(async (t: MediaStreamTrack | null, ev: number, cancelled?: () => boolean): Promise<boolean> => {
    const range = capsRef.current.exposure;
    if (!t || track.current !== t || !range || !Number.isFinite(ev) || cancelled?.()) return false;
    const want = clampExposure(range, ev);
    try {
      // Only for the camera it was meant for (another may be open by the time it's done), and not
      // if its caller went away while it queued.
      if (!(await apply(t, { exposureCompensation: want }, cancelled))) return false;
      if (track.current !== t) return false;
      // What the camera says it's at, where it says.
      const reported = (t.getSettings?.() as { exposureCompensation?: number } | undefined)?.exposureCompensation;
      setExposureState(fin(reported) ? reported : want);
      setError(null);
      return true;
    } catch {
      if (track.current === t) setError("The camera didn't change its exposure");
      return false;
    }
  }, []);
  const setExposure = useCallback<ExposureSetter>((ev, cancelled) => exposeOn(track.current, ev, cancelled), [exposeOn]);
  const attach = useCallback((t: MediaStreamTrack | null) => {
    // The camera let go no longer changes its exposure through these controls.
    if (track.current !== t) (track.current as ExposureBound | null)?.bindExposure?.(null);
    track.current = t;
    const caps = (t?.getCapabilities?.() ?? {}) as { focusMode?: string[] };
    // The lens pinned on this device before stays pinned, where this camera can (cameraFocus.ts).
    const range = focusRange(t);
    const saved = range ? savedFocus() : null;
    const pinned = range && saved?.pinned ? clampFocus(range, saved.distance) : null;
    focusRef.current = { range, pinned };
    setFocusCaps(range);
    setFocusState(pinned);
    // Else continuous focus, where offered. Either goes with every later setting too, and is applied now.
    const focus: Record<string, unknown> = pinned != null ? { focusMode: "manual", focusDistance: pinned } : caps.focusMode?.includes("continuous") ? { focusMode: "continuous" } : {};
    applier.current.reset({});
    if (t && focus.focusMode)
      void apply(t, focus).catch(() => {
        // The camera wouldn't hold the pin: back to its own focus, and say the pin is off.
        if (pinned == null || track.current !== t || !range) return;
        focusRef.current.pinned = null;
        setFocusState(null);
        void apply(t, { focusMode: range.auto, focusDistance: undefined }).catch(() => undefined);
      });
    capsRef.current = t ? readCaps(t) : NO_CAPS;
    // A pinch still queued for the last camera goes with it.
    pending.current.next = null;
    setCaps(capsRef.current);
    setTorchState(false);
    setZoomState(1);
    // Never the last camera's: where this one is now, which is 0 (its own) unless it was opened at
    // the exposure chosen in Scan settings (the app's camera, nativeCamera.ts).
    const now = (t?.getSettings?.() as { exposureCompensation?: number } | undefined)?.exposureCompensation;
    setExposureState(capsRef.current.exposure && fin(now) ? now : 0);
    if (t) (t as ExposureBound).bindExposure?.((ev, cancelled) => exposeOn(t, ev, cancelled));
    setError(null);
  }, []);
  /** The person has used the flashlight button this session: the scanner then never touches it (glare.ts TorchOnStruggle). */
  const torchByPerson = useRef(false);
  /** Turn the flashlight on or off: whether the camera open now took it (false: another camera, or refused). */
  const setTorch = useCallback(async (on: boolean): Promise<boolean> => {
    const t = track.current;
    if (!t) return false;
    try {
      // Only for the camera it was meant for (another may be open by the time it's done).
      if (!(await apply(t, { torch: on }))) return false;
      if (track.current !== t) return false;
      // A browser may skip a setting it can't meet and still resolve (an \`advanced\` set): the camera's
      // own report, where it gives one, says whether it took it (review of #208).
      const now = (t.getSettings?.() as { torch?: unknown } | undefined)?.torch;
      if (typeof now === "boolean" && now !== on) {
        setError(on ? "The flashlight didn't turn on" : "The flashlight didn't turn off");
        return false;
      }
      setTorchState(on);
      setError(null);
      return true;
    } catch {
      if (track.current === t) setError(on ? "The flashlight didn't turn on" : "The flashlight didn't turn off");
      return false;
    }
  }, []);
  /**
   * Zoom the camera in use: its own zoom where it has one, else digitally. Read from the camera
   * open when it's called, and published only if that camera is still the one in use (review of
   * #145: a 4× meant for a camera with its own zoom landed on one without, past its 3× limit).
   */
  const setZoom = useCallback(async (z: number, forTrack?: MediaStreamTrack | null) => {
    const t = track.current;
    // A request made on another camera (a pinch queued before a switch) is dropped.
    if (forTrack !== undefined && forTrack !== t) return;
    const c = capsRef.current;
    // Clamped to the camera in use, right before it's applied (and to the 4× cap).
    const want = clampZoom(c, z);
    let shown = want;
    if (c.zoom && t) {
      try {
        if (!(await apply(t, { zoom: want }))) return;
      } catch {
        if (track.current === t) setError("The camera didn't zoom");
        return;
      }
      // What the camera says it's at, where it says.
      const reported = (t.getSettings?.() as { zoom?: number } | undefined)?.zoom;
      if (typeof reported === "number" && Number.isFinite(reported)) shown = reported;
    }
    if (track.current !== t) return;
    setZoomState(shown);
    setError(null);
  }, []);
  /**
   * Any zoom in the camera's range (or 1× to the digital limit), for a pinch. Camera calls are
   * queued, newest wins; each is bound to the camera it was made on, and dropped if that changed.
   */
  const pending = useRef<{ busy: boolean; next: { z: number; t: MediaStreamTrack | null } | null }>({ busy: false, next: null });
  const zoomTo = useCallback(
    (z: number) => {
      userZoomed.current = true;
      const p = pending.current;
      p.next = { z: clampZoom(capsRef.current, z), t: track.current };
      if (p.busy) return;
      p.busy = true;
      void (async () => {
        while (p.next != null) {
          const v = p.next;
          p.next = null;
          await setZoom(v.z, v.t);
        }
        p.busy = false;
      })();
    },
    [setZoom],
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
  /**
   * Pin the lens at `d` (the browser's units, metres), or hand focus back to the camera with null.
   * Remembered on this device. Calls from a dragged slider are queued, newest wins, as a pinch's are.
   */
  const focusQueue = useRef<{ busy: boolean; next: { d: number | null } | null }>({ busy: false, next: null });
  const setFocus = useCallback((d: number | null) => {
    const q = focusQueue.current;
    q.next = { d };
    if (q.busy) return;
    q.busy = true;
    void (async () => {
      while (q.next) {
        const want = q.next.d;
        q.next = null;
        const t = track.current;
        const range = focusRef.current.range;
        if (!t || !range) continue;
        const pinned = want == null ? null : clampFocus(range, want);
        try {
          if (!(await apply(t, pinned == null ? { focusMode: range.auto, focusDistance: undefined } : { focusMode: "manual", focusDistance: pinned }))) continue;
        } catch {
          if (track.current === t) setError(pinned == null ? "The camera didn't go back to autofocus" : "The camera didn't hold that focus");
          continue;
        }
        if (track.current !== t) continue;
        const last = savedFocus();
        saveFocus({ pinned: pinned != null, distance: pinned ?? focusRef.current.pinned ?? last?.distance ?? range.near });
        focusRef.current.pinned = pinned;
        setFocusState(pinned);
        setError(null);
      }
      q.busy = false;
    })();
  }, []);
  /** Turn the pin on (where it was last, else where the camera is focused now, else the middle of the slider) or off. */
  const pinFocus = useCallback(
    (on: boolean) => {
      const range = focusRef.current.range;
      if (!on || !range) return setFocus(null);
      const now = (track.current?.getSettings?.() as { focusDistance?: number } | undefined)?.focusDistance;
      setFocus(savedFocus()?.distance ?? (typeof now === "number" && now > 0 ? now : sliderToDistance(range, 0.5)));
    },
    [setFocus],
  );
  /** Focus on a point of the frame (0 to 1 across and down), where the browser lets it; else nothing. Never while the lens is pinned. */
  const focusAt = useCallback((x: number, y: number) => {
    const t = track.current;
    if (!t || !pointsOfInterestSupported() || focusRef.current.pinned != null) return;
    void apply(t, { pointsOfInterest: [{ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }] }).catch(() => undefined);
  }, []);
  return {
    attach,
    caps,
    torch,
    setTorch,
    /** The flashlight button: the person's own choice, which the scanner leaves alone from then on. */
    personSetsTorch: useCallback(
      (on: boolean) => {
        torchByPerson.current = true;
        return setTorch(on);
      },
      [setTorch],
    ),
    /** Whether the person has used the flashlight button this session. */
    torchTouched: useCallback(() => torchByPerson.current, []),
    /** The exposure compensation the camera was last set to (EV), and setting it; `caps.exposure` says whether it can. */
    exposure,
    setExposure,
    zoom,
    autoZoom,
    focusAt,
    /** Run a constraint change of another kind on `t` by itself, in turn with these (serialApplier). */
    exclusive: useCallback(<T,>(t: MediaStreamTrack, work: () => Promise<T>) => applier.current.exclusive(t, work), []),
    /** Where the lens can be pinned on this camera, or null where the browser doesn't offer it. */
    focusCaps,
    /** Where the lens is pinned (metres), or null on autofocus. */
    focus,
    setFocus,
    pinFocus,
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
  // The scanner zooms by itself and a pinch zooms too, so zoom is one small button showing the
  // level; a tap opens + and − (Bryan, 16 Nov 2026: too busy).
  const [zoomOpen, setZoomOpen] = useState(false);
  const levelRef = useRef<HTMLButtonElement>(null);
  // The focus slider while it's being dragged: the lens follows a moment behind (camera calls queue).
  const [slide, setSlide] = useState<number | null>(null);
  const [sliding, setSliding] = useState(false);
  // Let go, the slider shows where the finger left it until the lens has caught up (or failed, or the pin went off).
  const caught = slide != null && c.focusCaps != null && c.focus != null && Math.abs(c.focus - sliderToDistance(c.focusCaps, slide)) < 0.002;
  useEffect(() => {
    if (slide != null && !sliding && (caught || c.focus == null || c.error)) setSlide(null);
  }, [slide, sliding, caught, c.focus, c.error]);
  // Another camera: what was dragged on the last one means nothing here.
  useEffect(() => setSlide(null), [c.focusCaps]);
  const groupRef = useRef<HTMLDivElement>(null);
  // + and − fold away again a few seconds after the last zoom. Focus on one of them goes back to
  // the level button rather than to the page (Codex review, 16 Nov 2026).
  useEffect(() => {
    if (!zoomOpen) return;
    const t = window.setTimeout(() => {
      const at = document.activeElement;
      if (at && at !== levelRef.current && groupRef.current?.contains(at)) levelRef.current?.focus();
      setZoomOpen(false);
    }, 4000);
    return () => window.clearTimeout(t);
  }, [zoomOpen, c.zoom]);
  if (!live) return null;
  return (
    <div className="scan-tools">
      {c.caps.torch && (
        <Button className={`scan-tool${c.torch ? " is-on" : ""}`} onClick={() => void c.personSetsTorch(!c.torch)} aria-pressed={c.torch} aria-label={c.torch ? "Turn the flashlight off" : "Turn the flashlight on"}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 2h10v4l-3 4v11a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V10L7 6z" />
            {c.torch && <path d="M12 13v3" />}
          </svg>
        </Button>
      )}
      {(c.canZoomIn || c.canZoomOut) && (
        <div ref={groupRef} className={`scan-zoom-buttons${zoomOpen ? " is-open" : ""}`} role="group" aria-label="Zoom">
          {zoomOpen && (
            <Button className="scan-tool" onClick={c.zoomIn} disabled={!c.canZoomIn} aria-label="Zoom in">
              +
            </Button>
          )}
          <Button ref={levelRef} className="scan-tool scan-zoom-level" onClick={() => setZoomOpen((o) => !o)} aria-expanded={zoomOpen} aria-label={`Zoom ${fmt(c.zoom)}${zoomOpen ? "" : ", change it"}`}>
            {fmt(c.zoom)}
          </Button>
          {/* A pinch or the scanner's own zoom, said too: the button's label alone isn't announced. */}
          <span className="visually-hidden" aria-live="polite">
            {fmt(c.zoom)}
          </span>
          {zoomOpen && (
            <Button className="scan-tool" onClick={c.zoomOut} disabled={!c.canZoomOut} aria-label="Zoom out">
              −
            </Button>
          )}
        </div>
      )}
      {c.focusCaps && (
        <div className="scan-focus">
          <Button
            className={`scan-tool${c.focus != null ? " is-on" : ""}`}
            onClick={() => c.pinFocus(c.focus == null)}
            aria-pressed={c.focus != null}
            aria-label={c.focus != null ? "Focus is pinned. Go back to autofocus" : "Pin the focus"}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
          </Button>
          {c.focus != null && (
            <label className="scan-focus-slider">
              <span>Focus {fmtFocus(slide != null ? sliderToDistance(c.focusCaps, slide) : c.focus)}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={slide ?? distanceToSlider(c.focusCaps, c.focus)}
                onChange={(e) => {
                  const t = Number(e.target.value);
                  setSlide(t);
                  c.setFocus(sliderToDistance(c.focusCaps!, t));
                }}
                onPointerDown={() => setSliding(true)}
                onPointerUp={() => setSliding(false)}
                onPointerCancel={() => setSliding(false)}
                aria-label="Focus distance, near to far"
                aria-valuetext={fmtFocus(slide != null ? sliderToDistance(c.focusCaps, slide) : c.focus)}
              />
            </label>
          )}
        </div>
      )}
      {c.error && <span className="scan-tool-error">{c.error}</span>}
    </div>
  );
}
