// The table's clock: a per-device choice, off unless someone turns it on. With it on, the middle
// of the table shows how long the game has run and, where turns are counted, how long this turn
// has. The times come from the game's own record (packages/core/src/table.ts, clockAt), so
// nothing else is stored and a phone following a shared table can show them too.

import { useEffect, useState, useSyncExternalStore } from "react";

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
