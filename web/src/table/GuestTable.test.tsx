// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "a".repeat(32);
const NEW_KEY = "b".repeat(32);
const CODE = "c".repeat(32);
const fixtures = vi.hoisted(() => ({ user: "sam" as string | null, localGame: null as unknown, hash: "" }));
vi.mock("../auth", () => ({ useMe: () => ({ data: fixtures.user ? { id: fixtures.user } : null }) }));
vi.mock("../api", () => ({ api: vi.fn(async () => ({ code: "c".repeat(32) })) }));
vi.mock("../viewingFlag", () => ({ isViewing: () => false }));
vi.mock("./wakeLock", () => ({ useScreenAwake: () => {} }));
vi.mock("./store", () => ({ resumeGame: vi.fn(), getGame: () => fixtures.localGame, useTable: () => ({ game: fixtures.localGame, state: null }) }));
vi.mock("./share", () => ({
  guestWsUrl: (id: string, key: string) => `wss://relay/table/${id}/ws?role=guest&key=${key}`,
  joinFragment: (key: string, relay: string) => `#k=${key}${relay === "edge" ? "&r=cf" : ""}`,
  // In the app this reads the address bar; here, the router's address (Where, below).
  joinLink: () => ({ key: new URLSearchParams(fixtures.hash.slice(1)).get("k") ?? "", relay: "edge" }),
  roomToKeep: () => ({ key: "b".repeat(32), relay: "cf" }),
  startHosting: vi.fn(),
  clearMovedTo: vi.fn(),
}));
// The table itself is TablePlay's; here only what GuestTable hands it.
vi.mock("./TablePlay", async () => {
  const { createContext } = await import("react");
  return {
    DispatchContext: createContext(() => {}),
    TableScreen: ({ following }: { following: { keepHere?: React.ReactNode; seat: number } }) => (
      <div data-testid="table" data-seat={following.seat}>{following.keepHere}</div>
    ),
  };
});

class Socket {
  static OPEN = 1;
  static sockets: Socket[] = [];
  readyState = 0;
  onopen?: () => void;
  onclose?: (e: { code: number; reason?: string }) => void;
  onmessage?: (m: { data: string }) => void;
  sent: string[] = [];
  constructor(public url: string) { Socket.sockets.push(this); }
  send(msg: string) { this.sent.push(msg); }
  close() { this.readyState = 3; }
  /** The relay lets this phone in, the host is there, and the game arrives. */
  connect(snapshot: unknown) {
    act(() => {
      this.readyState = 1;
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: "host", connected: true }) });
      this.onmessage?.({ data: JSON.stringify(snapshot) });
    });
  }
  receive(msg: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(msg) }));
  }
}
vi.stubGlobal("WebSocket", Socket);

const setup = { id: "current", startedAt: "2026-11-27T19:00:00Z", format: "commander", startingLife: 40, players: [{ seat: 0, name: "Host", colorIdentity: "" }, { seat: 1, name: "Sam", colorIdentity: "" }] };
const log = [{ seq: 1, at: "2026-11-27T19:01:00Z", event: { type: "life", seat: 1, delta: -3 } }];
const moved = (key: string) => ({ type: "state", setup, log, next: { gameId: "current", key, relay: "cf" }, moved: true });

let where = "";
function Where() {
  const l = useLocation();
  where = `${l.pathname}${l.hash}`;
  fixtures.hash = l.hash;
  return null;
}

let host: HTMLElement;
let root: Root;
async function open() {
  const { GuestTable } = await import("./GuestTable");
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[`/table/join/current#k=${KEY}&r=cf`]}>
        <Where />
        <Routes>
          <Route path="/table/join/:gameId" element={<GuestTable />} />
          <Route path="/table/play" element={<p>Hosting here</p>} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name);

beforeEach(() => {
  Socket.sockets.length = 0;
  fixtures.user = "sam";
  fixtures.localGame = null;
  localStorage.clear();
  localStorage.setItem("yama.guest.current", "1");
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("keeping a shared game on this device", () => {
  it("asks the host's device with Yama's claim code and this device's room, then keeps the game on its yes", async () => {
    const { api } = await import("../api");
    const store = await import("./store");
    const share = await import("./share");
    await open();
    Socket.sockets[0]!.connect({ type: "state", setup, log });
    await act(async () => button("Keep the game on this device")!.click());
    expect(api).toHaveBeenCalledWith("/api/table/current/claim", { method: "POST" });
    const asked = JSON.parse(Socket.sockets[0]!.sent.at(-1)!);
    expect(asked).toEqual({ type: "event", event: { type: "hand_over", code: CODE, key: NEW_KEY, relay: "cf" } });
    expect(document.body.textContent).toContain("Asking the host's device");
    Socket.sockets[0]!.receive(moved(NEW_KEY));
    expect(store.resumeGame).toHaveBeenCalledWith(setup, log);
    expect(share.startHosting).toHaveBeenCalledWith("current");
    expect(where).toBe("/table/play");
  });

  it("still keeps the game when its yes comes after this device stopped waiting", async () => {
    const store = await import("./store");
    await open();
    Socket.sockets[0]!.connect({ type: "state", setup, log });
    await act(async () => button("Keep the game on this device")!.click());
    act(() => button("Stop asking")!.click());
    Socket.sockets[0]!.receive(moved(NEW_KEY));
    expect(store.resumeGame).toHaveBeenCalledWith(setup, log);
    expect(where).toBe("/table/play");
  });

  it("follows the game to whichever device took it, in the same seat", async () => {
    const store = await import("./store");
    await open();
    Socket.sockets[0]!.connect({ type: "state", setup, log });
    Socket.sockets[0]!.receive(moved("e".repeat(32)));
    expect(store.resumeGame).not.toHaveBeenCalled();
    expect(where).toBe(`/table/join/current#k=${"e".repeat(32)}&r=cf`);
    // A new room: a new connection, and the seat stays this device's.
    expect(Socket.sockets.at(-1)!.url).toContain(`key=${"e".repeat(32)}`);
    expect(localStorage.getItem("yama.guest.current")).toBe("1");
  });

  it("says what's missing instead of asking: an account, or a device free of its own game", async () => {
    fixtures.user = null;
    await open();
    Socket.sockets[0]!.connect({ type: "state", setup, log });
    expect(button("Keep the game on this device")).toBeUndefined();
    expect(document.body.textContent).toContain("sign in to Yama on it");
    act(() => root.unmount());
    root = createRoot(host);
    fixtures.user = "sam";
    fixtures.localGame = { setup: { id: "mine" } };
    await open();
    Socket.sockets.at(-1)!.connect({ type: "state", setup, log });
    expect(button("Keep the game on this device")).toBeUndefined();
    expect(document.body.textContent).toContain("has its own game going");
  });
});
