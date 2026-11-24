// @vitest-environment jsdom
// Only a card-shaped outline names a card by its art (cardShape.ts; the public hard-card photos run,
// 24 Nov 2026), and the Codex review of #213: a card tilted far enough to look square is still in
// view, so a hold on it stands, and it's asked to be held flatter rather than named by its art. The
// camera and the recognizer are faked as in ScannerView.rescan.test.tsx; the recognizer flags the
// square outline (`shaped: false`) as the real one does.
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

/** What lies in view: Arcane Signet flat, the same card tilted so its outline looks square, or nothing. */
const cam = vi.hoisted(() => ({ card: "signet" as "signet" | "tilted" | "other" | "otherTilted" | "column" | "none", printings: 1, ill: 0, title: "" }));

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
/** The same card tilted far enough that its outline is about square (cardShape.ts refuses it). */
const SQUAT: Quad = [[89, 400], [551, 400], [551, 860], [89, 860]];
/** A column of overlapping cards outlined as one (1.9 to 1): not one card. */
const COLUMN: Quad = [[150, 60], [490, 60], [490, 706], [150, 706]];
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
        const quad = cam.card === "none" ? null : cam.card === "tilted" || cam.card === "otherTilted" ? SQUAT : cam.card === "column" ? COLUMN : QUAD;
        onSeen?.(quad);
        // "weak": the card still there, its art washed out (a foil in glare): too weak to hold it.
        // Each card's art matches surely: only the outline differs.
        const isOther = cam.card === "other" || cam.card === "otherTilted";
        const matches = !quad ? [] : isOther ? [{ ...other, score: 0.9 }] : [{ ...signet(), score: 0.93 }, { ...other, score: 0.4 }];
        const odd = cam.card === "tilted" || cam.card === "otherTilted" || cam.card === "column";
        return { quad, upright: 1, matches, ...(odd ? { shaped: false as const } : {}), timings: { detectMs: 1, embedMs: 1, totalMs: 2 } };
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
  Object.assign(cam, { card: "signet", printings: 1, ill: cam.ill + 1, title: "" });
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

describe("an outline that isn't card-shaped", { timeout: 20_000 }, () => {
  it("doesn't name a card tilted to look square by its art, asks for it flatter, and names it once it is", async () => {
    cam.card = "tilted";
    const accepted: ScanCandidate[] = [];
    act(() => root.render(<Host accepted={accepted} />));
    await until(() => (chip().includes("Hold the card flatter") ? true : null), "hold it flatter");
    await wait(800);
    expect(accepted).toHaveLength(0);
    cam.card = "signet";
    await until(() => (accepted.length === 1 ? true : null), "the card added once flat");
  });

  it("keeps the hold on the card just filed while it's tilted for a moment: not added twice (Codex review of #213)", async () => {
    const accepted: ScanCandidate[] = [];
    act(() => root.render(<Host accepted={accepted} />));
    await until(() => (accepted.length === 1 ? true : null), "the card added");
    cam.card = "tilted";
    await wait(1000);
    cam.card = "signet";
    await wait(1200);
    expect(accepted).toHaveLength(1);
  });

  it("names a tilted card by its title, while it's still tilted (Codex re-check of #213)", async () => {
    cam.card = "tilted";
    cam.title = "Arcane Signet";
    const accepted: ScanCandidate[] = [];
    act(() => root.render(<Host accepted={accepted} />));
    await until(() => (accepted.length === 1 ? true : null), "the tilted card named by its title");
    expect(accepted[0]!.name).toBe("Arcane Signet");
  });

  it("lets another card, tilted, end the hold on the one just filed, but not be named by its art; flat, it's added", async () => {
    const accepted: ScanCandidate[] = [];
    act(() => root.render(<Host accepted={accepted} />));
    await until(() => (accepted.length === 1 ? true : null), "the first card added");
    cam.card = "otherTilted";
    await wait(1200);
    expect(accepted).toHaveLength(1);
    cam.card = "other";
    await until(() => (accepted.length === 2 ? true : null), "the other card added once flat");
    // (This fake's printings are all Arcane Signet's: the second add is the card in view, Stridehangar.)
    await wait(600);
    expect(accepted).toHaveLength(2);
  });

  it("names nothing from a column of overlapping cards, title or art, and says to show one card", async () => {
    cam.card = "column";
    cam.title = "Arcane Signet";
    const accepted: ScanCandidate[] = [];
    act(() => root.render(<Host accepted={accepted} />));
    await until(() => (chip().includes("Show one card at a time") ? true : null), "one card at a time");
    await wait(1000);
    expect(accepted).toHaveLength(0);
  });
});
