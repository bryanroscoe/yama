// The speed test's run (speedRun.ts) with the workers, pictures and frames faked: which models are
// timed, what's measured of each frame, the look, and stopping.
import { describe, expect, it } from "vitest";
import type { ArtRecognizer, BundleInfo } from "./artClient";
import type { ModelChoices, ModelOption } from "./models";
import type { Recognition } from "./recognizer";
import { FRAMES_PER_CARD, SPEED_CARDS, type SpeedCard } from "./speed";
import { lookToTime, runSpeedTest, speedConfigs, type SpeedDeps, type SpeedProgress } from "./speedRun";
import { modelsOf } from "./models";

const V = "gallery-20261106T183001884398Z";
const opt = (id: string, file: string | null = `/scan-bundle/${V}/${id}.onnx`): ModelOption => ({ id, label: `Model ${id}`, note: "", file, bytes: 100 });
const bundleFinder = opt("bundle-detector");
const yamaFinder = opt("yama-corners-20261120");
const yamaArt = opt("yama-art-20261118");
const cascade = opt("yama-art-20261118-cascade");
const bundleArt = opt("bundle");
const lookV1 = opt("look-v1");

const info = (over: { detector?: ModelOption[]; art?: ModelOption[]; look?: ModelOption[]; lookDefault?: string } = {}): BundleInfo => ({
  version: V,
  ready: true,
  error: null,
  files: { detector: bundleFinder.file!, embed: yamaArt.file!, search: "s", arts: "a" },
  bytes: { detector: 1, embed: 1, search: 1, arts: 1 },
  constants: { scene: 640 },
  models: {
    detector: { default: "bundle-detector", options: over.detector ?? [bundleFinder, yamaFinder] },
    art: { default: "yama-art-20261118", options: over.art ?? [bundleArt, yamaArt, cascade] },
    look: { default: over.lookDefault ?? "look-v1", options: over.look ?? [opt("off", null), lookV1, opt("look-v0")] },
    text: { default: "auto", options: [{ id: "auto", label: "Automatic", note: "" }] },
    lock: { default: "lead", options: [{ id: "lead", label: "Art that leads", note: "" }] },
  },
});

const cards: SpeedCard[] = Array.from({ length: SPEED_CARDS }, (_, i) => ({ index: i * 10, id: `card-${i}`, name: `Card ${i}`, set: "tst", number: String(i), illustrationId: `ill-${i}` }));

interface World {
  deps: SpeedDeps;
  loads: { art: string; detector: string }[];
  disposed: number;
  looks: { option: string; times: { url: string; quad: unknown }[]; disposed: boolean }[];
  /** What was asked for, in order. */
  calls: string[];
}

/**
 * A pretend browser: a clock moved by the fakes (a frame takes 100 ms with the bundle's finder,
 * 30 with Yama's; loading 2 s), recognizers that track a card after its first frame and find the
 * card shown, pictures for every card, and a look timer.
 */
