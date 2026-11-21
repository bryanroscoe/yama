import { describe, expect, it } from "vitest";
import type { Art } from "./recognizer";
import {
  captureEnv,
  CARD_ASPECT,
  configStats,
  deviceLabel,
  placedQuad,
  placement,
  quantile,
  speedCards,
  speedSummary,
  stat,
  webGpuInfo,
  type ConfigResult,
  type FrameTime,
  type NavigatorLike,
  type SpeedEnv,
} from "./speed";

const art = (i: number, over: Partial<Art> = {}): Art => ({ id: `id-${i}`, name: `Card ${i}`, set: "tst", number: String(i), illustrationId: `ill-${i}`, layout: "normal", printings: 1, ...over });

describe("the speed test's cards", () => {
  it("are spread through the gallery, single-faced normal cards with distinct names, the same each time", () => {
    const arts = Array.from({ length: 100 }, (_, i) => art(i, i % 10 === 6 ? { layout: "token" } : i % 10 === 7 ? { id: `id-${i}-1` } : {}));
    // Two artworks of one card: only one is shown.
    arts[18] = art(18, { name: "Card 8" });
    const cards = speedCards(arts, 8);
    expect(cards.map((c) => c.index)).toEqual([8, 19, 31, 43, 58, 68, 81, 93]);
    expect(cards.every((c) => arts[c.index]!.layout === "normal" && !c.id.endsWith("-1"))).toBe(true);
    expect(new Set(cards.map((c) => c.name)).size).toBe(8);
    expect(speedCards(arts, 8)).toEqual(cards);
    expect(cards[0]).toEqual({ index: 8, id: "id-8", name: "Card 8", set: "tst", number: "8", illustrationId: "ill-8" });
  });

  it("are fewer when the gallery has fewer, and none from an empty one", () => {
    expect(speedCards([art(0), art(1, { layout: "token" })], 8).map((c) => c.id)).toEqual(["id-0"]);
    expect(speedCards([], 8)).toEqual([]);
  });
});

describe("where a frame puts its card", () => {
  it("gives the corners top-left first and clockwise, with the top edge a little narrower", () => {
    const p = { cx: 320, cy: 569, width: 340, angle: 0, keystone: 0.9 };
    const q = placedQuad(p);
    const h = 340 * CARD_ASPECT;
    expect(q[0]![0]).toBeCloseTo(320 - 153);
    expect(q[0]![1]).toBeCloseTo(569 - h / 2);
    expect(q[1]![0]).toBeCloseTo(320 + 153);
    expect(q[2]![0]).toBeCloseTo(320 + 170);
    expect(q[2]![1]).toBeCloseTo(569 + h / 2);
    expect(q[3]![0]).toBeCloseTo(320 - 170);
  });

  it("turns the card about its centre", () => {
    const q = placedQuad({ cx: 0, cy: 0, width: 100, angle: Math.PI / 2, keystone: 1 });
    const h = 100 * CARD_ASPECT;
    // A quarter turn clockwise (y down): the top-left corner goes to the top right.
    expect(q[0]![0]).toBeCloseTo(h / 2);
    expect(q[0]![1]).toBeCloseTo(-50);
  });

  it("keeps the card in the frame and moves it only slightly between a card's frames", () => {
    for (let c = 0; c < 8; c++) {
      const first = placement(c, 0);
      for (const corner of placedQuad(first)) {
        expect(corner[0]).toBeGreaterThan(0);
        expect(corner[0]).toBeLessThan(640);
        expect(corner[1]).toBeGreaterThan(0);
        expect(corner[1]).toBeLessThan(1138);
      }
      for (let f = 1; f < 4; f++) {
        const p = placement(c, f);
        // Within the recognizer's tracking (10% of the window), so tracked frames stay tracked.
        expect(Math.hypot(p.cx - first.cx, p.cy - first.cy)).toBeLessThan(5);
        expect(Math.abs(p.angle - first.angle)).toBeLessThan(0.01);
        expect(p.width).toBe(first.width);
      }
    }
    expect(placement(3, 2)).toEqual(placement(3, 2));
  });
});

