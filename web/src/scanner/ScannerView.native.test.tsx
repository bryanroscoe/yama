// @vitest-environment jsdom
// The card finder in the app's own code, in the scanner's live loop (nativeModels.ts, ScannerView.tsx),
// with the app's camera and the recognizer faked: each frame comes with the corners the app's finder
// placed on it, and the art is matched there (`matchAt`), so the web view's finder never runs; a
// failure hands the finding back to the web view for the rest of the session; turned off, nothing
// runs in the app; and the timing record names what ran.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtRecognizer, BundleInfo } from "./artClient";
import type { Handed } from "./recognizer";
import type { Quad } from "./types";

const V = "gallery-20261106T183001884398Z";
const bundle = (): BundleInfo => ({
  version: V,
  ready: true,
  error: null,
  files: { detector: `/scan-bundle/${V}/detector.onnx`, embed: `/scan-bundle/${V}/embed.onnx`, search: "s", arts: "a" },
  bytes: { detector: 1, embed: 1, search: 1, arts: 1 },
  constants: { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63 },
  models: {
    detector: { default: "bundle-detector", options: [{ id: "bundle-detector", label: "ManaVault's card finder", note: "", file: `/scan-bundle/${V}/detector.onnx`, bytes: 1 }] },
    art: { default: "bundle", options: [{ id: "bundle", label: "ManaVault's art model", note: "", file: `/scan-bundle/${V}/embed.onnx`, bytes: 1 }] },
    look: { default: "off", options: [{ id: "off", label: "Off", note: "" }] },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }] },
    lock: { default: "lead", options: [{ id: "lead", label: "Art that leads", note: "" }] },
  },
});

const sent = vi.hoisted(() => ({ timings: [] as Record<string, unknown>[] }));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, opts?: { json?: Record<string, unknown> }) => {
    if (path.startsWith("/api/scan/bundle")) return Promise.resolve(bundle());
    if (path === "/api/scan/diagnostics/timings") {
      sent.timings.push(opts?.json ?? {});
      return Promise.resolve({ id: "t" });
    }
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));

const quadAt = (x: number): Quad => [[x, 100], [x + 300, 100], [x + 300, 520], [x, 520]];

/** What the faked app finder says of each frame, and what was asked of it and of the recognizer. */
const nat = vi.hoisted(() => ({
  state: 1,
  loads: 0,
  failLoad: false,
  on: false,
  sets: [] as { on?: boolean; outline?: boolean }[],
  matched: [] as { handed: Handed; turn?: boolean }[],
  identified: 0,
  /** Each frame read, in order: by the web view's finder ("web") or at the app's corners ("app"). */
  order: [] as string[],
  score: 0.93,
}));

vi.mock("./nativeCamera", async (original) => {
  const real = await original<typeof import("./nativeCamera")>();
  return {
    ...real,
    nativeCameraAvailable: () => true,
    savedNativeCamera: () => ({ on: true, lens: "auto", fps: 30, torchLevel: null }),
    nativeFinderAbility: async () => ({ finder: true }),
    loadNativeFinder: async () => {
      nat.loads += 1;
      if (nat.failLoad) throw new Error("the model wouldn't load");
      return { loadMs: 5, sent: false };
    },
    unloadNativeFinder: async () => undefined,
    openNativeCamera: (el: HTMLCanvasElement) => {
      Object.defineProperty(el, "videoWidth", { configurable: true, get: () => 640 });
      Object.defineProperty(el, "videoHeight", { configurable: true, get: () => 1138 });
      const info = { source: "native" as const, width: 2160, height: 3840 };
      return {
        kind: "native" as const,
        ready: Promise.resolve(info),
        frame: () => el,
        fullScale: () => 3.375,
        around: async (quad: Quad) => ({ image: { width: 4, height: 4, data: new Uint8ClampedArray(64) }, quad }),
        region: async () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64) }),
        track: () => null,
        info: () => info,
        described: () => null,
        setTorchLevel: async () => undefined,
        bench: async () => [],
        found: () => (nat.on ? { state: nat.state, quad: nat.state === real.FOUND_CARD ? quadAt(100) : null, vote: 1, ms: 8, passes: 1, ageMs: 3 } : null),
        setFinder: async (o: { on?: boolean; outline?: boolean }) => {
          nat.sets.push(o);
          if (o.on !== undefined) nat.on = o.on;
          return { loaded: true, on: nat.on, ...(nat.state === real.FOUND_FAILED ? { failed: "The app's card finder stopped: out of memory" } : {}) };
        },
        finderStatus: () => ({ loaded: true, on: nat.on, ms: 8, fps: 30, ...(nat.state === real.FOUND_FAILED ? { failed: "The app's card finder stopped: out of memory" } : {}) }),
        close: () => undefined,
      };
    },
  };
});

