import { describe, expect, it } from "vitest";
import { HAND_MAX, serialApplier, zoomSteps, zoomTop } from "./camera";
import { LENS_SWITCH } from "./zoomPolicy";

describe("camera zoom and constraints (review of #145)", () => {
  it("never steps + past 4×, below the lens switch, whatever the camera's own top end", () => {
    const caps = { torch: false, exposure: null, zoom: { min: 1, max: 10 } };
    expect(HAND_MAX).toBeLessThan(LENS_SWITCH);
    expect(zoomTop(caps)).toBe(4);
    expect(zoomSteps(caps, 4).above).toBeUndefined();
    expect(zoomSteps(caps, 3).above).toBe(4);
    // A camera that zooms less than that: its own top end.
    expect(zoomTop({ torch: false, exposure: null, zoom: { min: 1, max: 2.5 } })).toBe(2.5);
    // Digital zoom: its own limit.
    expect(zoomTop({ torch: false, exposure: null, zoom: null })).toBe(3);
  });

  it("applies focus and zoom one at a time, each on top of the other, never losing one", async () => {
    const track = {} as MediaStreamTrack;
    const sent: Record<string, unknown>[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const a = serialApplier(async (_t, all) => {
      sent.push(all);
      if (sent.length === 1) await slow;
    }, () => track);
    a.reset({});
    const zoom = a.set(track, { zoom: 2 });
    const focus = a.set(track, { pointsOfInterest: [{ x: 0.2, y: 0.9 }] });
    release();
    await Promise.all([zoom, focus]);
    expect(sent).toEqual([{ zoom: 2 }, { zoom: 2, pointsOfInterest: [{ x: 0.2, y: 0.9 }] }]);
    expect(a.applied()).toEqual({ zoom: 2, pointsOfInterest: [{ x: 0.2, y: 0.9 }] });
  });

  it("drops a change meant for a camera that's no longer current, and says so", async () => {
    let current: MediaStreamTrack | null = {} as MediaStreamTrack;
    const old = current;
    const sent: unknown[] = [];
    const a = serialApplier(async (_t, all) => void sent.push(all), () => current);
    current = {} as MediaStreamTrack;
    await expect(a.set(old!, { zoom: 3 })).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it("says a change that finished after the camera changed didn't apply, and doesn't record it", async () => {
    const a1 = {} as MediaStreamTrack;
    let current: MediaStreamTrack = a1;
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const a = serialApplier(async () => slow, () => current);
    const pending = a.set(a1, { zoom: 4 });
    current = {} as MediaStreamTrack;
    a.reset({});
    release();
    await expect(pending).resolves.toBe(false);
    expect(a.applied()).toEqual({});
    // And one for the camera in use: true.
    const ok = serialApplier(async () => undefined, () => current);
    await expect(ok.set(current, { torch: true })).resolves.toBe(true);
  });
});
