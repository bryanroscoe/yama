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

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What one option does, as its hint: "Moves 3, adds 94 new copies." */
export function outcomeText(o: CollectOutcome): string {
  const parts: string[] = [];
  if (o.moved) parts.push(`moves ${o.moved}`);
  if (o.added) parts.push(`adds ${n(o.added, "new copy", "new copies")}`);
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
  const out = [`${n(p.cards, "card")} in the deck, ${p.in_box} already in its box.`];
  if (p.not_in_list > 0) out.push(`${n(p.not_in_list, "card")} in the box ${p.not_in_list === 1 ? "isn't" : "aren't"} in the list any more. Adding leaves ${p.not_in_list === 1 ? "it" : "them"} there.`);
  if (p.missing === 0) {
    out.push("Nothing to add: the box holds the whole list.");
    return out;
  }
  if (p.same_elsewhere > 0) {
    out.push(`You own the same printing of ${p.same_elsewhere} of the ${p.missing} missing in another box or binder.`);
  }
  if (p.proxies > 0) out.push(`${n(p.proxies, "card")} the deck marks as a proxy ${p.proxies === 1 ? "goes" : "go"} in as ${p.proxies === 1 ? "a proxy" : "proxies"}.`);
  if (p.no_printing.length) out.push(`Yama has no printing of ${p.no_printing.join(", ")}, so ${p.no_printing.length === 1 ? "it's" : "they're"} left out.`);
  return out;
}

/** The main button: "Add 97 cards", or with moves "Add 97 cards (3 moved)". */
export function buttonText(o: CollectOutcome): string {
  const total = o.added + o.moved;
  if (total === 0) return "Nothing to add";
  return `Add ${n(total, "card")}${o.moved ? ` (${o.moved} moved)` : ""}`;
}

/** "C21 263, foil, proxy. The deck's printing" for a card's line. */
export function printingText(l: Pick<CollectLine, "printing" | "proxy">): string {
  const p = l.printing;
  if (!p) return "No printing in Yama's card data";
  const bits = [`${p.set_code.toUpperCase()} ${p.collector_number}`];
  if (p.finish !== "nonfoil") bits.push(p.finish);
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
  if (!p.applied) return p.left_out ? `Nothing added. ${n(p.left_out, "card")} left out.` : `Nothing to add: ${p.box_name} already holds the deck's list.`;
  const parts: string[] = [];
  if (p.added) parts.push(`added ${n(p.added, "card")}`);
  if (p.moved) parts.push(`moved ${p.moved}`);
  const text = parts.join(" and ");
  const left = p.left_out ? ` ${p.left_out} left out.` : "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} into ${p.box_name}.${left}`;
}
