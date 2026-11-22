// @vitest-environment jsdom
// The card finder in the app's own code, from the page's side (nativeCamera.ts, nativeModels.ts,
// recognizer.ts): what a frame's reply says the finder found, frames asked for with it while it
// runs, the model handed over only when the app doesn't have it, the per-device choice, and the
// art matched at corners handed in, read upside down only when upright is doubtful.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawFront } from "./eval/syntheticCards";
import { finderKey, FOUND_CARD, FOUND_FAILED, FOUND_NONE, HEADER, loadNativeFinder, nativeFind, openNativeCamera, parseReply, toBase64, type FrameChannel, type FrameRequest, type ScannerCameraPlugin } from "./nativeCamera";
import { NATIVE_KEY, nativeId, nativeWanted, saveNative, savedNative } from "./nativeModels";
import { createRecognizer, halfTurn, TurnMemory, type OrtLike } from "./recognizer";
import type { Quad, RgbaImage } from "./types";

/** A binary reply, with the finder's block (ScannerCameraPlugin.answer). */
function reply(o: { id: number; width: number; height: number; state: number; quad?: number[]; vote?: number; ms?: number; passes?: number }): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER + o.width * o.height * 4);
  const h = new DataView(buf);
  h.setUint32(0, o.id, true);
  h.setUint32(8, o.width, true);
  h.setUint32(12, o.height, true);
  h.setUint32(16, 2160, true);
  h.setUint32(20, 3840, true);
  h.setUint32(24, 1, true);
  h.setFloat64(32, Date.now(), true);
  h.setUint32(48, o.state, true);
  h.setFloat32(52, o.vote ?? 0, true);
  for (let i = 0; i < 8; i++) h.setFloat32(56 + i * 4, o.quad?.[i] ?? Number.NaN, true);
  h.setFloat32(88, o.ms ?? 0, true);
  h.setUint32(92, o.passes ?? 0, true);
  h.setFloat32(96, 4, true);
  return buf;
}

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData: () => undefined, drawImage: () => undefined } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a frame's reply", () => {
  it("says what the app's finder found on it", () => {
    const card = parseReply(reply({ id: 3, width: 2, height: 2, state: FOUND_CARD, quad: [1, 2, 3, 2, 3, 6, 1, 6], vote: 0.98, ms: 7.5, passes: 1 })).frame!;
    expect(card.finder).toEqual({ state: FOUND_CARD, quad: [[1, 2], [3, 2], [3, 6], [1, 6]], vote: expect.closeTo(0.98, 5), ms: 7.5, passes: 1, ageMs: 4 });
    expect(parseReply(reply({ id: 3, width: 2, height: 2, state: FOUND_NONE })).frame!.finder).toMatchObject({ state: FOUND_NONE, quad: null });
    // A finder that stopped has nothing to say of the frame but that.
    expect(parseReply(reply({ id: 3, width: 2, height: 2, state: FOUND_FAILED, quad: [1, 2, 3, 2, 3, 6, 1, 6] })).frame!.finder).toMatchObject({ state: FOUND_FAILED, quad: null });
  });
});

