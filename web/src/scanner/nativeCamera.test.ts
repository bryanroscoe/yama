// @vitest-environment jsdom
// The app's own camera as a camera source: the option on this device, frames arriving over the
// binary channel or as base64, the canvas standing in for the video, regions cut from the full
// frame, and the camera's controls shaped as a track.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Capacitor } from "@capacitor/core";
import {
  base64Transport,
  benchLine,
  binaryTransport,
  captureOf,
  exposureRange,
  HEADER,
  NATIVE_CAMERA_KEY,
  NATIVE_CLASS,
  nativeCameraAvailable,
  openNativeCamera,
  parseReply,
  savedNativeCamera,
  saveNativeCamera,
  type FrameChannel,
  type FrameRequest,
  type NativeDescribed,
  type NativeSet,
  type ScannerCameraPlugin,
} from "./nativeCamera";
import type { Quad } from "./types";

/** A binary reply as ScannerCameraPlugin.answer writes it. */
function reply(o: { id: number; width?: number; height?: number; full?: [number, number]; seq?: number; error?: string; jpeg?: Uint8Array; sentAt?: number; capture?: number }): ArrayBuffer {
  const body = o.error != null ? new TextEncoder().encode(o.error) : (o.jpeg ?? new Uint8Array((o.width ?? 0) * (o.height ?? 0) * 4).fill(7));
  const buf = new ArrayBuffer(HEADER + body.byteLength);
  const h = new DataView(buf);
  h.setUint32(0, o.id, true);
  h.setUint32(4, o.error != null ? 1 : 0, true);
  h.setUint32(8, o.width ?? 0, true);
  h.setUint32(12, o.height ?? 0, true);
  h.setUint32(16, o.full?.[0] ?? 0, true);
  h.setUint32(20, o.full?.[1] ?? 0, true);
  h.setUint32(24, o.seq ?? 1, true);
  h.setUint32(28, o.jpeg ? 1 : 0, true);
  h.setFloat64(32, o.sentAt ?? Date.now(), true);
  h.setFloat32(40, 3.5, true);
  h.setFloat32(44, 12, true);
  h.setUint32(100, o.capture ?? 0, true);
  new Uint8Array(buf, HEADER).set(body);
  return buf;
}

const DESCRIBED: NativeDescribed = {
  binary: true,
  lensAsked: "main",
  lens: "main",
  lenses: [
    { lens: "main", equivalent: 24 },
    { lens: "ultrawide", equivalent: 13 },
  ],
  fpsAsked: 60,
  fpsRange: [60, 60],
  fpsRanges: [
    [15, 30],
    [30, 30],
    [60, 60],
  ],
  width: 2160,
  height: 3840,
  zoom: 1,
  zoomMin: 0.5,
  zoomMax: 8,
  hasTorch: true,
  torch: false,
  torchLevels: 5,
  focusMode: "continuous",
  focusNearest: 0.08,
  focusFarthest: 4,
};

/** A Pixel-like exposure: index -12 to 12 in sixths of a stop, so -2 to +2 EV. */
const EXPOSURE = { supported: true, min: -2, max: 2, step: 1 / 6, ev: 0, index: 0, minIndex: -12, maxIndex: 12, stepRational: [1, 6] as [number, number] };

/** The plugin and the channel, in memory: a 360 × 640 frame of a 2160 × 3840 camera. */
function fakes(described: NativeDescribed = DESCRIBED, opts: { capture?: number } = {}) {
  const sets: NativeSet[] = [];
  const requests: FrameRequest[] = [];
  const calls: string[] = [];
  let seq = 0;
  const channel: FrameChannel = {
    onmessage: null,
    postMessage(text) {
      const q = JSON.parse(text) as FrameRequest & { id: number };
      requests.push(q);
      const frame = q.op === "frame";
      // A region comes back at its longest side or the full frame's, whichever is less.
      const rw = frame ? 360 : Math.round((q.w ?? 1) * 2160);
      const rh = frame ? 640 : Math.round((q.h ?? 1) * 3840);
      const k = frame ? 1 : Math.min(1, (q.maxSide ?? Infinity) / Math.max(rw, rh));
      const buf = reply({ id: q.id, width: Math.round(rw * k), height: Math.round(rh * k), full: [2160, 3840], seq: (seq += 1), capture: frame ? undefined : opts.capture });
      setTimeout(() => this.onmessage?.({ data: buf }), 0);
    },
  };
  let now = { ...described };
  const opens: Parameters<ScannerCameraPlugin["open"]>[0][] = [];
  const plugin: ScannerCameraPlugin = {
    available: async () => ({ available: true, binary: true }),
    open: async (o) => {
      calls.push("open");
      opens.push(o);
      return now;
    },
    close: async () => {
      calls.push("close");
    },
    setRect: async () => undefined,
    set: async (o) => {
      sets.push(o);
      now = { ...now, ...(o.zoom != null ? { zoom: o.zoom } : {}), ...(o.torch != null ? { torch: o.torch } : {}), ...(o.focusMode ? { focusMode: o.focusMode, focusDistance: o.focusDistance } : {}) };
      // As ScannerCameraPlugin does: the nearest step of the camera's, within its range.
      const e = now.exposure;
      if (o.exposure != null && e?.supported) {
        const index = Math.max(e.minIndex!, Math.min(e.maxIndex!, Math.round(o.exposure / e.step!)));
        now = { ...now, exposure: { ...e, index, ev: index * e.step! } };
      }
      return now;
    },
    status: async () => ({ ...now, fps: 58.9 }),
    frame: async () => ({ width: 2, height: 1, fullWidth: 2160, fullHeight: 3840, seq: 1, format: "rgba", convertMs: 1, waitMs: 0, sentAt: Date.now(), data: btoa(String.fromCharCode(1, 2, 3, 255, 4, 5, 6, 255)) }),
    region: async () => ({ width: 1, height: 1, fullWidth: 2160, fullHeight: 3840, seq: 1, format: "rgba", convertMs: 1, waitMs: 0, sentAt: Date.now(), data: btoa(String.fromCharCode(9, 9, 9, 255)) }),
  };
  return { plugin, channel, sets, requests, calls, opens };
}

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  // jsdom draws nothing: the canvas only needs to take the frame.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData: () => undefined, drawImage: () => undefined, getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.classList.remove(NATIVE_CLASS);
});

