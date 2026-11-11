// A new online game's seats, as Play online sets them up, and the request they make
// (server/src/play.rs, create_game).

/** One seat on the New game form. Seat 1 is always you. */
export interface SeatPlan {
  kind: "me" | "friend" | "ai";
  /** One of your decks: yours, or the one the computer plays. "" means the first in your list. */
  deckId: string;
  difficulty: string;
  /** A computer seat plays one of your decks or a stock precon. */
  source?: "deck" | "precon";
  preconId?: string;
}

/** The computer plays a precon in this seat (and one is chosen). */
export const playsPrecon = (s: SeatPlan) => s.kind === "ai" && s.source === "precon" && !!s.preconId;

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
