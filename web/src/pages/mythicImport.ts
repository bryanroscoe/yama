import { plural } from "@yama/core";
// Mythic Tools import on the Collection page (server/src/collection/mythic.rs): the report the
// server sends for a preview (?dry_run=1) and for the import itself, and the sentences shown.

export interface MythicChange {
  name: string;
  set_code: string;
  collector_number: string;
  finish: string;
  lang: string;
  proxy: boolean;
  /** "box: bulk", or "unfiled". */
  place: string;
  qty: number;
  /** For copies kept where they were moved: where Yama has them. */
  now_in?: string[];
}

export interface MythicReport {
  dry_run: boolean;
  remove_missing: boolean;
  /** When this exact file was imported before; nothing is added from it again. */
  already_imported: string | null;
  rows: number;
  copies: number;
  containers: string[];
  new_containers: string[];
  /** Yama containers that take the file's type: "bulk (list to box)". */
  retyped_containers: string[];
  added: number;
  added_cards: MythicChange[];
  already_in_yama: number;
  kept_where_moved: number;
  kept_cards: MythicChange[];
  missing: number;
  missing_cards: MythicChange[];
  removed: number;
  unknown_printings: string[];
  errors: string[];
  deck_containers: string[];
  decks_created: string[];
  decks_updated: string[];
  /** Deck containers whose Yama deck wasn't made from a Mythic file: it keeps its own list. */
  decks_kept: string[];
}


/** "Sol Ring, CMM 410, foil, in box: bulk". */
export function changeText(c: MythicChange, where = true): string {
  const bits = [c.name, `${c.set_code.toUpperCase()} ${c.collector_number}`.trim()];
  if (c.finish !== "nonfoil") bits.push(c.finish);
  if (c.lang !== "en") bits.push(c.lang);
  if (c.proxy) bits.push("proxy");
  return `${c.qty > 1 ? `${c.qty} ` : ""}${bits.filter(Boolean).join(", ")}${where ? `, in ${c.place}` : ""}`;
}

/** A copy kept where it was moved: "Sol Ring, CMM 410: the file has it in box: bulk, Yama in deck: Omo". */
export function keptText(c: MythicChange): string {
  const now = c.now_in?.length ? c.now_in.join(" and ") : "another place";
  return `${changeText(c, false)}: the file has it in ${c.place}, Yama in ${now}`;
}

/** The preview's sentences, before anything is written. */
export function previewLines(r: MythicReport, day: (iso: string) => string = (iso) => iso.slice(0, 10)): string[] {
  const out = [`${plural(r.copies, "card")} in the file.`];
  if (r.already_imported) {
    out.push(`You imported this exact file on ${day(r.already_imported.slice(0, 10))}, so nothing is added from it again.`);
  } else {
    out.push(r.added ? `${plural(r.added, "card")} to add.` : "Nothing new to add.");
  }
  if (r.already_in_yama) out.push(`${plural(r.already_in_yama, "card")} ${r.already_in_yama === 1 ? "is" : "are"} in Yama already.`);
  if (r.kept_where_moved) {
    const one = r.kept_where_moved === 1;
    out.push(`${r.kept_where_moved} of those ${one ? "is" : "are"} somewhere else in Yama than the file says (moved there, say) and ${one ? "stays" : "stay"} put.`);
  }
  if (r.new_containers.length) out.push(`New: ${r.new_containers.join(", ")}.`);
  if (r.retyped_containers.length) out.push(`Changed type, as in the file: ${r.retyped_containers.join(", ")}.`);
  if (r.deck_containers.length)
    out.push(`${r.deck_containers.length === 1 ? "This deck becomes a Yama deck" : "These decks become Yama decks"} too, private until you share ${r.deck_containers.length === 1 ? "it" : "them"}: ${r.deck_containers.join(", ")}.`);
  return out;
}

/** Above the list of copies the file no longer lists: how many, and in which of its containers. */
export function missingText(r: Pick<MythicReport, "missing" | "missing_cards">): string {
  const places = [...new Set(r.missing_cards.map((c) => c.place))];
  const one = r.missing === 1;
  return `${plural(r.missing, "card")} in ${places.join(" and ")} ${one ? "isn't" : "aren't"} in this export. Yama keeps ${one ? "it" : "them"} unless you say so; boxes and binders the file doesn't name are never touched.`;
}

/** The checkbox for copies the file no longer lists. */
export function missingLabel(r: Pick<MythicReport, "missing">): string {
  return `Remove ${r.missing === 1 ? "this copy" : `these ${r.missing} copies`} from Yama`;
}

/** After the import. */
export function resultLines(r: MythicReport): string[] {
  const out: string[] = [];
  if (r.added) out.push(`Added ${plural(r.added, "card")}.`);
  if (r.removed) out.push(`Removed ${plural(r.removed, "card")} the file no longer lists.`);
  if (!r.added && !r.removed) out.push(r.already_imported ? "Nothing changed: you'd imported this file already." : "Nothing changed: Yama has everything in the file.");
  if (r.missing > r.removed) out.push(`${plural(r.missing - r.removed, "card")} the file no longer lists ${r.missing - r.removed === 1 ? "stays" : "stay"} in Yama.`);
  if (r.decks_created.length) out.push(`New decks, private until you share them: ${r.decks_created.join(", ")}. Check each one's commander on the Decks tab.`);
  if (r.decks_updated.length) out.push(`Updated decks: ${r.decks_updated.join(", ")}.`);
  if (r.decks_kept.length) out.push(`Decks you made in Yama keep their own lists: ${r.decks_kept.join(", ")}.`);
  return out;
}
