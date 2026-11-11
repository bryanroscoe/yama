import { beforeEach, describe, expect, it, vi } from "vitest";
import { versionOn } from "./versions";

// The queue lives in localStorage; Node has none without a file, so give it a map.
const items = new Map<string, string>();
let full = false;
vi.stubGlobal("localStorage", {
  get length() { return items.size; },
  key: (i: number) => [...items.keys()][i] ?? null,
  getItem: (k: string) => items.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (full) throw new Error("QuotaExceededError");
    items.set(k, v);
  },
  removeItem: (k: string) => void items.delete(k),
});

class ApiError extends Error {
  constructor(public status: number, message = `HTTP ${status}`) {
    super(message);
  }
}
type Body = { id: string; note?: string; seats: { seat: number; deck_version_id: string | null }[] };
const posts: Body[] = [];
let offline = false;
/** Game ids Yama answers with an error status. */
const fail = new Map<string, number>();
/** Runs right before a POST is answered: another window acting meanwhile. */
let duringPost: ((id: string) => void) | null = null;
vi.mock("../storage", () => ({ keepStorage: () => undefined }));
vi.mock("../api", async () => ({
  errorMessage: (await vi.importActual<typeof import("../api")>("../api")).errorMessage,
  unanswered: (await vi.importActual<typeof import("../api")>("../api")).unanswered,
  ApiError,
  api: vi.fn(async (path: string, init?: { method?: string; json?: Body }) => {
    if (offline) throw new TypeError("Failed to fetch");
    if (path === "/api/decks/gone/versions") throw new ApiError(404, "deck not found");
    if (path === "/api/decks/d1/versions") {
      return [
        { id: "v-old", created_at: "2026-10-01T12:00:00Z" },
        { id: "v-evening", created_at: "2026-10-20T23:00:00" },
        { id: "v-new", created_at: "2026-11-05T12:00:00Z" },
      ];
    }
    if (init?.method === "POST" && path === "/api/games") {
      duringPost?.(init.json!.id);
      const status = fail.get(init.json!.id);
      if (status) throw new ApiError(status, status === 400 ? "a game needs 1 to 10 seats" : `HTTP ${status}`);
      posts.push(init.json!);
      return { id: init.json!.id };
    }
    throw new Error(`unexpected request ${path}`);
  }),
}));

items.set("yama.me", JSON.stringify({ id: "me" }));
const q = await import("./loggedQueue");

/** A game played on `day`, logged at 9 pm that evening unless said otherwise. */
const game = (id: string, day = "2026-10-20", extra: { loggedAt?: string; deck?: string; note?: string } = {}) => ({
  day,
  loggedAt: extra.loggedAt ?? new Date(`${day}T21:00:00`).toISOString(),
  decks: { 0: extra.deck ?? "d1" },
  body: { id, format: "commander", note: extra.note, seats: [{ seat: 0, deck_version_id: null, user_id: "me" }, { seat: 1, deck_version_id: "v-theirs", guest_name: "Sam" }] },
});
const waiting = () => q.loggedWaiting().map((g) => [g.body.id, g.error ?? null, !!g.refused]);
const signIn = (id: string) => {
  items.set("yama.me", JSON.stringify({ id }));
  q.reloadLogged();
};

