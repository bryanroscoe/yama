// The game on this device, kept in localStorage so a refresh, a locked phone or no signal
// never loses it. Sync to the server is opportunistic and idempotent.

import {
  record,
  replay,
  toServerEvents,
  toServerFinish,
  type FinishDetails,
  type LoggedEvent,
  type TableEvent,
  type TableSetup,
  type TableState,
} from "@yama/core";
import { useSyncExternalStore } from "react";
import { api, ApiError } from "../api";
import { isViewing } from "../viewingFlag";

export interface LocalGame {
  setup: TableSetup;
  log: LoggedEvent[];
  /** Undone events, newest last, for redo. Cleared by any new event. */
  redo: LoggedEvent[];
  /** Highest seq the server has. */
  syncedThrough: number;
  /**
   * Highest seq handed to an upload (maybe still in flight). Events at or below it are never
   * merged into or undone, so the phone and the server can't end up with different versions.
   */
  frozenThrough?: number;
  finishSynced?: boolean;
}

const CURRENT = "yama.table.current";
const OUTBOX = "yama.table.outbox";
/** Finished games the server refused (not a network problem). Kept so nothing is lost. */
const REJECTED = "yama.table.rejected";

type Listener = () => void;
const listeners = new Set<Listener>();

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

let current: LocalGame | null = read<LocalGame | null>(CURRENT, null);
let outbox: LocalGame[] = read<LocalGame[]>(OUTBOX, []);
let rejected: { game: LocalGame; error: string }[] = read(REJECTED, []);
let derived: TableState | null = current ? replay(current.setup, current.log) : null;
let syncState: { syncing: boolean; error: string | null; lastSyncedAt: string | null } = {
  syncing: false,
  error: null,
  lastSyncedAt: null,
};

function emit() {
  localStorage.setItem(CURRENT, JSON.stringify(current));
  localStorage.setItem(OUTBOX, JSON.stringify(outbox));
  localStorage.setItem(REJECTED, JSON.stringify(rejected));
  for (const l of listeners) l();
}

function setCurrent(next: LocalGame | null) {
  current = next;
  derived = next ? replay(next.setup, next.log) : null;
  emit();
}

const subscribe = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useTable() {
  const game = useSyncExternalStore(subscribe, () => current);
  const state = useSyncExternalStore(subscribe, () => derived);
  return { game, state };
}

export function useOutbox() {
  return useSyncExternalStore(subscribe, () => outbox);
}

export function useRejected() {
  return useSyncExternalStore(subscribe, () => rejected);
}

/** A 4xx other than auth or rate limits: retrying the same upload won't help. */
function isPermanent(e: unknown) {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);
}

export function useSyncStatus() {
  return useSyncExternalStore(subscribe, () => syncState);
}

export function startGame(setup: TableSetup) {
  setCurrent({ setup, log: [], redo: [], syncedThrough: 0 });
  void sync();
}

const fixedThrough = (g: LocalGame) => Math.max(g.syncedThrough, g.frozenThrough ?? 0);

export function dispatch(event: TableEvent) {
  if (!current) return;
  setCurrent({ ...current, log: record(current.log, event, new Date(), fixedThrough(current)), redo: [] });
}

/** Undo only reaches events not yet sent to the server; older ones are history. */
export function canUndo() {
  return !!current && current.log.length > 0 && current.log[current.log.length - 1]!.seq > fixedThrough(current);
}

export function undo() {
  if (!current || !canUndo()) return;
  const last = current.log[current.log.length - 1]!;
  setCurrent({ ...current, log: current.log.slice(0, -1), redo: [...current.redo, last] });
}

export function redo() {
  if (!current || current.redo.length === 0) return;
  const next = current.redo[current.redo.length - 1]!;
  const seq = (current.log[current.log.length - 1]?.seq ?? 0) + 1;
  setCurrent({ ...current, log: [...current.log, { ...next, seq }], redo: current.redo.slice(0, -1) });
}

/**
 * End the game and queue it for upload. `details` (how it was won, fun ratings) ride on the
 * finish event and `firstSeat`, if the table only says at the end, goes in as a set_first event
 * just before it, so the log stays the one record the server copies.
 */
export function finishGame(winnerSeat: number | null, details: FinishDetails = {}, firstSeat: number | null = null) {
  if (!current) return;
  const now = new Date();
  let log = current.log;
  if (firstSeat !== null && replay(current.setup, log).firstSeat !== firstSeat) {
    log = record(log, { type: "set_first", seat: firstSeat }, now, Infinity);
  }
  const fun = details.fun?.length ? details.fun : undefined;
  const winCondition = winnerSeat === null ? undefined : details.winCondition;
  log = record(log, { type: "finish", winnerSeat, endedAt: now.toISOString(), ...(winCondition ? { winCondition } : {}), ...(fun ? { fun } : {}) }, now, Infinity);
  // A finished game uploads whole: drop the in-flight mark so nothing is held back.
  outbox = [...outbox, { ...current, log, frozenThrough: undefined }];
  setCurrent(null);
  void sync();
}

