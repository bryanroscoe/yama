// One shared table's room, written against a small interface so it runs (and is tested) without
// the Workers runtime. `index.ts` plugs in a Durable Object's hibernating WebSockets.
//
// The same wire messages as the server's relay (server/src/table_rooms.rs):
//   host  → relay: {"type":"state", setup, log, next?}
//   guest → relay: {"type":"event", "event": {...}}
//   relay → guest: the host's newest snapshot, or {"type":"host","connected":bool}
//   relay → host:  {"type":"event", "event": {...}}, or {"type":"resend"} when the room lost its
//                  newest snapshot (it slept) and someone joined
// The host phone stays authoritative: it checks every event against what guests may do.

export type Role = "host" | "guest";

/** What a room needs from its runtime. `S` is a socket. */
export interface RoomIo<S> {
  /** Open sockets, optionally only one role's. */
  sockets(role?: Role): S[];
  roleOf(s: S): Role;
  send(s: S, text: string): void;
  close(s: S, code: number, reason: string): void;
  /** A stored snapshot, kept across hibernation so late joiners catch up. */
  loadSnapshot(): string | undefined;
  saveSnapshot(text: string): void;
  /**
   * What the room remembers while it's awake: lost when it sleeps (only after it has been idle),
   * kept across guests reconnecting.
   */
  memory: RoomMemory;
  now(): number;
}

export interface RoomMemory {
  /** The host's newest snapshot. */
  latest?: string;
  /** Newer than the stored snapshot, waiting for the next write. */
  unsaved?: boolean;
  savedAt?: number;
  /** Taps guests may still send, as of `tapsAt` (ms). */
  taps?: number;
  tapsAt?: number;
}

/** A snapshot carries the whole game log, so it may be large; guests only send one tap. */
export const MAX_SNAPSHOT = 1024 * 1024;
export const MAX_EVENT = 8 * 1024;
/** Guests in one room: a table of up to eight, each maybe on two devices, plus spares. */
export const MAX_GUESTS = 24;
/**
 * Taps from all of a room's guests together: a burst of 40, then 12 a second (holding a button
 * repeats about 7 a second). Each tap makes the host send the whole game again; taps over it are
 * dropped. Room-wide, so reconnecting doesn't buy a fresh allowance.
 */
export const TAP_BURST = 40;
export const TAPS_PER_SECOND = 12;
/**
 * Snapshots are stored at most this often (each is a storage write, and the free plan has a
 * daily allowance); guests get every one as it comes. One still unsaved is written when the host
 * leaves or the next one arrives, and if the room sleeps first, the host is asked again.
 */
export const SAVE_EVERY_MS = 5000;

const hostStatus = (connected: boolean) => JSON.stringify({ type: "host", connected });

/** Whether a room can take another connection. The host always gets in: it replaces any old one. */
export function hasRoom<S>(io: RoomIo<S>, role: Role): boolean {
  return role === "host" || io.sockets("guest").length < MAX_GUESTS;
}

/** Spend one of the guests' taps; false when none are left. */
function spendTap<S>(io: RoomIo<S>): boolean {
  const m = io.memory;
  const now = io.now();
  const taps = Math.min(TAP_BURST, (m.taps ?? TAP_BURST) + ((now - (m.tapsAt ?? now)) / 1000) * TAPS_PER_SECOND);
  if (taps < 1) return false;
  m.taps = taps - 1;
  m.tapsAt = now;
  return true;
}

function save<S>(io: RoomIo<S>) {
  const m = io.memory;
  if (!m.unsaved || !m.latest) return;
  io.saveSnapshot(m.latest);
  m.unsaved = false;
  m.savedAt = io.now();
}

/** A socket just joined (already among `io.sockets()`). */
export function join<S>(io: RoomIo<S>, s: S): void {
  if (io.roleOf(s) === "host") {
    // A newer host connection (a reconnect, or the page reloaded) replaces the old one.
    for (const old of io.sockets("host")) if (old !== s) io.close(old, 4000, "replaced by a newer connection");
    for (const g of io.sockets("guest")) io.send(g, hostStatus(true));
    return;
  }
  const hosts = io.sockets("host");
  io.send(s, hostStatus(hosts.length > 0));
  const snapshot = io.memory.latest ?? io.loadSnapshot();
  if (snapshot) io.send(s, snapshot);
  // Just woken: the stored snapshot may be a few seconds behind the host.
  if (!io.memory.latest) for (const h of hosts) io.send(h, JSON.stringify({ type: "resend" }));
}

export function message<S>(io: RoomIo<S>, s: S, text: string): void {
  if (io.roleOf(s) === "host") {
    if (text.length > MAX_SNAPSHOT) return io.close(s, 1009, "snapshot too large");
    const msg = parse(text);
    if (msg?.type !== "state" || typeof msg.setup !== "object" || !Array.isArray(msg.log)) return;
    const m = io.memory;
    m.latest = text;
    m.unsaved = true;
    // The next game's link is stored at once: phones that reconnect later follow it from here.
    if (msg.next || io.now() - (m.savedAt ?? -Infinity) >= SAVE_EVERY_MS) save(io);
    for (const g of io.sockets("guest")) io.send(g, text);
    return;
  }
  if (text.length > MAX_EVENT) return io.close(s, 1009, "message too large");
  const msg = parse(text);
  const event = msg?.event as { type?: unknown } | undefined;
  if (msg?.type !== "event" || typeof event !== "object" || event === null || typeof event.type !== "string") return;
  if (!spendTap(io)) return;
  // Offline host: the tap is dropped, and the guest's screen says changes wait for it.
  const out = JSON.stringify({ type: "event", event });
  for (const h of io.sockets("host")) io.send(h, out);
}

/** A socket closed or failed. `io.sockets()` may still list it. */
export function leave<S>(io: RoomIo<S>, s: S): void {
  if (io.roleOf(s) !== "host") return;
  save(io);
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
