import { beforeEach, describe, expect, it, vi } from "vitest";

// The store keeps its games in localStorage; Node has none without a file, so give it a map.
const items = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => items.get(k) ?? null,
  setItem: (k: string, v: string) => void items.set(k, v),
  removeItem: (k: string) => void items.delete(k),
});

class ApiError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}
const calls: { path: string; method: string }[] = [];
let failWith: number | "offline" | null = null;
/** POSTs to /api/games answer 410: the game was deleted on another device. */
let goneOnPost = false;
vi.mock("../api", () => ({
  ApiError,
  api: vi.fn(async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    if (failWith === "offline") throw new TypeError("Failed to fetch");
    if (method === "DELETE" && failWith !== null) throw new ApiError(failWith);
    if (method === "POST" && path === "/api/games" && goneOnPost) throw new ApiError(410);
    calls.push({ path, method });
    return {};
  }),
}));
vi.mock("../viewingFlag", () => ({ isViewing: () => false }));
let guest = false;
vi.mock("../guest", () => ({ isGuest: () => guest }));

items.set("yama.me", JSON.stringify({ id: "me" }));
const store = await import("./store");

const setup = (id: string) => ({ id, startedAt: "2026-10-31T19:00:00Z", format: "commander" as const, startingLife: 40, players: [{ seat: 0, name: "Bryan", colorIdentity: "" }] });

describe("deleting table games", () => {
  beforeEach(() => {
    calls.length = 0;
    failWith = null;
    goneOnPost = false;
  });

  it("discarding a game deletes Yama's copy too", async () => {
    store.startGame(setup("g-discard"));
    await store.sync();
    store.discardGame();
    await vi.waitFor(() => expect(calls).toContainEqual({ path: "/api/games/g-discard", method: "DELETE" }));
    expect(store.getGame()).toBeNull();
  });

  it("a delete waits offline and goes once the connection is back", async () => {
    failWith = "offline";
    expect(await store.deleteGame("g-offline")).toBe(false);
    expect(JSON.parse(items.get("yama.table.deletes")!)).toEqual([{ id: "g-offline", owner: "me" }]);
    failWith = null;
    await store.sync();
    expect(calls).toContainEqual({ path: "/api/games/g-offline", method: "DELETE" });
    expect(JSON.parse(items.get("yama.table.deletes")!)).toEqual([]);
  });

  it("a game Yama never had counts as deleted", async () => {
    failWith = 404;
    expect(await store.deleteGame("g-never")).toBe(true);
  });

  it("a game deleted on another device leaves this one too, without an error", async () => {
    store.startGame(setup("g-elsewhere"));
    goneOnPost = true;
    await store.sync();
    expect(store.getGame()).toBeNull();
    expect(JSON.parse(items.get("yama.table.rejected")!)).toEqual([]);
  });

  it("another account's queued delete waits for that account", async () => {
    failWith = "offline";
    await store.deleteGame("g-theirs");
    failWith = null;
    items.set("yama.me", JSON.stringify({ id: "someone-else" }));
    await store.sync();
    expect(calls).not.toContainEqual({ path: "/api/games/g-theirs", method: "DELETE" });
    items.set("yama.me", JSON.stringify({ id: "me" }));
    await store.sync();
    expect(calls).toContainEqual({ path: "/api/games/g-theirs", method: "DELETE" });
  });
});

describe("games counted without an account", () => {
  beforeEach(() => {
    calls.length = 0;
    failWith = null;
    goneOnPost = false;
  });

  it("stay on the phone until whoever signs in saves them", async () => {
    guest = true;
    store.startGame(setup("guest-1"));
    store.dispatch({ type: "life", seat: 0, delta: -3 });
    await store.sync();
    store.finishGame(0);
    await store.sync();
    expect(calls).toEqual([]);
    expect(store.getGame()).toBeNull();
    expect(JSON.parse(items.get("yama.table.guestGames")!).map((g: { setup: { id: string } }) => g.setup.id)).toEqual(["guest-1"]);
    // Discarding one never asks Yama to delete anything.
    store.startGame(setup("guest-2"));
    store.discardGame();
    await store.sync();
    expect(calls).toEqual([]);
    // Signed in, saved: it uploads with its finish.
    guest = false;
    store.saveGuestGames();
    await store.sync();
    expect(calls.map((c) => c.path)).toEqual(["/api/games", "/api/games/guest-1/finish"]);
    expect(JSON.parse(items.get("yama.table.guestGames")!)).toEqual([]);
  });

  it("a game going when they sign in waits too, until saved", async () => {
    guest = true;
    store.startGame(setup("guest-3"));
    guest = false;
    await store.sync();
    expect(calls).toEqual([]);
    store.saveGuestGames();
    await store.sync();
    expect(calls.map((c) => c.path)).toContain("/api/games");
    store.discardGame();
    await store.sync();
  });
});

