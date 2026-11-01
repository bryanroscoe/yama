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
  it("never shows an account's game, and brings its own along at sign-in only into an empty slot", async () => {
    guest = false;
    store.startGame(setup("account-1"));
    // Signed out, counting without an account: the account's game isn't there.
    guest = true;
    store.selectSlot(true);
    expect(store.getGame()).toBeNull();
    store.startGame(setup("guest-9"));
    // Back to the account: its own game, untouched; the guest game waits for guest mode.
    guest = false;
    store.selectSlot(false);
    expect(store.getGame()?.setup.id).toBe("account-1");
    guest = true;
    store.selectSlot(true);
    expect(store.getGame()?.setup.id).toBe("guest-9");
    // An account with no game going takes the guest game along, still unsaved.
    guest = false;
    store.selectSlot(false);
    store.discardGame();
    store.selectSlot(true);
    expect(store.getGame()?.setup.id).toBe("guest-9");
    store.selectSlot(false);
    expect(store.getGame()).toMatchObject({ setup: { id: "guest-9" }, guest: true });
    store.discardGame();
    await store.sync();
  });
});
