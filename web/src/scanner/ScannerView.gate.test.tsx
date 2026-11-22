// @vitest-environment jsdom
// The placement gate in the scanner's live loop (gate.ts, ScannerView.tsx), with the camera and the
// recognizer faked: with the lock option "lead-gate" chosen, every frame goes to the card finder
// alone, the art is matched only once the card has come to rest, and once; without it, every frame
// is matched as before.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtRecognizer, BundleInfo } from "./artClient";
import { THUMB_SIDE } from "./gate";
import type { Quad, RgbaImage } from "./types";

const V = "gallery-20261106T183001884398Z";
const bundle = (): BundleInfo => ({
  version: V,
  ready: true,
  error: null,
  files: { detector: "d", embed: `/scan-bundle/${V}/embed.onnx`, search: "s", arts: "a" },
  bytes: { detector: 1, embed: 1, search: 1, arts: 1 },
  constants: { scene: 640 },
  models: {
    art: { default: "bundle", options: [{ id: "bundle", label: "ManaVault's art model", note: "", file: `/scan-bundle/${V}/embed.onnx`, bytes: 1 }] },
    look: { default: "off", options: [{ id: "off", label: "Off", note: "" }] },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }] },
    lock: {
      default: "lead",
      options: [
        { id: "lead", label: "Art that leads", note: "" },
        { id: "lead-gate", label: "Art that leads, read when the card is still", note: "" },
      ],
    },
  },
});

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string) => {
    if (path.startsWith("/api/scan/bundle")) return Promise.resolve(bundle());
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));

/** The faked card finder and art match: where the card is on each pass, and what was asked. */
const cam = vi.hoisted(() => ({ x: 100 as number | null, step: 0, located: 0, identified: [] as (unknown | undefined)[], score: 0.93, others: 0 }));
const quadAt = (x: number): Quad => [[x, 100], [x + 300, 100], [x + 300, 520], [x, 520]];
vi.mock("./artClient", async (original) => ({
  ...(await original<typeof import("./artClient")>()),
  loadArtRecognizer: async () => {
    const match = (quad: Quad | null) => ({
      quad,
      upright: 1,
      // The card, then `others` other cards the search listed below it, at 0.45.
      matches: quad
        ? [
            { index: 4, id: "p1", name: "Arcane Signet", set: "eoc", number: "101", illustrationId: "ill-signet", layout: "normal", printings: 1, score: cam.score },
            ...Array.from({ length: cam.others }, (_, i) => ({ index: 10 + i, id: `o${i}`, name: `Other card ${i}`, set: "fdn", number: String(i), illustrationId: `ill-${i}`, layout: "normal", printings: 1, score: 0.45 })),
          ]
        : [],
      timings: { detectMs: 1, embedMs: 1, totalMs: 2 },
    });
    const here = () => {
      if (cam.x == null) return null;
      cam.x += cam.step;
      return quadAt(cam.x);
    };
    const r: ArtRecognizer = {
      embed: `${V}/embed.onnx`,
      art: "bundle",
      useArt: async () => undefined,
      detector: "bundle-detector",
      useDetector: async () => undefined,
      look: "off",
      useLook: async () => undefined,
      lookAt: async () => ({ model: "none", frames: 0, queryMs: 0, scored: 0, cached: 0, fetchMs: 0, decodeMs: 0, embedMs: 0, ms: 0 }),
      identify: async (_image, onSeen, at) => {
        cam.identified.push(at);
        const quad = at ?? here();
        onSeen?.(quad);
        return match(quad);
      },
      locate: async (image: RgbaImage) => {
        cam.located += 1;
        const quad = here();
        return quad ? { quad, upright: 1, sharpness: 50, thumb: new Uint8Array(THUMB_SIDE * THUMB_SIDE).map((_, i) => (i * 37) % 251), detectMs: 1, image } : { quad: null, upright: 0, detectMs: 1, image };
      },
      matchAt: async () => {
        throw new Error("no app finder here");
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
// A camera that is always delivering a 1280 × 720 picture.
Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1280 });
Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 720 });
Object.defineProperty(HTMLVideoElement.prototype, "readyState", { configurable: true, get: () => 4 });
Object.defineProperty(HTMLVideoElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
HTMLVideoElement.prototype.play = async () => undefined;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

const { ScannerView } = await import("./ScannerView");

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  const track = { stop: () => undefined, getSettings: () => ({ deviceId: "x", width: 1280, height: 720 }), getCapabilities: () => ({}), applyConstraints: async () => undefined, label: "fake" };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => stream, enumerateDevices: async () => [] } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.assign(cam, { x: 100, step: 0, located: 0, identified: [], score: 0.93, others: 0 });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "mediaDevices");
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
const chip = () => document.querySelector(".scan-chip")?.textContent ?? "";
const foundName = () => document.querySelector(".scan-info h3")?.textContent ?? "";

describe("the placement gate in the live scanner", () => {
  it("without the option matches the art on every frame, and never runs the finder alone", async () => {
    cam.score = 0.2;
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (cam.identified.length >= 3 ? true : null), "three frames matched");
    expect(cam.located).toBe(0);
    expect(cam.identified.every((at) => at === undefined)).toBe(true);
  });

  it("with it, matches nothing while the card moves, and says to hold it still", async () => {
    localStorage.setItem("yama.scan.models", JSON.stringify({ lock: "lead-gate" }));
    cam.step = 40;
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (cam.located >= 8 ? true : null), "eight passes of the finder");
    expect(cam.identified).toEqual([]);
    expect(chip()).toContain("Hold the card still");
  });

  it("with it, matches the art once the card rests, on the frame and corners the finder gave, and finds the card", async () => {
    localStorage.setItem("yama.scan.models", JSON.stringify({ lock: "lead-gate" }));
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    expect(cam.identified).toEqual([quadAt(100)]);
    // The finder ran alone several times first: at least the 100 ms it takes to call a card still.
    expect(cam.located).toBeGreaterThanOrEqual(3);
    // And however long the card lies there, it isn't matched again.
    await wait(500);
    expect(cam.identified).toHaveLength(1);
  });

  it("with it, a card whose art only leads still settles on its second read in a row, as without it", async () => {
    localStorage.setItem("yama.scan.models", JSON.stringify({ lock: "lead-gate" }));
    Object.assign(cam, { score: 0.72, others: 4 });
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    expect(cam.identified).toHaveLength(2);
  });

  it("with it, a fair match whose title can't be read still waits its four reads, as without it", async () => {
    localStorage.setItem("yama.scan.models", JSON.stringify({ lock: "lead-gate" }));
    // Nothing else listed, so nothing to lead: the title is read each time, and reads nothing.
    cam.score = 0.72;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    expect(cam.identified).toHaveLength(4);
  });

  it("with it, gives up after five tries on a card it can't name, and says to move it", async () => {
    localStorage.setItem("yama.scan.models", JSON.stringify({ lock: "lead-gate" }));
    cam.score = 0.2;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (chip().includes("No match, move the card") ? true : null), "No match");
    expect(cam.identified).toHaveLength(5);
    const passes = cam.located;
    await wait(200);
    // Still looking for the card to move, and matching nothing more.
    expect(cam.located).toBeGreaterThan(passes);
    expect(cam.identified).toHaveLength(5);
    expect(foundName()).toBe("");
  });
});
