// Games logged with Log a game while Yama couldn't be reached. Each waits on this device and
// goes up with the table's own uploads (store.ts `sync`: on reconnecting, every 20 seconds, and
// when the app opens). Saving a logged game again under its id is harmless (the server stores
// what the form says), so a save whose answer was lost can simply be sent again.
//
// Each waiting game is its own storage entry (`yama.table.logged.<game id>`), never one shared
// list: two windows queueing different games can't overwrite each other, and the newest save of
// one game replaces the older one. Every save has a revision, so an upload that finishes after
// the game was saved again leaves the newer save waiting.

import { useSyncExternalStore } from "react";
import { api, ApiError, errorMessage, unanswered, type DeckVersionRow } from "../api";
import { keepStorage } from "../storage";
import { versionOn } from "./versions";

/** One seat of the POST /api/games body, as Log a game builds it. */
export interface LoggedSeat {
  seat: number;
  deck_version_id: string | null;
  [field: string]: unknown;
}

/** The POST /api/games body for a logged game. */
export interface LoggedBody {
  id: string;
  seats: LoggedSeat[];
  [field: string]: unknown;
}

export interface LoggedGame {
  body: LoggedBody;
  /**
   * Seat number to the deck (one of the logger's own) played in it. Its version is looked up
   * when the game is sent: the list that was current on `day`, and no later than `loggedAt`.
   */
  decks: Record<number, string>;
  /** The local day it was played, YYYY-MM-DD. */
  day: string;
  /** When Save was pressed. A deck version saved after this was never the one played. */
  loggedAt: string;
}

export interface QueuedLog extends LoggedGame {
  /** The account that logged it: it's only sent while that account is signed in here. */
  owner: string;
  /** This save of the game. An upload answers for the revision it sent, not a newer one. */
  rev: string;
  /** Why it hasn't gone up: Yama refused it, or something keeps failing. */
  error?: string;
  /** Yama refused it for good (a 4xx): it isn't sent again, only kept until it's discarded. */
  refused?: true;
}

const PREFIX = "yama.table.logged.";
const keyOf = (id: string) => PREFIX + id;

let cache: QueuedLog[] | null = null;
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const changed = () => {
  cache = null;
  for (const l of listeners) l();
};

function valid(q: unknown): q is QueuedLog {
  const g = q as QueuedLog | null;
  return !!g && typeof g.body?.id === "string" && Array.isArray(g.body.seats) && typeof g.owner === "string" && typeof g.rev === "string";
}

/** Every logged game on this device, oldest save first, read from storage. */
function all(): QueuedLog[] {
  if (cache) return cache;
  const found: QueuedLog[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(PREFIX)) continue;
    try {
      const q = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
      if (valid(q) && keyOf(q.body.id) === key) found.push(q);
    } catch {
      // Unreadable: left where it is, never deleted.
    }
  }
  cache = found.sort((a, b) => a.loggedAt.localeCompare(b.loggedAt));
  return cache;
}

/** The stored save of a game, if it is still the revision `rev`. */
function stillWaiting(id: string, rev: string): QueuedLog | null {
  try {
    const q = JSON.parse(localStorage.getItem(keyOf(id)) ?? "null") as unknown;
    return valid(q) && q.rev === rev ? q : null;
  } catch {
    return null;
  }
}

