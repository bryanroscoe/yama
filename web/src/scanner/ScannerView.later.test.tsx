// @vitest-environment jsdom
// Stage 5 of docs/plans/scanner-match-cardvision.md in the scanner itself:
// - Card first, printing after (item 22, opt-in): a card named before its printing is settled is
//   handed to the host at once as a provisional row and scanning goes on; its printing is worked
//   out after (the collector line of the view it was named in, the look, the border, the set lock)
//   and the row settles itself, or waits for a pick. Nothing is filed unsettled; Undo drops it.
// - Tie by price (item 26, opt-in): printings it can't tell apart, priced within 15%, settle as the
//   dearest, marked "by price".
// - Border colour (item 24): a border read surely rules out printings of the other colour.
// The card comes from "Use a photo" (no camera here), with the recognizer, the look and the text
// reader faked, as in ScannerView.lookSettle.test.tsx.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Printing } from "../api";
import type { ArtRecognizer, BundleInfo, LookDone } from "./artClient";
import type { Provisional } from "./later";
import { setDiagnosticsOn } from "./diagnostics";
import type { ScanCandidate } from "./types";

const V = "gallery-20261106T183001884398Z";
const printing = (id: string, set: string, number: string, released: string, extra: Partial<Printing> = {}): Printing => ({
  scryfall_id: id, oracle_id: "o", name: "Arcane Signet", set_code: set, set_name: `Set ${set.toUpperCase()}`, collector_number: number, lang: "en",
  rarity: "common", finishes: ["nonfoil"], released_at: released, image_normal: `https://cards.scryfall.io/normal/front/${id}.jpg`, image_small: null, back_image_normal: null, artist: null,
  price_date: "2026-11-20", usd: null, usd_foil: null, usd_etched: null, eur: null, eur_foil: null, ...extra,
});