describe("the camera with the app's finder", () => {
  function fakes() {
    const requests: FrameRequest[] = [];
    const sets: unknown[] = [];
    let running = false;
    const channel: FrameChannel = {
      onmessage: null,
      postMessage(text) {
        const q = JSON.parse(text) as FrameRequest & { id: number };
        requests.push(q);
        const buf = q.found && running ? reply({ id: q.id, width: 4, height: 6, state: FOUND_CARD, quad: [0, 0, 4, 0, 4, 6, 0, 6], vote: 1, ms: 6, passes: 1 }) : reply({ id: q.id, width: 4, height: 6, state: 0 });
        setTimeout(() => this.onmessage?.({ data: buf }), 0);
      },
    };
    const plugin = {
      open: async () => ({ binary: true, lensAsked: "auto", lens: "auto", lenses: [], fpsAsked: 30, fpsRanges: [], hasTorch: false, torch: false, torchLevels: 0, focusMode: "continuous" }),
      close: async () => undefined,
      setRect: async () => undefined,
      status: async () => ({}),
      finderSet: async (o: { on?: boolean }) => {
        sets.push(o);
        if (o.on !== undefined) running = o.on;
        return { loaded: true, on: running };
      },
    } as unknown as ScannerCameraPlugin;
    return { plugin, channel, requests, sets };
  }

  it("asks for found frames while it runs, and keeps what was found with the frame in the canvas", async () => {
    const { plugin, channel, requests } = fakes();
    const cam = openNativeCamera(document.createElement("canvas"), { lens: "auto", fps: 30, width: 3840, height: 2160 }, { plugin, channel, settleMs: 0, pullRate: 200 });
    await cam.ready;
    expect(cam.found()).toBeNull();
    expect(requests.every((q) => !q.found)).toBe(true);
    const st = await cam.setFinder({ on: true, outline: true });
    expect(st).toMatchObject({ on: true });
    await vi.waitFor(() => expect(cam.found()).toMatchObject({ state: FOUND_CARD, quad: [[0, 0], [4, 0], [4, 6], [0, 6]] }));
    expect(requests.at(-1)).toMatchObject({ op: "frame", found: true });
    await cam.setFinder({ on: false });
    expect(cam.found()).toBeNull();
    const before = requests.length;
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(before + 1));
    expect(requests.at(-1)?.found).toBeUndefined();
    cam.close();
  });
});

describe("handing the app its card finder", () => {
  it("names a file by itself when it's content-addressed, else by its bundle too", () => {
    expect(finderKey("/scan-bundle/gallery-1/corners-18f9d6aab2a4.onnx")).toBe("corners-18f9d6aab2a4.onnx");
    expect(finderKey("/scan-bundle/gallery-20261106T183001884398Z/detector.onnx")).toBe("gallery-20261106T183001884398Z-detector.onnx");
  });

  it("sends the model only when the app doesn't have it", async () => {
    const asked: string[] = [];
    let have = false;
    const plugin = {
      finderLoad: async () => {
        asked.push("load");
        if (!have) throw Object.assign(new Error("The app doesn't have that model yet"), { code: "need-model" });
        return { key: "k", loadMs: 12 };
      },
      finderModel: async ({ data }: { key: string; data: string }) => {
        asked.push(`model ${atob(data).length}`);
        have = true;
        return { key: "k", bytes: 3 };
      },
    } as unknown as ScannerCameraPlugin;
    const bytes = vi.fn(async () => Uint8Array.of(1, 2, 3));
    expect(await loadNativeFinder({ key: "k", bytes }, {}, plugin)).toEqual({ loadMs: 12, sent: true });
    expect(asked).toEqual(["load", "model 3", "load"]);
    expect(await loadNativeFinder({ key: "k", bytes }, {}, plugin)).toEqual({ loadMs: 12, sent: false });
    expect(bytes).toHaveBeenCalledTimes(1);
    // Any other refusal is the answer: it can't run here, or ran out of memory, and the file isn't sent again.
    const sent = vi.fn(async () => ({}));
    const broken = { finderLoad: async () => Promise.reject(Object.assign(new Error("no runtime"), { code: "unavailable" })), finderModel: sent } as unknown as ScannerCameraPlugin;
    await expect(loadNativeFinder({ key: "k", bytes }, {}, broken)).rejects.toThrow("no runtime");
    const short = { finderLoad: async () => Promise.reject(Object.assign(new Error("out of memory"), { code: "failed" })), finderModel: sent } as unknown as ScannerCameraPlugin;
    await expect(loadNativeFinder({ key: "k", bytes }, {}, short)).rejects.toThrow("out of memory");
    expect(sent).not.toHaveBeenCalled();
  });

  it("encodes a large file a chunk at a time", () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 251);
    const back = atob(toBase64(big));
    expect(back.length).toBe(big.length);
    expect(back.charCodeAt(123_456)).toBe(123_456 % 251);
  });

  it("finds a frame from the page in the app", async () => {
    const plugin = { find: async (o: { width: number; data: string; reset?: boolean }) => ({ state: FOUND_CARD, quad: [[0, 0], [2, 0], [2, 3], [0, 3]], vote: 0.9, ms: 5, runs: [2.5, 2.5], reset: o.reset }) } as unknown as ScannerCameraPlugin;
    const r = await nativeFind({ width: 2, height: 3, data: new Uint8ClampedArray(24) }, true, plugin);
    expect(r).toMatchObject({ state: FOUND_CARD, quad: [[0, 0], [2, 0], [2, 3], [0, 3]], passes: 2, runs: [2.5, 2.5] });
  });
});

