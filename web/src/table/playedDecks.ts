// The decks people have played at your games, as Mythic Tools keeps a player's decks: what each
// seat brought, from the games this account can already see (`GET /api/games`: games it logged,
// sat in, or its playgroups'). A friend without an account (most of a playgroup) has no decks on
// Yama, but their past games say what they play, so their seat can offer those first.

import type { GameRow } from "../api";
import { splitPair } from "./logEdit";
import { isPlaceholderName } from "./playerNames";
import { shortDate, fmtDate } from "@yama/core";

/** Lowercase, without accents and outer spaces: "Éowyn " finds eowyn. */
export const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();

/** Who sits at a seat, as far as the deck search needs: their name, member row or account. */
export interface DeckOwner {
  name: string;
  memberId?: string;
  userId?: string;
}

export interface PlayedDeck {
  /** The player and the deck, unique in the list. */
  key: string;
  /** The deck's own name, or its commanders when the seat was named only by them. */
  name: string;
  /** A deck name the seat was given (a precon, a friend's brew), not just its commanders. */
  named: boolean;
  /** The label as saved. "Tymna the Weaver and Friends" reads as a pair until the cards say no. */
  label?: string;
  /** The commander, and the partner or Background beside it. */
  commanders: string[];
  /** The player's name as the newest game shows it. */
  player: string;
  memberId?: string;
  userId?: string;
  games: number;
  /** When it was last played (the game's start). */
  last: string;
}

/** Game lists put together, each game once (yours and a playgroup's overlap). */
export function mergeGames(...lists: (GameRow[] | undefined)[]): GameRow[] {
  const byId = new Map<string, GameRow>();
  for (const list of lists) for (const g of list ?? []) if (!byId.has(g.id)) byId.set(g.id, g);
  return [...byId.values()];
}

/** The same person: the same account or member; by name only when one side has neither. */
export function samePerson(a: DeckOwner, b: DeckOwner): boolean {
  // An account is one person in every playgroup; a member row is one group's.
  if (a.userId && b.userId) return a.userId === b.userId;
  if (a.memberId && b.memberId) return a.memberId === b.memberId;
  // A friend's member row and an older game's typed name are one person, so two Alexes stay
  // apart only when both are known; a name alone never claims an account that's elsewhere.
  if ((a.memberId || a.userId) && (b.memberId || b.userId)) return false;
  return !!fold(a.name) && fold(a.name) === fold(b.name);
}

/**
 * Every deck each person played, once per person: newest game first, so a renamed member reads
 * as they're called now. A seat that played one of your Yama decks is left out (your decks are
 * listed as themselves), as are AI seats and temporary labels ("Player 2"). The server keeps a
 * seat's deck version only for the seated account's own deck or, on a guest's seat, a deck the
 * game's recorder lent. So a version on your own seat is yours; one on another account's seat is
 * theirs and stays; one on a guest's seat is yours only when it's one of your decks (its current
 * version, or a lent deck's name), since another member may have logged the game and lent theirs.
 */
export function playedDecks(games: GameRow[] | undefined, me?: string, mine: { name: string; current_version_id?: string | null }[] = []): PlayedDeck[] {
  const yourVersions = new Set(mine.flatMap((d) => (d.current_version_id ? [d.current_version_id] : [])));
  const yourNames = new Set(mine.map((d) => fold(d.name)));
  const out = new Map<string, PlayedDeck>();
  const newest = [...(games ?? [])].sort((a, b) => b.started_at.localeCompare(a.started_at));
  for (const g of newest) {
    for (const s of g.seats) {
      const player = s.display_name?.trim() ?? "";
      const yourDeck =
        !!s.deck_version_id &&
        (s.user_id ? s.user_id === me : yourVersions.has(s.deck_version_id) || (!!s.deck_label && yourNames.has(fold(s.deck_label))));
      if (s.ai_kind || yourDeck || !player || isPlaceholderName(player)) continue;
      const { commander, partner } = splitPair(s);
      const label = s.deck_label?.trim() ?? "";
      const commanders = [commander, partner].filter((c): c is string => !!c);
      const named = !!label && label !== commander && label !== commanders.join(" and ");
      const name = named ? label : commanders.join(" and ");
      if (!name) continue;
      // An account is one person in every playgroup; a member row only in its own.
      const person = s.user_id ? `u:${s.user_id}` : s.member_id ? `m:${s.member_id}` : `n:${fold(player)}`;
      const key = `${person}|${fold(name)}`;
      const had = out.get(key);
      if (had) {
        had.games += 1;
        continue;
      }
      out.set(key, { key, name, named, label: label || undefined, commanders, player, memberId: s.member_id ?? undefined, userId: s.user_id ?? undefined, games: 1, last: g.started_at });
    }
  }
  // A deck someone played under a typed name ("matt") and under their member row or account is
  // one row, when exactly one known person has that name and deck; otherwise it stays apart.
  const all = [...out.values()];
  const known = all.filter((d) => d.memberId || d.userId);
  const merged: PlayedDeck[] = [];
  for (const d of all) {
    if (d.memberId || d.userId) {
      merged.push(d);
      continue;
    }
    const into = known.filter((k) => fold(k.name) === fold(d.name) && fold(k.player) === fold(d.player));
    if (into.length !== 1) {
      merged.push(d);
      continue;
    }
    const k = into[0]!;
    k.games += d.games;
    if (d.last > k.last) k.last = d.last;
  }
  return merged;
}

/** Who played a deck, as a person to compare. */
export const playedBy = (d: PlayedDeck): DeckOwner => ({ name: d.player, memberId: d.memberId, userId: d.userId });

/**
 * One person's decks, their most played first (then the newest). A friend logged under their
 * member row in one game and by name in another has one list.
 */
export function decksOf(played: PlayedDeck[], who: DeckOwner): PlayedDeck[] {
  if (!fold(who.name) && !who.memberId && !who.userId) return [];
  const byDeck = new Map<string, PlayedDeck>();
  for (const d of played) {
    if (!samePerson(playedBy(d), who)) continue;
    const k = fold(d.name);
    const had = byDeck.get(k);
    if (!had) byDeck.set(k, { ...d });
    else byDeck.set(k, { ...had, games: had.games + d.games, last: had.last > d.last ? had.last : d.last });
  }
  return [...byDeck.values()].sort((a, b) => b.games - a.games || b.last.localeCompare(a.last));
}

/** "Matt, 3 games, last Oct 25". */
export function playedLine(d: PlayedDeck, whose = true): string {
  const day = fmtDate(d.last, { year: false });
  const games = d.games === 1 ? `played ${day}` : `${d.games} games, last ${day}`;
  return whose ? `${d.player}, ${games}` : games.charAt(0).toUpperCase() + games.slice(1);
}

/** Someone's name as a filter's label: "Matt's", "Chris's". */
export function possessive(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first ? `${first}'s` : "Theirs";
}
