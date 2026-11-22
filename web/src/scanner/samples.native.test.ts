// @vitest-environment jsdom
// Scan photos on the Android app's own camera (nativeCamera.ts): the recognizer is handed a small
// frame (360 × 640 of a 2160 × 3840 camera here), but a photo's view of the card is cut from the
// full camera frame through the plugin's region request (`around`), so the crops kept with it
// (photoCut.ts) are at the card's own resolution in the full frame, not the recognizer's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cutBox } from "./cameraSource";
import { CARD_CROP_MAX, CROPS } from "./photoCut";
import { HEADER, openNativeCamera, type FrameChannel, type FrameRequest, type NativeDescribed, type ScannerCameraPlugin } from "./nativeCamera";
import type { Quad } from "./types";

const DESCRIBED: NativeDescribed = {
  binary: true,
  lensAsked: "main",
  lens: "main",
  lenses: [{ lens: "main", equivalent: 24 }],
  fpsAsked: 30,
  fpsRange: [30, 30],
  fpsRanges: [[30, 30]],
  width: 2160,
  height: 3840,
  zoom: 1,
  zoomMin: 1,
  zoomMax: 8,
  hasTorch: false,
  torch: false,
  torchLevels: 0,
  focusMode: "continuous",
  focusNearest: 0.08,
  focusFarthest: 4,
};

/** A binary reply as ScannerCameraPlugin.answer writes it, of a `width` × `height` RGBA picture. */
function reply(id: number, width: number, height: number, seq: number): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER + width * height * 4);
  const h = new DataView(buf);
  h.setUint32(0, id, true);
  h.setUint32(8, width, true);
  h.setUint32(12, height, true);
  h.setUint32(16, 2160, true);
  h.setUint32(20, 3840, true);
  h.setUint32(24, seq, true);
  h.setFloat64(32, Date.now(), true);
  return buf;
}

/** The plugin and the channel in memory: frames of 360 × 640; regions from the 2160 × 3840 frame. */
function fakes() {
  const requests: FrameRequest[] = [];
  let seq = 0;
  const channel: FrameChannel = {
    onmessage: null,
    postMessage(text) {
      const q = JSON.parse(text) as FrameRequest & { id: number };
      requests.push(q);
      const frame = q.op === "frame";
      const rw = frame ? 360 : Math.round((q.w ?? 1) * 2160);
      const rh = frame ? 640 : Math.round((q.h ?? 1) * 3840);
      const k = frame ? 1 : Math.min(1, (q.maxSide ?? Infinity) / Math.max(rw, rh));
      const buf = reply(q.id, Math.round(rw * k), Math.round(rh * k), (seq += 1));
      setTimeout(() => this.onmessage?.({ data: buf }), 0);
    },
  };
  const plugin: ScannerCameraPlugin = {
    available: async () => ({ available: true, binary: true }),
    open: async () => DESCRIBED,
    close: async () => undefined,
    setRect: async () => undefined,
    set: async () => DESCRIBED,
    status: async () => ({ ...DESCRIBED, fps: 30 }),
    frame: async () => ({ width: 1, height: 1, fullWidth: 2160, fullHeight: 3840, seq: 1, format: "rgba", convertMs: 1, waitMs: 0, sentAt: Date.now(), data: btoa(String.fromCharCode(1, 2, 3, 255)) }),
    region: async () => ({ width: 1, height: 1, fullWidth: 2160, fullHeight: 3840, seq: 1, format: "rgba", convertMs: 1, waitMs: 0, sentAt: Date.now(), data: btoa(String.fromCharCode(9, 9, 9, 255)) }),
  };
  return { plugin, channel, requests };
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData: () => undefined, drawImage: () => undefined, getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A card 180 × 320 recognizer-frame pixels: 1,080 × 1,920 of the full frame. */
const quad: Quad = [
  [90, 160],
  [270, 160],
  [270, 480],
  [90, 480],
];

describe("scan photos on the app's own camera", () => {
  it("cut their crops from the full frame's region, not the recognizer's small frame", async () => {
    const { plugin, channel, requests } = fakes();
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "main", fps: 30, width: 3840, height: 2160 }, { plugin, channel, settleMs: 0 });
    await cam.ready;
    // The scanner's view of a card found in the collection (CUT_SIDE, 2,400 px).
    const shot = await cam.around(quad, document.createElement("canvas"), 2400);
    expect(requests.some((r) => r.op === "region" && r.maxSide === 2400)).toBe(true);
    const sizes = Object.fromEntries(CROPS.map(([name, cut]) => [name, cut(shot)]).map(([name, img]) => [name, [(img as { width: number }).width, (img as { height: number }).height]]));
    // The card is ~1,920 px tall in the full frame: its whole-card crop is capped, never the 320 of the small frame.
    expect(sizes.card).toEqual([Math.round((CARD_CROP_MAX * 63) / 88), CARD_CROP_MAX]);
    // The set symbol's area at the card's own width there (30% of ~1,080 px, at most 800) and the
    // strip across the whole card, where the small frame would have given 54 and 180 px.
    expect(sizes.symbol![0]).toBeGreaterThan(300);
    expect(sizes.strip![0]).toBeGreaterThan(1000);
    // A deck or box scan cuts at 1,200 px: the card crop is then the card's height in that cut.
    const small = await cam.around(quad, document.createElement("canvas"), 1200);
    const card = CROPS.find(([name]) => name === "card")![1](small);
    const box = cutBox(quad, 360, 640, Number.POSITIVE_INFINITY);
    expect(card.height).toBe(Math.round((320 * 1200) / box.h));
    cam.close();
  });
});
