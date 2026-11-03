import { beforeEach, describe, expect, it, vi } from "vitest";
const items = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => items.get(k) ?? null,
  setItem: (k: string, v: string) => void items.set(k, v),
  removeItem: (k: string) => void items.delete(k),
});
const following = await import("./following");
const table = { gameId: "game", key: "a".repeat(32), relay: "edge" as const, names: "Alice, Bob" };
describe("returning to a joined table", () => {
  beforeEach(() => { items.clear(); vi.useRealTimers(); });
  it("survives reload without copying an old game, isolated from other accounts and guests", async () => {
    following.rememberTable("alice", table);
    vi.resetModules();
    const reloaded = await import("./following");
    expect(reloaded.followedTable("alice")).toMatchObject(table);
    expect(reloaded.followedTable("bob")).toBeNull();
    expect(reloaded.followedTable(null)).toBeNull();
    expect([...items.keys()]).toEqual(["yama.table.following.account:alice"]);
  });
  it("a late end from the previous game cannot forget the rematch", () => {
    following.rememberTable("alice", table);
    following.rememberTable("alice", { ...table, gameId: "rematch" });
    following.forgetTable("alice", "game");
    expect(following.followedTable("alice")?.gameId).toBe("rematch");
    following.forgetTable("alice", "rematch");
    expect(following.followedTable("alice")).toBeNull();
  });
  it("does not keep offering yesterday's game or malformed saved data", () => {
    vi.useFakeTimers();
    following.rememberTable(null, table);
    vi.advanceTimersByTime(24 * 3600 * 1000);
    expect(following.followedTable(null)).toBeNull();
    items.set("yama.table.following.guest", "{bad");
    expect(following.followedTable(null)).toBeNull();
    vi.useRealTimers();
  });
});
