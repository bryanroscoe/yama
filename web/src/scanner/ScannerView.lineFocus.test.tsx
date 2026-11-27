// @vitest-environment jsdom
// The app's camera focuses on the held card's collector line (Bryan, 27 Nov 2026: the bottom left
// corner "always looks a little fuzzy"; LineFocus.java). Its card finder rests while the card's
// sheet is open, so the hold tells the camera where the card is (Codex review of #218: without it
// the focus region lapsed just when the held card's frames were read). The camera and the
// recognizer are faked as in ScannerView.sharp.test.tsx, with the app's camera in place of the
// browser's.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ArtRecognizer, BundleInfo } from "./artClient";
import type { Provisional } from "./later";
import { saveModel } from "./models";
import type { Quad, ScanCandidate } from "./types";

const V = "gallery-20261106T183001884398Z";
const printing = (id: string, set: string, number: string): Printing => ({
  scryfall_id: id, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: number, lang: "en",
  rarity: "common", finishes: ["nonfoil"], released_at: "2024-01-01", image_normal: `https://cards.scryfall.io/normal/front/${id}.jpg`, image_small: null, back_image_normal: null, artist: null,
  price_date: "2026-11-20", usd: 1, usd_foil: null, usd_etched: null, eur: null, eur_foil: null,
});
const bundle = (): BundleInfo => ({
  version: V,
  ready: true,
  error: null,
  files: { detector: "d", embed: `/scan-bundle/${V}/embed.onnx`, search: "s", arts: "a" },
  bytes: { detector: 1, embed: 1, search: 1, arts: 1 },
  constants: { scene: 640 },
  models: {
    art: { default: "bundle", options: [{ id: "bundle", label: "ManaVault's art model", note: "", file: `/scan-bundle/${V}/embed.onnx`, bytes: 1 }] },
    look: {
      default: "off",
      options: [
        { id: "off", label: "Off", note: "" },
        { id: "look-v1-sure", label: "Yama's look model v1, settles when sure", note: "", file: `/scan-bundle/${V}/look-1.onnx`, bytes: 9, settles: true },
      ],
    },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }] },
    lock: { default: "lead", options: [{ id: "lead", label: "Art that leads", note: "" }] },
  },
});

/** What lies in view: the card found first, another card, or nothing. */
const cam = vi.hoisted(() => ({ card: "signet" as "signet" | "weak" | "lookalike" | "titled" | "other" | "none", printings: 3, ill: 0, title: "", line: "C 0145\nWOC • EN", collectorReads: 0 }));
/** The printing look: the option loaded, each printing's score, and the looks asked for. */
const look = vi.hoisted(() => ({ loaded: "off", scores: {} as Record<string, number>, asked: 0 }));
/** Whether a strip is sharp enough to read (quality.ts): the canvas here draws nothing, so it's said here. */
const quality = vi.hoisted(() => ({ sharp: false }));
vi.mock("./quality", async (original) => ({ ...(await original<typeof import("./quality")>()), worthReading: () => quality.sharp }));

/** The app's camera, faked: whether it was asked to focus on the line as it opened, and each held card's corners it was told, with their frame's size. */
const native = vi.hoisted(() => ({ opened: [] as (boolean | undefined)[], follows: [] as Quad[], sizes: [] as [number, number][] }));
vi.mock("./nativeCamera", async (original) => {
  const real = await original<typeof import("./nativeCamera")>();
  return {
    ...real,
    nativeCameraAvailable: () => true,
    savedNativeCamera: () => ({ on: true, lens: "auto", fps: 30, torchLevel: null, exposure: 0, lineFocus: true }),
    nativeFinderAbility: async () => ({ finder: false, reason: "not in this test" }),
    openNativeCamera: (el: HTMLCanvasElement, req: { lineFocus?: boolean }) => {
      Object.defineProperty(el, "videoWidth", { configurable: true, get: () => 640 });
      Object.defineProperty(el, "videoHeight", { configurable: true, get: () => 1138 });
      native.opened.push(req.lineFocus);
      const info = { source: "native" as const, width: 2160, height: 3840 };
      return {
        kind: "native" as const,
        ready: Promise.resolve(info),
        frame: () => el,
        fullScale: () => 3.375,
        around: async (quad: Quad) => ({ image: { width: 4, height: 4, data: new Uint8ClampedArray(64) }, quad, capture: { af: "passive-focused" as const, line: true, lineAsked: true, focusCm: 19, exposureMs: 16.6 } }),
        region: async () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64) }),
        track: () => null,
        info: () => info,
        described: () => ({ lineFocus: { asked: !!req.lineFocus, on: !!req.lineFocus, moves: 1 } }),
        setTorchLevel: async () => undefined,
        setLineFocus: async () => undefined,
        followLine: (quad: Quad, w: number, h: number) => {
          native.follows.push(quad);
          native.sizes.push([w, h]);
        },
        bench: async () => [],
        found: () => null,
        setFinder: async () => ({ loaded: false, on: false }),
        finderStatus: () => null,
        close: () => undefined,
      };
    },
  };
});

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string) => {
    if (path.startsWith("/api/scan/bundle")) return Promise.resolve(bundle());
    if (path.startsWith("/api/scan/printings")) return Promise.resolve({ same_art: true, printings: [printing("p1", "eoc", "101"), printing("p2", "woc", "145"), printing("p3", "c19", "236")].slice(0, cam.printings) });
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));

