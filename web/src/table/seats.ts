// Seat drafts for the table's New game and Log a game. A seat is tied to your account only when
// you say so ("This is me", or your own row in the playgroup's list), never because it happens
// to hold your name, and typing someone else's name over your seat makes it theirs.

import type { Playgroup } from "../api";

export interface SeatDraft {
  /** Local setup identity: stays with this seat when another player is removed. */
  draftId?: string;
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
  /** The deck's listed commanders, when they can't all lead it together: the seat plays one. */
  commanderChoices?: string[];
}

export interface Me {
  id: string;
  display_name: string;
}

/** What a seat drops when it stops being someone's: their account, profile and deck. */
export const NOT_AN_ACCOUNT = { userId: undefined, handle: undefined, deckId: undefined, deckVersionId: undefined, deckLabel: undefined, commanderChoices: undefined } as const;

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

/** Give setup seats stable local identities, including old saved setups and new blank seats. */
export function withDraftIds(seats: SeatDraft[]): SeatDraft[] {
  const seen = new Set<string>();
  return seats.map((s) => {
    const draftId = s.draftId && !seen.has(s.draftId) ? s.draftId : crypto.randomUUID();
    seen.add(draftId);
    return draftId === s.draftId ? s : { ...s, draftId };
  });
}

/** A delayed editor answer follows its surviving seat; a removed seat is no longer a target. */
export function applyDraftPatch(seats: SeatDraft[], draftId: string, patch: SeatPatch): SeatDraft[] {
  return applySeatPatch(seats, seats.findIndex((s) => s.draftId === draftId), patch);
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
    ...(changed ? { deckId: undefined, deckVersionId: undefined, deckLabel: undefined, commanderChoices: undefined } : {}),
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
 * Explicit group choices may also reconcile unique plain guest names; saved-game rebuilds do not.
 */
export function fitSeatsToGroup(seats: SeatDraft[], group: Playgroup | undefined, me: Me | null | undefined, matchGuestNames = false): SeatDraft[] {
  const fitted = seats.map((s) => {
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
  if (!group || !matchGuestNames) return fitted;
  // Only an explicit group choice reconciles plain friends by name. Never infer your own
  // account from a name, override a known identity, or give two seats the same member.
  const nameKey = (name: string) => name.trim().toLowerCase();
  return fitted.map((s, i) => {
    const original = seats[i]!;
    if (original.memberId || original.userId || original.handle || !nameKey(s.name)) return s;
    const matches = group.members.filter((m) => nameKey(m.display_name) === nameKey(s.name));
    if (matches.length !== 1) return s;
    const member = matches[0]!;
    if (member.user_id === me?.id || fitted.some((o) => o.memberId === member.id || (!!member.user_id && o.userId === member.user_id))) return s;
    if (fitted.filter((o) => nameKey(o.name) === nameKey(s.name)).length !== 1) return s;
    return { ...s, memberId: member.id, userId: member.user_id ?? undefined, handle: member.handle ?? undefined, name: member.display_name };
  });
}

/**
 * Handles for seats rebuilt from a saved game, which know only a member or a guest's name: a
 * member's from the playgroup, a guest's from the one person in your other playgroups by that name.
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
    // Only when the name is one person's: two Alexes with accounts leave the seat a plain guest.
    const known = groups.flatMap((g) => (g.id === group?.id ? [] : g.members)).filter((m) => m.user_id && m.display_name.toLowerCase() === name);
    const people = new Set(known.map((m) => m.user_id));
    const handle = people.size === 1 ? known[0]!.handle : null;
    return handle ? { ...s, handle } : s;
  });
}

/**
 * Seats copied from a playgroup you can't log in (you sat in it but aren't a member): its members
 * become guests by name, keeping their decks, labels and handles; only your own account stays
 * tied. Unlike choosing "None" yourself, nothing about what they played is dropped.
 */
export function withoutGroup(seats: SeatDraft[], me: Me | null | undefined): SeatDraft[] {
  return seats.map((s) => {
    if (!s.memberId && !s.userId) return s;
    if (me && s.userId === me.id) return { ...s, memberId: undefined };
    return { ...s, memberId: undefined, userId: undefined };
  });
}

/**
 * Seats rebuilt from a saved game, fitted to the playgroup as it is now: someone who left and
 * rejoined has a new member row (removal clears the old one from past seats), so their account
 * finds it again; anyone with no row in it now becomes a guest by name, keeping what they played.
 */
export function rebuildForGroup(seats: SeatDraft[], group: Playgroup | undefined, me: Me | null | undefined): SeatDraft[] {
  if (!group) return seats;
  return seats.map((s) => {
    const fitted = fitSeatsToGroup([s], group, me)[0]!;
    return fitted.memberId || fitted.userId || !(s.memberId || s.userId) ? fitted : withoutGroup([s], me)[0]!;
  });
}

/** Someone a seat can be, as the people search and the Who's playing row offer them. */
export interface SeatPerson {
  name: string;
  memberId?: string;
  userId?: string;
  handle?: string;
}

/**
 * The seat fields for a person picked: a member of the game's playgroup (their account comes
 * with them), you (without a playgroup only your own account can be tied), or anyone else as a
 * guest by name and the handle they were found by. null for a member no longer in the group.
 */
export function personPatch(p: SeatPerson, group: Playgroup | undefined, me: Me | null | undefined): Partial<SeatDraft> | null {
  if (group && p.memberId) {
    const m = group.members.find((x) => x.id === p.memberId);
    if (!m) return null;
    return { ...NOT_AN_ACCOUNT, memberId: m.id, userId: m.user_id ?? undefined, handle: m.handle ?? undefined, name: m.display_name };
  }
  if (!group && me && p.userId === me.id) return { userId: me.id, name: me.display_name, memberId: undefined };
  return { ...NOT_AN_ACCOUNT, memberId: undefined, name: p.name, handle: p.handle };
}

/** Whether this seat is that person: the same member or account, or a guest by the same name. */
export function seatHolds(s: Pick<SeatDraft, "name" | "memberId" | "userId">, p: SeatPerson): boolean {
  if (p.memberId) return s.memberId === p.memberId;
  if (p.userId) return !s.memberId && s.userId === p.userId;
  return !s.memberId && !s.userId && !!p.name.trim() && s.name.trim().toLowerCase() === p.name.trim().toLowerCase();
}

/** A seat nobody has been put in yet. */
export const isOpenSeat = (s: Pick<SeatDraft, "name" | "memberId" | "userId">) => !s.name.trim() && !s.memberId && !s.userId;

/**
 * Who's playing, one tap per person: someone already seated leaves and their seat is removed,
 * lowering the player count (at least one seat remains). Others keep their order and decks.
 * Anyone else takes the first open seat or a new one, up to `max`. The same seats back when
 * there's no room. Callers must route editor lookups by draft identity when removal changes seat indices.
 */
export function togglePerson(seats: SeatDraft[], p: SeatPerson, patch: Partial<SeatDraft>, max: number): SeatDraft[] {
  const at = seats.findIndex((s) => seatHolds(s, p));
  if (at >= 0) return seats.length === 1 ? [emptySeat()] : seats.filter((_, i) => i !== at);
  const open = seats.findIndex(isOpenSeat);
  if (open >= 0) return patchSeat(seats, open, { ...emptySeat(), ...patch });
  if (seats.length >= max) return seats;
  return patchSeat([...seats, emptySeat()], seats.length, patch);
}
