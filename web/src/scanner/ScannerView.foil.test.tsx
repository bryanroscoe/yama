// @vitest-environment jsdom
// Foil by its sheen, and Foil or Not foil after filing (Bryan, 23 Nov 2026: "Let's detect foils by
// the rainbow sheen ... it should be easier to switch between foil and not foil"). The camera and
// the recognizer are faked as in ScannerView.rescan.test.tsx; the recognizer says each frame's
// sheen (foil.ts), and Arcane Signet's printing comes in regular and foil.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ArtRecognizer, BundleInfo } from "./artClient";
import type { Quad, ScanCandidate } from "./types";

const V = "gallery-20261106T183001884398Z";
const printing = (id: string, set: string, number: string): Printing => ({
  scryfall_id: id, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: number, lang: "en",
  rarity: "common", finishes: ["nonfoil", "foil"], released_at: "2024-01-01", image_normal: null, image_small: null, back_image_normal: null, artist: null,
  price_date: "2026-11-20", usd: 1, usd_foil: 3, full_art: cam.fullArt, usd_etched: null, eur: null, eur_foil: null,
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
    look: { default: "off", options: [{ id: "off", label: "Off", note: "" }] },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }] },
    lock: { default: "lead", options: [{ id: "lead", label: "Art that leads", note: "" }] },
  },
});

/** What lies in view (Arcane Signet, or nothing), and its text box's sheen (foil.ts). */
const cam = vi.hoisted(() => ({ card: "signet" as "signet" | "weak" | "lookalike" | "titled" | "other" | "none", printings: 1, ill: 0, title: "", sheen: { spread: 2, hues: 0 }, fullArt: false }));

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
      look: "off",
      useLook: async () => undefined,
      lookAt: async () => ({ model: "none", frames: 0, queryMs: 0, scored: 0, cached: 0, fetchMs: 0, decodeMs: 0, embedMs: 0, ms: 0 }),
      identify: async (_image, onSeen) => {
        const quad = cam.card === "none" ? null : QUAD;
        onSeen?.(quad);
        // "weak": the card still there, its art washed out (a foil in glare): too weak to hold it.
        const matches = cam.card === "signet" ? [{ ...signet(), score: 0.93 }] : cam.card === "weak" ? [{ ...signet(), score: 0.3 }] : cam.card === "lookalike" ? [{ ...other, score: 0.5 }, { ...signet(), score: 0.45 }] : cam.card === "titled" ? [{ ...other, score: 0.7 }, { ...signet(), score: 0.66 }] : cam.card === "other" ? [{ ...other, score: 0.9 }, { ...signet(), score: 0.4 }] : [];
        return { quad, upright: 1, matches, ...(quad ? { sheen: cam.sheen } : {}), timings: { detectMs: 1, embedMs: 1, totalMs: 2 } };
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
  createScannerOcr: async () => ({ engine: "tesseract", read: async (_img: unknown, o: { mode: string }) => (o.mode === "line" && cam.title ? { text: cam.title, confidence: 95 } : { text: "", confidence: 0 }), terminate: async () => undefined }),
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
  Object.assign(cam, { card: "signet", printings: 1, ill: cam.ill + 1, title: "", sheen: { spread: 2, hues: 0 }, fullArt: false });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until<T>(get: () => T | null | undefined, what: string, tries = 150): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const v = get();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`never saw ${what} (the chip said "${chip()}")`);
}
const chip = () => document.querySelector(".scan-chip")?.textContent ?? "";
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name);
const click = (el: Element) => act(async () => void (el as HTMLElement).click());

function scan(o: { bySheen?: boolean; accepted: ScanCandidate[]; flipped: [ScanCandidate, string][] }) {
  act(() =>
    root.render(
      <ScannerView
        autoAdd
        foilBySheen={o.bySheen ?? true}
        onAccept={async (c) => {
          o.accepted.push(c);
          return true;
        }}
        onUndo={async () => undefined}
        onFinish={async (c, to) => {
          o.flipped.push([c, to]);
        }}
      />,
    ),
  );
}

describe("foil by its sheen", { timeout: 20_000 }, () => {
  it("files a card whose text box shows a foil's rainbow as foil, says so, and Not foil changes it", async () => {
    cam.sheen = { spread: 24, hues: 4 };
    const accepted: ScanCandidate[] = [];
    const flipped: [ScanCandidate, string][] = [];
    scan({ accepted, flipped });
    await until(() => (accepted.length === 1 ? true : null), "the card filed");
    expect(accepted[0]!.finish).toBe("foil");
    expect(accepted[0]!.foil).toMatchObject({ foil: true, sure: true });
    // Its foil price ($3), and the finish said.
    await until(() => (chip().includes("Added Arcane Signet (EOC 101), foil, $3.00") ? true : null), "the foil said");
    await click(await until(() => button("Not foil"), "Not foil"));
    expect(flipped).toHaveLength(1);
    expect(flipped[0]![0]).toBe(accepted[0]);
    expect(flipped[0]![1]).toBe("nonfoil");
    await until(() => (chip().includes("Arcane Signet (EOC 101): not foil, $1.00") ? true : null), "now not foil");
    // And back again: the same card each time.
    await click(await until(() => button("Foil"), "Foil"));
    expect(flipped[1]).toEqual([accepted[0], "foil"]);
  });

  it("files a plain card as regular, with Foil beside Undo for when it is one", async () => {
    const accepted: ScanCandidate[] = [];
    const flipped: [ScanCandidate, string][] = [];
    scan({ accepted, flipped });
    await until(() => (accepted.length === 1 ? true : null), "the card filed");
    expect(accepted[0]!.finish).toBe("nonfoil");
    await until(() => (chip().includes("Added Arcane Signet (EOC 101), $1.00") ? true : null), "the plain add");
    await click(await until(() => button("Foil"), "Foil"));
    expect(flipped[0]![1]).toBe("foil");
  });

  it("leaves the finish to the host when it's turned off, or for a full-art printing (no text box)", async () => {
    cam.sheen = { spread: 24, hues: 4 };
    const off: ScanCandidate[] = [];
    scan({ bySheen: false, accepted: off, flipped: [] });
    await until(() => (off.length === 1 ? true : null), "the card filed");
    expect(off[0]!.finish).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    cam.fullArt = true;
    cam.ill += 1;
    const full: ScanCandidate[] = [];
    scan({ accepted: full, flipped: [] });
    await until(() => (full.length === 1 ? true : null), "the full-art card filed");
    expect(full[0]!.finish).toBeUndefined();
    // What its sheen said is still kept for its record.
    expect(full[0]!.foil?.foil).toBe(true);
  });
});
