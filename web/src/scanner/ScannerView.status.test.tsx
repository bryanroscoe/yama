// @vitest-environment jsdom
// What the camera's chip says the scanner is doing (Bryan, 22 Nov 2026: "It's not always clear or
// speedy enough to let you know when it's trying to scan the next card and if it's finished
// scanning that card and what card it did just scan"). His screenshot: the next card already in
// view, while the chip still said "Found it. Hold still for the printing" of the card before. The
// camera and the recognizer are faked as in ScannerView.gate.test.tsx; the text reader reads
// nothing, so a card's printing is never settled by its collector line.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ArtRecognizer, BundleInfo } from "./artClient";
import type { Quad, ScanCandidate } from "./types";

const V = "gallery-20261106T183001884398Z";
const printing = (id: string, set: string, number: string): Printing => ({
  scryfall_id: id, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: number, lang: "en",
  rarity: "common", finishes: ["nonfoil"], released_at: "2024-01-01", image_normal: null, image_small: null, back_image_normal: null, artist: null,
  price_date: "2026-11-20", usd: "1.00", usd_foil: null, usd_etched: null, eur: null, eur_foil: null,
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

/** What lies in view: the card found first, another card, or nothing. */
const cam = vi.hoisted(() => ({ card: "signet" as "signet" | "other" | "none", printings: 3, ill: 0 }));

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string) => {
    if (path.startsWith("/api/scan/bundle")) return Promise.resolve(bundle());
    if (path.startsWith("/api/scan/printings")) return Promise.resolve({ same_art: true, printings: [printing("p1", "eoc", "101"), printing("p2", "woc", "145"), printing("p3", "c19", "236")].slice(0, cam.printings) });
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));

// A card near enough for its collector line to be read (closer.ts): over 1,563 px tall in a 4K picture.
const QUAD: Quad = [[300, 900], [1860, 900], [1860, 3080], [300, 3080]];
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
        const matches = cam.card === "signet" ? [{ ...signet(), score: 0.93 }] : cam.card === "other" ? [{ ...other, score: 0.9 }, { ...signet(), score: 0.4 }] : [];
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
vi.mock("./serverCatalog", () => ({ createServerCatalog: async () => ({ hasSet: () => false, lookup: async () => null, names: () => [] }) }));
vi.mock("./ocrEngine", async (original) => ({
  ...(await original<typeof import("./ocrEngine")>()),
  createScannerOcr: async () => ({ engine: "tesseract", read: async () => ({ text: "", confidence: 0 }), terminate: async () => undefined }),
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
  Object.assign(cam, { card: "signet", printings: 3, ill: cam.ill + 1 });
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
const click = (el: Element) => act(async () => void (el as HTMLElement).click());

describe("the camera always says what the scanner is doing, and with which card", { timeout: 20_000 }, () => {
  it("names the card whose printing it's reading, and says at once when another card has taken its place", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await until(() => chip() === "Arcane Signet: hold still for the printing", "the card named while its printing is read");
    // The next card laid down: the scanner is still on the last one, and says so (not after the
    // six seconds a card may be away while its corner is brought close).
    const before = performance.now();
    cam.card = "other";
    await until(() => chip() === "Still on Arcane Signet: tap its printing", "still on the card before");
    expect(performance.now() - before).toBeLessThan(2500);
    // The sheet is still that card's, with its printings to tap.
    expect(document.querySelector(".scan-info h3")?.textContent).toContain("Arcane Signet");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
    // Skip: on to the card in view.
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Skip")!);
    await until(() => chip().startsWith("Stridehangar Automaton") || chip() === "Found Stridehangar Automaton", "the next card found");
  });

  it("keeps reading through a card brought close or wobbling out of view, as before", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await until(() => chip() === "Arcane Signet: hold still for the printing", "the card named");
    cam.card = "none";
    await wait(600);
    expect(chip()).toBe("Arcane Signet: hold still for the printing");
  });

  it("names the card it just added, then says it's ready for the next one once the card has gone", async () => {
    cam.printings = 1;
    function Host() {
      const [cards, setCards] = useState<ScanCandidate[]>([]);
      return (
        <ScannerView
          autoAdd
          // As the collection does: Undo is offered, so the add is shown with the card.
          onUndo={async () => undefined}
          onAccept={async (c) => {
            setCards((a) => [c, ...a]);
            return true;
          }}
          recentCards={cards.map((c, i) => ({ key: `k${i}`, name: c.name, set: c.set, number: c.number, finish: "nonfoil", copies: 1, prices: c.prices, image: null, oracleId: c.oracle_id }))}
        />
      );
    }
    act(() => root.render(<Host />));
    await until(() => (chip().startsWith("Added Arcane Signet") ? true : null), "the card added, by name");
    cam.card = "none";
    // With cards in the strip the chip used to go blank: now it says the scanner is waiting.
    const idle = await until(() => (chip() === "Ready for the next card" ? document.querySelector(".scan-chip") : null), "ready for the next card");
    expect(idle?.classList.contains("is-idle")).toBe(true);
  });
});
