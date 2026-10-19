import type { DeckVersionRow } from "../api";

/**
 * The version of a deck in use on a day (YYYY-MM-DD, local): the newest one saved by the end of
 * that day. Logging an old game then credits the list that was actually played, not today's.
 * null if the deck had no saved version yet: the game keeps its commander and label but isn't
 * credited to a list saved after it was played.
 */
export function versionOn(versions: DeckVersionRow[], day: string): string | null {
  const end = new Date(`${day}T23:59:59.999`).getTime();
  const before = versions.filter((v) => Date.parse(v.created_at) <= end).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return before[before.length - 1]?.id ?? null;
}

/** Today (or `d`) as YYYY-MM-DD in the device's own time zone, not UTC. */
export function localDay(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
