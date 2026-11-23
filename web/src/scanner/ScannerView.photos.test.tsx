// @vitest-environment jsdom
// Scan photos of every card the scanner names (Bryan, 22 Nov 2026: "so we can have a better corpus
// of training photos"; samples.ts): a card let go without filing is kept as `unconfirmed` with the
// scanner's guess, scores and rule; a card filed is kept as added; one photo per card placed in
// view, a later answer relabelling it; and nothing at all with the switch off. The camera and the
// recognizer are faked, as in ScannerView.gate.test.tsx, and the scan photo worker too (no canvas
// can encode here).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtRecognizer, BundleInfo } from "./artClient";
import type { Quad } from "./types";

const V = "gallery-20261106T183001884398Z";
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

/** Every scan photo upload and label change the scanner sent. */
const sent = vi.hoisted(() => ({ calls: [] as { path: string; method: string; json: Record<string, unknown> }[], reports: [] as Record<string, unknown>[] }));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, init?: { method?: string; json?: Record<string, unknown> }) => {
    if (path.startsWith("/api/scan/bundle")) return Promise.resolve(bundle());
    if (path.startsWith("/api/scan/samples") && init?.method) {
      sent.calls.push({ path, method: init.method, json: init.json ?? {} });
      return Promise.resolve({ id: `photo${sent.calls.length}` });
    }
    if (path.startsWith("/api/scan/samples")) return Promise.resolve({ count: 0, bytes: 0, keep: 20000 });
    // A scan sent by hand ("Send this scan"), kept apart from the photos.
    if (path === "/api/scan/diagnostics" && init?.method === "POST") {
      sent.reports.push(init.json ?? {});
      return Promise.resolve({ id: "diag1" });
    }
    if (path.startsWith("/api/scan/diagnostics")) return Promise.resolve({ count: 0, bytes: 0, keep: 200 });
    return Promise.reject(new Error(`offline: ${path}`));
  },
}));

/** The faked art match: which card the recognizer names, and the picture of the card lying in view. */
const cam = vi.hoisted(() => ({ card: "Arcane Signet", index: 4, picture: 37 }));
const QUAD: Quad = [
  [100, 100],
  [400, 100],
  [400, 520],
  [100, 520],
];
vi.mock("./artClient", async (original) => ({
  ...(await original<typeof import("./artClient")>()),
  loadArtRecognizer: async () => {
    const match = () => ({
      quad: QUAD,
      upright: 1,
      matches: [
        { index: cam.index, id: `p-${cam.index}`, name: cam.card, set: "eoc", number: "101", illustrationId: `ill-${cam.index}`, layout: "normal", printings: 1, score: 0.93 },
        { index: 20, id: "p-20", name: "Other card", set: "fdn", number: "9", illustrationId: "ill-20", layout: "normal", printings: 1, score: 0.41 },
      ],
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
        onSeen?.(QUAD);
        return match();
      },
      locate: async (image) => ({ quad: QUAD, upright: 1, sharpness: 50, thumb: new Uint8Array(0), detectMs: 1, image }),
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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => undefined;
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
/** The card's pixels, made once per size and picture. */
const pictures = new Map<string, Uint8ClampedArray>();
function picture(n: number): Uint8ClampedArray {
  const key = `${n}:${cam.picture}`;
  let p = pictures.get(key);
  if (!p) {
    p = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i += 1) p[i] = (i * cam.picture) % 251;
    pictures.set(key, p);
  }
  return p.slice();
}
/** A scan photo worker that answers at once, as photo.worker.ts would. */
vi.stubGlobal("OffscreenCanvas", class {});
vi.stubGlobal(
  "Worker",
  class {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    postMessage(msg: { id: number; shot: { quad: Quad } }) {
      setTimeout(() => this.onmessage?.({ data: { id: msg.id, cut: { image: "AAAA", quad: msg.shot.quad, crops: [{ name: "card", image: "BBBB", width: 786, height: 1100 }] } } }), 0);
    }
    terminate() {}
  },
);
HTMLCanvasElement.prototype.getContext = function () {
  return {
    drawImage: () => undefined,
    // The card in view, as a picture of its own: the same card gives the same pixels.
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: picture(w * h * 4) }),
    putImageData: () => undefined,
  } as unknown as CanvasRenderingContext2D;
} as unknown as typeof HTMLCanvasElement.prototype.getContext;
// A camera that is always delivering a 1280 × 720 picture.
Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, get: () => 1280 });
Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, get: () => 720 });
Object.defineProperty(HTMLVideoElement.prototype, "readyState", { configurable: true, get: () => 4 });
Object.defineProperty(HTMLVideoElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
HTMLVideoElement.prototype.play = async () => undefined;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

const { ScannerView } = await import("./ScannerView");
const { setSavingPhotos } = await import("./samples");

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  const track = { stop: () => undefined, getSettings: () => ({ deviceId: "x", width: 1280, height: 720 }), getCapabilities: () => ({}), applyConstraints: async () => undefined, label: "fake" };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => stream, enumerateDevices: async () => [] } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  Object.assign(cam, { card: "Arcane Signet", index: 4, picture: 37 });
  sent.calls.length = 0;
  setSavingPhotos(true);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  Reflect.deleteProperty(navigator, "mediaDevices");
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
const foundName = () => document.querySelector(".scan-info h3")?.textContent ?? "";
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
const click = (el: HTMLElement) => act(() => el.click());
const posts = () => sent.calls.filter((c) => c.method === "POST");

