// Games logged with Log a game while Yama couldn't be reached. Each waits on this device and
// goes up with the table's own uploads (store.ts `sync`: on reconnecting, every 20 seconds, and
// when the app opens). Saving a logged game again under its id is harmless (the server stores
// what the form says), so a save whose answer was lost can simply be sent again.

import { useSyncExternalStore } from "react";
import { api, ApiError, errorMessage, type DeckVersionRow } from "../api";
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
   * when the game is sent: the list that was current on `day`, not whatever it is by then.
   */
  decks: Record<number, string>;
  /** The local day it was played, YYYY-MM-DD. */
  day: string;
}

export interface QueuedLog extends LoggedGame {
  /** The account that logged it: it's only sent while that account is signed in here. */
  owner: string | null;
  queuedAt: string;
  /** Yama refused it (not a connection problem): it stays here until discarded. */
  error?: string;
}

const KEY = "yama.table.logged";

function read(): QueuedLog[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? (raw as QueuedLog[]).filter((q) => typeof q?.body?.id === "string" && Array.isArray(q.body.seats)) : [];
  } catch {
    return [];
  }
}

let queue: QueuedLog[] = read();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function set(next: QueuedLog[]) {
  queue = next;
  localStorage.setItem(KEY, JSON.stringify(next));
  for (const l of listeners) l();
}

/** The account signed in on this device, as auth.tsx remembers it. */
function signedInUser(): string | null {
  try {
    return (JSON.parse(localStorage.getItem("yama.me") ?? "null") as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

/** Send one logged game: each of the logger's decks credited with its list on the day played. */
export async function sendLogged(g: LoggedGame): Promise<void> {
  const seats = await Promise.all(
    g.body.seats.map(async (s) => {
      const deck = g.decks[s.seat];
      return deck ? { ...s, deck_version_id: versionOn(await api<DeckVersionRow[]>(`/api/decks/${deck}/versions`), g.day) } : s;
    }),
  );
  await api("/api/games", { method: "POST", json: { ...g.body, seats } });
}

/** Keep a logged game on this device until Yama can be reached. The newest save of an id wins. */
export function queueLogged(g: LoggedGame) {
  set([...queue.filter((q) => q.body.id !== g.body.id), { ...g, owner: signedInUser(), queuedAt: new Date().toISOString() }]);
}

/** Throw a waiting logged game away (one Yama refused, or one logged by mistake). */
export function discardLogged(id: string) {
  set(queue.filter((q) => q.body.id !== id));
}

/** The signed-in account's logged games still on this device: waiting, or refused. */
export function loggedWaiting(): QueuedLog[] {
  const me = signedInUser();
  return queue.filter((q) => q.owner === null || q.owner === me);
}

/** Whether a sync has anything of this account's to send. */
export const hasLoggedToSend = () => loggedWaiting().some((q) => !q.error);

let snapshot: QueuedLog[] = [];
export function useLoggedQueue(): QueuedLog[] {
  return useSyncExternalStore(subscribe, () => {
    const now = loggedWaiting();
    // The same array while nothing changed, so React doesn't re-render forever.
    if (now.length !== snapshot.length || now.some((q, i) => q !== snapshot[i])) snapshot = now;
    return snapshot;
  });
}

/** A 4xx other than auth or rate limits: sending the same game again won't help. */
const isPermanent = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);

/**
 * Send every waiting logged game of the signed-in account, oldest first. A game Yama refuses is
 * marked with why and kept (the ones behind it still go); a connection problem stops the run
 * and throws, so the caller tries again later. Returns how many were sent.
 */
export async function flushLogged(): Promise<number> {
  let sent = 0;
  for (const q of loggedWaiting().filter((q) => !q.error)) {
    try {
      await sendLogged(q);
      sent += 1;
      // By identity: the form may have queued a newer save of this game meanwhile.
      set(queue.filter((x) => x !== q));
    } catch (e) {
      if (!isPermanent(e)) throw e;
      set(queue.map((x) => (x === q ? { ...x, error: errorMessage(e) } : x)));
    }
  }
  return sent;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== KEY) return;
    queue = read();
    for (const l of listeners) l();
  });
}

/** For tests: read the queue from storage again. */
export function reloadLogged() {
  queue = read();
}
