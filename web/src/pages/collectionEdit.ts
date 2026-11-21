// Fixing a collection row: another printing of the same card (picked, or scanned again), or
// deleting the row. These plan the ops; the server applies them in one transaction.

import { plural, priceSource, treatmentLabel, usd } from "@yama/core";
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

/**
 * "The Lord of the Rings: Tales of Middle-earth (LTR) #258", with the language when not English,
 * and what makes it special first: "Surge foil, Marvel Super Heroes Commander (MSC) #40". With a
 * finish, only what a copy in that finish is (a regular copy isn't a surge foil).
 */
export function printingLabel(p: Pick<Printing, "set_name" | "set_code" | "collector_number" | "lang" | "promo_types" | "frame_effects" | "border_color" | "full_art">, finish?: string): string {
  const special = treatmentLabel(p, finish);
  return `${special ? `${special}, ` : ""}${p.set_name} (${p.set_code.toUpperCase()}) #${p.collector_number}${p.lang !== "en" ? `, ${p.lang}` : ""}`;
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
 * The op that marks the row's copies (all, or one split off): a language, signed, altered.
 * Nothing changed: no op. The printing stays as it is: Yama's card data has one entry for each
 * set and number, so there is no other-language printing to file the copy under.
 */
export function markOps(item: Pick<CollectionItem, "id" | "qty" | "lang" | "signed" | "altered">, mark: Mark, scope: Scope, newId: () => string): Op[] {
  const op: Op = { op_id: "", kind: "update", item_id: item.id };
  if (mark.lang !== undefined && mark.lang !== item.lang) op.lang = mark.lang;
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
    mark.signed === true ? "signed" : null,
    mark.altered === true ? "altered" : null,
  ].filter(Boolean);
  const gone = [mark.signed === false ? "signed" : null, mark.altered === false ? "altered" : null].filter(Boolean);
  const name = item.name ?? "The card";
  const which = item.qty === 1 ? name : scope === "one" ? `One ${name}` : `Every ${name} in this row`;
  const now = what.length ? `is now ${what.join(" and ")}` : "";
  const no = gone.length ? `is no longer ${gone.join(" or ")}` : "";
  return `${which} ${[now, no].filter(Boolean).join(" and ")}.`;
}

/** "Japanese, signed, altered" for a copy's line in the sheet and its tags in the list; English and unmarked say nothing. */
export function markWords(item: Pick<CollectionItem, "lang" | "signed" | "altered">): string[] {
  return [item.lang !== "en" ? languageName(item.lang) : null, item.signed ? "signed" : null, item.altered ? "altered" : null].filter((x): x is string => !!x);
}

// ── a copy's condition, what a row is worth, and what a saved change says ───

/** The conditions a copy can be in, best first, by the code stores use. */
export const CONDITION_CODES = ["NM", "LP", "MP", "HP", "DMG"];
const CONDITION_WORDS: Record<string, string> = { NM: "near mint", LP: "lightly played", MP: "moderately played", HP: "heavily played", DMG: "damaged" };

/** "near mint" for "NM"; a code Yama has no words for is shown as it is. */
export function conditionWord(code: string): string {
  return CONDITION_WORDS[code] ?? code;
}

