/// <reference types="node" />
// A ScanCatalog over the server's SQLite file, read-only, for the offline eval.

import { DatabaseSync } from "node:sqlite";
import type { CatalogPrinting, ScanCatalog } from "../types";

const SKIP_LAYOUTS = new Set(["token", "double_faced_token", "emblem", "vanguard", "scheme", "planar", "art_series"]);

export function openDbCatalog(path: string): ScanCatalog & { imageUrl(set: string, number: string): string | null; close(): void } {
  const db = new DatabaseSync(path, { readOnly: true });
  const sets = new Set((db.prepare("SELECT DISTINCT set_code AS s FROM printings").all() as { s: string }[]).map((r) => r.s));
  const lookupQ = db.prepare(
    "SELECT scryfall_id, name, set_code, collector_number, lang, image_normal FROM printings WHERE set_code = ? AND collector_number = ? ORDER BY (lang = ?) DESC LIMIT 1",
  );
  const byNameQ = db.prepare(
    "SELECT scryfall_id, name, set_code, collector_number, lang, image_normal FROM printings WHERE name = ? AND lang = 'en' ORDER BY released_at DESC",
  );
  type Row = { scryfall_id: string; name: string; set_code: string; collector_number: string; lang: string; image_normal: string | null };
  const toPrinting = (r: Row): CatalogPrinting => ({ scryfall_id: r.scryfall_id, name: r.name, set: r.set_code, number: r.collector_number, lang: r.lang, image: r.image_normal });
  const imageQ = db.prepare("SELECT image_normal FROM printings WHERE set_code = ? AND collector_number = ? AND lang = 'en'");
  const names: string[] = [];
  const full = new Map<string, string>();
  for (const row of db.prepare("SELECT name, layout, faces FROM cards").all() as { name: string; layout: string | null; faces: string | null }[]) {
    if (row.layout && SKIP_LAYOUTS.has(row.layout)) continue;
    names.push(row.name);
    if (row.faces) {
      for (const f of JSON.parse(row.faces) as { name?: string }[]) {
        if (f.name && f.name !== row.name) {
          names.push(f.name);
          full.set(f.name, row.name);
        }
      }
    }
  }
  return {
    hasSet: (c) => sets.has(c),
    async lookup(set, number, lang): Promise<CatalogPrinting | null> {
      const r = lookupQ.get(set, number, lang) as
        | { scryfall_id: string; name: string; set_code: string; collector_number: string; lang: string; image_normal: string | null }
        | undefined;
      return r
        ? { scryfall_id: r.scryfall_id, name: r.name, set: r.set_code, number: r.collector_number, lang: r.lang, image: r.image_normal }
        : null;
    },
    async printingsOf(name) {
      return (byNameQ.all(name) as Row[]).map(toPrinting);
    },
    names: () => names,
    fullName: (n) => full.get(n) ?? n,
    imageUrl: (set, number) => (imageQ.get(set, number) as { image_normal: string | null } | undefined)?.image_normal ?? null,
    close: () => db.close(),
  };
}