describe("the statistics", () => {
  it("are by nearest rank, as the server's timing summaries", () => {
    expect(quantile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile(Array.from({ length: 10 }, (_, i) => i + 1), 0.9)).toBe(9);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([Number.NaN, 2], 0.5)).toBe(2);
    expect(stat([10.04, 20.06, 30])).toEqual({ median: 20.1, p90: 30, n: 3 });
    expect(stat([])).toEqual({ median: null, p90: null, n: 0 });
  });

  const frame = (card: number, f: number, over: Partial<FrameTime> = {}): FrameTime => ({
    card,
    frame: f,
    fresh: f === 0,
    roundMs: f === 0 ? 200 + card : 100 + card,
    totalMs: f === 0 ? 190 + card : 95 + card,
    detector: f === 0 ? [50, 50] : [50],
    embed: [10, 5],
    search: [3],
    cuts: 17,
    found: true,
    right: true,
    ...over,
  });

  it("leave out the first card, which warms up, and keep tracked and fresh frames apart", () => {
    const frames = [frame(0, 0, { roundMs: 900 }), frame(0, 1, { roundMs: 800 }), ...[1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((f) => frame(c, f)))];
    const s = configStats(frames);
    expect(s.fresh).toEqual({ median: 202, p90: 203, n: 3 });
    expect(s.tracked).toEqual({ median: 102, p90: 103, n: 9 });
    expect(s.trackedInWorker.median).toBe(97);
    expect(s.freshInWorker.median).toBe(192);
    // Every detector pass counts on its own; the art embedding and search are a frame's total.
    expect(s.detector).toEqual({ median: 50, p90: 50, n: 15 });
    expect(s.embed).toEqual({ median: 15, p90: 15, n: 12 });
    expect(s.search.median).toBe(3);
  });

  it("use every frame when there's only one card, and only frames with a card for the art", () => {
    const s = configStats([frame(0, 0), frame(0, 1, { found: false, embed: [], search: [] })]);
    expect(s.tracked.n).toBe(1);
    expect(s.embed.n).toBe(1);
  });
});

/** A browser's navigator, as the tests pretend it. */
function nav(over: Partial<NavigatorLike> = {}): NavigatorLike {
  return {
    userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    userAgentData: {
      getHighEntropyValues: async () => ({
        model: "Pixel 10 Pro",
        platform: "Android",
        platformVersion: "16.0.0",
        architecture: "",
        bitness: "64",
        mobile: true,
        brands: [{ brand: "Chromium", version: "142" }],
        fullVersionList: [
          { brand: "Chromium", version: "142.0.7444.12" },
          { brand: "Google Chrome", version: "142.0.7444.12" },
        ],
        uaFullVersion: "142.0.7444.12",
      }),
    },
    gpu: {
      requestAdapter: async () => ({
        info: { vendor: "imagination", architecture: "dxt", device: "", description: "PowerVR D-Series" },
        features: { has: (f: string) => f === "shader-f16" },
      }),
    },
    ...over,
  };
}

const app = { web: "abc1234", built: "2026-11-21T10:00:00Z", native: null };

