// The life counter without an account (Bryan, 2026-11-01): anyone can count a game on their own
// phone. Nothing goes to Yama: games stay on the phone until whoever signs in on it says to save
// them (table/store.ts). Sharing the table with other phones needs an account. Card search for
// the commander fields uses Yama's guest search, limited per address and off with
// YAMA_GUEST_MODE=0; without it, typed names still count.

import { useSyncExternalStore } from "react";

const KEY = "yama.guest";
let chosen = typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "1";
/** Set by App while it shows the guest app: nobody is signed in on this device. */
let active = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

/** Someone picked "Use without an account" on this device (until they sign in). */
export function useGuestChosen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => chosen,
  );
}

export function chooseGuest(on: boolean) {
  chosen = on;
  if (on) localStorage.setItem(KEY, "1");
  else localStorage.removeItem(KEY);
  emit();
}

/** Whether the app is running as a guest right now (no account signed in). */
export function isGuest(): boolean {
  return active;
}

export function setGuestActive(on: boolean) {
  active = on;
}

/** Card search for whoever is using the app: their account's, or the guest search. */
export function cardSearchPath(query: string, order?: string): string {
  return `${active ? "/api/guest/cards/search" : "/api/cards/search"}?q=${encodeURIComponent(query)}${order ? `&order=${order}` : ""}`;
}
