// Which printing is in front of the camera. The art says which card (and narrows reprints to
// those sharing the artwork); the collector line, when it's needed, picks among those few. When
// neither settles it, the person picks: a scan never files a guessed printing.

import { api, type Printing } from "../api";
import { normaliseNumber, parseCollector } from "./parse";
import { pickPrinting } from "./pick";
import type { CatalogPrinting } from "./types";

export interface PrintingOptions {
  /** True when these are exactly the printings that share the scanned artwork. */
  sameArt: boolean;
  printings: Printing[];
}

const cache = new Map<string, Promise<PrintingOptions>>();

/** Printings for a recognised artwork (`art` + `id`), or every printing of a card read by `name`. */
export function printingOptions(q: { art?: string | null; id?: string; name?: string }): Promise<PrintingOptions> {
  const params = new URLSearchParams();
  if (q.art) params.set("art", q.art);
  if (q.id) params.set("id", q.id);
  if (q.name) params.set("name", q.name);
  const key = params.toString();
  let hit = cache.get(key);
  if (!hit) {
    hit = api<{ same_art: boolean; printings: Printing[] }>(`/api/scan/printings?${key}`).then((r) => ({ sameArt: r.same_art, printings: r.printings }));
    hit.catch(() => cache.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

export interface Choice {
  /** The printing to file, or null when the person has to pick. */
  chosen: Printing | null;
  /** "only": the one printing with this art. "collector": read from the collector line. */
  how: "only" | "collector" | null;
  /** What to offer in the picker: English first, the best guesses at the top. */
  options: Printing[];
  /** The collector line gave both the set code and the number of the chosen printing. */
  strong?: boolean;
}

const asCatalog = (p: Printing): CatalogPrinting & { p: Printing } => ({ p, scryfall_id: p.scryfall_id, name: p.name, set: p.set_code, number: p.collector_number, lang: p.lang, image: p.image_normal });

/**
 * Settle the printing when it can be settled. `collector` is the OCR text of the collector line,
 * when it was read. English printings are preferred: the card data keeps other languages only
 * where Scryfall has no English printing.
 */
export function choosePrinting(o: PrintingOptions, collector?: string): Choice {
  const english = o.printings.filter((p) => p.lang === "en");
  const pool = english.length > 0 ? english : o.printings;
  const options = [...pool, ...o.printings.filter((p) => !pool.includes(p))];
  if (o.sameArt && pool.length === 1) return { chosen: pool[0]!, how: "only", options };
  if (collector) {
    const sets = new Set(pool.map((p) => p.set_code));
    const read = parseCollector(collector, (code) => sets.has(code));
    const pick = pickPrinting(pool.map(asCatalog), read.sets.slice(0, 3), read.numbers.slice(0, 3), read.rawSets);
    // Among a card's every printing (not just one artwork's), only an exactly read set code counts.
    if (pick && (o.sameArt || pick.how === "set")) {
      const chosen = (pick.printing as ReturnType<typeof asCatalog>).p;
      const strong = read.sets.includes(chosen.set_code) && read.numbers.includes(normaliseNumber(chosen.collector_number));
      return { chosen, how: "collector", options: [chosen, ...options.filter((p) => p !== chosen)], strong };
    }
    // Not settled, but put printings matching what was read first.
    const near = (p: Printing) => read.sets.includes(p.set_code) || read.rawSets.includes(p.set_code) || read.numbers.includes(p.collector_number.replace(/^0+/, ""));
    return { chosen: null, how: null, options: [...options.filter(near), ...options.filter((p) => !near(p))] };
  }
  return { chosen: null, how: null, options };
}