/** The account signed in on this device, as auth.tsx remembers it. */
export function signedInUser(): string | null {
  try {
    return (JSON.parse(localStorage.getItem("yama.me") ?? "null") as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/** The account changed while a game was being sent: nothing more goes up under the new one. */
export class AccountChanged extends Error {}

/**
 * Send one logged game as `owner`: each of the logger's decks credited with its list on the
 * day played (and saved no later than when the game was logged). The account is checked again
 * right before the game is posted, after the version lookups: requests go out as whoever is
 * signed in at that moment.
 */
export async function sendLogged(g: LoggedGame, owner: string | null): Promise<void> {
  const seats = await Promise.all(
    g.body.seats.map(async (s) => {
      const deck = g.decks[s.seat];
      if (!deck) return s;
      try {
        return { ...s, deck_version_id: versionOn(await api<DeckVersionRow[]>(`/api/decks/${deck}/versions`), g.day, g.loggedAt) };
      } catch (e) {
        // The deck was deleted since: the seat keeps its commander and label, credited to no list.
        if (e instanceof ApiError && e.status === 404) return { ...s, deck_version_id: null };
        throw e;
      }
    }),
  );
  if (signedInUser() !== owner) throw new AccountChanged("Another account signed in on this device.");
  await api("/api/games", { method: "POST", json: { ...g.body, seats } });
}

/**
 * Keep a logged game on this device until Yama can be reached, for the account that logged it.
 * The newest save of a game replaces the one waiting. Throws if the phone can't keep it.
 */
export function queueLogged(g: LoggedGame, owner: string) {
  keepStorage();
  const entry: QueuedLog = { ...g, owner, rev: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}` };
  try {
    localStorage.setItem(keyOf(g.body.id), JSON.stringify(entry));
  } catch {
    throw new Error("This phone's storage is full, so the game couldn't be kept here. It hasn't been saved: free some space, or try again once Yama answers.");
  } finally {
    changed();
  }
}

/** Throw a waiting logged game away, or forget one Yama now has. */
export function discardLogged(id: string) {
  localStorage.removeItem(keyOf(id));
  changed();
}

/** The signed-in account's logged games still on this device: waiting, failing or refused. */
export function loggedWaiting(): QueuedLog[] {
  const me = signedInUser();
  return all().filter((q) => q.owner === me);
}

/** Whether a sync has anything of this account's to send. */
export const hasLoggedToSend = () => loggedWaiting().some((q) => !q.refused);

let snapshot: QueuedLog[] = [];
export function useLoggedQueue(): QueuedLog[] {
  return useSyncExternalStore(subscribe, () => {
    const now = loggedWaiting();
    // The same array while nothing changed, so React doesn't re-render forever.
    if (now.length !== snapshot.length || now.some((q, i) => q.rev !== snapshot[i]!.rev || q.error !== snapshot[i]!.error)) snapshot = now;
    return snapshot;
  });
}

/** Yama can't be reached or is having trouble: the same game may well go through later. */
export function worthKeeping(e: unknown): boolean {
  return unanswered(e) || (e instanceof ApiError && (e.status >= 500 || e.status === 408 || e.status === 429));
}

/** Record why a save hasn't gone up, if it is still the save that was sent. */
function mark(q: QueuedLog, error: string, refused: boolean) {
  const now = stillWaiting(q.body.id, q.rev);
  if (!now) return;
  const { refused: _, ...rest } = now;
  try {
    localStorage.setItem(keyOf(q.body.id), JSON.stringify({ ...rest, error, ...(refused ? { refused: true as const } : {}) }));
  } catch {
    // The game itself is still stored; only the reason couldn't be.
  }
  changed();
}

/**
 * Send every waiting logged game of the signed-in account, oldest first. Returns how many went.
 * - Sent: forgotten, unless the game was saved again meanwhile (the newer save still waits).
 * - Yama doesn't answer, the session has expired, or the account changed: the run stops and
 *   everything waits for the next one.
 * - Yama says the game was deleted on another device (410): it's gone from here too.
 * - Yama refuses it (another 4xx): kept with the reason and not sent again.
 * - Anything else (a server error, a rate limit): kept with the reason, tried again next time,
 *   and the games behind it still go.
 * It never throws: a logged game that can't go up is this queue's to report, not the table's.
 */
export async function flushLogged(): Promise<number> {
  const me = signedInUser();
  let sent = 0;
  for (const q of loggedWaiting().filter((x) => !x.refused)) {
    // Saved again, sent by another window or discarded since this run began.
    if (!stillWaiting(q.body.id, q.rev)) continue;
    try {
      await sendLogged(q, me);
      sent += 1;
      if (stillWaiting(q.body.id, q.rev)) discardLogged(q.body.id);
    } catch (e) {
      if (e instanceof AccountChanged || unanswered(e) || (e instanceof ApiError && e.status === 401)) break;
      if (e instanceof ApiError && e.status === 410) {
        if (stillWaiting(q.body.id, q.rev)) discardLogged(q.body.id);
        continue;
      }
      mark(q, errorMessage(e), !worthKeeping(e));
    }
  }
  return sent;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key.startsWith(PREFIX) || event.key === "yama.me") changed();
  });
}

/** For tests: forget what was read from storage. */
export function reloadLogged() {
  changed();
}
