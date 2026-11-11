// A logged game back in the Log a game form, to edit it. Saving it again under the same id
// stores what the form says now (server/src/games.rs, create_game).

import { FORMATS, noteText, type FunRating, type TableFormat, type WinCondition } from "@yama/core";
import type { KnockoutAnswer } from "../components/GameCapture";
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

/**
 * A game logged after it was played (Log a game): finished, with nothing recorded at the table.
 * A note doesn't say so: any game can carry one. The server's rule is the same (games.rs,
 * `is_logged`).
 */
export function isLoggedGame(g: Pick<GameDetail, "mode" | "status" | "events">): boolean {
  return g.mode === "in_person" && g.status === "finished" && g.events.length === 0;
}

/**
 * A logged game's per-seat answers (fun, and who was knocked out when and by whom) for the seats
 * being saved. `kept` lists the form's places that are saved, in order: a seat left blank is
 * dropped and the rest are numbered from 0, so every answer follows its player. `winner` is the
 * winner's place in the form, or null for a draw.
 */
export function seatResults(kept: number[], winner: number | null, fun: FunRating[], outs: KnockoutAnswer[]) {
  const seatOf = (place: number | null) => {
    const seat = place === null ? -1 : kept.indexOf(place);
    return seat >= 0 ? seat : null;
  };
  return kept.flatMap((place, seat) => {
    const rating = fun.find((r) => r.seat === place)?.rating ?? null;
    // The winner wasn't knocked out, whatever was ticked before they were picked.
    const out = place === winner ? undefined : outs.find((k) => k.seat === place);
    if (rating === null && !out) return [];
    return [{ seat, fun: rating, eliminated_turn: out?.turn ?? null, eliminated_by_seat: out ? seatOf(out.by) : null }];
  });
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
  /** Who was knocked out, by their place in the form. */
  outs: KnockoutAnswer[];
  /** What was written about the game ("" for none). */
  note: string;
  seats: SeatDraft[];
  /** Each seat's label as saved, for a "partner" that turns out to be part of a deck's name. */
  savedLabels: (string | null)[];
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
    // A seat was knocked out if the game says when or by whom.
    outs: seats.flatMap((s, i) => (s.eliminated_turn != null || s.eliminated_by_seat != null ? [{ seat: i, turn: s.eliminated_turn, by: place(s.eliminated_by_seat) }] : [])),
    note: noteText(g.note) ?? "",
    savedLabels: seats.map((s) => s.deck_label),
    seats: seats.map((s) => {
      const mine = decks.find((d) => d.id === g.your_decks?.[s.seat]);
      const read = splitPair(s);
      const commander = read.commander;
      // On your own deck, a "partner" that isn't one of its commanders is part of its name.
      const partner = mine && read.partner && !mine.commanders.includes(read.partner) ? undefined : read.partner;
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
        // A named deck that isn't yours keeps its name while its commander is edited.
        deckTyped: !mine && !!label ? true : undefined,
        commanderName: commander ?? "",
        partnerName: partner,
        colorIdentity: mine?.color_identity ?? "",
        art: mine?.commander_image ?? undefined,
        artist: mine?.commander_image ? (mine.commander_artist ?? undefined) : undefined,
      };
    }),
  };
}

/**
 * A rebuilt seat once its cards are looked up. A partner read from the label ("Tymna the Weaver
 * and Kraum, Ludevic's Opus") that isn't a card was part of a deck's name ("Tymna the Weaver and
 * Friends"): the lookup drops it, and the name comes back as the seat's deck.
 */
export function settleRebuilt(found: Partial<SeatDraft>, readPartner: boolean, savedLabel: string | null | undefined): Partial<SeatDraft> {
  return readPartner && !found.partnerName && savedLabel ? { ...found, deckLabel: savedLabel } : found;
}