describe("the per-device choice", () => {
  it("is on by default, kept per device, and names what ran", () => {
    expect(nativeWanted("detector", savedNative())).toBe(true);
    saveNative("detector", false);
    expect(JSON.parse(store.get(NATIVE_KEY)!)).toEqual({ detector: false });
    expect(nativeWanted("detector", savedNative())).toBe(false);
    saveNative("detector", null);
    expect(nativeWanted("detector", savedNative())).toBe(true);
    expect(nativeId("yama-corners-20261120")).toBe("yama-corners-20261120-native");
  });
});

// ---- The art at corners handed in ----

const constants = { scene: 640, det_input: 256, rotations: 4, refine_fill: 0.6, refine_min_side: 64, card_aspect: 88 / 63 };
class Tensor {
  constructor(
    readonly type: string,
    readonly data: Uint8Array | Float32Array | BigInt64Array,
    readonly dims: readonly number[],
  ) {}
}

/** A stand-in recognizer whose art scores `score(quad)` for the quad it is shown; every graph run logged. */
function fakeOrt(log: string[], score: (q: number[]) => number) {
  let lastQuad: number[] = [];
  const ort: OrtLike = {
    Tensor: Tensor as unknown as OrtLike["Tensor"],
    InferenceSession: {
      async create(model) {
        const kind = model[0];
        return {
          inputNames: kind === 1 ? ["window"] : kind === 2 ? ["scene", "quad"] : ["embeddings"],
          async run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>> {
            if (kind === 1) {
              log.push("detect");
              return { quad: { data: Float32Array.from([78, 58, 178, 58, 178, 198, 78, 198]) }, up: { data: Float32Array.from([4, 0]) }, centre: { data: Float32Array.from([128, 128]) }, short: { data: Float32Array.from([100]) } };
            }
            if (kind === 2) {
              log.push("embed");
              lastQuad = [...((feeds.quad as Tensor).data as Float32Array)];
              return { embeddings: new Tensor("float32", new Float32Array(4), [1, 4]) };
            }
            log.push("search");
            // The card, and another well below it (a search lists its best five).
            return { indices: { data: BigInt64Array.from([0n, 1n]) }, scores: { data: Float32Array.from([score(lastQuad), score(lastQuad) - 0.4]) } };
          },
        };
      },
    },
  };
  return ort;
}
const graphs = { detector: Uint8Array.of(1), embed: Uint8Array.of(2), search: Uint8Array.of(3) };
const arts = [
  { id: "a", name: "Sol Ring", set: "ecc", number: "57", illustrationId: "ill-a", layout: "normal", printings: 1 },
  { id: "b", name: "Arcane Signet", set: "eoc", number: "101", illustrationId: "ill-b", layout: "normal", printings: 1 },
];

function frame(): RgbaImage {
  const card = drawFront({ frame: [40, 110, 170], box: [200, 220, 235], art: [[30, 60, 120], [220, 230, 240]] }, 200, 280);
  const data = new Uint8ClampedArray(640 * 640 * 4).fill(110);
  for (let y = 0; y < card.height; y += 1) data.set(card.data.subarray(y * card.width * 4, (y + 1) * card.width * 4), ((y + 100) * 640 + 100) * 4);
  return { width: 640, height: 640, data };
}
const upright: Quad = [[100, 100], [300, 100], [300, 380], [100, 380]];

