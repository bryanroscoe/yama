// Finished results are durable records of their own. The bulk queues are projections:
// an older window writing a stale queue cannot erase an individual saved result.
import type { LocalGame } from "./store";

const SAVED = "yama.table.saved.";
const REJECTION = "yama.table.savedError.";
const ENDED = "yama.table.ended.";
const endedKey = (g: LocalGame) => `${ENDED}${g.guest ? "guest" : g.owner ?? "legacy"}.${g.setup.id}`;

export function hasEnded(g: LocalGame): boolean {
  return localStorage.getItem(endedKey(g)) !== null || finishedRecords().some((row) => endedKey(row.game) === endedKey(g));
}

function markEnded(g: LocalGame): boolean {
  try { localStorage.setItem(endedKey(g), "1"); return true; } catch { return false; }
}

/** The server already retained the result; this historical local counter needs no new save. */
export function rememberServerFinish(g: LocalGame) { markEnded(g); }

export function saveFinished(g: LocalGame, error?: string): LocalGame {
  const saveId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  const saved = { ...g, saveId };
  // Record first. If the process ends between these writes, recovery also installs the marker.
  localStorage.setItem(SAVED + saveId, JSON.stringify({ game: saved, ...(error ? { error } : {}) }));
  markEnded(saved); // The detailed record itself also proves this game ended if storage is full.
  return saved;
}

export function finishedRecords(): { game: LocalGame; error?: string }[] {
  const records: { game: LocalGame; error?: string }[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(REJECTION) && localStorage.getItem(SAVED + key.slice(REJECTION.length)) === null) {
      localStorage.removeItem(key);
      i--;
      continue;
    }
    if (!key?.startsWith(SAVED)) continue;
    try {
      const row = JSON.parse(localStorage.getItem(key) ?? "null") as { game?: LocalGame; error?: string } | null;
      if (!row?.game?.setup?.id || key !== SAVED + row.game.saveId || !Array.isArray(row.game.log)) continue;
      const error = localStorage.getItem(REJECTION + row.game.saveId) ?? row.error;
      records.push({ game: row.game, ...(error ? { error } : {}) });
      markEnded(row.game);
    } catch {
      // Keep malformed entries for recovery; never delete a result we cannot read.
    }
  }
  return records;
}

export function acknowledgeFinished(g: LocalGame, discard = false) {
  // If the marker cannot fit, retain the detailed save until a later retry can install it.
  // Explicit discard/adoption may remove it: the caller is deleting it or kept another copy.
  if (!markEnded(g) && !discard) return;
  if (g.saveId) {
    localStorage.removeItem(SAVED + g.saveId);
    localStorage.removeItem(REJECTION + g.saveId);
  }
  if (discard) markEnded(g); // Removal may have freed the small amount of space it needs.
  // Keep the small ended marker: a sleeping window may still hold this game as active.
}

export function rejectFinished(g: LocalGame, error: string) {
  if (g.saveId) {
    // Never rewrite the immutable result: a concurrent discard may already have removed it.
    // An orphaned error has no authority and cannot resurrect that result.
    try { localStorage.setItem(REJECTION + g.saveId, error); } catch { /* The result remains readable. */ }
  }
}

export const isFinishedStorageKey = (key: string | null) => key === null || key.startsWith(SAVED) || key.startsWith(REJECTION) || key.startsWith(ENDED);
