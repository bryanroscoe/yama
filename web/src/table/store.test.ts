import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store keeps its games in localStorage; Node has none without a file, so give it a map.
const items = new Map<string, string>();
let beforeWrite: ((key: string) => void) | null = null;
vi.stubGlobal("localStorage", {
  get length() { return items.size; },
  key: (i: number) => [...items.keys()][i] ?? null,
  getItem: (k: string) => items.get(k) ?? null,
  setItem: (k: string, v: string) => { beforeWrite?.(k); items.set(k, v); },
  removeItem: (k: string) => void items.delete(k),
});

class ApiError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}
const calls: { path: string; method: string }[] = [];
const uploads: Record<string, unknown>[] = [];
let holdPost: Promise<void> | null = null;
let failWith: number | "offline" | null = null;
/** POSTs to /api/games answer 410: the game was deleted on another device. */
let goneOnPost = false;
let postStatus: number | null = null;
let serverFinished = false;
vi.mock("../api", () => ({
  ApiError,
  api: vi.fn(async (path: string, init?: { method?: string; json?: Record<string, unknown> }) => {
    const method = init?.method ?? "GET";
    if (failWith === "offline") throw new TypeError("Failed to fetch");
    if (method === "DELETE" && failWith !== null) throw new ApiError(failWith);
    if (method === "POST" && path === "/api/games" && goneOnPost) throw new ApiError(410);
    if (method === "POST" && path === "/api/games" && postStatus !== null) throw new ApiError(postStatus);
    calls.push({ path, method });
    if (method === "POST" && path === "/api/games") {
      uploads.push(init!.json!);
      if (holdPost) await holdPost;
    }
    return { status: serverFinished ? "finished" : "in_progress", can_delete: true };
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

describe("saving after commander changes", () => {
  afterEach(() => {
    beforeWrite = null;
    postStatus = null;
    serverFinished = false;
    store.selectSlot(true);
    store.selectSlot(false, null);
  });
  beforeEach(async () => {
    failWith = null;
    goneOnPost = false;
    holdPost = null;
    guest = false;
    items.set("yama.me", JSON.stringify({ id: "me" }));
    store.selectSlot(true);
    store.selectSlot(false, "me");
    await store.sync();
    uploads.length = 0;
    calls.length = 0;
  });

  it("does not let a stale same-game snapshot overwrite changed commanders before a storage notification", async () => {
    store.startGame(setup("commander-race"));
    await store.sync();
    const newer = { ...store.getGame()!, log: [{ seq: 1, at: "2026-11-02T20:00:00Z", event: { type: "seat", seat: 0, commanderName: "Jace, Multiverse Architect", colorIdentity: "U" } }] };
    items.set("yama.table.current.me", JSON.stringify(newer));
    calls.length = 0;
    store.dispatch({ type: "life", seat: 0, delta: -1 });
    store.finishGame(0);
    await store.sync();
    expect(calls).toEqual([]);
    expect(JSON.parse(items.get("yama.table.current.me")!)).toEqual(newer);
  });

  it("does not replace another window's finished upload when the active slot is unchanged", async () => {
    store.startGame(setup("queue-race"));
    await store.sync();
    const queued = [{ ...store.getGame()!, setup: setup("finished-elsewhere") }];
    items.set("yama.table.outbox", JSON.stringify(queued));
    calls.length = 0;
    await store.sync();
    expect(calls).toEqual([]);
    expect(JSON.parse(items.get("yama.table.outbox")!)).toEqual(queued);
    // Let the store observe the other window's update before the next test.
    items.set("yama.table.outbox", "[]");
    store.selectSlot(true);
    store.selectSlot(false, "me");
  });

  it("persists the finished result immediately while an earlier upload is still running", async () => {
    let release!: () => void;
    holdPost = new Promise<void>((resolve) => { release = resolve; });
    store.startGame(setup("finish-inflight"));
    await vi.waitFor(() => expect(uploads.some((body) => body.id === "finish-inflight")).toBe(true));
    store.dispatch({ type: "seat", seat: 0, commanderName: "Jace, Multiverse Architect", colorIdentity: "U" });
    store.finishGame(0);
    try {
      const queued = JSON.parse(items.get("yama.table.outbox")!);
      expect(queued).toHaveLength(1);
      expect(queued[0].log.at(-1).event).toMatchObject({ type: "finish", winnerSeat: 0 });
      expect(JSON.parse(items.get("yama.table.current.me")!)).toBeNull();
    } finally {
      holdPost = null;
      release();
      await store.sync();
      await vi.waitFor(() => expect(uploads.some((body) => body.id === "finish-inflight" && body.finish)).toBe(true));
    }
    const finished = uploads.find((body) => body.id === "finish-inflight" && body.finish);
    expect(finished).toMatchObject({ seats: [{ commander_name: "Jace, Multiverse Architect" }], finish: { winner_seat: 0 } });
    expect(calls.some((c) => c.path.endsWith("/finish"))).toBe(false);
  });

  it("recovers a finished result after an overlapping stale queue write and a full app restart", async () => {
    store.startGame(setup("overlap-finish"));
    store.dispatch({ type: "seat", seat: 0, commanderName: "Jace, Multiverse Architect", colorIdentity: "U" });
    await store.sync();
    vi.resetModules();
    const stale = await import("./store");
    stale.selectSlot(false, "me");
    await stale.sync();
    failWith = "offline";
    let overlapped = false;
    // The older window has passed every snapshot check when the newer window finishes.
    beforeWrite = (key) => {
      if (key !== "yama.table.outbox") return;
      beforeWrite = null;
      overlapped = true;
      store.finishGame(0);
    };
    await stale.sync();
    await store.sync();
    expect(overlapped).toBe(true);
    expect([...items.keys()].filter((key) => key.startsWith("yama.table.saved."))).toHaveLength(1);
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    await reopened.sync();
    expect(reopened.getGame()).toBeNull();
    expect(JSON.parse(items.get("yama.table.outbox")!)).toHaveLength(1);
    failWith = null;
    await reopened.sync();
    expect(uploads.at(-1)).toMatchObject({ id: "overlap-finish", seats: [{ commander_name: "Jace, Multiverse Architect" }], finish: { winner_seat: 0 } });
    expect([...items.keys()].filter((key) => key.startsWith("yama.table.saved."))).toHaveLength(0);
    // Acknowledgment removes the detailed save, but cannot resurrect the old counter.
    stale.dispatch({ type: "life", seat: 0, delta: -10 });
    await stale.sync();
    expect(JSON.parse(items.get("yama.table.current.me")!)).toBeNull();
  });

  it("keeps a refused result through stale queue writes and restart until explicitly deleted", async () => {
    store.startGame(setup("refused-finish"));
    await store.sync();
    postStatus = 409;
    store.finishGame(0);
    await store.sync();
    const records = [...items.keys()].filter((key) => key.startsWith("yama.table.saved."));
    expect(records).toHaveLength(1);
    expect(items.get(`yama.table.savedError.${JSON.parse(items.get(records[0]!)!).game.saveId}`)).toBe("HTTP 409");
    items.set("yama.table.rejected", "[]"); // A stale window lost only the projection.
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    calls.length = 0;
    await reopened.sync();
    expect(calls).toEqual([]);
    expect(JSON.parse(items.get("yama.table.rejected")!)[0].game.setup.id).toBe("refused-finish");
    postStatus = null;
    expect(await reopened.deleteGame("refused-finish")).toBe(true);
    expect(items.has(records[0]!)).toBe(false);
    await reopened.sync();
    expect(JSON.parse(items.get("yama.table.rejected")!)).toEqual([]);
  });

  it("adopts a recovered guest finish without restoring its obsolete active counter", async () => {
    guest = true;
    store.selectSlot(true);
    store.startGame(setup("interrupted-guest-finish"));
    const old = items.get("yama.table.guestCurrent")!;
    store.finishGame(0);
    await store.sync();
    items.set("yama.table.guestCurrent", old); // Process closed before its slot clear persisted.
    guest = false;
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    reopened.saveGuestGames();
    await reopened.sync();
    expect(reopened.getGame()).toBeNull();
    expect(uploads.at(-1)).toMatchObject({ id: "interrupted-guest-finish", finish: { winner_seat: 0 } });
    reopened.selectSlot(true);
    expect(reopened.getGame()).toBeNull();
    await Promise.resolve();
    expect(JSON.parse(items.get("yama.table.guestCurrent")!)).toBeNull();
    // No repeated adoption or active guest prompt after another sign-in.
    reopened.selectSlot(false, "me");
    calls.length = 0;
    reopened.saveGuestGames();
    await reopened.sync();
    expect(calls).toEqual([]);
  });

  it("protects pending results left by an older app build before retrying them", async () => {
    const legacy = { setup: setup("legacy-result"), owner: "me", log: [{ seq: 1, at: "2026-11-02T20:00:00Z", event: { type: "finish", winnerSeat: 0, endedAt: "2026-11-02T20:00:00Z" } }], redo: [], syncedThrough: 0 };
    items.set("yama.table.outbox", JSON.stringify([legacy]));
    failWith = "offline";
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    await reopened.sync();
    expect([...items.keys()].filter((key) => key.startsWith("yama.table.saved."))).toHaveLength(1);
    expect(JSON.parse(items.get("yama.table.outbox")!)[0].saveId).toBeTruthy();
    failWith = null;
    await reopened.sync();
    expect(uploads.at(-1)).toMatchObject({ id: "legacy-result", finish: { winner_seat: 0 } });
  });

  it("can load and upload a legacy result when storage is too full to migrate it", async () => {
    const legacy = { setup: setup("legacy-quota"), owner: "me", log: [{ seq: 1, at: "2026-11-02T20:00:00Z", event: { type: "finish", winnerSeat: 0, endedAt: "2026-11-02T20:00:00Z" } }], redo: [], syncedThrough: 0 };
    items.set("yama.table.outbox", JSON.stringify([legacy]));
    beforeWrite = (key) => { if (key.startsWith("yama.table.saved.")) throw new DOMException("Full", "QuotaExceededError"); };
    failWith = "offline";
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    await reopened.sync();
    expect(JSON.parse(items.get("yama.table.outbox")!)[0].setup.id).toBe("legacy-quota");
    failWith = null;
    await reopened.sync();
    expect(uploads.at(-1)).toMatchObject({ id: "legacy-quota", finish: { winner_seat: 0 } });
    expect(JSON.parse(items.get("yama.table.outbox")!)).toEqual([]);
  });

  it("recovers a durable result even when its small ended marker cannot be written", async () => {
    store.startGame(setup("marker-quota"));
    await store.sync();
    const old = items.get("yama.table.current.me")!;
    beforeWrite = (key) => { if (key.startsWith("yama.table.ended.")) throw new DOMException("Full", "QuotaExceededError"); };
    failWith = "offline";
    store.finishGame(0);
    await store.sync();
    items.set("yama.table.current.me", old);
    items.set("yama.table.outbox", "[]");
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    await reopened.sync();
    expect(reopened.getGame()).toBeNull();
    expect(JSON.parse(items.get("yama.table.outbox")!)).toHaveLength(1);
    failWith = null;
    await reopened.sync();
    // Acknowledged on Yama; keep the local detail until the ended marker can be retained too.
    expect([...items.keys()].filter((key) => key.startsWith("yama.table.saved."))).toHaveLength(1);
    beforeWrite = null;
    await reopened.sync();
    expect([...items.keys()].filter((key) => key.startsWith("yama.table.saved."))).toHaveLength(0);
    expect(JSON.parse(items.get("yama.table.current.me")!)).toBeNull();
  });

  it("retires an old local counter when the server already has its finished result", async () => {
    serverFinished = true;
    store.startGame(setup("already-finished-on-server"));
    const old = items.get("yama.table.current.me")!;
    await store.sync();
    expect(store.getGame()).toBeNull();
    expect(JSON.parse(items.get("yama.table.current.me")!)).toBeNull();
    // A sleeping old window can leave the same historical counter behind again.
    items.set("yama.table.current.me", old);
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    expect(reopened.getGame()).toBeNull();
  });

  it("confirms a conflicting old commander snapshot is finished before retiring it", async () => {
    postStatus = 409;
    serverFinished = true;
    store.startGame(setup("conflicting-old-counter"));
    await store.sync();
    expect(calls).toContainEqual({ path: "/api/games/conflicting-old-counter", method: "GET" });
    expect(store.getGame()).toBeNull();
  });

  it("keeps edits made while a request is learning that the server game finished", async () => {
    let release!: () => void;
    holdPost = new Promise<void>((resolve) => { release = resolve; });
    serverFinished = true;
    store.startGame(setup("late-local-edit"));
    await vi.waitFor(() => expect(uploads.some((body) => body.id === "late-local-edit")).toBe(true));
    store.dispatch({ type: "life", seat: 0, delta: -3 });
    holdPost = null;
    release();
    await store.sync();
    expect(store.getGame()?.log.at(-1)?.event).toMatchObject({ type: "life", delta: -3 });
    expect(JSON.parse(items.get("yama.table.current.me")!).log).toHaveLength(1);
    serverFinished = false;
    await store.deleteGame("late-local-edit");
  });

  it.each(["discard", "adopt"])("does not resurrect a legacy guest result after %s", async (operation) => {
    const legacy = { setup: setup(`retired-guest-${operation}`), guest: true, log: [{ seq: 1, at: "2026-11-02T20:00:00Z", event: { type: "finish", winnerSeat: 0, endedAt: "2026-11-02T20:00:00Z" } }], redo: [], syncedThrough: 0 };
    items.set("yama.table.guestGames", JSON.stringify([legacy]));
    vi.resetModules();
    const first = await import("./store");
    first.selectSlot(false, "me");
    if (operation === "discard") first.dropGuestGames();
    else first.saveGuestGames();
    await first.sync();
    items.set("yama.table.guestGames", JSON.stringify([legacy]));
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    calls.length = 0;
    reopened.saveGuestGames();
    await reopened.sync();
    expect(calls).toEqual([]);
    expect(JSON.parse(items.get("yama.table.guestGames")!)).toEqual([]);
  });

  it("uploads durable results and can sync again when a bulk queue write hits quota", async () => {
    const legacy = { setup: setup("projection-quota"), owner: "me", log: [{ seq: 1, at: "2026-11-02T20:00:00Z", event: { type: "finish", winnerSeat: 0, endedAt: "2026-11-02T20:00:00Z" } }], redo: [], syncedThrough: 0 };
    items.set("yama.table.outbox", JSON.stringify([legacy]));
    beforeWrite = (key) => { if (key === "yama.table.outbox") throw new DOMException("Full", "QuotaExceededError"); };
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    await reopened.sync();
    expect(uploads.at(-1)).toMatchObject({ id: "projection-quota", finish: { winner_seat: 0 } });
    beforeWrite = null;
    await reopened.sync();
    expect(JSON.parse(items.get("yama.table.outbox")!)).toEqual([]);
  });

  it("a late rejection cannot recreate a result discarded in another window", async () => {
    const { acknowledgeFinished } = await import("./finished");
    store.startGame(setup("discard-during-rejection"));
    await store.sync();
    postStatus = 409;
    beforeWrite = (key) => {
      if (!key.startsWith("yama.table.savedError.")) return;
      beforeWrite = null;
      const record = [...items.keys()].find((k) => k.startsWith("yama.table.saved."))!;
      acknowledgeFinished(JSON.parse(items.get(record)!).game, true);
    };
    store.finishGame(0);
    await store.sync();
    expect([...items.keys()].filter((key) => key.startsWith("yama.table.saved."))).toHaveLength(0);
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    postStatus = null;
    await reopened.sync();
    expect(JSON.parse(items.get("yama.table.rejected")!)).toEqual([]);
    expect([...items.keys()].some((key) => key.startsWith("yama.table.savedError."))).toBe(false);
  });

  it.each([1, 2])("uploads successful partial guest adoptions when item %s hits quota", async (failAt) => {
    guest = true;
    store.selectSlot(true);
    const ids = [`partial-${failAt}-guest-1`, `partial-${failAt}-guest-2`];
    for (const id of ids) {
      store.startGame(setup(id));
      store.finishGame(0);
      await store.sync();
    }
    guest = false;
    store.selectSlot(false, "me");
    let attempts = 0;
    beforeWrite = (key) => {
      if (key.startsWith("yama.table.saved.") && ++attempts === failAt) throw new DOMException("Full", "QuotaExceededError");
    };
    store.saveGuestGames();
    await store.sync();
    const failed = ids[failAt - 1]!;
    const succeeded = ids[failAt === 1 ? 1 : 0]!;
    await vi.waitFor(() => expect(uploads.some((body) => body.id === succeeded)).toBe(true));
    expect(uploads.some((body) => body.id === failed)).toBe(false);
    expect(JSON.parse(items.get("yama.table.guestGames")!).map((g: { setup: { id: string } }) => g.setup.id)).toEqual([failed]);
    beforeWrite = null;
    store.saveGuestGames();
    await store.sync();
    await vi.waitFor(() => expect(uploads.some((body) => body.id === failed)).toBe(true));
    expect(JSON.parse(items.get("yama.table.guestGames")!)).toEqual([]);
  });

  it("keeps the active guest slot when its account copy cannot be persisted", async () => {
    guest = true;
    store.selectSlot(true);
    store.startGame(setup("active-guest-quota"));
    const original = items.get("yama.table.guestCurrent");
    guest = false;
    store.selectSlot(false, "me");
    beforeWrite = (key) => { if (key === "yama.table.current.me") throw new DOMException("Full", "QuotaExceededError"); };
    store.saveGuestGames();
    await store.sync();
    expect(items.get("yama.table.guestCurrent")).toBe(original);
    expect(store.getGame()).toBeNull();
    beforeWrite = null;
    store.saveGuestGames();
    await store.sync();
    expect(store.getGame()).toMatchObject({ setup: { id: "active-guest-quota" }, owner: "me" });
    expect(items.has("yama.table.guestCurrent")).toBe(false);
    await store.deleteGame("active-guest-quota");
  });

  it("keeps a legacy outbox result when neither its journal nor rejection copy fits", async () => {
    const legacy = { setup: setup("legacy-rejection-quota"), owner: "me", log: [{ seq: 1, at: "2026-11-02T20:00:00Z", event: { type: "finish", winnerSeat: 0, endedAt: "2026-11-02T20:00:00Z" } }], redo: [], syncedThrough: 0 };
    items.set("yama.table.outbox", JSON.stringify([legacy]));
    beforeWrite = (key) => {
      if (key.startsWith("yama.table.saved.") || key === "yama.table.rejected") throw new DOMException("Full", "QuotaExceededError");
    };
    postStatus = 409;
    vi.resetModules();
    const reopened = await import("./store");
    reopened.selectSlot(false, "me");
    await reopened.sync();
    expect(JSON.parse(items.get("yama.table.outbox")!)[0].setup.id).toBe("legacy-rejection-quota");
    beforeWrite = null;
    postStatus = null;
    vi.resetModules();
    const recovered = await import("./store");
    recovered.selectSlot(false, "me");
    await recovered.sync();
    expect(uploads.at(-1)).toMatchObject({ id: "legacy-rejection-quota", finish: { winner_seat: 0 } });
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
    expect(calls.map((c) => c.path)).toEqual(["/api/games"]);
    expect(uploads.at(-1)).toMatchObject({ id: "guest-1", finish: { winner_seat: 0 } });
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
    expect(uploads.some((body) => body.id === "theirs-1")).toBe(false);
    // Back as them: it goes up.
    items.set("yama.me", JSON.stringify({ id: "someone-else" }));
    await store.sync();
    expect(uploads.at(-1)).toMatchObject({ id: "theirs-1", finish: { winner_seat: 0 } });
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
      store.selectSlot(true);
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
