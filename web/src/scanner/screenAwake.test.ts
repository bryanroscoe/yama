// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { keepScreenAwake } from "./screenAwake";

const flush = () => new Promise((r) => setTimeout(r, 0));
let hidden = false;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
const turn = async (h: boolean) => {
  hidden = h;
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
};
afterEach(() => {
  hidden = false;
});

/** A browser's Screen Wake Lock: what it was asked for, and the locks it handed out. */
function browserLock() {
  const locks: { released: boolean; release(): Promise<void> }[] = [];
  return {
    locks,
    request: async () => {
      const s = {
        released: false,
        release: async () => {
          s.released = true;
        },
      };
      locks.push(s);
      return s;
    },
  };
}

describe("keeping the screen on while the scanner's camera runs (Bryan, 22 Nov 2026)", () => {
  it("in the app, asks the app, lets go in the background and again on closing", async () => {
    const calls: boolean[] = [];
    const lock = browserLock();
    const release = keepScreenAwake({ native: async (on) => (calls.push(on), true), wakeLock: lock });
    await flush();
    expect(calls).toEqual([true]);
    await turn(true);
    expect(calls).toEqual([true, false]);
    await turn(false);
    expect(calls).toEqual([true, false, true]);
    release();
    await flush();
    expect(calls).toEqual([true, false, true, false]);
    // The browser's lock is never asked for when the app holds the screen.
    expect(lock.locks).toHaveLength(0);
  });

  it("with an APK from before the app's method, falls back to the browser's lock (none in a web view: nothing breaks)", async () => {
    const lock = browserLock();
    const release = keepScreenAwake({ native: async () => false, wakeLock: lock });
    await flush();
    expect(lock.locks).toHaveLength(1);
    release();
    expect(lock.locks[0]!.released).toBe(true);
    const none = keepScreenAwake({ native: async () => false, wakeLock: null });
    await flush();
    none();
  });

  it("in a browser, asks for the lock again when the page is back (the browser lets it go when hidden)", async () => {
    const lock = browserLock();
    const release = keepScreenAwake({ native: async () => false, wakeLock: lock });
    await flush();
    lock.locks[0]!.released = true;
    await turn(true);
    expect(lock.locks).toHaveLength(1);
    await turn(false);
    expect(lock.locks).toHaveLength(2);
    // Back again while the lock still holds: not asked twice.
    await turn(false);
    expect(lock.locks).toHaveLength(2);
    release();
    expect(lock.locks[1]!.released).toBe(true);
  });

  it("closed before the app or the browser answered, lets go of what then arrives", async () => {
    const calls: boolean[] = [];
    const release = keepScreenAwake({ native: async (on) => (calls.push(on), true), wakeLock: null });
    release();
    await flush();
    expect(calls).toEqual([true, false]);
    const lock = browserLock();
    const release2 = keepScreenAwake({ native: async () => false, wakeLock: lock });
    release2();
    await flush();
    await flush();
    expect(lock.locks.every((l) => l.released)).toBe(true);
  });

  it("goes on scanning when the browser refuses the lock", async () => {
    const release = keepScreenAwake({
      native: async () => false,
      wakeLock: {
        request: async () => {
          throw new Error("NotAllowedError");
        },
      },
    });
    await flush();
    release();
  });

  it("keeps the app's one flag on while any scanner holds it, in the order asked (independent review of #202)", async () => {
    const calls: boolean[] = [];
    const native = async (on: boolean) => (calls.push(on), true);
    const first = keepScreenAwake({ native, wakeLock: null });
    await flush();
    // The camera restarts: the old hold is let go as a new one starts, before either is answered.
    first();
    const second = keepScreenAwake({ native, wakeLock: null });
    await flush();
    await flush();
    // Whatever went between, the flag ends on.
    expect(calls.at(-1)).toBe(true);
    const third = keepScreenAwake({ native, wakeLock: null });
    await flush();
    second();
    await flush();
    expect(calls.at(-1)).toBe(true);
    third();
    await flush();
    expect(calls.at(-1)).toBe(false);
  });

  it("lets the app's flag go when the app goes to the background before it answered (Codex review of #202)", async () => {
    const calls: boolean[] = [];
    let answer: (ok: boolean) => void = () => undefined;
    const native = (on: boolean) => {
      calls.push(on);
      return on ? new Promise<boolean>((r) => (answer = r)) : Promise.resolve(true);
    };
    const release = keepScreenAwake({ native, wakeLock: null });
    await flush();
    expect(calls).toEqual([true]);
    await turn(true);
    answer(true);
    await flush();
    await flush();
    // Off once the first answer is in: hidden, nothing holds the screen.
    expect(calls).toEqual([true, false]);
    release();
    await flush();
    expect(calls).toEqual([true, false]);
  });
});
