// Seat drafts for the table's New game and Log a game. A seat is tied to your account only when
// you say so ("This is me", or your own row in the playgroup's list), never because it happens
// to hold your name, and typing someone else's name over your seat makes it theirs.

import type { Playgroup } from "../api";

export interface SeatDraft {
  name: string;
  memberId?: string;
  userId?: string;
  deckId?: string;
  deckVersionId?: string;
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

/** What a seat drops when it stops being an account's: the account and that account's deck. */
export const NOT_AN_ACCOUNT = { userId: undefined, deckId: undefined, deckVersionId: undefined } as const;

export function emptySeat(): SeatDraft {
  return { name: "", commanderName: "", colorIdentity: "" };
}

/**
 * Change one seat. A person sits once: claiming an account or a playgroup member for this seat
 * takes them off any other seat, which becomes a blank guest seat again.
 */
export function patchSeat(seats: SeatDraft[], i: number, patch: Partial<SeatDraft>): SeatDraft[] {
  return seats.map((s, j) => {
    if (j === i) return { ...s, ...patch };
    const sameAccount = patch.userId !== undefined && s.userId === patch.userId;
    const sameMember = patch.memberId !== undefined && s.memberId === patch.memberId;
    return sameAccount || sameMember ? { ...s, ...NOT_AN_ACCOUNT, memberId: undefined, name: "" } : s;
  });
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
      if (member) return { ...s, memberId: member.id, name: member.display_name };
      return { ...s, memberId: undefined, ...(s.userId ? NOT_AN_ACCOUNT : {}) };
    }
    if (!s.memberId && (!s.userId || s.userId === me?.id)) return s;
    return { ...s, memberId: undefined, ...(s.userId === me?.id ? {} : NOT_AN_ACCOUNT) };
  });
}
