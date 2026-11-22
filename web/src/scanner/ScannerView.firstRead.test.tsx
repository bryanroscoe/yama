// @vitest-environment jsdom
// The collector line's first read (ScannerView.tsx, `startFirstRead` and `settle`; Bryan, 22 Nov
// 2026: "That's very clearly 0019 but it didn't recognize it"). The view a card is named in has its
// collector line read at once, while its printings load, not after; a card with one printing has
// nothing read; a card named by its title has the view it was read in read too; and Scanner
// diagnostics keep how long the read waited and each crop took, with a struggle record for a
// printing settled slowly. The card comes from "Use a photo" (no camera here), with the
// recognizer and the text reader faked.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ArtRecognizer, BundleInfo, LookDone } from "./artClient";
import type { ArtMatch } from "./recognizer";
import { setDiagnosticsOn } from "./diagnostics";
import type { Provisional } from "./later";
import type { ScanCandidate } from "./types";

const V = "gallery-20261106T183001884398Z";
const printing = (id: string, number: string, name = "Stridehangar Automaton"): Printing => ({
  scryfall_id: id, oracle_id: "o", name, set_code: "drc", set_name: "Aetherdrift Commander", collector_number: number, lang: "en",
  rarity: "rare", finishes: ["nonfoil"], released_at: "2025-02-14", image_normal: `https://cards.scryfall.io/normal/front/${id}.jpg`, image_small: null, back_image_normal: null, artist: null,
  price_date: null, usd: null, usd_foil: null, usd_etched: null, eur: null, eur_foil: null,
});
// Two printings that share the art, told apart only by their number (DRC 19 and 35).
const twins = [printing("p19", "19"), printing("p35", "35")];
const bundle = (): BundleInfo => ({
  version: V,
  ready: true,
  error: null,
  files: { detector: "d", embed: `/scan-bundle/${V}/embed.onnx`, search: "s", arts: "a" },
  bytes: { detector: 1, embed: 1, search: 1, arts: 1 },
  constants: { scene: 640 },
  models: {
    art: { default: "bundle", options: [{ id: "bundle", label: "ManaVault's art model", note: "", file: `/scan-bundle/${V}/embed.onnx`, bytes: 1 }] },
    look: { default: "look-v1", options: [{ id: "off", label: "Off", note: "" }, { id: "look-v1", label: "Yama's look model v1", note: "", file: `/scan-bundle/${V}/look-1.onnx`, bytes: 9 }] },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }] },
    lock: { default: "lead", options: [{ id: "lead", label: "Art that leads", note: "" }] },
  },
});

