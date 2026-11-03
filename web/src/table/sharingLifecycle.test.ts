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
vi.mock("../api", () => ({ api: vi.fn(async () => ({})), API_BASE: "", publicOrigin: () => "https://yama.ing" }));
vi.mock("./store", () => ({
  getGame: () => game,
  isPosted: () => true,
  dispatch: vi.fn(),
  setSharedReadOnly: vi.fn(),
  sync: vi.fn(async () => {}),
  subscribeTable: (f: () => void) => { changes.add(f); return () => { changes.delete(f); }; },
  subscribeTableEnd: (f: (g: LocalGame) => void) => { ends.add(f); return () => { ends.delete(f); }; },
}));
class Socket {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onclose?: (e: { code: number }) => void;
  messages: string[] = [];
  constructor(public url: string) { Socket.sockets.push(this); }
  send(msg: string) { this.messages.push(msg); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
vi.stubGlobal("WebSocket", Socket);
const setup = { id: "current", startedAt: "2026-11-02T19:00:00Z", format: "commander" as const, startingLife: 40, players: [{ seat: 0, name: "Host", colorIdentity: "" }] };
let share: typeof import("./share");
describe("shared table lifecycle", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
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
});
