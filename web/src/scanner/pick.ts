import { normaliseNumber } from "./parse";
import type { CatalogPrinting } from "./types";

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = row[j]!;
      row[j] = Math.min(up + 1, row[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length]!;
}

export interface Pick {
  printing: CatalogPrinting;
  /** "set": the set code read exactly; "near": the read set was one character off or missing. */
  how: "set" | "near";
}

/**
 * Choose the printing a scan most likely shows, from all printings of one card.
 *  1. The first of `sets` (codes that exist) the card was printed in, preferring a matching
 *     collector number.
 *  2. Otherwise the printings whose set code is one character away from what OCR read
 *     (`rawSets`, e.g. "ble" for "blb") or whose number is one of `numbers`; taken only when
 *     that leaves a single set.
 * Null when it can't tell (basic lands share numbers across many sets).
 */
export function pickPrinting(printings: CatalogPrinting[], sets: string[], numbers: string[], rawSets: string[] = []): Pick | null {
  const nums = new Set(numbers.map(normaliseNumber));
  const numberHit = (p: CatalogPrinting) => nums.has(normaliseNumber(p.number));
  for (const set of sets) {
    const inSet = printings.filter((p) => p.set === set);
    if (inSet.length === 0) continue;
    const p = inSet.find(numberHit) ?? (inSet.length === 1 ? inSet[0]! : null);
    if (p) return { printing: p, how: "set" };
  }
  const near = (p: CatalogPrinting) => rawSets.some((r) => r.length >= 2 && editDistance(r, p.set) <= 1);
  const tiers = [
    printings.filter((p) => near(p) && numberHit(p)),
    printings.filter(numberHit),
    printings.filter(near),
  ];
  for (const hits of tiers) {
    if (hits.length === 0) continue;
    if (new Set(hits.map((p) => p.set)).size !== 1) continue;
    const exact = hits.find(numberHit);
    if (exact) return { printing: exact, how: "near" };
    if (hits.length === 1) return { printing: hits[0]!, how: "near" };
  }
  return null;
}
