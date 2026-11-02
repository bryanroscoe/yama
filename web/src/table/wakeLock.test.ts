import { describe, expect, it } from "vitest";
import { holdScreenAwake, type PageHost } from "./wakeLock";

function fakes(opts: { refuse?: number } = {}) {
  const sentinels: { released: boolean; fire: () => void; release(): Promise<void>; addEventListener(t: string, fn: () => void): void }[] = [];
  let refusals = opts.refuse ?? 0;
  let requests = 0;
  const nav = {
    wakeLock: {
      request: async () => {
        requests++;
        if (refusals > 0) {
          refusals--;
          throw new Error("NotAllowedError");
        }
        let onRelease = () => {};
        const s = {
          released: false,
          fire: () => {
            s.released = true;
            onRelease();
          },
          release: async () => s.fire(),
          addEventListener: (_t: string, fn: () => void) => void (onRelease = fn),
        };
        sentinels.push(s);
        return s;
      },
    },
  };
  const listeners = new Map<string, Set<() => void>>();
  const page: PageHost & { emit(type: string): void } = {
    visibilityState: "visible",
    addEventListener: (t, fn) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn),
    removeEventListener: (t, fn) => void listeners.get(t)?.delete(fn),
    emit: (t) => listeners.get(t)?.forEach((fn) => fn()),
  };
  return { nav, page, sentinels, requests: () => requests, listeners };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("holdScreenAwake", () => {
  it("asks again when the page comes back after the browser let go", async () => {
    const f = fakes();
    holdScreenAwake(f.nav, f.page);
    await settle();
    expect(f.sentinels).toHaveLength(1);

    // Switched apps: the browser releases the lock.
    f.page.visibilityState = "hidden";
    f.sentinels[0]!.fire();
    f.page.emit("visibilitychange");
    await settle();
    expect(f.requests()).toBe(1);

    f.page.visibilityState = "visible";
    f.page.emit("visibilitychange");
    await settle();
    expect(f.sentinels).toHaveLength(2);
    expect(f.sentinels[1]!.released).toBe(false);
  });

  it("retries on the next tap when the first ask is refused, and not while held", async () => {
    const f = fakes({ refuse: 1 });
    holdScreenAwake(f.nav, f.page);
    await settle();
    expect(f.sentinels).toHaveLength(0);

    f.page.emit("click");
    await settle();
    expect(f.sentinels).toHaveLength(1);

    f.page.emit("click");
    f.page.emit("visibilitychange");
    await settle();
    expect(f.requests()).toBe(2);
  });

  it("releases on stop, including a lock granted after stopping", async () => {
    const f = fakes();
    const stop = holdScreenAwake(f.nav, f.page);
    stop();
    await settle();
    expect(f.sentinels).toHaveLength(1);
    expect(f.sentinels[0]!.released).toBe(true);
    expect([...f.listeners.values()].every((s) => s.size === 0)).toBe(true);

    f.page.emit("click");
    await settle();
    expect(f.requests()).toBe(1);
  });

  it("does nothing where the browser has no wake lock", () => {
    const f = fakes();
    const stop = holdScreenAwake({}, f.page);
    expect(f.listeners.size).toBe(0);
    stop();
  });
});
