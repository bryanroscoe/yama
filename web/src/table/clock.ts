// The table's clock: a per-device choice, off unless someone turns it on. With it on, a strip
// under the table's top bar shows how long the game has run and, where turns are counted, how
// long this turn has. The times come from the game's own record (packages/core/src/table.ts, clockAt), so
// nothing else is stored and a phone following a shared table can show them too.

import type { LoggedEvent } from "@yama/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const KEY = "yama.table.clock";
function stored(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}
let clockOn = stored();
const listeners = new Set<() => void>();

export function useTableClock(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => clockOn,
    () => false,
  );
}

export function setTableClock(on: boolean) {
  clockOn = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Private browsing: the choice lasts for this visit.
  }
  for (const l of listeners) l();
}

/** The time now, again every second while `ticking` (a finished game's clock stands still). */
export function useNow(ticking: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!ticking) return;
    setNow(new Date());
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, [ticking]);
  return now;
}

/** What a following phone has learned about the host's clock: the newest event it saw, and how far ahead of this phone's clock the host's was when it arrived. */
export interface HostClock {
  seq: number;
  at: string;
  offset: number;
}

/**
 * The host's clock against this phone's, relearned when a newer event arrives: an event is
 * stamped by the host and reaches a follower within a moment, so its time less this phone's time
 * is how far the host's clock is ahead. Only a newer event teaches anything: the log this phone
 * first loads may end in an old event, and an undo on the host brings an older one back to the end.
 */
export function learnHostClock(known: HostClock | null, last: Pick<LoggedEvent, "seq" | "at"> | undefined, nowMs: number): HostClock | null {
  if (!last) return known;
  // The first log seen: remember where it ends, and trust this phone's clock until news comes.
  if (!known) return { seq: last.seq, at: last.at, offset: 0 };
  const newer = last.seq > known.seq || (last.seq === known.seq && last.at > known.at);
  if (!newer) return known;
  const at = Date.parse(last.at);
  return { seq: last.seq, at: last.at, offset: Number.isFinite(at) ? at - nowMs : known.offset };
}

/** Milliseconds to add to this phone's clock to read the host's; 0 on the host itself. */
export function useHostOffset(log: LoggedEvent[], following: boolean): number {
  const known = useRef<HostClock | null>(null);
  const [offset, setOffset] = useState(0);
  const last = log[log.length - 1];
  const key = last ? `${last.seq}:${last.at}` : "";
  useEffect(() => {
    if (!following) return;
    known.current = learnHostClock(known.current, last, Date.now());
    setOffset(known.current?.offset ?? 0);
    // `last` is the event `key` names.
  }, [following, key]);
  return following ? offset : 0;
}
