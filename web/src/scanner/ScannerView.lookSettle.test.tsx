// @vitest-environment jsdom
// Settling by look (look.ts `lookSettles`, ScannerView.tsx): with the look option that settles when
// sure (`look-v1-sure`, opt-in), a card whose printings share its art is settled by itself once the
// look has scored every printing and the closest leads the next by 0.10, unless the collector line
// read something pointing to another printing; it's filed as a collector-line settle is (Keep
// adding, Wrong printing), and its timing record says "look" with the lead. The default only orders
// the list, and identity-only scanners run no look. The card comes from "Use a photo" (no camera
// here), with the recognizer, the look and the text reader faked.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ArtRecognizer, BundleInfo, LookDone } from "./artClient";
import type { LookCandidate } from "./look";
import { saveModel } from "./models";
import { setDiagnosticsOn } from "./diagnostics";
import type { ScanCandidate } from "./types";

const V = "gallery-20261106T183001884398Z";
const printing = (id: string, set: string, number: string, released: string): Printing => ({
  scryfall_id: id, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: number, lang: "en",
  rarity: "common", finishes: ["nonfoil"], released_at: released, image_normal: `https://cards.scryfall.io/normal/front/${id}.jpg`, image_small: null, back_image_normal: null, artist: null,
  price_date: null, usd: null, usd_foil: null, usd_etched: null, eur: null, eur_foil: null,
});
// Newest first, as the server lists them.
const printings = [printing("p-new", "eoc", "101", "2025-08-01"), printing("p-mid", "woc", "145", "2023-09-08"), printing("p-old", "c19", "236", "2019-08-23")];
const v1File = `/scan-bundle/${V}/look-152f52c100f0.onnx`;
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
      default: "look-v1",
      options: [
        { id: "off", label: "Off", note: "" },
        { id: "look-v1", label: "Yama's look model v1", note: "", file: v1File, bytes: 9 },
        { id: "look-v1-sure", label: "Yama's look model v1, settles when sure", note: "", file: v1File, bytes: 9, settles: true },
      ],
    },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }] },
    lock: { default: "lead", options: [{ id: "lead", label: "Art that leads", note: "" }] },
  },
});

/** The timing records sent (diagnostics on). */
const timings = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, opts?: { json?: unknown }) => {
    if (path === "/api/scan/bundle?can=cuts,settle") return Promise.resolve(bundle());
    if (path.startsWith("/api/scan/printings")) return Promise.resolve({ same_art: true, printings });
    if (path === "/api/scan/diagnostics/timings") {
      timings.push(opts?.json as Record<string, unknown>);
      return Promise.resolve({ id: "t" });
    }
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));