describe("the option", () => {
  it("defaults to the browser camera without the plugin and ignores malformed settings", () => {
    expect(savedNativeCamera()).toEqual({ on: false, lens: "auto", fps: 30, torchLevel: null, exposure: 0, lineFocus: true });
    store.set(NATIVE_CAMERA_KEY, "not json");
    expect(savedNativeCamera().on).toBe(false);
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ on: "yes", lens: "fisheye", fps: -3, focus: "near" }));
    expect(savedNativeCamera()).toEqual({ on: false, lens: "auto", fps: 30, torchLevel: null, exposure: 0, lineFocus: true });
  });
  it("uses the native camera when supported and preserves an explicit opt-out", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    const available = vi.spyOn(Capacitor, "isPluginAvailable").mockImplementation((name) => name === "ScannerCamera");
    expect(savedNativeCamera()).toEqual({ on: true, lens: "auto", fps: 30, torchLevel: null, exposure: 0, lineFocus: true });
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ lens: "ultrawide", fps: 60 }));
    expect(savedNativeCamera()).toEqual({ on: true, lens: "ultrawide", fps: 60, torchLevel: null, exposure: 0, lineFocus: true });
    saveNativeCamera({ on: false, lens: "main", fps: 60, torchLevel: null, exposure: 0, lineFocus: true });
    expect(savedNativeCamera()).toEqual({ on: false, lens: "main", fps: 60, torchLevel: null, exposure: 0, lineFocus: true });
    store.delete(NATIVE_CAMERA_KEY);
    available.mockReturnValue(false);
    expect(savedNativeCamera().on).toBe(false);
  });
  it("takes Automatic over a Main saved before it became the default, and keeps any other lens or a choice since (23 Nov 2026)", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    vi.spyOn(Capacitor, "isPluginAvailable").mockImplementation((name) => name === "ScannerCamera");
    // Saved with version 3, on Main, which was then the default.
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ v: 3, on: true, lens: "main", fps: 30, torchLevel: null }));
    expect(savedNativeCamera()).toEqual({ on: true, lens: "auto", fps: 30, torchLevel: null, exposure: 0, lineFocus: true });
    // Main chosen while Automatic was the default (before version 3): a choice, kept.
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ lens: "main", fps: 60 }));
    expect(savedNativeCamera()).toMatchObject({ lens: "main", fps: 60 });
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ v: 2, on: true, lens: "main", fps: 30 }));
    expect(savedNativeCamera().lens).toBe("main");
    // Automatic, or another lens, saved before: kept.
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ v: 2, on: true, lens: "auto", fps: 30 }));
    expect(savedNativeCamera().lens).toBe("auto");
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ v: 3, on: true, lens: "ultrawide", fps: 30 }));
    expect(savedNativeCamera().lens).toBe("ultrawide");
    // Main chosen since: kept.
    saveNativeCamera({ on: true, lens: "main", fps: 30, torchLevel: null, exposure: 0, lineFocus: true });
    expect(savedNativeCamera().lens).toBe("main");
  });
  it("takes the default over an off saved while the app's camera was opt-in, keeping the rest", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    vi.spyOn(Capacitor, "isPluginAvailable").mockImplementation((name) => name === "ScannerCamera");
    // As the option was saved before 22 Nov 2026: no version, `on: false` beside a lens chosen.
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ on: false, lens: "ultrawide", fps: 60, torchLevel: 2 }));
    expect(savedNativeCamera()).toEqual({ on: true, lens: "ultrawide", fps: 60, torchLevel: 2, exposure: 0, lineFocus: true });
    // Turned off since, it stays off.
    saveNativeCamera({ on: false, lens: "main", fps: 60, torchLevel: 2, exposure: 0, lineFocus: true });
    expect(JSON.parse(store.get(NATIVE_CAMERA_KEY)!)).toMatchObject({ v: 4, on: false });
    expect(savedNativeCamera().on).toBe(false);
  });
  it("is remembered on this device", () => {
    saveNativeCamera({ on: true, lens: "ultrawide", fps: 60, torchLevel: 3, exposure: 0, lineFocus: true });
    expect(savedNativeCamera()).toEqual({ on: true, lens: "ultrawide", fps: 60, torchLevel: 3, exposure: 0, lineFocus: true });
    // Only 30 or 60: a faster rate saved by hand is 30.
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ on: true, fps: 120 }));
    expect(savedNativeCamera().fps).toBe(30);
  });
  it("isn't offered in a browser", () => {
    expect(nativeCameraAvailable()).toBe(false);
  });
  it("keeps the exposure chosen (23 Nov 2026), and reads a save from before it as the camera's own", () => {
    saveNativeCamera({ on: true, lens: "auto", fps: 30, torchLevel: null, exposure: -0.667, lineFocus: true });
    expect(savedNativeCamera().exposure).toBe(-0.667);
    // Saved before exposure, with this version and older ones: everything else as it was, the exposure 0.
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ v: 4, on: false, lens: "main", fps: 60, torchLevel: 3 }));
    expect(savedNativeCamera()).toEqual({ on: false, lens: "main", fps: 60, torchLevel: 3, exposure: 0, lineFocus: true });
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ v: 3, on: true, lens: "ultrawide", fps: 30 }));
    expect(savedNativeCamera()).toMatchObject({ lens: "ultrawide", exposure: 0 });
    // Nonsense is the camera's own.
    for (const exposure of ["-1", null, 50, -11, true]) {
      store.set(NATIVE_CAMERA_KEY, JSON.stringify({ v: 4, on: true, lens: "auto", fps: 30, exposure }));
      expect(savedNativeCamera().exposure).toBe(0);
    }
    // To three decimals, and never a negative zero.
    saveNativeCamera({ on: true, lens: "auto", fps: 30, torchLevel: null, exposure: -0.66666666, lineFocus: true });
    expect(JSON.parse(store.get(NATIVE_CAMERA_KEY)!)).toMatchObject({ v: 4, exposure: -0.667 });
    saveNativeCamera({ on: true, lens: "auto", fps: 30, torchLevel: null, exposure: -0.0001, lineFocus: true });
    expect(Object.is(savedNativeCamera().exposure, 0)).toBe(true);
  });
});

