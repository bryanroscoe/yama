// The game on this device, kept in localStorage so a refresh, a locked phone or no signal
// never loses it. Sync to the server is opportunistic and idempotent.

import {
  apply,
  record,
  replay,
  seatOrder,
  settledThrough,
  toServerEvents,
  toServerFinish,
  type FinishDetails,
  type LoggedEvent,
  type TableEvent,
  type TableSetup,
  type TableState,
} from "@yama/core";
import { useSyncExternalStore } from "react";
import { api, ApiError, errorMessage, unanswered } from "../api";
import { isViewing } from "../viewingFlag";
import { isGuest } from "../guest";
import { keepStorage } from "../storage";
import { acknowledgeFinished, finishedRecords, hasEnded, isFinishedStorageKey, rejectFinished, rememberServerFinish, saveFinished } from "./finished";
import { flushLogged, hasLoggedToSend } from "./loggedQueue";

export interface LocalGame {
  /** Durable finished-result record; bulk queues may be rebuilt from it after a stale write. */
  saveId?: string;
  setup: TableSetup;
  log: LoggedEvent[];
  /** Undone events, newest last, for redo. Cleared by any new event. */
  redo: Undone[];
  /**
   * Events Undo took back by recording their opposite, because they could no longer be dropped:
   * `by` is the seq of the opposite event and `of` the seq of the one it cancels. Both stay in
   * the log for good and Undo steps over both, so it never undoes its own undo. A pair goes only
   * when its `by` event is dropped again (Redo before it was sent).
   */
  cancelled?: { by: number; of: number }[];
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

/**
 * An undone event waiting for Redo. `by` is the seq of the event that took it back; missing when
 * it was simply dropped from the log.
 */
export type Undone = LoggedEvent & { by?: number };

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
// Storage notifications may be delayed while another app window is asleep. Compare the
// actual persisted snapshots before writing, including queues when the active game is unchanged.
const observed = new Map<string, string | null>();

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    observed.set(key, raw);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  localStorage.setItem(key, raw);
  observed.set(key, raw);
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

// Pause restored shared games before the startup sync microtask, until this document has
// acquired their host lock. A passive second tab must not upload even its first stale copy.
function pendingHostLock(game: LocalGame | null): string | null {
  return typeof navigator !== "undefined" && navigator.locks && game?.owner &&
    localStorage.getItem(`yama.table.hosting.${game.owner}`) === game.setup.id ? game.setup.id : null;
}
// A matching game ID is insufficient: a newer commander/log or pending result can have
// the same ID. Never replace snapshots we have not observed, even before their storage event.
const storageKeys = () => [currentKey(), OUTBOX, REJECTED, DELETES, GUEST_GAMES, GUEST_CURRENT];
const sameStoredSnapshot = () => storageKeys().every((key) => localStorage.getItem(key) === (observed.get(key) ?? null));
let readOnlyGame: string | null = pendingHostLock(current);
/** This document has been granted hosting ownership (a browser lock where supported). */
let sharedHost: string | null = null;
export function setSharedHost(gameId: string | null) { sharedHost = gameId; }
function canWriteShared() {
  const marked = pendingHostLock(current);
  return readOnlyGame === null && sameStoredSnapshot() && (!marked || marked === sharedHost);
}
/** Another tab owns this shared counter; this tab may follow it, never write its old copy. */
export function setSharedReadOnly(gameId: string | null) {
  if (readOnlyGame && !gameId) reloadQueues();
  readOnlyGame = gameId;
}
function reloadQueues() {
  outbox = read<LocalGame[]>(OUTBOX, []);
  rejected = read(REJECTED, []);
  guestGames = read<LocalGame[]>(GUEST_GAMES, []);
  deletes = read<(QueuedDelete | string)[]>(DELETES, []).map((d) => typeof d === "string" ? { id: d, owner: null } : d);
  restoreFinished();
}
function restoreFinished() {
  const saved = finishedRecords();
  // Preserve results queued by builds from before individual durable saves existed.
  const upgrade = (game: LocalGame, error?: string): LocalGame | undefined => {
    if (game.saveId || !game.log.some((entry) => entry.event.type === "finish")) return game;
    const existing = saved.find((row) => row.game.setup.id === game.setup.id && row.game.owner === game.owner
      && row.game.guest === game.guest && JSON.stringify(row.game.setup) === JSON.stringify(game.setup) && JSON.stringify(row.game.log) === JSON.stringify(game.log));
    if (existing) return existing.game;
    // A stale pre-upgrade queue must not recreate a discarded/adopted/acknowledged result.
    if (!saved.some((row) => row.game.setup.id === game.setup.id && row.game.owner === game.owner && row.game.guest === game.guest) && hasEnded(game)) return undefined;
    let durable: LocalGame;
    try { durable = saveFinished(game, error); } catch { return game; } // A readable legacy queue still uploads when storage is full.
    saved.push({ game: durable, ...(error ? { error } : {}) });
    return durable;
  };
  outbox = outbox.flatMap((game) => { const next = upgrade(game); return next ? [next] : []; });
  guestGames = guestGames.flatMap((game) => { const next = upgrade(game); return next ? [next] : []; });
  rejected = rejected.flatMap((row) => { const game = upgrade(row.game, row.error); return game ? [{ ...row, game }] : []; });
  const live = new Set(saved.map((r) => r.game.saveId));
  // An absent record was acknowledged or explicitly discarded by another window.
  outbox = outbox.filter((g) => !g.saveId || live.has(g.saveId));
  guestGames = guestGames.filter((g) => !g.saveId || live.has(g.saveId));
  rejected = rejected.filter((r) => !r.game.saveId || live.has(r.game.saveId));
  for (const { game, error } of saved) {
    if (error) {
      outbox = outbox.filter((g) => g.saveId !== game.saveId);
      if (!rejected.some((r) => r.game.saveId === game.saveId)) rejected = [...rejected, { game, error }];
    } else if (game.guest) {
      if (!guestGames.some((g) => g.saveId === game.saveId)) guestGames = [...guestGames, game];
    } else if (!outbox.some((g) => g.saveId === game.saveId)) outbox = [...outbox, game];
  }
  if (current && hasEnded(current)) {
    current = null;
    derived = null;
  }
  if (waitingGuest && hasEnded(waitingGuest)) waitingGuest = null;
}
/**
 * The game being handed to another phone (share.tsx, handOver): it's uploaded and then let go,
 * and nothing more is recorded on this one meanwhile.
 */
let handingOver: string | null = null;
const mayEditCurrent = () => canWriteShared() && (!current || !hasEnded(current));
/** This device may record a change to its game now. */
const mayRecord = () => mayEditCurrent() && (!current || current.setup.id !== handingOver);

function persist() {
  if (canWriteShared()) {
    if (current && hasEnded(current)) { current = null; derived = null; }
    // Queue first: a finish must be durable before its active-game slot is cleared.
    try {
      // A legacy result may still lack a journal at quota. Keep its old outbox copy
      // until a rejection copy can be persisted, rather than clearing it first.
      write(REJECTED, rejected);
      write(OUTBOX, outbox);
      write(DELETES, deletes);
      write(GUEST_GAMES, guestGames);
      write(currentKey(), current);
    } catch {
      // Durable result records remain authoritative; a full auxiliary queue must not
      // prevent uploading them or permanently wedge the in-flight sync promise.
      syncState = { ...syncState, error: "This phone couldn't keep the latest changes. Keep Yama open and try again." };
    }
  }
}

function emit() {
  persist();
  for (const l of listeners) l();
}

function setCurrent(next: LocalGame | null): boolean {
  if (!canWriteShared() || (next && hasEnded(next))) return false;
  current = next;
  derived = next ? replay(next.setup, next.log) : null;
  // Saved now; anything already showing hears about it in a moment, not in the middle of a
  // render or commit.
  persist();
  queueMicrotask(emit);
  return true;
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
  reloadQueues();
  // A game kept under the old shared key comes along only for its own account (or one from before
  // games recorded theirs); another account's stays where it is until that account signs in.
  if (!guest && user && !current) {
    const old = read<LocalGame | null>(CURRENT, null);
    if (old && (!old.owner || old.owner === user) && !hasEnded(old) && !hasEnded({ ...old, owner: old.owner ?? user }) && sameStoredSnapshot()) {
      current = { ...old, owner: old.owner ?? user };
      write(currentKey(), current);
      localStorage.removeItem(CURRENT);
    }
  }
  readOnlyGame = pendingHostLock(current);
  derived = current ? replay(current.setup, current.log) : null;
  waitingGuest = slot !== "guest" ? readWaitingGuest() : null;
  // Pages that render from now on read the new game; anything already showing hears about it
  // in a moment, before the screen updates.
  queueMicrotask(emit);
}

/** The game going without an account, as the signed-in account sees it: waiting to be saved. */
// The device starts on the account's slot, so whatever waits in the guest slot is known from the start.
function readWaitingGuest(): LocalGame | null {
  const game = read<LocalGame | null>(GUEST_CURRENT, null);
  return game && !hasEnded(game) ? game : null;
}
let waitingGuest: LocalGame | null = readWaitingGuest();
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
  if (!canWriteShared()) return;
  // Saved by the account signed in now: theirs, uploaded only while they're signed in here.
  const owner = signedInUser() ?? undefined;
  const adoptCurrent = (game: LocalGame) => {
    const { guest: _, ...g } = game;
    const next = { ...g, owner };
    if (!canWriteShared() || hasEnded(next)) return false;
    // The account copy must be durable before removing the guest's active slot.
    write(currentKey(), next);
    current = next;
    derived = replay(next.setup, next.log);
    return true;
  };
  try {
    const remaining: LocalGame[] = [];
    for (const game of guestGames) {
      try {
        const { guest: _, ...g } = game;
        const adopted = saveFinished({ ...g, owner });
        acknowledgeFinished(game, true);
        outbox = [...outbox, adopted];
      } catch {
        remaining.push(game);
        syncState = { ...syncState, error: "Some games are still on this device. Keep Yama open and try saving them again." };
      }
    }
    guestGames = remaining;
    // A guest counter left in the account's own slot by an older version stays there.
    if (current?.guest) adoptCurrent(current);
    if (slot !== "guest" && waitingGuest && !current && adoptCurrent(waitingGuest)) {
      localStorage.removeItem(GUEST_CURRENT);
      observed.set(GUEST_CURRENT, null);
      waitingGuest = null;
    }
  } catch {
    syncState = { ...syncState, error: "Some games are still on this device. Keep Yama open and try saving them again." };
  } finally {
    // A later adoption can hit quota after an earlier one succeeded. Reconcile those
    // durable account copies and upload them now; keep the remaining guest records.
    restoreFinished();
    emit();
    void settle();
  }
}

