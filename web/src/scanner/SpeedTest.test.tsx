// @vitest-environment jsdom
// "Test scanner speed" in Scan settings (SpeedTest.tsx): runs only on a tap, shows the summary and
// the table, keeps the result on the account, and stops when Scan settings closes.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigResult, SpeedReport } from "./speed";

const run = vi.hoisted(() => ({
  calls: [] as { signal?: AbortSignal; progress: (p: { text: string; done: number; total: number }) => void; finish: (r: SpeedReport) => void; fail: (e: Error) => void }[],
  saved: [] as SpeedReport[],
  saveFails: false,
  /** While set, a save waits for it. */
  saveGate: null as Promise<void> | null,
}));

vi.mock("./speedRun", () => ({
  runSpeedTest: (progress: (p: { text: string; done: number; total: number }) => void, signal?: AbortSignal) =>
    new Promise<SpeedReport>((finish, fail) => {
      run.calls.push({ signal, progress, finish, fail });
    }),
  saveSpeedTest: async (r: SpeedReport) => {
    if (run.saveGate) await run.saveGate;
    if (run.saveFails) throw new Error("Too many scanner speed tests");
    run.saved.push(r);
    return { id: "t1" };
  },
  speedTestCount: async () => run.saved.length,
  deleteSpeedTests: async () => {
    const deleted = run.saved.length;
    run.saved.length = 0;
    return { deleted };
  },
}));

const { SpeedTest, configName, scannerSettled } = await import("./SpeedTest");

const stat = (median: number) => ({ median, p90: median + 10, n: 21 });
const config = (roles: ConfigResult["roles"], tracked: number, over: Partial<ConfigResult> = {}): ConfigResult => ({
  roles,
  runtime: "wasm-1-thread",
  wanted: { detector: { id: "bundle-detector", label: "ManaVault's card finder" }, art: { id: "yama-art-20261118", label: "Yama's art model" } },
  ran: { detector: "bundle-detector", art: "yama-art-20261118" },
  loadMs: 2100,
  downloaded: false,
  firstFrameMs: 300,
  stats: { detector: stat(50), embed: stat(60), search: stat(5), tracked: stat(tracked), fresh: stat(tracked + 50), trackedInWorker: stat(tracked - 2), freshInWorker: stat(tracked + 48) },
  found: 32,
  right: 32,
  frames: Array(32).fill(null),
  error: null,
  ...over,
});

const report = (): SpeedReport => ({
  version: 1,
  startedAt: "2026-11-21T10:00:00Z",
  ms: 41000,
  bundle: "gallery-20261106",
  device: "Pixel 10 Pro, Android 16, Google Chrome 142",
  env: { userAgent: "UA", hints: null, app: { web: "abc", built: "", native: null }, cores: 8, memory: 8, isolated: false, sharedMemory: false, webgpu: { api: true, adapter: true, vendor: "imagination", architecture: "dxt", f16: true } },
  choices: {},
  cards: [],
  configs: [config(["yours", "defaults"], 142), config(["faster"], 48, { downloaded: true, right: 30 })],
  look: { runtime: "wasm-1-thread", option: "look-v1", label: "Yama's look model v1", loadMs: 800, firstMs: 900, picture: stat(70), frame: stat(65), fetch: stat(300), decode: stat(12), error: null },
});

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  run.calls.length = 0;
  run.saved.length = 0;
  run.saveFails = false;
  run.saveGate = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name);