describe("focusing on the collector line (27 Nov 2026)", () => {
  it("is on unless turned off, and a save from before it reads as on", () => {
    vi.spyOn(Capacitor, "isNativePlatform").mockReturnValue(true);
    vi.spyOn(Capacitor, "isPluginAvailable").mockReturnValue(true);
    expect(savedNativeCamera().lineFocus).toBe(true);
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ v: 4, on: true, lens: "auto", fps: 30, torchLevel: null, exposure: 0 }));
    expect(savedNativeCamera().lineFocus).toBe(true);
    saveNativeCamera({ ...savedNativeCamera(), lineFocus: false });
    expect(savedNativeCamera()).toMatchObject({ lineFocus: false, lens: "auto", on: true });
    store.set(NATIVE_CAMERA_KEY, JSON.stringify({ v: 4, on: true, lens: "auto", fps: 30, lineFocus: "no" }));
    expect(savedNativeCamera().lineFocus).toBe(true);
  });

  it("reads what the camera said of a frame from the header's last four bytes", () => {
    // Focused on its own (2, plus one), on the line (top bit); 20 cm; 33.3 ms (333 tenths).
    expect(captureOf(0x83 | (20 << 8) | (333 << 16))).toEqual({ af: "passive-focused", line: true, focusCm: 20, exposureMs: 33.3 });
    // Still finding focus, not on the line, distance unknown.
    expect(captureOf(2 | (0 << 8) | (85 << 16))).toEqual({ af: "passive-scan", line: false, exposureMs: 8.5 });
    // As far as can be said, the longest exposure (the top bits set: a negative int in Java).
    expect(captureOf((255 << 8) | (65535 << 16))).toEqual({ line: false, focusCm: 255, exposureMs: 6553.5 });
    expect(captureOf(((255 << 8) | (65535 << 16)) | 0)).toEqual({ line: false, focusCm: 255, exposureMs: 6553.5 });
    // Nothing said (an APK before it), or an autofocus state it doesn't know.
    expect(captureOf(0)).toBeUndefined();
    expect(captureOf(undefined)).toBeUndefined();
    expect(captureOf(0x7f)).toEqual({ line: false });
  });

  it("comes with a binary reply, and not from an older APK", () => {
    expect(parseReply(reply({ id: 1, width: 1, height: 1, capture: 3 | (25 << 8) | (100 << 16) })).frame!.capture).toEqual({ af: "passive-focused", line: false, focusCm: 25, exposureMs: 10 });
    expect(parseReply(reply({ id: 1, width: 1, height: 1 })).frame!.capture).toBeUndefined();
  });

  it("comes with a base64 frame", async () => {
    const { plugin } = fakes();
    const t = base64Transport({ ...plugin, region: async () => ({ ...(await plugin.region({ op: "region" })), capture: 0x83 | (19 << 8) | (200 << 16) }) });
    expect((await t.request({ op: "region" })).capture).toEqual({ af: "passive-focused", line: true, focusCm: 19, exposureMs: 20 });
  });

  it("is asked for as the camera opens, turned on and off later, and said in what it delivers", async () => {
    const lineFocus = { asked: true, on: true, moves: 3, box: [0.1, 0.6, 0.4, 0.7] as [number, number, number, number] };
    const { plugin, channel, opens, sets } = fakes({ ...DESCRIBED, lineFocus });
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 3840, height: 2160, lineFocus: true }, { plugin, channel, settleMs: 0 });
    const info = await cam.ready;
    expect(opens[0]).toMatchObject({ lens: "auto", lineFocus: true });
    expect(info.lineFocus).toBe(true);
    expect(cam.described()!.lineFocus).toEqual(lineFocus);
    await cam.setLineFocus(false);
    expect(sets).toEqual([{ lineFocus: false }]);
    cam.close();
    // Closed: nothing more is sent.
    await cam.setLineFocus(true);
    expect(sets).toEqual([{ lineFocus: false }]);
    // Not asked for, it says so; an older APK says nothing of it.
    const old = fakes();
    const plain = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 3840, height: 2160 }, { plugin: old.plugin, channel: old.channel, settleMs: 0 });
    expect((await plain.ready).lineFocus).toBeUndefined();
    expect(old.opens[0]!.lineFocus).toBe(false);
    plain.close();
  });

  it("gives a card's cut what the camera said of its frame", async () => {
    const { plugin, channel } = fakes(DESCRIBED, { capture: 0x83 | (21 << 8) | (166 << 16) });
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 3840, height: 2160 }, { plugin, channel, settleMs: 0 });
    await cam.ready;
    const cut = await cam.around(quad, document.createElement("canvas"), 2400);
    expect(cut.capture).toEqual({ af: "passive-focused", line: true, focusCm: 21, exposureMs: 16.6 });
    cam.close();
  });
});

