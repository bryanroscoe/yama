import type { Happening } from "./types";

export type CombatEvent = Extract<Happening, { kind: "attack" | "block" | "damage" }>;
export interface CombatCue { kind: CombatEvent["kind"] | "summary"; events: CombatEvent[]; omitted?: number }

/** Only new public events, never historical combat on attachment or reconnect. */
export function combatCues(events: Happening[], after: number): CombatCue[] {
  const cues: CombatCue[] = [];
  for (const e of events) {
    if (e.seq <= after || (e.kind !== "attack" && e.kind !== "block" && e.kind !== "damage")) continue;
    if ((e.kind === "attack" && !e.attacks.length) || (e.kind === "block" && !e.blocks.length) || (e.kind === "damage" && e.amount <= 0)) continue;
    const last = cues.at(-1);
    // Simultaneous damage reads as one impact, rather than one pause per creature.
    if (last?.kind === e.kind) last.events.push(e);
    else cues.push({ kind: e.kind, events: [e] });
  }
  return cues;
}

/** Bound fast-forward bursts; the log remains the complete event record. */
export function enqueueCombatCues(queue: CombatCue[], fresh: CombatCue[]): CombatCue[] {
  const all = [...queue, ...fresh].map((cue) => cue.events.length <= 24 ? cue : ({ ...cue, events: cue.events.slice(0, 24), omitted: (cue.omitted ?? 0) + cue.events.length - 24 }));
  if (all.length <= 8) return all;
  const older = all.slice(1, -6);
  const events = older.flatMap((c) => c.events);
  return [all[0]!, { kind: "summary", events: events.slice(-3), omitted: older.reduce((n, c) => n + (c.omitted ?? 0), 0) + Math.max(0, events.length - 3) }, ...all.slice(-6)];
}
