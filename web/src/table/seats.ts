// Seat drafts for the table's New game and Log a game. A seat is tied to your account only when
// you say so ("This is me", or your own row in the playgroup's list), never because it happens
// to hold your name, and typing someone else's name over your seat makes it theirs.

import type { Playgroup } from "../api";

export interface SeatDraft {
  name: string;
  memberId?: string;
  userId?: string;
  /** The player's profile handle, when they have one: their seat can offer their public decks. */
  handle?: string;
  /** One of your decks. */
  deckId?: string;
  deckVersionId?: string;
  /** A deck picked that isn't one of yours: a precon, or one of the player's public decks. */
  deckLabel?: string;
  commanderName: string;
  colorIdentity: string;
  art?: string;
  artist?: string;
  partnerName?: string;
  partnerArt?: string;
  partnerArtist?: string;
  /** The commander's and the partner's own colors (colorIdentity is both), from the cards picked. */
  ownIdentity?: string;
  partnerIdentity?: string;
  pairs?: "partner" | "background" | null;
  pairsWith?: string | null;
  pairScope?: string;
}

export interface Me {
  id: string;
  display_name: string;
}

/** What a seat drops when it stops being someone's: their account, profile and deck. */
export const NOT_AN_ACCOUNT = { userId: undefined, handle: undefined, deckId: undefined, deckVersionId: undefined, deckLabel: undefined } as const;

/**
 * The seat's label on the server: the deck picked (a precon, or the player's public deck), else
 * the commander. A pair always travels as "Commander and Partner", so another device can rebuild
 * it (GameDetail's splitPair).
 */
export function seatDeckLabel(s: Pick<SeatDraft, "commanderName" | "partnerName" | "deckLabel">): string | undefined {
  const partner = s.partnerName?.trim();
  if (s.commanderName && partner) return `${s.commanderName} and ${partner}`;
  return s.deckLabel || s.commanderName || undefined;
}

export function emptySeat(): SeatDraft {
  return { name: "", commanderName: "", colorIdentity: "" };
}

/**
 * Change one seat. A person sits once: claiming an account, a playgroup member or a profile
 * handle for this seat takes them off any other seat, which becomes a blank guest seat again.
 */
export function patchSeat(seats: SeatDraft[], i: number, patch: Partial<SeatDraft>): SeatDraft[] {
  return seats.map((s, j) => {
    if (j === i) return { ...s, ...patch };
    const sameAccount = patch.userId !== undefined && s.userId === patch.userId;
    const sameMember = patch.memberId !== undefined && s.memberId === patch.memberId;
    const sameHandle = patch.handle !== undefined && s.handle === patch.handle;
    return sameAccount || sameMember || sameHandle ? { ...s, ...NOT_AN_ACCOUNT, memberId: undefined, name: "" } : s;
  });
}

/** A change to a seat, or one decided from the seat as it is by then (null: no change). */
export type SeatPatch = Partial<SeatDraft> | ((now: SeatDraft) => Partial<SeatDraft> | null);

/** Apply a seat change to the seat at `i`, if there still is one. */
export function applySeatPatch(seats: SeatDraft[], i: number, patch: SeatPatch): SeatDraft[] {
  const seat = seats[i];
  if (!seat) return seats;
  const p = typeof patch === "function" ? patch(seat) : patch;
  return p ? patchSeat(seats, i, p) : seats;
}

/**
 * Whether a seat still holds the deck and commanders a slow lookup was started for. A result
 * that comes back after the seat changed (another deck, other commanders, a removed seat whose
 * place someone else took) is dropped rather than written onto what's there now.
 */
export function stillHolds(now: SeatDraft, then: Pick<SeatDraft, "deckId" | "deckLabel" | "commanderName" | "partnerName">): boolean {
  return now.deckId === then.deckId && now.deckLabel === then.deckLabel && now.commanderName === then.commanderName && (now.partnerName ?? "") === (then.partnerName ?? "");
}

