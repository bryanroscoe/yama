// The Android app's own camera as a camera source (cameraSource.ts): ScannerCameraPlugin.java
// opens the camera with CameraX and draws the preview behind the web view, which is transparent
// while it is open (`html.native-camera`, scanner.css). This file asks it for frames:
//
//   - a small frame for the recognizer, pulled over and over into a canvas that stands where the
//     <video> does (same size on screen, not painted: the preview behind it is what's seen);
//   - a region of the full camera frame on request, cut in native code from the frame last pulled.
//
// Frames cross as ArrayBuffers over a web message channel where the web view supports it, else as
// base64 through plugin calls. What a frame costs to cross is measured as it runs (`bridge` in
// `info()`), and `bench` times every way of crossing for the PR and Scan settings.
//
// It is an option in Scan settings (off unless turned on, per device), offered only inside the
// app with native code that has the plugin.
//
// The card finder can run in native code too (NativeFinder.java; docs/plans/scanner-match-cardvision.md,
// stage 3): on every frame the camera analyses, drawing the outline natively. Each frame the page
// pulls then comes with the card's corners already found on it (`found()`), so the web recognizer
// matches the art there and doesn't look for the card again. `loadNativeFinder` hands the app the
// card finder's file (the page has it in its cache; the app keeps a copy) and `nativeFind` runs it
// on a frame from the page (the speed test).

import { Capacitor, registerPlugin } from "@capacitor/core";
import { cameraInfo } from "./camera";
import { CUT_SIDE, cutBox, draw, type BridgeCost, type CameraSource, type FrameElement, type SourceInfo } from "./cameraSource";
import { RECOGNIZER_SHORT_SIDE } from "./artClient";
import type { Quad, RgbaImage } from "./types";

// ---- The option ----

export type NativeLens = "auto" | "main" | "ultrawide" | "telephoto";

export const LENS_NAMES: Record<NativeLens, string> = { auto: "Automatic", main: "Main", ultrawide: "Ultra-wide", telephoto: "Telephoto" };

export interface NativeCameraOption {
  /** Use the app's own camera. */
  on: boolean;
  lens: NativeLens;
  /** Frames a second to ask the camera for: 30 or 60 (faster is a high-speed session, which can't feed the scanner). */
  fps: number;
  /** The flashlight's strength (1 up to what the phone has), or null for the phone's own. */
  torchLevel: number | null;
}

/** On this device: whether the scanner uses the app's own camera, and how it's set. */
export const NATIVE_CAMERA_KEY = "yama.scan.nativeCamera";

const isLens = (v: unknown): v is NativeLens => v === "auto" || v === "main" || v === "ultrawide" || v === "telephoto";
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Use the app's own camera where the plugin is available unless this device opted out. */
export function savedNativeCamera(): NativeCameraOption {
  const defaults: NativeCameraOption = { on: nativeCameraAvailable(), lens: "auto", fps: 30, torchLevel: null };
  try {
    const v = JSON.parse(localStorage.getItem(NATIVE_CAMERA_KEY) ?? "null") as Partial<NativeCameraOption> | null;
    if (!v || typeof v !== "object") return defaults;
    return {
      on: typeof v.on === "boolean" ? v.on : defaults.on,
      lens: isLens(v.lens) ? v.lens : defaults.lens,
      fps: v.fps === 60 ? 60 : defaults.fps,
      torchLevel: positive(v.torchLevel) ? Math.round(v.torchLevel) : defaults.torchLevel,
    };
  } catch {
    return defaults;
  }
}

export function saveNativeCamera(o: NativeCameraOption) {
  try {
    localStorage.setItem(NATIVE_CAMERA_KEY, JSON.stringify(o));
  } catch {
    /* storage off */
  }
}

/** Whether this is the Android app with native code that has the camera (an older APK doesn't). */
export function nativeCameraAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("ScannerCamera");
  } catch {
    return false;
  }
}

// ---- The plugin ----

/** What the plugin says of the camera: what was asked for, what the phone gave, how it's set now. */
export interface NativeDescribed {
  binary: boolean;
  lensAsked: string;
  lens: string;
  lensNote?: string;
  /** The lens the phone is using now, where it says (Android 10 on, a lens it lists). */
  activeLens?: string;
  lenses: { lens: string; equivalent: number }[];
  fpsAsked: number;
  fpsRange?: [number, number];
  fpsRanges: [number, number][];
  /** Frames a second the camera is delivering, once it has delivered some. */
  fps?: number;
  /** The full frame, upright. */
  width?: number;
  height?: number;
  zoom?: number;
  zoomMin?: number;
  zoomMax?: number;
  hasTorch: boolean;
  torch: boolean;
  /** 0 without a flashlight, 1 for on or off only, more where its strength can be set. */
  torchLevels: number;
  torchLevel?: number;
  focusMode: string;
  focusDistance?: number;
  /** Metres: as near as the lens focuses, and where everything beyond is sharp. Absent when focus can't be set. */
  focusNearest?: number;
  focusFarthest?: number;
  /** The app's own card finder (NativeFinder.java), where this APK has it. */
  finder?: NativeFinderStatus;
}

