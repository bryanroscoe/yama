import { count } from "@yama/core";
// Lists of cards to sell, in the formats store buylists take. Each format follows the platform's
// own documentation, read 2026-11-02:
// - SortSwift (https://sortswift.com/docs/buylist/csv-format-requirements): a CSV with a Scryfall
//   ID (matched directly) or a Card Name, plus Quantity; optional Condition (NM, LP, MP, HP, DM),
//   Printing (Normal, Foil, Etched), Language and Notes. Its languages
//   (https://sortswift.com/docs/inventory/can-i-import-non-english-cards-via-csv): EN, ES, FR, DE,
//   IT, PT, JP, KR, RU, ZH-S, ZH-T.
// - Storepass (https://admin.storepass.co/support/documentation/6U6oso1E2f): Bulk Submission takes
//   pasted lines with the quantity first ("2 Lightning Bolt"); printing and condition are chosen on
//   the store's page.
// - Card Kingdom (https://www.cardkingdom.com/static/csvImport): "Title" (in quotes), Edition (the
//   set's name), Foil (1 or 0) and Quantity, no header row; English cards only (and no etched
//   foils, which the file can't tell from foils); at most 500 lines and 5,000 cards.
// The store's page matches each line and shows its offer before anything is sent.

export type SellFormat = "sortswift" | "storepass" | "cardkingdom";

/** What a sell list needs from a collection row. */
export interface SellCard {
  id: string;
  scryfall_id: string;
  name: string | null;
  set_code: string | null;
  set_name: string | null;
  collector_number: string | null;
  qty: number;
  condition: string;
  finish: string;
  lang: string;
  proxy: boolean;
  altered?: boolean;
  signed?: boolean;
  misprint?: boolean;
}

export interface SellFormatInfo {
  label: string;
  /** Where the file goes, in the store's words. */
  how: string;
  file: string;
  mime: string;
  /** Pasted rather than uploaded, so Copy comes first. */
  paste: boolean;
}

export const SELL_FORMATS: Record<SellFormat, SellFormatInfo> = {
  sortswift: {
    label: "SortSwift",
    how: "For buylists that say Powered by SortSwift. Upload the file from the buylist's CSV upload; it matches each card by its Scryfall ID and keeps its condition, finish and language. The platform's name is at the foot of the store's buylist page.",
    file: "yama-sell-sortswift.csv",
    mime: "text/csv",
    paste: false,
  },
  storepass: {
    label: "Storepass",
    how: "For buylists that say Powered by Storepass. Paste it into Bulk Submission, then pick each card's printing and condition on the store's page: the list carries only names. The platform's name is at the foot of the store's buylist page.",
    file: "yama-sell-list.txt",
    mime: "text/plain",
    paste: true,
  },
  cardkingdom: {
    label: "Card Kingdom",
    how: "For Card Kingdom's sell list import. It takes English cards by name, set name and foil (not etched), up to 500 lines and 5,000 cards; condition is graded when they arrive.",
    file: "yama-sell-cardkingdom.csv",
    mime: "text/csv",
    paste: false,
  },
};

export const CARD_KINGDOM_MAX_LINES = 500;
export const CARD_KINGDOM_MAX_CARDS = 5000;

/** Yama's conditions in SortSwift's words: it says DM, not DMG. */
const SORTSWIFT_CONDITION: Record<string, string> = { NM: "NM", LP: "LP", MP: "MP", HP: "HP", DMG: "DM" };
const SORTSWIFT_PRINTING: Record<string, string> = { nonfoil: "Normal", foil: "Foil", etched: "Etched" };

/** Scryfall's language codes as SortSwift writes them. Languages it doesn't list (Phyrexian,
 *  Hebrew, Latin and the other Scryfall-only ones) can't go in its file. */
const SORTSWIFT_LANGUAGE: Record<string, string> = {
  en: "EN", es: "ES", fr: "FR", de: "DE", it: "IT", pt: "PT", ja: "JP", ko: "KR", ru: "RU", zhs: "ZH-S", zht: "ZH-T",
};

