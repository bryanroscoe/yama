// Only a return address, never a second copy of a host's game. Accounts and signed-out
// visitors keep separate addresses; reopening always asks the relay for the current state.
import { useSyncExternalStore } from "react";

export interface FollowedTable {
  gameId: string;
  key: string;
  relay: "edge" | "server";
  names: string;
  at: number;
}
const storageKey = (user: string | null) => `yama.table.following.${user ? `account:${user}` : "guest"}`;
const MAX_AGE = 24 * 60 * 60 * 1000;
const listeners = new Set<() => void>();
let version = 0;
const changed = () => { version++; for (const l of listeners) l(); };

export function followedTable(user: string | null): FollowedTable | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(user)) ?? "null") as FollowedTable | null;
    return value && typeof value.gameId === "string" && typeof value.key === "string" &&
      (value.relay === "edge" || value.relay === "server") && typeof value.names === "string" &&
      typeof value.at === "number" && Date.now() - value.at < MAX_AGE ? value : null;
  } catch { return null; }
}

export function rememberTable(user: string | null, table: Omit<FollowedTable, "at">) {
  const old = followedTable(user);
  if (old && old.gameId === table.gameId && old.key === table.key && old.relay === table.relay && old.names === table.names && Date.now() - old.at < 60_000) return;
  localStorage.setItem(storageKey(user), JSON.stringify({ ...table, at: Date.now() }));
  changed();
}

export function forgetTable(user: string | null, gameId: string) {
  if (followedTable(user)?.gameId !== gameId) return;
  localStorage.removeItem(storageKey(user));
  changed();
}

export function useFollowedTable(user: string | null) {
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version);
  return followedTable(user);
}
if (typeof window !== "undefined") window.addEventListener("storage", (e) => {
  if (e.key === null || e.key.startsWith("yama.table.following.")) changed();
});
