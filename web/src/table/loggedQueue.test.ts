import { beforeEach, describe, expect, it, vi } from "vitest";

// The queue lives in localStorage; Node has none without a file, so give it a map.
const items = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => items.get(k) ?? null,
  setItem: (k: string, v: string) => void items.set(k, v),
  removeItem: (k: string) => void items.delete(k),
});

class ApiError extends Error {
  constructor(public status: number, message = `HTTP ${status}`) {
    super(message);
  }
}
const posts: { id: string; seats: { seat: number; deck_version_id: string | null }[] }[] = [];
let offline = false;
/** Game ids Yama refuses, with the status. */
const refuse = new Map<string, number>();
vi.mock("../api", async () => ({
  errorMessage: (await vi.importActual<typeof import("../api")>("../api")).errorMessage,
  ApiError,
  api: vi.fn(async (path: string, init?: { method?: string; json?: { id: string; seats: { seat: number; deck_version_id: string | null }[] } }) => {
    if (offline) throw new TypeError("Failed to fetch");
    if (path === "/api/decks/d1/versions") {
      return [
        { id: "v-old", created_at: "2026-10-01T12:00:00Z" },
        { id: "v-new", created_at: "2026-11-05T12:00:00Z" },
      ];
    }
    if (init?.method === "POST" && path === "/api/games") {
      const status = refuse.get(init.json!.id);
      if (status) throw new ApiError(status, "a game needs 1 to 10 seats");
      posts.push(init.json!);
      return { id: init.json!.id };
    }
    throw new Error(`unexpected request ${path}`);
  }),
}));

items.set("yama.me", JSON.stringify({ id: "me" }));
const q = await import("./loggedQueue");

const game = (id: string, day = "2026-10-20") => ({
  day,
  decks: { 0: "d1" },
  body: { id, format: "commander", seats: [{ seat: 0, deck_version_id: null, user_id: "me" }, { seat: 1, deck_version_id: "v-theirs", guest_name: "Sam" }] },
});
const waiting = () => q.loggedWaiting().map((g) => [g.body.id, g.error ?? null]);

describe("logging a game offline", () => {
  beforeEach(() => {
    posts.length = 0;
    offline = false;
    refuse.clear();
    items.delete("yama.table.logged");
    items.set("yama.me", JSON.stringify({ id: "me" }));
    q.reloadLogged();
  });

  it("credits your deck with the list that was current on the day played", async () => {
    await q.sendLogged(game("g1", "2026-10-20"));
    await q.sendLogged(game("g2", "2026-11-06"));
    // Your seat gets the version of that day; a seat without one of your decks is sent as it is.
    expect(posts.map((p) => p.seats.map((s) => s.deck_version_id))).toEqual([["v-old", "v-theirs"], ["v-new", "v-theirs"]]);
  });

  it("keeps a game on the device while Yama can't be reached, and sends it once it can", async () => {
    offline = true;
    await expect(q.sendLogged(game("g-offline"))).rejects.toThrow();
    q.queueLogged(game("g-offline"));
    expect(q.hasLoggedToSend()).toBe(true);
    // Still offline: the run stops, and the game is still waiting, not marked as refused.
    await expect(q.flushLogged()).rejects.toThrow();
    expect(waiting()).toEqual([["g-offline", null]]);
    // It survives a reload of the page.
    q.reloadLogged();
    expect(waiting()).toEqual([["g-offline", null]]);
    offline = false;
    expect(await q.flushLogged()).toBe(1);
    expect(posts.map((p) => p.id)).toEqual(["g-offline"]);
    expect(posts[0]!.seats[0]!.deck_version_id).toBe("v-old");
    expect(q.loggedWaiting()).toEqual([]);
    expect(q.hasLoggedToSend()).toBe(false);
  });

  it("keeps a game Yama refuses, says why, and still sends the ones behind it", async () => {
    q.queueLogged(game("g-bad"));
    q.queueLogged(game("g-good"));
    refuse.set("g-bad", 400);
    expect(await q.flushLogged()).toBe(1);
    expect(posts.map((p) => p.id)).toEqual(["g-good"]);
    expect(waiting()).toEqual([["g-bad", "a game needs 1 to 10 seats"]]);
    // It isn't asked again on every sync, and it goes when it's discarded.
    expect(q.hasLoggedToSend()).toBe(false);
    expect(await q.flushLogged()).toBe(0);
    q.discardLogged("g-bad");
    expect(q.loggedWaiting()).toEqual([]);
  });

  it("saving the same game again replaces the one waiting", () => {
    q.queueLogged(game("g-twice", "2026-10-20"));
    q.queueLogged(game("g-twice", "2026-10-21"));
    expect(q.loggedWaiting().map((g) => g.day)).toEqual(["2026-10-21"]);
  });

  it("another account's logged game waits for that account", async () => {
    q.queueLogged(game("g-mine"));
    items.set("yama.me", JSON.stringify({ id: "someone-else" }));
    expect(q.loggedWaiting()).toEqual([]);
    expect(await q.flushLogged()).toBe(0);
    expect(posts).toEqual([]);
    items.set("yama.me", JSON.stringify({ id: "me" }));
    expect(await q.flushLogged()).toBe(1);
  });
});
