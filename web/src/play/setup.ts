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
 * but a friend's plays a precon; a seat set to precons that hasn't picked one (or whose precon is
 * no longer in the list: a seat remembered from an earlier game) gets one of the list, spread out
 * so the table isn't one deck four times.
 */
export function withPrecons(seats: SeatPlan[], precons: string[], noDecks: boolean): SeatPlan[] {
  if (!precons.length) return seats;
  return seats.map((s, i) => {
    const has = !!s.preconId && precons.includes(s.preconId);
    if (s.kind === "friend" || (!noDecks && s.source !== "precon") || (s.source === "precon" && has)) return s;
    return { ...s, source: "precon", preconId: has ? s.preconId : precons[(i * 37 + 11) % precons.length]! };
  });
}

/**
 * Your decks in the order seats take them: the one changed most recently first (the list arrives
 * by name, which sat every seat on the same deck). Another list of a deck already there (its
 * configurations) is left out, unless those are all there is.
 */
export function recentDecks(decks: { id: string; updated_at: string; parent_id?: string | null }[]): string[] {
  const mains = decks.filter((d) => !d.parent_id);
  return [...(mains.length ? mains : decks)].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((d) => d.id);
}

/**
 * The deck a seat starts on: the most recent one no other seat has, so a table isn't one deck
 * four times. Once every deck is taken they come round again.
 */
export function nextDeck(order: string[], taken: Iterable<string>, i: number): string {
  const used = new Set(taken);
  return order.find((id) => !used.has(id)) ?? order[i % Math.max(1, order.length)] ?? "";
}

const KINDS = ["me", "friend", "ai"];
const DIFFICULTIES = ["Easy", "Medium", "Hard"];

/** The seats kept from the last game you set up (JSON), or null when there are none to trust. */
export function rememberedSeats(raw: string | null): SeatPlan[] | null {
  if (!raw) return null;
  try {
    const seats: unknown = JSON.parse(raw);
    if (!Array.isArray(seats) || seats.length < 2 || seats.length > 6) return null;
    const out = seats.map((s: Partial<SeatPlan> | null, i): SeatPlan | null => {
      if (!s || typeof s !== "object" || !KINDS.includes(s.kind as string) || (s.kind === "me") !== (i === 0)) return null;
      const plan: SeatPlan = { kind: s.kind!, deckId: typeof s.deckId === "string" ? s.deckId : "", difficulty: DIFFICULTIES.includes(s.difficulty as string) ? s.difficulty! : "Medium" };
      if (s.source === "precon" && typeof s.preconId === "string" && s.preconId) return { ...plan, source: "precon", preconId: s.preconId };
      return plan;
    });
    return out.every((s) => s !== null) ? (out as SeatPlan[]) : null;
  } catch {
    return null;
  }
}

/**
 * The seats a new game opens with: the ones you set up last time, else you and three computers.
 * A seat with no deck, or one you no longer have, takes the next of your decks ([`recentDecks`])
 * that nobody else is on. A friend brings their own, so their seat holds none.
 */
export function startingSeats(decks: { id: string; updated_at: string; parent_id?: string | null }[], remembered: SeatPlan[] | null): SeatPlan[] {
  const base: SeatPlan[] = remembered ?? [
    { kind: "me", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
    { kind: "ai", deckId: "", difficulty: "Medium" },
  ];
  const order = recentDecks(decks);
  const kept = base.map((s) => (s.kind !== "friend" && decks.some((d) => d.id === s.deckId) ? s.deckId : ""));
  const taken = new Set(kept.filter(Boolean));
  return base.map((s, i) => {
    if (s.kind === "friend") return { ...s, deckId: "" };
    if (kept[i]) return s;
    const deckId = nextDeck(order, taken, i);
    if (deckId) taken.add(deckId);
    return { ...s, deckId };
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
