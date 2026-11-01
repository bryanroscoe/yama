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
 * Ops that file the row's copies (all, or one) under `printing`. The whole row is updated in place,
 * so it keeps its id, note and price paid (and merges into a matching row if there is one); one
 * copy is taken off the row and added as the new printing, in the same place and condition, with
 * its price paid (the note stays with the row).
 */
export function reprintOps(
  item: CollectionItem & { altered?: boolean; signed?: boolean; misprint?: boolean; purchase_currency?: string | null },
  printing: Pick<Printing, "scryfall_id" | "lang" | "finishes">,
  scope: Scope,
  newId: () => string,
): Op[] {
  if (printing.scryfall_id === item.scryfall_id) return [];
  const finish = finishFor(item, printing);
  if (scope === "all" || item.qty <= 1) {
    return [{ op_id: newId(), kind: "update", item_id: item.id, scryfall_id: printing.scryfall_id, lang: printing.lang, finish }];
  }
  return [
    { op_id: newId(), kind: "adjust", item_id: item.id, delta: -1 },
    {
      op_id: newId(),
      kind: "add",
      scryfall_id: printing.scryfall_id,
      qty: 1,
      condition: item.condition,
      finish,
      lang: printing.lang,
      altered: item.altered ?? false,
      signed: item.signed ?? false,
      misprint: item.misprint ?? false,
      proxy: item.proxy,
      container_id: item.container_id,
      purchase_price: item.purchase_price,
      purchase_currency: item.purchase_currency ?? null,
    },
  ];
}

/** "The Lord of the Rings: Tales of Middle-earth (LTR) #258", with the language when not English. */
export function printingLabel(p: Pick<Printing, "set_name" | "set_code" | "collector_number" | "lang">): string {
  return `${p.set_name} (${p.set_code.toUpperCase()}) #${p.collector_number}${p.lang !== "en" ? `, ${p.lang}` : ""}`;
}