/** Throw away the games counted here without an account, the one going included. */
export function dropGuestGames() {
  if (!canWriteShared()) return;
  for (const game of guestGames) acknowledgeFinished(game, true);
  guestGames = [];
  if (slot !== "guest" && waitingGuest) {
    waitingGuest = null;
    localStorage.removeItem(GUEST_CURRENT);
    observed.set(GUEST_CURRENT, null);
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

/** Deletes Yama refused for good (anything but "not found"): its copy of the game is still there. */
const refusedDeletes = new Map<string, string>();

/**
 * Delete a table game this account recorded: every copy on this device now, and Yama's once the
 * server answers (queued while offline). Resolves true once Yama has removed it and false while
 * the delete waits for a connection. It throws when nothing was deleted (another window on this
 * device runs the table, so this one may not write) and when Yama refused, so the page never
 * reports a delete that didn't happen.
 */
export async function deleteGame(gameId: string): Promise<boolean> {
  if (!canWriteShared()) {
    throw new Error("This game wasn't deleted: another window on this device is running the table. Close that window or reload this page, then try again.");
  }
  refusedDeletes.delete(gameId);
  for (const { game } of finishedRecords()) {
    if (game.setup.id === gameId && !game.guest && mineGame(game)) acknowledgeFinished(game, true);
  }
  if (current?.setup.id === gameId) {
    for (const l of endListeners) l(current);
    forgetPrompts(gameId);
    current = null;
    derived = null;
  }
  outbox = outbox.filter((g) => g.setup.id !== gameId);
  rejected = rejected.filter((r) => r.game.setup.id !== gameId);
  if (!deletes.some((d) => d.id === gameId)) deletes = [...deletes, { id: gameId, owner: signedInUser() }];
  emit();
  await settle();
  const refused = refusedDeletes.get(gameId);
  if (refused !== undefined) {
    refusedDeletes.delete(gameId);
    throw new Error(`Yama didn't delete this game: ${refused}`);
  }
  return !deletes.some((d) => d.id === gameId);
}

/** Sync, then once more if a run that was already going missed something queued since. */
async function settle() {
  await sync();
  if (deletes.some(mine) || current || outbox.length) await sync();
}

/** A logged game was queued while offline: try to send it now, and again on the usual triggers. */
export function syncLogged(): Promise<void> {
  return sync();
}

async function pushDeletes() {
  // Another account's deletes wait until it signs in here again.
  for (const { id } of deletes.filter(mine)) {
    if (!canWriteShared()) return;
    try {
      await api(`/api/games/${id}`, { method: "DELETE" });
    } catch (e) {
      // Not found: the server never had it (or it's gone already), which is what we wanted.
      // Any other refusal is final too (asking again gets the same answer), but the game is
      // still on Yama: whoever asked for the delete is told (deleteGame).
      if (!isPermanent(e)) throw e;
      if (!(e instanceof ApiError && e.status === 404)) refusedDeletes.set(id, errorMessage(e));
    }
    deletes = deletes.filter((d) => d.id !== id);
    emit();
    gamesChanged();
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

/**
 * The table as people see it, to tell whether an event changed anything: a counter at 0 reads the
 * same as one never touched.
 */
function tableKey(s: TableState): string {
  const kept = (m: Partial<Record<string, number>>) => Object.entries(m).filter(([, v]) => v).sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify({ ...s, setup: null, players: s.players.map((p) => ({ ...p, commanderDamage: kept(p.commanderDamage), counters: kept(p.counters) })) });
}

/** A tap on minus at 0, the monarch picked again: the event leaves the table exactly as it was. */
function changesNothing(before: TableState, event: TableEvent): boolean {
  const after = apply(before, event);
  return after === before || tableKey(after) === tableKey(before);
}

/**
 * Events that say something the table's totals don't hold (that first was rolled for, what a
 * seat or player was before): they're logged even when the table looks the same after them.
 */
const SAYS_MORE = new Set<TableEvent["type"]>(["set_first", "seat", "player", "finish"]);

/** The pairs whose two events are both still in the log: a seq freed by a drop may be used again. */
function pairsIn(pairs: LocalGame["cancelled"], log: LoggedEvent[]): LocalGame["cancelled"] {
  if (!pairs?.length) return undefined;
  const seqs = new Set(log.map((l) => l.seq));
  const kept = pairs.filter((c) => seqs.has(c.by) && seqs.has(c.of));
  return kept.length ? kept : undefined;
}

export function dispatch(event: TableEvent) {
  if (!current || !mayRecord()) return;
  // Nothing to log, and nothing for Undo to find later.
  if (!SAYS_MORE.has(event.type) && changesNothing(replay(current.setup, current.log), event)) return;
  const last = current.log[current.log.length - 1];
  // A take-back stays the one event it is: a tap right after it starts a new event rather than
  // merging into it, so Undo can tell the two apart (and the tap can't cancel it out of the log).
  const tookBack = !!last && !!current.cancelled?.some((c) => c.by === last.seq);
  const log = record(current.log, event, new Date(), tookBack ? last.seq : fixedThrough(current));
  setCurrent({ ...current, log, redo: [], cancelled: pairsIn(current.cancelled, log) });
}

/**
 * The event that takes `event` back, read against the table just before it: what it changed is
 * changed back (totals stop at 0, so that isn't always what was tapped). Null when no event can
 * (a passed turn, a change of player or commander) and when it changed nothing.
 */
export function inverseOf(before: TableState, event: TableEvent): TableEvent | null {
  const after = apply(before, event);
  const was = before.players.find((p) => "seat" in event && p.seat === event.seat);
  const now = after.players.find((p) => "seat" in event && p.seat === event.seat);
  switch (event.type) {
    case "life":
      return was && event.delta ? { type: "life", seat: event.seat, delta: -event.delta } : null;
    case "poison": {
      const delta = (was?.poison ?? 0) - (now?.poison ?? 0);
      return delta ? { type: "poison", seat: event.seat, delta } : null;
    }
    case "commander_damage": {
      // The life it took comes back with it.
      const delta = (was?.commanderDamage[event.source] ?? 0) - (now?.commanderDamage[event.source] ?? 0);
      return delta ? { type: "commander_damage", seat: event.seat, source: event.source, delta } : null;
    }
    case "counter": {
      const delta = (was?.counters[event.counter] ?? 0) - (now?.counters[event.counter] ?? 0);
      return delta ? { type: "counter", seat: event.seat, counter: event.counter, delta } : null;
    }
    case "commander_cast": {
      const delta = event.partner ? (was?.partnerCasts ?? 0) - (now?.partnerCasts ?? 0) : (was?.commanderCasts ?? 0) - (now?.commanderCasts ?? 0);
      return delta ? { type: "commander_cast", seat: event.seat, ...(event.partner ? { partner: true } : {}), delta } : null;
    }
    case "monarch":
      return before.monarch === after.monarch ? null : { type: "monarch", seat: before.monarch };
    case "initiative":
      return before.initiative === after.initiative ? null : { type: "initiative", seat: before.initiative };
    case "day_night":
      return before.dayNight === after.dayNight ? null : { type: "day_night", value: before.dayNight };
    case "swap_places":
      return seatOrder(before).join() === seatOrder(after).join() ? null : { type: "swap_places", a: event.a, b: event.b };
    case "eliminate":
      // Someone already out (a knockout given to another player) can't be put back as they were.
      return was && !was.eliminated ? { type: "revive", seat: event.seat } : null;
    default:
      return null;
  }
}

type UndoStep =
  /** Not sent yet: the log is cut back to just before it (index `at`). */
  | { drop: LoggedEvent; at: number }
  | { of: LoggedEvent; inverse: TableEvent }
  /** `saved`: the server has it; otherwise it is only held for an upload that hasn't landed. */
  | { stuck: TableEvent["type"]; saved: boolean };

/** Undo's next step for the game as it is now: asked several times a render, worked out once. */
let stepFor: { game: LocalGame; step: UndoStep | null } | null = null;

/**
 * What Undo does next: it acts on the newest event that still stands. Walking back from the end,
 * it steps over every event Undo has already taken back and the event that took it back (the
 * `cancelled` pairs), and over events that changed nothing (there is nothing to undo in them).
 * An event the server doesn't have yet is simply dropped. One it has, or that is on its way, is
 * history, so it is taken back by recording its opposite as a new event, the way a tap on + takes
 * back a tap on −: nothing already sent changes. `stuck` names an event nothing can take back.
 */
function undoStep(g: LocalGame): UndoStep | null {
  if (stepFor?.game === g) return stepFor.step;
  const paired = new Set((g.cancelled ?? []).flatMap((c) => [c.by, c.of]));
  let step: UndoStep | null = null;
  for (let at = g.log.length - 1; at >= 0 && !step; at--) {
    const target = g.log[at]!;
    if (paired.has(target.seq)) continue;
    const before = replay(g.setup, g.log.slice(0, at));
    if (changesNothing(before, target.event)) continue;
    if (target.seq > fixedThrough(g)) step = { drop: target, at };
    else {
      const inverse = inverseOf(before, target.event);
      step = inverse ? { of: target, inverse } : { stuck: target.event.type, saved: target.seq <= g.syncedThrough };
    }
  }
  stepFor = { game: g, step };
  return step;
}

export function canUndo() {
  if (!current || !mayRecord()) return false;
  const step = undoStep(current);
  return !!step && !("stuck" in step);
}

const STUCK: Partial<Record<TableEvent["type"], string>> = {
  pass_turn: "passing the turn",
  set_first: "choosing who goes first",
  seat: "a change of deck or commander",
  player: "a change of player",
  revive: "putting a player back in the game",
  eliminate: "a knockout",
};

/** Why Undo is off although something has happened, in a sentence for under the button. Null when it's on, or nothing has happened. */
export function undoStuck(): string | null {
  if (!current || !mayRecord()) return null;
  const step = undoStep(current);
  if (!step || !("stuck" in step)) return null;
  const what = STUCK[step.stuck] ?? "the last change";
  // Held for an upload that hasn't landed (no signal, say): Yama doesn't have it, so don't say it does.
  return step.saved
    ? `Undo stops here: ${what} can't be undone once it's saved to Yama.`
    : `Undo stops here: ${what} is already on its way to Yama, so it can't be undone.`;
}

export function undo() {
  if (!current || !mayRecord()) return;
  const step = undoStep(current);
  if (!step || "stuck" in step) return;
  if ("drop" in step) {
    // Anything after it changed nothing and hasn't been sent either: it goes too, or it could
    // start to mean something once the event before it is gone.
    const log = current.log.slice(0, step.at);
    setCurrent({ ...current, log, redo: [...current.redo, step.drop], cancelled: pairsIn(current.cancelled, log) });
    return;
  }
  // Appended as it is, never merged into the event before it: each take-back stays one event.
  const seq = current.log[current.log.length - 1]!.seq + 1;
  setCurrent({
    ...current,
    log: [...current.log, { seq, at: new Date().toISOString(), event: step.inverse }],
    redo: [...current.redo, { ...step.of, by: seq }],
    cancelled: [...(current.cancelled ?? []), { by: seq, of: step.of.seq }],
  });
}

export function canRedo() {
  return !!current && mayRecord() && current.redo.length > 0;
}

export function redo() {
  if (!current || !canRedo()) return;
  const { by, ...next } = current.redo[current.redo.length - 1]!;
  const rest = current.redo.slice(0, -1);
  const last = current.log[current.log.length - 1];
  // Taken back by an event that hasn't been sent yet: dropping that event brings it back, and
  // the pair goes with it.
  if (by !== undefined && last?.seq === by && by > fixedThrough(current) && current.cancelled?.some((c) => c.by === by && c.of === next.seq)) {
    const log = current.log.slice(0, -1);
    setCurrent({ ...current, log, redo: rest, cancelled: pairsIn(current.cancelled, log) });
    return;
  }
  // Recorded again as a new event, never dated before the one it follows. If a sent take-back
  // stands against the first recording, that pair stays as it is (both remain history Undo steps
  // over) and this new event is the one a later Undo reaches. Whatever is still undone stays in
  // the redo list, and comes back the same way.
  const at = last && Date.parse(next.at) < Date.parse(last.at) ? new Date().toISOString() : next.at;
  setCurrent({ ...current, log: [...current.log, { seq: (last?.seq ?? 0) + 1, at, event: next.event }], redo: rest });
}

/**
 * End the game and queue it for upload. `details` (how it was won, fun ratings) ride on the
 * finish event and `firstSeat`, if the table only says at the end, goes in as a set_first event
 * just before it, so the log stays the one record the server copies.
 */
export function finishGame(winnerSeat: number | null, details: FinishDetails = {}, firstSeat: number | null = null) {
  if (!current || !mayRecord()) return;
  const now = new Date();
  let log = current.log;
  if (firstSeat !== null && replay(current.setup, log).firstSeat !== firstSeat) {
    log = record(log, { type: "set_first", seat: firstSeat }, now, Infinity);
  }
  const fun = details.fun?.length ? details.fun : undefined;
  const winCondition = winnerSeat === null ? undefined : details.winCondition;
  const note = details.note?.trim();
  log = record(log, { type: "finish", winnerSeat, endedAt: now.toISOString(), ...(winCondition ? { winCondition } : {}), ...(fun ? { fun } : {}), ...(note ? { note } : {}) }, now, Infinity);
  // A finished game uploads whole: drop the in-flight mark so nothing is held back. One counted
  // without an account waits on this phone instead.
  // Nothing is undone in a finished game: its record keeps no pairs.
  const saved = saveFinished({ ...current, log, cancelled: undefined, frozenThrough: undefined });
  if (current.guest) guestGames = [...guestGames, saved];
  else outbox = [...outbox, saved];
  for (const l of endListeners) l(saved);
  forgetPrompts(saved.setup.id);
  setCurrent(null);
  // If an earlier upload was already running, drain this newly queued result when it ends.
  void settle();
}

/**
 * Carry on, on this device, with a game this account started elsewhere (the phone died, or the
 * laptop takes over). Everything the server has is history: Undo can only take it back with a
 * new event (undoStep). It starts with nothing marked as taken back: which events cancel which
 * is known only on the device that undid them.
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

/** What to ask before discardGame (components/confirm's `ask`). */
export const DISCARD_GAME = { title: "Throw this game away?", body: "It won't count, and it's deleted from Yama.", confirm: "Throw it away", danger: true } as const;

/** Throw away the game on this device. If it already reached Yama, it's deleted there too. */
export function discardGame() {
  if (!current || !mayRecord()) return;
  // Never uploaded: it only has to go from this phone.
  if (current.guest) {
    forgetPrompts(current.setup.id);
    return setCurrent(null);
  }
  void deleteGame(current.setup.id).catch((e) => {
    syncState = { ...syncState, error: errorMessage(e) };
    emit();
  });
}

/** The seat's label on the server: its commander, and its partner, so another device can rebuild the pair. */
export function deckLabel(p: { deckLabel?: string; commanderName?: string; partnerName?: string }): string | null {
  if (p.partnerName && p.commanderName && (!p.deckLabel || p.deckLabel === p.commanderName)) return `${p.commanderName} and ${p.partnerName}`;
  return p.deckLabel ?? p.commanderName ?? null;
}

async function pushGame(g: LocalGame): Promise<boolean> {
  const s = g.setup;
  // A seat that changed commanders or players mid-game uploads the one it has now.
  const now = new Map(replay(s, g.log).players.map((p) => [p.seat, p]));
  const upTo = g.frozenThrough ?? Infinity;
  const fresh = g.log.filter((l) => l.seq > g.syncedThrough && l.seq <= upTo);
  const finish = toServerFinish(s, g.log);
  const saved = await api<{ status?: string }>("/api/games", {
    method: "POST",
    json: {
      id: s.id,
      playgroup_id: s.playgroupId ?? null,
      format: s.format,
      starting_life: s.startingLife,
      started_at: s.startedAt,
      // One game of a match: which match, which game of it, and how long it runs.
      // The score before this game rides along: seats are renumbered between games, and names change.
      ...(s.match ? { match: { id: s.match.id, game: s.match.game, best_of: s.match.bestOf, wins: s.players.map((_, seat) => s.match!.wins[seat] ?? 0), draws: s.match.draws } } : {}),
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
          // Outside Commander, the deck colors the seat started with (later changes are its "seat" events).
          colors: s.format !== "commander" && p.colorIdentity ? p.colorIdentity : null,
        };
      }),
      // The events ride along, so a seat's new player arrives with the "player" event that
      // explains it (Yama refuses different players without one).
      events: toServerEvents(fresh),
      // Result, current commanders and final events commit in one server transaction.
      finish,
    },
  });
  posted.add(s.id);
  return saved.status === "finished";
}

/**
 * The app's query cache, once it has been handed over (refreshOnSave). Uploads happen here,
 * outside any page, so the pages that list games can't know one landed unless the store says so.
 */
let queries: { invalidateQueries: (filters: { queryKey: string[] }) => unknown } | null = null;

/**
 * Give the store the app's query client: when a finished game reaches Yama, or a deleted one
 * leaves it, the lists of games, the playgroup's stats and each deck's results read again.
 * Without this a game just saved was missing from Recent games (or still "Still going") until
 * the page was loaded afresh.
 */
export function refreshOnSave(client: { invalidateQueries: (filters: { queryKey: string[] }) => unknown }) {
  queries = client;
}

function gamesChanged() {
  for (const key of ["games", "stats", "deck-results"]) void queries?.invalidateQueries({ queryKey: [key] });
}

let inflight: Promise<void> | null = null;

/** Games this device has seen the server accept (the shared-table relay needs the game there first). */
const posted = new Set<string>();
export function isPosted(gameId: string): boolean {
  return posted.has(gameId);
}

export function sync(): Promise<void> {
  restoreFinished();
  // An admin viewing as someone sends nothing: games recorded on this device wait until the view
  // ends (the server would refuse them, and they'd be set aside as rejected).
  if (isViewing() || !canWriteShared()) return Promise.resolve();
  // Nobody is signed in: there's no account to send anything to.
  if (isGuest()) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    await Promise.resolve(); // Assign inflight before any synchronous error/finally can reset it.
    try {
      syncState = { ...syncState, syncing: true };
      emit();
      // Finished games first: they're complete and the most valuable.
      // Another account's games wait until it signs in here again.
      for (let g = outbox.find(mineGame); g && canWriteShared(); g = outbox.find(mineGame)) {
        try {
          await pushGame(g);
          acknowledgeFinished(g);
          gamesChanged();
        } catch (e) {
          if (!isPermanent(e)) throw e;
          // Set it aside so the games behind it still upload; one deleted meanwhile, or deleted
          // on another device (410), is simply gone.
          if (!deletes.some((d) => d.id === g.setup.id) && !isGone(e)) {
            const error = e instanceof Error ? e.message : String(e);
            rejectFinished(g, error);
            rejected = [...rejected, { game: g, error }];
          } else acknowledgeFinished(g, true);
        }
        // By identity: a delete while this one uploaded may have changed the list.
        outbox = outbox.filter((o) => o !== g);
        emit();
      }
      if (!canWriteShared()) return;
      // Games logged while Yama couldn't be reached ride the same uploads (loggedQueue.ts). One
      // that can't go up is the logged queue's to report (it never throws): it doesn't hold back
      // the game on the table or change what the table says about its own saving.
      await flushLogged();
      await pushDeletes();
      if (current && mayEditCurrent() && !current.guest && mineGame(current)) {
        // Freeze what we're about to send: later taps start new events instead of changing these.
        // A counter still being tapped waits for the next sync, so its burst stays one event.
        const through = Math.max(settledThrough(current.log, new Date()), fixedThrough(current));
        current = { ...current, frozenThrough: Math.max(current.frozenThrough ?? 0, through) };
        emit();
        if (!current) return;
        const snapshot = current;
        const snapshotSlot = slot;
        const stillCurrent = () => slot === snapshotSlot && current?.setup.id === snapshot.setup.id && current.owner === snapshot.owner && mineGame(snapshot);
        let finished = false;
        try {
          finished = await pushGame(snapshot);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && stillCurrent() && !snapshot.log.some((entry) => entry.seq > snapshot.syncedThrough)) {
            // Old commanders may conflict before POST can return the finished status.
            // Confirm ownership and status; never discard unconfirmed local events.
            const saved = await api<{ status: string; can_delete: boolean }>(`/api/games/${snapshot.setup.id}`);
            if (saved.status !== "finished" || !saved.can_delete) throw e;
            finished = true;
          } else if (!isGone(e)) throw e;
          // Whoever recorded it deleted it on another device: it goes from this one too.
          else if (stillCurrent()) {
            forgetPrompts(snapshot.setup.id);
            current = null;
            derived = null;
          }
        }
        if (finished && stillCurrent()) {
          // A tap still settling wasn't in this upload: keep it here rather than retire the game.
          if (current!.log !== snapshot.log || snapshot.log.some((l) => l.seq > through)) throw new Error("This game has finished on Yama. Your newer changes are kept on this device; check Game history before continuing.");
          current = null;
          derived = null;
          emit(); // Free the obsolete counter before retaining its small ended marker.
          rememberServerFinish(snapshot);
          gamesChanged();
        }
        // Only advance if the game is still the same one (it may have been finished meanwhile).
        if (current && stillCurrent()) {
          // Everything frozen went up, a tap that was still settling included.
          current = { ...current, syncedThrough: Math.max(current.syncedThrough, through, snapshot.frozenThrough ?? 0) };
        }
      }
      syncState = { syncing: false, error: null, lastSyncedAt: new Date().toISOString() };
    } catch (e) {
      // Yama didn't answer (fetch's own error): the games are safe here and upload on their own later.
      syncState = { ...syncState, syncing: false, error: unanswered(e) ? "Yama didn't answer. The games stay on this device, and it tries again on its own." : errorMessage(e) };
    } finally {
      inflight = null;
      syncState = { ...syncState, syncing: false };
      emit();
    }
  })();
  return inflight;
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void sync());
  window.addEventListener("storage", (event) => {
    const markerKey = current?.owner ? `yama.table.hosting.${current.owner}` : null;
    const markerChanged = event.key === null || (!!markerKey && event.key === markerKey);
    const finishedChanged = isFinishedStorageKey(event.key);
    if (!markerChanged && !finishedChanged && !storageKeys().includes(event.key ?? "")) return;
    reloadQueues();
    if (event.key === null || event.key === currentKey() || finishedChanged) {
      current = read<LocalGame | null>(currentKey(), null);
      derived = current ? replay(current.setup, current.log) : null;
      restoreFinished();
    }
    if (event.key === null || event.key === GUEST_CURRENT) waitingGuest = slot !== "guest" ? readWaitingGuest() : null;
    if (markerChanged) {
      const marked = pendingHostLock(current);
      setSharedReadOnly(marked && marked !== sharedHost ? marked : null);
    }
    // Notify without writing it back: storage messages must not create a tab-to-tab loop.
    for (const l of listeners) l();
  });
  // A game or finished games left on this device from before (a reload, a phone that was off)
  // go up straight away, so sharing and other devices can find them.
  restoreFinished();
  if (current || outbox.length || deletes.some(mine) || hasLoggedToSend()) queueMicrotask(() => void sync());
  setInterval(() => {
    if (navigator.onLine && (current || outbox.length || deletes.some(mine) || hasLoggedToSend())) void sync();
  }, 20_000);
}

