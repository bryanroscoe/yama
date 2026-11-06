// The set lock (Bryan, 2026-11-06): scanning a pile from one set or precon, say so once and the
// scanner matches that set's art first and files that set's printing, with no collector line to
// read. A card whose art clearly isn't in the set is shown as such, and the person says whether
// it's from another set.

import { api, type Printing } from "../api";
import type { PoolKeys } from "./artClient";
import type { ArtMatch } from "./recognizer";

export interface ScanSet {
  code: string;
  name: string;
  released_at: string | null;
  cards: number;
}

export interface SetPrinting extends Printing {
  illustration_id: string | null;
  back_illustration_id: string | null;
}

export interface LockedSet {
  code: string;
  name: string;
  printings: SetPrinting[];
}

/** The sets chosen on this device, kept between scans. */
export const LOCK_KEY = "yama.scan.sets";
/** Most sets locked at once (a precon and its main set, say). */
export const MAX_LOCKED = 4;

let setsCache: Promise<ScanSet[]> | null = null;
export function scanSets(): Promise<ScanSet[]> {
  setsCache ??= api<ScanSet[]>("/api/scan/sets");
  setsCache.catch(() => (setsCache = null));
  return setsCache;
}

const setCache = new Map<string, Promise<LockedSet>>();
export function lockedSet(code: string): Promise<LockedSet> {
  const key = code.toLowerCase();
  let hit = setCache.get(key);
  if (!hit) {
    hit = api<LockedSet>(`/api/scan/set?code=${encodeURIComponent(key)}`);
    hit.catch(() => setCache.delete(key));
    setCache.set(key, hit);
  }
  return hit;
}

export function savedLock(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCK_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string").slice(0, MAX_LOCKED) : [];
  } catch {
    return [];
  }
}

export function saveLock(codes: string[]) {
  try {
    if (codes.length) localStorage.setItem(LOCK_KEY, JSON.stringify(codes));
    else localStorage.removeItem(LOCK_KEY);
  } catch {
    /* storage off: the lock lasts this scan only */
  }
}

/** What the recognizer should match for these sets. */
export function poolKeys(sets: LockedSet[]): PoolKeys {
  const illustrations = new Set<string>();
  const ids = new Set<string>();
  for (const s of sets) {
    for (const p of s.printings) {
      if (p.illustration_id) illustrations.add(p.illustration_id);
      if (p.back_illustration_id) illustrations.add(p.back_illustration_id);
      if (!p.illustration_id) ids.add(p.scryfall_id);
    }
  }
  return { illustrations: [...illustrations], ids: [...ids] };
}

/** Card names (each face too) in these sets, for reading a card's name against just them. */
export function lockedNames(sets: LockedSet[]): string[] {
  const names = new Set<string>();
  for (const s of sets) {
    for (const p of s.printings) {
      // A title shows one face; the scanner's catalog turns a face back into the card's full name.
      for (const face of p.name.split(" // ")) names.add(face);
    }
  }
  return [...names];
}

/**
 * An in-set match counts while it scores within this of the best match anywhere: the right card
 * scores the same in both (the pool is part of the gallery), and a card that isn't in the set
 * scores well above any in-set lookalike.
 */
export const POOL_MARGIN = 0.06;

export type LockedJudgement =
  /** The best match among the locked sets' art. */
  | { kind: "in-set"; match: ArtMatch }
  /** The best match anywhere, clearly not in the locked sets. */
  | { kind: "outside"; match: ArtMatch }
  | { kind: "none" };

/**
 * Which match to go on while locked. `pool` is the recognizer's in-pool search; when the bundle
 * can't be searched by part it's undefined, and the top matches that are in the sets stand in.
 */
export function judgeLocked(matches: ArtMatch[], pool: ArtMatch[] | undefined, inSets: (m: ArtMatch) => boolean, minimum: number): LockedJudgement {
  const best = matches[0];
  const inPool = (pool ?? matches.filter(inSets))[0];
  if (inPool && inPool.score >= minimum && (!best || inPool.score >= best.score - POOL_MARGIN)) return { kind: "in-set", match: inPool };
  if (best) return { kind: "outside", match: best };
  return { kind: "none" };
}

/** Whether an art match is among the locked sets' artworks. */
export function artInSets(keys: PoolKeys): (m: ArtMatch) => boolean {
  const ills = new Set(keys.illustrations);
  const ids = new Set(keys.ids);
  return (m) => (!!m.illustrationId && ills.has(m.illustrationId)) || ids.has(m.id.replace(/-1$/, ""));
}

/** The printings to choose among when locked: those in the locked sets, if any. */
export function inLockedSets<T extends Pick<Printing, "set_code">>(printings: T[], codes: ReadonlySet<string>): T[] {
  if (codes.size === 0) return [];
  return printings.filter((p) => codes.has(p.set_code));
}

/**
 * Suggest locking to a set when the last few cards filed all came from it. `recentSets` is newest
 * first; null when there's nothing to suggest.
 */
export function suggestLock(recentSets: string[], locked: ReadonlySet<string>, run = 3): string | null {
  if (recentSets.length < run) return null;
  const first = recentSets[0]!;
  if (locked.has(first)) return null;
  return recentSets.slice(0, run).every((s) => s === first) ? first : null;
}
