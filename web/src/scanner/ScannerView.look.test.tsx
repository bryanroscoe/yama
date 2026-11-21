// @vitest-environment jsdom
// The printing look in the scanner (look.ts, ScannerView.tsx): a card found by its art with several
// printings sharing that art gets its list ordered by look, once the look has finished, with its
// best guess marked; it never chooses or files one; and a list touched before then keeps its order.
// The card comes from "Use a photo" (no camera here), with the recognizer and the look faked.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ArtRecognizer, BundleInfo, LookDone } from "./artClient";
import type { LookCandidate } from "./look";

const V = "gallery-20261106T183001884398Z";
const printing = (id: string, set: string, released: string): Printing => ({
  scryfall_id: id, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: "1", lang: "en",
  rarity: "common", finishes: ["nonfoil"], released_at: released, image_normal: `https://cards.scryfall.io/normal/front/${id}.jpg`, image_small: null, back_image_normal: null, artist: null,
  price_date: null, usd: null, usd_foil: null, usd_etched: null, eur: null, eur_foil: null,
});
// Newest first, as the server lists them.
const printings = [printing("p-new", "eoc", "2025-08-01"), printing("p-mid", "woc", "2023-09-08"), printing("p-old", "c19", "2019-08-23")];
const bundle = (): BundleInfo => ({
  version: V,
  ready: true,
  error: null,
  files: { detector: "d", embed: `/scan-bundle/${V}/embed.onnx`, search: "s", arts: "a" },
  bytes: { detector: 1, embed: 1, search: 1, arts: 1 },
  constants: { scene: 640 },
  models: {
    art: { default: "bundle", options: [{ id: "bundle", label: "ManaVault's art model", note: "", file: `/scan-bundle/${V}/embed.onnx`, bytes: 1 }] },
    look: { default: "look-v0", options: [{ id: "off", label: "Off", note: "" }, { id: "look-v0", label: "Yama's look model, 20 Nov", note: "", file: `/scan-bundle/${V}/look-58acfa166105.onnx`, bytes: 9 }] },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }] },
    lock: { default: "lead", options: [{ id: "lead", label: "Art that leads", note: "" }] },
  },
});

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string) => {
    if (path === "/api/scan/bundle?can=cuts") return Promise.resolve(bundle());
    if (path.startsWith("/api/scan/printings")) return Promise.resolve({ same_art: true, printings });
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));

/** The faked look: what it was asked, the scores it gives, and a gate to hold it back. */
const look = vi.hoisted(() => ({ asked: [] as { index: number; candidates: LookCandidate[] }[], gate: null as Promise<void> | null, loaded: "off" }));
vi.mock("./artClient", async (original) => ({
  ...(await original<typeof import("./artClient")>()),
  loadArtRecognizer: async () => {
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
      async lookAt(index, candidates, onScore) {
        look.asked.push({ index, candidates });
        await look.gate;
        const scores: Record<string, number> = { "p-old": 0.9, "p-mid": 0.5, "p-new": 0.2 };
        for (const c of candidates) onScore(c.id, scores[c.id]!);
        return { model: "look-58acfa166105", frames: 2, queryMs: 1, scored: candidates.length, cached: 0, fetchMs: 1, decodeMs: 1, embedMs: 1, ms: 5 } satisfies LookDone;
      },
      // The photo: a card in the middle, its art shared by the three printings.
      identify: async () => ({
        quad: [[100, 100], [400, 100], [400, 520], [100, 520]],
        upright: 1,
        matches: [{ index: 4, id: "p-new", name: "Arcane Signet", set: "eoc", number: "1", illustrationId: "ill-signet", layout: "normal", printings: 3, score: 0.93 }],
        timings: { detectMs: 1, embedMs: 1, totalMs: 2 },
      }),
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
// jsdom draws nothing: a canvas that hands back blank pixels, and a photo that decodes to a size.
vi.stubGlobal("createImageBitmap", async () => ({ width: 500, height: 640, close: () => undefined }));
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

const { ScannerView } = await import("./ScannerView");

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  look.asked.length = 0;
  look.gate = null;
  look.loaded = "off";
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until<T>(get: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const v = get();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`never saw ${what}`);
}
const order = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.querySelector(".scan-printing-set")?.textContent?.split(" ")[0]);
async function scanPhoto() {
  await until(() => (look.loaded === "look-v0" ? true : null), "the look model");
  const input = document.querySelector<HTMLInputElement>(".scan-photo-input")!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "card.jpg", { type: "image/jpeg" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

describe("the printing look in the scanner", () => {
  it("orders the list by look once it's done, marks its best guess, and chooses nothing", async () => {
    const accepted: unknown[] = [];
    act(() =>
      root.render(
        <ScannerView
          onAccept={async (c) => {
            accepted.push(c);
            return true;
          }}
        />,
      ),
    );
    await scanPhoto();
    await until(() => (order().length === 3 ? true : null), "the printings");
    // The found card's artwork and each printing's own picture.
    expect(look.asked[0]!.index).toBe(4);
    expect(look.asked[0]!.candidates.map((c) => c.id)).toEqual(["p-new", "p-mid", "p-old"]);
    await until(() => (order()[0] === "C19" ? true : null), "the look's order");
    expect(order()).toEqual(["C19", "WOC", "EOC"]);
    const best = document.querySelector(".scan-printing.is-look");
    expect(best?.textContent).toContain("Looks closest");
    expect(best?.textContent).toContain("C19");
    // A guess, never a choice: nothing filed, nothing chosen.
    expect(document.querySelector(".scan-printing.is-chosen")).toBeNull();
    expect(accepted).toEqual([]);
  });

  it("leaves the order alone once the list was touched before the look finished", async () => {
    let release!: () => void;
    look.gate = new Promise((r) => (release = r));
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await scanPhoto();
    await until(() => (order().length === 3 && look.asked.length > 0 ? true : null), "the printings");
    expect(order()).toEqual(["EOC", "WOC", "C19"]);
    await act(async () => document.querySelector(".scan-printings")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    await act(async () => release());
    await wait(60);
    expect(order()).toEqual(["EOC", "WOC", "C19"]);
    expect(document.querySelector(".scan-printing.is-look")).toBeNull();
  });
});
