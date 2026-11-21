// @vitest-environment jsdom
// The "Models" part of Scan settings (models.ts; Bryan, 20 Nov 2026: switch models on the fly when
// things break): each slot's default or a named option, applied at once without reloading the
// scanner, and a choice the server no longer offers falling back to the default.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtRecognizer, BundleInfo } from "./artClient";
import type { ModelOption } from "./models";

const V = "gallery-20261106T183001884398Z";
const yamaArt = { id: "yama-art-20261118", label: "Yama's art model, 18 Nov", note: "Fine-tuned for sleeved cards.", file: `/scan-bundle/${V}/query-52420d900728.onnx`, bytes: 5_139_404 };
const bundleArt = { id: "bundle", label: "ManaVault's art model", note: "The bundle's own.", file: `/scan-bundle/${V}/embed.onnx`, bytes: 5_118_408 };
const bundleFinder = { id: "bundle-detector", label: "ManaVault's card finder", note: "Four turned views a look.", file: `/scan-bundle/${V}/detector.onnx`, bytes: 12_576_317 };
const yamaFinder = { id: "yama-corners-20261120", label: "Yama's card finder, 20 Nov", note: "One view a look.", file: `/scan-bundle/${V}/corners-0123456789ab.onnx`, bytes: 4_140_304 };
const server = vi.hoisted(() => ({ art: [] as unknown[], detector: [] as unknown[] }));
const bundle = (): BundleInfo => ({
  version: V,
  ready: true,
  error: null,
  files: { detector: bundleFinder.file, embed: yamaArt.file, search: "s", arts: "a" },
  bytes: { detector: 1, embed: yamaArt.bytes, search: 1, arts: 1 },
  constants: { scene: 640 },
  models: {
    detector: { default: "bundle-detector", options: server.detector as ModelOption[] },
    art: { default: "yama-art-20261118", options: server.art as ModelOption[] },
    look: { default: "off", options: [{ id: "off", label: "Off", note: "" }] },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }, { id: "mlkit", label: "Google ML Kit", note: "" }, { id: "tesseract", label: "Tesseract", note: "" }] },
    lock: { default: "lead", options: [{ id: "lead", label: "Art that leads", note: "Leads by 0.10." }, { id: "sure", label: "Sure scores only", note: "0.82." }] },
  },
});

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string) => {
    // The app says it can feed an art model's `cuts` (artClient.ts).
    if (path === "/api/scan/bundle?can=cuts") return Promise.resolve(bundle());
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));

