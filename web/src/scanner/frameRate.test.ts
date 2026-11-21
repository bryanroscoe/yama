import { afterEach, describe, expect, it, vi } from "vitest";
import { ask60, askUsualRate, fps60On, FPS60_KEY, FrameRateMeter, offers60, setFps60 } from "./frameRate";

// Asking the camera for 60 frames a second without giving up resolution, and measuring what it
// really delivers (frameRate.ts).

function camera(opts: { max?: number; now?: { width?: number; height?: number; frameRate?: number }; onApply?: (c: MediaTrackConstraints, settings: { width?: number; height?: number; frameRate?: number }) => void }) {
  const settings = { width: 1920, height: 1080, frameRate: 30, ...opts.now };
  const asked: MediaTrackConstraints[] = [];
  return {
    asked,
    settings,
    getCapabilities: () => (opts.max == null ? {} : { frameRate: { min: 1, max: opts.max } }),
    getSettings: () => ({ ...settings }),
    applyConstraints: async (c?: MediaTrackConstraints) => {
      asked.push(c!);
      opts.onApply?.(c!, settings);
    },
  };
}

describe("asking for 60 frames a second", () => {
  it("asks with the size delivered now as the least it will take", async () => {
    const cam = camera({ max: 60, onApply: (_, s) => (s.frameRate = 60) });
    expect(offers60(cam)).toBe(true);
    expect(await ask60(cam)).toBe("sixty");
    expect(cam.asked).toEqual([{ width: { min: 1920, ideal: 1920 }, height: { min: 1080, ideal: 1080 }, frameRate: { min: 50, ideal: 60 } }]);
  });

  it("asks nothing of a camera that tops out at 30, or is already at 60", async () => {
    const thirty = camera({ max: 30 });
    expect(offers60(thirty)).toBe(false);
    expect(await ask60(thirty)).toBe("unavailable");
    const unknown = camera({});
    expect(await ask60(unknown)).toBe("unavailable");
    const already = camera({ max: 60, now: { frameRate: 59.94 } });
    expect(await ask60(already)).toBe("already");
    expect([...thirty.asked, ...unknown.asked, ...already.asked]).toEqual([]);
  });

  it("leaves the camera as it is when it can't do 60 at this size", async () => {
    const cam = camera({
      max: 60,
      now: { width: 3840, height: 2160 },
      onApply: () => {
        throw new DOMException("no", "OverconstrainedError");
      },
    });
    expect(await ask60(cam)).toBe("refused");
    expect(cam.settings).toEqual({ width: 3840, height: 2160, frameRate: 30 });
  });

  it("gives the rate back if the picture came back smaller all the same", async () => {
    const cam = camera({
      max: 60,
      now: { width: 3840, height: 2160 },
      onApply: (c, s) => {
        if (c.frameRate) Object.assign(s, { width: 1920, height: 1080, frameRate: 60 });
        else Object.assign(s, { width: 3840, height: 2160, frameRate: 30 });
      },
    });
    expect(await ask60(cam)).toBe("refused");
    expect(cam.asked[1]).toEqual({ width: { ideal: 3840 }, height: { ideal: 2160 } });
    expect(cam.settings.width).toBe(3840);
  });

  it("goes back to the usual rate at the same size when turned off", async () => {
    const cam = camera({ max: 60, now: { frameRate: 60 } });
    await askUsualRate(cam);
    expect(cam.asked).toEqual([{ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }]);
  });
});

describe("the 60 frames switch", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("is on until turned off, on this device", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    expect(fps60On()).toBe(true);
    setFps60(false);
    expect(store.get(FPS60_KEY)).toBe("0");
    expect(fps60On()).toBe(false);
    setFps60(true);
    expect(fps60On()).toBe(true);
  });
});

describe("the frame rate the camera delivers", () => {
  it("is measured from the frames presented, over the last two seconds", () => {
    const m = new FrameRateMeter();
    expect(m.fps(0)).toBeNull();
    for (let i = 0; i <= 10; i += 1) m.tick(i * 33.3);
    // A third of a second isn't enough to say.
    expect(m.fps(333)).toBeNull();
    for (let i = 11; i <= 90; i += 1) m.tick(i * 33.3);
    expect(m.fps(90 * 33.3)).toBeCloseTo(30, 0);
    // The camera now delivers 60: within two seconds the old frames are out of the window.
    const from = 90 * 33.3;
    for (let i = 1; i <= 150; i += 1) m.tick(from + i * 16.67);
    const last = from + 150 * 16.67;
    expect(m.fps(last + 10)).toBeCloseTo(60, 0);
    // No frame for over a second (the camera stopped, the tab was hidden): nothing to say.
    expect(m.fps(last + 1200)).toBeNull();
    m.reset();
    expect(m.fps(last)).toBeNull();
  });
});
