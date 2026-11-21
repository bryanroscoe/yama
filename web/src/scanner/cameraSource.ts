// The scanner's camera, behind one seam (docs/scanner.md, "The camera source"). The scanner asks
// a camera source for four things and doesn't care which camera answers:
//
//   - the frame to look at now (`frame`): something it can draw from, with a size, sitting in the
//     camera box so on-screen boxes can be mapped into it;
//   - a region of that frame at the camera's full resolution (`around` a card, or a plain `region`),
//     which is what text is read from;
//   - what the camera can do and its controls (`track`: a MediaStreamTrack, or the native camera
//     standing in for one, so zoom, torch and focus go through camera.tsx unchanged);
//   - what it is and what it delivers (`info`), for Scan settings and Scanner diagnostics.
//
// Two cameras answer: the browser's (a <video> fed by getUserMedia, as the scanner always had),
// and the Android app's own (nativeCamera.ts), whose frames are small and whose regions are cut
// from the full frame in native code.

import type { CameraInfo } from "./camera";
import type { Quad, RgbaImage } from "./types";

/**
 * What frames are read from: the <video>, or the native camera's canvas, which carries the same
 * `videoWidth` and `videoHeight` so one loop reads either.
 */
export type FrameElement = (HTMLVideoElement | HTMLCanvasElement) & { videoWidth: number; videoHeight: number };

/** A box in frame pixels. */
export interface FrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a camera source says of itself, on top of what camera.tsx reads from a track. */
export interface SourceInfo extends CameraInfo {
  /** Which camera this is. */
  source: "browser" | "native";
  /** Native: the lens in use ("auto" is the camera that switches lens itself) and the one asked for. */
  lens?: string;
  lensAsked?: string;
  /** Native: why the lens in use isn't the one asked for. */
  lensNote?: string;
  /** Native: the capture rate asked for, and the exposure's range the camera was given. */
  fpsAsked?: number;
  fpsRange?: [number, number];
  /** Native: the size of the frames the recognizer is handed (the full frame is `width` × `height`). */
  frameWidth?: number;
  frameHeight?: number;
  /** Native: how frames cross to the page, and what one costs (ms, medians of the last frames). */
  transport?: "binary" | "base64";
  bridge?: BridgeCost;
}

/** What handing one frame from native code to the page costs, in ms. */
export interface BridgeCost {
  /** Frames timed. */
  frames: number;
  /** Native: scaling the camera's frame to RGBA. */
  convert: number;
  /** From native's send to the page having the bytes. */
  transit: number;
  /** The page putting the bytes where the scanner draws from. */
  draw: number;
  /** Bytes a frame. */
  bytes: number;
}

export interface CameraSource {
  readonly kind: "browser" | "native";
  /** The frame to read now, or null before the camera has one. */
  frame(): FrameElement | null;
  /** Full-resolution pixels per frame pixel: 1 for a browser's video, more where frames are handed over small. */
  fullScale(): number;
  /**
   * The part of the frame around a card (its quad in frame pixels) at the camera's full
   * resolution, its longest side at most `maxSide`, and the quad within it.
   */
  around(quad: Quad, canvas: HTMLCanvasElement, maxSide?: number): Promise<{ image: RgbaImage; quad: Quad }>;
  /** A box of the frame, drawn `w` × `h` from the camera's full resolution. */
  region(box: FrameBox, w: number, h: number, canvas: HTMLCanvasElement): Promise<RgbaImage>;
  /** The camera's controls and capabilities, as a track. */
  track(): MediaStreamTrack | null;
  info(): SourceInfo | null;
}

/** `source`'s box drawn `w` × `h` on `canvas`, and read back. */
export function draw(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, w: number, h: number, canvas: HTMLCanvasElement): RgbaImage {
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * The box around a card quad that a read is cut from: the quad's bounds and a margin of 8% of its
 * longer side, kept inside a `width` × `height` frame, and the scale that brings its longest side
 * down to `maxSide` (never up).
 */
export function cutBox(quad: Quad, width: number, height: number, maxSide: number): FrameBox & { k: number } {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const pad = 0.08 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs) + pad));
  const y1 = Math.min(height, Math.ceil(Math.max(...ys) + pad));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, k: Math.min(1, maxSide / Math.max(x1 - x0, y1 - y0)) };
}

/** The longest side a card is cut at unless the caller says otherwise: enough for the collector line. */
export const CUT_SIDE = 2400;

/**
 * The browser's camera: the scanner's <video>, which ScannerView feeds from getUserMedia. Its
 * frames are already at full resolution, so a region is simply drawn from the video.
 */
export function browserCameraSource(video: () => HTMLVideoElement | null): CameraSource {
  const track = () => (video()?.srcObject as MediaStream | null | undefined)?.getVideoTracks?.()[0] ?? null;
  const need = () => {
    const v = video();
    if (!v || v.videoWidth === 0) throw new Error("The camera has no frame");
    return v;
  };
  return {
    kind: "browser",
    frame: () => video(),
    fullScale: () => 1,
    async around(quad, canvas, maxSide = CUT_SIDE) {
      const v = need();
      const b = cutBox(quad, v.videoWidth, v.videoHeight, maxSide);
      return { image: draw(v, b.x, b.y, b.w, b.h, b.w * b.k, b.h * b.k, canvas), quad: quad.map(([x, y]) => [(x - b.x) * b.k, (y - b.y) * b.k]) as Quad };
    },
    async region(box, w, h, canvas) {
      return draw(need(), box.x, box.y, box.w, box.h, w, h, canvas);
    },
    track,
    info() {
      const v = video();
      const st = track()?.getSettings?.();
      return v && v.videoWidth > 0 ? { source: "browser", width: v.videoWidth, height: v.videoHeight, frameRate: st?.frameRate, label: track()?.label || undefined } : null;
    },
  };
}

/** What a timing record calls the camera, in 40 characters or fewer: "2160×3840", or "2160×3840 native main 60fps". */
export function sourceLabel(info: SourceInfo): string | null {
  if (!info.width || !info.height) return null;
  const size = `${info.width}×${info.height}`;
  if (info.source !== "native") return size;
  const rate = info.frameRate ?? info.fpsRange?.[1];
  return [size, "native", info.lens ?? "auto", rate ? `${Math.round(rate)}fps` : null].filter(Boolean).join(" ").slice(0, 40);
}