describe("the game slot without an account", () => {
  it("never mixes with an account's game, and joins it only when saved into an empty slot", async () => {
    guest = false;
    store.startGame(setup("account-1"));
    // Signed out, counting without an account: the account's game isn't there.
    guest = true;
    store.selectSlot(true);
    expect(store.getGame()).toBeNull();
    store.startGame(setup("guest-9"));
    store.dispatch({ type: "life", seat: 0, delta: -2 });
    // Signed in: the account's own game, untouched; the guest game waits, unsaved.
    guest = false;
    store.selectSlot(false);
    expect(store.getGame()?.setup.id).toBe("account-1");
    // Saving with another game going leaves it waiting.
    store.saveGuestGames();
    store.selectSlot(true);
    expect(store.getGame()).toMatchObject({ setup: { id: "guest-9" }, guest: true });
    expect(store.getGame()!.log).toHaveLength(1);
    // Once the account's game is gone, saving brings it over as the account's own.
    store.selectSlot(false);
    store.discardGame();
    store.saveGuestGames();
    expect(store.getGame()?.setup.id).toBe("guest-9");
    expect(store.getGame()!.guest).toBeUndefined();
    // And the guest slot is empty again.
    store.selectSlot(true);
    expect(store.getGame()).toBeNull();
    store.selectSlot(false);
    store.discardGame();
    await store.sync();
  });
});

describe("whose games upload", () => {
  it("uploads only the games of the account signed in here", async () => {
    guest = false;
    calls.length = 0;
    // Saved by another account that signed out before it went up.
    items.set("yama.me", JSON.stringify({ id: "someone-else" }));
    guest = true;
    store.startGame(setup("theirs-1"));
    store.finishGame(0);
    guest = false;
    // Saved while offline: it waits in the outbox.
    failWith = "offline";
    store.saveGuestGames();
    await store.sync();
    failWith = null;
    calls.length = 0;
    // Now "me" signs in on the phone: their game isn't sent under "me".
    items.set("yama.me", JSON.stringify({ id: "me" }));
    await store.sync();
    expect(calls.map((c) => c.path)).not.toContain("/api/games/theirs-1/finish");
    // Back as them: it goes up.
    items.set("yama.me", JSON.stringify({ id: "someone-else" }));
    await store.sync();
    expect(calls.map((c) => c.path)).toContain("/api/games/theirs-1/finish");
    items.set("yama.me", JSON.stringify({ id: "me" }));
  });
});

describe("each account's game", () => {
  it("is its own: another account signing in on the phone doesn't see it", async () => {
    guest = false;
    items.set("yama.me", JSON.stringify({ id: "alice" }));
    store.selectSlot(false, "alice");
    store.startGame(setup("alice-1"));
    // Alice signs out, Bob signs in: no game of Alice's.
    items.set("yama.me", JSON.stringify({ id: "bob" }));
    store.selectSlot(false, "bob");
    expect(store.getGame()).toBeNull();
    // Alice again: hers, as she left it.
    items.set("yama.me", JSON.stringify({ id: "alice" }));
    store.selectSlot(false, "alice");
    expect(store.getGame()?.setup.id).toBe("alice-1");
    store.discardGame();
    await store.sync();
    items.set("yama.me", JSON.stringify({ id: "me" }));
    store.selectSlot(false, null);
  });

  it("takes a game from the old shared key only if it's that account's", () => {
    items.set("yama.table.current", JSON.stringify({ setup: setup("old-carol"), log: [], redo: [], syncedThrough: 0, owner: "carol" }));
    store.selectSlot(false, "dave");
    expect(store.getGame()).toBeNull();
    store.selectSlot(false, "carol");
    expect(store.getGame()?.setup.id).toBe("old-carol");
    expect(items.get("yama.table.current")).toBeUndefined();
    store.discardGame();
    store.selectSlot(false, null);
  });
});


