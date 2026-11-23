// @vitest-environment jsdom
// Glare and going wide (Bryan, 23 Nov 2026, after #205: the scanner no longer seemed to switch
// lenses "to try to scan the card better", and "the glare is really killing me"). A card filed
// last stayed "named" while a glary foil lay unnamed in its place, so it never went wide; the
// flashlight's reflection was most of the glare on foils (glare.ts). The camera and the
// recognizer are faked as in ScannerView.rescan.test.tsx, with a camera that zooms out to 0.5x
// and has a flashlight.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ArtRecognizer, BundleInfo } from "./artClient";
import type { Quad, ScanCandidate } from "./types";
import { WIDE_AFTER_MS } from "./zoomPolicy";

const V = "gallery-20261106T183001884398Z";
const printing = (id: string, set: string, number: string): Printing => ({
  scryfall_id: id, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: number, lang: "en",
  rarity: "common", finishes: ["nonfoil"], released_at: "2024-01-01", image_normal: null, image_small: null, back_image_normal: null, artist: null,
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
    look: { default: "off", options: [{ id: "off", label: "Off", note: "" }] },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }] },
    lock: { default: "lead", options: [{ id: "lead", label: "Art that leads", note: "" }] },
  },
});

/**
 * What lies in view: Arcane Signet (named surely), a foil the art can't name (another card at 0.55,
 * its art blown out when `glare`), or nothing.
 */
const cam = vi.hoisted(() => ({ card: "signet" as "signet" | "foil" | "none", printings: 1, ill: 0, title: "", glare: true }));

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
      identify: async (image, onSeen) => {
        const quad = cam.card === "none" ? null : QUAD;
        onSeen?.(quad);
        // As the real worker: glare measured on the frame there, and the frame's pixels handed over
        // (the page can't read them after the call).
        const { artGlare } = await import("./glare");
        const glare = quad ? artGlare(image, quad) : undefined;
        (image.data.buffer as ArrayBuffer & { transfer?: () => ArrayBuffer }).transfer?.();
        const matches = cam.card === "signet" ? [{ ...signet(), score: 0.93 }] : cam.card === "foil" ? [{ ...other, score: 0.55 }, { ...signet(), score: 0.4 }] : [];
        return { quad, upright: 1, matches, ...(glare != null ? { glare } : {}), timings: { detectMs: 1, embedMs: 1, totalMs: 2 } };
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
    // A glary foil's frame is blown out (glare.ts measures it); anything else is black.
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(cam.card === "foil" && cam.glare ? 255 : 0) }),
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
/** Every setting the camera was asked for, in order. */
let applied: Record<string, unknown>[] = [];
beforeEach(() => {
  applied = [];
  const track = {
    stop: () => undefined,
    getSettings: () => ({ deviceId: "x", width: 2160, height: 3840 }),
    // A Pixel's: zooms out to its ultra-wide, and a flashlight.
    getCapabilities: () => ({ zoom: { min: 0.507, max: 30 }, torch: true }),
    applyConstraints: async (c: { advanced?: Record<string, unknown>[] }) => {
      applied.push({ ...(c.advanced?.[0] ?? {}) });
    },
    label: "fake",
  };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => stream, enumerateDevices: async () => [] } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.assign(cam, { card: "signet", printings: 1, ill: cam.ill + 1, title: "", glare: true });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "mediaDevices");
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until<T>(get: () => T | null | undefined, what: string, tries = 250): Promise<T> {
  for (let i = 0; i < tries; i += 1) {
    const v = get();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`never saw ${what} (the chip said "${chip()}"; the camera was asked for ${JSON.stringify(applied)})`);
}
const chip = () => document.querySelector(".scan-chip")?.textContent ?? "";
const click = (el: Element) => act(async () => void (el as HTMLElement).click());
/** Asked for about this zoom (0.51 on this lens, whose least is 0.507). */
const zoomedTo = (z: number) => applied.some((a) => typeof a.zoom === "number" && Math.abs(a.zoom - z) < 0.02);
const torchNow = () => [...applied].reverse().find((a) => typeof a.torch === "boolean")?.torch;

