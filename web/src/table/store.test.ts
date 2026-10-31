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
    expect(JSON.parse(items.get("yama.table.deletes")!)).toEqual(["g-offline"]);
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
});
