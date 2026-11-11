// A new online game's seats, as Play online sets them up, and the request they make
// (server/src/play.rs, create_game).

/** One seat on the New game form. Seat 1 is always you. */
export interface SeatPlan {
  kind: "me" | "friend" | "ai";
  /** One of your decks: yours, or the one the computer plays. "" means the first in your list. */
  deckId: string;
  difficulty: string;
  /** Your seat or a computer's plays one of your decks or a stock precon. */
  source?: "deck" | "precon";
  preconId?: string;
}

/** This seat (yours or the computer's) plays a precon, and one is chosen. */
export const playsPrecon = (s: SeatPlan) => s.kind !== "friend" && s.source === "precon" && !!s.preconId;

/**
 * The seats as they'll be sent. With no decks of your own (a guest, or a new account) every seat
 * but a friend's plays a precon; a seat set to precons that hasn't picked one gets one of the
 * list, spread out so the table isn't one deck four times.
 */
export function withPrecons(seats: SeatPlan[], precons: string[], noDecks: boolean): SeatPlan[] {
  if (!precons.length) return seats;
  return seats.map((s, i) => {
    if (s.kind === "friend" || (!noDecks && s.source !== "precon") || (s.source === "precon" && s.preconId)) return s;
    return { ...s, source: "precon", preconId: s.preconId || precons[(i * 37 + 11) % precons.length]! };
  });
}

/**
 * The POST /api/play body. `first` is a seat's place in the list, or null for a roll; `firstDeck`
 * stands in for a seat that hasn't picked one of your decks yet.
 */
export function playRequest(seats: SeatPlan[], first: number | null, playgroupId: string, firstDeck: string) {
  return {
    playgroup_id: playgroupId || null,
    first: first !== null && first < seats.length ? first : null,
    seats: seats.map((s) => ({
      kind: s.kind,
      deck_id: s.kind === "friend" || playsPrecon(s) ? null : s.deckId || firstDeck,
      precon_id: playsPrecon(s) ? s.preconId : null,
      difficulty: s.kind === "ai" ? s.difficulty : null,
    })),
  };
}

/** "You", "Seat 2, a friend", "Seat 3, the computer": who a seat is before anyone has joined. */
export function seatWho(s: SeatPlan, i: number): string {
  if (i === 0) return "You";
  return `Seat ${i + 1}, ${s.kind === "friend" ? "a friend" : "the computer"}`;
}