vi.mock("./artClient", async (original) => ({
  ...(await original<typeof import("./artClient")>()),
  loadArtRecognizer: async () => {
    const match = (quad: Quad | null) => ({
      quad,
      upright: 1,
      matches: quad ? [{ index: 4, id: "p1", name: "Arcane Signet", set: "eoc", number: "101", illustrationId: "ill-signet", layout: "normal", printings: 1, score: nat.score }] : [],
      timings: { detectMs: 1, embedMs: 1, totalMs: 2 },
    });
    const r: ArtRecognizer = {
      embed: `${V}/embed.onnx`,
      art: "bundle",
      useArt: async () => undefined,
      detector: "bundle-detector",
      useDetector: async () => undefined,
      look: "off",
      useLook: async () => undefined,
      lookAt: async () => ({ model: "none", frames: 0, queryMs: 0, scored: 0, cached: 0, fetchMs: 0, decodeMs: 0, embedMs: 0, ms: 0 }),
      identify: async (_image, onSeen) => {
        nat.identified += 1;
        nat.order.push("web");
        onSeen?.(quadAt(100));
        return match(quadAt(100));
      },
      matchAt: async (_image, handed, opts) => {
        nat.matched.push({ handed, turn: opts?.turn });
        nat.order.push("app");
        return match(handed.quad);
      },
      locate: async () => {
        throw new Error("no placement gate here");
      },
      reset: () => undefined,
      setPool: async () => -1,
      dispose: () => undefined,
    };
    return r;
  },
}));
vi.mock("./serverCatalog", () => ({ createServerCatalog: async () => ({ hasSet: () => false, lookup: async () => null, names: () => [] }) }));
vi.mock("./ocrEngine", async (original) => ({
  ...(await original<typeof import("./ocrEngine")>()),
  createScannerOcr: async () => ({ engine: "tesseract", read: async () => ({ text: "", confidence: 0 }), terminate: async () => undefined }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => undefined;
vi.stubGlobal("Worker", class {});
vi.stubGlobal(
  "ImageData",
  class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  },
);
HTMLCanvasElement.prototype.getContext = function () {
  return {
    drawImage: () => undefined,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: () => undefined,
  } as unknown as CanvasRenderingContext2D;
} as unknown as typeof HTMLCanvasElement.prototype.getContext;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

const { ScannerView } = await import("./ScannerView");

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.assign(nat, { state: 1, loads: 0, failLoad: false, on: false, sets: [], matched: [], identified: 0, order: [], score: 0.93 });
  sent.timings = [];
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until<T>(get: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const v = get();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`never saw ${what}`);
}

describe("the card finder in the app's own code", () => {
  it("hands each frame's corners in: the art is matched there and the web view's finder never runs", async () => {
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 3 ? true : null), "three frames matched at the app's corners");
    // A frame read before the app's finder had loaded is the web view's; none after.
    expect(nat.order.slice(nat.order.indexOf("app"))).not.toContain("web");
    expect(nat.loads).toBe(1);
    // The corners as found (the recognizer's frame is the whole canvas here), read upside down when doubtful.
    expect(nat.matched[0]).toEqual({ handed: { quad: quadAt(100), upright: 1 }, turn: true });
    // It runs, and draws the outline, while the scanner reads.
    expect(nat.sets).toContainEqual(expect.objectContaining({ on: true, outline: true }));
  });

  it("gives the finding back to the web view for the session when it fails", async () => {
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 2 ? true : null), "frames matched at the app's corners");
    nat.state = 3;
    await until(() => (nat.identified >= 3 ? true : null), "the web view's finder running");
    const matched = nat.matched.length;
    await wait(200);
    expect(nat.matched.length).toBe(matched);
    expect(nat.loads).toBe(1);
  });

  it("falls back as soon as it doesn't load", async () => {
    nat.score = 0.2;
    nat.failLoad = true;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.identified >= 3 ? true : null), "the web view's finder running");
    expect(nat.matched).toEqual([]);
    expect(nat.sets.filter((s) => s.on)).toEqual([]);
  });

  it("turned off on this device, runs nothing in the app", async () => {
    nat.score = 0.2;
    localStorage.setItem("yama.scan.native", JSON.stringify({ detector: false }));
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.identified >= 3 ? true : null), "the web view's finder running");
    expect(nat.loads).toBe(0);
    expect(nat.matched).toEqual([]);
  });

  it("names what found the card in the timing record", async () => {
    localStorage.setItem("yama.scan.diagnostics", "1");
    // Not until the app's finder runs, so the card is named from its corners.
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly autoAdd closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 1 ? true : null), "a frame matched at the app's corners");
    nat.score = 0.93;
    // Filed by itself (Keep going), its timing record goes.
    await until(() => (sent.timings.length > 0 ? true : null), "a timing record");
    const t = sent.timings[0]!;
    expect((t.models as Record<string, string>).detector).toBe("bundle-detector-native");
    expect((t.detail as Record<string, unknown>).finder_ms).toBe(8);
  });
});