const state = vi.hoisted(() => ({
  printings: [] as unknown[],
  line: "",
  /** Holds the text reader's reads back while set. */
  ocrGate: null as Promise<void> | null,
  timings: [] as Record<string, unknown>[],
  samples: [] as { label_scryfall_id?: string; kind: string }[],
  /** Draw a black-bordered card on a light table in the photo's view of the card. */
  drawCard: false,
  /** The artwork matched: one per test, as printings.ts keeps each artwork's printings for the session. */
  ill: 0,
  /** Whether the printings share the art (false: a card's every printing, as for a title read). */
  sameArt: true,
}));
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
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, opts?: { json?: unknown }) => {
    if (path === "/api/scan/bundle?can=cuts,settle") return Promise.resolve(bundle());
    if (path.startsWith("/api/scan/printings")) return Promise.resolve({ same_art: state.sameArt, printings: state.printings });
    if (path === "/api/scan/diagnostics/timings") {
      state.timings.push(opts?.json as Record<string, unknown>);
      return Promise.resolve({ id: "t" });
    }
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));
vi.mock("./samples", async (original) => ({
  ...(await original<typeof import("./samples")>()),
  keepSample: async (_shot: unknown, label: { label_scryfall_id?: string; kind: string }) => void state.samples.push(label),
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
      look: "off",
      useLook: async () => undefined,
      lookAt: async () => ({ model: "m", frames: 1, queryMs: 1, scored: 0, cached: 0, fetchMs: 1, decodeMs: 1, embedMs: 1, ms: 1 }) satisfies LookDone,
      keepLook: async () => [],
      // The photo: a card in the middle, its art shared by the printings.
      identify: async () => ({
        quad: [[100, 100], [400, 100], [400, 520], [100, 520]],
        upright: 1,
        matches: [{ index: 4, id: "p-new", name: "Arcane Signet", set: "eoc", number: "101", illustrationId: `ill-signet-${state.ill}`, layout: "normal", printings: 3, score: 0.93 }],
        timings: { detectMs: 1, embedMs: 1, totalMs: 2 },
      }),
      locate: () => new Promise(() => undefined),
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
  createScannerOcr: async () => ({
    engine: "tesseract",
    read: async () => {
      await state.ocrGate;
      return { text: state.line, confidence: state.line ? 0.9 : 0 };
    },
    terminate: async () => undefined,
  }),
}));
vi.mock("./sounds", async (original) => ({ ...(await original<typeof import("./sounds")>()), playScanSound: () => undefined, playPriceSound: () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => undefined;
vi.stubGlobal("Worker", class {});
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
/**
 * The photo's view of the card (`around` in ScannerView: the card's quad padded by 8%, 368 × 488):
 * with `drawCard`, a light table, a black border 3.5% of the card's width, and art inside.
 */
function view(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  if (!state.drawCard || w !== 368 || h !== 488) return data;
  const [x0, y0, x1, y1] = [34, 34, 334, 454];
  const bw = 0.035 * (x1 - x0);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const card = i >= x0 && i < x1 && j >= y0 && j < y1;
      const art = i >= x0 + bw && i < x1 - bw && j >= y0 + bw && j < y1 - bw;
      const c = !card ? [205, 205, 200] : art ? [(i * 37) % 255, (j * 71) % 255, ((i + j) * 5) % 255] : [16, 16, 18];
      data.set([...c, 255], (j * w + i) * 4);
    }
  return data;
}
HTMLCanvasElement.prototype.getContext = function () {
  return {
    drawImage: () => undefined,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: view(w, h) }),
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
  state.printings = [printing("p-new", "eoc", "101", "2025-08-01"), printing("p-mid", "woc", "145", "2023-09-08"), printing("p-old", "c19", "236", "2019-08-23")];
  state.line = "";
  state.ocrGate = null;
  state.timings.length = 0;
  state.samples.length = 0;
  state.drawCard = false;
  state.ill += 1;
  state.sameArt = true;
  setDiagnosticsOn(true);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setDiagnosticsOn(false);
  localStorage.clear();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until<T>(get: () => T | null | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 150; i += 1) {
    const v = get();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`never saw ${what}`);
}
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const click = (el: HTMLElement) => act(() => el.click());
async function scanPhoto() {
  const input = await until(() => document.querySelector<HTMLInputElement>(".scan-photo-input"), "the photo input");
  // The recognizer has loaded (its settings line says so) before the photo is read.
  await wait(30);
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["photo"], "card.jpg", { type: "image/jpeg" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
function scanner(props: { autoAdd?: boolean; withRows?: boolean } = {}) {
  const accepted: ScanCandidate[] = [];
  const rows: Provisional[] = [];
  act(() =>
    root.render(
      <ScannerView
        autoAdd={props.autoAdd}
        onAccept={async (c) => {
          accepted.push(c);
          return true;
        }}
        onUndo={async () => undefined}
        onProvisional={props.withRows === false ? undefined : (row) => void rows.push(row)}
      />,
    ),
  );
  return { accepted, rows };
}

describe("card first, printing after (opt-in)", () => {
  beforeEach(() => localStorage.setItem("yama.scan.cardFirst", "1"));

  it("with Keep adding, hands the card over at once and settles its row from the collector line it was named with", async () => {
    state.line = "0145 R\nWOC • EN";
    const { accepted, rows } = scanner({ autoAdd: true });
    await scanPhoto();
    const row = await until(() => rows[0], "the provisional row");
    expect(row.card).toMatchObject({ name: "Arcane Signet", scryfall_id: undefined });
    // The scanner goes on: no sheet waits on this card, and nothing was filed unsettled.
    expect(document.querySelector(".scan-result")).toBeNull();
    expect(accepted).toEqual([]);
    await until(() => row.state.phase === "settled", "the row to settle");
    expect(row.state).toMatchObject({ how: "collector", chosen: { scryfall_id: "p-mid" }, filed: { scryfall_id: "p-mid", set: "woc", number: "145" } });
    // "Added" only once the host says it saved it (Codex review of #195).
    expect(document.body.textContent).toContain("finding the printing");
    act(() => row.saved(true));
    await until(() => document.body.textContent?.includes("Added Arcane Signet (WOC 145)"), "Added, once saved");
    // The host saves it (the row's filed card), not onAccept; the photo is kept with its final label.
    expect(accepted).toEqual([]);
    await until(() => state.samples.length > 0, "the scan photo");
    expect(state.samples[0]).toMatchObject({ kind: "added", label_scryfall_id: "p-mid" });
    // Its timing record: the row came long before the printing.
    const t = await until(() => state.timings.find((x) => x.printing === "collector"), "the timing record");
    const detail = t.detail as Record<string, unknown>;
    expect(detail.rows).toBe("card-first");
    expect(detail.auto).toBe(true);
    expect(detail.row_ms as number).toBeLessThanOrEqual(t.printing_ms as number);
  });

  it("says a settled row couldn't be saved when the host couldn't, rather than Added", async () => {
    state.printings = [printing("p-only", "woc", "145", "2023-09-08")];
    const { rows } = scanner({ autoAdd: true });
    await scanPhoto();
    const row = await until(() => rows[0], "the provisional row");
    await until(() => row.state.phase === "settled", "the row to settle");
    act(() => row.saved(false));
    await until(() => document.body.textContent?.includes("Couldn't save Arcane Signet (WOC 145)"), "the failed save");
  });

  it("settles a card with one printing at once, as the only one", async () => {
    state.printings = [printing("p-only", "woc", "145", "2023-09-08")];
    const { rows } = scanner({ autoAdd: true });
    await scanPhoto();
    const row = await until(() => rows[0], "the provisional row");
    await until(() => row.state.phase === "settled", "the row to settle");
    expect(row.state.how).toBe("only");
  });

  it("leaves a row the scanner can't settle waiting for a pick, which then settles it", async () => {
    const { rows } = scanner({ autoAdd: true });
    await scanPhoto();
    const row = await until(() => rows[0], "the provisional row");
    await until(() => row.state.phase === "pick", "the row to wait for a pick", );
    expect(row.state.options?.map((p) => p.scryfall_id)).toEqual(["p-new", "p-mid", "p-old"]);
    act(() => void row.pick(row.state.options![2]!));
    expect(row.state).toMatchObject({ phase: "settled", how: "picked", filed: { scryfall_id: "p-old" } });
    await until(() => state.samples.length > 0, "the scan photo");
    expect(state.samples[0]).toMatchObject({ label_scryfall_id: "p-old" });
    const t = await until(() => state.timings.find((x) => x.outcome === "picked"), "the timing record");
    expect(t.printing).toBe("picked");
  });

  it("drops a row taken back out (Undo) before its printing settles: nothing is filed", async () => {
    state.ocrGate = new Promise(() => undefined);
    const { accepted, rows } = scanner({ autoAdd: true });
    await scanPhoto();
    const row = await until(() => rows[0], "the provisional row");
    expect(row.state.phase).toBe("finding");
    await click(await until(() => button("Undo"), "Undo"));
    expect(row.state.phase).toBe("dropped");
    expect(accepted).toEqual([]);
    await until(() => document.body.textContent?.includes("Took out Arcane Signet"), "Took out");
  });

  it("without Keep adding, Add files the card first while its printing is still being read", async () => {
    let release = () => undefined as void;
    state.ocrGate = new Promise<void>((r) => (release = r));
    state.line = "0145 R\nWOC • EN";
    const { accepted, rows } = scanner();
    await scanPhoto();
    const add = await until(() => button("Add"), "Add, ready before the printing");
    expect(add.disabled).toBe(false);
    await click(add);
    const row = await until(() => rows[0], "the provisional row");
    expect(row.auto).toBe(false);
    await act(async () => release());
    await until(() => row.state.phase === "settled", "the row to settle");
    expect(row.state.how).toBe("collector");
    expect(accepted).toEqual([]);
  });

  it("is offered in Scan settings only where the host keeps rows, off by default", async () => {
    localStorage.removeItem("yama.scan.cardFirst");
    scanner();
    await click(await until(() => document.querySelector<HTMLButtonElement>('button[aria-label="Scan settings"]'), "the gear"));
    const box = await until(() => document.querySelector<HTMLInputElement>("#scan-card-first"), "the Card first switch");
    expect(box.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#scan-tie-price")?.checked).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#scan-by-price")?.checked).toBe(true);
    act(() => root.unmount());
    root = createRoot(host);
    scanner({ withRows: false });
    await click(await until(() => document.querySelector<HTMLButtonElement>('button[aria-label="Scan settings"]'), "the gear"));
    await until(() => document.querySelector("#scan-tie-price"), "the settings");
    expect(document.querySelector("#scan-card-first")).toBeNull();
  });
});

describe("card first off (the default)", () => {
  it("keeps the card in the sheet until its printing settles, as before: no provisional row", async () => {
    const { accepted, rows } = scanner({ autoAdd: true });
    await scanPhoto();
    await until(() => document.body.textContent?.includes("Tap your printing"), "the picker");
    expect(rows).toEqual([]);
    expect(accepted).toEqual([]);
    expect(button("Add")).toBeUndefined();
  });
});

describe("tie by price (opt-in)", () => {
  beforeEach(() => {
    state.printings = [
      printing("p-new", "eoc", "101", "2025-08-01", { usd: 1.0 }),
      printing("p-mid", "woc", "145", "2023-09-08", { usd: 1.1 }),
      printing("p-old", "c19", "236", "2019-08-23", { usd: 1.05 }),
    ];
  });

  it("files the dearest of printings it can't tell apart, priced within 15%, marked by price (Keep adding)", async () => {
    localStorage.setItem("yama.scan.tieByPrice", "1");
    const { accepted } = scanner({ autoAdd: true });
    await scanPhoto();
    const c = await until(() => accepted[0], "the card filed");
    expect(c).toMatchObject({ scryfall_id: "p-mid", byPrice: true });
    const t = await until(() => state.timings.find((x) => x.outcome === "filed"), "the timing record");
    expect(t.printing).toBe("price");
  });

  it("settles a provisional row by price too", async () => {
    localStorage.setItem("yama.scan.tieByPrice", "1");
    localStorage.setItem("yama.scan.cardFirst", "1");
    const { rows } = scanner({ autoAdd: true });
    await scanPhoto();
    const row = await until(() => rows[0], "the provisional row");
    await until(() => row.state.phase === "settled", "the row to settle");
    expect(row.state).toMatchObject({ how: "price", filed: { scryfall_id: "p-mid", byPrice: true } });
  });

  it("never ties printings drawn differently: they can be told apart by eye", async () => {
    localStorage.setItem("yama.scan.tieByPrice", "1");
    state.sameArt = false;
    const { accepted } = scanner({ autoAdd: true });
    await scanPhoto();
    await until(() => document.body.textContent?.includes("Tap your printing"), "the picker");
    expect(accepted).toEqual([]);
  });

  it("asks as before when it's off, or when the prices are further apart", async () => {
    const { accepted } = scanner({ autoAdd: true });
    await scanPhoto();
    await until(() => document.body.textContent?.includes("Tap your printing"), "the picker");
    expect(accepted).toEqual([]);
    act(() => root.unmount());
    root = createRoot(host);
    localStorage.setItem("yama.scan.tieByPrice", "1");
    state.printings = [printing("p-new", "eoc", "101", "2025-08-01", { usd: 1.0 }), printing("p-mid", "woc", "145", "2023-09-08", { usd: 3 })];
    state.ill += 1;
    const again = scanner({ autoAdd: true });
    await scanPhoto();
    await until(() => document.body.textContent?.includes("Tap your printing"), "the picker");
    expect(again.accepted).toEqual([]);
  });
});

describe("border colour (item 24)", () => {
  it("rules out a white-bordered printing when the card's border reads black, and files the one left", async () => {
    state.drawCard = true;
    state.printings = [printing("p-white", "4ed", "300", "1995-04-01", { border_color: "white" }), printing("p-black", "m10", "210", "2009-07-17", { border_color: "black" })];
    const { accepted } = scanner({ autoAdd: true });
    await scanPhoto();
    const c = await until(() => accepted[0], "the card filed");
    expect(c.scryfall_id).toBe("p-black");
    const t = await until(() => state.timings.find((x) => x.outcome === "filed"), "the timing record");
    expect(t.printing).toBe("border");
    expect((t.detail as Record<string, unknown>).border).toBe("black");
  });

  it("rules nothing out when the border can't be read surely", async () => {
    state.printings = [printing("p-white", "4ed", "300", "1995-04-01", { border_color: "white" }), printing("p-black", "m10", "210", "2009-07-17", { border_color: "black" })];
    const { accepted } = scanner({ autoAdd: true });
    await scanPhoto();
    await until(() => document.body.textContent?.includes("Tap your printing"), "the picker");
    expect(accepted).toEqual([]);
  });
});
