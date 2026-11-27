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
  /** The art read in the app: loads, and each read asked of it (frame number, corners in the frame's pixels). */
  artLoads: 0,
  artUnloads: 0,
  finderUnloads: 0,
  artFails: false,
  embeds: [] as { seq: number; quad: Quad }[],
  embedGone: false,
  score: 0.93,
  /** Where the app's finder spent a frame, as an APK from 22 Nov 2026 says (none before). */
  stages: {} as { convertMs?: number; waitMs?: number; cutWaitMs?: number; copyMs?: number },
  /** The lens saved on the device, each lens the app's camera was opened with, and one that won't open. */
  lens: "auto",
  opened: [] as string[],
  failLens: null as string | null,
  /** What the app's camera says of itself (its lenses, nearest focus): null for nothing. */
  described: null as unknown,
  /** Focus on the collector line: saved on the device, asked as each camera opened, and each change asked later. */
  lineFocus: true,
  openedLine: [] as (boolean | undefined)[],
  lineSets: [] as boolean[],
}));

vi.mock("./nativeCamera", async (original) => {
  const real = await original<typeof import("./nativeCamera")>();
  return {
    ...real,
    nativeCameraAvailable: () => true,
    savedNativeCamera: () => ({ on: true, lens: nat.lens, fps: 30, torchLevel: null, exposure: 0, lineFocus: nat.lineFocus }),
    nativeFinderAbility: async () => ({ finder: true }),
    loadNativeFinder: async () => {
      nat.loads += 1;
      if (nat.failLoad) throw new Error("the model wouldn't load");
      return { loadMs: 5, sent: false };
    },
    unloadNativeFinder: async () => {
      nat.finderUnloads += 1;
    },
    loadNativeArt: async () => {
      nat.artLoads += 1;
      if (nat.artFails) throw new Error("the art model wouldn't load");
      return { loadMs: 9, sent: false };
    },
    unloadNativeArt: async () => {
      nat.artUnloads += 1;
    },
    nativeEmbed: async (seq: number, quad: Quad) => {
      nat.embeds.push({ seq, quad });
      if (nat.embedGone) throw new Error(real.NATIVE_GONE);
      return { data: new Float32Array(4), rows: 1, dim: 4, ms: 6 };
    },
    openNativeCamera: (el: HTMLCanvasElement, req: { lens: string; lineFocus?: boolean }) => {
      Object.defineProperty(el, "videoWidth", { configurable: true, get: () => 640 });
      Object.defineProperty(el, "videoHeight", { configurable: true, get: () => 1138 });
      const info = { source: "native" as const, width: 2160, height: 3840 };
      nat.opened.push(req.lens);
      nat.openedLine.push(req.lineFocus);
      return {
        kind: "native" as const,
        ready: nat.failLens === req.lens ? Promise.reject(new Error("that lens wouldn't bind")) : Promise.resolve(info),
        frame: () => el,
        fullScale: () => 3.375,
        around: async (quad: Quad) => ({ image: { width: 4, height: 4, data: new Uint8ClampedArray(64) }, quad }),
        region: async () => ({ width: 4, height: 4, data: new Uint8ClampedArray(64) }),
        track: () => null,
        info: () => info,
        described: () => nat.described,
        setTorchLevel: async () => undefined,
        setLineFocus: async (on: boolean) => {
          nat.lineSets.push(on);
        },
        followLine: () => undefined,
        bench: async () => [],
        found: () => (nat.on ? { state: nat.state, quad: nat.state === real.FOUND_CARD ? quadAt(100) : null, vote: 1, ms: 8, passes: 1, ageMs: 3, seq: 41 } : null),
        setFinder: async (o: { on?: boolean; outline?: boolean }) => {
          nat.sets.push(o);
          if (o.on !== undefined) nat.on = o.on;
          return { loaded: true, on: nat.on, ...(nat.state === real.FOUND_FAILED ? { failed: "The app's card finder stopped: out of memory" } : {}) };
        },
        finderStatus: () => ({ loaded: true, on: nat.on, ms: 8, fps: 30, ...nat.stages, ...(nat.state === real.FOUND_FAILED ? { failed: "The app's card finder stopped: out of memory" } : {}) }),
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
        // As the worker does: the art read where it's asked to be read.
        let remote: { reads: number; ms: number[]; failed?: string } | undefined;
        if (opts?.remote && handed.quad) {
          remote = { reads: 0, ms: [] };
          try {
            const got = await opts.remote(handed.quad, undefined);
            remote.reads += 1;
            if (got.ms != null) remote.ms.push(got.ms);
          } catch (e) {
            remote.failed = e instanceof Error ? e.message : String(e);
          }
        }
        return { ...match(handed.quad), ...(remote ? { remote } : {}) };
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
  Object.assign(nat, { state: 1, loads: 0, failLoad: false, on: false, sets: [], matched: [], identified: 0, order: [], score: 0.93, artLoads: 0, artUnloads: 0, finderUnloads: 0, artFails: false, embeds: [], embedGone: false, lens: "auto", opened: [], failLens: null, described: null, stages: {}, lineFocus: true, openedLine: [], lineSets: [] });
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

describe("focusing on the collector line (27 Nov 2026)", () => {
  it("is asked for as the app's camera opens in a collection scan, and not in a deck or box scan", async () => {
    act(() => root.render(<ScannerView closeups={false} onAccept={async () => true} />));
    await until(() => (nat.openedLine.length ? true : null), "the app's camera opened");
    expect(nat.openedLine).toEqual([true]);
    act(() => root.unmount());
    root = createRoot(host);
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.openedLine.length > 1 ? true : null), "the app's camera opened again");
    expect(nat.openedLine[1]).toBe(false);
    // Opened as it was wanted: nothing more to tell the camera.
    expect(nat.lineSets).toEqual([]);
  });

  it("is turned off and on again from Scan settings without opening the camera again", async () => {
    act(() => root.render(<ScannerView closeups={false} onAccept={async () => true} />));
    await until(() => (nat.openedLine.length ? true : null), "the app's camera opened");
    await act(async () => (await until(() => document.querySelector<HTMLButtonElement>('button[aria-label="Scan settings"]'), "the gear")).click());
    const box = await until(() => document.querySelector<HTMLInputElement>("#scan-line-focus"), "the switch");
    expect(box.checked).toBe(true);
    await act(async () => box.click());
    await until(() => (nat.lineSets.length ? true : null), "the camera told");
    await act(async () => document.querySelector<HTMLInputElement>("#scan-line-focus")!.click());
    await until(() => (nat.lineSets.length > 1 ? true : null), "the camera told again");
    expect(nat.lineSets).toEqual([false, true]);
    expect(nat.openedLine).toEqual([true]);
  });

  it("isn't asked for where it's turned off on this device", async () => {
    nat.lineFocus = false;
    act(() => root.render(<ScannerView closeups={false} onAccept={async () => true} />));
    await until(() => (nat.openedLine.length ? true : null), "the app's camera opened");
    expect(nat.openedLine).toEqual([false]);
  });

  it("says in the timing record whether autofocus followed the line, and why not", async () => {
    localStorage.setItem("yama.scan.diagnostics", "1");
    nat.described = { lineFocus: { asked: true, on: false, why: "Only with the lens on Automatic.", moves: 0 } };
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly autoAdd closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 1 ? true : null), "a frame matched at the app's corners");
    nat.score = 0.93;
    await until(() => (sent.timings.length > 0 ? true : null), "a timing record");
    const d = sent.timings[0]!.detail as Record<string, unknown>;
    expect(d.line_focus).toBe(false);
    expect(d.line_focus_why).toBe("Only with the lens on Automatic.");
  });

  it("says nothing of it in the timing record where it wasn't asked for, or the app doesn't say", async () => {
    localStorage.setItem("yama.scan.diagnostics", "1");
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly autoAdd closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 1 ? true : null), "a frame matched at the app's corners");
    nat.score = 0.93;
    await until(() => (sent.timings.length > 0 ? true : null), "a timing record");
    expect(Object.keys(sent.timings[0]!.detail as object).filter((k) => k.startsWith("line_focus"))).toEqual([]);
  });
});

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

  it("draws no outline of its own over the app's while the app's finder draws, even on a frame it didn't hand over (23 Nov 2026)", async () => {
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 2 ? true : null), "frames matched at the app's corners");
    // Frames the app's finder hands nothing with (it restarting after a card, a frame it timed out
    // on): the web view's finder reads them, but its outline isn't drawn beside the app's.
    nat.state = 0;
    const before = nat.identified;
    await until(() => (nat.identified >= before + 3 ? true : null), "frames read by the web view's finder");
    await wait(100);
    const drawn = [...document.querySelectorAll(".scan-outline g")].map((g) => Number(g.getAttribute("opacity") ?? "0"));
    expect(drawn.every((o) => o === 0)).toBe(true);
  });

  it("gives the finding back to the web view for the session when it fails", async () => {
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 2 ? true : null), "frames matched at the app's corners");
    const unloadsBefore = nat.finderUnloads;
    nat.state = 3;
    await until(() => (nat.identified >= 3 ? true : null), "the web view's finder running");
    const matched = nat.matched.length;
    await wait(200);
    expect(nat.matched.length).toBe(matched);
    expect(nat.loads).toBe(1);
    // And the app lets the finder's model go, now it won't run this session.
    expect(nat.finderUnloads).toBeGreaterThan(unloadsBefore);
  });

  it("says in the timing record that the web view's finder ran because the app's stopped", async () => {
    localStorage.setItem("yama.scan.diagnostics", "1");
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly autoAdd closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 1 ? true : null), "a frame matched at the app's corners");
    nat.state = 3;
    await until(() => (nat.identified >= 2 ? true : null), "the web view's finder running");
    nat.score = 0.93;
    await until(() => (sent.timings.length > 0 ? true : null), "a timing record");
    const t = sent.timings[0]!;
    expect((t.models as Record<string, string>).detector).toBe("bundle-detector");
    expect((t.detail as Record<string, unknown>).finder_fallback).toBe("The app's card finder stopped: out of memory");
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
    // An APK from before the loop's stage timings says none, and the record has none.
    expect(Object.keys(t.detail as object).filter((k) => /convert|wait|copy/.test(k))).toEqual([]);
  });

  it("records where the app's finder spends a frame, when the app says", async () => {
    localStorage.setItem("yama.scan.diagnostics", "1");
    nat.stages = { convertMs: 9.5, waitMs: 3.1, cutWaitMs: 0, copyMs: 4.2 };
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly autoAdd closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 1 ? true : null), "a frame matched at the app's corners");
    nat.score = 0.93;
    await until(() => (sent.timings.length > 0 ? true : null), "a timing record");
    const d = sent.timings[0]!.detail as Record<string, unknown>;
    expect([d.finder_convert_ms, d.finder_wait_ms, d.finder_cut_wait_ms, d.camera_copy_ms]).toEqual([9.5, 3.1, 0, 4.2]);
  });

  it("reads the art in the app too, of the frame the app's finder found the card on, and names it in the record", async () => {
    localStorage.setItem("yama.scan.diagnostics", "1");
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly autoAdd closeups={false} onAccept={async () => true} />));
    await until(() => (nat.embeds.length >= 2 ? true : null), "art read in the app");
    expect(nat.artLoads).toBe(1);
    // That frame, and the corners in its own pixels (the recognizer's here are the whole canvas).
    expect(nat.embeds[0]).toEqual({ seq: 41, quad: quadAt(100) });
    nat.score = 0.93;
    await until(() => (sent.timings.length > 0 ? true : null), "a timing record");
    const t = sent.timings[0]!;
    expect((t.models as Record<string, string>).art).toBe("bundle-native");
    expect((t.detail as Record<string, unknown>).art_ms).toBe(6);
  });

  it("goes on reading the art in the app after a frame it no longer had", async () => {
    nat.score = 0.2;
    nat.embedGone = true;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.embeds.length >= 3 ? true : null), "reads asked of the app despite frames it no longer had");
    nat.embedGone = false;
    const before = nat.embeds.length;
    await until(() => (nat.embeds.length > before + 1 ? true : null), "more reads in the app");
  });

  it("doesn't read the art in the app when that's turned off, or when its model won't load", async () => {
    nat.score = 0.2;
    localStorage.setItem("yama.scan.native", JSON.stringify({ art: false }));
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 3 ? true : null), "frames matched at the app's corners");
    expect(nat.artLoads).toBe(0);
    expect(nat.embeds).toEqual([]);
    // And the app lets the art model go (it keeps no crops for it).
    expect(nat.artUnloads).toBeGreaterThan(0);
    act(() => root.unmount());
    localStorage.clear();
    root = createRoot(host);
    Object.assign(nat, { matched: [], artFails: true, on: false });
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 3 ? true : null), "frames matched at the app's corners");
    expect(nat.artLoads).toBe(1);
    expect(nat.embeds).toEqual([]);
  });

  it("stops reading the art in the app for the session after a read fails, and lets its model go", async () => {
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.embeds.length >= 1 ? true : null), "art read in the app");
    nat.embedGone = false;
    // Every read from now on fails.
    const reads = nat.embeds.length;
    Object.assign(nat, { embedGone: false });
    const failing = vi.fn();
    nat.embeds.push = ((...items: { seq: number; quad: Quad }[]) => {
      failing();
      throw new Error("the app's art reader crashed");
      return items.length;
    }) as typeof nat.embeds.push;
    await until(() => (failing.mock.calls.length >= 1 ? true : null), "a failed read");
    await until(() => (nat.artUnloads > 0 ? true : null), "the art model let go");
    const failed = failing.mock.calls.length;
    await wait(300);
    // No more reads asked of the app.
    expect(failing.mock.calls.length).toBe(failed);
    expect(nat.embeds.length).toBe(reads);
  });

  it("names the worker as the art's reader in the record when the app didn't read it", async () => {
    localStorage.setItem("yama.scan.diagnostics", "1");
    localStorage.setItem("yama.scan.native", JSON.stringify({ art: false }));
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly autoAdd closeups={false} onAccept={async () => true} />));
    await until(() => (nat.matched.length >= 1 ? true : null), "a frame matched at the app's corners");
    nat.score = 0.93;
    await until(() => (sent.timings.length > 0 ? true : null), "a timing record");
    const t = sent.timings[0]!;
    expect((t.models as Record<string, string>).detector).toBe("bundle-detector-native");
    expect((t.models as Record<string, string>).art).toBe("bundle");
    expect((t.detail as Record<string, unknown>).art_ms).toBeUndefined();
  });
});