function world(
  opts: { choices?: ModelChoices; info?: BundleInfo; failLoad?: string; failPictures?: number; wrongOn?: string; abortAfter?: { controller: AbortController; frames: number }; hangOn?: number; runsInstead?: string } = {},
): World {
  let clock = 0;
  const w: World = { deps: undefined as unknown as SpeedDeps, loads: [], disposed: 0, looks: [], calls: [] };
  let framesSeen = 0;
  w.deps = {
    now: () => clock,
    env: async () => (w.calls.push("env"), { userAgent: "UA", hints: { model: "Pixel 10 Pro", platform: "Android", platformVersion: "16" }, app: { web: "abc", built: "", native: null }, cores: 8, memory: 8, isolated: false, sharedMemory: false, webgpu: { api: false, adapter: false } }),
    bundleInfo: async () => (w.calls.push("info"), opts.info ?? info()),
    choices: () => opts.choices ?? {},
    async loadRecognizer(_info, art, detector, onState) {
      if (art.id === opts.failLoad) throw new Error("out of memory");
      w.loads.push({ art: art.id, detector: detector.id });
      w.calls.push(`load ${art.id}`);
      if (art.id === "yama-art-20261118-cascade") onState({ kind: "downloading", loaded: 50, total: 100 });
      clock += 2000;
      let tracking = false;
      let shown: SpeedCard | null = null;
      let gone = false;
      let hung: ((e: Error) => void) | null = null;
      const per = detector.id === "yama-corners-20261120" ? 10 : 50;
      const rec: ArtRecognizer = {
        embed: `${V}/${art.id}`,
        art: art.id === opts.runsInstead ? "bundle" : art.id,
        detector: detector.id,
        look: "off",
        async identify(image) {
          if (gone) throw new Error("The scanner is closed");
          framesSeen += 1;
          if (opts.abortAfter && framesSeen === opts.abortAfter.frames) opts.abortAfter.controller.abort();
          // A frame that never answers until its worker is ended.
          if (framesSeen === opts.hangOn) await new Promise((_, reject) => (hung = reject));
          const passes = tracking ? 1 : 2;
          tracking = true;
          const embed = art.id === "yama-art-20261118-cascade" ? [15] : [60];
          const ms = passes * per + embed[0]! + 5;
          clock += ms + 1;
          // The frame says which card: the fakes write its number into the first pixel.
          shown = cards[image.data[0]!]!;
          const top = { ...shown, illustrationId: shown.id === opts.wrongOn ? "other" : shown.illustrationId, id: shown.id === opts.wrongOn ? "other" : shown.id, layout: "normal", printings: 1, index: shown.index, score: 0.9 };
          const r: Recognition = {
            quad: [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
            ],
            upright: 1,
            matches: [top],
            timings: { detectMs: passes * per, embedMs: embed[0]! + 5, totalMs: ms, cuts: 17, runs: { detector: Array(passes).fill(per), embed, search: [5] } },
          };
          return r;
        },
        reset() {
          tracking = false;
        },
        setPool: async () => -1,
        dispose() {
          if (gone) return;
          gone = true;
          w.disposed += 1;
          hung?.(new Error("The scanner is closed"));
        },
        useArt: async () => undefined,
        useLook: async () => undefined,
        lookAt: async () => {
          throw new Error("no look");
        },
        useDetector: async () => undefined,
        sample: async (n) => cards.slice(0, n),
      };
      return rec;
    },
    async picture(card) {
      if (opts.failPictures && cards.indexOf(card) < opts.failPictures) throw new Error("404");
      return { card, url: `https://cards.scryfall.io/normal/front/${card.id}.jpg`, image: { width: 488, height: 680 } as unknown as ImageBitmap };
    },
    frame(pic) {
      const data = new Uint8ClampedArray(16);
      data[0] = cards.indexOf(pic.card);
      return { width: 2, height: 2, data };
    },
    async lookTimer(option) {
      clock += 500;
      const l = { option: option.id, times: [] as { url: string; quad: unknown }[], disposed: false };
      w.looks.push(l);
      return {
        async time(url, frame) {
          l.times.push({ url, quad: frame?.quad });
          const first = l.times.length === 1;
          return { fetchMs: 300, decodeMs: 12, pictureMs: first ? 400 : 70, frameMs: first ? 300 : 65 };
        },
        dispose() {
          l.disposed = true;
        },
      };
    },
  };
  return w;
}

