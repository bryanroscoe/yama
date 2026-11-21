import { afterEach, describe, expect, it, vi } from "vitest";
import { clampFocus, distanceToSlider, fmtFocus, FOCUS_KEY, focusRange, saveFocus, savedFocus, sliderToDistance } from "./cameraFocus";

// Pinning the lens (cameraFocus.ts): offered only where the browser has a manual focus mode, a
// focus distance and a way back to autofocus.

const track = (focusMode: string[] | undefined, focusDistance?: { min?: number; max?: number }) => ({ getCapabilities: () => ({ focusMode, focusDistance }) as MediaTrackCapabilities });

describe("where the lens can be pinned", () => {
  it("is from the camera's nearest focus to a metre, with continuous autofocus to go back to", () => {
    expect(focusRange(track(["continuous", "manual"], { min: 0.08, max: 12 }))).toEqual({ near: 0.08, far: 1, auto: "continuous" });
    expect(focusRange(track(["single-shot", "manual"], { min: 0.1, max: 0.6 }))).toEqual({ near: 0.1, far: 0.6, auto: "single-shot" });
    // A nearest distance of nothing, and a farthest of infinity.
    expect(focusRange(track(["continuous", "manual"], { min: 0, max: Infinity }))).toEqual({ near: 0.03, far: 1, auto: "continuous" });
  });

  it("isn't offered without a manual mode, a distance range, or a way back", () => {
    expect(focusRange(null)).toBeNull();
    expect(focusRange(track(undefined))).toBeNull();
    expect(focusRange(track(["continuous"], { min: 0.1, max: 2 }))).toBeNull();
    expect(focusRange(track(["manual"], { min: 0.1, max: 2 }))).toBeNull();
    expect(focusRange(track(["continuous", "manual"]))).toBeNull();
    expect(focusRange(track(["continuous", "manual"], { min: 2, max: 5 }))).toBeNull();
  });
});

describe("the focus slider", () => {
  const r = { near: 0.08, far: 1, auto: "continuous" as const };
  it("runs near to far, with the close end given as much room as the far end", () => {
    expect(sliderToDistance(r, 0)).toBe(0.08);
    expect(sliderToDistance(r, 1)).toBe(1);
    // Halfway along is the middle by ratio (28 cm), not by distance (54 cm).
    expect(sliderToDistance(r, 0.5)).toBeCloseTo(0.283, 3);
    for (const d of [0.08, 0.15, 0.3, 0.7, 1]) expect(sliderToDistance(r, distanceToSlider(r, d))).toBeCloseTo(d, 2);
    expect(sliderToDistance(r, -1)).toBe(0.08);
    expect(sliderToDistance(r, 2)).toBe(1);
  });

  it("keeps a distance within the camera's range, and says it plainly", () => {
    expect(clampFocus(r, 0.01)).toBe(0.08);
    expect(clampFocus(r, 5)).toBe(1);
    expect(fmtFocus(0.123)).toBe("12 cm");
    expect(fmtFocus(1)).toBe("1 m");
  });
});

describe("the pin is remembered on this device", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("with its distance, and nothing unreadable counts", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    expect(savedFocus()).toBeNull();
    saveFocus({ pinned: true, distance: 0.14 });
    expect(savedFocus()).toEqual({ pinned: true, distance: 0.14 });
    store.set(FOCUS_KEY, '{"pinned":true,"distance":"near"}');
    expect(savedFocus()).toBeNull();
    store.set(FOCUS_KEY, "not json");
    expect(savedFocus()).toBeNull();
  });
});