/** "Near mint (NM)": the words first, with the code a store's list uses. */
export function conditionLabel(code: string): string {
  const words = CONDITION_WORDS[code];
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)} (${code})` : code;
}

/**
 * How many copies a row holds and what one is worth, with the price's source and date:
 * "6 copies, $0.19 each (TCGplayer market via Scryfall, Nov 20)". A proxy has no value of its
 * own, so the price is said to be the real card's; a missing price stays missing.
 * `known` false: the price isn't known yet (the copy just changed finish, say), so only the count
 * is said, never the old price or "no market price".
 */
export function worthLine(item: Pick<CollectionItem, "qty" | "proxy" | "unit_price_usd" | "price_date">, known = true): string {
  if (!known) return item.proxy ? plural(item.qty, "proxy", "proxies") : plural(item.qty, "copy", "copies");
  const priced = item.unit_price_usd != null;
  const source = priceSource(item.price_date);
  if (item.proxy) return `${plural(item.qty, "proxy", "proxies")}${priced ? `. A real copy is ${usd(item.unit_price_usd)} (${source})` : ""}`;
  const copies = plural(item.qty, "copy", "copies");
  if (!priced) return `${copies}, no market price`;
  return `${copies}, ${usd(item.unit_price_usd)}${item.qty > 1 ? " each" : ""} (${source})`;
}

/** What a row's sheet can change about its copies in one go. */
export interface CopyChange {
  container_id?: string | null;
  condition?: string;
  finish?: string;
  proxy?: boolean;
}

/**
 * The op that changes the row's copies (all, or one split off into its own row): where they're
 * kept, their condition, their finish, whether they're proxies.
 */
export function changeOps(item: Pick<CollectionItem, "id" | "qty">, change: CopyChange, scope: Scope, newId: () => string): Op[] {
  const op: Op = { op_id: newId(), kind: "update", item_id: item.id, ...change };
  if (scope === "one" && item.qty > 1) op.split = 1;
  return [op];
}

/**
 * What the sheet says once a change is saved: "One Sol Ring is now in Trade binder. The other 5
 * are unchanged." `place` is the new place's name (null: not filed anywhere).
 */
export function changeDone(item: Pick<CollectionItem, "name" | "qty">, change: CopyChange, scope: Scope, place?: string | null): string {
  const one = item.qty === 1 || scope === "one";
  const name = item.name ?? "The card";
  const which = item.qty === 1 ? name : one ? `One ${name}` : `All ${item.qty} copies of ${name}`;
  const what = [
    change.container_id !== undefined ? (change.container_id ? `in ${place ?? "its new place"}` : "not filed anywhere") : null,
    change.condition !== undefined ? conditionWord(change.condition) : null,
    change.finish !== undefined ? finishWord(change.finish) : null,
    change.proxy === true ? (one ? "marked as a proxy" : "marked as proxies") : null,
    change.proxy === false ? (one ? "marked as a real card" : "marked as real cards") : null,
  ].filter(Boolean);
  const rest = item.qty - 1;
  const left = scope === "one" && rest > 0 ? ` The other ${rest === 1 ? "one is" : `${rest} are`} unchanged.` : "";
  return `${which} ${one ? "is" : "are"} now ${what.join(" and ")}.${left}`;
}

/** What a saved change did to a row: fields it set, or (from the row as it is now) what they become. */
export type RowChange = Partial<CollectionItem> | ((cur: CollectionItem) => Partial<CollectionItem>);

/**
 * The row once a saved change has landed. It starts from the row as it is now (`cur`), not as
 * the tap saw it: the row may have been read again in between, with another count. Null is a
 * change to one copy split off the row, which only loses that copy. The market price belongs to
 * the printing and finish, so a change of either that brings no price of its own leaves it
 * unknown (`priced` false, and blank) until the row is read again.
 */
export function landedRow(cur: CollectionItem, change: RowChange | null): { row: CollectionItem; priced: boolean } {
  if (!change) return { row: { ...cur, qty: cur.qty - 1 }, priced: true };
  const set = typeof change === "function" ? change(cur) : change;
  const row = { ...cur, ...set };
  const priced = (row.finish === cur.finish && row.scryfall_id === cur.scryfall_id) || "unit_price_usd" in set;
  return { row: priced ? row : { ...row, unit_price_usd: null, price_date: null }, priced };
}

/** Whether two rows hold the same kind of copy in the same place: how a row is found again after a change. */
export function sameCopy(
  a: Pick<CollectionItem, "scryfall_id" | "condition" | "finish" | "lang" | "proxy" | "altered" | "signed" | "misprint" | "container_id">,
  b: Pick<CollectionItem, "scryfall_id" | "condition" | "finish" | "lang" | "proxy" | "altered" | "signed" | "misprint" | "container_id">,
): boolean {
  return (
    a.scryfall_id === b.scryfall_id && a.condition === b.condition && a.finish === b.finish && a.lang === b.lang && a.proxy === b.proxy &&
    !!a.altered === !!b.altered && !!a.signed === !!b.signed && !!a.misprint === !!b.misprint && (a.container_id ?? null) === (b.container_id ?? null)
  );
}
