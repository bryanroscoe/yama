// One shared table's room, written against a small interface so it runs (and is tested) without
// the Workers runtime. `index.ts` plugs in a Durable Object's hibernating WebSockets.
//
// The same wire messages as the server's relay (server/src/table_rooms.rs):
//   host  → relay: {"type":"state", setup, log, next?}
//   guest → relay: {"type":"event", "event": {...}}
//   relay → guest: the host's newest snapshot, or {"type":"host","connected":bool}
//   relay → host:  {"type":"event", "event": {...}}
// The host phone stays authoritative: it checks every event against what guests may do.

export type Role = "host" | "guest";

/** What a room needs from its runtime. `S` is a socket. */
export interface RoomIo<S> {
  /** Open sockets, optionally only one role's. */
  sockets(role?: Role): S[];
  roleOf(s: S): Role;
  send(s: S, text: string): void;
  close(s: S, code: number, reason: string): void;
  /** The newest snapshot, kept across hibernation so late joiners catch up. */
  loadSnapshot(): string | undefined;
  saveSnapshot(text: string): void;
  /** A guest's tap allowance, kept with its socket across hibernation. */
  allowance(s: S): Allowance | undefined;
  setAllowance(s: S, a: Allowance): void;
  now(): number;
}

/** Taps a guest may still send, as of `at` (ms). */
export interface Allowance {
  taps: number;
  at: number;
}

/** A snapshot carries the whole game log, so it may be large; guests only send one tap. */
export const MAX_SNAPSHOT = 1024 * 1024;
export const MAX_EVENT = 8 * 1024;
/** Guests in one room: a table of up to eight, each maybe on two devices, plus spares. */
export const MAX_GUESTS = 24;
/**
 * Taps per guest: a burst of 30, then 8 a second (holding a button repeats about 7 a second).
 * Each tap makes the host send, and the room store, the whole game again, so a phone with the
 * link can't run the table's free allowance down. Taps over it are dropped.
 */
export const TAP_BURST = 30;
export const TAPS_PER_SECOND = 8;

const hostStatus = (connected: boolean) => JSON.stringify({ type: "host", connected });

/** Whether a room can take another connection. The host always gets in: it replaces any old one. */
export function hasRoom<S>(io: RoomIo<S>, role: Role): boolean {
  return role === "host" || io.sockets("guest").length < MAX_GUESTS;
}

/** Spend one of a guest's taps; false when it has none left. */
function spendTap<S>(io: RoomIo<S>, s: S): boolean {
  const now = io.now();
  const was = io.allowance(s) ?? { taps: TAP_BURST, at: now };
  const taps = Math.min(TAP_BURST, was.taps + ((now - was.at) / 1000) * TAPS_PER_SECOND);
  if (taps < 1) return false;
  io.setAllowance(s, { taps: taps - 1, at: now });
  return true;
}

/** A socket just joined (already among `io.sockets()`). */
export function join<S>(io: RoomIo<S>, s: S): void {
  if (io.roleOf(s) === "host") {
    // A newer host connection (a reconnect, or the page reloaded) replaces the old one.
    for (const old of io.sockets("host")) if (old !== s) io.close(old, 4000, "replaced by a newer connection");
    for (const g of io.sockets("guest")) io.send(g, hostStatus(true));
    return;
  }
  io.send(s, hostStatus(io.sockets("host").length > 0));
  const snapshot = io.loadSnapshot();
  if (snapshot) io.send(s, snapshot);
}

export function message<S>(io: RoomIo<S>, s: S, text: string): void {
  if (io.roleOf(s) === "host") {
    if (text.length > MAX_SNAPSHOT) return io.close(s, 1009, "snapshot too large");
    const msg = parse(text);
    if (msg?.type !== "state" || typeof msg.setup !== "object" || !Array.isArray(msg.log)) return;
    io.saveSnapshot(text);
    for (const g of io.sockets("guest")) io.send(g, text);
    return;
  }
  if (text.length > MAX_EVENT) return io.close(s, 1009, "message too large");
  const msg = parse(text);
  const event = msg?.event as { type?: unknown } | undefined;
  if (msg?.type !== "event" || typeof event !== "object" || event === null || typeof event.type !== "string") return;
  if (!spendTap(io, s)) return;
  // Offline host: the tap is dropped, and the guest's screen says changes wait for it.
  const out = JSON.stringify({ type: "event", event });
  for (const h of io.sockets("host")) io.send(h, out);
}

/** A socket closed or failed. `io.sockets()` may still list it. */
export function leave<S>(io: RoomIo<S>, s: S): void {
  if (io.roleOf(s) !== "host") return;
  // A replaced host leaving changes nothing: its successor is already here.
  if (io.sockets("host").some((h) => h !== s)) return;
  for (const g of io.sockets("guest")) if (g !== s) io.send(g, hostStatus(false));
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
