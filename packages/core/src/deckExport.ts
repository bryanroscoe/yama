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

import type { DeckBoard } from "./deckStats";

export type ExportFormat = "names" | "moxfield" | "arena";

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
  { value: "moxfield", label: "Moxfield", hint: "With set and collector number of your copy, or the default printing." },
  { value: "arena", label: "MTG Arena", hint: "Arena's import format: names only, front faces for double-faced cards." },
];

const FRONT_FACE_ONLY = new Set(["transform", "modal_dfc", "adventure", "flip", "meld", "reversible_card"]);

function arenaName(c: ExportCard): string {
  return c.layout && FRONT_FACE_ONLY.has(c.layout) ? c.name.split(" // ")[0]! : c.name;
}

function line(c: ExportCard, format: ExportFormat): string {
  if (format === "arena") return `${c.qty} ${arenaName(c)}`;
  if (format === "names" || !c.setCode || !c.collectorNumber) return `${c.qty} ${c.name}`;
  const mark = c.finish === "foil" ? " *F*" : c.finish === "etched" ? " *E*" : "";
  return `${c.qty} ${c.name} (${c.setCode.toUpperCase()}) ${c.collectorNumber}${mark}`;
}

export function exportDeck(cards: ExportCard[], format: ExportFormat): string {
  const sections: [string, DeckBoard][] = [["Commander", "commander"], ["Deck", "main"]];
  if (format !== "names") sections.push(["Sideboard", "side"]);
  const out: string[] = [];
  for (const [title, board] of sections) {
    const rows = cards
      .filter((c) => c.board === board && c.qty > 0)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => line(c, format));
    if (rows.length) out.push(title, ...rows, "");
  }
  return out.join("\n").trimEnd() + "\n";
}

/** "Riders of Rohan" + "moxfield" → "riders-of-rohan-moxfield.txt" */
export function exportFileName(deckName: string, format: ExportFormat): string {
  const slug = deckName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "deck"}-${format}.txt`;
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