describe("a second tab following the host", () => {
  it("cannot edit or upload its old local snapshot, or overwrite the host's newer storage", async () => {
    guest = false;
    items.set("yama.me", JSON.stringify({ id: "me" }));
    store.selectSlot(false, "me");
    store.startGame(setup("shared-read-only"));
    await store.sync();
    calls.length = 0;
    store.setSharedReadOnly("shared-read-only");
    const newer = { ...store.getGame()!, log: [{ seq: 1, at: "2026-11-02T20:00:00Z", event: { type: "life", seat: 0, delta: -2 } }] };
    items.set("yama.table.current.me", JSON.stringify(newer));
    // The real host also queued a finished game and a deletion while this tab was asleep.
    const queued = [{ ...newer, setup: { ...newer.setup, id: "finished-offline" } }];
    items.set("yama.table.outbox", JSON.stringify(queued));
    items.set("yama.table.deletes", JSON.stringify([{ id: "discarded-elsewhere", owner: "me" }]));
    store.dispatch({ type: "life", seat: 0, delta: -10 });
    store.finishGame(0);
    store.discardGame();
    await store.sync();
    expect(store.getGame()!.log).toHaveLength(0);
    expect(JSON.parse(items.get("yama.table.current.me")!)).toEqual(newer);
    expect(calls).toEqual([]);
    expect(JSON.parse(items.get("yama.table.outbox")!)).toEqual(queued);
    expect(JSON.parse(items.get("yama.table.deletes")!)).toEqual([{ id: "discarded-elsewhere", owner: "me" }]);
    store.setSharedReadOnly(null);
  });
});


describe("a sharing marker that appears before its storage event", () => {
  it("fences writes until this document owns hosting, then releases the fence on removal", async () => {
    const priorNavigator = globalThis.navigator;
    vi.stubGlobal("navigator", { locks: {} });
    try {
      guest = false;
      items.set("yama.me", JSON.stringify({ id: "me" }));
      store.selectSlot(false, "me");
      store.startGame(setup("marker-race"));
      await store.sync();
      calls.length = 0;
      items.set("yama.table.hosting.me", "marker-race");
      store.dispatch({ type: "life", seat: 0, delta: -10 });
      store.finishGame(0);
      store.discardGame();
      await store.sync();
      expect(store.getGame()!.log).toHaveLength(0);
      expect(calls).toEqual([]);
      store.setSharedHost("marker-race");
      store.dispatch({ type: "life", seat: 0, delta: -1 });
      await store.sync();
      expect(store.getGame()!.log.at(-1)?.event).toMatchObject({ type: "life", delta: -1 });
      store.setSharedHost(null);
      const before = store.getGame();
      store.dispatch({ type: "life", seat: 0, delta: -3 });
      expect(store.getGame()).toBe(before);
      items.delete("yama.table.hosting.me");
      store.dispatch({ type: "life", seat: 0, delta: 1 });
      expect(store.getGame()).not.toBe(before);
    } finally {
      store.setSharedHost(null);
      store.setSharedReadOnly(null);
      items.delete("yama.table.hosting.me");
      vi.stubGlobal("navigator", priorNavigator);
    }
  });
});


describe("persisted game identity at host grant", () => {
  it("rejects an old claim and fences cached writes before the storage event arrives", async () => {
    guest = false;
    items.set("yama.me", JSON.stringify({ id: "me" }));
    store.selectSlot(false, "me");
    store.startGame(setup("old-claim"));
    await store.sync();
    const replacement = { ...store.getGame()!, setup: setup("new-selected"), log: [] };
    items.set("yama.table.current.me", JSON.stringify(replacement));
    calls.length = 0;
    expect(store.refreshSharedGame("old-claim")).toBe(false);
    store.dispatch({ type: "life", seat: 0, delta: -10 });
    await store.sync();
    expect(calls).toEqual([]);
    expect(JSON.parse(items.get("yama.table.current.me")!)).toEqual(replacement);
    // Deliver the new selected slot through the normal account selection boundary.
    store.selectSlot(true);
    store.selectSlot(false, "me");
  });
  it("refreshes a same-game snapshot before hosting instead of publishing the old log", async () => {
    guest = false;
    items.set("yama.me", JSON.stringify({ id: "me" }));
    store.selectSlot(false, "me");
    store.startGame(setup("same-claim"));
    await store.sync();
    const latest = { ...store.getGame()!, log: [{ seq: 1, at: "2026-11-02T20:00:00Z", event: { type: "life", seat: 0, delta: -2 } }] };
    items.set("yama.table.current.me", JSON.stringify(latest));
    expect(store.getGame()!.log).toHaveLength(0);
    expect(store.refreshSharedGame("same-claim")).toBe(true);
    expect(store.getGame()!.log).toEqual(latest.log);
  });
});