// A card near enough for its collector line to be read (closer.ts: over 1,563 px tall in a 4K
// picture), not so near it's cut off: 2,180 px of 3,840, given in the recognizer's 640 × 1138 frame.
const QUAD: Quad = [[89, 267], [551, 267], [551, 913], [89, 913]];
vi.mock("./artClient", async (original) => ({
  ...(await original<typeof import("./artClient")>()),
  loadArtRecognizer: async () => {
    // Its artwork is new in each test: printings.ts keeps an artwork's printings for the session.
    const signet = () => ({ index: 4, id: "p1", name: "Arcane Signet", set: "eoc", number: "101", illustrationId: `ill-signet-${cam.ill}`, layout: "normal", printings: 3 });
    const other = { index: 9, id: "q1", name: "Stridehangar Automaton", set: "drc", number: "19", illustrationId: "ill-other", layout: "normal", printings: 2 };
    const r: ArtRecognizer = {
      embed: `${V}/embed.onnx`,
      art: "bundle",
      useArt: async () => undefined,
      detector: "bundle-detector",
      useDetector: async () => undefined,
      get look() {
        return look.loaded;
      },
      useLook: async (o) => void (look.loaded = o?.id ?? "off"),
      // The frames the card was named on, kept for a card-first row's look.
      keepLook: async () => [],
      lookAt: async (_index, candidates, onScore) => {
        look.asked += 1;
        for (const c of candidates) if (look.scores[c.id] != null) onScore(c.id, look.scores[c.id]!);
        return { model: "look-1", frames: 1, queryMs: 1, scored: candidates.length, cached: 0, fetchMs: 0, decodeMs: 0, embedMs: 0, ms: 1 };
      },
      identify: async (_image, onSeen) => {
        const quad = cam.card === "none" ? null : QUAD;
        onSeen?.(quad);
        // "weak": the card still there, its art washed out (a foil in glare): too weak to hold it.
        const matches = cam.card === "signet" ? [{ ...signet(), score: 0.93 }] : cam.card === "weak" ? [{ ...signet(), score: 0.3 }] : cam.card === "lookalike" ? [{ ...other, score: 0.5 }, { ...signet(), score: 0.45 }] : cam.card === "titled" ? [{ ...other, score: 0.7 }, { ...signet(), score: 0.66 }] : cam.card === "other" ? [{ ...other, score: 0.9 }, { ...signet(), score: 0.4 }] : [];
        return { quad, upright: 1, matches, timings: { detectMs: 1, embedMs: 1, totalMs: 2 } };
      },
      locate: async () => {
        throw new Error("no gate here");
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
vi.mock("./serverCatalog", () => ({ createServerCatalog: async () => ({ hasSet: () => false, lookup: async () => null, names: () => ["Arcane Signet", "Stridehangar Automaton"] }) }));
vi.mock("./ocrEngine", async (original) => ({
  ...(await original<typeof import("./ocrEngine")>()),
  // A title read gives `cam.title` (the card's name, read off it); nothing else reads.
  // The collector line's crops (block reads) give `cam.line`; a title read nothing.
  createScannerOcr: async () => ({
    engine: "tesseract",
    read: async (_img: unknown, o: { mode: string }) => (o.mode === "block" ? (cam.collectorReads++, { text: cam.line, confidence: 95 }) : { text: "", confidence: 0 }),
    terminate: async () => undefined,
  }),
}));
vi.mock("./sounds", async (original) => ({ ...(await original<typeof import("./sounds")>()), playScanSound: () => undefined, playPriceSound: () => undefined }));

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
// A camera always delivering an upright 2160 × 3840 picture, as a phone's does.
Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 2160 });
Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 3840 });
Object.defineProperty(HTMLVideoElement.prototype, "readyState", { configurable: true, get: () => 4 });
Object.defineProperty(HTMLVideoElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
HTMLVideoElement.prototype.play = async () => undefined;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

const { ScannerView } = await import("./ScannerView");

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  const track = { stop: () => undefined, getSettings: () => ({ deviceId: "x", width: 2160, height: 3840 }), getCapabilities: () => ({}), applyConstraints: async () => undefined, label: "fake" };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => stream, enumerateDevices: async () => [] } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.assign(cam, { card: "signet", printings: 3, ill: cam.ill + 1, title: "", line: "C 0145\nWOC • EN", collectorReads: 0 });
  quality.sharp = false;
  Object.assign(look, { loaded: "off", scores: {}, asked: 0 });
  Object.assign(native, { opened: [], follows: [], sizes: [] });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until<T>(get: () => T | null | undefined, what: string, tries = 150): Promise<T> {
  const seen = new Set<string>();
  for (let i = 0; i < tries; i += 1) {
    const v = get();
    if (v) return v;
    seen.add(chip());
    await wait(20);
  }
  console.log("chips seen", [...seen], document.querySelector(".scan-panel")?.textContent);
  throw new Error(`never saw ${what} (the chip said "${chip()}")`);
}
const chip = () => document.querySelector(".scan-chip")?.textContent ?? "";

describe("focusing on the held card's collector line", { timeout: 20_000 }, () => {
  it("tells the app's camera where the held card is, frame after frame, while its sheet is open", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await until(() => (native.opened.length ? true : null), "the app's camera opened");
    expect(native.opened).toEqual([true]);
    // Named with three printings of its art: the sheet opens and the card is held for its line.
    // Every view is too soft to read, so the hold goes on, and each of its frames says where the card is.
    await until(() => (native.follows.length >= 2 ? true : null), "the held card's corners, twice");
    expect(native.follows[0]).toEqual(QUAD);
    // In the pixels of the frame it was found in: the app's 640 x 1138.
    expect(native.sizes[0]).toEqual([640, 1138]);
    expect(cam.collectorReads).toBe(0);
  });

  it("doesn't in a deck or box scan, which reads no printing", async () => {
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (native.opened.length ? true : null), "the app's camera opened");
    expect(native.opened).toEqual([false]);
    await wait(600);
    expect(native.follows).toEqual([]);
  });
});