describe("exposureRange", () => {
  it("is the camera's range in EV only where it can be changed", () => {
    expect(exposureRange(EXPOSURE)).toEqual({ min: -2, max: 2, step: 1 / 6 });
    expect(exposureRange({ supported: false })).toBeNull();
    expect(exposureRange(undefined)).toBeNull();
    expect(exposureRange({ ...EXPOSURE, min: 0, max: 0 })).toBeNull();
    expect(exposureRange({ ...EXPOSURE, step: 0 })).toBeNull();
  });
});

describe("a binary reply", () => {
  it("carries the frame, its full size and what it cost", () => {
    const r = parseReply(reply({ id: 4, width: 2, height: 3, full: [2160, 3840], seq: 9, sentAt: 1000 }), 1006);
    expect(r.id).toBe(4);
    expect(r.frame).toMatchObject({ width: 2, height: 3, fullWidth: 2160, fullHeight: 3840, seq: 9, format: "rgba", convertMs: 3.5, waitMs: 12, transitMs: 6 });
    expect(r.frame!.data.byteLength).toBe(24);
  });
  it("says why there is no frame", () => {
    expect(parseReply(reply({ id: 2, error: "no-frame: The camera has no frame yet" }))).toEqual({ id: 2, error: "no-frame: The camera has no frame yet" });
    expect(parseReply(new ArrayBuffer(8)).error).toMatch(/cut short/);
  });
  it("refuses pixels that don't match their size, and takes a JPEG as it is", () => {
    const bad = reply({ id: 1, width: 2, height: 2 });
    new DataView(bad).setUint32(8, 3, true);
    expect(parseReply(bad).error).toMatch(/size/);
    expect(parseReply(reply({ id: 1, width: 640, height: 360, jpeg: new Uint8Array([0xff, 0xd8, 0xff]) })).frame).toMatchObject({ format: "jpeg", width: 640 });
  });
});

describe("the binary channel", () => {
  it("matches each reply to its request by id, in any order", async () => {
    const sent: (FrameRequest & { id: number })[] = [];
    const channel: FrameChannel = { onmessage: null, postMessage: (t) => void sent.push(JSON.parse(t) as FrameRequest & { id: number }) };
    const t = binaryTransport(channel);
    const a = t.request({ op: "frame", shortSide: 640 });
    const b = t.request({ op: "region", x: 0, y: 0, w: 1, h: 1 });
    expect(sent.map((q) => q.op)).toEqual(["frame", "region"]);
    channel.onmessage!({ data: reply({ id: sent[1]!.id, width: 1, height: 1 }) });
    channel.onmessage!({ data: reply({ id: sent[0]!.id, width: 2, height: 1 }) });
    expect((await a).width).toBe(2);
    expect((await b).width).toBe(1);
  });
  it("rejects with the camera's reason, gives up on a reply that never comes, and ends what's waiting when closed", async () => {
    const sent: { id: number }[] = [];
    const channel: FrameChannel = { onmessage: null, postMessage: (t) => void sent.push(JSON.parse(t) as { id: number }) };
    const t = binaryTransport(channel, 20);
    const refused = t.request({ op: "frame" });
    channel.onmessage!({ data: reply({ id: sent[0]!.id, error: "closed: The camera isn't open" }) });
    await expect(refused).rejects.toThrow("closed: The camera isn't open");
    await expect(t.request({ op: "frame" })).rejects.toThrow("didn't answer");
    const waiting = t.request({ op: "frame" });
    t.close();
    await expect(waiting).rejects.toThrow("closed");
    await expect(t.request({ op: "frame" })).rejects.toThrow("closed");
  });
});

