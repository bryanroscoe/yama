import { describe, expect, it } from "vitest";
import { reloadOnStaleCode } from "./lazyPages";

function store(): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

describe("a tab opened before a release", () => {
  it("reloads once when its code is gone, and shows the error if that happens again soon after", () => {
    let now = 1_000_000;
    let reloads = 0;
    const storage = store();
    const onError = reloadOnStaleCode({ storage, now: () => now, reload: () => reloads++ });
    const first = new Event("vite:preloadError", { cancelable: true });
    onError(first);
    expect(reloads).toBe(1);
    expect(first.defaultPrevented).toBe(true);
    now += 5_000;
    const again = new Event("vite:preloadError", { cancelable: true });
    onError(again);
    expect(reloads).toBe(1);
    expect(again.defaultPrevented).toBe(false);
    // A later release in the same tab gets its own reload.
    now += 10 * 60_000;
    onError(new Event("vite:preloadError", { cancelable: true }));
    expect(reloads).toBe(2);
  });

  it("doesn't reload when it can't remember having done so", () => {
    let reloads = 0;
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
    reloadOnStaleCode({ storage: blocked, reload: () => reloads++ })(new Event("vite:preloadError", { cancelable: true }));
    expect(reloads).toBe(0);
  });
});
