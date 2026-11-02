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
import { isGuest } from "../guest";
import { keepStorage } from "../storage";

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
  /**
   * Counted without an account (guest.ts): it stays on this phone until whoever signs in here
   * says to save it (saveGuestGames).
   */
  guest?: true;
  /**
   * The account whose game it is (signed in when it started, or that said to save it): it's only
   * uploaded while that account is signed in here. Missing on games from before this was kept.
   */
  owner?: string;
}

const CURRENT = "yama.table.current";
/**
 * The game going without an account. Kept apart from an account's, so someone counting without
 * one never sees (or overwrites) the game of an account that signed out on this device.
 */
const GUEST_CURRENT = "yama.table.guestCurrent";
/**
 * Which game this device shows: one account's ("account:<id>"), or the one without an account.
 * Each account keeps its own, so someone signing in after another never sees (or discards) the
 * other's game. "account:" (nobody known yet) is the old shared key, from before accounts had
 * their own.
 */
let slot = "account:";
const currentKey = () => (slot === "guest" ? GUEST_CURRENT : slot === "account:" ? CURRENT : `${CURRENT}.${slot.slice("account:".length)}`);
const OUTBOX = "yama.table.outbox";
/** Finished games the server refused (not a network problem). Kept so nothing is lost. */
const REJECTED = "yama.table.rejected";
/** Games to delete from Yama: discarded or deleted here, waiting for a connection. */
const DELETES = "yama.table.deletes";
/** Finished games counted without an account, waiting for someone to sign in and save them. */
const GUEST_GAMES = "yama.table.guestGames";

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
let guestGames: LocalGame[] = read<LocalGame[]>(GUEST_GAMES, []);
/** Each delete remembers whose it is: it's only sent while that account is signed in here. */
type QueuedDelete = { id: string; owner: string | null };
let deletes: QueuedDelete[] = read<(QueuedDelete | string)[]>(DELETES, []).map((d) => (typeof d === "string" ? { id: d, owner: null } : d));