describe("what's recorded about the device", () => {
  it("has the user agent, hints, cores, memory, threads and WebGPU's adapter", async () => {
    const env = await captureEnv(nav(), { crossOriginIsolated: false, SharedArrayBuffer: undefined }, app);
    expect(env).toMatchObject({ cores: 8, memory: 8, isolated: false, sharedMemory: false, app });
    expect(env.userAgent).toContain("Android 10; K");
    expect(env.hints).toMatchObject({ model: "Pixel 10 Pro", platform: "Android", platformVersion: "16.0.0" });
    // Only the hints asked for.
    expect(env.hints).not.toHaveProperty("uaFullVersion");
    expect(env.webgpu).toEqual({ api: true, adapter: true, vendor: "imagination", architecture: "dxt", device: "", description: "PowerVR D-Series", f16: true });
    expect(deviceLabel(env)).toBe("Pixel 10 Pro, Android 16, Google Chrome 142");
  });

  it("says when WebGPU isn't there, gives no adapter, or fails, and reads older adapters' info", async () => {
    expect(await webGpuInfo(nav({ gpu: undefined }))).toEqual({ api: false, adapter: false });
    expect(await webGpuInfo(nav({ gpu: { requestAdapter: async () => null } }))).toEqual({ api: true, adapter: false });
    expect(await webGpuInfo(nav({ gpu: { requestAdapter: () => Promise.reject(new Error("blocked")) } }))).toEqual({ api: true, adapter: false, error: "blocked" });
    const older = await webGpuInfo(
      nav({ gpu: { requestAdapter: async () => ({ requestAdapterInfo: async () => ({ vendor: "arm", architecture: "valhall" }), features: { has: () => false }, isFallbackAdapter: true }) } }),
    );
    expect(older).toMatchObject({ api: true, adapter: true, vendor: "arm", architecture: "valhall", f16: false, fallback: true });
  });

  it("does without hints, and names a device from its user agent", async () => {
    const env = await captureEnv(
      nav({ userAgentData: undefined, gpu: undefined, hardwareConcurrency: undefined, deviceMemory: undefined, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36" }),
      { crossOriginIsolated: true, SharedArrayBuffer: function SharedArrayBuffer() {} },
      app,
    );
    expect(env).toMatchObject({ hints: null, cores: null, memory: null, isolated: true, sharedMemory: true });
    expect(deviceLabel(env)).toBe("macOS, Chrome 157");
    const webview = { ...env, userAgent: "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro Build/BD1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36" };
    expect(deviceLabel(webview)).toBe("Pixel 10 Pro, Android 16, Android WebView 142");
    expect(deviceLabel({ ...webview, app: { ...app, native: { versionName: "0.2.140", versionCode: 140 } } })).toBe("Pixel 10 Pro, Android 16, Yama app 0.2.140");
  });

  it("doesn't wait on hints that never come", async () => {
    const env: SpeedEnv = await captureEnv(nav({ userAgentData: { getHighEntropyValues: () => new Promise(() => undefined) }, gpu: undefined }), {}, app);
    expect(env.hints).toBeNull();
  }, 10_000);
});

describe("the summary", () => {
  const config = (roles: ConfigResult["roles"], tracked: number | null, error: string | null = null): ConfigResult => ({
    roles,
    wanted: { detector: { id: "d", label: "D" }, art: { id: "a", label: "A" } },
    ran: { detector: "d", art: "a" },
    loadMs: 1000,
    downloaded: false,
    firstFrameMs: 300,
    stats: tracked === null ? null : ({ tracked: { median: tracked, p90: tracked, n: 1 } } as ConfigResult["stats"]),
    found: 1,
    right: 1,
    frames: [],
    error,
  });

  it("says a frame's time with this device's models and the others", () => {
    expect(speedSummary({ configs: [config(["yours", "defaults"], 142.4), config(["faster"], 48)] })).toBe("A frame takes 142 ms with your models (the defaults), 48 ms with the faster ones.");
    expect(speedSummary({ configs: [config(["yours", "faster"], 48), config(["defaults"], 142)] })).toBe("A frame takes 48 ms with your models (the faster ones), 142 ms with the defaults.");
    expect(speedSummary({ configs: [config(["yours"], 90), config(["defaults"], 142), config(["faster"], 48)] })).toBe(
      "A frame takes 90 ms with your models, 142 ms with the defaults and 48 ms with the faster ones.",
    );
    expect(speedSummary({ configs: [config(["yours", "defaults"], 142)] })).toBe("A frame takes 142 ms with your models (the defaults).");
  });

  it("says when it didn't finish", () => {
    expect(speedSummary({ configs: [config(["yours"], null, "out of memory")] })).toBe("The test didn't finish: out of memory");
    expect(speedSummary({ configs: [] })).toBe("The test didn't finish.");
  });
});
