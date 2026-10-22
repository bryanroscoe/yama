// Drag and drop on the online board (docs/play-polish-requirements.md, PP-25, PP-26, PP-40, PP-41):
// the pure parts. Board.tsx owns the pointer listeners and DragLayer.tsx draws the ghost card and
// the arrows; everything here decides what a drag means, so it can be tested without a browser.

import type { AttackAt, OptionView } from "./types";
import { shortName } from "./text";

/** A hand card plays once it's dragged up past a line this far above the hand (phase's HAND_DRAG_PLAY_THRESHOLD). */
export const HAND_PLAY_LINE = 64;

/** How far the pointer moves before a press becomes a drag; a smaller move is still a click or tap. */
export function dragSlop(pointerType: string): number {
  return pointerType === "touch" ? 10 : 5;
}

export function movedPast(x0: number, y0: number, x: number, y: number, slop: number): boolean {
  return Math.hypot(x - x0, y - y0) > slop;
}

/** Whether a hand card held at `y` is past the play line above the hand's top edge. */
export function pastPlayLine(y: number, handTop: number, line = HAND_PLAY_LINE): boolean {
  return y < handTop - line;
}

/** What's under the pointer: a card tile's ids (`data-ids`) and the seat pane it sits in (`data-seat`). */
export interface DropAt {
  ids: number[] | null;
  seat: number | null;
}

export function parseDrop(ids: string | null | undefined, seat: string | null | undefined): DropAt {
  const list = ids ? ids.split(" ").filter(Boolean).map(Number).filter(Number.isFinite) : [];
  const s = seat === null || seat === undefined || seat === "" ? NaN : Number(seat);
  return { ids: list.length ? list : null, seat: Number.isFinite(s) ? s : null };
}

/** The drop target under an element, read from the closest `data-ids` tile and `data-seat` pane. */
export function readDrop(el: Element | null): DropAt {
  const tile = el?.closest<HTMLElement>("[data-ids]");
  const pane = el?.closest<HTMLElement>("[data-seat]");
  return parseDrop(tile?.dataset.ids, pane?.dataset.seat);
}

export type HandDrop =
  | { act: "play"; option: OptionView }
  /** Several ways to play it: select it so the options list shows them. */
  | { act: "choose"; options: OptionView[] }
  /** Back into the hand; `reason` says why when it was dragged past the line but can't be played. */
  | { act: "back"; reason: string | null };

export function handDrop(p: {
  passed: boolean;
  /** The decision's options for this card. */
  options: OptionView[];
  /** Whether you have a decision at all (priority). */
  deciding: boolean;
  /** Declaring attackers or blockers. */
  combat: boolean;
  name: string;
}): HandDrop {
  if (!p.passed) return { act: "back", reason: null };
  if (!p.deciding) return { act: "back", reason: `You can play ${shortName(p.name)} when the game gets to you.` };
  if (p.combat) return { act: "back", reason: "Finish declaring attackers or blockers first." };
  if (p.options.length === 1) return { act: "play", option: p.options[0]! };
  if (p.options.length > 1) return { act: "choose", options: p.options };
  return { act: "back", reason: `${shortName(p.name)} can't be played right now.` };
}

/** Where an attacker dropped here attacks: a planeswalker or battle tile first, then the player whose pane it is. */
export function attackDrop(targets: AttackAt[], at: DropAt): AttackAt | null {
  if (at.ids) {
    const t = targets.find((x) => x.kind !== "player" && at.ids!.includes(x.id));
    if (t) return t;
  }
  if (at.seat !== null) {
    const t = targets.find((x) => x.kind === "player" && x.seat === at.seat);
    if (t) return t;
  }
  return null;
}

/**
 * The attacker a blocker dropped here blocks, if it may block it. On a stack of attackers, one
 * nobody blocks yet comes first (`blocked`: attackers already in your blocks).
 */
export function blockDrop(canBlock: number[], at: DropAt, blocked: Iterable<number> = []): number | null {
  const legal = at.ids?.filter((i) => canBlock.includes(i)) ?? [];
  const taken = new Set(blocked);
  return legal.find((i) => !taken.has(i)) ?? legal[0] ?? null;
}

/** The target option a drag-to-target dropped here picks: a card on the board, then a player. */
export function targetDrop(
  at: DropAt,
  cardTarget: (id: number) => OptionView | undefined,
  seatTarget: (seat: number) => OptionView | undefined,
): OptionView | null {
  for (const id of at.ids ?? []) {
    const o = cardTarget(id);
    if (o) return o;
  }
  if (at.seat !== null) return seatTarget(at.seat) ?? null;
  return null;
}

/**
 * The target options of a decision, by card id and by seat (newer servers say exactly what each
 * option targets), and by name for older servers whose options only read "Target Sol Ring".
 */
export function targetIndex(options: OptionView[]) {
  const byId = new Map<number, OptionView>();
  const bySeat = new Map<number, OptionView>();
  const byName = new Map<string, OptionView>();
  for (const o of options) {
    if (o.object !== null || !o.label.startsWith("Target ")) continue;
    if (o.target?.kind === "object") {
      if (!byId.has(o.target.id)) byId.set(o.target.id, o);
    } else if (o.target?.kind === "player") {
      if (!bySeat.has(o.target.seat)) bySeat.set(o.target.seat, o);
    } else {
      const name = o.label.slice(7);
      if (!byName.has(name)) byName.set(name, o);
    }
  }
  return { byId, bySeat, byName, size: byId.size + bySeat.size + byName.size };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * An arrow's path: a quadratic curve whose control point sits off the midpoint, perpendicular to
 * the line, by min(80, 0.3 × length) (the spec's arc, as phase's client draws it).
 */
export function arcPath(from: Point, to: Point): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const bend = Math.min(80, d * 0.3);
  const cx = (from.x + to.x) / 2 + (-dy / d) * bend;
  const cy = (from.y + to.y) / 2 + (dx / d) * bend;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `M ${r(from.x)} ${r(from.y)} Q ${r(cx)} ${r(cy)} ${r(to.x)} ${r(to.y)}`;
}

export function centre(r: { left: number; top: number; width: number; height: number }): Point {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
