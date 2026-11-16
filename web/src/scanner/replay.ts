// Replaying a scanner diagnostic record (diagnostics.ts) through today's decisions: the frames it
// read, through the evidence and the hold budgets (evidence.ts, heldRead.ts). Used by
// eval/real.test.ts, which also reads the record's strip again and replays its title and art.

import { Evidence, type PrintingLine } from "./evidence";
import type { ArtCandidate } from "./fuse";
import { HeldRead } from "./heldRead";

/** A record as get_scan_diagnostic (or GET /api/scan/diagnostics/<id>) gives it, as far as a replay needs. */
export interface DiagnosticRecord {
  id?: string;
  outcome: string;
  card_name?: string;
  detail: {
    options?: { id: string; set: string; number: string; rarity?: string | null; lang?: string; released_at?: string | null }[];
    frames?: { t: number; source: string; reads: string[]; skipped?: boolean }[];
    final?: { id?: string; how?: string };
    scan?: { art?: ArtCandidate[]; titles?: string[] };
    reasons?: string[];
  };
}

/** The record's candidate printings, as evidence.ts reads them. */
export const replayLines = (r: DiagnosticRecord): PrintingLine[] =>
  (r.detail.options ?? []).map((o) => ({ scryfall_id: o.id, set_code: o.set, collector_number: o.number, rarity: o.rarity ?? null, lang: o.lang ?? "en", released_at: o.released_at ?? null }));

/**
 * The recorded frames (those read, not skipped as blurred) through the evidence and the hold
 * budgets with Close-ups off: the printing it settles on, and on which frame, or null.
 */
export function replayFrames(r: DiagnosticRecord): { settled: string | null; frame: number | null; frames: number } {
  const ev = new Evidence(replayLines(r));
  const frames = (r.detail.frames ?? []).filter((f) => !f.skipped && f.reads.some((t) => t.trim()));
  const held = new HeldRead(false, frames[0]?.t ?? 0);
  let n = 0;
  for (const f of frames) {
    n += 1;
    ev.add(f.reads);
    const v = ev.verdict();
    if (v.kind === "settled") return { settled: v.id, frame: n, frames: frames.length };
    if (held.frame(f.t) !== "again") break;
  }
  return { settled: null, frame: null, frames: frames.length };
}
