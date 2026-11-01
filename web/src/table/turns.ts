// Counting turns at the table: a per-device choice, off unless someone turns it on. With it off
// there's no "Pass to" button and no turn number on the middle button; who goes first is still
// asked when a game starts.

import { useSyncExternalStore } from "react";

const KEY = "yama.table.turns";
let countTurns = typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "on";
const listeners = new Set<() => void>();

export function useCountTurns(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => countTurns,
  );
}

export function setCountTurns(on: boolean) {
  countTurns = on;
  localStorage.setItem(KEY, on ? "on" : "off");
  for (const l of listeners) l();
}
