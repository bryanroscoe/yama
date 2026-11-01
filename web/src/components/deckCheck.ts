// Pure helpers for the deck page's Commander Spellbook check: what the status line says, how
// often to ask again, and how its dates read. Kept apart from the components so they're tested
// without a browser.

import type { DeckCheck } from "../api";

/** What Yama sends where, said wherever a check can start. */
export const SENDS_LIST = "Yama sends this deck's card list (commander and main deck) to Commander Spellbook after each save, for the card flags and combos used in the suggestion.";

/** The ordinary deck-building limits, not a complete assessment of a deck's bracket. */
export function gameChangerFloor(count: number): string {
  if (count === 0) return "No Game Changers. That alone doesn't establish a bracket: speed, consistency and combos still matter.";
  if (count <= 3) return `${count} Game ${count === 1 ? "Changer" : "Changers"}: within bracket 3's limit, but the deck may belong higher.`;
  return `${count} Game Changers: above bracket 3's limit of three, so bracket 4 or 5 under the usual guidelines.`;
}

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

/** E is Spellbook's fallback, not proof of Exhibition intent. Handle it before the numeric
 * field so old cached E/1 responses also show Yama's provisional Core starting point. */
export function estimateValue(tag: string, bracket: number | null): { value: string; sub: (label: string) => string } {
  if (tag === "E") return { value: "2", sub: () => "Core starting point, confirm speed and intent" };
  if (["C", "O", "P", "S", "R"].includes(tag) && bracket != null && bracket >= 2 && bracket <= 4) return { value: String(bracket), sub: (label) => `From Commander Spellbook's "${label}" signals` };
  if (tag === "B") return { value: "Banned", sub: () => "A card is banned in Commander" };
  return { value: "Unknown", sub: () => `Commander Spellbook answered with a tag Yama doesn't know yet ("${tag}")` };
}

/** The starting suggestion as a number, 2-4, when the check gives one (E is the provisional
 *  Core starting point); null for a banned card or a tag Yama doesn't know. */
export function suggestedBracket(tag: string, bracket: number | null): number | null {
  const v = Number(estimateValue(tag, bracket).value);
  return Number.isInteger(v) ? v : null;
}

export function estimateExplanation(tag: string): string {
  if (tag === "E") return "Start with Core (2): the card-list check found no signals that suggest a higher bracket among the cards it recognized. This doesn't prove the deck's power or speed. Exhibition (1) is for decks deliberately built around theme over power, so Yama never assigns it automatically. A highly tuned deck may still belong above Core without any Game Changers.";
  if (tag === "B") return "The card-list check found a card banned in Commander. Review it before choosing a bracket; a bracket doesn't override card legality.";
  if (!["C", "O", "P", "S", "R"].includes(tag)) return "The card-list check returned a result Yama can't interpret yet. No starting bracket is available from this check; use the bracket guide and review the deck before declaring one.";
  return "This starting suggestion uses the Game Changers, mass land denial, extra turns and known combos found by Commander Spellbook. Confirm how early and consistently the deck can win before choosing your bracket. Yama never assigns Exhibition (1) or cEDH (5) automatically: those depend on how and why the deck was built.";
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
