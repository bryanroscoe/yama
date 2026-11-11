import { describe, expect, it } from "vitest";
import type { ComponentType } from "react";
import { boundaryState, reloadOnStaleCode, retryingLazy } from "./lazyPages";

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

describe("a page whose code didn't arrive", () => {
  it("asks for the code again on the next try, instead of failing for good", async () => {
    const Page: ComponentType = () => null;
    let online = false;
    let loads = 0;
    const load = async () => {
      loads++;
      if (!online) throw new TypeError("Failed to fetch dynamically imported module");
      return Page;
    };
    // Stands in for React.lazy: each lazy component keeps its factory, as React does.
    const factories: (() => Promise<{ default: ComponentType }>)[] = [];
    const attempt = retryingLazy(load, (factory) => factories.push(factory) - 1);

    const first = attempt("/decks#0");
    await expect(factories[first]!()).rejects.toThrow("Failed to fetch");
    // React renders the failed page once more before showing the error: the same try keeps its
    // failure (a fresh load here would suspend, fail and start over without end).
    expect(attempt("/decks#0")).toBe(first);
    expect(loads).toBe(1);
    // Try again (or the connection coming back) is a new try, with a fresh load.
    const second = attempt("/decks#1");
    expect(second).not.toBe(first);
    online = true;
    await expect(factories[second]!()).resolves.toEqual({ default: Page });
    expect(loads).toBe(2);
    // A page that loaded stays as it is, whichever try shows it.
    expect(attempt("/decks#2")).toBe(second);
    expect(attempt("/collection#0")).toBe(second);
  });

  it("starts afresh at another address after a failure", async () => {
    const factories: (() => Promise<{ default: ComponentType }>)[] = [];
    const attempt = retryingLazy(async () => { throw new TypeError("Failed to fetch"); }, (factory) => factories.push(factory) - 1);
    const first = attempt("/decks#0");
    await expect(factories[first]!()).rejects.toThrow();
    expect(attempt("/decks/d1#0")).not.toBe(first);
  });

  it("keeps its error for the address it happened at, and tries afresh at another", () => {
    const failed = new Error("boom");
    expect(boundaryState("/decks", { error: null, at: null })).toEqual({ at: "/decks" });
    expect(boundaryState("/decks", { error: failed, at: "/decks" })).toBeNull();
    expect(boundaryState("/collection", { error: failed, at: "/decks" })).toEqual({ error: null, at: "/collection" });
  });
});
