// Deck list exports and version diffs.
//
// - "names": card names only under Commander and Deck headings, the shape the commander-decks
//   lists use for pasting into EDHbots (sideboard left out).
// - "moxfield": "1 Sol Ring (CMM) 410", naming your own copy's printing (else Scryfall's
//   default), with *F* or *E* for foil and etched copies. Moxfield reads Commander, Deck and
//   Sideboard headings.
// - "arena": MTG Arena's import format: Commander, Deck and Sideboard headings and card names
//   without set codes (most paper printings aren't on Arena, and Arena finds a printing by name).
//   Double-faced and adventure cards go by their front face, as Arena names them; split cards
//   keep both halves.
// - "archidekt": Archidekt's text, "1x Sol Ring (cmm) 410 *F* [Commander{top}]": no headings,
//   the board in a category after the card ("Commander{top}", "Sideboard{noDeck}{noPrice}").
// - "mtgo": Magic Online's .dek file (XML). Commander decks keep the commander in the sideboard
//   there, so the deck's own sideboard is left out. Yama has no MTGO catalog numbers, so every
//   card goes by name with CatID 0: programs that read .dek by name take it (Yama's importer
//   among them); Magic Online itself matches by catalog number and may not.
// - "cockatrice": Cockatrice's .cod file (XML): the main deck in the "main" zone and the
//   commander in "side", where Cockatrice players keep it; the deck's own sideboard is left out.
// - "csv": one row a card, "Quantity,Name,Board,Set code,Collector number,Finish": opens in a
//   spreadsheet and reads back through Yama's own CSV import.
//
// server/src/sharing.rs writes the same formats for a shared deck's page; keep them in step.
// One known difference, in every format: within a board the cards are A to Z by the browser's
// collation here and by code point there, so an accented name can sit in another place.

import type { DeckBoard } from "./deckStats";

export type ExportFormat = "names" | "moxfield" | "arena" | "archidekt" | "mtgo" | "cockatrice" | "csv";

export interface ExportCard {
  name: string;
  qty: number;
  board: DeckBoard;
  layout?: string | null;
  setCode?: string | null;
  collectorNumber?: string | null;
  /** nonfoil | foil | etched */
  finish?: string | null;
}

export const EXPORT_FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  { value: "names", label: "Names only", hint: "Commander and Deck headings, no set codes. For EDHbots and most simulators." },
  { value: "moxfield", label: "Moxfield", hint: "With set and collector number of your copy, or of a paper printing." },
  { value: "arena", label: "MTG Arena", hint: "Arena's import format: names only, front faces for double-faced cards." },
  { value: "archidekt", label: "Archidekt", hint: "Archidekt's text: set and number, with the commander and sideboard as categories." },
  { value: "mtgo", label: "Magic Online (.dek)", hint: "A .dek file with the commander in the sideboard. Cards go by name, without Magic Online's catalog numbers, so Magic Online itself may not match them." },
  { value: "cockatrice", label: "Cockatrice (.cod)", hint: "A .cod file with the commander in the sideboard, where Cockatrice keeps it." },
  { value: "csv", label: "CSV", hint: "A spreadsheet row for each card: quantity, name, board, set, collector number and finish." },
];

/** Formats that are a file to open in another program, not text to paste. */
const FILES: Partial<Record<ExportFormat, { ext: string; mime: string }>> = {
  mtgo: { ext: "dek", mime: "application/xml" },
  cockatrice: { ext: "cod", mime: "application/xml" },
  csv: { ext: "csv", mime: "text/csv" },
};

/** The media type of a format's download. */
export function exportMime(format: ExportFormat): string {
  return `${FILES[format]?.mime ?? "text/plain"};charset=utf-8`;
}

const FRONT_FACE_ONLY = new Set(["transform", "modal_dfc", "adventure", "flip", "meld", "reversible_card"]);

function arenaName(c: ExportCard): string {
  return c.layout && FRONT_FACE_ONLY.has(c.layout) ? c.name.split(" // ")[0]! : c.name;
}

const byName = (a: ExportCard, b: ExportCard) => a.name.localeCompare(b.name);

/** The cards of one board, A to Z. */
function boardCards(cards: ExportCard[], board: DeckBoard): ExportCard[] {
  return cards.filter((c) => c.board === board && c.qty > 0).sort(byName);
}

function line(c: ExportCard, format: ExportFormat): string {
  if (format === "arena") return `${c.qty} ${arenaName(c)}`;
  if (format === "names" || !c.setCode || !c.collectorNumber) return `${c.qty} ${c.name}`;
  const mark = c.finish === "foil" ? " *F*" : c.finish === "etched" ? " *E*" : "";
  return `${c.qty} ${c.name} (${c.setCode.toUpperCase()}) ${c.collectorNumber}${mark}`;
}

function headed(cards: ExportCard[], format: ExportFormat): string {
  const sections: [string, DeckBoard][] = [["Commander", "commander"], ["Deck", "main"]];
  if (format !== "names") sections.push(["Sideboard", "side"]);
  const out: string[] = [];
  for (const [title, board] of sections) {
    const rows = boardCards(cards, board).map((c) => line(c, format));
    if (rows.length) out.push(title, ...rows, "");
  }
  return out.join("\n").trimEnd() + "\n";
}

const ARCHIDEKT_CATEGORY: Record<DeckBoard, string> = { commander: " [Commander{top}]", main: "", side: " [Sideboard{noDeck}{noPrice}]" };

