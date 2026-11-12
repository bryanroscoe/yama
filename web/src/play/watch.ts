// Watch the AIs play: request shapes and the words the screens use (server/src/watch.rs).

import { plural } from "@yama/core";
import { shortName } from "./text";
import type { SeatInfo, Speed, WatchStatus } from "./types";

export const LEVELS = ["Easy", "Medium", "Hard"] as const;
export type Level = (typeof LEVELS)[number];

export const SPEEDS: { speed: Speed; label: string; long: string }[] = [
  { speed: "1x", label: "1x", long: "Normal speed" },
  { speed: "2x", label: "2x", long: "Twice as fast" },
  { speed: "4x", label: "4x", long: "Four times as fast" },
  { speed: "end", label: "To the end", long: "Skip to the end" },
];

/** A watched game in the list (GET /api/watch). */
export interface WatchSummary {
  id: string;
  created_at: string;
  seats: SeatInfo[];
  status: WatchStatus;
  turn: number;
  winner: number | null;
  missing_cards: Record<string, string[]>;
}

/**
 * What this account may do with watched games (GET /api/watch/allowance). Null means no limit:
 * `at_a_time` for admins, the daily count for power users and admins.
 */
export interface WatchAllowance {
  at_a_time: number | null;
  per_day: number | null;
  used_today: number | null;
}

/** The daily allowance in a sentence, saying the limit and what is left of it. Null without a daily count. */
export function watchAllowanceText(a: WatchAllowance): string | null {
  if (a.per_day == null) return null;
  const left = Math.max(0, a.per_day - (a.used_today ?? 0));
  if (left === 0) return `You've started ${plural(a.per_day, "watched game")} in the last 24 hours, which is the daily limit. You can start another once the earliest of them is 24 hours old.`;
  const each = a.at_a_time === 1 ? ", one at a time" : a.at_a_time ? `, ${a.at_a_time} at a time` : "";
  return `You can start ${plural(a.per_day, "watched game")} a day${each}. ${left} left today.`;
}

/** One seat on the setup page: whose deck, which one, and how well the AI plays it. */
export interface WatchSeatPlan {
  source: "deck" | "precon";
  deckId: string;
  preconId: string;
  level: Level;
}

/** The POST /api/watch body. `first` is a seat index, or null for the engine's roll. */
export function watchRequest(seats: WatchSeatPlan[], first: number | null, reveal: boolean, speed: Speed) {
  return {
    seats: seats.map((s) => ({
      deck: s.source === "deck" ? { kind: "deck", id: s.deckId } : { kind: "precon", id: s.preconId },
      pilot: { kind: "ai", difficulty: s.level },
    })),
    first,
    reveal,
    speed,
  };
}

/** A computer seat by its commander ("Éowyn"), or its deck when it has none. */
export function seatName(s: SeatInfo | undefined, n: number): string {
  if (!s) return `Seat ${n + 1}`;
  return shortName(s.commander ?? s.deck_name ?? s.name);
}

/** "Éowyn, easy": the seat and its AI level, for headers and tabs. */
export function seatLabel(s: SeatInfo | undefined, n: number): string {
  const name = seatName(s, n);
  return s?.ai ? `${name}, ${s.ai.toLowerCase()}` : name;
}

/** The first line about a watched game: who won, why it stopped, or where it is. */
export function statusLine(g: Pick<WatchSummary, "status" | "turn" | "winner" | "seats">): string {
  const s = g.status;
  if (s.finished) {
    if (s.stopped) return s.stopped;
    if (g.winner === null) return `A draw on turn ${g.turn}`;
    return `${seatName(g.seats.find((x) => x.seat === g.winner), g.winner)} won on turn ${g.turn}`;
  }
  if (s.idle) return `Paused on turn ${g.turn} while nobody watches`;
  if (!s.playing) return `Paused on turn ${g.turn}`;
  return s.speed === "end" ? `Skipping to the end, turn ${g.turn}` : `Playing, turn ${g.turn}`;
}

/** "Éowyn, Atraxa and Omo" from a game's seats. */
export function tableNames(seats: SeatInfo[]): string {
  const names = seats.map((s) => seatName(s, s.seat));
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
