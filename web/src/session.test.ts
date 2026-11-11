import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { accountPageOpen, cacheStep, followSession, keptAcrossAccounts, ME_KEY, releaseSession, releaseStep, SIGNED_OUT_KEY, signInEnded, signingOut, startSession, storageStep } from "./session";

const open = { pages: 1, deliberate: false };
const none = { pages: 0, deliberate: false };

describe("whose data the cache holds", () => {
  it("empties when another account signs in, and when the account signs out", () => {
    expect(cacheStep({ owner: "a", lapsed: null }, "b", open)).toMatchObject({ owner: "b", clear: true });
    expect(cacheStep({ owner: "a", lapsed: null }, null, none)).toMatchObject({ owner: null, lapsed: null, clear: true });
    expect(cacheStep({ owner: null, lapsed: null }, "a", none)).toMatchObject({ owner: "a", clear: true });
  });

  it("stays as it is while the same account stays signed in, or nobody is", () => {
    expect(cacheStep({ owner: "a", lapsed: null }, "a", open)).toMatchObject({ owner: "a", clear: false, refresh: false });
    expect(cacheStep({ owner: null, lapsed: null }, null, open)).toMatchObject({ owner: null, clear: false, refresh: false });
  });

  it("keeps an open page's data when its sign-in ends, for that account's return", () => {
    const lapsed = cacheStep({ owner: "a", lapsed: null }, null, open);
    expect(lapsed).toMatchObject({ owner: "a", lapsed: "a", clear: false });
    // Still signed out: still waiting.
    expect(cacheStep(lapsed, null, open)).toMatchObject({ owner: "a", lapsed: "a", clear: false });
    // The same account again: carry on, and ask again for what failed meanwhile.
    expect(cacheStep(lapsed, "a", open)).toMatchObject({ owner: "a", lapsed: null, clear: false, refresh: true });
    // Someone else: nothing of the first account is left for them.
    expect(cacheStep(lapsed, "b", open)).toMatchObject({ owner: "b", lapsed: null, clear: true });
  });

  it("never keeps a page waiting after a sign-out the person asked for, or with no page open", () => {
    expect(cacheStep({ owner: "a", lapsed: null }, null, { pages: 1, deliberate: true })).toMatchObject({ owner: null, lapsed: null, clear: true });
    expect(cacheStep({ owner: "a", lapsed: null }, null, none)).toMatchObject({ lapsed: null, clear: true });
  });

  it("lets go of the data when the page stops waiting", () => {
    expect(releaseStep({ owner: "a", lapsed: "a" })).toEqual({ owner: null, lapsed: null, clear: true });
    expect(releaseStep({ owner: "a", lapsed: null })).toMatchObject({ owner: "a", clear: false });
  });

  it("keeps only what holds nothing of an account", () => {
    expect(keptAcrossAccounts(["me"])).toBe(true);
    expect(keptAcrossAccounts(["auth-config"])).toBe(true);
    expect(keptAcrossAccounts(["shared-deck", "tok"])).toBe(true);
    // A guest's own card search; an account's carries its copies.
    expect(keptAcrossAccounts(["search", "sol ring", "name", 1, true])).toBe(true);
    expect(keptAcrossAccounts(["search", "sol ring", "name", 1, false])).toBe(false);
    for (const family of ["collection", "collection-summary", "decks", "deck", "plan", "games", "playgroups", "containers", "sharing", "research", "lab", "advisor"]) {
      expect(keptAcrossAccounts([family, "x"])).toBe(false);
    }
  });
});

describe("a request refused with 401", () => {
  it("asks who is signed in only when the app believed someone was", () => {
    expect(signInEnded(new ApiError(401, "Sign in"), true)).toBe(true);
    expect(signInEnded(new ApiError(401, "Wrong password"), false)).toBe(false);
    expect(signInEnded(new ApiError(403, "Not yours"), true)).toBe(false);
    expect(signInEnded(new TypeError("Failed to fetch"), true)).toBe(false);
  });
});