const fake = vi.hoisted(() => ({
  /** The printings the server gives, and a gate that holds its answer back while set. */
  printings: [] as Printing[],
  sameArt: true,
  printingsGate: null as Promise<void> | null,
  printingsAnswered: false,
  /** What the art recognizer sees in the photo. */
  matches: [] as ArtMatch[],
  /** The collector line read from every crop, a title read, and a gate holding collector reads back. */
  line: "",
  title: "",
  ocrGate: null as Promise<void> | null,
  /** Each collector-line read asked for: whether the printings had been answered by then. */
  collectorReads: [] as { printingsAnswered: boolean }[],
  looked: "off",
  timings: [] as Record<string, unknown>[],
  records: [] as Record<string, unknown>[],
}));

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: async (path: string, opts?: { method?: string; json?: unknown }) => {
    if (path === "/api/scan/bundle?can=cuts,settle") return bundle();
    if (path.startsWith("/api/scan/printings")) {
      await fake.printingsGate;
      fake.printingsAnswered = true;
      return { same_art: fake.sameArt, printings: fake.printings };
    }
    if (path === "/api/scan/diagnostics/timings") {
      fake.timings.push(opts?.json as Record<string, unknown>);
      return { id: "t" };
    }
    if (path === "/api/scan/diagnostics" && opts?.method === "POST") {
      fake.records.push(opts.json as Record<string, unknown>);
      return { id: "d" };
    }
    if (path.startsWith("/api/scan/diagnostics")) return { count: 0, bytes: 0, keep: 200 };
    throw new Error(`offline: ${path}`);
  },
}));

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
        return fake.looked;
      },
      useLook: async (o) => void (fake.looked = o?.id ?? "off"),
      lookAt: async () => ({ model: "look-1", frames: 1, queryMs: 1, scored: 0, cached: 0, fetchMs: 0, decodeMs: 0, embedMs: 0, ms: 1 }) satisfies LookDone,
      identify: async () => ({ quad: [[100, 100], [400, 100], [400, 520], [100, 520]], upright: 1, matches: fake.matches, timings: { detectMs: 1, embedMs: 1, totalMs: 2 } }),
      locate: () => new Promise(() => undefined),
      matchAt: () => new Promise(() => undefined),
      reset: () => undefined,
      setPool: async () => -1,
      dispose: () => undefined,
    };
    return r;
  },
}));
vi.mock("./serverCatalog", () => ({
  createServerCatalog: async () => ({ hasSet: () => false, lookup: async () => null, names: () => ["Stridehangar Automaton", "Vineglimmer Snarl", "Arcane Signet", "Sol Ring"] }),
}));
// The text reader: a collector-line read ("block", with its whitelist) gives `fake.line`, after
// `fake.ocrGate`; a title read ("line") gives `fake.title`. ML Kit says its own time.
vi.mock("./ocrEngine", async (original) => ({
  ...(await original<typeof import("./ocrEngine")>()),
  createScannerOcr: async () => ({
    engine: "mlkit",
    read: async (_img: unknown, opts: { mode: string; whitelist?: string }) => {
      if (opts.mode !== "block") return { text: fake.title, confidence: 90 };
      fake.collectorReads.push({ printingsAnswered: fake.printingsAnswered });
      await fake.ocrGate;
      return { text: fake.line, confidence: 90, ms: 12 };
    },
    terminate: async () => undefined,
  }),
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
// jsdom encodes no JPEG: a struggle record goes without its images.
HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
  callback(null);
};

const { ScannerView } = await import("./ScannerView");

/** A match for the photo's card. Each test's own artwork, so the printings asked for are never another test's (printings.ts keeps them). */
const match = (name: string, art: string, score: number, index = 4, printings = 2): ArtMatch => ({ index, id: `${art}-card`, name, set: "drc", number: "19", illustrationId: art, layout: "normal", printings, score });

let root: Root;
let host: HTMLDivElement;
let skew = 0;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.assign(fake, { printings: twins, sameArt: true, printingsGate: null, printingsAnswered: false, matches: [], line: "", title: "", ocrGate: null, looked: "off" });
  fake.collectorReads.length = 0;
  fake.timings.length = 0;
  fake.records.length = 0;
  skew = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  setDiagnosticsOn(true);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  setDiagnosticsOn(false);
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
async function scanPhoto() {
  await until(() => (fake.looked === "look-v1" ? true : null), "the recognizer");
  const input = document.querySelector<HTMLInputElement>(".scan-photo-input")!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "card.jpg", { type: "image/jpeg" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
function scanner(rows?: Provisional[]) {
  const accepted: ScanCandidate[] = [];
  act(() =>
    root.render(
      <ScannerView
        autoAdd
        onAccept={async (c) => {
          accepted.push(c);
          return true;
        }}
        {...(rows ? { onUndo: async () => undefined, onProvisional: (row: Provisional) => void rows.push(row) } : {})}
      />,
    ),
  );
  return accepted;
}
/** A gate and its key. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

describe("the collector line's first read", () => {
  it("reads the view the card was named in while its printings load, and settles from that one clear read", async () => {
    fake.matches = [match("Stridehangar Automaton", "ill-first", 0.93)];
    fake.line = "R 0019\nDRC • EN AARON J. RILEY";
    const printings = gate();
    fake.printingsGate = printings.promise;
    const accepted = scanner();
    await scanPhoto();
    // The reader has the collector line before the server has answered with the printings.
    await until(() => (fake.collectorReads.length > 0 ? true : null), "a collector-line read");
    expect(fake.collectorReads[0]).toEqual({ printingsAnswered: false });
    expect(fake.printingsAnswered).toBe(false);
    await act(async () => printings.open());
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    expect(accepted[0]).toMatchObject({ scryfall_id: "p19" });
    const t = await until(() => fake.timings[0], "the timing record");
    expect(t).toMatchObject({ printing: "collector" });
    // How long the read waited after the card was named, each crop's read (the reader's time and
    // ML Kit's own), how long the printings took, and that one read settled it.
    expect(t.detail).toMatchObject({ first_settled: true, first_wait_ms: expect.any(Number), first_ms: expect.any(Number), options_ms: expect.any(Number) });
    const detail = t.detail as { first_ocr_ms: number[]; first_engine_ms: number[]; first_wait_ms: number; first_ms: number };
    expect(detail.first_ocr_ms.length).toBe(fake.collectorReads.length);
    expect(detail.first_engine_ms).toEqual(detail.first_ocr_ms.map(() => 12));
    expect(detail.first_wait_ms).toBeLessThanOrEqual(detail.first_ms);
  });

  it("reads nothing for a card with one printing: its printings are weighed first", async () => {
    fake.printings = [printing("p1", "57", "Sol Ring")];
    fake.matches = [match("Sol Ring", "ill-only", 0.93)];
    fake.line = "C 0057\nDRC • EN";
    const accepted = scanner();
    await scanPhoto();
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    await wait(50);
    expect(accepted[0]).toMatchObject({ scryfall_id: "p1" });
    expect(fake.collectorReads).toEqual([]);
    const t = await until(() => fake.timings[0], "the timing record");
    expect(t).toMatchObject({ printing: "only" });
    expect(t.detail).not.toHaveProperty("first_ms");
  });

  it("waits for the server before reading art the bundle knows in one printing, and reads it when the server knows more", async () => {
    // The bundle says one printing; the server knows a reprint newer than the bundle.
    fake.matches = [match("Stridehangar Automaton", "ill-reprint", 0.93, 4, 1)];
    fake.line = "R 0019\nDRC • EN AARON J. RILEY";
    const printings = gate();
    fake.printingsGate = printings.promise;
    const accepted = scanner();
    await scanPhoto();
    await wait(100);
    expect(fake.collectorReads).toEqual([]);
    await act(async () => printings.open());
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    expect(accepted[0]).toMatchObject({ scryfall_id: "p19" });
    expect(fake.collectorReads.every((r) => r.printingsAnswered)).toBe(true);
  });

  it("stops reading once the card is let go, and nothing it read counts", async () => {
    fake.matches = [match("Stridehangar Automaton", "ill-skip", 0.93)];
    fake.line = "R 0019\nDRC • EN AARON J. RILEY";
    const reads = gate();
    fake.ocrGate = reads.promise;
    const accepted = scanner();
    await scanPhoto();
    await until(() => (fake.collectorReads.length > 0 && fake.printingsAnswered ? true : null), "the read under way");
    const skip = await until(() => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Skip"), "Skip");
    await act(async () => skip.click());
    await act(async () => reads.open());
    await wait(100);
    // The crop under way when it was let go was the last.
    expect(fake.collectorReads).toHaveLength(1);
    expect(accepted).toEqual([]);
  });

  it("reads the view a card was named in by its title, and settles its printing from it", async () => {
    // The art isn't sure (two cards close), so the title is read; it names a card the art didn't.
    fake.matches = [match("Vineglimmer Snarl", "ill-title", 0.7, 4), match("Arcane Signet", "ill-other", 0.69, 5)];
    fake.title = "Stridehangar Automaton";
    fake.sameArt = false;
    fake.line = "R 0019\nDRC • EN AARON J. RILEY";
    const accepted = scanner();
    await scanPhoto();
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    expect(accepted[0]).toMatchObject({ name: "Stridehangar Automaton", scryfall_id: "p19" });
    expect(fake.collectorReads.length).toBeGreaterThan(0);
    const t = await until(() => fake.timings[0], "the timing record");
    expect(t).toMatchObject({ rule: "title", printing: "collector" });
    expect(t.detail).toMatchObject({ first_settled: true });
    // Its border isn't weighed: every printing of a card named by its title is a candidate.
    expect(t.detail).not.toHaveProperty("border");
  });

  it("keeps a struggle record of a printing settled 3 s or more after the card was named, with the read's timings", async () => {
    fake.matches = [match("Stridehangar Automaton", "ill-slow", 0.93)];
    fake.line = "R 0019\nDRC • EN AARON J. RILEY";
    const reads = gate();
    fake.ocrGate = reads.promise;
    const accepted = scanner();
    await scanPhoto();
    await until(() => (fake.collectorReads.length > 0 && fake.printingsAnswered ? true : null), "the read under way");
    // The reader takes its time.
    skew += 4000;
    await act(async () => reads.open());
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    const rec = await until(() => fake.records[0], "the struggle record");
    const detail = rec.detail as { reasons: string[]; printingMs: number; namedAt: number; frames: { source: string; t: number; wait?: number; ocrMs?: number[]; engineMs?: number[] }[] };
    expect(detail.reasons).toContain("slow-printing");
    expect(detail.printingMs).toBeGreaterThanOrEqual(3000);
    const first = detail.frames.find((f) => f.source === "first")!;
    expect(first.ocrMs!.length).toBeGreaterThan(0);
    expect(first.engineMs).toEqual(first.ocrMs!.map(() => 12));
    expect(first.wait).toBeGreaterThanOrEqual(0);
    // The frame's time, less when the card was named, is how long the first read took.
    expect(first.t - detail.namedAt).toBeGreaterThanOrEqual(4000);
  });

  it("keeps a slow-printing record for a card-first row settled slowly too (Codex review of #200)", async () => {
    localStorage.setItem("yama.scan.cardFirst", "1");
    fake.matches = [match("Stridehangar Automaton", "ill-row", 0.93)];
    fake.line = "R 0019\nDRC • EN AARON J. RILEY";
    const reads = gate();
    fake.ocrGate = reads.promise;
    const rows: Provisional[] = [];
    scanner(rows);
    await scanPhoto();
    const row = await until(() => rows[0], "the provisional row");
    await until(() => (fake.collectorReads.length > 0 ? true : null), "the read under way");
    skew += 4000;
    await act(async () => reads.open());
    await until(() => (row.state.phase === "settled" ? true : null), "the row to settle");
    expect(row.state).toMatchObject({ how: "collector", chosen: { scryfall_id: "p19" } });
    const rec = await until(() => fake.records[0], "the struggle record");
    expect((rec.detail as { reasons: string[] }).reasons).toContain("slow-printing");
  });

  it("keeps no slow-printing record for a printing settled at once", async () => {
    fake.matches = [match("Stridehangar Automaton", "ill-fast", 0.93)];
    fake.line = "R 0019\nDRC • EN AARON J. RILEY";
    const accepted = scanner();
    await scanPhoto();
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    await until(() => fake.timings[0], "the timing record");
    await wait(50);
    expect(fake.records).toEqual([]);
  });
});
