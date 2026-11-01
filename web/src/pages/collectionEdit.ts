// Fixing a collection row: another printing of the same card (picked, or scanned again), or
// deleting the row. These plan the ops; the server applies them in one transaction.

import type { CollectionItem, Printing } from "../api";

export type Op = Record<string, unknown> & { op_id: string; kind: string };

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
