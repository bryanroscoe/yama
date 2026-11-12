// Check a deck without an account (/check; Bryan, 12 Nov 2026). The list someone pastes is kept
// in this browser only, the way games counted without an account are (table/store.ts): it is
// still here on the next visit, and Yama's server keeps nothing of it. Each visit sends the list
// to `POST /api/public/deck-check` (server/src/list_check.rs), which answers from card data and
// market prices alone and keeps nothing of the list; the answer isn't kept either, so prices and legality
// are current. Saving it, signed in and with who can see it chosen on the page, makes it an
// ordinary deck of the account (`POST /api/decks`) and removes it from here.

import type { Card, CheapestPrinting, DeckAnalysis, DeckCard, DeckEntry, DeckView, SinglesValue, Visibility } from "../api";

/** The server's limits (list_check.rs), checked here first so the page can say what's wrong. */
export const MAX_LINES = 300;
export const MAX_TEXT_BYTES = 60_000;
/** A deck's name, in characters (decks.rs DECK_NAME_MAX). */
export const NAME_MAX = 120;

const KEY = "yama.check.deck";

/** The one list this browser keeps. */
export interface GuestDeck {
  /** What the person called it; empty means "name it after its commander". */
  name: string;
  /** The list as pasted. */
  text: string;
  /** The commander (or two) picked on the page, by oracle id; empty means Yama's reading. */
  commanders: string[];
  /** Sent with the save, so the same save sent twice (a lost reply) makes one deck. It names
   *  one list under one name with one commander: a change to any of them gets a new id
   *  (`changed`), because the server refuses an id sent again for something else. */
  opId: string;
}

/** One card of the answer: the deck page's entry without anything of an account's. */
export interface CheckedCard extends DeckCard {
  card: Card | null;
  cheapest_usd: number | null;
  cheapest_printing: CheapestPrinting | null;
  produced_mana: string | null;
  /** It could be the commander. */
  can_lead: boolean;
}

/** `POST /api/public/deck-check`. */
export interface ListCheck {
  cards: CheckedCard[];
  /** Names that matched no card, as written; counted nowhere. */
  unknown: string[];
  /** No Commander heading and no pick: the commander in `cards` is Yama's guess, or missing. */
  commander_guessed: boolean;
  validation: DeckView["validation"];
  game_changers: string[] | null;
  game_changers_as_of: string | null;
  reserved_list: string[] | null;
  reserved_list_as_of: string | null;
  singles_value: SinglesValue;
  analysis: DeckAnalysis | null;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The list while the browser won't keep it (storage blocked or full): held for this page load,
 *  so it survives going to the sign-in page and back, and is gone on a reload. */
let unkept: GuestDeck | null = null;

const store = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const newOpId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `check-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** A new list to keep: its own op id, no commander picked. */
export function newGuestDeck(text: string, name = ""): GuestDeck {
  return { name: name.trim().slice(0, NAME_MAX), text, commanders: [], opId: newOpId() };
}

/** The list with something about it changed (its name, its commander): what would be saved is
 *  now different, so it is a new save with its own id. Nothing changed keeps the id. */
export function changed(deck: GuestDeck, change: Partial<Pick<GuestDeck, "name" | "commanders">>): GuestDeck {
  const next = { ...deck, ...change };
  const same = next.name === deck.name && next.commanders.join("\n") === deck.commanders.join("\n");
  return same ? deck : { ...next, opId: newOpId() };
}

/** The kept list, or null: none, storage blocked, or something that isn't one (it is removed). */
export function readGuestDeck(storage?: Store | null): GuestDeck | null {
  if (storage === undefined) {
    if (unkept) return unkept;
    storage = store();
  }
  if (!storage) return null;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<GuestDeck> | null;
    if (!v || typeof v.text !== "string" || !v.text.trim() || typeof v.opId !== "string" || !v.opId) {
      storage.removeItem(KEY);
      return null;
    }
    return {
      name: typeof v.name === "string" ? v.name.slice(0, NAME_MAX) : "",
      text: v.text,
      commanders: Array.isArray(v.commanders) ? v.commanders.filter((c): c is string => typeof c === "string").slice(0, 2) : [],
      opId: v.opId,
    };
  } catch {
    return null;
  }
}

/** Keep the list (or forget it with null). False when the browser wouldn't keep it. */
export function writeGuestDeck(deck: GuestDeck | null, storage?: Store | null): boolean {
  if (storage !== undefined) return put(deck, storage);
  const kept = put(deck, store());
  unkept = kept ? null : deck;
  return kept;
}

function put(deck: GuestDeck | null, storage: Store | null): boolean {
  if (!storage) return false;
  try {
    if (deck) storage.setItem(KEY, JSON.stringify(deck));
    else storage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** Whether this browser is keeping the list, as far as the last write could tell. */
export const keptInBrowser = () => unkept === null;

/** What stops a list from being checked, in words, or null. */
export function listProblem(text: string): string | null {
  if (!text.trim()) return "Paste a deck list first.";
  // Counted as the server counts them: a last line's own line break isn't another line.
  if (text.replace(/\r?\n$/, "").split("\n").length > MAX_LINES) return `That's more than ${MAX_LINES} lines. Check one deck at a time, and leave out long notes.`;
  if (new TextEncoder().encode(text).length > MAX_TEXT_BYTES) return "That's too much text for one deck.";
  return null;
}