describe("Test scanner speed", () => {
  it("runs only when pressed, shows its progress, then the summary and table, and keeps it on the account", async () => {
    await act(async () => root.render(<SpeedTest />));
    expect(run.calls).toHaveLength(0);
    await act(async () => button("Test scanner speed")!.click());
    expect(run.calls).toHaveLength(1);
    expect(button("Test scanner speed")!.disabled).toBe(true);
    await act(async () => run.calls[0]!.progress({ text: "Timing your models: card 2 of 8", done: 3, total: 27 }));
    expect(host.textContent).toContain("Timing your models: card 2 of 8");
    expect(host.querySelector("progress")!.value).toBe(3);
    await act(async () => run.calls[0]!.finish(report()));
    expect(host.textContent).toContain("A frame takes 142 ms with your models (the defaults), 48 ms with the faster ones.");
    const rows = [...host.querySelectorAll("tbody tr")].map((r) => [...r.children].map((c) => c.textContent));
    expect(rows[0]).toEqual(["Your models (the defaults)", "5060", "6070", "515", "142152", "192202"]);
    expect(rows[1]![0]).toBe("The faster ones");
    expect(host.textContent).toContain("The faster ones put the right card first on 30 of 32 frames.");
    expect(host.textContent).toContain("Printing look (Yama's look model v1): 70 ms to compare a printing's picture, 65 ms for a frame of the card.");
    expect(host.textContent).toContain("the faster ones took 2.1 s to load (with a download)");
    expect(host.textContent).toContain("WebGPU is available (imagination dxt), with 16-bit floats.");
    expect(host.textContent).toContain("One processor thread (the page isn't cross-origin isolated), of 8 cores.");
    expect(host.textContent).toContain("Kept on your account.");
    expect(run.saved).toHaveLength(1);
    expect(button("Test scanner speed")!.disabled).toBe(false);
    // and they can be deleted from here.
    expect(host.textContent).toContain("1 test saved on your account.");
    await act(async () => button("Delete saved tests")!.click());
    expect(run.saved).toHaveLength(0);
    expect(host.textContent).toContain("Deleted 1 saved test.");
    expect(button("Delete saved tests")).toBeUndefined();
  });

  it("says when it couldn't keep the result, or couldn't run", async () => {
    run.saveFails = true;
    await act(async () => root.render(<SpeedTest />));
    await act(async () => button("Test scanner speed")!.click());
    await act(async () => run.calls[0]!.finish(report()));
    expect(host.textContent).toContain("Not kept: Too many scanner speed tests");
    await act(async () => button("Test scanner speed")!.click());
    await act(async () => run.calls[1]!.fail(new Error("Card recognition isn't ready on the server yet, so there's nothing to time.")));
    expect(host.textContent).toContain("Card recognition isn't ready");
  });

  it("stops with Stop, and when Scan settings closes", async () => {
    await act(async () => root.render(<SpeedTest />));
    await act(async () => button("Test scanner speed")!.click());
    await act(async () => button("Stop")!.click());
    expect(run.calls[0]!.signal!.aborted).toBe(true);
    // Not startable again until the stopped run has ended.
    expect(host.textContent).toContain("Stopping");
    expect(button("Test scanner speed")!.disabled).toBe(true);
    await act(async () => run.calls[0]!.fail(new Error("Stopped")));
    expect(host.textContent).toContain("Stopped.");
    expect(button("Test scanner speed")!.disabled).toBe(false);
    await act(async () => button("Test scanner speed")!.click());
    expect(run.calls).toHaveLength(2);
    act(() => root.unmount());
    expect(run.calls[1]!.signal!.aborted).toBe(true);
    // A result arriving after it stopped is neither shown nor kept.
    root = createRoot(host);
    await act(async () => run.calls[1]!.finish(report()));
    expect(run.saved).toHaveLength(0);
  });

  it("stops when the scanner begins loading a model, and can't be stopped once it's keeping the result", async () => {
    await act(async () => root.render(<SpeedTest ready />));
    await act(async () => button("Test scanner speed")!.click());
    await act(async () => root.render(<SpeedTest ready={false} />));
    expect(run.calls[0]!.signal!.aborted).toBe(true);
    await act(async () => run.calls[0]!.fail(new Error("stopped")));
    expect(host.textContent).toContain("Stopped: the scanner began loading a model.");
    await act(async () => root.render(<SpeedTest ready />));
    let open = () => undefined as void;
    run.saveGate = new Promise<void>((r) => (open = r));
    await act(async () => button("Test scanner speed")!.click());
    await act(async () => run.calls[1]!.finish(report()));
    expect(host.textContent).toContain("Keeping it on your account…");
    expect(button("Stop")).toBeUndefined();
    expect(button("Test scanner speed")!.disabled).toBe(true);
    await act(async () => open());
    expect(host.textContent).toContain("Kept on your account.");
    expect(host.textContent).toContain("1 test saved on your account.");
  });

  it("waits for the scanner's own models, and shows the tests kept with a way to delete them", async () => {
    run.saved.push(report(), report());
    await act(async () => root.render(<SpeedTest ready={false} />));
    expect(button("Test scanner speed")!.disabled).toBe(true);
    expect(host.textContent).toContain("still loading its models");
    expect(host.textContent).toContain("2 tests saved on your account.");
    await act(async () => button("Delete saved tests")!.click());
    expect(host.textContent).toContain("Deleted 2 saved tests.");
    expect(scannerSettled("art", null, {})).toBe(true);
    expect(scannerSettled(null, null, {})).toBe(false);
    expect(scannerSettled("art", { kind: "preparing" }, {})).toBe(false);
    expect(scannerSettled("art", null, { art: "Loading Yama's art model…" })).toBe(false);
    expect(scannerSettled("text", null, { art: "Couldn't load it, so the one before still runs." })).toBe(true);
  });

  it("names a configuration by every role it fills", () => {
    expect(configName(config(["yours", "faster"], 48))).toBe("Your models (the faster ones)");
    expect(configName(config(["defaults"], 142))).toBe("The defaults");
  });
});
