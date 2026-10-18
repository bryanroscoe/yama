// Fuzzy card-name lookup for OCR text from the title bar. A trigram index narrows ~35k names to a
// few dozen, then an edit distance that ignores junk around the name (mana symbols, frame
// edges) picks the best.

import { normaliseName } from "./parse";

export interface NameMatch {
  name: string;
  /** 0..1: 1 - edit distance / name length, lowered when the name covers little of the text. */
  score: number;
}

export class NameIndex {
  private readonly names: string[];
  private readonly norm: string[];
  private readonly grams = new Map<string, number[]>();

  constructor(names: readonly string[]) {
    this.names = [...new Set(names)];
    this.norm = this.names.map(normaliseName);
    this.norm.forEach((n, id) => {
      for (const g of new Set(trigrams(n))) {
        let list = this.grams.get(g);
        if (!list) this.grams.set(g, (list = []));
        list.push(id);
      }
    });
  }

  get size(): number {
    return this.names.length;
  }

  /** Best matches for OCR'd title text, best first. */
  match(text: string, limit = 3): NameMatch[] {
    const q = normaliseName(text);
    if (q.replace(/ /g, "").length < 3) return [];
    const counts = new Map<number, number>();
    for (const g of new Set(trigrams(q))) {
      const list = this.grams.get(g);
      if (!list || list.length > 4000) continue; // very common grams carry no signal
      for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const shortlist = [...counts.entries()]
      .map(([id, c]) => ({ id, c: c / Math.max(1, this.norm[id]!.length - 1) }))
      .sort((a, b) => b.c - a.c)
      .slice(0, 80);
    const scored = shortlist.map(({ id }) => {
      const name = this.norm[id]!;
      const d = fittingDistance(name, q);
      let score = 1 - d / name.length;
      // A short name found inside long text ("opt" in a garbled line) is weak evidence.
      const coverage = name.length / q.length;
      if (coverage < 0.7) score *= Math.max(0.3, coverage / 0.7);
      return { name: this.names[id]!, score };
    });
    scored.sort((a, b) => b.score - a.score || b.name.length - a.name.length);
    return scored.slice(0, limit);
  }
}

function trigrams(s: string): string[] {
  const p = ` ${s} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= p.length; i += 1) out.push(p.slice(i, i + 3));
  return out;
}

/**
 * Edit distance between `needle` and the best-matching substring of `hay` (fitting alignment):
 * skipping characters before and after the match in `hay` is free.
 */
export function fittingDistance(needle: string, hay: string): number {
  const n = needle.length;
  const m = hay.length;
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = needle[i - 1] === hay[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  let best = Infinity;
  for (let j = 0; j <= m; j += 1) best = Math.min(best, prev[j]!);
  return best;
}
