// A logged game back in the Log a game form, to edit it. Saving it again under the same id
// stores what the form says now (server/src/games.rs, create_game).

import { FORMATS, type FunRating, type TableFormat, type WinCondition } from "@yama/core";
import type { DeckSummary, GameDetail, GameSeat } from "../api";
import { emptySeat, type SeatDraft } from "./seats";
import { localDay } from "./versions";

/** "Tana and Tymna" on the server's label, back into a commander and a partner. */
export function splitPair(s: Pick<GameSeat, "commander_name" | "deck_label">): { commander?: string; partner?: string } {
  const commander = s.commander_name ?? undefined;
  const label = s.deck_label ?? "";
  const partner = commander && label.startsWith(`${commander} and `) ? label.slice(commander.length + 5) : undefined;
  return { commander, partner };
}

export interface LogForm {
  groupId: string;
  /** The game's format and starting life, kept as they were (a copied Standard game stays one). */
  format: TableFormat;
  startingLife: number;
  /** YYYY-MM-DD, the local day it was played. */
  date: string;
  turns: string;
  /** A seat's place in the form, "draw", or null if nobody said. */
  winner: number | "draw" | null;
  first: number | null;
  condition: WinCondition | null;
  fun: FunRating[];
  seats: SeatDraft[];
}

/** A guest named "@sam" was found by that handle; their seat can offer their public decks again. */
function handleOf(name: string | null): string | undefined {
  const m = name?.match(/^@([a-z][a-z0-9_-]{2,29})$/i);
  return m ? m[1]!.toLowerCase() : undefined;
}

export function formFromGame(g: GameDetail, decks: DeckSummary[] = []): LogForm {
  const seats = [...g.seats].sort((a, b) => a.seat - b.seat);
  const at = (seat: number | null) => (seat === null ? -1 : seats.findIndex((s) => s.seat === seat));
  const place = (seat: number | null) => (at(seat) >= 0 ? at(seat) : null);
  return {
    groupId: g.playgroup_id ?? "",
    format: FORMATS.some((f) => f.key === g.format) ? (g.format as TableFormat) : "commander",
    startingLife: g.starting_life ?? 40,
    date: localDay(new Date(g.started_at)),
    turns: g.turns != null ? String(g.turns) : "",
    winner: g.status !== "finished" ? null : g.winner_seat === null ? "draw" : place(g.winner_seat),
    first: place(g.first_seat),
    condition: (g.win_condition as WinCondition | null) ?? null,
    fun: seats.flatMap((s, i) => (s.fun != null ? [{ seat: i, rating: s.fun }] : [])),
    seats: seats.map((s) => {
      const { commander, partner } = splitPair(s);
      const mine = decks.find((d) => d.id === g.your_decks?.[s.seat]);
      // The label names a precon or someone's public deck unless it's only the commanders.
      const label = s.deck_label && s.deck_label !== commander && !partner ? s.deck_label : undefined;
      return {
        ...emptySeat(),
        name: s.display_name ?? s.guest_name ?? "",
        memberId: s.member_id ?? undefined,
        userId: s.user_id ?? undefined,
        handle: s.user_id ? undefined : handleOf(s.guest_name),
        deckId: mine?.id,
        deckVersionId: s.deck_version_id ?? undefined,
        // Your deck lent to someone keeps its name too.
        deckLabel: label,
        commanderName: commander ?? "",
        partnerName: partner,
        colorIdentity: mine?.color_identity ?? "",
        art: mine?.commander_image ?? undefined,
        artist: mine?.commander_image ? (mine.commander_artist ?? undefined) : undefined,
      };
    }),
  };
}