describe("which models the speed test times", () => {
  it("this device's, the defaults and the faster ones, each pair once", () => {
    const models = modelsOf(info());
    expect(speedConfigs(models, {}).map((c) => [c.roles, c.detector.id, c.art.id])).toEqual([
      [["yours", "defaults"], "bundle-detector", "yama-art-20261118"],
      [["faster"], "yama-corners-20261120", "yama-art-20261118-cascade"],
    ]);
    expect(speedConfigs(models, { detector: "yama-corners-20261120", art: "yama-art-20261118-cascade" }).map((c) => c.roles)).toEqual([["yours", "faster"], ["defaults"]]);
    expect(speedConfigs(models, { art: "bundle" }).map((c) => [c.roles, c.art.id])).toEqual([
      [["yours"], "bundle"],
      [["defaults"], "yama-art-20261118"],
      [["faster"], "yama-art-20261118-cascade"],
    ]);
    // A choice not on offer runs the default, so it's the defaults that are timed for it.
    expect(speedConfigs(models, { art: "withdrawn" })[0]!.roles).toEqual(["yours", "defaults"]);
  });

  it("only faster options the server offers, one standing in for the default where the other isn't", () => {
    expect(speedConfigs(modelsOf(info({ detector: [bundleFinder] })), {}).map((c) => [c.roles, c.detector.id, c.art.id])).toEqual([
      [["yours", "defaults"], "bundle-detector", "yama-art-20261118"],
      [["faster"], "bundle-detector", "yama-art-20261118-cascade"],
    ]);
    expect(speedConfigs(modelsOf(info({ detector: [bundleFinder], art: [bundleArt, yamaArt] })), {}).map((c) => c.roles)).toEqual([["yours", "defaults"]]);
  });

  it("the look this device runs, or the default when its look is off", () => {
    const models = modelsOf(info());
    expect(lookToTime(models, {})?.id).toBe("look-v1");
    expect(lookToTime(models, { look: "look-v0" })?.id).toBe("look-v0");
    expect(lookToTime(models, { look: "off" })?.id).toBe("look-v1");
    expect(lookToTime(modelsOf(info({ lookDefault: "off" })), { look: "off" })?.id).toBe("look-v1");
    expect(lookToTime(modelsOf(info({ look: [opt("off", null)], lookDefault: "off" })), {})).toBeNull();
  });
});