function archidekt(cards: ExportCard[]): string {
  const out: string[] = [];
  for (const board of ["commander", "main", "side"] as const) {
    for (const c of boardCards(cards, board)) {
      const printing = c.setCode && c.collectorNumber ? ` (${c.setCode.toLowerCase()}) ${c.collectorNumber}` : "";
      const mark = printing && c.finish === "foil" ? " *F*" : printing && c.finish === "etched" ? " *E*" : "";
      out.push(`${c.qty}x ${c.name}${printing}${mark}${ARCHIDEKT_CATEGORY[board]}`);
    }
  }
  // An empty deck is an empty file, as the server writes it.
  return out.length ? out.join("\n") + "\n" : "";
}

/** Text for an XML attribute or element. */
function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mtgo(cards: ExportCard[]): string {
  const row = (c: ExportCard, side: boolean) => `  <Cards CatID="0" Quantity="${c.qty}" Sideboard="${side}" Name="${xml(arenaName(c))}" Annotation="0" />`;
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Deck xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    "  <NetDeckID>0</NetDeckID>",
    "  <PreconstructedDeckID>0</PreconstructedDeckID>",
    ...boardCards(cards, "main").map((c) => row(c, false)),
    ...boardCards(cards, "commander").map((c) => row(c, true)),
    "</Deck>",
    "",
  ].join("\n");
}

function cockatrice(cards: ExportCard[], deckName: string): string {
  const zone = (name: string, board: DeckBoard) => {
    const rows = boardCards(cards, board).map((c) => `        <card number="${c.qty}" name="${xml(arenaName(c))}"/>`);
    return rows.length ? [`    <zone name="${name}">`, ...rows, "    </zone>"] : [];
  };
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<cockatrice_deck version="1">',
    `    <deckname>${xml(deckName)}</deckname>`,
    "    <comments></comments>",
    ...zone("main", "main"),
    ...zone("side", "commander"),
    "</cockatrice_deck>",
    "",
  ].join("\n");
}

/** A CSV field: quoted when it holds a comma, a quote or a line break. */
function csvField(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_BOARD: Record<DeckBoard, string> = { commander: "Commander", main: "Main", side: "Sideboard" };

function csv(cards: ExportCard[]): string {
  const out = ["Quantity,Name,Board,Set code,Collector number,Finish"];
  for (const board of ["commander", "main", "side"] as const) {
    for (const c of boardCards(cards, board)) {
      const printed = !!c.setCode && !!c.collectorNumber;
      out.push([String(c.qty), csvField(c.name), CSV_BOARD[board], printed ? c.setCode!.toUpperCase() : "", printed ? csvField(c.collectorNumber!) : "", printed ? c.finish ?? "" : ""].join(","));
    }
  }
  return out.join("\n") + "\n";
}

/** The deck in `format`. `deckName` goes into the formats that carry one (Cockatrice). */
export function exportDeck(cards: ExportCard[], format: ExportFormat, deckName = ""): string {
  if (format === "archidekt") return archidekt(cards);
  if (format === "mtgo") return mtgo(cards);
  if (format === "cockatrice") return cockatrice(cards, deckName);
  if (format === "csv") return csv(cards);
  return headed(cards, format);
}

/** "Riders of Rohan" + "moxfield" → "riders-of-rohan-moxfield.txt"; a file format takes its own ending ("riders-of-rohan.cod"). */
export function exportFileName(deckName: string, format: ExportFormat): string {
  const slug = deckName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const file = FILES[format];
  return file ? `${slug || "deck"}.${file.ext}` : `${slug || "deck"}-${format}.txt`;
}

// ── version diffs ──────────────────────────────────────────────────────────

export interface DiffCard {
  oracle_id: string;
  name: string;
  qty: number;
  board: DeckBoard;
}

export interface DiffLine {
  name: string;
  board: DeckBoard;
  before: number;
  after: number;
}

export interface DeckDiff {
  added: DiffLine[];
  removed: DiffLine[];
  /** Same card and board, different count. */
  changed: DiffLine[];
}

/** What changed from `before` to `after`, per card and board (a card moved from the main deck
 *  to the commander slot shows as removed from one and added to the other). */
export function diffDecks(before: DiffCard[], after: DiffCard[]): DeckDiff {
  const key = (c: DiffCard) => `${c.board}\u0000${c.oracle_id}`;
  const tally = (cards: DiffCard[]) => {
    const m = new Map<string, DiffLine>();
    for (const c of cards) {
      const k = key(c);
      const line = m.get(k) ?? { name: c.name, board: c.board, before: 0, after: 0 };
      line.after += c.qty;
      m.set(k, line);
    }
    return m;
  };
  const a = tally(before);
  const b = tally(after);
  const diff: DeckDiff = { added: [], removed: [], changed: [] };
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const was = a.get(k)?.after ?? 0;
    const now = b.get(k)?.after ?? 0;
    if (was === now) continue;
    const line = { name: (b.get(k) ?? a.get(k))!.name, board: (b.get(k) ?? a.get(k))!.board, before: was, after: now };
    if (was === 0) diff.added.push(line);
    else if (now === 0) diff.removed.push(line);
    else diff.changed.push(line);
  }
  const byName = (x: DiffLine, y: DiffLine) => x.name.localeCompare(y.name);
  diff.added.sort(byName);
  diff.removed.sort(byName);
  diff.changed.sort(byName);
  return diff;
}