describe("another tab of this browser", () => {
  it("signs this one out when it signs out", () => {
    expect(storageStep({ key: SIGNED_OUT_KEY, newValue: "1762868000000" }, "a")).toBe("reload");
    expect(storageStep({ key: SIGNED_OUT_KEY, newValue: null }, "a")).toBe("none");
  });

  it("asks who is signed in when the account changed there", () => {
    expect(storageStep({ key: ME_KEY, newValue: JSON.stringify({ id: "b" }) }, "a")).toBe("ask");
    expect(storageStep({ key: ME_KEY, newValue: null }, "a")).toBe("ask");
    expect(storageStep({ key: ME_KEY, newValue: JSON.stringify({ id: "a" }) }, null)).toBe("ask");
    expect(storageStep({ key: ME_KEY, newValue: "{broken" }, "a")).toBe("ask");
  });

  it("ignores the same account and unrelated keys", () => {
    expect(storageStep({ key: ME_KEY, newValue: JSON.stringify({ id: "a", display_name: "A" }) }, "a")).toBe("none");
    expect(storageStep({ key: ME_KEY, newValue: null }, null)).toBe("none");
    expect(storageStep({ key: "yama.table.lastSetup.a", newValue: "{}" }, "a")).toBe("none");
    expect(storageStep({ key: null, newValue: null }, "a")).toBe("none");
  });
});

describe("this tab's cache as accounts come and go", () => {
  afterEach(() => vi.unstubAllGlobals());

  function cache(owner: string | null) {
    const qc = new QueryClient();
    qc.setQueryData(["me"], owner ? { id: owner } : null);
    qc.setQueryData(["auth-config"], { open_signup: true });
    qc.setQueryData(["collection", "all"], [{ name: "Black Lotus" }]);
    qc.setQueryData(["deck", "d1"], { id: "d1" });
    qc.setQueryData(["plan", owner], { decks: [] });
    startSession(qc, owner);
    const families = () => qc.getQueryCache().getAll().map((q) => String(q.queryKey[0])).sort();
    return { qc, families };
  }

  it("holds nothing of the last account once another signs in", () => {
    const { families } = cache("a");
    followSession("a");
    expect(families()).toEqual(["auth-config", "collection", "deck", "me", "plan"]);
    followSession("b");
    expect(families()).toEqual(["auth-config", "me"]);
  });

  it("empties on a 401 at start (the saved account was never confirmed by the server), even with a page open", () => {
    const { families } = cache("a");
    const close = accountPageOpen();
    followSession(null);
    expect(families()).toEqual(["auth-config", "me"]);
    close();
  });

  it("keeps an open page's data through a sign-in that ended, then refreshes it for the same account", () => {
    const { qc, families } = cache("a");
    followSession("a");
    const close = accountPageOpen();
    followSession(null);
    expect(families()).toEqual(["auth-config", "collection", "deck", "me", "plan"]);
    followSession("a");
    expect(families()).toEqual(["auth-config", "collection", "deck", "me", "plan"]);
    // Asked again as the account that's back; who is signed in was just answered.
    expect(qc.getQueryState(["deck", "d1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["me"])?.isInvalidated).toBe(false);
    close();
  });

  it("drops the data when the waiting page closes, or the person carries on signed out", () => {
    const first = cache("a");
    followSession("a");
    const close = accountPageOpen();
    followSession(null);
    close();
    expect(first.families()).toEqual(["auth-config", "me"]);

    const second = cache("a");
    followSession("a");
    const closeSecond = accountPageOpen();
    followSession(null);
    releaseSession();
    expect(second.families()).toEqual(["auth-config", "me"]);
    closeSecond();
  });

  it("drops the data on Sign out, and tells the browser's other tabs", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { setItem: (k: string, v: string) => void stored.set(k, v) });
    const { families } = cache("a");
    followSession("a");
    const close = accountPageOpen();
    signingOut();
    followSession(null);
    expect(families()).toEqual(["auth-config", "me"]);
    expect(stored.has(SIGNED_OUT_KEY)).toBe(true);
    close();
  });
});
