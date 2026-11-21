import { afterEach, describe, expect, it, vi } from "vitest";
import { embedIdentity, oneLoadAtATime } from "./artClient";
import { isStale, namedPaths } from "./bundleCache";

const V = "gallery-20261106T183001884398Z";
const files = (embed: string, supplement: string | null) => ({
  detector: `/scan-bundle/${V}/detector.onnx`,
  embed: `/scan-bundle/${V}/${embed}`,
  search: `/scan-bundle/${V}/search.onnx`,
  arts: `/scan-bundle/${V}/arts.slim.json`,
  supplement,
});

describe("the art worker's cache clean-up", () => {
  it("drops what the server no longer names: older bundles, a replaced embed graph, other supplements", () => {
    for (const base of ["https://yama.ing", "http://localhost:5173"]) {
      const named = namedPaths({ files: files("query-52420d900728.onnx", `/scan-bundle/${V}/supplement-b.json`) }, base);
      const stale = (path: string) => isStale(`${base}${path}`, named);
      expect(stale(`/scan-bundle/${V}/detector.onnx`)).toBe(false);
      expect(stale(`/scan-bundle/${V}/query-52420d900728.onnx`)).toBe(false);
      expect(stale(`/scan-bundle/${V}/search.onnx`)).toBe(false);
      expect(stale(`/scan-bundle/${V}/arts.slim.json`)).toBe(false);
      expect(stale(`/scan-bundle/${V}/supplement-b.json`)).toBe(false);
      // The bundle's own embed graph once the query model replaces it, an older query model,
      // an older supplement, and every file of an older bundle.
      expect(stale(`/scan-bundle/${V}/embed.onnx`)).toBe(true);
      expect(stale(`/scan-bundle/${V}/query-000000000000.onnx`)).toBe(true);
      expect(stale(`/scan-bundle/${V}/supplement-a.json`)).toBe(true);
      expect(stale("/scan-bundle/retrain-20261026T052522727512Z/detector.onnx")).toBe(true);
      // Not the scanner's bundle files: the WASM runtime stays.
      expect(stale("/assets/ort-wasm-simd-threaded-abc123.wasm")).toBe(false);
    }
  });

  it("keeps the bundle's embed graph when that is what the server names, and no supplement means none kept", () => {
    const named = namedPaths({ files: files("embed.onnx", null) }, "https://yama.ing");
    expect(isStale(`https://yama.ing/scan-bundle/${V}/embed.onnx`, named)).toBe(false);
    expect(isStale(`https://yama.ing/scan-bundle/${V}/query-52420d900728.onnx`, named)).toBe(true);
    expect(isStale(`https://yama.ing/scan-bundle/${V}/supplement-b.json`, named)).toBe(true);
  });

  it("keeps every model the server offers in a slot, so switching back in Scan settings needs no download", () => {
    const models = {
      art: { default: "yama-art-20261118", options: [{ id: "bundle", label: "", note: "", file: `/scan-bundle/${V}/embed.onnx` }, { id: "yama-art-20261118", label: "", note: "", file: `/scan-bundle/${V}/query-52420d900728.onnx` }] },
      look: { default: "off", options: [{ id: "off", label: "", note: "" }, { id: "look-v0", label: "", note: "", file: `/scan-bundle/${V}/look-58acfa166105.onnx` }] },
    };
    const named = namedPaths({ files: files("query-52420d900728.onnx", null), models }, "https://yama.ing");
    expect(isStale(`https://yama.ing/scan-bundle/${V}/embed.onnx`, named)).toBe(false);
    expect(isStale(`https://yama.ing/scan-bundle/${V}/look-58acfa166105.onnx`, named)).toBe(false);
    // One the server stopped offering (withdrawn, or an older pin) goes.
    expect(isStale(`https://yama.ing/scan-bundle/${V}/query-000000000000.onnx`, named)).toBe(true);
  });

  it("names the bundle and embed graph a recognizer runs, for kept photos and diagnostics", () => {
    expect(embedIdentity({ version: V, files: files("query-52420d900728.onnx", null) })).toBe(`${V}/query-52420d900728.onnx`);
    expect(embedIdentity({ version: V, files: files("embed.onnx", null) })).toBe(`${V}/embed.onnx`);
  });
});

describe("one scanner load at a time across tabs", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A lock manager that grants one request at a time, in order. */
  const fairLocks = () => {
    let tail: Promise<unknown> = Promise.resolve();
    return {
      request: (_name: string, _opts: unknown, grant: () => Promise<unknown>) => {
        const run = tail.then(grant);
        tail = run.catch(() => undefined);
        return run;
      },
    };
  };

  it("never runs two loads at once, and runs without the API", async () => {
    vi.stubGlobal("navigator", { locks: fairLocks() });
    let running = 0;
    let most = 0;
    const load = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return "loaded";
    };
    expect(await Promise.all([oneLoadAtATime(load), oneLoadAtATime(load), oneLoadAtATime(load)])).toEqual(["loaded", "loaded", "loaded"]);
    expect(most).toBe(1);
    vi.stubGlobal("navigator", {});
    expect(await oneLoadAtATime(async () => "no locks")).toBe("no locks");
  });

  it("loads anyway when another tab holds the lock too long, but never runs a failed load twice", async () => {
    const stuck = {
      request: (_name: string, opts: { signal: AbortSignal }) =>
        new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new DOMException("gave up", "AbortError")))),
    };
    vi.stubGlobal("navigator", { locks: stuck });
    expect(await oneLoadAtATime(async () => "went ahead", 10)).toBe("went ahead");
    vi.stubGlobal("navigator", { locks: fairLocks() });
    let tries = 0;
    await expect(
      oneLoadAtATime(async () => {
        tries += 1;
        throw new DOMException("download stopped", "AbortError");
      }),
    ).rejects.toThrow("download stopped");
    expect(tries).toBe(1);
  });
});