describe("a speed test", () => {
  it("times every frame through each configuration's own worker, the warm-up apart, then the look", async () => {
    const w = world();
    const progress: SpeedProgress[] = [];
    const r = await runSpeedTest((p) => progress.push(p), undefined, w.deps);
    expect(w.loads).toEqual([
      { art: "yama-art-20261118", detector: "bundle-detector" },
      { art: "yama-art-20261118-cascade", detector: "yama-corners-20261120" },
    ]);
    // One worker at a time, each ended after its frames.
    expect(w.disposed).toBe(2);
    expect(r.configs).toHaveLength(2);
    const [mine, fast] = r.configs;
    expect(mine!.roles).toEqual(["yours", "defaults"]);
    expect(mine!.frames).toHaveLength(SPEED_CARDS * FRAMES_PER_CARD);
    expect(mine!.frames.filter((f) => f.fresh)).toHaveLength(SPEED_CARDS);
    expect(mine!.loadMs).toBe(2000);
    expect(mine!.downloaded).toBe(false);
    // The first frame (fresh: two passes of 50, an embedding of 60, a search of 5, and a ms of messaging).
    expect(mine!.firstFrameMs).toBe(166);
    expect(mine!.stats!.tracked).toEqual({ median: 116, p90: 116, n: (SPEED_CARDS - 1) * (FRAMES_PER_CARD - 1) });
    expect(mine!.stats!.trackedInWorker.median).toBe(115);
    expect(mine!.stats!.fresh.median).toBe(166);
    expect(mine!.stats!.detector.median).toBe(50);
    expect(mine!.stats!.embed.median).toBe(60);
    expect(mine!.stats!.search.median).toBe(5);
    expect(mine!.right).toBe(SPEED_CARDS * FRAMES_PER_CARD);
    expect(mine!.ran).toEqual({ detector: "bundle-detector", art: "yama-art-20261118" });
    expect(fast!.roles).toEqual(["faster"]);
    expect(fast!.downloaded).toBe(true);
    expect(fast!.stats!.tracked.median).toBe(31);
    // The look: the device's (the default here), every card's picture and first frame, the first apart.
    expect(w.looks).toHaveLength(1);
    expect(w.looks[0]!.option).toBe("look-v1");
    expect(w.looks[0]!.disposed).toBe(true);
    expect(w.looks[0]!.times.map((t) => t.url)).toEqual(cards.map((c) => `https://cards.scryfall.io/normal/front/${c.id}.jpg`));
    expect(w.looks[0]!.times[0]!.quad).toHaveLength(4);
    expect(r.look).toMatchObject({ option: "look-v1", loadMs: 500, firstMs: 700, picture: { median: 70, n: SPEED_CARDS - 1 }, frame: { median: 65 }, fetch: { median: 300 }, decode: { median: 12 }, error: null });
    expect(r).toMatchObject({ version: 1, bundle: V, device: "Pixel 10 Pro, Android 16", choices: {} });
    expect(r.cards.map((c) => c.id)).toEqual(cards.map((c) => c.id));
    expect(progress.at(-1)).toMatchObject({ text: "Done" });
    expect(progress.some((p) => p.text.includes("Downloading"))).toBe(true);
    expect(progress.every((p) => p.done <= p.total)).toBe(true);
  });

  it("counts the frames that didn't put the right card first", async () => {
    const r = await runSpeedTest(() => undefined, undefined, world({ wrongOn: "card-3" }).deps);
    expect(r.configs[0]!.right).toBe((SPEED_CARDS - 1) * FRAMES_PER_CARD);
  });

  it("goes on past a configuration that won't load, and does without cards whose pictures didn't come", async () => {
    const w = world({ failLoad: "yama-art-20261118-cascade", failPictures: 2 });
    const r = await runSpeedTest(() => undefined, undefined, w.deps);
    expect(r.configs[0]!.frames).toHaveLength((SPEED_CARDS - 2) * FRAMES_PER_CARD);
    expect(r.configs[1]).toMatchObject({ roles: ["faster"], stats: null, error: "out of memory" });
    expect(r.cards).toHaveLength(SPEED_CARDS - 2);
    expect(r.look?.error).toBeNull();
  });

  it("stops when asked, ending the worker under way", async () => {
    const controller = new AbortController();
    const w = world({ abortAfter: { controller, frames: 6 } });
    await expect(runSpeedTest(() => undefined, controller.signal, w.deps)).rejects.toThrow("stopped");
    expect(w.loads).toHaveLength(1);
    expect(w.disposed).toBe(1);
    expect(w.looks).toHaveLength(0);
  });

  it("ends the worker at once when stopped mid-frame, not at the next step", async () => {
    const controller = new AbortController();
    const w = world({ hangOn: 3 });
    const run = runSpeedTest(() => undefined, controller.signal, w.deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(w.disposed).toBe(0);
    controller.abort();
    await expect(run).rejects.toThrow();
    expect(w.disposed).toBe(1);
  });

  it("asks about the device before timing anything", async () => {
    const w = world();
    await runSpeedTest(() => undefined, undefined, w.deps);
    expect(w.calls.slice(0, 3)).toEqual(["env", "info", "load yama-art-20261118"]);
  });

  it("never files the defaults' times under models that didn't load", async () => {
    const w = world({ runsInstead: "yama-art-20261118-cascade" });
    const r = await runSpeedTest(() => undefined, undefined, w.deps);
    const fast = r.configs.find((c) => c.roles.includes("faster"))!;
    expect(fast.stats).toBeNull();
    expect(fast.frames).toEqual([]);
    expect(fast.error).toContain("didn't load");
    expect(fast.runtime).toBe("wasm-1-thread");
    expect(r.look?.runtime).toBe("wasm-1-thread");
  });

  it("says why when nothing can be timed", async () => {
    await expect(runSpeedTest(() => undefined, undefined, world({ info: { ...info(), ready: false } }).deps)).rejects.toThrow("isn't ready");
    const none = world({ failPictures: SPEED_CARDS });
    const r = await runSpeedTest(() => undefined, undefined, none.deps);
    expect(r.configs).toHaveLength(1);
    expect(r.configs[0]!.error).toContain("pictures");
    expect(r.look).toBeNull();
  });
});