/** The faked look: what it was asked, the scores it gives (a printing left out can't be scored), and the text reader's collector line. */
const look = vi.hoisted(() => ({
  asked: [] as { index: number; candidates: LookCandidate[] }[],
  loaded: "off",
  scores: {} as Record<string, number>,
  line: "",
  /** Holds the text reader's reads back while set. */
  ocrGate: null as Promise<void> | null,
  /** Holds the look back while set. */
  gate: null as Promise<void> | null,
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
        return look.loaded;
      },
      useLook: async (o) => void (look.loaded = o?.id ?? "off"),
      async lookAt(index, candidates, onScore) {
        look.asked.push({ index, candidates });
        await look.gate;
        let scored = 0;
        for (const c of candidates) {
          const s = look.scores[c.id];
          if (s === undefined) continue;
          onScore(c.id, s);
          scored += 1;
        }
        return { model: "look-152f52c100f0", frames: 2, queryMs: 1, scored, cached: 0, fetchMs: 1, decodeMs: 1, embedMs: 1, ms: 5 } satisfies LookDone;
      },
      // The photo: a card in the middle, its art shared by the three printings.
      identify: async () => ({
        quad: [[100, 100], [400, 100], [400, 520], [100, 520]],
        upright: 1,
        matches: [{ index: 4, id: "p-new", name: "Arcane Signet", set: "eoc", number: "101", illustrationId: "ill-signet", layout: "normal", printings: 3, score: 0.93 }],
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
// The collector line's first read gives `look.line` from every crop.
vi.mock("./ocrEngine", async (original) => ({
  ...(await original<typeof import("./ocrEngine")>()),
  createScannerOcr: async () => ({
    engine: "tesseract",
    read: async () => {
      await look.ocrGate;
      return { text: look.line, confidence: look.line ? 0.9 : 0 };
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

const { ScannerView } = await import("./ScannerView");

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  look.asked.length = 0;
  look.loaded = "off";
  // The closest (C19) well ahead of the next: 0.4.
  look.scores = { "p-old": 0.9, "p-mid": 0.5, "p-new": 0.2 };
  look.line = "";
  look.ocrGate = null;
  look.gate = null;
  timings.length = 0;
  setDiagnosticsOn(true);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  saveModel("look", null);
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
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const click = (el: HTMLElement) => act(() => el.click());
const order = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((o) => o.querySelector(".scan-printing-set")?.textContent?.split(" ")[0]);
async function scanPhoto(model: string) {
  await until(() => (look.loaded === model ? true : null), `the look model ${model}`);
  const input = document.querySelector<HTMLInputElement>(".scan-photo-input")!;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "card.jpg", { type: "image/jpeg" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
function scanner(props: { autoAdd?: boolean; identityOnly?: boolean } = {}) {
  const accepted: ScanCandidate[] = [];
  act(() =>
    root.render(
      <ScannerView
        {...props}
        onAccept={async (c) => {
          accepted.push(c);
          return true;
        }}
      />,
    ),
  );
  return accepted;
}

describe("settling by look, when chosen", () => {
  it("settles the closest printing once it leads by 0.10, Keep adding files it, and its record says look with the lead", async () => {
    saveModel("look", "look-v1-sure");
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ scryfall_id: "p-old" });
    // Every printing was compared, by its own picture.
    expect(look.asked[0]!.candidates.map((c) => c.id)).toEqual(["p-new", "p-mid", "p-old"]);
    const t = await until(() => timings[0], "the timing record");
    expect(t).toMatchObject({ outcome: "filed", printing: "look", mode: "printing", models: expect.objectContaining({ look: "look-v1-sure" }) });
    expect(t.detail).toMatchObject({ look_lead: 0.4, look_sure: true, look_option: "look-v1-sure", look_top_filed: true, auto: true });
  });

  it("doesn't settle once the person has touched the list, before the look finished", async () => {
    saveModel("look", "look-v1-sure");
    let release!: () => void;
    look.gate = new Promise((r) => (release = r));
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    await until(() => (order().length === 3 && look.asked.length ? true : null), "the printings");
    await act(async () => document.querySelector(".scan-printings")!.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    await act(async () => release());
    await wait(100);
    expect(document.querySelector(".scan-printing.is-chosen")).toBeNull();
    expect(order()).toEqual(["EOC", "WOC", "C19"]);
    expect(accepted).toEqual([]);
  });

  it("follows a switch to plain v1 made while the look runs: nothing settles", async () => {
    let release!: () => void;
    look.gate = new Promise((r) => (release = r));
    saveModel("look", "look-v1-sure");
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    await until(() => (look.asked.length ? true : null), "the look");
    act(() => saveModel("look", "look-v1"));
    await until(() => (look.loaded === "look-v1" ? true : null), "the switch");
    await act(async () => release());
    await until(() => (order()[0] === "C19" ? true : null), "the look's order");
    await wait(60);
    expect(accepted).toEqual([]);
    expect(document.querySelector(".scan-printing.is-chosen")).toBeNull();
  });

  it("settles when switched to the option while the look runs on v1's model", async () => {
    let release!: () => void;
    look.gate = new Promise((r) => (release = r));
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1");
    await until(() => (look.asked.length ? true : null), "the look");
    act(() => saveModel("look", "look-v1-sure"));
    await until(() => (look.loaded === "look-v1-sure" ? true : null), "the switch");
    await act(async () => release());
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    expect(accepted[0]).toMatchObject({ scryfall_id: "p-old" });
    const t = await until(() => timings[0], "the timing record");
    // Named under v1, weighed and settled under the option: the record says which rule applied.
    expect(t).toMatchObject({ printing: "look", models: expect.objectContaining({ look: "look-v1" }) });
    expect(t.detail).toMatchObject({ look_option: "look-v1-sure", look_sure: true });
  });

  it("shows a look settle like the scanner's other settles: chosen, with Wrong printing under More", async () => {
    saveModel("look", "look-v1-sure");
    const accepted = scanner();
    await scanPhoto("look-v1-sure");
    await until(() => document.querySelector("h3"), "the card");
    // The list goes: the printing is chosen. Nothing filed without Keep adding.
    await until(() => (document.querySelector('[role="option"]') ? null : true), "the list to close");
    await click(await until(() => button("More"), "More"));
    expect(button("Wrong printing")).toBeDefined();
    expect(button("Change printing (3)")).toBeUndefined();
    expect(accepted).toEqual([]);
    await click(button("Add")!);
    expect(accepted[0]).toMatchObject({ scryfall_id: "p-old" });
  });

  it("Wrong printing after a look settle reopens the list with it marked and last, never settles it again, and counts the correction", async () => {
    saveModel("look", "look-v1-sure");
    const accepted = scanner();
    await scanPhoto("look-v1-sure");
    await click(await until(() => button("More"), "More"));
    await click(await until(() => button("Wrong printing"), "Wrong printing"));
    const marked = await until(() => document.querySelector(".scan-misread"), "the misread mark");
    expect(marked.textContent).toBe("Read as this");
    expect(marked.closest('[role="option"]')?.textContent).toContain("C19");
    // The look's order with the printing said to be wrong last, and nothing settled again.
    await until(() => (order().join() === "WOC,EOC,C19" ? true : null), "the look's order without the misread");
    await wait(60);
    expect(document.querySelector(".scan-printing.is-chosen")).toBeNull();
    expect(document.querySelector(".scan-printing.is-look")?.textContent).toContain("WOC");
    expect(accepted).toEqual([]);
    const options = document.querySelectorAll<HTMLElement>('[role="option"]');
    await click([...options].find((o) => o.textContent?.includes("WOC"))!);
    expect(accepted[0]).toMatchObject({ scryfall_id: "p-mid" });
    const t = await until(() => timings[0], "the timing record");
    expect(t).toMatchObject({ printing: "corrected" });
    expect(t.detail).toMatchObject({ printing_rejected: "look", look_lead: 0.4 });
  });

  it("leaves strict twins to the collector line: a lead under 0.10 only orders the list", async () => {
    saveModel("look", "look-v1-sure");
    look.scores = { "p-old": 0.9, "p-mid": 0.86, "p-new": 0.2 };
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    await until(() => (order()[0] === "C19" ? true : null), "the look's order");
    await wait(60);
    expect(order()).toEqual(["C19", "WOC", "EOC"]);
    expect(document.querySelector(".scan-printing.is-look")?.textContent).toContain("Looks closest");
    expect(document.querySelector(".scan-printing.is-chosen")).toBeNull();
    expect(accepted).toEqual([]);
  });

  it("settles nothing when a printing couldn't be scored", async () => {
    saveModel("look", "look-v1-sure");
    look.scores = { "p-old": 0.9, "p-mid": 0.2 };
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    await until(() => (order()[0] === "C19" ? true : null), "the look's order");
    await wait(60);
    expect(document.querySelector(".scan-printing.is-chosen")).toBeNull();
    expect(accepted).toEqual([]);
  });

  it("never settles against what the collector line read: another printing's set code read exactly", async () => {
    saveModel("look", "look-v1-sure");
    look.line = "WOC • EN";
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    await until(() => (order().length === 3 && look.asked.length ? true : null), "the printings");
    await wait(100);
    expect(document.querySelector(".scan-printing.is-chosen")).toBeNull();
    expect(accepted).toEqual([]);
    // Recorded as a lead the rule refused, for the default's comparison too.
    const options = document.querySelectorAll<HTMLElement>('[role="option"]');
    await click([...options].find((o) => o.textContent?.includes("WOC"))!);
    const t = await until(() => timings[0], "the timing record");
    expect(t.detail).toMatchObject({ look_lead: 0.4, look_sure: false });
  });

  it("waits for the collector line's first read before settling: a look done first doesn't settle against what it then reads", async () => {
    saveModel("look", "look-v1-sure");
    let release!: () => void;
    look.ocrGate = new Promise((r) => (release = r));
    look.line = "WOC • EN";
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    // The look has finished while the first read is held back: nothing settled yet.
    await until(() => (look.asked.length ? true : null), "the look");
    await wait(100);
    expect(accepted).toEqual([]);
    await act(async () => release());
    await until(() => (order().length === 3 ? true : null), "the printings");
    await wait(100);
    expect(document.querySelector(".scan-printing.is-chosen")).toBeNull();
    expect(accepted).toEqual([]);
  });

  it("settles once the first read is done when it agrees", async () => {
    saveModel("look", "look-v1-sure");
    let release!: () => void;
    look.ocrGate = new Promise((r) => (release = r));
    look.line = "C19 • EN";
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    await until(() => (look.asked.length ? true : null), "the look");
    await wait(100);
    expect(accepted).toEqual([]);
    await act(async () => release());
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    expect(accepted[0]).toMatchObject({ scryfall_id: "p-old" });
  });

  it("settles when the collector line's read agrees with the look", async () => {
    saveModel("look", "look-v1-sure");
    look.line = "C19 • EN";
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    expect(accepted[0]).toMatchObject({ scryfall_id: "p-old" });
    expect(await until(() => timings[0], "the timing record")).toMatchObject({ printing: "look" });
  });

  it("leaves a printing the collector line settled as the collector line's", async () => {
    saveModel("look", "look-v1-sure");
    look.line = "0236 C\nC19 • EN";
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1-sure");
    await until(() => (accepted.length ? accepted : null), "the card filed by itself");
    expect(accepted[0]).toMatchObject({ scryfall_id: "p-old" });
    expect(await until(() => timings[0], "the timing record")).toMatchObject({ printing: "collector" });
  });
});

describe("the look's default, and scanners where only the card matters", () => {
  it("the default only orders the list, and its record keeps the lead the look had for measuring", async () => {
    const accepted = scanner({ autoAdd: true });
    await scanPhoto("look-v1");
    await until(() => (order()[0] === "C19" ? true : null), "the look's order");
    await wait(60);
    expect(document.querySelector(".scan-printing.is-chosen")).toBeNull();
    expect(accepted).toEqual([]);
    const options = document.querySelectorAll<HTMLElement>('[role="option"]');
    await click([...options].find((o) => o.textContent?.includes("WOC"))!);
    expect(accepted[0]).toMatchObject({ scryfall_id: "p-mid" });
    const t = await until(() => timings[0], "the timing record");
    expect(t).toMatchObject({ printing: "picked", models: expect.objectContaining({ look: "look-v1" }) });
    // What the rule would have done here: settled C19, which wasn't the printing filed.
    expect(t.detail).toMatchObject({ look_lead: 0.4, look_sure: true, look_option: "look-v1", look_top_filed: false });
  });

  it("runs no look in an identity-only scanner, whatever was chosen", async () => {
    saveModel("look", "look-v1-sure");
    const accepted = scanner({ autoAdd: true, identityOnly: true });
    await until(() => document.querySelector(".scan-photo-input"), "the scanner");
    await wait(100);
    expect(look.loaded).toBe("off");
    const input = document.querySelector<HTMLInputElement>(".scan-photo-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "card.jpg", { type: "image/jpeg" })] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await until(() => (accepted.length ? accepted : null), "the card counted");
    expect(look.asked).toEqual([]);
    const t = await until(() => timings[0], "the timing record");
    expect(t).toMatchObject({ mode: "identity" });
    expect(t.printing).toBeUndefined();
    expect(t.detail).not.toHaveProperty("look_lead");
  });
});