const commandersOf = (check: Pick<ListCheck, "cards">) => check.cards.filter((c) => c.board === "commander");

/** The list's name on the page and when saved: theirs, else its commander's, else a plain one. */
export function deckName(deck: Pick<GuestDeck, "name">, check: Pick<ListCheck, "cards"> | null): string {
  const own = deck.name.trim();
  if (own) return own.slice(0, NAME_MAX);
  const leaders = check ? commandersOf(check).map((c) => c.name) : [];
  return (leaders.join(" and ") || "Checked deck").slice(0, NAME_MAX);
}

/** The cards that could lead the deck, once each, in list order (the sideboard left out). */
export function commanderChoices(check: Pick<ListCheck, "cards">): CheckedCard[] {
  const seen = new Set<string>();
  return check.cards.filter((c) => c.can_lead && c.board !== "side" && !seen.has(c.oracle_id) && !!seen.add(c.oracle_id));
}

/** The answer as the deck page's components read a deck. Nothing here belongs to an account:
 *  no copies owned, no container, no id, no saved version. */
export function asDeckView(name: string, check: ListCheck): DeckView {
  const cards: DeckEntry[] = check.cards.map((c) => ({ ...c, owned: 0, in_deck_container: 0, proxies: 0, locations: {}, needed: 0, printing: null }));
  return {
    id: "",
    name,
    container_id: null,
    version_id: null,
    bracket: null,
    parent_id: null,
    configuration: null,
    visibility: "private",
    share_token: null,
    configurations: [],
    cards,
    validation: check.validation,
    ownership: { cards: check.validation.total, owned: 0, needed: 0, needed_cost_usd: 0, needed_without_price: 0, price_date: check.singles_value.newest_date },
    game_changers: check.game_changers,
    game_changers_as_of: check.game_changers_as_of,
    reserved_list: check.reserved_list,
    reserved_list_as_of: check.reserved_list_as_of,
    singles_value: check.singles_value,
  };
}

/** `POST /api/decks` for the checked list: the cards as Yama read them (the server names each by
 *  its id again), under the list's own op id, with who can see the deck as the person chose on
 *  the page. The choice is always sent: the page never leaves it to a default nobody saw. */
export function saveRequest(deck: GuestDeck, check: ListCheck, visibility: Visibility): { name: string; cards: DeckCard[]; op_id: string; visibility: Visibility } {
  return {
    name: deckName(deck, check),
    cards: check.cards.map(({ oracle_id, name, qty, board }) => ({ oracle_id, name, qty, board })),
    op_id: deck.opId,
    visibility,
  };
}

/** What the Bracket tile says: the brackets the list plays like, as "2" or "2 to 3". */
export function playsLikeRange(a: Pick<DeckAnalysis, "power_bracket" | "bracket">): string {
  const [low, high] = a.bracket?.plays_like ?? [a.power_bracket, a.power_bracket];
  return low === high ? String(low) : `${low} to ${high}`;
}

/** The least bracket Wizards' card rules allow, in a few words, when the analysis could read one. */
export function rulesNote(a: Pick<DeckAnalysis, "bracket">): string | null {
  const rules = a.bracket?.rules;
  return rules == null ? null : `Card rules allow ${rules} or higher`;
}