/** For the shared-table host connection: current game and change notifications. */
export function getGame(): LocalGame | null {
  return current;
}
export { subscribe as subscribeTable };

/** Explicit finish/discard, apart from a change of account or active game slot. */
const endListeners = new Set<(game: LocalGame) => void>();
export function subscribeTableEnd(listener: (game: LocalGame) => void) {
  endListeners.add(listener);
  return () => { endListeners.delete(listener); };
}

/**
 * Before handing `gameId` to another phone: stop recording, and upload every event it has, the
 * last tap too. True once Yama has all of it; the other phone carries on from exactly this log.
 * False (and recording again) when it isn't this device's game to hand over or Yama can't be
 * reached.
 */
export async function sealForHandOver(gameId: string): Promise<LocalGame | null> {
  if (!current || current.setup.id !== gameId || !mayRecord() || current.guest || !mineGame(current) || isGuest() || isViewing()) return null;
  handingOver = gameId;
  const last = current.log[current.log.length - 1]?.seq ?? 0;
  current = { ...current, frozenThrough: Math.max(current.frozenThrough ?? 0, last) };
  emit();
  // An upload already going may have started before the freeze: then one more sends the rest.
  for (let i = 0; i < 3 && current?.setup.id === gameId && (current.syncedThrough < last || !isPosted(gameId)); i++) {
    await sync();
    if (syncState.error) break;
  }
  if (current?.setup.id === gameId && current.syncedThrough >= last && isPosted(gameId)) return current;
  releaseHandOver(gameId);
  return null;
}

