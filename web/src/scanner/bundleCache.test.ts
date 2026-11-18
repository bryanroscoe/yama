import { describe, expect, it } from "vitest";
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
});
