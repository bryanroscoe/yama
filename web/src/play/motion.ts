// Board motion (docs/play-polish-requirements.md, PP-53 to PP-56): the pure parts. The server
// sends whole boards, not events, so motion comes from comparing one board with the next: where
// each card went (phase keeps a card's id when it changes zone), how life totals moved, what the
// stack did and whose turn began. BoardMotion.tsx turns these into animations.

import type { Speed, View } from "./types";

/** Base durations at normal speed, in ms (PP-53's table, trimmed: four turns a round adds up). */
export const MS = {
  flight: 320,
  reflow: 220,
  leave: 360,
  pop: 220,
  draw: 300,
  drawStagger: 80,
  stack: 240,
  lifeTick: 300,
  lifeFloat: 800,
  spotlight: 700,
  banner: 900,
  end: 2600,
} as const;

/**
 * How fast board motion runs: 1 is normal, smaller is quicker, 0 is none (the board just
 * settles). Reduced motion and a hidden tab turn it off; watching at 2x and 4x shortens it, and
 * "to the end" turns it off.
 */
export function motionScale(p: { reduced: boolean; hidden: boolean; speed?: Speed | null }): number {
  if (p.reduced || p.hidden) return 0;
  switch (p.speed) {
    case "end":
      return 0;
    case "4x":
      return 0.35;
    case "2x":
      return 0.6;
    default:
      return 1;
  }
}

export const dur = (base: number, scale: number) => Math.round(base * scale);

export type Zone = "battlefield" | "hand" | "graveyard" | "exile" | "command";

/** Where every card you can see is, by id, with the seat whose zone it is. */
export function zonesOf(view: View, you: number | null): Map<number, { zone: Zone; seat: number }> {
  const out = new Map<number, { zone: Zone; seat: number }>();
  for (const c of view.battlefield) out.set(c.id, { zone: "battlefield", seat: c.controller });
  for (const c of view.command_zone) out.set(c.id, { zone: "command", seat: c.owner });
  for (const c of view.exile) out.set(c.id, { zone: "exile", seat: c.owner });
  for (const p of view.players) for (const c of p.graveyard) out.set(c.id, { zone: "graveyard", seat: p.seat });
  if (you !== null) for (const c of view.hand) out.set(c.id, { zone: "hand", seat: you });
  for (const [seat, cards] of Object.entries(view.hands ?? {})) for (const c of cards) out.set(c.id, { zone: "hand", seat: Number(seat) });
  return out;
}

/** Life totals by seat. */
export function lifeOf(view: View): Map<number, number> {
  return new Map(view.players.map((p) => [p.seat, p.life]));
}

/** How each seat's life total moved since the last board (only the ones that changed). */
export function lifeChanges(prev: Map<number, number> | null, view: View): { seat: number; delta: number }[] {
  if (!prev) return [];
  const out: { seat: number; delta: number }[] = [];
  for (const p of view.players) {
    const was = prev.get(p.seat);
    if (was !== undefined && was !== p.life) out.push({ seat: p.seat, delta: p.life - was });
  }
  return out;
}

export interface StackItem {
  name: string;
  controller: number;
}

/**
 * What the stack did between two boards: items that left from the top (resolved or countered)
 * and items added on top. The stack only grows and shrinks at the top, so the boards share a
 * common bottom part.
 */
export function stackChange(prev: StackItem[], next: StackItem[]): { left: number; added: StackItem[] } {
  let common = 0;
  while (common < prev.length && common < next.length && prev[common]!.name === next[common]!.name && prev[common]!.controller === next[common]!.controller) common++;
  return { left: prev.length - common, added: next.slice(common) };
}

/** Whether `seat`'s turn just began (a new turn number, or the active seat changed). */
export function turnBegan(prev: { turn: number; active: number } | null, view: View, seat: number | null): boolean {
  if (!prev || seat === null || view.active !== seat) return false;
  return prev.turn !== view.turn || prev.active !== view.active;
}

/** A floating life number: "−3" or "+2". */
export function deltaText(delta: number): string {
  return delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`;
}

/** The number a ticking total shows a fraction `t` (0 to 1) of the way from `from` to `to`, easing out. */
export function tickValue(from: number, to: number, t: number): number {
  const k = Math.min(1, Math.max(0, t));
  return Math.round(from + (to - from) * (1 - (1 - k) * (1 - k)));
}
