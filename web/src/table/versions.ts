import type { DeckVersionRow } from "../api";

/**
 * The version of a deck in use on a day (YYYY-MM-DD, local): the newest one saved by the end of
 * that day, or the first version if the deck was added later. Logging an old game then credits
 * the list that was actually played, not today's.
 */
export function versionOn(versions: DeckVersionRow[], day: string): string | null {
  const end = new Date(`${day}T23:59:59.999`).getTime();
  const byAge = [...versions].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const before = byAge.filter((v) => Date.parse(v.created_at) <= end);
  return (before[before.length - 1] ?? byAge[0])?.id ?? null;
}
