import { describe, expect, it } from "vitest";
import { MAX_EVENT, MAX_GUESTS, MAX_SNAPSHOT, TAP_BURST, TAPS_PER_SECOND, hasRoom, join, leave, message, type Allowance, type Role, type RoomIo } from "./room";

interface Fake {
  role: Role;
  open: boolean;
  got: string[];
  closed?: { code: number; reason: string };
  allowance?: Allowance;
}

function fakeRoom() {
  const all: Fake[] = [];
  let snapshot: string | undefined;
  const clock = { now: 1_000_000 };
  const io: RoomIo<Fake> = {
    sockets: (role) => all.filter((s) => s.open && (!role || s.role === role)),
    roleOf: (s) => s.role,
    send: (s, text) => void s.got.push(text),
    close: (s, code, reason) => {
      s.open = false;
      s.closed = { code, reason };
    },
    loadSnapshot: () => snapshot,
    saveSnapshot: (t) => void (snapshot = t),
    allowance: (s) => s.allowance,
    setAllowance: (s, a) => void (s.allowance = a),
    now: () => clock.now,
  };
  const connect = (role: Role) => {
    const s: Fake = { role, open: true, got: [] };
    all.push(s);
    join(io, s);
    return s;
  };
  return { io, connect, clock, snapshot: () => snapshot };
}

const state = (life: number, extra: object = {}) => JSON.stringify({ type: "state", setup: { id: "g1" }, log: [{ life }], ...extra });
const tap = JSON.stringify({ type: "event", event: { type: "life", seat: 1, delta: -1 } });

describe("table room", () => {
  it("passes the host's snapshots to guests and guests' taps to the host", () => {
    const r = fakeRoom();
    const host = r.connect("host");
    const guest = r.connect("guest");
    expect(guest.got).toEqual([JSON.stringify({ type: "host", connected: true })]);
    message(r.io, host, state(40));
    expect(guest.got.at(-1)).toBe(state(40));
    message(r.io, guest, tap);
    expect(host.got).toEqual([tap]);
  });

  it("catches up a late joiner with the newest snapshot, even while the host is away", () => {
    const r = fakeRoom();
    const host = r.connect("host");
    message(r.io, host, state(40));
    message(r.io, host, state(39));
    host.open = false;
    leave(r.io, host);
    const late = r.connect("guest");
    expect(late.got).toEqual([JSON.stringify({ type: "host", connected: false }), state(39)]);
  });

  it("tells guests when the host drops and comes back", () => {
    const r = fakeRoom();
    const host = r.connect("host");
    const guest = r.connect("guest");
    host.open = false;
    leave(r.io, host);
    expect(guest.got.at(-1)).toBe(JSON.stringify({ type: "host", connected: false }));
    r.connect("host");
    expect(guest.got.at(-1)).toBe(JSON.stringify({ type: "host", connected: true }));
  });

  it("lets a newer host connection replace the old one without telling guests it left", () => {
    const r = fakeRoom();
    const first = r.connect("host");
    const guest = r.connect("guest");
    const second = r.connect("host");
    expect(first.closed?.code).toBe(4000);
    const before = guest.got.length;
    leave(r.io, first);
    expect(guest.got.length).toBe(before);
    message(r.io, guest, tap);
    expect(second.got).toEqual([tap]);
    expect(first.got).toEqual([]);
  });

  it("never lets a guest speak for the host", () => {
    const r = fakeRoom();
    r.connect("host");
    const guest = r.connect("guest");
    const other = r.connect("guest");
    message(r.io, guest, state(1));
    expect(r.snapshot()).toBeUndefined();
    expect(other.got).toEqual([JSON.stringify({ type: "host", connected: true })]);
  });

  it("forwards only well-formed events, rebuilt, and nothing else a guest sends", () => {
    const r = fakeRoom();
    const host = r.connect("host");
    const guest = r.connect("guest");
    for (const junk of ["not json", "[]", "null", '{"type":"event"}', '{"type":"event","event":{"seat":1}}', '{"type":"state","setup":{},"log":[]}']) {
      message(r.io, guest, junk);
    }
    expect(host.got).toEqual([]);
    message(r.io, guest, JSON.stringify({ type: "event", event: { type: "life", seat: 1, delta: 2 }, from: "someone else", extra: 1 }));
    expect(host.got).toEqual([JSON.stringify({ type: "event", event: { type: "life", seat: 1, delta: 2 } })]);
  });

  it("ignores host messages that aren't snapshots", () => {
    const r = fakeRoom();
    const host = r.connect("host");
    const guest = r.connect("guest");
    message(r.io, host, JSON.stringify({ type: "state", setup: "x", log: [] }));
    message(r.io, host, "garbage");
    expect(r.snapshot()).toBeUndefined();
    expect(guest.got.length).toBe(1);
  });

  it("closes oversized messages", () => {
    const r = fakeRoom();
    const host = r.connect("host");
    const guest = r.connect("guest");
    message(r.io, guest, JSON.stringify({ type: "event", event: { type: "life", pad: "x".repeat(MAX_EVENT) } }));
    expect(guest.closed?.code).toBe(1009);
    message(r.io, host, state(1, { pad: "x".repeat(MAX_SNAPSHOT) }));
    expect(host.closed?.code).toBe(1009);
    expect(r.snapshot()).toBeUndefined();
  });

  it("has room for a full table of guests, and always for the host", () => {
    const r = fakeRoom();
    for (let i = 0; i < MAX_GUESTS; i++) {
      expect(hasRoom(r.io, "guest")).toBe(true);
      r.connect("guest");
    }
    expect(hasRoom(r.io, "guest")).toBe(false);
    // Someone holding the link can't lock the host out by filling the room.
    expect(hasRoom(r.io, "host")).toBe(true);
  });

  it("drops a guest's taps beyond a burst, and lets them through again as time passes", () => {
    const r = fakeRoom();
    const host = r.connect("host");
    const guest = r.connect("guest");
    for (let i = 0; i < TAP_BURST + 10; i++) message(r.io, guest, tap);
    expect(host.got.length).toBe(TAP_BURST);
    r.clock.now += 1000;
    for (let i = 0; i < TAPS_PER_SECOND + 5; i++) message(r.io, guest, tap);
    expect(host.got.length).toBe(TAP_BURST + TAPS_PER_SECOND);
    // Each guest has its own allowance.
    const other = r.connect("guest");
    message(r.io, other, tap);
    expect(host.got.length).toBe(TAP_BURST + TAPS_PER_SECOND + 1);
  });
});
