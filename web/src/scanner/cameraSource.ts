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
import { applyH, squareToQuad, type CardRegion } from "./image";
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
  /** Native: the lens the phone is using now, where it says (so "auto" can be checked, not assumed). */
  activeLens?: string;
  /** Native: the capture rate asked for, and the exposure's range the camera was given. */
  fpsAsked?: number;
  fpsRange?: [number, number];
  /** Native: the size of the frames the recognizer is handed (the full frame is `width` × `height`). */
  frameWidth?: number;
  frameHeight?: number;
  /** Native: how frames cross to the page, and what one costs (ms, medians of the last frames). */
  transport?: "binary" | "base64";
  bridge?: BridgeCost;
  /** Native: autofocus is following the card's collector line (an APK from 27 Nov 2026 on; absent before). */
  lineFocus?: boolean;
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

/** Camera2's autofocus states (CaptureResult.CONTROL_AF_STATE, 0 to 6), as a frame's capture names them. */
export type AfState = "inactive" | "passive-scan" | "passive-focused" | "active-scan" | "focused-locked" | "not-focused-locked" | "passive-unfocused";

/**
 * What the camera said of a frame as it took it: the app's camera since 27 Nov 2026 (a browser's
 * says nothing). Kept with each collector-line read in Scanner diagnostics, so a soft frame can be
 * told apart: the lens still finding focus, focused somewhere else, or a long exposure (shake).
 */
export interface FrameCapture {
  /** The autofocus state, where it said. */
  af?: AfState;
  /**
   * The camera says it focused on a region sent for the card's collector line (LineFocus.java):
   * absent where its result didn't say which region it used.
   */
  line?: boolean;
  /** The frame's request asked for the line's region. */
  lineAsked: boolean;
  /** Where the lens was focused, in whole centimetres (255: that or further), where it said. */
  focusCm?: number;
  /** The exposure's time in ms (to a tenth), where it said. */
  exposureMs?: number;
}

export interface CameraSource {
  readonly kind: "browser" | "native";
  /** The frame to read now, or null before the camera has one. */
  frame(): FrameElement | null;
  /** Full-resolution pixels per frame pixel: 1 for a browser's video, more where frames are handed over small. */
  fullScale(): number;
  /**
   * The part of the frame around a card (its quad in frame pixels) at the camera's full
   * resolution, its longest side at most `maxSide`, and the quad within it. With `part`, only
   * around that part of the card (LINE_PART: where the collector line is read); the quad is still
   * the whole card's, its far corners then outside the image. The app's camera also says what it
   * knew of the frame as it took it (`capture`).
   */
  around(quad: Quad, canvas: HTMLCanvasElement, maxSide?: number, part?: CardRegion): Promise<{ image: RgbaImage; quad: Quad; capture?: FrameCapture }>;
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
 * down to `maxSide` (never up). `card`, when the quad is a part of a card (`partQuad`): the margin
 * is the whole card's, which refineQuad needs to look past each edge it snaps to (9% of the card's
 * width either side; 8% of a part's longer side can be less).
 */
export function cutBox(quad: Quad, width: number, height: number, maxSide: number, card: Quad = quad): FrameBox & { k: number } {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const span = (q: Quad, i: 0 | 1) => Math.max(...q.map((p) => p[i])) - Math.min(...q.map((p) => p[i]));
  const pad = 0.08 * Math.max(span(card, 0), span(card, 1));
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(width, Math.ceil(Math.max(...xs) + pad));
  const y1 = Math.min(height, Math.ceil(Math.max(...ys) + pad));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, k: Math.min(1, maxSide / Math.max(x1 - x0, y1 - y0)) };
}

/** The longest side a card is cut at unless the caller says otherwise: enough for the collector line. */
export const CUT_SIDE = 2400;

/**
 * The part of a card the collector line is read from (`around`'s `part`): its bottom 60%, whole
 * width. Every crop of the line is in its bottom eighth; the rest keeps enough of the card's left
 * and right edges (and its bottom) for refineQuad to snap the corners, which it can't from less
 * (scanner.test.ts). Bryan, 25 Nov 2026: "starting at a lower resolution and only upping the
 * resolution as we need to for things like the card number". Everything else the scanner looks at
 * is the camera's small frame (640 px across); only this part is cut at full resolution. For a card
 * 2250 px tall in a 4K frame (Bryan's median) that is 1960 × 1710 px against the whole card's 1802 ×
 * 2400: about a fifth fewer pixels to convert and hand over, and the line at the camera's full
 * resolution rather than 92% of it (the whole card is scaled to CUT_SIDE) [ran: the arithmetic].
 */
export const LINE_PART: CardRegion = { x0: 0, y0: 0.4, x1: 1, y1: 1 };

/** Where `part` of a card (as a share of its width and height, from its printed top left) lies in the frame: its four corners. */
export function partQuad(quad: Quad, part: CardRegion): Quad {
  const h = squareToQuad(quad);
  return [applyH(h, part.x0, part.y0), applyH(h, part.x1, part.y0), applyH(h, part.x1, part.y1), applyH(h, part.x0, part.y1)];
}

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
    async around(quad, canvas, maxSide = CUT_SIDE, part) {
      const v = need();
      const b = cutBox(part ? partQuad(quad, part) : quad, v.videoWidth, v.videoHeight, maxSide, quad);
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
