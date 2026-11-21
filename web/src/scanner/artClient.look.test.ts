// @vitest-environment jsdom
// The printing look's plumbing (artClient.ts): a look model starts the look's own worker and has
// the art worker keep frames; a look hands the card's frames from one worker to the other, reports
// each printing's score as it comes, and stops when asked; Off ends the look's worker.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadArtRecognizer, type ArtWorkerReply, type ArtWorkerRequest, type BundleInfo } from "./artClient";
import type { LookWorkerReply, LookWorkerRequest } from "./look";

const V = "gallery-20261106T183001884398Z";
const info: BundleInfo = {
  version: V,
  ready: true,
  error: null,
  files: { detector: "d", embed: `/scan-bundle/${V}/embed.onnx`, search: "s", arts: "a" },
  bytes: { detector: 1, embed: 1, search: 1, arts: 1 },
  constants: { scene: 640 },
};
const lookV0 = { id: "look-v0", label: "Yama's look model, 20 Nov", note: "", file: `/scan-bundle/${V}/look-58acfa166105.onnx`, bytes: 9_292_149 };

const workers: FakeWorker[] = [];
let failModel = false;
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly asked: (ArtWorkerRequest | LookWorkerRequest)[] = [];
  readonly transferred: Transferable[][] = [];
  readonly look: boolean;
  terminated = false;
  constructor(url: URL) {
    this.look = String(url).includes("look.worker");
    workers.push(this);
  }
  private say(m: ArtWorkerReply | LookWorkerReply) {
    setTimeout(() => this.onmessage?.({ data: m } as MessageEvent), 1);
  }
  postMessage(m: ArtWorkerRequest | LookWorkerRequest, transfer: Transferable[] = []) {
    this.asked.push(m);
    this.transferred.push(transfer);
    if (!this.look) {
      if (m.type === "load") this.say({ type: "ready", ms: 1, arts: 3 });
      if (m.type === "frames") this.say({ type: "frames", id: m.id, frames: [{ width: 2, height: 2, quad: [[0, 0], [2, 0], [2, 2], [0, 2]], buffer: new ArrayBuffer(16) }] });
      return;
    }
    if (m.type === "model") this.say({ type: "ready", id: m.id, error: failModel ? "This browser can't read the printings' pictures in the background" : null });
    // A slow look: it ends only when told to stop.
    if (m.type === "look" && m.candidates[0]?.url === "slow") return;
    if (m.type === "stop") this.say({ type: "done", id: m.id, error: null, model: "look-58acfa166105", frames: 1, queryMs: 1, scored: 0, cached: 0, fetchMs: 0, decodeMs: 0, embedMs: 0, ms: 5 });
    if (m.type === "look") {
      this.say({ type: "score", id: m.id, candidate: "a", score: 0.7 });
      this.say({ type: "score", id: m.id, candidate: "b", score: 0.4 });
      this.say({ type: "done", id: m.id, error: null, model: "look-58acfa166105", frames: m.frames.length, queryMs: 1, scored: 2, cached: 0, fetchMs: 2, decodeMs: 3, embedMs: 4, ms: 10 });
    }
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
  workers.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe("the printing look, beside the art worker", () => {
  it("starts its own worker for a look model, and has the art worker keep frames meanwhile", async () => {
    const art = (await loadArtRecognizer(undefined, { info }))!;
    expect(art.look).toBe("off");
    await expect(art.lookAt(1, [], () => undefined)).rejects.toThrow("No look model");
    await art.useLook(lookV0);
    expect(art.look).toBe("look-v0");
    const [artWorker, lookWorker] = workers;
    expect(lookWorker!.look).toBe(true);
    // Frames are kept once the model is there, not while it downloads.
    expect(artWorker!.asked).toContainEqual({ type: "keep-frames", on: true });
    expect(artWorker!.asked.findIndex((m) => m.type === "keep-frames")).toBeGreaterThan(-1);
    expect(lookWorker!.asked[0]).toMatchObject({ type: "model", url: `http://localhost:3000/scan-bundle/${V}/look-58acfa166105.onnx`, bytes: 9_292_149 });
    // Off: the look's worker goes, and the art worker stops keeping frames.
    await art.useLook(null);
    expect(art.look).toBe("off");
    expect(lookWorker!.terminated).toBe(true);
    expect(artWorker!.asked.at(-1)).toEqual({ type: "keep-frames", on: false });
    art.dispose();
  });

  it("hands the card's frames to the look's worker and reports each score as it comes", async () => {
    const art = (await loadArtRecognizer(undefined, { info }))!;
    await art.useLook(lookV0);
    const scores: [string, number][] = [];
    const done = await art.lookAt(7, [{ id: "a", url: "https://cards.scryfall.io/a.jpg" }, { id: "b", url: "https://cards.scryfall.io/b.jpg" }], (id, score) => scores.push([id, score]));
    const [artWorker, lookWorker] = workers;
    expect(artWorker!.asked).toContainEqual(expect.objectContaining({ type: "frames", index: 7 }));
    const asked = lookWorker!.asked.find((m) => m.type === "look") as Extract<LookWorkerRequest, { type: "look" }>;
    expect(asked.frames).toHaveLength(1);
    expect(asked.candidates.map((c) => c.id)).toEqual(["a", "b"]);
    // The frames are moved, not copied, between the workers.
    expect(lookWorker!.transferred[lookWorker!.asked.indexOf(asked)]).toEqual([asked.frames[0]!.buffer]);
    expect(scores).toEqual([
      ["a", 0.7],
      ["b", 0.4],
    ]);
    expect(done).toMatchObject({ model: "look-58acfa166105", frames: 1, scored: 2 });
    art.dispose();
  });

  it("tells the look's worker to stop when the look is no longer wanted", async () => {
    const art = (await loadArtRecognizer(undefined, { info }))!;
    await art.useLook(lookV0);
    const stop = new AbortController();
    const looking = art.lookAt(7, [{ id: "a", url: "slow" }], () => undefined, stop.signal);
    // Under way in the look's worker (the frames came from the art worker first).
    for (let i = 0; i < 50 && !workers[1]!.asked.some((m) => m.type === "look"); i += 1) await new Promise((r) => setTimeout(r, 2));
    stop.abort();
    expect(await looking).toMatchObject({ scored: 0 });
    const lookWorker = workers[1]!;
    const id = (lookWorker.asked.find((m) => m.type === "look") as { id: number }).id;
    expect(lookWorker.asked).toContainEqual({ type: "stop", id });
    art.dispose();
    expect(lookWorker.terminated).toBe(true);
  });

  it("switches between options on one model file (v1, and v1 that settles when sure) without loading it again", async () => {
    const art = (await loadArtRecognizer(undefined, { info }))!;
    const v1 = { id: "look-v1", label: "Yama's look model v1", note: "", file: `/scan-bundle/${V}/look-152f52c100f0.onnx`, bytes: 9_292_149 };
    const sure = { ...v1, id: "look-v1-sure", label: "Yama's look model v1, settles when sure", settles: true };
    await art.useLook(v1);
    await art.useLook(sure);
    expect(art.look).toBe("look-v1-sure");
    const lookWorker = workers[1]!;
    expect(lookWorker.asked.filter((m) => m.type === "model")).toHaveLength(1);
    expect(lookWorker.terminated).toBe(false);
    // Another file is loaded as before.
    await art.useLook(lookV0);
    expect(art.look).toBe("look-v0");
    expect(lookWorker.asked.filter((m) => m.type === "model")).toHaveLength(2);
    art.dispose();
  });

  it("ends the look's worker when its model won't load, and keeps no frames for it", async () => {
    const art = (await loadArtRecognizer(undefined, { info }))!;
    failModel = true;
    await expect(art.useLook(lookV0)).rejects.toThrow("can't read");
    failModel = false;
    expect(art.look).toBe("off");
    expect(workers[1]!.terminated).toBe(true);
    expect(workers[0]!.asked).not.toContainEqual({ type: "keep-frames", on: true });
    // A later try starts a new one.
    await art.useLook(lookV0);
    expect(workers).toHaveLength(3);
    expect(art.look).toBe("look-v0");
    art.dispose();
  });
});
