import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalGame } from "./store";
const items = new Map<string, string>();
const changes = new Set<() => void>();
const ends = new Set<(game: LocalGame) => void>();
let game: LocalGame | null;
vi.stubGlobal("localStorage", {
  getItem: (k: string) => items.get(k) ?? null,
  setItem: (k: string, v: string) => void items.set(k, v),
  removeItem: (k: string) => void items.delete(k),
  get length() { return items.size; },
  key: (i: number) => [...items.keys()][i] ?? null,
});
vi.stubGlobal("location", { origin: "https://yama.ing", hash: "" });
vi.stubGlobal("window", {
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (id: number) => clearTimeout(id),
  setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
  clearInterval: (id: number) => clearInterval(id),
});
vi.mock("../api", () => ({
  api: vi.fn(async () => ({})),
  API_BASE: "",
  publicOrigin: () => "https://yama.ing",
  ApiError: class ApiError extends Error { constructor(public status: number, message: string) { super(message); } },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
vi.mock("../components/confirm", () => ({ ask: vi.fn(async () => true), tell: vi.fn(async () => {}) }));
vi.mock("./store", () => ({
  getGame: () => game,
  isPosted: () => true,
  dispatch: vi.fn(),
  setSharedReadOnly: vi.fn(),
  setSharedHost: vi.fn(),
  prepareSharing: vi.fn(),
  refreshSharedGame: (id: string) => game?.setup.id === id,
  sync: vi.fn(async () => {}),
  subscribeTable: (f: () => void) => { changes.add(f); return () => { changes.delete(f); }; },
  subscribeTableEnd: (f: (g: LocalGame) => void) => { ends.add(f); return () => { ends.delete(f); }; },
  sealForHandOver: vi.fn(async () => game),
  releaseHandOver: vi.fn(),
  letGo: vi.fn(() => { game = null; for (const f of changes) f(); }),
}));
class Socket {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onclose?: (e: { code: number }) => void;
  onmessage?: (m: { data: string }) => void;
  messages: string[] = [];
  constructor(public url: string) { Socket.sockets.push(this); }
  send(msg: string) { this.messages.push(msg); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
vi.stubGlobal("WebSocket", Socket);
const setup = { id: "current", startedAt: "2026-11-02T19:00:00Z", format: "commander" as const, startingLife: 40, players: [{ seat: 0, name: "Host", colorIdentity: "", userId: "host" }] };
const code = "c".repeat(32);
const newKey = "d".repeat(32);
const askFrom = (ws: Socket, event: Record<string, unknown>) => ws.onmessage?.({ data: JSON.stringify({ type: "event", event }) });
let share: typeof import("./share");
describe("shared table lifecycle", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    // Node versions expose different navigator APIs; model the browser's available lock.
    vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } });
    vi.stubEnv("VITE_RELAY_URL", "wss://relay.yama.ing");
    items.clear(); changes.clear(); ends.clear(); Socket.sockets.length = 0;
    game = { setup, log: [], redo: [], owner: "host", syncedThrough: 0 };
    share = await import("./share");
  });
  afterEach(() => { share.stopHosting(); vi.useRealTimers(); });
  it("resumes sharing after reload only for the same account's current game", () => {
    items.set("yama.table.hosting.host", "different");
    share.restoreHosting("host");
    expect(Socket.sockets).toHaveLength(0);
    items.set("yama.table.hosting.host", "current");
    share.restoreHosting("other");
    expect(Socket.sockets).toHaveLength(0);
    share.restoreHosting("host");
    expect(Socket.sockets).toHaveLength(1);
    share.stopHosting();
    share.restoreHosting("host");
    expect(Socket.sockets).toHaveLength(1); // Stop sharing stays stopped after a reload.
  });
  it("requires an explicit start when the browser has no locks", () => {
    vi.stubGlobal("navigator", {});
    items.set("yama.table.hosting.host", "current");
    share.restoreHosting("host");
    expect(Socket.sockets).toHaveLength(0);
    share.startHosting("current");
    expect(Socket.sockets).toHaveLength(1);
  });
  it.each([4000, 1009])("terminal relay closure %s stays stopped after reload without deleting another host's registration", async (code) => {
    const { api } = await import("../api");
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    expect(items.get("yama.table.hosting.host")).toBe("current");
    ws.onclose?.({ code });
    expect(items.has("yama.table.hosting.host")).toBe(false);
    share.restoreHosting("host");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.sockets).toHaveLength(1);
    expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it("a live registration completing after replacement cannot erase the successor's key", async () => {
    const { api } = await import("../api");
    let complete!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    share.startHosting("current");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    Socket.sockets[0]!.onclose?.({ code: 4000 });
    complete({});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(Socket.sockets).toHaveLength(1);
  });
  it("an explicit stop cleans up a registration that completes late", async () => {
    const { api } = await import("../api");
    let complete!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    share.startHosting("current");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    share.stopHosting();
    complete({});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2);
    expect(items.has("yama.table.hosting.host")).toBe(false);
  });
  it("a terminal close cannot clear a newer game's restore marker", () => {
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    items.set("yama.table.hosting.host", "next");
    ws.onclose?.({ code: 4000 });
    expect(items.get("yama.table.hosting.host")).toBe("next");
  });
  it("does not activate a claim after its game changed before the lock callback", async () => {
    const priorNavigator = globalThis.navigator;
    let claim!: (lock: object | null) => Promise<void>;
    vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, callback: typeof claim) => { claim = callback; return Promise.resolve(); } } });
    try {
      share.startHosting("current");
      game = { ...game!, setup: { ...setup, id: "replacement" } };
      await claim({});
      expect(Socket.sockets).toHaveLength(0);
      expect(items.has("yama.table.hosting.host")).toBe(false);
    } finally { vi.stubGlobal("navigator", priorNavigator); }
  });
  it("publishes the host's layout/settings and an explicit end before the socket closes", () => {
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    expect(JSON.parse(ws.messages[0]!)).toMatchObject({ setup, layout: "upright", countTurns: false, showArt: true });
    for (const end of ends) end(game!);
    game = null;
    for (const f of changes) f();
    expect(JSON.parse(ws.messages.at(-1)!)).toMatchObject({ ended: true, setup });
    expect(ws.readyState).toBe(3);
    expect(items.has("yama.table.hosting.host")).toBe(false);
  });
  it("keeps the rematch's address in the old room for a sleeping phone", () => {
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    share.announceNext("next");
    for (const end of ends) end(game!);
    expect(JSON.parse(ws.messages.at(-1)!)).toMatchObject({ ended: true, next: { gameId: "next", relay: "cf" } });
  });
  it("switching account slots stops this host without pretending the game finished", () => {
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    game = null;
    for (const f of changes) f();
    expect(ws.messages.map((m) => JSON.parse(m).ended)).not.toContain(true);
  });
  it("hands the game to the device that asked, once its holder says yes, and every phone moves with it", async () => {
    const { api } = await import("../api");
    const store = await import("./store");
    vi.mocked(api).mockImplementation(async (path: string) => (path.includes("/claim/") ? { name: "Sam" } : {}));
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    askFrom(ws, { type: "hand_over", code, key: newKey, relay: "cf" });
    await vi.waitFor(() => expect(store.letGo).toHaveBeenCalledWith("current"));
    const calls = vi.mocked(api).mock.calls.map(([path, init]) => `${init?.method ?? "GET"} ${path}`);
    expect(calls).toContain(`GET /api/table/current/claim/${code}`);
    expect(calls).toContain("POST /api/table/current/hand-over");
    expect(vi.mocked(api).mock.calls.find(([path]) => path.endsWith("/hand-over"))?.[1]).toMatchObject({ json: { code } });
    // The old room's last word sends every phone (asleep ones too, via the relay's copy) to the new one.
    expect(JSON.parse(ws.messages.at(-1)!)).toMatchObject({ type: "state", moved: true, next: { gameId: "current", key: newKey, relay: "cf" } });
    expect(ws.readyState).toBe(3);
    expect(items.get("yama.guest.current")).toBe("0"); // This device follows from its own seat.
    expect(items.has("yama.table.hosting.host")).toBe(false);
    const { ask } = await import("../components/confirm");
    expect(vi.mocked(ask).mock.calls[0]![0].title).toBe("Hand the game to Sam's device?");
  });
  it("keeps the game when its holder says no, and ignores asks that aren't one", async () => {
    const { api } = await import("../api");
    const store = await import("./store");
    const { ask } = await import("../components/confirm");
    vi.mocked(api).mockImplementation(async (path: string) => (path.includes("/claim/") ? { name: "Sam" } : {}));
    vi.mocked(ask).mockResolvedValueOnce(false);
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    askFrom(ws, { type: "hand_over", code: "not a code", key: newKey, relay: "cf" });
    askFrom(ws, { type: "hand_over", code, key: "short", relay: "cf" });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(api).mock.calls.some(([path]) => path.includes("/claim/"))).toBe(false);
    askFrom(ws, { type: "hand_over", code, key: newKey, relay: "cf" });
    await vi.waitFor(() => expect(ask).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(0);
    expect(store.sealForHandOver).not.toHaveBeenCalled();
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/hand-over"))).toBe(false);
    expect(ws.readyState).toBe(1);
    // A tap still goes to the game; a hand-over ask is never one.
    askFrom(ws, { type: "life", seat: 0, delta: -1 });
    expect(store.dispatch).toHaveBeenCalledTimes(1);
  });
  it("records again and says so when the game couldn't reach Yama first", async () => {
    const { api } = await import("../api");
    const store = await import("./store");
    const { tell } = await import("../components/confirm");
    vi.mocked(api).mockImplementation(async (path: string) => (path.includes("/claim/") ? { name: "Sam" } : {}));
    vi.mocked(store.sealForHandOver).mockResolvedValueOnce(null);
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    askFrom(ws, { type: "hand_over", code, key: newKey, relay: "cf" });
    await vi.waitFor(() => expect(tell).toHaveBeenCalled());
    expect(store.releaseHandOver).toHaveBeenCalledWith("current");
    expect(store.letGo).not.toHaveBeenCalled();
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/hand-over"))).toBe(false);
    expect(share.roomToKeep("other")).toMatchObject({ relay: "cf" });
  });
  it("holds taps that arrive while it's handing over, and records them if the game stays", async () => {
    const { api } = await import("../api");
    const store = await import("./store");
    let seal!: (g: LocalGame | null) => void;
    vi.mocked(store.sealForHandOver).mockImplementationOnce(() => new Promise((resolve) => { seal = resolve; }));
    vi.mocked(api).mockImplementation(async (path: string) => (path.includes("/claim/") ? { name: "Sam" } : {}));
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    askFrom(ws, { type: "hand_over", code, key: newKey, relay: "cf" });
    await vi.waitFor(() => expect(seal).toBeTypeOf("function"));
    askFrom(ws, { type: "life", seat: 0, delta: -1 });
    expect(store.dispatch).not.toHaveBeenCalled();
    seal(null);
    await vi.waitFor(() => expect(store.releaseHandOver).toHaveBeenCalled());
    expect(store.dispatch).toHaveBeenCalledWith({ type: "life", seat: 0, delta: -1 });
  });
  it("won't hand over while the table's connection is down: nobody would hear where it went", async () => {
    const { api } = await import("../api");
    const store = await import("./store");
    const { tell } = await import("../components/confirm");
    vi.mocked(api).mockImplementation(async (path: string) => (path.includes("/claim/") ? { name: "Sam" } : {}));
    share.startHosting("current");
    const ws = Socket.sockets[0]!;
    ws.onopen?.();
    askFrom(ws, { type: "hand_over", code, key: newKey, relay: "cf" });
    ws.readyState = 0; // Dropped while the question was on screen.
    await vi.waitFor(() => expect(tell).toHaveBeenCalled());
    expect(store.sealForHandOver).not.toHaveBeenCalled();
    expect(vi.mocked(api).mock.calls.some(([path]) => path.endsWith("/hand-over"))).toBe(false);
  });
});