/** The recognizer the scanner gets: which art model it was started with, and the switches since. */
const art = vi.hoisted(() => ({ loads: [] as { art?: { id: string } | null; detector?: { id: string } | null }[], switches: [] as string[], now: "", none: false, detector: "bundle-detector", detectorSwitches: [] as string[] }));
vi.mock("./artClient", async (original) => ({
  ...(await original<typeof import("./artClient")>()),
  loadArtRecognizer: async (_: unknown, opts: { art?: { id: string } | null; detector?: { id: string } | null }) => {
    art.loads.push(opts);
    art.detector = opts.detector?.id ?? "bundle-detector";
    // No recognizer (a bundle not ready yet): the scanner reads text.
    if (art.none) return null;
    art.now = opts.art?.id ?? "?";
    const r: ArtRecognizer = {
      get embed() {
        return `${V}/${art.now}.onnx`;
      },
      get art() {
        return art.now;
      },
      async useArt(o) {
        art.switches.push(o.id);
        art.now = o.id;
      },
      look: "off",
      useLook: async () => undefined,
      lookAt: () => Promise.reject(new Error("no look here")),
      get detector() {
        return art.detector;
      },
      // As artClient's: asking for the one running loads nothing.
      async useDetector(o) {
        if (o.id === art.detector) return;
        art.detectorSwitches.push(o.id);
        art.detector = o.id;
      },
      identify: () => new Promise(() => undefined),
      reset: () => undefined,
      setPool: async () => -1,
      dispose: () => undefined,
    };
    return r;
  },
}));
vi.mock("./serverCatalog", () => ({ createServerCatalog: async () => ({ hasSet: () => false, lookup: async () => null, names: () => [] }) }));
/** The text readers started: the choice each was given, and whether it was stopped. */
const ocr = vi.hoisted(() => ({ started: [] as { choice: unknown; terminated: boolean }[] }));
vi.mock("./ocrEngine", async (original) => ({
  ...(await original<typeof import("./ocrEngine")>()),
  createScannerOcr: async (_: unknown, choice: unknown) => {
    const started = { choice, terminated: false };
    ocr.started.push(started);
    return { engine: "tesseract", read: async () => ({ text: "", confidence: 0 }), terminate: async () => void (started.terminated = true) };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => undefined;
// The art worker needs these to be there at all (loadArtRecognizer is mocked).
vi.stubGlobal("Worker", class {});

const { ScannerView } = await import("./ScannerView");
const { saveModel } = await import("./models");

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  art.loads.length = 0;
  art.switches.length = 0;
  art.none = false;
  ocr.started.length = 0;
  server.art = [bundleArt, yamaArt];
  server.detector = [bundleFinder];
  art.detector = "bundle-detector";
  art.detectorSwitches.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  for (const slot of ["detector", "art", "look", "text", "lock"] as const) saveModel(slot, null);
  localStorage.clear();
});

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
async function until<T>(get: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const v = get();
    if (v) return v;
    await wait(20);
  }
  throw new Error(`never saw ${what}`);
}
/** The select under a Field's words in Scan settings. */
const select = (label: string) => [...document.querySelectorAll<HTMLLabelElement>(".scan-models label")].find((l) => l.textContent?.startsWith(label))?.querySelector("select") ?? null;
const choose = (el: HTMLSelectElement, value: string) =>
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
async function openSettings() {
  await until(() => art.loads.length > 0 || null, "the recognizer");
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Scan settings"]')!.click());
  return until(() => document.querySelector(".scan-models"), "the Models section");
}

describe("Models in Scan settings", () => {
  it("starts on each slot's default, and lists only slots with a choice", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    const models = await openSettings();
    expect(art.loads[0]!.art?.id).toBe("yama-art-20261118");
    expect(select("Art match")!.value).toBe("");
    expect([...select("Art match")!.options].map((o) => o.textContent)).toEqual(["Default (Yama's art model, 18 Nov)", "ManaVault's art model", "Yama's art model, 18 Nov"]);
    expect(models.textContent).toContain("Running Yama's art model, 18 Nov.");
    // ML Kit only in the app; the look has only Off so far: no choice to make.
    expect([...select("Text reader")!.options].map((o) => o.value)).toEqual(["", "auto", "tesseract"]);
    expect(select("Printing look")).toBeNull();
    expect(select("Settling by art")!.value).toBe("");
  });

  it("switches the art model at once, in the same scanner, and remembers it on this device", async () => {
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    const models = await openSettings();
    await choose(select("Art match")!, "bundle");
    await until(() => (art.switches.includes("bundle") ? true : null), "the switch");
    await until(() => (models.textContent?.includes("Running ManaVault's art model.") ? true : null), "the model running");
    expect(art.loads).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("yama.scan.models")!)).toEqual({ art: "bundle" });
    // Back to the default.
    await choose(select("Art match")!, "");
    await until(() => (art.now === "yama-art-20261118" ? true : null), "the default again");
    expect(art.loads).toHaveLength(1);
    expect(localStorage.getItem("yama.scan.models")).toBe("{}");

    // The lock rule applies to the next frame: nothing to load.
    await choose(select("Settling by art")!, "sure");
    expect(JSON.parse(localStorage.getItem("yama.scan.models")!)).toEqual({ lock: "sure" });
    expect(models.textContent).toContain("0.82.");
  });

  it("switches the card finder at once, and a new scanner starts with the one chosen", async () => {
    server.detector = [bundleFinder, yamaFinder];
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    const models = await openSettings();
    expect(models.textContent).toContain("Running ManaVault's card finder.");
    await choose(select("Card finder")!, "yama-corners-20261120");
    await until(() => (models.textContent?.includes("Running Yama's card finder, 20 Nov.") ? true : null), "the card finder running");
    expect(art.detectorSwitches).toContain("yama-corners-20261120");
    expect(art.loads).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("yama.scan.models")!)).toEqual({ detector: "yama-corners-20261120" });
    // A new scanner loads with it, no switch needed.
    act(() => root.unmount());
    root = createRoot(host);
    art.detectorSwitches.length = 0;
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    await until(() => (art.loads.length === 2 ? true : null), "the second recognizer");
    expect(art.loads[1]!.detector?.id).toBe("yama-corners-20261120");
    await wait(50);
    expect(art.detectorSwitches).toEqual([]);
  });

  it("starts a scanner whose chosen model the server no longer offers on the default, and says so", async () => {
    saveModel("art", "bundle");
    server.art = [yamaArt];
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    const models = await openSettings();
    expect(art.loads[0]!.art?.id).toBe("yama-art-20261118");
    // Only one art model on offer, but the one chosen here is gone: the slot says so, and the
    // choice is kept for when it's back.
    expect(select("Art match")!.value).toBe("bundle");
    expect([...select("Art match")!.options].find((o) => o.value === "bundle")?.textContent).toBe("bundle (not on offer now)");
    expect(models.textContent).toContain("isn't on offer now, so the default runs");
    expect(JSON.parse(localStorage.getItem("yama.scan.models")!)).toEqual({ art: "bundle" });
    // The same for a lock rule this build doesn't know.
    saveModel("lock", "vote");
    await wait(20);
    expect(select("Settling by art")!.value).toBe("vote");
    expect([...select("Settling by art")!.options].find((o) => o.value === "vote")?.textContent).toBe("vote (not on offer now)");
    expect(models.textContent).toContain("isn't on offer now, so the default runs");
  });

  it("starts a text-only scanner's reader with the server's readers, and lets one switched away finish its reads", async () => {
    art.none = true;
    act(() => root.render(<ScannerView onAccept={async () => true} />));
    const models = await openSettings();
    await until(() => ocr.started[0], "the text reader");
    // Started once, knowing what the server offers (a withdrawn reader is never started).
    expect(ocr.started).toHaveLength(1);
    expect(ocr.started[0]!.choice).toEqual({ engine: "auto", allowed: ["auto", "mlkit", "tesseract"] });
    expect(document.body.textContent).not.toContain("The text reader was switched");
    expect(models.textContent).toContain("Card recognition isn't running.");
    // Choosing another: the next read starts it; the one running isn't cut off mid-read.
    await choose(select("Text reader")!, "tesseract");
    await wait(30);
    expect(ocr.started[0]!.terminated).toBe(false);
    expect(JSON.parse(localStorage.getItem("yama.scan.models")!)).toEqual({ text: "tesseract" });
  });
});
