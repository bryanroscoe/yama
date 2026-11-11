// Fixing a collection row: another printing of the same card (picked, or scanned again), or
// deleting the row. These plan the ops; the server applies them in one transaction.

import type { CollectionItem, Printing } from "../api";

export type Op = Record<string, unknown> & { op_id: string; kind: string };

/**
 * Op ids for a screen's taps. The server applies an op id once, so the id has to outlive a send
 * that failed: the save may have gone through with only its answer lost, and the same tap again
 * must then be the same op, not a second copy (project review, 11 Nov 2026: every tap minted a new
 * id). `idFor(action)` gives one id per action until `saved(action)` says the server has it.
 */
export function opIds(newId: () => string = () => crypto.randomUUID()) {
  const unconfirmed = new Map<string, string>();
  return {
    idFor(action: string): string {
      let id = unconfirmed.get(action);
      if (!id) {
        id = newId();
        unconfirmed.set(action, id);
      }
      return id;
    },
    /** The server confirmed this action (all of them, with no argument): its next tap is a new op. */
    saved(action?: string) {
      if (action === undefined) unconfirmed.clear();
      else unconfirmed.delete(action);
    },
  };
}

/** Which copies a change is for: the whole row, or one copy split off it. */
export type Scope = "all" | "one";

/** The row's finish if the new printing comes in it, else that printing's first finish. */
export function finishFor(item: Pick<CollectionItem, "finish">, printing: Pick<Printing, "finishes">): string {
  if (printing.finishes.length === 0 || printing.finishes.includes(item.finish)) return item.finish;
  return printing.finishes[0]!;
}

/**
 * The op that files the row's copies (all, or one) under `printing`. The whole row is updated in
 * place, so it keeps its id, note and price paid (and merges into a matching row if there is one).
 * One copy is split off on the server, with its place, condition and price paid, and only if the
 * row still has a copy to split: a row deleted elsewhere meanwhile gains nothing.
 */
export function reprintOps(
  item: Pick<CollectionItem, "id" | "scryfall_id" | "qty" | "finish">,
  printing: Pick<Printing, "scryfall_id" | "lang" | "finishes">,
  scope: Scope,
  newId: () => string,
): Op[] {
  if (printing.scryfall_id === item.scryfall_id) return [];
  const op: Op = { op_id: newId(), kind: "update", item_id: item.id, scryfall_id: printing.scryfall_id, lang: printing.lang, finish: finishFor(item, printing) };
  if (scope === "one" && item.qty > 1) op.split = 1;
  return [op];
}

/** "The Lord of the Rings: Tales of Middle-earth (LTR) #258", with the language when not English. */
export function printingLabel(p: Pick<Printing, "set_name" | "set_code" | "collector_number" | "lang">): string {
  return `${p.set_name} (${p.set_code.toUpperCase()}) #${p.collector_number}${p.lang !== "en" ? `, ${p.lang}` : ""}`;
}

/** A finish in words: "regular", "foil", "etched foil". */
export function finishWord(finish: string): string {
  return finish === "nonfoil" ? "regular" : finish === "etched" ? "etched foil" : finish;
}

/** The finishes of the copies you own, in words: "regular", "foil", "regular and foil". */
export function ownedFinishes(finishes: Iterable<string>): string {
  const order = ["nonfoil", "foil", "etched"];
  const words = [...new Set(finishes)].sort((a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9)).map(finishWord);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The finishes a row can be set to: its printing's (when known), always including the row's own. */
export function finishChoices(current: string, printingFinishes: string[] | undefined): string[] {
  const list = printingFinishes && printingFinishes.length > 0 ? printingFinishes : ["nonfoil", "foil", "etched"];
  return list.includes(current) ? list : [current, ...list];
}