describe("scan photos of every card the scanner names", () => {
  it("keeps a card let go with Skip as unconfirmed, with the scanner's guess, scores and rule, once", async () => {
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    await click(await until(() => button("Skip"), "Skip"));
    await until(() => (posts().length ? true : null), "the photo sent");
    const [photo] = posts();
    expect(photo!.path).toBe("/api/scan/samples");
    expect(photo!.json).toMatchObject({ kind: "unconfirmed", guess_name: "Arcane Signet", guess_illustration_id: "ill-4", method: "art", score: 0.93, rule: "sure", source: "browser", mode: "identity", shared: true, image: "AAAA" });
    expect(photo!.json.label_name).toBeUndefined();
    expect((photo!.json.scores as { name: string }[]).map((m) => m.name)).toEqual(["Arcane Signet", "Other card"]);
    expect((photo!.json.crops as { name: string }[]).map((c) => c.name)).toEqual(["card"]);
    // The card still lying there isn't another photo, however many frames see it.
    await wait(300);
    expect(sent.calls).toHaveLength(1);
  });

  it("keeps a card filed as added, and no second photo when it's let go after", async () => {
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    await click(await until(() => button("Add"), "Add"));
    await until(() => (posts().length ? true : null), "the photo sent");
    expect(posts()[0]!.json).toMatchObject({ kind: "added", label_name: "Arcane Signet", rule: "sure" });
    await wait(300);
    expect(sent.calls).toHaveLength(1);
  });

  it("relabels the photo of a card called wrong when the card read next where it lies is filed", async () => {
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    // Wrong card, nothing more said: kept as wrong, and the scanner reads the card again.
    await click(await until(() => button("More"), "More"));
    await click(await until(() => button("Wrong card"), "Wrong card"));
    Object.assign(cam, { card: "Mind Stone", index: 5 });
    await click(await until(() => button("Scan it again"), "Scan it again"));
    await until(() => (posts().length ? true : null), "the photo sent");
    expect(posts()[0]!.json).toMatchObject({ kind: "wrong", guess_name: "Arcane Signet" });
    // It reads the right card this time, and it's filed: the same photo is relabelled.
    await until(() => (foundName().includes("Mind Stone") ? true : null), "the right card found");
    await click(await until(() => button("Add"), "Add"));
    const patch = await until(() => sent.calls.find((c) => c.method === "PATCH"), "the label change");
    expect(patch.path).toBe("/api/scan/samples/photo1");
    expect(patch.json).toMatchObject({ kind: "corrected", label_name: "Mind Stone" });
    await wait(200);
    expect(posts()).toHaveLength(1);
  });

  it("keeps a photo of its own for another card laid where the one called wrong lay", async () => {
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    await click(await until(() => button("More"), "More"));
    await click(await until(() => button("Wrong card"), "Wrong card"));
    // The person gives up on it and lays another card on top, without the view ever emptying.
    Object.assign(cam, { card: "Mind Stone", index: 5, picture: 53 });
    await click(await until(() => button("Scan it again"), "Scan it again"));
    await until(() => (foundName().includes("Mind Stone") ? true : null), "the other card found");
    await click(await until(() => button("Add"), "Add"));
    await until(() => (posts().length === 2 ? true : null), "two photos sent");
    expect(posts().map((c) => c.json.kind)).toEqual(["wrong", "added"]);
    expect(posts()[1]!.json).toMatchObject({ label_name: "Mind Stone" });
    expect(sent.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("keeps the card in hand when the scanner is closed", async () => {
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    act(() => root.render(<></>));
    await until(() => (posts().length ? true : null), "the photo sent");
    expect(posts()[0]!.json).toMatchObject({ kind: "unconfirmed", guess_name: "Arcane Signet" });
  });

  it("keeps nothing in test scan, whatever it names", async () => {
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await click(await until(() => document.querySelector<HTMLButtonElement>('button[aria-label="Scan settings"]'), "Scan settings"));
    const testing = await until(() => [...document.querySelectorAll<HTMLLabelElement>("label.scan-keep")].find((l) => l.textContent?.includes("Test scan."))?.querySelector("input"), "the test scan switch");
    await click(testing);
    // Test scan goes on card after card by itself; let it name a couple.
    await until(() => (foundName().includes("Arcane Signet") || document.body.textContent?.includes("scanned, none saved") ? true : null), "a card named");
    Object.assign(cam, { card: "Mind Stone", index: 5, picture: 53 });
    await wait(600);
    expect(sent.calls).toEqual([]);
  });

  it("sends nothing with Save scan photos off", async () => {
    setSavingPhotos(false);
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    await click(await until(() => button("Skip"), "Skip"));
    Object.assign(cam, { card: "Mind Stone", index: 5 });
    await until(() => (foundName().includes("Mind Stone") ? true : null), "the next card found");
    await click(await until(() => button("Add"), "Add"));
    await wait(300);
    expect(sent.calls).toEqual([]);
  });

  it("sends the card in hand by hand (Send this scan), with the person's note, with Scanner diagnostics off", async () => {
    sent.reports.length = 0;
    // No JPEG encoder here: the record goes without its pictures.
    HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
      cb(null);
    };
    act(() => root.render(<ScannerView identityOnly onAccept={async () => true} />));
    await until(() => (foundName().includes("Arcane Signet") ? true : null), "the card found");
    await click(await until(() => button("More"), "More"));
    await click(await until(() => button("Send this scan"), "Send this scan"));
    const note = await until(() => document.querySelector<HTMLTextAreaElement>(".scan-report textarea"), "the note");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(note, "Foil, the number won't read");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Send")!);
    await until(() => (document.querySelector(".scan-report")?.textContent?.includes("Sent.") ? true : null), "Sent");
    expect(sent.reports).toHaveLength(1);
    const r = sent.reports[0] as { outcome: string; card_name: string; detail: { reasons: string[]; note: string; found: { art: { name: string } }; reported: { switchOn: boolean } } };
    expect(r.outcome).toBe("reported");
    expect(r.card_name).toBe("Arcane Signet");
    expect(r.detail.reasons).toEqual(["reported"]);
    expect(r.detail.note).toBe("Foil, the number won't read");
    expect(r.detail.found.art.name).toBe("Arcane Signet");
    expect(r.detail.reported.switchOn).toBe(false);
  });
});
