// ScanCatalog for the app: printings from the Rust server (GET /api/printings/lookup), names
// from the offline card bundle already kept in IndexedDB.

import { api, ApiError, type Printing } from "../api";
import { loadOfflineCards } from "../offline/cards";
import type { CatalogPrinting, ScanCatalog } from "./types";

const SKIP_LAYOUTS = new Set(["token", "double_faced_token", "emblem", "vanguard", "scheme", "planar", "art_series"]);

export interface ServerCatalogOptions {
  /**
   * Known set codes. The server has no set list endpoint yet, so without this every plausible
   * code is tried (more lookups, and OCR confusions such as "M0M" for "MOM" are fixed only by
   * trying the lookalike spellings in turn).
   */
  setCodes?: Iterable<string>;
}

export async function createServerCatalog(opts: ServerCatalogOptions = {}): Promise<ScanCatalog> {
  const bundle = await loadOfflineCards();
  const names: string[] = [];
  const full = new Map<string, string>();
  const oracle = new Map<string, string>();
  for (const c of bundle?.cards ?? []) {
    if (c.y && SKIP_LAYOUTS.has(c.y)) continue;
    names.push(c.n);
    oracle.set(c.n, c.i);
    if (c.n.includes(" // ")) {
      for (const face of c.n.split(" // ")) {
        names.push(face);
        full.set(face, c.n);
      }
    }
  }
  const sets = opts.setCodes ? new Set([...opts.setCodes].map((s) => s.toLowerCase())) : null;
  const cache = new Map<string, Promise<CatalogPrinting | null>>();
  const toPrinting = (p: Printing): CatalogPrinting => ({
    scryfall_id: p.scryfall_id,
    name: p.name,
    set: p.set_code,
    number: p.collector_number,
    lang: p.lang,
    image: p.image_normal,
  });
  const printingsOf = new Map<string, Promise<CatalogPrinting[]>>();

  return {
    hasSet: (code) => (sets ? sets.has(code) : /^[a-z0-9]{2,5}$/.test(code) && /[a-z]/.test(code)),
    lookup(set, number, lang) {
      const key = `${set}/${number}/${lang}`;
      let hit = cache.get(key);
      if (!hit) {
        const q = new URLSearchParams({ set, number, lang });
        hit = api<Printing>(`/api/printings/lookup?${q}`)
          .then(toPrinting)
          .catch((e) => {
            if (e instanceof ApiError && e.status === 404) return null;
            cache.delete(key); // network trouble: try again next frame
            throw e;
          });
        cache.set(key, hit);
      }
      return hit;
    },
    async printingsOf(name) {
      const id = oracle.get(name);
      if (!id) return [];
      let list = printingsOf.get(id);
      if (!list) {
        list = api<{ printings: Printing[] }>(`/api/cards/${encodeURIComponent(id)}`).then((d) =>
          d.printings.filter((p) => p.lang === "en").map(toPrinting),
        );
        list.catch(() => printingsOf.delete(id));
        printingsOf.set(id, list);
      }
      return list;
    },
    names: () => names,
    fullName: (n) => full.get(n) ?? n,
  };
}
