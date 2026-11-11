import { plural } from "@yama/core";
// Importing a collection from another app's export or a pasted list (server/src/collection/
// import.rs): the report the server sends for a preview (dry_run) and for the import itself, and
// the sentences shown. The Mythic Tools import has its own (mythicImport.ts).

/** A card line that matched. */
export interface ImportLine {
  name: string;
  /** The name as the list wrote it, when it isn't the card's own. */
  written_as: string | null;
  set_code: string;
  set_name: string;
  collector_number: string;
  finish: string;
  condition: string;
  lang: string;
  proxy: boolean;
  qty: number;
  /** How the printing was found; "default" is one Yama picked because the line named none it has. */
  printing: "id" | "exact" | "set" | "number" | "default";
}

/** A card line that matched nothing: listed, never dropped. */
export interface UnmatchedLine {
  /** As a list would write it: "2 Sol Rnig (C21) 263". */
  text: string;
  /** The row of the file, for a CSV. */
  row: number | null;
  qty: number;
  reason: string;
  suggestions: string[];
}

export interface ImportReport {
  dry_run: boolean;
  top_up: boolean;
  /** "a ManaBox export", "a plain list". */
  source: string;
  /** When this exact list was imported before; nothing is added from it again. */
  already_imported: string | null;
  /** "box: Bulk", or "unfiled". */
  place: string;
  lines: number;
  copies: number;
  added: number;
  added_cards: ImportLine[];
  already_owned: number;
  unmatched: UnmatchedLine[];
  unmatched_copies: number;
  skipped: string[];
  notes: string[];
}

/** The most text one import takes (the server's cap), and the same for a limited account's message. */
export const IMPORT_MAX_BYTES = 4 << 20;

/** What the textarea suggests: the formats people paste. */
export const LIST_EXAMPLE = "1 Sol Ring\n2 Arcane Signet (CMM) 367\n1 Rhystic Study (JMP) 169 *F*";

const CONDITION: Record<string, string> = { LP: "lightly played", MP: "moderately played", HP: "heavily played", DMG: "damaged" };

/** "box: Bulk" as a sentence says it: "the box Bulk"; "unfiled": "your loose cards". */
export function placeText(place: string): string {
  const i = place.indexOf(": ");
  if (i < 0) return "your loose cards";
  const kind = place.slice(0, i);
  return `the ${kind === "deck" ? "deck box" : kind} ${place.slice(i + 2)}`;
}

/** "2 Sol Ring, CMM 410, foil, lightly played". A printing Yama picked says so. */
export function lineText(l: ImportLine): string {
  const bits = [l.name, `${l.set_code.toUpperCase()} ${l.collector_number}`.trim()];
  if (l.finish !== "nonfoil") bits.push(l.finish);
  if (l.condition !== "NM") bits.push(CONDITION[l.condition] ?? l.condition);
  if (l.lang !== "en") bits.push(l.lang);
  if (l.proxy) bits.push("proxy");
  const written = l.written_as ? ` (written as “${l.written_as}”)` : "";
  const picked = l.printing === "default" ? " (a regular printing)" : "";
  return `${l.qty > 1 ? `${l.qty} ` : ""}${bits.filter(Boolean).join(", ")}${written}${picked}`;
}

/** A line that matched nothing, with why and what it might have meant. */
export function unmatchedText(u: UnmatchedLine): string {
  const where = u.row ? `Row ${u.row}: ` : "";
  const meant = u.suggestions.length ? ` Did you mean ${u.suggestions.join(" or ")}?` : "";
  return `${where}${u.text}. ${u.reason}${meant}`;
}

/** The unmatched lines as a list to copy, fix and paste again. */
export function unmatchedList(r: Pick<ImportReport, "unmatched">): string {
  return r.unmatched.map((u) => u.text).join("\n");
}

/** The preview's sentences, before anything is written. */
export function previewLines(r: ImportReport, day: (iso: string) => string = (iso) => iso.slice(0, 10)): string[] {
  if (r.lines === 0) return ["Yama found no cards in that."];
  const out = [`This looks like ${r.source} with ${plural(r.copies + r.unmatched_copies, "card")}.`];
  if (r.already_imported) {
    out.push(`You imported this exact list on ${day(r.already_imported.slice(0, 10))}, so nothing is added from it again.`);
  } else {
    out.push(r.added ? `${plural(r.added, "card")} to add to ${placeText(r.place)}.` : "Nothing to add.");
    if (r.already_owned) out.push(`${plural(r.already_owned, "card")} ${r.already_owned === 1 ? "is" : "are"} in your collection already and ${r.already_owned === 1 ? "isn't" : "aren't"} added again.`);
  }
  if (r.unmatched.length) out.push(unmatchedSentence(r, false));
  return [...out, ...r.notes];
}

function unmatchedSentence(r: Pick<ImportReport, "unmatched">, done: boolean): string {
  const n = r.unmatched.length;
  return `${plural(n, "line")} matched no card and ${n === 1 ? (done ? "wasn't" : "won't be") : done ? "weren't" : "won't be"} added. ${n === 1 ? "It's" : "They're"} listed below to fix by hand.`;
}

/** After the import. */
export function resultLines(r: ImportReport): string[] {
  const out: string[] = [];
  if (r.added) out.push(`Added ${plural(r.added, "card")} to ${placeText(r.place)}.`);
  else if (r.already_imported) out.push("Nothing changed: you'd imported this list already.");
  else if (r.already_owned) out.push("Nothing changed: your collection has everything in the list.");
  else out.push("Nothing was added.");
  if (r.added && r.already_owned) out.push(`${plural(r.already_owned, "card")} you had already ${r.already_owned === 1 ? "wasn't" : "weren't"} added again.`);
  if (r.unmatched.length) out.push(unmatchedSentence(r, true));
  return out;
}

/** The "Put them in" choice for a box that doesn't exist yet. */
export const NEW_BOX = "new";

/** Where the copies go, as the report words it, before the server has said: "box: Bulk", "unfiled". */
export function chosenPlace(place: string, newName: string, containers: { id: string; kind: string; name: string }[]): string {
  if (place === NEW_BOX) return newName.trim() ? `box: ${newName.trim()}` : "unfiled";
  const c = containers.find((c) => c.id === place);
  return c ? `${c.kind}: ${c.name}` : "unfiled";
}

type Call = <T>(path: string, init: { method: string; json: unknown }) => Promise<T>;

/** What is sent for a preview: nothing is written, and the place doesn't change what matches. */
export function previewImport(call: Call, source: { text: string; fileName: string | null }, topUp: boolean): Promise<ImportReport> {
  return call<ImportReport>("/api/collection/import", { method: "POST", json: { text: source.text, file_name: source.fileName, top_up: topUp, dry_run: true } });
}

/**
 * The import itself. A new box is made first; making it again (a second try after a lost reply)
 * answers with the same box, and the same list again adds nothing, so trying again is safe.
 */
export async function runImport(call: Call, source: { text: string; fileName: string | null }, o: { place: string; newName: string; topUp: boolean }): Promise<ImportReport> {
  let container: string | null = o.place && o.place !== NEW_BOX ? o.place : null;
  if (o.place === NEW_BOX && o.newName.trim()) container = (await call<{ id: string }>("/api/containers", { method: "POST", json: { kind: "box", name: o.newName.trim() } })).id;
  return call<ImportReport>("/api/collection/import", { method: "POST", json: { text: source.text, file_name: source.fileName, container_id: container, top_up: o.topUp, dry_run: false } });
}
