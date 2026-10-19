// Pure helpers for the deck page's Commander Spellbook check: what the status line says, how
// often to ask again, and how its dates read. Kept apart from the components so they're tested
// without a browser.

import type { DeckCheck } from "../api";

/** What Yama sends where, said wherever a check can start. */
export const SENDS_LIST = "Yama sends this deck's card list (commander and main deck) to Commander Spellbook after each save, for the estimate.";

/** A moment (RFC 3339, UTC) as the reader's local calendar day: "Oct 18, 2026". Unlike `day()`
 *  for date-only values, a check at 9 pm Central stays on the day it happened. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A moment as a local time, with the day when it isn't today: "9:30 PM" or "Oct 20, 9:30 AM". */
export function localTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = d.toDateString() === now.toDateString();
  return d.toLocaleString(undefined, today ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The estimate's value: its bracket, "banned" only for Spellbook's B tag, and "unknown" for a
 *  tag Yama doesn't know yet (never mistaken for banned). */
export function estimateValue(tag: string, bracket: number | null): { value: string; sub: (label: string) => string } {
  if (bracket != null) return { value: String(bracket), sub: (label) => `Commander Spellbook's "${label}"` };
  if (tag === "B") return { value: "Banned", sub: () => "A card is banned in Commander" };
  return { value: "Unknown", sub: () => `Commander Spellbook answered with a tag Yama doesn't know yet ("${tag}")` };
}

/** How soon to ask about a check again: every few seconds while a try is due or running, then
 *  just after a failed try's pause ends (at most every 15 minutes), else not at all. */
export function pollAfter(c: DeckCheck | undefined, now = Date.now()): number | false {
  if (!c) return false;
  if (c.pending) return 3000;
  if (c.retrying && c.next_try_at) {
    const wait = new Date(c.next_try_at).getTime() - now + 2000;
    return Number.isNaN(wait) ? 60_000 : Math.min(Math.max(wait, 5000), 15 * 60_000);
  }
  return false;
}

/** The line under the bracket pair: why there's no fresh answer, when that's the case. The
 *  error comes before "checking", so a failing check never reads as one about to answer. */
export function checkStatus(c: DeckCheck | undefined, now = new Date()): string | null {
  if (!c) return null;
  const failed = c.result ? "The last re-check failed" : "Couldn't check";
  if (!c.enabled) return "Outside checks are off on this server.";
  if (c.archived) return "This deck is archived, so Commander Spellbook isn't asked about it.";
  if (c.error && c.gave_up) return `${failed}: ${c.error}. Stopped trying until you ask again.`;
  if (c.error && c.retrying && c.next_try_at) return `${failed}: ${c.error}. Trying again at ${localTime(c.next_try_at, now)}.`;
  if (c.error && c.pending) return `${failed}: ${c.error}. Trying again now.`;
  if (c.pending) return c.result ? "Checking again with Commander Spellbook." : "Checking with Commander Spellbook. This takes a few seconds after a save.";
  if (!c.result && !c.requested_at) return "Not checked yet.";
  return null;
}