/** One CSV cell: quoted when it has to be, or always. */
function cell(v: string | number, quote = false): string {
  const s = String(v);
  return quote || /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Signed, altered or misprinted: worth telling the store, and the plain formats can't say it. */
export function special(c: SellCard): string[] {
  return [c.signed && "Signed", c.altered && "Altered", c.misprint && "Misprint"].filter((x): x is string => !!x);
}

export interface SellText {
  text: string;
  /** Lines in the output (Storepass and Card Kingdom merge identical cards). */
  lines: number;
  copies: number;
}

/** The chosen cards in one store format. `qty` is how many of each row to sell (default: all). */
export function sellText(format: SellFormat, cards: SellCard[], qty: (c: SellCard) => number = (c) => c.qty): SellText {
  const rows = cards.filter((c) => qty(c) > 0 && c.name);
  const copies = rows.reduce((n, c) => n + qty(c), 0);
  if (format === "sortswift") {
    const head = ["Scryfall ID", "Card Name", "Set", "Card Number", "Quantity", "Condition", "Printing", "Language", "Notes"];
    const body = rows.map((c) =>
      [
        c.scryfall_id,
        c.name ?? "",
        (c.set_code ?? "").toUpperCase(),
        c.collector_number ?? "",
        qty(c),
        SORTSWIFT_CONDITION[c.condition] ?? c.condition,
        SORTSWIFT_PRINTING[c.finish] ?? c.finish,
        SORTSWIFT_LANGUAGE[c.lang.toLowerCase()] ?? c.lang,
        special(c).join(", "),
      ]
        .map((v) => cell(v))
        .join(","),
    );
    return { text: [head.join(","), ...body].join("\n") + "\n", lines: body.length, copies };
  }
  // Both remaining formats merge copies that read the same line, keeping first-seen order.
  const merged = new Map<string, { parts: string[]; n: number }>();
  for (const c of rows) {
    const parts = format === "storepass" ? [c.name!] : [c.name!, c.set_name ?? "", c.finish === "nonfoil" ? "0" : "1"];
    const key = parts.join("\u0000");
    const m = merged.get(key);
    if (m) m.n += qty(c);
    else merged.set(key, { parts, n: qty(c) });
  }
  const list = [...merged.values()];
  const text =
    format === "storepass"
      ? list.map((m) => `${m.n} ${m.parts[0]}`).join("\n")
      : list.map((m) => [cell(m.parts[0]!, true), cell(m.parts[1]!), m.parts[2], m.n].join(",")).join("\n");
  return { text: text + "\n", lines: list.length, copies };
}

/** Rows a format can't take at all, and why; they're left out of its list and said so. */
export function leftOut(format: SellFormat, cards: SellCard[]): { card: SellCard; why: string }[] {
  const out: { card: SellCard; why: string }[] = [];
  for (const c of cards) {
    if (c.proxy) out.push({ card: c, why: "a proxy" });
    else if (!c.name) out.push({ card: c, why: "not in Yama's card data yet" });
    else if (format === "cardkingdom" && c.lang !== "en") out.push({ card: c, why: "not English" });
    // Card Kingdom's file says only foil or not, so an etched copy would be quoted as a plain foil.
    else if (format === "cardkingdom" && c.finish === "etched") out.push({ card: c, why: "etched, which Card Kingdom's file can't say" });
    else if (format === "sortswift" && !SORTSWIFT_LANGUAGE[c.lang.toLowerCase()]) out.push({ card: c, why: `a language SortSwift doesn't list (${c.lang})` });
  }
  return out;
}

/** The rows that can go in this format's list. */
export function sellable(format: SellFormat, cards: SellCard[]): SellCard[] {
  const out = new Set(leftOut(format, cards).map((x) => x.card.id));
  return cards.filter((c) => !out.has(c.id));
}

/** Card Kingdom's limits, said before the import tool refuses. */
export function overLimit(format: SellFormat, t: SellText): string | null {
  if (format !== "cardkingdom") return null;
  if (t.lines > CARD_KINGDOM_MAX_LINES) return `Card Kingdom takes at most ${CARD_KINGDOM_MAX_LINES} lines; this list has ${count(t.lines)}. Send it in parts.`;
  if (t.copies > CARD_KINGDOM_MAX_CARDS) return `Card Kingdom takes at most ${count(CARD_KINGDOM_MAX_CARDS)} cards; this list has ${count(t.copies)}. Send it in parts.`;
  return null;
}