/**
 * The seat's commander fields as edited. Other commanders aren't the deck the seat was saved with
 * (an edited game can hold a deck version with no name to show), so the deck goes; art and colors
 * filled in for the same commanders keep it.
 */
export function commandersPatch(seat: SeatDraft, d: Partial<SeatDraft>): Partial<SeatDraft> {
  const changed = (d.commanderName ?? "") !== seat.commanderName || (d.partnerName ?? "") !== (seat.partnerName ?? "");
  return {
    ...d,
    commanderName: d.commanderName ?? "",
    colorIdentity: d.colorIdentity ?? "",
    ...(changed ? { deckId: undefined, deckVersionId: undefined, deckLabel: undefined } : {}),
  };
}

/**
 * A seat's place in the form after the seat at `gone` was removed: the seats after it move up
 * one, and the removed seat itself is no longer anyone's answer (null).
 */
export function afterRemoving(seat: number | null, gone: number): number | null {
  if (seat === null || seat === gone) return null;
  return seat > gone ? seat - 1 : seat;
}

/**
 * A new name typed into a seat. If the seat was tied to an account (and not picked from the
 * playgroup's list), a name that isn't that account's turns it into someone else's seat, so a
 * game you only watched isn't put on your record.
 */
export function renameSeat(seat: SeatDraft, name: string, me: Me | null | undefined): Partial<SeatDraft> {
  const stillYou = !!me && seat.userId === me.id && name.trim() === me.display_name;
  return seat.userId && !seat.memberId && !stillYou ? { name, ...NOT_AN_ACCOUNT } : { name };
}

/**
 * Fit the seats to the playgroup just chosen (or to none). With a group, a seat tied to an
 * account becomes that person's member row, and picks from another group become guests under the
 * same name. Without one, member picks become typed names, and only your own account stays tied
 * (the server only lets you put a game on your own record without a playgroup).
 */
export function fitSeatsToGroup(seats: SeatDraft[], group: Playgroup | undefined, me: Me | null | undefined): SeatDraft[] {
  return seats.map((s) => {
    if (group) {
      if (s.memberId && group.members.some((m) => m.id === s.memberId)) return s;
      const member = s.userId ? group.members.find((m) => m.user_id === s.userId) : undefined;
      if (member) return { ...s, memberId: member.id, name: member.display_name, handle: member.handle ?? undefined };
      // Someone found by their handle who is in this group: their member row, account and all.
      const found = !s.userId && s.handle ? group.members.find((m) => m.user_id && m.handle === s.handle) : undefined;
      if (found) return { ...s, memberId: found.id, userId: found.user_id!, name: found.display_name, handle: found.handle ?? undefined };
      return { ...s, memberId: undefined, ...(s.userId ? NOT_AN_ACCOUNT : {}) };
    }
    if (!s.memberId && (!s.userId || s.userId === me?.id)) return s;
    return { ...s, memberId: undefined, ...(s.userId === me?.id ? {} : NOT_AN_ACCOUNT) };
  });
}

/**
 * Handles for seats rebuilt from a saved game, which know only a member or a guest's name: a
 * member's from the playgroup, a guest's from someone in your other playgroups by that name.
 * With the handle on the seat, their public decks are offered and they can't sit twice.
 */
export function withHandles(seats: SeatDraft[], group: Playgroup | undefined, groups: Playgroup[]): SeatDraft[] {
  return seats.map((s) => {
    if (s.handle) return s;
    if (s.memberId) {
      const handle = group?.members.find((m) => m.id === s.memberId)?.handle;
      return handle ? { ...s, handle } : s;
    }
    const name = s.name.trim().toLowerCase();
    if (s.userId || !name) return s;
    const known = groups.flatMap((g) => (g.id === group?.id ? [] : g.members)).find((m) => m.user_id && m.handle && m.display_name.toLowerCase() === name);
    return known?.handle ? { ...s, handle: known.handle } : s;
  });
}