/** What the app's card finder is doing. */
export interface NativeFinderStatus {
  loaded: boolean;
  on: boolean;
  /** Why it stopped: it never starts again for this camera. */
  failed?: string;
  loadMs?: number;
  /** The median find of the last frames, ms, and frames found a second. */
  ms?: number;
  fps?: number;
}

/** The app's card finder on one frame, as the frame's reply carries it. */
export interface NativeFound {
  /** FOUND_CARD: a card in view (with its corners); FOUND_NONE: none; FOUND_FAILED: the finder stopped; FOUND_OFF: it isn't running. */
  state: number;
  /** The card's corners in the frame's pixels, top-left as printed first, when one is in view. */
  quad: Quad | null;
  /** How sure the finder is that a card is there (0 to 1). */
  vote: number;
  /** The find's milliseconds in native code, and its detector runs. */
  ms: number;
  passes: number;
  /** How long ago the camera took the frame, when the reply was sent. */
  ageMs: number;
}

export const FOUND_OFF = 0;
export const FOUND_CARD = 1;
export const FOUND_NONE = 2;
export const FOUND_FAILED = 3;

export interface NativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The page's width in CSS pixels, so native code can turn the rest into its own. */
  viewWidth: number;
}

export interface NativeSet {
  zoom?: number;
  torch?: boolean;
  torchLevel?: number;
  focusMode?: "continuous" | "manual";
  focusDistance?: number;
  point?: { x: number; y: number };
}

export interface FrameRequest {
  op: "frame" | "region";
  /** A frame: its short side. */
  shortSide?: number;
  /** A region, as fractions of the frame, and its longest side. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  maxSide?: number;
  format?: "rgba" | "jpeg";
  quality?: number;
  /** Time the crossing on a made-up frame of this size, with no camera. */
  synthetic?: boolean;
  fullWidth?: number;
  fullHeight?: number;
  /** A frame the app's card finder looked at, with what it found (while it runs). */
  found?: boolean;
}

interface Base64Frame {
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  seq: number;
  format: "rgba" | "jpeg";
  convertMs: number;
  waitMs: number;
  sentAt: number;
  data: string;
  finder?: Omit<NativeFound, "quad"> & { quad?: [number, number][] };
}

export interface ScannerCameraPlugin {
  available(): Promise<{ available: boolean; binary: boolean }>;
  open(o: { lens: string; fps: number; width: number; height: number; rect: NativeRect | null }): Promise<NativeDescribed>;
  close(): Promise<void>;
  setRect(o: { rect: NativeRect }): Promise<void>;
  set(o: NativeSet): Promise<NativeDescribed>;
  status(): Promise<NativeDescribed>;
  frame(o: FrameRequest): Promise<Base64Frame>;
  region(o: FrameRequest): Promise<Base64Frame>;
  /** Whether this APK can run the card finder (ONNX Runtime ships for arm64-v8a and x86_64 only). */
  finderAvailable?(): Promise<{ finder: boolean; reason?: string; abi?: string }>;
  finderModel?(o: { key: string; data: string }): Promise<{ key: string; bytes: number }>;
  /** Rejects with code "need-model" when the app doesn't have `key` yet. */
  finderLoad?(o: { key: string; constants: Record<string, unknown>; shortSide: number }): Promise<{ key: string; loadMs: number }>;
  finderSet?(o: { on?: boolean; outline?: boolean; reset?: boolean }): Promise<NativeFinderStatus>;
  finderUnload?(): Promise<void>;
  find?(o: { width: number; height: number; data: string; reset?: boolean }): Promise<{ state: number; quad?: [number, number][]; vote: number; ms: number; runs: number[] }>;
}

const ScannerCamera = registerPlugin<ScannerCameraPlugin>("ScannerCamera");

// ---- Frames across the bridge ----

/** One frame or region as it arrived. */
export interface NativeFrame {
  width: number;
  height: number;
  /** The full camera frame it was made from. */
  fullWidth: number;
  fullHeight: number;
  seq: number;
  format: "rgba" | "jpeg";
  /** RGBA pixels, or a JPEG file. */
  data: Uint8Array;
  /** Native: scaling and converting it. */
  convertMs: number;
  /** Native: waiting for the camera to deliver it. */
  waitMs: number;
  /** From native's send to here. */
  transitMs: number;
  /** The app's card finder on this frame (absent from a plain frame of an APK without it). */
  finder?: NativeFound;
}

export interface FrameTransport {
  readonly kind: "binary" | "base64";
  request(q: FrameRequest): Promise<NativeFrame>;
  close(): void;
}

/** A binary reply's header (ScannerCameraPlugin.HEADER). */
export const HEADER = 104;

