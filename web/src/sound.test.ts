import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("holdSound", () => {
  it("suspends audio once the last page using it lets go", async () => {
    const suspend = vi.fn(() => Promise.resolve());
    class FakeAudio {
      state = "running";
      suspend = suspend;
      resume = () => Promise.resolve();
    }
    vi.stubGlobal("window", { AudioContext: FakeAudio });
    const { holdSound, unlockSound } = await import("./sound");
    const scanner = holdSound();
    const deckCheck = holdSound();
    expect(unlockSound()).toBe(true);
    scanner();
    expect(suspend).not.toHaveBeenCalled();
    deckCheck();
    expect(suspend).toHaveBeenCalledTimes(1);
    // Releasing twice does nothing more.
    deckCheck();
    expect(suspend).toHaveBeenCalledTimes(1);
  });
});