describe("the art at corners handed in", () => {
  beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => undefined));

  it("runs no finder: no card is nothing, a card is matched where it was put", async () => {
    const log: string[] = [];
    const r = await createRecognizer(fakeOrt(log, () => 0.9), graphs, constants, arts);
    log.length = 0;
    const none = await r.matchAt(frame(), { quad: null, upright: 0.1 });
    expect(none).toMatchObject({ quad: null, matches: [], upright: 0.1 });
    expect(log).toEqual([]);
    const got = await r.matchAt(frame(), { quad: upright, upright: 0.97 }, { turn: true });
    // Sure upright: read once.
    expect(log).toEqual(["embed", "search"]);
    expect(got.quad).toEqual(upright);
    expect(got.upright).toBe(0.97);
    expect(got.turned).toBeUndefined();
  });

  it("reads it turned half round when upright is doubtful, and keeps the way that wins", async () => {
    const log: string[] = [];
    // The card is really the other way up: the half-turned quad (top-left at the far corner) scores.
    const r = await createRecognizer(fakeOrt(log, (q) => (q[0]! > 200 ? 0.9 : 0.3)), graphs, constants, arts);
    log.length = 0;
    const got = await r.matchAt(frame(), { quad: upright }, { turn: true });
    expect(log).toEqual(["embed", "search", "embed", "search"]);
    expect(got.turned).toBe("won");
    expect(got.quad).toEqual(halfTurn(upright));
    expect(got.matches[0]!.score).toBeCloseTo(0.9);
    // The same card again, as the finder gives it: read the way that won, once.
    log.length = 0;
    const again = await r.matchAt(frame(), { quad: upright }, { turn: true });
    expect(log).toEqual(["embed", "search"]);
    expect(again.quad).toEqual(halfTurn(upright));
    expect(again.turned).toBeUndefined();
  });

  it("doesn't read it both ways again while the doubtful card lies there, but does for another card", () => {
    const m = new TurnMemory();
    expect(m.first(upright)).toEqual({ quad: upright, known: false, name: null });
    m.learn(upright, "Sol Ring");
    // Nudged two pixels, the finder calling the far corner the top: the same card, read as it was.
    const nudged = halfTurn(upright).map(([x, y]) => [x + 2, y]) as Quad;
    expect(m.first(nudged)).toEqual({ quad: [[102, 100], [302, 100], [302, 380], [102, 380]], known: true, name: "Sol Ring" });
    // Elsewhere, or another size: a new card.
    expect(m.first(upright.map(([x, y]) => [x + 150, y]) as Quad).known).toBe(false);
    expect(m.first(upright.map(([x, y]) => [x * 2, y * 2]) as Quad).known).toBe(false);
    // Turned a quarter in place (its centre and short side as they were): a new reading, as the finder gives it.
    const c = [200, 240];
    const quarter = upright.map(([x, y]) => [c[0]! - (y - c[1]!), c[1]! + (x - c[0]!)]) as Quad;
    expect(m.first(quarter)).toEqual({ quad: quarter, known: false, name: null });
  });

  it("describes a card for the placement gate at corners handed in, with no finder pass", async () => {
    const log: string[] = [];
    const r = await createRecognizer(fakeOrt(log, () => 0.9), graphs, constants, arts);
    log.length = 0;
    const seen = await r.locate(frame(), { quad: upright, upright: 0.95 });
    expect(log).toEqual([]);
    expect(seen).toMatchObject({ quad: upright, upright: 0.95 });
    expect(seen.thumb).toHaveLength(48 * 48);
    expect(seen.sharpness).toBeGreaterThan(0);
    expect(await r.locate(frame(), { quad: null })).toMatchObject({ quad: null });
  });
});