const quadOf = (q: readonly (readonly number[])[] | undefined | null): Quad | null =>
  q && q.length === 4 && q.every((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])) ? (q.map((p) => [p[0]!, p[1]!]) as Quad) : null;

/** A binary reply: its request's id, and the frame or the reason there is none. */
export function parseReply(buf: ArrayBuffer, now = Date.now()): { id: number; frame?: NativeFrame; error?: string } {
  if (buf.byteLength < HEADER) return { id: 0, error: "A camera frame arrived cut short" };
  const h = new DataView(buf, 0, HEADER);
  const id = h.getUint32(0, true);
  if (h.getUint32(4, true) !== 0) return { id, error: new TextDecoder().decode(new Uint8Array(buf, HEADER)) || "The camera gave no frame" };
  const width = h.getUint32(8, true);
  const height = h.getUint32(12, true);
  const format = h.getUint32(28, true) === 1 ? "jpeg" : "rgba";
  if (format === "rgba" && buf.byteLength - HEADER !== width * height * 4) return { id, error: "A camera frame doesn't match its size" };
  const state = h.getUint32(48, true);
  const corners = [0, 1, 2, 3].map((i) => [h.getFloat32(56 + i * 8, true), h.getFloat32(60 + i * 8, true)]);
  const finder: NativeFound = { state, quad: state === FOUND_CARD ? quadOf(corners) : null, vote: h.getFloat32(52, true), ms: h.getFloat32(88, true), passes: h.getUint32(92, true), ageMs: h.getFloat32(96, true) };
  return {
    id,
    frame: {
      width,
      height,
      fullWidth: h.getUint32(16, true),
      fullHeight: h.getUint32(20, true),
      seq: h.getUint32(24, true),
      format,
      data: new Uint8Array(buf, HEADER),
      convertMs: h.getFloat32(40, true),
      waitMs: h.getFloat32(44, true),
      transitMs: Math.max(0, now - h.getFloat64(32, true)),
      finder,
    },
  };
}

/** The object the plugin adds to the page where the web view can pass ArrayBuffers. */
export interface FrameChannel {
  postMessage(message: string): void;
  onmessage: ((e: { data: unknown }) => void) | null;
}

export const frameChannel = (): FrameChannel | null => (globalThis as { yamaScannerCamera?: FrameChannel }).yamaScannerCamera ?? null;

/** How long a frame may take to come before its request is given up. */
const REPLY_TIMEOUT_MS = 5000;

/** Frames as ArrayBuffers over the web message channel: requests go out as JSON, each reply carries its request's id. */
export function binaryTransport(channel: FrameChannel, timeoutMs = REPLY_TIMEOUT_MS): FrameTransport {
  // Ids start somewhere new for each transport, so a late reply to a closed one matches nothing here.
  let next = 1 + Math.floor(Math.random() * 1e6) * 1000;
  let closed = false;
  const waiting = new Map<number, { resolve: (f: NativeFrame) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const heard = (e: { data: unknown }) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const r = parseReply(e.data);
    const w = waiting.get(r.id);
    if (!w) return;
    waiting.delete(r.id);
    clearTimeout(w.timer);
    if (r.frame) w.resolve(r.frame);
    else w.reject(new Error(r.error));
  };
  channel.onmessage = heard;
  return {
    kind: "binary",
    request(q) {
      if (closed) return Promise.reject(new Error("The camera closed"));
      const id = next++;
      return new Promise<NativeFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("The camera didn't answer"));
        }, timeoutMs);
        waiting.set(id, { resolve, reject, timer });
        channel.postMessage(JSON.stringify({ ...q, id }));
      });
    },
    close() {
      closed = true;
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new Error("The camera closed"));
      }
      waiting.clear();
      // Only its own: a newer transport on the same channel keeps hearing.
      if (channel.onmessage === heard) channel.onmessage = null;
    },
  };
}

