import { plural } from "@yama/core";
// "Add to my collection" for a deck (server/src/collection/deck_box.rs): the preview the server
// sends (GET /api/decks/{id}/collect?same=) and the sentences the sheet shows for it.

export type SamePrinting = "move" | "add" | "skip";

export interface CollectOutcome {
  /** Copies moved into the deck box from another box, binder or list. */
  moved: number;
  /** New copies added. */
  added: number;
  /** Missing copies not added: the same printing is elsewhere, or Yama has no printing. */
  left_out: number;
}

export interface CollectPrinting {
  scryfall_id: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  finish: string;
  /** "deck": the printing the deck names (from an import); "default": Yama's pick. */
  from: "deck" | "default";
  image_small: string | null;
  /** What makes the printing special for a copy in this finish, in words ("Surge foil"). */
  special?: string | null;
}

export interface CollectElsewhere {
  item_id: string;
  container_id: string | null;
  /** "box: Bulk", or "unfiled". */
  place: string;
  qty: number;
}

export interface CollectLine extends CollectOutcome {
  oracle_id: string;
  name: string;
  qty: number;
  in_box: number;
  missing: number;
  printing: CollectPrinting | null;
  proxy: boolean;
  elsewhere: CollectElsewhere[];
}

export interface CollectPreview extends CollectOutcome {
  deck_id: string;
  deck_name: string;
  version_id: string | null;
  box_id: string | null;
  box_name: string;
  box_kind: string;
  box_exists: boolean;
  same_printing: SamePrinting;
  cards: number;
  in_box: number;
  missing: number;
  same_elsewhere: number;
  /** Copies in the box the list doesn't have; they stay. */
  not_in_list: number;
  options: Record<SamePrinting, CollectOutcome>;
  proxies: number;
  no_printing: string[];
  /** Only the cards the box is short of. */
  lines: CollectLine[];
  applied: boolean;
}

export const SAME_CHOICES: { value: SamePrinting; label: string }[] = [
  { value: "move", label: "Move them into the deck box" },
  { value: "add", label: "Leave them where they are and add new copies" },
  { value: "skip", label: "Leave them where they are and don't add those" },
];


