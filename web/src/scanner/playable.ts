// Which scanned cards see play in Commander (Bryan, 16 Nov 2026: "It'd be great to have those
// flagged"), so a playable card stands out from bulk while scanning. Read from the offline card
// list the scanner already keeps (its Game Changer flag and Scryfall's EDHREC rank), on the
// device, with no request per card. The rank says how many Commander decks on EDHREC run the
// card, against every other card: popularity, not power, and the labels say so.
//
// A cEDH list (the top cards in competitive decks) is a separate source another thread is
// gathering; it slots in here as another tag when it lands.

import { useEffect, useState } from "react";
import { offlineCard } from "../offline/cards";

export interface Playability {
  /** Scryfall's EDHREC rank: 1 is the card in the most Commander decks. Null when unranked. */
  rank: number | null;
  /** On the Game Changer list; null when the saved card list doesn't carry the flags. */
  gameChanger: boolean | null;
}

/** In the top thousand: a staple, in a large share of all decks. */
export const STAPLE_RANK = 1000;
/**
 * In the top five thousand: seen in real decks, not just bulk. Checked against Scryfall's order
 * on 16 Nov 2026: Batterskull sits just past it (about 5,100), Grizzly Bears near 8,150.
 */
export const PLAYED_RANK = 5000;

export type PlayTag = "game-changer" | "staple" | "played";

/** The one tag a card's tile wears, strongest first; null for a card that's rarely played. */
export function playTag(p: Playability | null | undefined): PlayTag | null {
  if (!p) return null;
  if (p.gameChanger) return "game-changer";
  if (p.rank == null) return null;
  if (p.rank <= STAPLE_RANK) return "staple";
  if (p.rank <= PLAYED_RANK) return "played";
  return null;
}

export const PLAY_WORD: Record<PlayTag, string> = { "game-changer": "Game Changer", staple: "Staple", played: "Played" };

/** The sentence under the card: where the tag comes from, in words. Null with nothing to say. */
export function playLine(p: Playability | null | undefined): string | null {
  if (!p) return null;
  const gc = p.gameChanger ? "On the Game Changer list." : null;
  const rank = p.rank == null ? null : p.rank > PLAYED_RANK ? "Rarely in Commander decks." : "Ranked by how many Commander decks run it.";
  return [gc, rank].filter(Boolean).join(" ") || null;
}

const known = new Map<string, Promise<Playability | null>>();

/** One card's playability from the saved card list; null when the list or the card isn't there. */
export function playabilityOf(oracleId: string): Promise<Playability | null> {
  let p = known.get(oracleId);
  if (!p) {
    p = offlineCard(oracleId).then(
      (c) => (c ? { rank: c.edhrec_rank ?? null, gameChanger: c.game_changer ?? null } : null),
      () => null,
    );
    // A miss (no saved list yet) is asked again next time, rather than remembered.
    void p.then((v) => {
      if (!v) known.delete(oracleId);
    });
    known.set(oracleId, p);
  }
  return p;
}

/** Playability for each oracle id given, filled in as the saved list answers. */
export function usePlayability(ids: readonly (string | null | undefined)[]): ReadonlyMap<string, Playability> {
  const [found, setFound] = useState<ReadonlyMap<string, Playability>>(() => new Map());
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort().join(",");
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(",") : []) {
      if (found.has(id)) continue;
      void playabilityOf(id).then((p) => {
        if (live && p) setFound((m) => (m.has(id) ? m : new Map(m).set(id, p)));
      });
    }
    return () => {
      live = false;
    };
    // `found` is read to skip what's known; asking again on its change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return found;
}

/** Remember a card's playability without asking the saved list: the scanner's dev page only. */
export function rememberPlayability(oracleId: string, p: Playability) {
  known.set(oracleId, Promise.resolve(p));
}