async function fromBase64(s: string): Promise<Uint8Array> {
  try {
    // The browser's own decoder, off the page's thread.
    return new Uint8Array(await (await fetch(`data:application/octet-stream;base64,${s}`)).arrayBuffer());
  } catch {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
}

/** Frames as base64 through plugin calls: every web view has it. */
export function base64Transport(plugin: Pick<ScannerCameraPlugin, "frame" | "region">): FrameTransport {
  return {
    kind: "base64",
    async request(q) {
      const r = await (q.op === "region" ? plugin.region(q) : plugin.frame(q));
      const arrived = Date.now();
      const data = await fromBase64(r.data);
      // Decoding the base64 is part of what this way of crossing costs.
      const f = r.finder;
      const finder: NativeFound | undefined = f ? { state: f.state, quad: f.state === FOUND_CARD ? quadOf(f.quad) : null, vote: f.vote, ms: f.ms, passes: f.passes, ageMs: f.ageMs } : undefined;
      return { width: r.width, height: r.height, fullWidth: r.fullWidth, fullHeight: r.fullHeight, seq: r.seq, format: r.format, data, convertMs: r.convertMs, waitMs: r.waitMs, transitMs: Math.max(0, arrived - r.sentAt) + (Date.now() - arrived), finder };
    },
    close() {},
  };
}

const imageOf = (f: NativeFrame): RgbaImage => {
  const data = new Uint8ClampedArray(f.data.buffer as ArrayBuffer, f.data.byteOffset, f.width * f.height * 4);
  return typeof ImageData === "function" ? new ImageData(data, f.width, f.height) : { width: f.width, height: f.height, data };
};

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- The source ----

export interface NativeCameraRequest {
  lens: NativeLens;
  fps: number;
  /** The full frame to ask the camera for (landscape). */
  width: number;
  height: number;
  torchLevel?: number | null;
}

/** One way of crossing the bridge, timed (ms, medians). */
export interface BenchRow {
  what: string;
  size: string;
  frames: number;
  /** A frame's bytes as they cross. */
  bytes: number;
  convert: number;
  transit: number;
  draw: number;
  /** From asking to drawable, less the wait for the camera's next frame. */
  total: number;
}

export interface NativeCamera extends CameraSource {
  readonly kind: "native";
  /** Resolves with what the camera gave once it has delivered a frame; rejects if it won't open. */
  readonly ready: Promise<SourceInfo>;
  info(): SourceInfo | null;
  described(): NativeDescribed | null;
  /** The flashlight's strength from now on (and now, if it's lit). */
  setTorchLevel(level: number | null): Promise<void>;
  /** Time every way a frame can cross to the page. */
  bench(frames?: number): Promise<BenchRow[]>;
  /**
   * What the app's card finder found on the frame in the canvas now (null when the frame came
   * without it: the finder isn't running, or this frame was taken before it started).
   */
  found(): NativeFound | null;
  /**
   * Run the app's card finder on this camera's frames (it must be loaded: `loadNativeFinder`), or
   * stop it; show its outline or not; forget the card it tracks. Resolves with what it's doing.
   */
  setFinder(o: { on?: boolean; outline?: boolean; reset?: boolean }): Promise<NativeFinderStatus | null>;
  /** What the app's card finder is doing, as the camera last said. */
  finderStatus(): NativeFinderStatus | null;
  close(): void;
}

export interface NativeCameraDeps {
  plugin?: ScannerCameraPlugin;
  channel?: FrameChannel | null;
  /** Called when what the camera delivers is known better (the capture rate, measured a little after opening). */
  onInfo?: (info: SourceInfo) => void;
  /** The most frames a second pulled for the recognizer. */
  pullRate?: number;
  /** How long to wait before asking for the camera (tests: 0). */
  settleMs?: number;
}

/** The class on <html> while the native preview shows through the page (scanner.css). */
export const NATIVE_CLASS = "native-camera";

/**
 * The camera is opened and closed one call at a time, in the order asked, whichever scanner asked:
 * a camera closing (a new lens, the scanner remounting) is closed before the next one opens.
 */
let calls: Promise<unknown> = Promise.resolve();
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const p = calls.then(fn, fn);
  calls = p.catch(() => undefined);
  return p;
}

/** How often the camera is asked what it delivers. */
const STATUS_MS = 2500;
/** How long a new camera waits before it's asked for (see `ready`). */
const SETTLE_MS = 30;
/** After binding, try the browser camera if CameraX still hasn't supplied a usable frame. */
const FIRST_FRAME_MS = 3000;
/** Frames are pulled no faster than this: the recognizer reads fewer than that a second. */
const PULL_RATE = 20;
/** Frames timed for `bridge`. */
const COST_WINDOW = 30;

/**
 * Open the app's own camera, pulling frames into `canvas` (which stands where the <video> does).
 * Close it when done: the preview goes and the page gets its ground back.
 */
