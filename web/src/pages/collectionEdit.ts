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

// ── a copy's language, and whether it's signed or altered ──────────────────

/** The languages cards are printed in, by Scryfall's code (server/src/collection.rs `LANGS`). */
export const LANGUAGES: [string, string][] = [
  ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"], ["ja", "Japanese"], ["ko", "Korean"],
  ["ru", "Russian"], ["zhs", "Simplified Chinese"], ["zht", "Traditional Chinese"], ["he", "Hebrew"], ["la", "Latin"], ["grc", "Ancient Greek"], ["ar", "Arabic"],
  ["sa", "Sanskrit"], ["ph", "Phyrexian"], ["qya", "Quenya"],
];

/** "Japanese" for "ja"; a code Yama has no name for is shown as it is. */
export function languageName(code: string): string {
  return LANGUAGES.find(([c]) => c === code)?.[1] ?? code;
}

/** The languages a row can be set to: the list, and the row's own if it's one the list doesn't have. */
export function languageChoices(current: string): [string, string][] {
  return LANGUAGES.some(([c]) => c === current) ? LANGUAGES : [[current, current], ...LANGUAGES];
}

/** What marks a copy as its own: the language it's printed in, and whether it's signed or altered. */
export interface Mark {
  lang?: string;
  signed?: boolean;
  altered?: boolean;
}

/**
 * The op that marks the row's copies (all, or one split off): a language, signed, altered. A new
 * language also files the copies under that language's printing of the same set and number, when
 * Yama has it, so the picture and the price are that printing's. Nothing changed: no op.
 */
export function markOps(
  item: Pick<CollectionItem, "id" | "scryfall_id" | "qty" | "lang" | "signed" | "altered" | "set_code" | "collector_number">,
  mark: Mark,
  scope: Scope,
  printings: Pick<Printing, "scryfall_id" | "set_code" | "collector_number" | "lang">[] | undefined,
  newId: () => string,
): Op[] {
  const op: Op = { op_id: "", kind: "update", item_id: item.id };
  if (mark.lang !== undefined && mark.lang !== item.lang) {
    op.lang = mark.lang;
    const same = printings?.find((p) => p.lang === mark.lang && p.set_code === item.set_code && p.collector_number === item.collector_number);
    if (same && same.scryfall_id !== item.scryfall_id) op.scryfall_id = same.scryfall_id;
  }
  if (mark.signed !== undefined && mark.signed !== !!item.signed) op.signed = mark.signed;
  if (mark.altered !== undefined && mark.altered !== !!item.altered) op.altered = mark.altered;
  if (Object.keys(op).length === 3) return [];
  if (scope === "one" && item.qty > 1) op.split = 1;
  op.op_id = newId();
  return [op];
}

/** What the page says after a mark is saved: "One Sol Ring is now signed." */
export function markDone(item: Pick<CollectionItem, "name" | "qty">, mark: Mark, scope: Scope): string {
  const what = [
    mark.lang !== undefined ? `in ${languageName(mark.lang)}` : null,
    mark.signed !== undefined ? (mark.signed ? "signed" : "not signed") : null,
    mark.altered !== undefined ? (mark.altered ? "altered" : "not altered") : null,
  ].filter(Boolean);
  const name = item.name ?? "The card";
  const which = item.qty === 1 ? name : scope === "one" ? `One ${name}` : `Every ${name} in this row`;
  return `${which} is now ${what.join(" and ")}.`;
}

/** "Japanese, signed, altered" for the sheet's line about the copy; English and unmarked say nothing. */
export function markWords(item: Pick<CollectionItem, "lang" | "signed" | "altered">): string[] {
  return [item.lang !== "en" ? languageName(item.lang) : null, item.signed ? "signed" : null, item.altered ? "altered" : null].filter((x): x is string => !!x);
}