describe("two transports on one channel", () => {
  it("leaves the newer one hearing when the older closes", async () => {
    const sent: { id: number }[] = [];
    const channel: FrameChannel = { onmessage: null, postMessage: (t) => void sent.push(JSON.parse(t) as { id: number }) };
    const older = binaryTransport(channel);
    const newer = binaryTransport(channel);
    older.close();
    const got = newer.request({ op: "frame" });
    channel.onmessage!({ data: reply({ id: sent[0]!.id, width: 1, height: 1 }) });
    expect((await got).width).toBe(1);
    newer.close();
    expect(channel.onmessage).toBeNull();
  });
});

describe("base64 frames", () => {
  it("decodes the pixels a plugin call returns", async () => {
    const f = await base64Transport(fakes().plugin).request({ op: "frame" });
    expect([...f.data]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    expect(f).toMatchObject({ width: 2, height: 1, fullWidth: 2160 });
  });
});

const quad: Quad = [
  [90, 160],
  [270, 160],
  [270, 480],
  [90, 480],
];

describe("the app's camera as a source", () => {
  it("opens, takes frames into the canvas and answers as the video would", async () => {
    const { plugin, channel, calls } = fakes();
    const el = document.createElement("canvas");
    const cam = openNativeCamera(el, { lens: "main", fps: 60, width: 3840, height: 2160 }, { plugin, channel, settleMs: 0 });
    // Nothing to read before the first frame.
    expect(cam.frame()).toBeNull();
    expect((el as unknown as HTMLVideoElement).videoWidth).toBe(0);
    const info = await cam.ready;
    expect(calls).toEqual(["open"]);
    expect(document.documentElement.classList.contains(NATIVE_CLASS)).toBe(true);
    const v = cam.frame()!;
    expect([v.videoWidth, v.videoHeight]).toEqual([360, 640]);
    expect((v as unknown as HTMLVideoElement).srcObject).toBeTruthy();
    // 2160 full-frame pixels across for 360 frame pixels.
    expect(cam.fullScale()).toBe(6);
    expect(info).toMatchObject({ source: "native", lens: "main", lensAsked: "main", width: 2160, height: 3840, fpsAsked: 60, fpsRange: [60, 60], frameWidth: 360, frameHeight: 640, transport: "binary", zoomRange: [0.5, 8], torch: true });
    expect(info.bridge).toMatchObject({ frames: 1, convert: 3.5, bytes: 360 * 640 * 4 });
    cam.close();
    // The page has its ground back at once; the camera is closed in its turn.
    expect(document.documentElement.classList.contains(NATIVE_CLASS)).toBe(false);
    expect(cam.frame()).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["open", "close"]);
    expect(cam.track()).toBeNull();
  });

  it("cuts a card from the full frame: the box as fractions, the quad in the cut's pixels", async () => {
    const { plugin, channel, requests } = fakes();
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 3840, height: 2160 }, { plugin, channel, settleMs: 0 });
    await cam.ready;
    const cut = await cam.around(quad, document.createElement("canvas"), 2400);
    const q = requests.find((r) => r.op === "region")!;
    // The quad's bounds and its 8% margin (25.6 of 320), in frame pixels: 64..296 by 134..506.
    expect(q).toMatchObject({ op: "region", maxSide: 2400 });
    expect(q.x).toBeCloseTo(64 / 360);
    expect(q.y).toBeCloseTo(134 / 640);
    expect(q.w).toBeCloseTo(232 / 360);
    expect(q.h).toBeCloseTo(372 / 640);
    // 372 frame pixels tall is 2232 of the full frame: under 2400, so it comes whole, six for one.
    expect(cut.image.height).toBe(2232);
    expect(cut.quad[0]![0]).toBeCloseTo((90 - 64) * 6, 0);
    expect(cut.quad[2]![1]).toBeCloseTo((480 - 134) * 6, 0);
    // A smaller limit scales the cut, and the quad with it.
    const small = await cam.around(quad, document.createElement("canvas"), 1200);
    expect(small.image.height).toBe(1200);
    expect(small.quad[2]![1]).toBeCloseTo(((480 - 134) * 1200) / 372, 0);
    cam.close();
    await expect(cam.around(quad, document.createElement("canvas"))).rejects.toThrow("no frame");
  });

  it("falls back to base64 frames where the web view has no binary channel", async () => {
    const { plugin } = fakes({ ...DESCRIBED, binary: false });
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 1920, height: 1080 }, { plugin, channel: null, settleMs: 0 });
    const info = await cam.ready;
    expect(info.transport).toBe("base64");
    expect([info.frameWidth, info.frameHeight]).toEqual([2, 1]);
    cam.close();
  });

  it("never reaches the camera when it is closed at once (a scanner mounted and unmounted)", async () => {
    const { plugin, channel, calls } = fakes();
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 1920, height: 1080 }, { plugin, channel, settleMs: 0 });
    cam.close();
    await expect(cam.ready).rejects.toThrow("closed");
    expect(calls).toEqual([]);
    expect(document.documentElement.classList.contains(NATIVE_CLASS)).toBe(false);
  });

  it("closes a camera closed while it was opening, before the next one opens", async () => {
    const { plugin, channel, calls } = fakes();
    let opening!: () => void;
    const slow = new Promise<void>((r) => (opening = r));
    const open = plugin.open;
    plugin.open = async (o) => {
      const d = await open(o);
      if (calls.length === 1) await slow;
      return d;
    };
    const first = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 1920, height: 1080 }, { plugin, channel, settleMs: 0 });
    await new Promise((r) => setTimeout(r, 5));
    first.close();
    const second = openNativeCamera(document.createElement("canvas"), { lens: "main", fps: 30, width: 1920, height: 1080 }, { plugin, channel, settleMs: 0 });
    opening();
    await expect(first.ready).rejects.toThrow("closed");
    await second.ready;
    // The first camera's close lands before the second's open, never after it.
    expect(calls).toEqual(["open", "close", "open"]);
    expect(document.documentElement.classList.contains(NATIVE_CLASS)).toBe(true);
    second.close();
  });

  it("passes on the reason the camera wouldn't open", async () => {
    const { plugin, channel } = fakes();
    plugin.open = async () => {
      throw new Error("The camera isn't allowed.");
    };
    await expect(openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 1920, height: 1080 }, { plugin, channel, settleMs: 0 }).ready).rejects.toThrow("isn't allowed");
  });

  it("releases a bound camera that sends no frames before allowing browser fallback", async () => {
    vi.useFakeTimers();
    try {
      const { plugin } = fakes({ ...DESCRIBED, binary: false });
      plugin.frame = vi.fn().mockRejectedValue(new Error("No frame"));
      let release!: () => void;
      const closed = new Promise<void>((resolve) => { release = resolve; });
      const close = vi.spyOn(plugin, "close").mockReturnValue(closed);
      const cam = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 1920, height: 1080 }, { plugin, channel: null, settleMs: 0 });
      const fallback = vi.fn();
      void cam.ready.catch(fallback);
      await vi.advanceTimersByTimeAsync(3100);
      expect(close).toHaveBeenCalledOnce();
      expect(fallback).not.toHaveBeenCalled();
      release();
      await expect(cam.ready).rejects.toThrow("didn't deliver a frame");
      expect(fallback).toHaveBeenCalledOnce();
      expect(document.documentElement.classList.contains(NATIVE_CLASS)).toBe(false);
      cam.close();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("learns the capture rate delivered a moment after opening", async () => {
    vi.useFakeTimers();
    try {
      const { plugin, channel } = fakes();
      const told: (number | undefined)[] = [];
      const cam = openNativeCamera(document.createElement("canvas"), { lens: "main", fps: 60, width: 3840, height: 2160 }, { plugin, channel, settleMs: 0, onInfo: (i) => told.push(i.frameRate) });
      await vi.advanceTimersByTimeAsync(50);
      // Not known until the camera has run: the rate asked for is never passed off as delivered.
      expect((await cam.ready).frameRate).toBeUndefined();
      await vi.advanceTimersByTimeAsync(3000);
      expect(told).toEqual([58.9]);
      cam.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the app's camera's controls, as a track", () => {
  async function opened(req: { torchLevel?: number | null; exposure?: number | null } = {}, described: NativeDescribed = DESCRIBED) {
    const f = fakes(described);
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "main", fps: 30, width: 3840, height: 2160, ...req }, { plugin: f.plugin, channel: f.channel, settleMs: 0 });
    await cam.ready;
    return { cam, track: cam.track()!, ...f };
  }
  const apply = (t: MediaStreamTrack, all: Record<string, unknown>) => t.applyConstraints({ advanced: [all as MediaTrackConstraintSet] });

  it("says what the camera can do in a browser's words", async () => {
    const { cam, track } = await opened();
    expect(track.getCapabilities()).toMatchObject({ zoom: { min: 0.5, max: 8 }, torch: true, focusMode: ["continuous", "manual"], focusDistance: { min: 0.08, max: 4 } });
    expect(track.getSettings()).toMatchObject({ width: 2160, height: 3840, frameRate: 60, zoom: 1, facingMode: "environment" });
    expect(track.label).toBe("App camera, Main");
    cam.close();
  });

  it("sends only what changed, however often camera.tsx repeats the rest", async () => {
    const { cam, track, sets } = await opened();
    await apply(track, { focusMode: "continuous" });
    await apply(track, { focusMode: "continuous", zoom: 2 });
    await apply(track, { focusMode: "continuous", zoom: 2, torch: true });
    await apply(track, { focusMode: "continuous", zoom: 2, torch: true, pointsOfInterest: [{ x: 0.3, y: 0.9 }] });
    await apply(track, { focusMode: "continuous", zoom: 3, torch: true, pointsOfInterest: [{ x: 0.3, y: 0.9 }] });
    expect(sets).toEqual([{ focusMode: "continuous" }, { zoom: 2 }, { torch: true }, { point: { x: 0.3, y: 0.9 } }, { zoom: 3 }]);
    expect(track.getSettings()).toMatchObject({ zoom: 3, torch: true });
    cam.close();
  });

  it("asks again for a setting the camera refused", async () => {
    const { cam, track, sets, plugin } = await opened();
    const set = plugin.set;
    let refuse = true;
    plugin.set = async (o) => {
      if (refuse) throw new Error("The camera refused that setting");
      return set(o);
    };
    await expect(apply(track, { torch: true })).rejects.toThrow("refused");
    refuse = false;
    // The same tap again reaches the camera: the refusal wasn't remembered as sent.
    await apply(track, { torch: true });
    expect(sets).toEqual([{ torch: true }]);
    expect(track.getSettings()).toMatchObject({ torch: true });
    cam.close();
  });

  it("sends everything again after the app has been away", async () => {
    const { cam, track, sets } = await opened();
    await apply(track, { zoom: 2, torch: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await apply(track, { zoom: 2, torch: true });
    expect(sets).toEqual([{ zoom: 2, torch: true }, { zoom: 2, torch: true }]);
    cam.close();
  });

  it("lights the flashlight at the strength chosen in Scan settings", async () => {
    const { cam, track, sets } = await opened({ torchLevel: 2 });
    await apply(track, { torch: true });
    expect(sets).toEqual([{ torch: true, torchLevel: 2 }]);
    await cam.setTorchLevel(4);
    expect(sets[1]).toEqual({ torch: true, torchLevel: 4 });
    cam.close();
  });

  it("takes a browser's exposureCompensation, in EV, and says the camera's range and where it is (23 Nov 2026)", async () => {
    const { cam, track, sets } = await opened({}, { ...DESCRIBED, exposure: EXPOSURE });
    expect(track.getCapabilities()).toMatchObject({ exposureCompensation: { min: -2, max: 2, step: 1 / 6 } });
    expect(track.getSettings()).toMatchObject({ exposureCompensation: 0 });
    await apply(track, { focusMode: "continuous", exposureCompensation: -0.5 });
    // Repeated with the rest, it isn't sent again.
    await apply(track, { focusMode: "continuous", exposureCompensation: -0.5, torch: true });
    await apply(track, { focusMode: "continuous", exposureCompensation: -9, torch: true });
    expect(sets).toEqual([{ focusMode: "continuous", exposure: -0.5 }, { torch: true }, { exposure: -9 }]);
    // The camera keeps to its range, and says where it is.
    expect(track.getSettings()).toMatchObject({ exposureCompensation: -2 });
    // Away and back, it's sent again with everything else.
    document.dispatchEvent(new Event("visibilitychange"));
    await apply(track, { focusMode: "continuous", exposureCompensation: -9, torch: true });
    expect(sets[3]).toEqual({ focusMode: "continuous", exposure: -9, torch: true });
    cam.close();
  });

  it("refuses an exposure loudly where the camera can't change it, sending nothing else either", async () => {
    // An APK from before exposure says nothing of it, and would take the call and ignore it.
    const { cam, track, sets } = await opened();
    expect(track.getCapabilities()).not.toHaveProperty("exposureCompensation");
    expect(track.getSettings()).not.toHaveProperty("exposureCompensation");
    await expect(apply(track, { torch: true, exposureCompensation: -1 })).rejects.toThrow("exposure can't be changed");
    expect(sets).toEqual([]);
    expect(await cam.setExposure(-1)).toBe(false);
    cam.close();
  });

  it("opens at the exposure saved on this device, before anyone reads the camera's settings", async () => {
    saveNativeCamera({ on: true, lens: "main", fps: 30, torchLevel: null, exposure: -0.7, lineFocus: true });
    const { cam, track, sets } = await opened({}, { ...DESCRIBED, exposure: EXPOSURE });
    expect(sets).toEqual([{ exposure: -0.7 }]);
    // The nearest sixth of a stop.
    expect(track.getSettings()).toMatchObject({ exposureCompensation: -4 / 6 });
    cam.close();
    // Asked for by the opener, that one; 0 sets nothing; a camera that can't sets nothing.
    const asked = await opened({ exposure: 1 }, { ...DESCRIBED, exposure: EXPOSURE });
    expect(asked.sets).toEqual([{ exposure: 1 }]);
    asked.cam.close();
    const none = await opened({ exposure: 0 }, { ...DESCRIBED, exposure: EXPOSURE });
    expect(none.sets).toEqual([]);
    none.cam.close();
    const cannot = await opened();
    expect(cannot.sets).toEqual([]);
    cannot.cam.close();
  });

  it("opens all the same when the camera refuses the saved exposure", async () => {
    saveNativeCamera({ on: true, lens: "main", fps: 30, torchLevel: null, exposure: -1, lineFocus: true });
    const f = fakes({ ...DESCRIBED, exposure: EXPOSURE });
    f.plugin.set = async () => {
      throw new Error("The camera refused that setting");
    };
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "main", fps: 30, width: 3840, height: 2160 }, { plugin: f.plugin, channel: f.channel, settleMs: 0 });
    await expect(cam.ready).resolves.toMatchObject({ source: "native" });
    expect(cam.track()!.getSettings()).toMatchObject({ exposureCompensation: 0 });
    cam.close();
  });

  it("sets the exposure from Scan settings through the camera controls holding it, else straight to the camera", async () => {
    const { cam, track, sets } = await opened({}, { ...DESCRIBED, exposure: EXPOSURE });
    expect(await cam.setExposure(-1)).toBe(true);
    expect(sets).toEqual([{ exposure: -1 }]);
    // camera.tsx lends its setter while it controls this camera (ExposureBound), and takes it back.
    const lent: number[] = [];
    (track as unknown as { bindExposure: (f: ((ev: number) => Promise<boolean>) | null) => void }).bindExposure(async (ev) => (lent.push(ev), true));
    expect(await cam.setExposure(-0.5)).toBe(true);
    expect(lent).toEqual([-0.5]);
    expect(sets).toHaveLength(1);
    (track as unknown as { bindExposure: (f: null) => void }).bindExposure(null);
    expect(await cam.setExposure(0)).toBe(true);
    expect(sets[1]).toEqual({ exposure: 0 });
    cam.close();
    expect(await cam.setExposure(-1)).toBe(false);
  });

  it("never sets the exposure from Scan settings while the camera opens: it waits, then goes through the controls (Codex review of #210)", async () => {
    saveNativeCamera({ on: true, lens: "main", fps: 30, torchLevel: null, exposure: -1, lineFocus: true });
    const f = fakes({ ...DESCRIBED, exposure: EXPOSURE });
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "main", fps: 30, width: 3840, height: 2160 }, { plugin: f.plugin, channel: f.channel, settleMs: 0 });
    // The scanner attaches the camera once it's ready, and lends its setter (camera.tsx).
    const lent: number[] = [];
    void cam.ready.then(() => (cam.track() as unknown as { bindExposure: (s: (ev: number) => Promise<boolean>) => void }).bindExposure(async (ev) => (lent.push(ev), true)));
    // Moved before the camera was ready.
    const took = cam.setExposure(0.5);
    await cam.ready;
    expect(await took).toBe(true);
    // The opening's own exposure went to the camera alone; the slider's through the controls.
    expect(f.sets).toEqual([{ exposure: -1 }]);
    expect(lent).toEqual([0.5]);
    // Its caller gone by the time the camera is ready: nothing is sent.
    expect(await cam.setExposure(1, () => true)).toBe(false);
    expect(lent).toEqual([0.5]);
    expect(f.sets).toHaveLength(1);
    cam.close();
  });

  it("holds the focus where the camera view's slider puts it, and hands it back", async () => {
    const { cam, track, sets } = await opened();
    // camera.tsx's focus control: a distance in metres, then autofocus again (cameraFocus.ts).
    await apply(track, { focusMode: "manual", focusDistance: 0.2, zoom: 1 });
    await apply(track, { focusMode: "manual", focusDistance: 0.12, zoom: 1 });
    await apply(track, { focusMode: "continuous", focusDistance: undefined, zoom: 1 });
    expect(sets).toEqual([{ focusMode: "manual", focusDistance: 0.2, zoom: 1 }, { focusMode: "manual", focusDistance: 0.12 }, { focusMode: "continuous" }]);
    cam.close();
  });
});

