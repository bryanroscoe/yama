// Wording for results and streaks, kept apart from the components so it can be tested.

import type { PlayerStat } from "../api";

/** "3-2, 5 games" (wins-losses), with draws named when there are any. */
export function recordText(v: { games: number; wins: number; losses: number; draws: number }): string {
  if (v.games === 0) return "no games yet";
  const draws = v.draws ? `, ${v.draws} ${v.draws === 1 ? "draw" : "draws"}` : "";
  return `${v.wins}-${v.losses}${draws}, ${v.games} ${v.games === 1 ? "game" : "games"}`;
}

export function streakText(s: PlayerStat["streak"]): string {
  if (!s) return "";
  if (s.kind === "win") return s.games === 1 ? "Won the last game" : `Won the last ${s.games}`;
  return s.games === 1 ? "Didn't win the last game" : `No win in the last ${s.games}`;
}
