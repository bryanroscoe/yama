// @vitest-environment jsdom
// Switching the art model on the fly (models.ts, Scan settings): the recognizer loads the one
// chosen, swaps it without reloading the rest, ends on the last one asked for, keeps the one before
// when a switch fails, and starts with the default when the one chosen won't load.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadArtRecognizer, type ArtWorkerReply, type ArtWorkerRequest, type BundleInfo } from "./artClient";

const V = "gallery-20261106T183001884398Z";
const info: BundleInfo = {
  version: V,
  ready: true,
  error: null,
  files: { detector: `/scan-bundle/${V}/detector.onnx`, embed: `/scan-bundle/${V}/query-52420d900728.onnx`, search: `/scan-bundle/${V}/search.onnx`, arts: `/scan-bundle/${V}/arts.slim.json` },
  bytes: { detector: 1, embed: 5_139_404, search: 1, arts: 1 },
  constants: { scene: 640 },
};
const bundleArt = { id: "bundle", label: "ManaVault's art model", note: "", file: `/scan-bundle/${V}/embed.onnx`, bytes: 5_118_408 };
const yamaArt = { id: "yama-art-20261118", label: "Yama's art model, 18 Nov", note: "", file: info.files.embed, bytes: 5_139_404 };

/** A stand-in for the art worker: what it was asked, and files that won't load. */
const workers: FakeWorker[] = [];
const broken = new Set<string>();
class FakeWorker {
  onmessage: ((e: MessageEvent<ArtWorkerReply>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  readonly asked: ArtWorkerRequest[] = [];
  /** The embed graph it runs. */
  embed: string | null = null;
  terminated = false;
  constructor() {
    workers.push(this);
  }
  postMessage(m: ArtWorkerRequest) {
    this.asked.push(m);
    const reply = (r: ArtWorkerReply, after = 0) => setTimeout(() => this.onmessage?.({ data: r } as MessageEvent<ArtWorkerReply>), after);
    if (m.type === "load") {
      if (broken.has(m.embed.url)) return reply({ type: "error", message: "Couldn't download it (404)" });
      this.embed = m.embed.url;
      reply({ type: "ready", ms: 1, arts: 3 });
    } else if (m.type === "embed") {
      // A bigger file takes longer, so two switches can finish out of order unless they're queued.
      const after = m.embed.url.includes("embed.onnx") ? 30 : 5;
      setTimeout(() => {
        if (broken.has(m.embed.url)) return this.onmessage?.({ data: { type: "embedded", id: m.id, error: "Couldn't download it (404)" } } as MessageEvent<ArtWorkerReply>);
        this.embed = m.embed.url;
        this.onmessage?.({ data: { type: "embedded", id: m.id, error: null } } as MessageEvent<ArtWorkerReply>);
      }, after);
    }
  }
  terminate() {
    this.terminated = true;
  }
}

beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
  workers.length = 0;
  broken.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("the art model, switched on the fly", () => {
  it("starts with the one chosen, and names it for records", async () => {
    const art = (await loadArtRecognizer(undefined, { info, art: bundleArt }))!;
    expect(workers).toHaveLength(1);
    expect(workers[0]!.embed).toBe(bundleArt.file);
    expect([art.art, art.embed]).toEqual(["bundle", `${V}/embed.onnx`]);
    art.dispose();
  });

  it("swaps the embed graph in the same worker, and ends on the last one asked for", async () => {
    const art = (await loadArtRecognizer(undefined, { info, art: yamaArt }))!;
    await art.useArt(bundleArt);
    expect([art.art, art.embed]).toEqual(["bundle", `${V}/embed.onnx`]);
    // Back and forth quickly: the slow one first can't finish last and win.
    const first = art.useArt(yamaArt);
    const second = art.useArt(bundleArt);
    const third = art.useArt(yamaArt);
    await Promise.all([first, second, third]);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.terminated).toBe(false);
    expect(workers[0]!.embed).toBe(yamaArt.file);
    expect(art.art).toBe(yamaArt.id);
    expect(workers[0]!.asked.filter((m) => m.type === "load")).toHaveLength(1);
    art.dispose();
  });

  it("keeps the one before when a switch fails", async () => {
    const art = (await loadArtRecognizer(undefined, { info, art: yamaArt }))!;
    broken.add(bundleArt.file);
    await expect(art.useArt(bundleArt)).rejects.toThrow("404");
    expect([art.art, workers[0]!.embed]).toEqual([yamaArt.id, yamaArt.file]);
    // And the next switch still runs.
    broken.clear();
    await art.useArt(bundleArt);
    expect(art.art).toBe("bundle");
    art.dispose();
  });

  it("starts with the bundle info's own when the one chosen won't load (opening offline, say)", async () => {
    broken.add(bundleArt.file);
    const art = (await loadArtRecognizer(undefined, { info, art: bundleArt }))!;
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect([art.art, art.embed]).toEqual(["query-52420d900728", `${V}/query-52420d900728.onnx`]);
    art.dispose();
    // Named by the server's list when it has one.
    const listed = (await loadArtRecognizer(undefined, { info: { ...info, models: { art: { default: yamaArt.id, options: [bundleArt, yamaArt] } } }, art: bundleArt }))!;
    expect(listed.art).toBe(yamaArt.id);
    listed.dispose();
  });
});
