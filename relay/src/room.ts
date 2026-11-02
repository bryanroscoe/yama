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
  /** Each connection's messages left, as of `at` (ms): see MESSAGE_BURST. */
  budgets?: Map<unknown, { left: number; at: number }>;
}

/** A snapshot carries the whole game log, so it may be large; guests only send one tap. */
export const MAX_SNAPSHOT = 1024 * 1024;
export const MAX_EVENT = 8 * 1024;
/** Guests in one room: a table of up to eight, each maybe on two devices, plus spares. */
export const MAX_GUESTS = 24;
/**
 * Taps from all of a room's guests together: a burst of 40, then 5 a second (holding a button
 * repeats about 7 a second for a moment, then about 2). Each tap makes the host send the whole game again; taps over it are
 * dropped. Room-wide, so reconnecting doesn't buy a fresh allowance.
 */
export const TAP_BURST = 40;
/** Within a table's guest message share (300 a minute per address, wrangler.toml). */
export const TAPS_PER_SECOND = 5;
/**
 * Snapshots are stored at most this often (each is a storage write, and the free plan has a
 * daily allowance); guests get every one as it comes. One still unsaved is written when the host
 * leaves or the next one arrives, and if the room sleeps first, the host is asked again.
 */
export const SAVE_EVERY_MS = 5000;

/**
 * Messages one connection may send, of any kind: a burst of 60, then 20 a second (a host resends
 * the game on every change, a dozen a second at a busy table). Over it the socket is closed, so a
 * connection that got in can't flood the room (each incoming message counts against the plan's
 * daily allowance); reconnecting is limited in index.ts.
 */
export const MESSAGE_BURST = 60;
export const MESSAGES_PER_SECOND = 20;
export const CLOSE_TOO_MANY_MESSAGES = 4429;

const hostStatus = (connected: boolean) => JSON.stringify({ type: "host", connected });

/** Whether a room can take another connection. The host always gets in: it replaces any old one. */
export function hasRoom<S>(io: RoomIo<S>, role: Role): boolean {
  return role === "host" || io.sockets("guest").length < MAX_GUESTS;
}

/** Spend one of this connection's messages; false when it has none left. */
function spendMessage<S>(io: RoomIo<S>, s: S): boolean {
  const budgets = (io.memory.budgets ??= new Map());
  const now = io.now();
  const was = budgets.get(s) ?? { left: MESSAGE_BURST, at: now };
  const left = Math.min(MESSAGE_BURST, was.left + ((now - was.at) / 1000) * MESSAGES_PER_SECOND);
  if (left < 1) return false;
  budgets.set(s, { left: left - 1, at: now });
  return true;
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

/**
 * Count one message against its connection's budget as it arrives, every message, even ones
 * dropped later as malformed; false (and the socket closed) when it has none left. Done before a
 * message waits for anything, so a burst can't pile up behind a wait first.
 */
export function admit<S>(io: RoomIo<S>, s: S): boolean {
  if (spendMessage(io, s)) return true;
  io.close(s, CLOSE_TOO_MANY_MESSAGES, "too many messages");
  return false;
}

/** A message from a socket: admitted against its budget, then handled. */
export function message<S>(io: RoomIo<S>, s: S, text: string): void {
  if (admit(io, s)) handle(io, s, text);
}

/** A message already admitted (`admit`). */
export function handle<S>(io: RoomIo<S>, s: S, text: string): void {
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
  io.memory.budgets?.delete(s);
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