function Host({ accepted }: { accepted: ScanCandidate[] }) {
  const [cards, setCards] = useState<ScanCandidate[]>([]);
  return (
    <ScannerView
      autoAdd
      closeups={false}
      onUndo={async () => undefined}
      onAccept={async (c) => {
        accepted.push(c);
        setCards((a) => [c, ...a]);
        return true;
      }}
      recentCards={cards.map((c, i) => ({ key: `k${cards.length - i}`, name: c.name, set: c.set, number: c.number, finish: "nonfoil", copies: 1, prices: c.prices, image: null, oracleId: c.oracle_id }))}
    />
  );
}

describe("glare and going wide", { timeout: 20_000 }, () => {
  it("steps out to 0.5x for a foil it can't name that's laid where the card just filed was (23 Nov 2026, after #205)", async () => {
    // No glare to hurry it: the plain struggle, 3 s.
    cam.glare = false;
    const accepted: ScanCandidate[] = [];
    act(() => root.render(<Host accepted={accepted} />));
    await until(() => (accepted.length === 1 ? true : null), "the card filed");
    expect(zoomedTo(0.5)).toBe(false);
    // The next card slid on without the view clearing: the art can't name it.
    cam.card = "foil";
    await until(() => (zoomedTo(0.5) ? true : null), "the step out to 0.5x");
    expect(accepted).toHaveLength(1);
    // Gone: back to 1x for the next card.
    cam.card = "none";
    await until(() => (applied.at(-1)?.zoom === 1 ? true : null), "back to 1x");
  });

  it("doesn't step out for the card just filed, lying there", async () => {
    const accepted: ScanCandidate[] = [];
    act(() => root.render(<Host accepted={accepted} />));
    await until(() => (accepted.length === 1 ? true : null), "the card filed");
    await wait(4500);
    expect(zoomedTo(0.5)).toBe(false);
    expect(accepted).toHaveLength(1);
  });

  it("with glare on a foil laid where the card just filed was: says so in place of Still in view, keeps Scan next card, and steps out sooner", async () => {
    const accepted: ScanCandidate[] = [];
    act(() => root.render(<Host accepted={accepted} />));
    await until(() => (accepted.length === 1 ? true : null), "the card filed");
    cam.card = "foil";
    const laid = performance.now();
    await until(() => (chip().includes("Glare on the card: tilt it a little") ? true : null), "the glare said");
    expect([...document.querySelectorAll(".scan-chip button")].map((b) => b.textContent)).toContain("Scan next card");
    await until(() => (zoomedTo(0.5) ? true : null), "the step out to 0.5x");
    // Glare: WIDE_GLARE_MS (1.5 s), well before the plain 3 s.
    expect(performance.now() - laid).toBeLessThan(WIDE_AFTER_MS);
  });

  it("turns the flashlight off when its glare is on the art of a card it can't name, says so, then says to tilt it", async () => {
    cam.card = "none";
    const accepted: ScanCandidate[] = [];
    act(() => root.render(<Host accepted={accepted} />));
    await click(await until(() => document.querySelector('[aria-label="Turn the flashlight on"]'), "the flashlight button"));
    await until(() => (torchNow() === true ? true : null), "the flashlight on");
    cam.card = "foil";
    await until(() => (torchNow() === false ? true : null), "the flashlight off");
    await until(() => (chip().includes("Flashlight off: it put glare on the card") ? true : null), "the flashlight's note");
    // The glare stays (another light): what to do about it, and the wide lens sooner than 3 s.
    await until(() => (chip().includes("Glare on the card: tilt it a little") ? true : null), "the glare said");
    await until(() => (zoomedTo(0.5) ? true : null), "the step out to 0.5x");
    expect(accepted).toHaveLength(0);
  });

  it("leaves the flashlight to the person once they've turned it back on", async () => {
    cam.card = "none";
    act(() => root.render(<Host accepted={[]} />));
    await click(await until(() => document.querySelector('[aria-label="Turn the flashlight on"]'), "the flashlight button"));
    await until(() => (torchNow() === true ? true : null), "the flashlight on");
    cam.card = "foil";
    await until(() => (torchNow() === false ? true : null), "the flashlight off");
    await click(await until(() => document.querySelector('[aria-label="Turn the flashlight on"]'), "the flashlight button again"));
    await until(() => (torchNow() === true ? true : null), "the flashlight on again");
    await wait(1500);
    expect(torchNow()).toBe(true);
    await until(() => (chip().includes("tilt it, or turn the flashlight off") ? true : null), "the glare said, flashlight on");
  });
});
