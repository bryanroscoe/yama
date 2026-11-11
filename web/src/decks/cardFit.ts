// Add cards (Edit the list): what a search result says about a card before it goes in the list.
import { identityKeys, MANA, plural } from "@yama/core";
import type { Card } from "../api";

/** A search result: the card, with how many copies the person owns (`/api/cards/search`). */
export type Hit = Card & { owned?: number; owned_in?: string | null };

/** The color identity these commanders give a deck ("WUG"; "" for colorless ones), or null with no commander. */
export function identityOf(commanders: { color_identity: string }[]): string | null {
  if (!commanders.length) return null;
  const all = commanders.map((c) => c.color_identity).join("");
  return "WUBRG".split("").filter((k) => all.includes(k)).join("");
}

/** "red", "black and red", "white, blue and black". */
function wordList(words: string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words.join("");
}

export interface Fit {
  ok: boolean;
  text: string;
}

/**
 * Whether the card may go in this deck: Commander's banned list and the commander's color
 * identity. With no commander chosen yet only the format's own legality is known.
 */
export function fitFor(card: Pick<Card, "legalities" | "color_identity">, identity: string | null): Fit {
  const status = card.legalities?.commander;
  if (status === "banned") return { ok: false, text: "Banned in Commander" };
  // A saved offline card may carry no legalities: unknown, so nothing is claimed about it.
  if (status && status !== "legal") return { ok: false, text: "Not legal in Commander" };
  if (identity === null) return { ok: true, text: status ? "Legal in Commander" : "" };
  const outside = identityKeys(card.color_identity).filter((k) => k !== "C" && !identity.includes(k));
  if (outside.length) return { ok: false, text: `Outside your commander's colors (${wordList(outside.map((k) => MANA[k].name.toLowerCase()))})` };
  return { ok: true, text: status ? "Legal in this deck" : "In your commander's colors" };
}

/** "You own 2 (in Trade binder)" or "Not in your collection"; nothing when ownership isn't known (offline). */
export function ownedText(hit: Hit): string {
  if (hit.owned === undefined) return "";
  if (hit.owned <= 0) return "Not in your collection";
  return `You own ${hit.owned}${hit.owned_in ? ` (in ${hit.owned_in})` : ""}`;
}

/** A card a Commander deck may hold more than one of: a basic land, or one whose text says so. */
export function anyNumber(card: Pick<Card, "type_line" | "oracle_text">): boolean {
  return /\bBasic\b/.test(card.type_line.split(" // ")[0]!) || /A deck can have (any number of|up to \w+) cards named/i.test(card.oracle_text);
}

/** "In the list" for one copy, "3 in the list" for more. */
export function inListText(copies: number): string {
  return copies === 1 ? "In the list" : `${copies} in the list`;
}

/** "Showing the 12 most played of 1,204 matches." */
export function moreText(total: number, shown: number): string {
  return total > shown ? `Showing the ${shown} most played of ${plural(total, "match", "matches")}.` : "";
}