describe("the app's camera lens (Bryan, 22 Nov 2026: up close on Automatic it 'looks a little distorted')", { timeout: 20_000 }, () => {
  it("opens on Automatic when the lens of its own won't open, before trying the browser's camera", async () => {
    nat.lens = "main";
    nat.failLens = "main";
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (nat.opened.includes("auto") ? true : null), "the app's camera on Automatic");
    expect(nat.opened).toEqual(["main", "auto"]);
    // And it scans with it: frames are matched at the app's corners.
    await until(() => (nat.matched.length >= 1 ? true : null), "a frame read");
  });

  it("asks for a little more room when the card is nearer than the main lens focuses", async () => {
    nat.lens = "main";
    // The app's finder hands a card 420 of the frame's 1138 px tall (quadAt): about 16.5 cm away for
    // a 24 mm lens (closer.ts), nearer than this lens's 20 cm.
    nat.described = { lens: "main", lenses: [{ lens: "main", equivalent: 24 }], focusNearest: 0.2 };
    nat.score = 0.2;
    act(() => root.render(<ScannerView identityOnly closeups={false} onAccept={async () => true} />));
    await until(() => (document.querySelector(".scan-chip")?.textContent === "Hold the phone a little further away" ? true : null), "further away");
    // A phone that lists no lenses: its one camera's figures, though the app says Automatic (Codex review of #202).
    nat.described = { lens: "auto", lenses: [], equivalent: 24, focusNearest: 0.2 };
    await wait(300);
    expect(document.querySelector(".scan-chip")?.textContent).toBe("Hold the phone a little further away");
    // Automatic over several lenses: its figures mix them, so nothing is said from them.
    nat.described = { lens: "auto", lenses: [{ lens: "main", equivalent: 24 }, { lens: "ultrawide", equivalent: 13 }], equivalent: 24, focusNearest: 0.2 };
    await until(() => (document.querySelector(".scan-chip")?.textContent !== "Hold the phone a little further away" ? true : null), "no hint on Automatic");
    nat.described = { lens: "main", lenses: [{ lens: "main", equivalent: 24 }], focusNearest: 0.2 };
    await until(() => (document.querySelector(".scan-chip")?.textContent === "Hold the phone a little further away" ? true : null), "further away again");
    // A lens that focuses as near as 15 cm: nothing said.
    nat.described = { lens: "main", lenses: [{ lens: "main", equivalent: 24 }], focusNearest: 0.15 };
    await until(() => (document.querySelector(".scan-chip")?.textContent !== "Hold the phone a little further away" ? true : null), "the hint gone");
  });
});