/** The account signed in on this device, as auth.tsx remembers it (the plan outbox does the same). */
function signedInUser(): string | null {
  try {
    return (JSON.parse(localStorage.getItem("yama.me") ?? "null") as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}
const mine = (d: QueuedDelete) => d.owner === null || d.owner === signedInUser();
/** A game this device may upload now: no owner recorded, or the account signed in here. */
const mineGame = (g: LocalGame) => !g.owner || g.owner === signedInUser();
let pendingIds: string[] = [];
let derived: TableState | null = current ? replay(current.setup, current.log) : null;
let syncState: { syncing: boolean; error: string | null; lastSyncedAt: string | null } = {
  syncing: false,
  error: null,
  lastSyncedAt: null,
};

function emit() {
  localStorage.setItem(currentKey(), JSON.stringify(current));
  localStorage.setItem(OUTBOX, JSON.stringify(outbox));
  localStorage.setItem(REJECTED, JSON.stringify(rejected));
  localStorage.setItem(DELETES, JSON.stringify(deletes));
  localStorage.setItem(GUEST_GAMES, JSON.stringify(guestGames));
  for (const l of listeners) l();
}

function setCurrent(next: LocalGame | null) {
  current = next;
  derived = next ? replay(next.setup, next.log) : null;
  // Saved now; anything already showing hears about it in a moment, not in the middle of a
  // render or commit.
  localStorage.setItem(currentKey(), JSON.stringify(current));
  queueMicrotask(emit);
}

/**
 * Show the game without an account (guest) or the account's (main.tsx calls it before the first
 * render and whenever /api/me's answer changes, before any page renders with it). The two never mix: a game counted without an account stays in its own slot
 * until whoever signs in says to save it (saveGuestGames), so nothing an account does reaches it.
 */
export function selectSlot(guest: boolean, user?: string | null) {
  const want = guest ? "guest" : `account:${user ?? ""}`;
  if (slot === want) return;
  slot = want;
  current = read<LocalGame | null>(currentKey(), null);
  // A game kept under the old shared key comes along only for its own account (or one from before
  // games recorded theirs); another account's stays where it is until that account signs in.
  if (!guest && user && !current) {
    const old = read<LocalGame | null>(CURRENT, null);
    if (old && (!old.owner || old.owner === user)) {
      current = { ...old, owner: old.owner ?? user };
      localStorage.removeItem(CURRENT);
    }
  }
  derived = current ? replay(current.setup, current.log) : null;
  waitingGuest = slot !== "guest" ? read<LocalGame | null>(GUEST_CURRENT, null) : null;
  // Pages that render from now on read the new game; anything already showing hears about it
  // in a moment, before the screen updates.
  queueMicrotask(emit);
}

/** The game going without an account, as the signed-in account sees it: waiting to be saved. */
// The device starts on the account's slot, so whatever waits in the guest slot is known from the start.
let waitingGuest: LocalGame | null = read<LocalGame | null>(GUEST_CURRENT, null);
export function useWaitingGuestGame() {
  return useSyncExternalStore(subscribe, () => waitingGuest);
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

/** Games counted on this phone without an account: the finished ones, and the one going. */
export function useGuestGames() {
  return useSyncExternalStore(subscribe, () => guestGames);
}

/**
 * Put the games counted here without an account on the signed-in account, and upload them. The
 * one still going comes along only into an empty slot (it becomes this device's game); with
 * another game going it waits, and the question stays until that one is done.
 */
export function saveGuestGames() {
  // Saved by the account signed in now: theirs, uploaded only while they're signed in here.
  const owner = signedInUser() ?? undefined;
  outbox = [...outbox, ...guestGames.map(({ guest: _, ...g }) => ({ ...g, owner }))];
  guestGames = [];
  // A game marked as counted without an account in the account's own slot (left by an older
  // version) is saved where it is.
  if (current?.guest) {
    const { guest: _, ...g } = current;
    current = { ...g, owner };
  }
  if (slot !== "guest" && waitingGuest && !current) {
    const { guest: _, ...g } = waitingGuest;
    current = { ...g, owner };
    derived = replay(g.setup, g.log);
    waitingGuest = null;
    localStorage.removeItem(GUEST_CURRENT);
  }
  emit();
  void sync();
}

/** Throw away the games counted here without an account, the one going included. */
export function dropGuestGames() {
  guestGames = [];
  if (slot !== "guest" && waitingGuest) {
    waitingGuest = null;
    localStorage.removeItem(GUEST_CURRENT);
  }
  emit();
}

export function useRejected() {
  return useSyncExternalStore(subscribe, () => rejected);
}

/** Games deleted on this device that Yama hasn't removed yet (offline): lists leave them out. */
export function usePendingDeletes() {
  return useSyncExternalStore(subscribe, () => {
    const ids = deletes.filter(mine).map((d) => d.id);
    // The same array while nothing changed, so React doesn't re-render forever.
    if (ids.length !== pendingIds.length || ids.some((id, i) => id !== pendingIds[i])) pendingIds = ids;
    return pendingIds;
  });
}

/**
 * Delete a table game this account recorded: every copy on this device now, and Yama's once the
 * server answers (queued while offline). Resolves true once Yama has removed it.
 */
export async function deleteGame(gameId: string): Promise<boolean> {
  if (current?.setup.id === gameId) {
    forgetPrompts(gameId);
    current = null;
    derived = null;
  }
  outbox = outbox.filter((g) => g.setup.id !== gameId);
  rejected = rejected.filter((r) => r.game.setup.id !== gameId);
  if (!deletes.some((d) => d.id === gameId)) deletes = [...deletes, { id: gameId, owner: signedInUser() }];
  emit();
  await settle();
  return !deletes.some((d) => d.id === gameId);
}

/** Sync, then once more if a run that was already going missed something queued since. */
async function settle() {
  await sync();
  if (deletes.some(mine) || current || outbox.length) await sync();
}

async function pushDeletes() {
  // Another account's deletes wait until it signs in here again.
  for (const { id } of deletes.filter(mine)) {
    try {
      await api(`/api/games/${id}`, { method: "DELETE" });
    } catch (e) {
      // Not found: the server never had it (or it's gone already), which is what we wanted.
      if (!(e instanceof ApiError && e.status === 404) && !isPermanent(e)) throw e;
    }
    deletes = deletes.filter((d) => d.id !== id);
    emit();
  }
}

/** Yama says the game was deleted on purpose (410). */
function isGone(e: unknown) {
  return e instanceof ApiError && e.status === 410;
}

/** A 4xx other than auth or rate limits: retrying the same upload won't help. */
function isPermanent(e: unknown) {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);
}

export function useSyncStatus() {
  return useSyncExternalStore(subscribe, () => syncState);
}

export function startGame(setup: TableSetup) {
  // A game in progress lives only on this device until it's uploaded.
  keepStorage();
  const owner = isGuest() ? undefined : (signedInUser() ?? undefined);
  setCurrent({ setup, log: [], redo: [], syncedThrough: 0, ...(isGuest() ? { guest: true as const } : {}), ...(owner ? { owner } : {}) });
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
  // A finished game uploads whole: drop the in-flight mark so nothing is held back. One counted
  // without an account waits on this phone instead.
  if (current.guest) guestGames = [...guestGames, { ...current, log, frozenThrough: undefined }];
  else outbox = [...outbox, { ...current, log, frozenThrough: undefined }];
  forgetPrompts(current.setup.id);
  setCurrent(null);
  void sync();
}

/**
 * Carry on, on this device, with a game this account started elsewhere (the phone died, or the
 * laptop takes over). Everything the server has is history: it can't be undone from here.
 */
export function resumeGame(setup: TableSetup, log: LoggedEvent[]) {
  const through = log[log.length - 1]?.seq ?? 0;
  setCurrent({ setup, log, redo: [], syncedThrough: through, frozenThrough: through, ...(signedInUser() ? { owner: signedInUser()! } : {}) });
  posted.add(setup.id);
  void sync();
}

/** The table's "not out" answers for a game that's over (TablePlay's useLethalPrompt). */
function forgetPrompts(gameId: string) {
  localStorage.removeItem(`yama.table.dismissed.${gameId}`);
}

/** Throw away the game on this device. If it already reached Yama, it's deleted there too. */
export function discardGame() {
  if (!current) return;
  // Never uploaded: it only has to go from this phone.
  if (current.guest) {
    forgetPrompts(current.setup.id);
    return setCurrent(null);
  }
  void deleteGame(current.setup.id);
}

/** The seat's label on the server: its commander, and its partner, so another device can rebuild the pair. */
export function deckLabel(p: { deckLabel?: string; commanderName?: string; partnerName?: string }): string | null {
  if (p.partnerName && p.commanderName && (!p.deckLabel || p.deckLabel === p.commanderName)) return `${p.commanderName} and ${p.partnerName}`;
  return p.deckLabel ?? p.commanderName ?? null;
}

async function pushGame(g: LocalGame): Promise<number> {
  const s = g.setup;
  // A seat that changed commanders or players mid-game uploads the one it has now.
  const now = new Map(replay(s, g.log).players.map((p) => [p.seat, p]));
  const upTo = g.frozenThrough ?? Infinity;
  const fresh = g.log.filter((l) => l.seq > g.syncedThrough && l.seq <= upTo);
  await api("/api/games", {
    method: "POST",
    json: {
      id: s.id,
      playgroup_id: s.playgroupId ?? null,
      format: s.format,
      starting_life: s.startingLife,
      started_at: s.startedAt,
      seats: s.players.map((p) => {
        const c = now.get(p.seat) ?? p;
        return {
          seat: p.seat,
          member_id: c.memberId ?? null,
          user_id: c.userId ?? null,
          guest_name: c.memberId || c.userId ? null : c.name,
          deck_version_id: c.deckVersionId ?? null,
          deck_label: deckLabel(c),
          commander_name: now.get(p.seat)?.commanderName ?? null,
        };
      }),
      // The events ride along, so a seat's new player arrives with the "player" event that
      // explains it (Yama refuses different players without one).
      events: toServerEvents(fresh),
    },
  });
  posted.add(s.id);
  // Built from the log alone, so a retry sends exactly the same finish.
  const finish = toServerFinish(s, g.log);
  if (finish) await api(`/api/games/${s.id}/finish`, { method: "POST", json: finish });
  return upTo === Infinity ? (g.log[g.log.length - 1]?.seq ?? 0) : upTo;
}

let inflight: Promise<void> | null = null;

/** Games this device has seen the server accept (the shared-table relay needs the game there first). */
const posted = new Set<string>();
export function isPosted(gameId: string): boolean {
  return posted.has(gameId);
}

export function sync(): Promise<void> {
  // An admin viewing as someone sends nothing: games recorded on this device wait until the view
  // ends (the server would refuse them, and they'd be set aside as rejected).
  if (isViewing()) return Promise.resolve();
  // Nobody is signed in: there's no account to send anything to.
  if (isGuest()) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    syncState = { ...syncState, syncing: true };
    emit();
    try {
      // Finished games first: they're complete and the most valuable.
      // Another account's games wait until it signs in here again.
      for (let g = outbox.find(mineGame); g; g = outbox.find(mineGame)) {
        try {
          await pushGame(g);
        } catch (e) {
          if (!isPermanent(e)) throw e;
          // Set it aside so the games behind it still upload; one deleted meanwhile, or deleted
          // on another device (410), is simply gone.
          if (!deletes.some((d) => d.id === g.setup.id) && !isGone(e)) rejected = [...rejected, { game: g, error: e instanceof Error ? e.message : String(e) }];
        }
        // By identity: a delete while this one uploaded may have changed the list.
        outbox = outbox.filter((o) => o !== g);
        emit();
      }
      await pushDeletes();
      if (current && !current.guest && mineGame(current)) {
        // Freeze what we're about to send: later taps start new events instead of changing these.
        const through = current.log[current.log.length - 1]?.seq ?? 0;
        current = { ...current, frozenThrough: Math.max(current.frozenThrough ?? 0, through) };
        emit();
        const snapshot = current;
        try {
          await pushGame(snapshot);
        } catch (e) {
          if (!isGone(e)) throw e;
          // Whoever recorded it deleted it on another device: it goes from this one too.
          if (current?.setup.id === snapshot.setup.id) {
            forgetPrompts(snapshot.setup.id);
            current = null;
            derived = null;
          }
        }
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
  if (current || outbox.length || deletes.some(mine)) queueMicrotask(() => void sync());
  setInterval(() => {
    if (navigator.onLine && (current || outbox.length || deletes.some(mine))) void sync();
  }, 20_000);
}

/** For the shared-table host connection: current game and change notifications. */
export function getGame(): LocalGame | null {
  return current;
}
export { subscribe as subscribeTable };
