// The words on a Recent games row (the Table tab): who won with what, and over whom.

import { winConditionLabel } from "@yama/core";
import type { GameRow, GameSeat } from "../api";

/** "Terra" from "Terra, Herald of Hope": the name a table calls a commander by. */
export const shortName = (name: string) => name.split(",")[0]!.trim();

/** "A, B and C". */
export const listNames = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The seat that won a finished game, found by seat number among that game's own seats. */
export function winningSeat(g: Pick<GameRow, "status" | "winner_seat" | "seats">): GameSeat | undefined {
  if (g.status !== "finished" || g.winner_seat == null) return undefined;
  return g.seats.find((s) => s.seat === g.winner_seat);
}

/**
 * The player at a seat, as a name that tells seats apart: their name, or "the computer" for an
 * AI seat whose name is just its commander's. Null when there's nothing better than the commander.
 */
function playerName(s: GameSeat): string | null {
  const name = s.display_name?.trim();
  const cmdr = s.commander_name ?? "";
  if (name && name !== cmdr && name !== shortName(cmdr)) return name;
  return s.ai_kind ? "the computer" : null;
}

/**
 * Seats named by their commander's short name, each seat once. When two seats share a commander,
 * or a seat shares the commander in `clash` (the winner's, in an "Over …" list), each gets its
 * player's name in brackets, or its seat number if the names don't tell them apart. A seat with
 * no commander goes by its player's name.
 */
export function seatLabels(seats: GameSeat[], clash: (string | null | undefined)[] = []): string[] {
  const clashing = new Set(clash.filter((c): c is string => !!c));
  const count = new Map<string, number>();
  for (const s of seats) if (s.commander_name) count.set(s.commander_name, (count.get(s.commander_name) ?? 0) + 1);
  return seats.map((s) => {
    const cmdr = s.commander_name;
    if (!cmdr) return s.display_name?.trim() || `Seat ${s.seat + 1}`;
    if ((count.get(cmdr) ?? 0) < 2 && !clashing.has(cmdr)) return shortName(cmdr);
    const group = seats.filter((o) => o.commander_name === cmdr);
    const names = group.map(playerName);
    const distinct = names.every((n) => !!n) && new Set(names).size === names.length;
    const who = playerName(s);
    return `${shortName(cmdr)} (${distinct && who ? who : `seat ${s.seat + 1}`})`;
  });
}

/**
 * "9 turns" for a game at the table (rounds), "34 player turns" for an online one, where the
 * rules engine counts every player's turn. Never the same word for both.
 */
export function turnsText(g: Pick<GameRow, "mode" | "turns">): string | null {
  return g.turns ? `${g.turns} ${g.mode === "online" ? "player turns" : "turns"}` : null;
}

export interface RecentText {
  /** "Sam won", "Draw" or "In progress". */
  title: string;
  /** The winning seat's own commander for this game ("Éowyn"), when it isn't the player's name. */
  with: string | null;
  /** How it was won, who it was over (or who's playing) and the game's note, as sentences. */
  sub: string;
  /** The phone's one line: the winner's commander and the turns. */
  short: string;
}

export function recentGameText(g: GameRow & { note?: string | null }): RecentText {
  const finished = g.status === "finished";
  const winner = winningSeat(g);
  const cmdr = winner?.commander_name ?? null;
  const title = !finished ? "In progress" : winner ? `${winner.display_name?.trim() || `Seat ${winner.seat + 1}`} won` : "Draw";
  const withCmdr = winner && cmdr && cmdr !== winner.display_name && shortName(cmdr) !== winner.display_name ? shortName(cmdr) : null;
  const how = winner ? winConditionLabel(g.win_condition) : null;
  const others = winner ? g.seats.filter((s) => s.seat !== winner.seat) : g.seats;
  const people = winner ? (others.length ? `Over ${listNames(seatLabels(others, [cmdr]))}` : null) : listNames(seatLabels(g.seats));
  const sub = [how, people, g.note].filter(Boolean).join(". ");
  const short = [cmdr && shortName(cmdr), turnsText(g)].filter(Boolean).join(", ") || sub;
  return { title, with: withCmdr, sub, short };
}