describe("timing the bridge", () => {
  it("times each way a frame can cross, and a card's cut", async () => {
    vi.stubGlobal("createImageBitmap", async () => ({ close: () => undefined }));
    const { plugin, channel } = fakes();
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 3840, height: 2160 }, { plugin, channel, settleMs: 0 });
    await cam.ready;
    const rows = await cam.bench(2);
    expect(rows.map((r) => r.what)).toEqual(["ArrayBuffer, RGBA", "ArrayBuffer, JPEG", "base64, RGBA", "base64, JPEG", "ArrayBuffer, RGBA, a card at 1200", "ArrayBuffer, RGBA, a card at 2400"]);
    expect(rows[0]).toMatchObject({ size: "360×640", frames: 2, bytes: 360 * 640 * 4, convert: 3.5 });
    cam.close();
  });
  it("writes a row for people", () => {
    expect(benchLine({ what: "ArrayBuffer, RGBA", size: "1138×640", frames: 15, bytes: 2_913_280, convert: 3.1, transit: 1.2, draw: 2.1, total: 6.4 })).toBe("ArrayBuffer, RGBA: 1138×640, 2.9 MB, 6.4 ms a frame (convert 3.1, crossing 1.2, drawing 2.1)");
    expect(benchLine({ what: "ArrayBuffer, JPEG", size: "1138×640", frames: 15, bytes: 81_400, convert: 9, transit: 0.4, draw: 5, total: 14.4 })).toContain("81 kB");
  });
});