export function openNativeCamera(canvas: HTMLCanvasElement, req: NativeCameraRequest, deps: NativeCameraDeps = {}): NativeCamera {
  const plugin = deps.plugin ?? ScannerCamera;
  const el = canvas as HTMLCanvasElement & FrameElement & { readyState?: number; srcObject?: unknown };
  let closed = false;
  /** The plugin was asked to open this camera, so closing it is owed. */
  let asked = false;
  let described: NativeDescribed | null = null;
  let transport: FrameTransport | null = null;
  let full: { w: number; h: number } | null = null;
  let hasFrame = false;
  let benching = false;
  /** The app's card finder runs: frames are asked for with what it found on them. */
  let finding = false;
  let lastFound: NativeFound | null = null;
  let torchLevel: number | null = positiveOrNull(req.torchLevel);
  /** What the track's callers last asked for, so a repeat isn't sent again. */
  const cleanups: (() => void)[] = [];
  const sent: { zoom?: number; torch?: boolean; focus?: string; point?: string } = {};
  // Away and back, the camera starts again with its flashlight off and its focus its own: what
  // was sent is forgotten, so the next change sends everything camera.tsx holds.
  const forget = () => {
    if (document.visibilityState === "visible") for (const k of Object.keys(sent) as (keyof typeof sent)[]) delete sent[k];
  };
  document.addEventListener("visibilitychange", forget);
  cleanups.push(() => document.removeEventListener("visibilitychange", forget));
  const costs: { convert: number; transit: number; draw: number; bytes: number }[] = [];

  // The canvas answers as the <video> does: a size once there's a frame, and "has a stream".
  Object.defineProperties(el, {
    videoWidth: { configurable: true, get: () => (hasFrame ? el.width : 0) },
    videoHeight: { configurable: true, get: () => (hasFrame ? el.height : 0) },
    readyState: { configurable: true, get: () => (hasFrame ? 4 : 0) },
    srcObject: { configurable: true, get: () => (closed || !described ? null : track) },
  });

  const rect = (): NativeRect | null => {
    const box = (el.closest(".scan-camera") ?? el).getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? { x: box.left, y: box.top, width: box.width, height: box.height, viewWidth: window.innerWidth } : null;
  };

  const put = (f: NativeFrame) => {
    const started = performance.now();
    if (el.width !== f.width) el.width = f.width;
    if (el.height !== f.height) el.height = f.height;
    el.getContext("2d", { willReadFrequently: true })?.putImageData(imageOf(f) as ImageData, 0, 0);
    full = { w: f.fullWidth, h: f.fullHeight };
    // With the canvas: the read loop takes the two together (`found()`).
    lastFound = f.finder && f.finder.state !== FOUND_OFF ? f.finder : null;
    hasFrame = true;
    costs.push({ convert: f.convertMs, transit: f.transitMs, draw: performance.now() - started, bytes: f.data.byteLength });
    if (costs.length > COST_WINDOW) costs.shift();
  };

  const bridge = (): BridgeCost | undefined =>
    costs.length
      ? { frames: costs.length, convert: round1(median(costs.map((c) => c.convert))), transit: round1(median(costs.map((c) => c.transit))), draw: round1(median(costs.map((c) => c.draw))), bytes: costs[costs.length - 1]!.bytes }
      : undefined;

  const set = async (patch: NativeSet) => {
    described = { ...(described as NativeDescribed), ...(await plugin.set(patch)) };
  };

  // The camera's controls, shaped as the track camera.tsx drives: zoom, torch, focus and a point
  // to focus on arrive as constraints and leave as plugin calls.
  const track = {
    kind: "video",
    get label() {
      return described ? `App camera, ${LENS_NAMES[described.lens as NativeLens] ?? described.lens}` : "App camera";
    },
    getCapabilities() {
      const d = described;
      if (!d) return {};
      return {
        ...(d.zoomMax != null && d.zoomMin != null ? { zoom: { min: d.zoomMin, max: d.zoomMax, step: 0.1 } } : {}),
        torch: d.hasTorch,
        focusMode: d.focusNearest != null ? ["continuous", "manual"] : ["continuous"],
        ...(d.focusNearest != null && d.focusFarthest != null ? { focusDistance: { min: d.focusNearest, max: d.focusFarthest, step: 0.01 } } : {}),
        ...(d.width && d.height ? { width: { max: d.width }, height: { max: d.height } } : {}),
      };
    },
    getSettings() {
      const d = described;
      if (!d) return {};
      return { deviceId: `native:${d.lens}`, facingMode: "environment", width: d.width, height: d.height, frameRate: d.fps ?? d.fpsRange?.[1], zoom: d.zoom, torch: d.torch, focusMode: d.focusMode, focusDistance: d.focusDistance };
    },
    async applyConstraints(c?: MediaTrackConstraints) {
      if (closed || !described) return;
      const adv = ((c?.advanced?.[0] as Record<string, unknown> | undefined) ?? (c as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
      const patch: NativeSet = {};
      // Remembered as sent only once the camera has taken them: a refused setting is asked again.
      const next = { ...sent };
      if (typeof adv.zoom === "number" && adv.zoom !== sent.zoom) {
        patch.zoom = adv.zoom;
        next.zoom = adv.zoom;
      }
      if (typeof adv.torch === "boolean" && adv.torch !== sent.torch) {
        patch.torch = adv.torch;
        next.torch = adv.torch;
        if (adv.torch && torchLevel && described.torchLevels > 1) patch.torchLevel = torchLevel;
      }
      // Focus: held at a distance (the camera view's focus slider, cameraFocus.ts), or by itself.
      const manual = adv.focusMode === "manual" || typeof adv.focusDistance === "number";
      const focus = manual ? `manual:${String(adv.focusDistance)}` : adv.focusMode === "continuous" ? "continuous" : undefined;
      if (focus && focus !== sent.focus) {
        next.focus = focus;
        if (manual) {
          patch.focusMode = "manual";
          if (typeof adv.focusDistance === "number") patch.focusDistance = adv.focusDistance;
        } else patch.focusMode = "continuous";
      }
      const p = (adv.pointsOfInterest as { x: number; y: number }[] | undefined)?.[0];
      const point = p ? `${p.x},${p.y}` : undefined;
      if (p && point !== sent.point) {
        next.point = point;
        patch.point = { x: p.x, y: p.y };
      }
      if (!Object.keys(patch).length) return;
      await set(patch);
      Object.assign(sent, next);
    },
    stop() {},
  } as unknown as MediaStreamTrack;

  const info = (): SourceInfo | null => {
    const d = described;
    if (!d) return null;
    return {
      ...cameraInfo(track),
      source: "native",
      // The rate the camera delivers, once measured (never the rate asked for).
      frameRate: d.fps,
      lens: d.lens,
      lensAsked: d.lensAsked,
      lensNote: d.lensNote,
      activeLens: d.activeLens,
      fpsAsked: d.fpsAsked,
      fpsRange: d.fpsRange,
      frameWidth: hasFrame ? el.width : undefined,
      frameHeight: hasFrame ? el.height : undefined,
      transport: transport?.kind,
      bridge: bridge(),
    };
  };

  const need = () => {
    if (closed || !transport || !hasFrame) throw new Error("The camera has no frame");
    return transport;
  };

  const pull = async (t: FrameTransport, firstFrame: () => void) => {
    const gap = 1000 / (deps.pullRate ?? PULL_RATE);
    while (!closed) {
      if (benching || (typeof document !== "undefined" && document.visibilityState !== "visible")) {
        await sleep(200);
        continue;
      }
      const started = performance.now();
      try {
        const f = await t.request({ op: "frame", shortSide: RECOGNIZER_SHORT_SIDE, ...(finding ? { found: true } : {}) });
        if (closed) return;
        put(f);
        firstFrame();
      } catch {
        // No frame yet, or the app was away: ask again shortly.
        if (closed) return;
        await sleep(250);
        continue;
      }
      const spent = performance.now() - started;
      await sleep(Math.max(0, gap - spent));
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const c of cleanups) c();
    transport?.close();
    document.documentElement.classList.remove(NATIVE_CLASS);
    if (asked) return inTurn(() => plugin.close()).catch(() => undefined);
  };

  const ready = (async (): Promise<SourceInfo> => {
    // A scanner mounted and unmounted at once (React's strict mode) never reaches the camera.
    // (The plugin itself waits for the web view's own camera to let go before it opens.)
    await sleep(deps.settleMs ?? SETTLE_MS);
    const d = await inTurn(async () => {
      if (closed) throw new Error("The camera closed");
      asked = true;
      return plugin.open({ lens: req.lens, fps: req.fps, width: req.width, height: req.height, rect: rect() });
    });
    // Closed while it was opening: `close` has already asked for it to be closed, in turn.
    if (closed) throw new Error("The camera closed");
    described = d;
    const channel = deps.channel === undefined ? frameChannel() : deps.channel;
    transport = d.binary && channel ? binaryTransport(channel) : base64Transport(plugin);
    document.documentElement.classList.add(NATIVE_CLASS);
    // The preview follows the camera box: the sheet moving it, the phone turning.
    const follow = () => {
      const r = rect();
      if (r && !closed) void plugin.setRect({ rect: r }).catch(() => undefined);
    };
    const box = el.closest(".scan-camera") ?? el;
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(follow) : null;
    ro?.observe(box);
    window.addEventListener("resize", follow);
    cleanups.push(() => {
      ro?.disconnect();
      window.removeEventListener("resize", follow);
    });
    follow();
    const first = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FIRST_FRAME_MS);
      void pull(transport!, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await first;
    if (closed) throw new Error("The camera closed");
    if (!hasFrame) {
      // Give the device back before the WebView tries to open it on the ready rejection.
      await close();
      throw new Error("The app's camera didn't deliver a frame");
    }
    // The capture rate the camera really delivers, and the lens the phone is using, are known
    // once it has run a moment, and can change: asked now and then, told when they differ.
    let told = "";
    const later = setInterval(() => {
      void plugin.status().then(
        (s) => {
          if (closed) return;
          described = { ...(described as NativeDescribed), ...s };
          const now = `${s.fps == null ? "" : Math.round(s.fps)}|${s.activeLens ?? ""}`;
          const i = info();
          if (i && now !== told) deps.onInfo?.(i);
          told = now;
        },
        () => undefined,
      );
    }, STATUS_MS);
    cleanups.push(() => clearInterval(later));
    return info()!;
  })();
  // A camera closed before anyone listened mustn't report an unhandled rejection.
  ready.catch(() => undefined);

  const timeOne = async (t: FrameTransport, q: FrameRequest, scratch: HTMLCanvasElement) => {
    const asked = performance.now();
    const f = await t.request(q);
    const got = performance.now();
    scratch.width = f.width;
    scratch.height = f.height;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    if (f.format === "jpeg") {
      const bmp = await createImageBitmap(new Blob([f.data as BlobPart], { type: "image/jpeg" }));
      ctx?.drawImage(bmp, 0, 0);
      bmp.close();
    } else ctx?.putImageData(imageOf(f) as ImageData, 0, 0);
    const drawn = performance.now();
    return { f, draw: drawn - got, total: drawn - asked - f.waitMs };
  };

  return {
    kind: "native",
    ready,
    frame: () => (hasFrame && !closed ? el : null),
    fullScale: () => (full && hasFrame && el.width > 0 ? full.w / el.width : 1),
    async around(quad, _canvas, maxSide = CUT_SIDE) {
      const t = need();
      const b = cutBox(quad, el.width, el.height, Number.POSITIVE_INFINITY);
      const f = await t.request({ op: "region", x: b.x / el.width, y: b.y / el.height, w: b.w / el.width, h: b.h / el.height, maxSide });
      // Pixels of the cut per frame pixel: the cut is from the full frame, so usually more than 1.
      const kx = f.width / b.w;
      const ky = f.height / b.h;
      return { image: imageOf(f), quad: quad.map(([x, y]) => [(x - b.x) * kx, (y - b.y) * ky]) as Quad };
    },
    async region(box, w, h, scratch) {
      const t = need();
      const f = await t.request({ op: "region", x: box.x / el.width, y: box.y / el.height, w: box.w / el.width, h: box.h / el.height, maxSide: Math.max(w, h) });
      const image = imageOf(f);
      if (f.width === Math.round(w) && f.height === Math.round(h)) return image;
      // Not the size asked for (a region is never enlarged natively): scaled here.
      const tmp = document.createElement("canvas");
      tmp.width = f.width;
      tmp.height = f.height;
      tmp.getContext("2d")?.putImageData(image as ImageData, 0, 0);
      return draw(tmp, 0, 0, f.width, f.height, w, h, scratch);
    },
    track: () => (closed || !described ? null : track),
    info,
    described: () => described,
    async setTorchLevel(level) {
      torchLevel = positiveOrNull(level);
      if (closed || !described || !described.torch || !torchLevel || described.torchLevels <= 1) return;
      await set({ torch: true, torchLevel });
    },
    async bench(frames = 15) {
      if (closed || !described) throw new Error("The camera isn't open");
      benching = true;
      // The running transport is used for binary (the channel hears one at a time), and plugin
      // calls for base64.
      const ways: { name: string; t: FrameTransport }[] = [];
      if (transport?.kind === "binary") ways.push({ name: "ArrayBuffer", t: transport });
      ways.push({ name: "base64", t: transport?.kind === "base64" ? transport : base64Transport(plugin) });
      const scratch = document.createElement("canvas");
      const rows: BenchRow[] = [];
      // Where the camera delivers nothing (an emulator), the crossing is timed on a made-up frame
      // the size the camera was asked for.
      const made: FrameRequest = hasFrame ? {} as FrameRequest : ({ synthetic: true, fullWidth: req.width, fullHeight: req.height } as FrameRequest);
      const run = async (label: string, t: FrameTransport, ask: FrameRequest) => {
        const q = { ...ask, ...made };
        const what = hasFrame ? label : `${label}, made-up frame`;
        const got: Awaited<ReturnType<typeof timeOne>>[] = [];
        for (let i = 0; i < frames && !closed; i += 1) got.push(await timeOne(t, q, scratch));
        if (!got.length) return;
        const f = got[got.length - 1]!.f;
        rows.push({
          what,
          size: `${f.width}×${f.height}`,
          frames: got.length,
          bytes: f.data.byteLength,
          convert: round1(median(got.map((g) => g.f.convertMs))),
          transit: round1(median(got.map((g) => g.f.transitMs))),
          draw: round1(median(got.map((g) => g.draw))),
          total: round1(median(got.map((g) => g.total))),
        });
      };
      try {
        for (const w of ways) {
          await run(`${w.name}, RGBA`, w.t, { op: "frame", shortSide: RECOGNIZER_SHORT_SIDE, format: "rgba" });
          await run(`${w.name}, JPEG`, w.t, { op: "frame", shortSide: RECOGNIZER_SHORT_SIDE, format: "jpeg", quality: 90 });
        }
        const best = ways[0]!;
        // A card's worth of the full frame, as a read cuts it (the middle 60% by 80%).
        await run(`${best.name}, RGBA, a card at 1200`, best.t, { op: "region", x: 0.2, y: 0.1, w: 0.6, h: 0.8, maxSide: 1200 });
        await run(`${best.name}, RGBA, a card at 2400`, best.t, { op: "region", x: 0.2, y: 0.1, w: 0.6, h: 0.8, maxSide: 2400 });
      } finally {
        benching = false;
      }
      return rows;
    },
    found: () => (closed ? null : lastFound),
    async setFinder(o) {
      if (closed || !described || !plugin.finderSet) return null;
      const st = await inTurn(() => plugin.finderSet!(o));
      if (o.on !== undefined) finding = !!st.on;
      if (!finding) lastFound = null;
      described = { ...(described as NativeDescribed), finder: st };
      return st;
    },
    finderStatus: () => described?.finder ?? null,
    close,
  };
}

// ---- The app's card finder, apart from any camera ----

export interface NativeFinderAbility {
  finder: boolean;
  /** Why it can't run here. */
  reason?: string;
  abi?: string;
}

let ability: Promise<NativeFinderAbility> | null = null;

/**
 * Whether this app can run the card finder in native code (asked once). Only the Android app's
 * own camera has it, and ONNX Runtime ships for arm64-v8a and x86_64 phones only (Bryan, 22 Nov
 * 2026): a 32-bit phone keeps the web view's finder.
 */
export function nativeFinderAbility(plugin: Pick<ScannerCameraPlugin, "finderAvailable"> = ScannerCamera): Promise<NativeFinderAbility> {
  if (plugin === ScannerCamera && !nativeCameraAvailable()) return Promise.resolve({ finder: false, reason: "Only the Android app can" });
  if (plugin !== ScannerCamera) return (plugin.finderAvailable?.() ?? Promise.resolve({ finder: false })).catch((e: unknown) => ({ finder: false, reason: message(e) }));
  return (ability ??= (plugin.finderAvailable?.() ?? Promise.resolve({ finder: false, reason: "This app is older than its card finder" })).catch((e: unknown) => ({ finder: false, reason: message(e) })));
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown) => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");

/** Bytes as base64, a chunk at a time (one call per byte would overflow the stack). */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  return btoa(s);
}

/**
 * The name the app keeps a card finder's file under: its own name when it is content-addressed
 * (`corners-18f9d6aab2a4.onnx`, as the server names Yama's files), else its bundle folder's name
 * and its own (`<bundle version>-detector.onnx`), so another bundle's file is another name.
 */
export function finderKey(file: string): string {
  const parts = new URL(file, "https://x.invalid").pathname.split("/").filter(Boolean);
  const name = parts[parts.length - 1] ?? "detector.onnx";
  const key = /-[0-9a-f]{12}\.onnx$/.test(name) ? name : `${parts[parts.length - 2] ?? "bundle"}-${name}`;
  return key.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(-120);
}

/**
 * Load the card finder in the app: from the copy it keeps, or, the first time, from `bytes` (the
 * page's cached file, handed over once). Rejects when it can't run here or won't load.
 */
export async function loadNativeFinder(
  file: { key: string; bytes: () => Promise<Uint8Array> },
  constants: Record<string, unknown>,
  plugin: Pick<ScannerCameraPlugin, "finderLoad" | "finderModel"> = ScannerCamera,
): Promise<{ loadMs: number; sent: boolean }> {
  if (!plugin.finderLoad || !plugin.finderModel) throw new Error("This app is older than its card finder");
  const ask = () => plugin.finderLoad!({ key: file.key, constants, shortSide: RECOGNIZER_SHORT_SIDE });
  try {
    const r = await ask();
    return { loadMs: r.loadMs, sent: false };
  } catch (e) {
    if (codeOf(e) !== "need-model") throw e;
  }
  await plugin.finderModel({ key: file.key, data: toBase64(await file.bytes()) });
  const r = await ask();
  return { loadMs: r.loadMs, sent: true };
}

/** Let the app's card finder go (the scanner closed). */
export function unloadNativeFinder(plugin: Pick<ScannerCameraPlugin, "finderUnload"> = ScannerCamera): Promise<void> {
  return plugin.finderUnload?.().catch(() => undefined) ?? Promise.resolve();
}

/**
 * The app's card finder on a frame from the page (the speed test's), with its own tracking across
 * calls until `reset`. `runs`: each detector run's ms, timed in native code.
 */
export async function nativeFind(image: RgbaImage, reset: boolean, plugin: Pick<ScannerCameraPlugin, "find"> = ScannerCamera): Promise<NativeFound & { runs: number[] }> {
  if (!plugin.find) throw new Error("This app is older than its card finder");
  const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  const r = await plugin.find({ width: image.width, height: image.height, data: toBase64(data), reset });
  return { state: r.state, quad: r.state === FOUND_CARD ? quadOf(r.quad) : null, vote: r.vote, ms: r.ms, passes: r.runs.length, ageMs: 0, runs: r.runs };
}

function positiveOrNull(v: number | null | undefined): number | null {
  return positive(v) ? v : null;
}

/** One line of a bench for people: "ArrayBuffer, RGBA: 1138×640, 2.9 MB, 6.4 ms a frame (convert 3.1, crossing 1.2, drawing 2.1)". */
export function benchLine(r: BenchRow): string {
  const size = r.bytes >= 1e6 ? `${(r.bytes / 1e6).toFixed(1)} MB` : `${Math.round(r.bytes / 1e3)} kB`;
  return `${r.what}: ${r.size}, ${size}, ${r.total} ms a frame (convert ${r.convert}, crossing ${r.transit}, drawing ${r.draw})`;
}