/**
 * Carry on, on this device, with a game this account started elsewhere (the phone died, or the
 * laptop takes over). Everything the server has is history: it can't be undone from here.
 */
export function resumeGame(setup: TableSetup, log: LoggedEvent[]) {
  const through = log[log.length - 1]?.seq ?? 0;
  setCurrent({ setup, log, redo: [], syncedThrough: through, frozenThrough: through });
  void sync();
}

export function discardGame() {
  setCurrent(null);
}

/** The seat's label on the server: its commander, and its partner, so another device can rebuild the pair. */
export function deckLabel(p: { deckLabel?: string; commanderName?: string; partnerName?: string }): string | null {
  if (p.partnerName && p.commanderName && (!p.deckLabel || p.deckLabel === p.commanderName)) return `${p.commanderName} and ${p.partnerName}`;
  return p.deckLabel ?? p.commanderName ?? null;
}

async function pushGame(g: LocalGame): Promise<number> {
  const s = g.setup;
  // A seat that changed commanders mid-game uploads the one it has now.
  const now = new Map(replay(s, g.log).players.map((p) => [p.seat, p]));
  await api("/api/games", {
    method: "POST",
    json: {
      id: s.id,
      playgroup_id: s.playgroupId ?? null,
      format: s.format,
      starting_life: s.startingLife,
      started_at: s.startedAt,
      seats: s.players.map((p) => ({
        seat: p.seat,
        member_id: p.memberId ?? null,
        user_id: p.userId ?? null,
        guest_name: p.memberId || p.userId ? null : p.name,
        deck_version_id: (now.get(p.seat) ?? p).deckVersionId ?? null,
        deck_label: deckLabel(now.get(p.seat) ?? p),
        commander_name: now.get(p.seat)?.commanderName ?? null,
      })),
    },
  });
  const upTo = g.frozenThrough ?? Infinity;
  const fresh = g.log.filter((l) => l.seq > g.syncedThrough && l.seq <= upTo);
  if (fresh.length) await api(`/api/games/${s.id}/events`, { method: "POST", json: toServerEvents(fresh) });
  // Built from the log alone, so a retry sends exactly the same finish.
  const finish = toServerFinish(s, g.log);
  if (finish) await api(`/api/games/${s.id}/finish`, { method: "POST", json: finish });
  return upTo === Infinity ? (g.log[g.log.length - 1]?.seq ?? 0) : upTo;
}

let inflight: Promise<void> | null = null;

export function sync(): Promise<void> {
  // An admin viewing as someone sends nothing: games recorded on this device wait until the view
  // ends (the server would refuse them, and they'd be set aside as rejected).
  if (isViewing()) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    syncState = { ...syncState, syncing: true };
    emit();
    try {
      // Finished games first: they're complete and the most valuable.
      while (outbox.length) {
        const g = outbox[0]!;
        try {
          await pushGame(g);
        } catch (e) {
          if (!isPermanent(e)) throw e;
          // Set it aside so the games behind it still upload.
          rejected = [...rejected, { game: g, error: e instanceof Error ? e.message : String(e) }];
        }
        outbox = outbox.slice(1);
        emit();
      }
      if (current) {
        // Freeze what we're about to send: later taps start new events instead of changing these.
        const through = current.log[current.log.length - 1]?.seq ?? 0;
        current = { ...current, frozenThrough: Math.max(current.frozenThrough ?? 0, through) };
        emit();
        const snapshot = current;
        await pushGame(snapshot);
        // Only advance if the game is still the same one (it may have been finished meanwhile).
        if (current && current.setup.id === snapshot.setup.id) {
          current = { ...current, syncedThrough: Math.max(current.syncedThrough, through) };
        }
      }
      syncState = { syncing: false, error: null, lastSyncedAt: new Date().toISOString() };
    } catch (e) {
      syncState = { ...syncState, syncing: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void sync());
  // A game or finished games left on this device from before (a reload, a phone that was off)
  // go up straight away, so sharing and other devices can find them.
  if (current || outbox.length) queueMicrotask(() => void sync());
  setInterval(() => {
    if (navigator.onLine && (current || outbox.length)) void sync();
  }, 20_000);
}

/** For the shared-table host connection: current game and change notifications. */
export function getGame(): LocalGame | null {
  return current;
}
export { subscribe as subscribeTable };
