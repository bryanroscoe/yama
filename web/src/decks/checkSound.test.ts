import { afterEach, describe, expect, it, vi } from "vitest";

// A stand-in AudioContext whose state the test sets, counting resume calls.
function fakeAudio(state: string) {
  const made: { state: string; resumes: number }[] = [];
  class Fake {
    state = state;
    resumes = 0;
    currentTime = 0;
    destination = {};
    constructor() {
      made.push(this);
    }
    resume() {
      this.resumes += 1;
      this.state = "running";
      return Promise.resolve();
    }
    createBuffer() {
      return {};
    }
    createBufferSource() {
      return { buffer: null, connect() {}, start() {} };
    }
  }
  vi.stubGlobal("window", { AudioContext: Fake });
  return made;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("deck check sounds", () => {
  it("resumes a suspended context on a tap", async () => {
    const made = fakeAudio("suspended");
    const { unlockSound } = await import("./checkSound");
    expect(unlockSound()).toBe(false);
    expect(made[0]!.resumes).toBe(1);
    expect(unlockSound()).toBe(true);
  });

  it("resumes Safari's interrupted context too (after another app or a locked screen)", async () => {
    const made = fakeAudio("interrupted");
    const { unlockSound } = await import("./checkSound");
    unlockSound();
    expect(made[0]!.resumes).toBe(1);
  });

  it("starts a new context when the old one was closed", async () => {
    const made = fakeAudio("suspended");
    const { unlockSound } = await import("./checkSound");
    unlockSound();
    made[0]!.state = "closed";
    unlockSound();
    expect(made).toHaveLength(2);
    expect(made[1]!.resumes).toBe(1);
  });
});