/** What one option does, as its hint: "Moves 3, adds 94 new copies." */
export function outcomeText(o: CollectOutcome): string {
  const parts: string[] = [];
  if (o.moved) parts.push(`moves ${o.moved}`);
  if (o.added) parts.push(`adds ${plural(o.added, "new copy", "new copies")}`);
  if (o.left_out) parts.push(`leaves out ${o.left_out}`);
  if (!parts.length) return "Nothing to do.";
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Where the cards go: "Into the deck box Tricky Terrain, made now." */
export function boxText(p: Pick<CollectPreview, "box_name" | "box_kind" | "box_exists">): string {
  const kind = p.box_kind === "deck" ? "deck box" : p.box_kind;
  return `Into the ${kind} ${p.box_name}${p.box_exists ? "" : ", made now"}. The deck's list doesn't change.`;
}

/** The counts above the choice, one sentence each. */
export function summary(p: CollectPreview): string[] {
  const out = [`${plural(p.cards, "card")} in the deck, ${p.in_box} already in its box.`];
  if (p.not_in_list > 0) out.push(`${plural(p.not_in_list, "card")} in the box ${p.not_in_list === 1 ? "isn't" : "aren't"} in the list any more. Adding leaves ${p.not_in_list === 1 ? "it" : "them"} there.`);
  if (p.missing === 0) {
    out.push("Nothing to add: the box holds the whole list.");
    return out;
  }
  if (p.same_elsewhere > 0) {
    out.push(`You own the same printing of ${p.same_elsewhere} of the ${p.missing} missing in another box or binder.`);
  }
  if (p.proxies > 0) out.push(`${plural(p.proxies, "new copy", "new copies")} will be recorded as ${p.proxies === 1 ? "a proxy" : "proxies"}.`);
  if (p.no_printing.length) out.push(`Yama has no printing of ${p.no_printing.join(", ")}, so ${p.no_printing.length === 1 ? "it's" : "they're"} left out.`);
  return out;
}

/** The main button: "Add 97 cards", or with moves "Add 97 cards (3 moved)". */
export function buttonText(o: CollectOutcome): string {
  const total = o.added + o.moved;
  if (total === 0) return "Nothing to add";
  return `Add ${plural(total, "card")}${o.moved ? ` (${o.moved} moved)` : ""}`;
}

/** "C21 263, foil, proxy. The deck's printing", "Surge foil, MSC 40. The deck's printing" for a card's line. */
export function printingText(l: Pick<CollectLine, "printing" | "proxy">): string {
  const p = l.printing;
  if (!p) return "No printing in Yama's card data";
  const bits = [`${p.set_code.toUpperCase()} ${p.collector_number}`];
  if (p.special) bits.unshift(p.special);
  // A special foil already says foil.
  if (p.finish !== "nonfoil" && !(p.finish === "foil" && p.special && /\bfoil\b/i.test(p.special))) bits.push(p.finish);
  if (l.proxy) bits.push("proxy");
  return `${bits.join(", ")}. ${p.from === "deck" ? "The deck's printing" : "Default printing"}`;
}

/** The cards the chosen option touches, by what happens to them. */
export function groups(p: Pick<CollectPreview, "lines">): { add: CollectLine[]; move: CollectLine[]; leave: CollectLine[] } {
  return {
    add: p.lines.filter((l) => l.added > 0),
    move: p.lines.filter((l) => l.moved > 0),
    leave: p.lines.filter((l) => l.left_out > 0),
  };
}

/** After applying: "Added 94 cards and moved 3 into Tricky Terrain." */
export function resultText(p: CollectPreview): string {
  if (!p.applied) return p.left_out ? `Nothing added. ${plural(p.left_out, "card")} left out.` : `Nothing to add: ${p.box_name} already holds the deck's list.`;
  const parts: string[] = [];
  if (p.added) parts.push(`added ${plural(p.added, "card")}`);
  if (p.moved) parts.push(`moved ${p.moved}`);
  const text = parts.join(" and ");
  const left = p.left_out ? ` ${p.left_out} left out.` : "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} into ${p.box_name}.${left}`;
}

/**
 * Why the sheet opens by itself, carried in the navigation's state beside `?collect=1`: a deck
 * was just added ("import"), or an existing deck's list was just saved ("edit"). A link someone
 * pressed ("Add to my collection") carries none.
 */
export type CollectAfter = "import" | "edit";

/** The navigation state that says why `?collect=1` is there. */
export const collectState = (after: CollectAfter): { collectAfter: CollectAfter } => ({ collectAfter: after });

/** That reason, read back from a location's state. */
export function collectAfter(state: unknown): CollectAfter | null {
  const after = (state as { collectAfter?: unknown } | null | undefined)?.collectAfter;
  return after === "import" || after === "edit" ? after : null;
}

/**
 * After a saved edit: the one line that offers the cards the deck's box is short of, or null
 * when there is nothing to offer. Only a deck whose box already holds cards is asked: someone
 * who keeps the deck in their collection wants the new cards there too, and someone who only
 * keeps the list is never asked again after an edit.
 */
export function offerLine(p: Pick<CollectPreview, "box_exists" | "in_box" | "added" | "moved">): { text: string; action: string } | null {
  const n = p.added + p.moved;
  if (!p.box_exists || p.in_box <= 0 || n <= 0) return null;
  return {
    text: `${plural(n, "card")} in this list ${n === 1 ? "isn't" : "aren't"} in the deck's box yet.`,
    action: n === 1 ? "Add it to your collection" : "Add them to your collection",
  };
}

/** The offer's heading: "Add these 100 cards to your collection?", counting what the box is short of. */
export function offerTitle(p: Pick<CollectPreview, "missing">): string {
  if (p.missing <= 0) return "Add to my collection";
  return p.missing === 1 ? "Add this card to your collection?" : `Add these ${p.missing} cards to your collection?`;
}

/**
 * Whether the sheet on screen is asking anything: it has an answer, and some choice in it adds or
 * moves a card. Closing a sheet that is still checking, failed, or has nothing to add declines
 * nothing, so it isn't remembered as "Not now".
 */
export function offerMade(p: Pick<CollectPreview, "added" | "moved" | "options"> | null | undefined): boolean {
  if (!p) return false;
  return [p, ...Object.values(p.options ?? {})].some((o) => o.added + o.moved > 0);
}

type Store = Pick<Storage, "getItem" | "setItem">;

/** The decks whose offer was answered "Not now" on this device. */
const NOT_NOW = "yama.collect.notnow";
/** Enough for anyone's decks; the oldest answers go first. */
const NOT_NOW_MAX = 300;

const deviceStore = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

function declinedDecks(storage: Store | null): string[] {
  try {
    const v: unknown = JSON.parse(storage?.getItem(NOT_NOW) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Whether "Not now" was answered for this deck on this device, so the offer isn't made by itself again. */
export function offerDeclined(deckId: string, storage: Store | null = deviceStore()): boolean {
  return declinedDecks(storage).includes(deckId);
}

/** Remember "Not now" for this deck on this device. More > Add to collection still opens the sheet. */
export function declineOffer(deckId: string, storage: Store | null = deviceStore()): void {
  try {
    const next = [...declinedDecks(storage).filter((id) => id !== deckId), deckId].slice(-NOT_NOW_MAX);
    storage?.setItem(NOT_NOW, JSON.stringify(next));
  } catch {
    // A browser that keeps nothing asks again next time.
  }
}

/** The deck's cards were added after all: later edits may offer their new cards again. */
export function forgetDeclined(deckId: string, storage: Store | null = deviceStore()): void {
  try {
    const kept = declinedDecks(storage);
    if (kept.includes(deckId)) storage?.setItem(NOT_NOW, JSON.stringify(kept.filter((id) => id !== deckId)));
  } catch {
    // Nothing was kept, so there is nothing to forget.
  }
}