describe("logging a game offline", () => {
  beforeEach(() => {
    posts.length = 0;
    offline = false;
    full = false;
    duringPost = null;
    fail.clear();
    for (const k of [...items.keys()]) if (k.startsWith("yama.table.logged.")) items.delete(k);
    signIn("me");
  });

  it("credits your deck with the list that was current when the game was played and logged", async () => {
    await q.sendLogged(game("g1", "2026-10-20"), "me");
    await q.sendLogged(game("g2", "2026-11-06"), "me");
    // Your seat gets the version of that day; a seat without one of your decks is sent as it is.
    expect(posts.map((p) => p.seats.map((s) => s.deck_version_id))).toEqual([["v-old", "v-theirs"], ["v-new", "v-theirs"]]);
    // A list saved later the same evening, after the game was logged, was never the one played,
    // however late the game uploads. Without a logged time, the whole day counts.
    const versions = [{ id: "v-old", created_at: "2026-10-01T12:00:00Z" }, { id: "v-evening", created_at: "2026-10-20T23:00:00" }] as Parameters<typeof versionOn>[0];
    expect(versionOn(versions, "2026-10-20", new Date("2026-10-20T21:00:00").toISOString())).toBe("v-old");
    expect(versionOn(versions, "2026-10-20")).toBe("v-evening");
    // Logged the next morning: the evening's list counts, the day's end is still the limit.
    expect(versionOn(versions, "2026-10-20", new Date("2026-10-21T09:00:00").toISOString())).toBe("v-evening");
  });

  it("a deck deleted since leaves its seat credited to no list, and the game still goes", async () => {
    await q.sendLogged(game("g-deck-gone", "2026-10-20", { deck: "gone" }), "me");
    expect(posts[0]!.seats.map((s) => s.deck_version_id)).toEqual([null, "v-theirs"]);
  });

  it("keeps a game on the device while Yama can't be reached, and sends it once it can", async () => {
    offline = true;
    await expect(q.sendLogged(game("g-offline"), "me")).rejects.toThrow();
    q.queueLogged(game("g-offline"), "me");
    expect(q.hasLoggedToSend()).toBe(true);
    // Still offline: the run stops without throwing, and the game waits with nothing against it.
    expect(await q.flushLogged()).toBe(0);
    expect(waiting()).toEqual([["g-offline", null, false]]);
    // It survives a reload of the page.
    q.reloadLogged();
    expect(waiting()).toEqual([["g-offline", null, false]]);
    offline = false;
    expect(await q.flushLogged()).toBe(1);
    expect(posts.map((p) => p.id)).toEqual(["g-offline"]);
    expect(posts[0]!.seats[0]!.deck_version_id).toBe("v-old");
    expect(q.loggedWaiting()).toEqual([]);
    expect(q.hasLoggedToSend()).toBe(false);
  });

  it("keeps a game Yama refuses, says why, and still sends the ones behind it", async () => {
    q.queueLogged(game("g-bad", "2026-10-19"), "me");
    q.queueLogged(game("g-good", "2026-10-20"), "me");
    fail.set("g-bad", 400);
    expect(await q.flushLogged()).toBe(1);
    expect(posts.map((p) => p.id)).toEqual(["g-good"]);
    expect(waiting()).toEqual([["g-bad", "a game needs 1 to 10 seats", true]]);
    // It isn't asked again on every sync, and it goes when it's discarded.
    expect(q.hasLoggedToSend()).toBe(false);
    expect(await q.flushLogged()).toBe(0);
    q.discardLogged("g-bad");
    expect(q.loggedWaiting()).toEqual([]);
  });

  it("a game that keeps failing on the server doesn't hold back the ones behind it, and is tried again", async () => {
    q.queueLogged(game("g-500", "2026-10-19"), "me");
    q.queueLogged(game("g-after", "2026-10-20"), "me");
    fail.set("g-500", 500);
    expect(await q.flushLogged()).toBe(1);
    expect(posts.map((p) => p.id)).toEqual(["g-after"]);
    // Kept with the reason, not marked refused: the next sync tries it again.
    expect(waiting()).toEqual([["g-500", "HTTP 500", false]]);
    expect(q.hasLoggedToSend()).toBe(true);
    fail.clear();
    expect(await q.flushLogged()).toBe(1);
    expect(q.loggedWaiting()).toEqual([]);
  });

  it("an expired session stops the run and keeps everything; a game deleted elsewhere just goes", async () => {
    q.queueLogged(game("g-401", "2026-10-19"), "me");
    q.queueLogged(game("g-next", "2026-10-20"), "me");
    fail.set("g-401", 401);
    expect(await q.flushLogged()).toBe(0);
    expect(waiting()).toEqual([["g-401", null, false], ["g-next", null, false]]);
    // 410: whoever logged it deleted it on another device. Not an error, not kept.
    fail.set("g-401", 410);
    expect(await q.flushLogged()).toBe(1);
    expect(q.loggedWaiting()).toEqual([]);
    expect(posts.map((p) => p.id)).toEqual(["g-next"]);
  });

  it("saving the same game again replaces the one waiting", () => {
    q.queueLogged(game("g-twice", "2026-10-20"), "me");
    q.queueLogged(game("g-twice", "2026-10-21"), "me");
    expect(q.loggedWaiting().map((g) => g.day)).toEqual(["2026-10-21"]);
  });

  it("a game saved again while it uploads keeps the newer save waiting", async () => {
    q.queueLogged(game("g-race", "2026-10-20", { note: "first" }), "me");
    // Another window saves the game again while the first save is on its way up.
    duringPost = () => {
      duringPost = null;
      q.queueLogged(game("g-race", "2026-10-20", { note: "second" }), "me");
    };
    expect(await q.flushLogged()).toBe(1);
    expect(q.loggedWaiting().map((g) => g.body.note)).toEqual(["second"]);
    expect(await q.flushLogged()).toBe(1);
    expect(posts.map((p) => p.note)).toEqual(["first", "second"]);
    expect(q.loggedWaiting()).toEqual([]);
  });

  it("two windows queueing different games don't overwrite each other", () => {
    q.queueLogged(game("g-tab-a"), "me");
    // The other window never saw g-tab-a in memory: it writes its own game straight to storage.
    const other = { ...game("g-tab-b", "2026-10-21"), owner: "me", rev: "r-b" };
    items.set("yama.table.logged.g-tab-b", JSON.stringify(other));
    q.reloadLogged();
    expect(q.loggedWaiting().map((g) => g.body.id)).toEqual(["g-tab-a", "g-tab-b"]);
  });

  it("another account's logged game waits for that account, even if the account changes mid-run", async () => {
    q.queueLogged(game("g-mine", "2026-10-19"), "me");
    q.queueLogged(game("g-mine-2", "2026-10-20"), "me");
    signIn("someone-else");
    expect(q.loggedWaiting()).toEqual([]);
    expect(await q.flushLogged()).toBe(0);
    expect(posts).toEqual([]);
    signIn("me");
    // Someone else signs in on this device (another tab) while the first game is going up: the
    // second is not sent as them.
    duringPost = () => {
      duringPost = null;
      items.set("yama.me", JSON.stringify({ id: "someone-else" }));
    };
    expect(await q.flushLogged()).toBe(1);
    expect(posts.map((p) => p.id)).toEqual(["g-mine"]);
    signIn("me");
    expect(waiting()).toEqual([["g-mine-2", null, false]]);
    // A game is never sent as an account other than the one it was logged by.
    await expect(q.sendLogged(game("g-wrong"), "someone-else")).rejects.toBeInstanceOf(q.AccountChanged);
  });

  it("says plainly when the phone can't keep the game", () => {
    full = true;
    expect(() => q.queueLogged(game("g-full"), "me")).toThrow("storage is full");
    full = false;
    expect(q.loggedWaiting()).toEqual([]);
  });

  it("keeps a game for a connection problem or a server in trouble, not for a refusal", () => {
    expect([new TypeError("Failed to fetch"), new ApiError(502), new ApiError(503), new ApiError(408), new ApiError(429)].map(q.worthKeeping)).toEqual([true, true, true, true, true]);
    expect([new ApiError(400), new ApiError(401), new ApiError(409), new Error("bug")].map(q.worthKeeping)).toEqual([false, false, false, false]);
  });
});