/** The hand-over didn't happen: this device records again. */
export function releaseHandOver(gameId: string) {
  if (handingOver !== gameId) return;
  handingOver = null;
  emit();
}

/**
 * `gameId` went to another phone: it leaves this device without being finished or deleted
 * (Yama keeps it, written by that phone now).
 */
export function letGo(gameId: string) {
  if (handingOver === gameId) handingOver = null;
  if (current?.setup.id !== gameId || !canWriteShared()) return;
  forgetPrompts(gameId);
  current = null;
  derived = null;
  emit();
}

/** Flush this document's admitted writes before pausing it for a sharing claim. */
export function prepareSharing() { emit(); }

/** Revalidate the selected game under the granted host lock, before publishing any state. */
export function refreshSharedGame(gameId: string): boolean {
  const raw = localStorage.getItem(currentKey());
  let saved: LocalGame | null;
  try { saved = raw ? JSON.parse(raw) as LocalGame : null; } catch { return false; }
  if (!saved || current?.setup.id !== gameId || saved.setup.id !== gameId || saved.owner !== current.owner || !mineGame(saved)) return false;
  current = saved;
  observed.set(currentKey(), raw);
  derived = replay(saved.setup, saved.log);
  reloadQueues();
  queueMicrotask(() => { for (const l of listeners) l(); });
  return true;
}
