// Drag to reorder, for the lists you put in order: triggers (GTriggers), cards (GOrder) and
// the hand. A press follows the pointer, the other entries slide aside to open the gap where it
// will land, an outlined slot marks that gap, and letting go moves the entry there once. The
// layout is measured when the drag starts and the DOM order only changes on the drop, so the
// pressed element (which holds the pointer capture) never moves in the document mid-drag.
//
// A mouse, pen or trackpad drags from anywhere on a row that isn't one of its buttons. A finger
// drags at once from a grip (`data-reorder-grip`, which has `touch-action: none`), or from the
// rest of the row after holding it still for a moment, so a swipe over the list still scrolls.
// The arrows next to each entry stay the keyboard way to reorder.

import { useCallback, useEffect, useRef, useState } from "react";
import { dragSlop, movedPast } from "./drag";

export type Axis = "x" | "y";
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How long a finger holds a row still before it picks the row up. */
export const HOLD_MS = 250;

/**
 * Where an entry dragged from `from` lands with the pointer at (`x`, `y`), measured against the
 * entries' boxes when the drag started. A column (`y`) counts the other entries whose middle the
 * pointer is below. A row (`x`), which may wrap, counts the entries on rows above the pointer and
 * those on its row whose middle it is past; a pointer above or below the list counts as on its
 * first or last row, so a single row only reads across.
 */
export function dropIndex(boxes: readonly Box[], from: number, x: number, y: number, axis: Axis): number {
  if (boxes.length < 2) return 0;
  let to = 0;
  if (axis === "y") {
    boxes.forEach((b, k) => {
      if (k !== from && y > b.top + b.height / 2) to++;
    });
    return to;
  }
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  const lastRowTop = Math.max(...boxes.map((b) => b.top));
  const firstRowBottom = Math.min(...boxes.filter((b) => b.top === top).map((b) => b.top + b.height));
  const cy = y < top ? (top + firstRowBottom) / 2 : y > bottom ? (lastRowTop + bottom) / 2 : y;
  boxes.forEach((b, k) => {
    if (k === from) return;
    const rowAbove = cy >= b.top + b.height;
    const sameRowPast = cy >= b.top && x > b.left + b.width / 2;
    if (rowAbove || sameRowPast) to++;
  });
  return to;
}

/** The nearest place to `to` an entry may go, stepping back towards `from` (a split pile keeps its cards). */
export function allowedTarget(from: number, to: number, canMove?: (from: number, to: number) => boolean): number {
  if (!canMove) return to;
  let at = to;
  while (at !== from && !canMove(from, at)) at += at > from ? -1 : 1;
  return at;
}

/**
 * How far each entry slides while the one at `from` is held over `to`, so the others show the
 * order it would make. A column moves the entries in between by the dragged one's height and the
 * gap; a row (cards of one size, possibly wrapping) moves each into the slot of its new place.
 * The dragged entry's own offset is 0 here: it follows the pointer instead.
 */
export function shifts(boxes: readonly Box[], from: number, to: number, axis: Axis): { dx: number; dy: number }[] {
  const out = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (from === to) return out;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const up = from < to; // the others move up (or left) to fill in behind it
  const step = axis === "y" ? columnStep(boxes, from) : 0;
  for (let k = lo; k <= hi; k++) {
    if (k === from) continue;
    const j = up ? k - 1 : k + 1;
    if (axis === "y") out[k] = { dx: 0, dy: up ? -step : step };
    else out[k] = { dx: boxes[j]!.left - boxes[k]!.left, dy: boxes[j]!.top - boxes[k]!.top };
  }
  return out;
}

/** The box the dragged entry would fill at `to`, for the drop marker. */
export function landing(boxes: readonly Box[], from: number, to: number, axis: Axis): Box {
  const me = boxes[from]!;
  const at = boxes[to]!;
  if (axis === "x") return { left: at.left, top: at.top, width: me.width, height: me.height };
  const top = to > from ? at.top + at.height - me.height : at.top;
  return { left: me.left, top, width: me.width, height: me.height };
}

/** A column entry's height plus the gap below it: how far its neighbours move to take its place. */
function columnStep(boxes: readonly Box[], from: number): number {
  let gap = Infinity;
  for (let k = 1; k < boxes.length; k++) gap = Math.min(gap, boxes[k]!.top - (boxes[k - 1]!.top + boxes[k - 1]!.height));
  return boxes[from]!.height + (Number.isFinite(gap) && gap > 0 ? gap : 0);
}

/** True while a reorder press holds a row: a long press then picks it up rather than reading the card. */
export const reorderHold = { active: false };

type Press = {
  pointer: number;
  touch: boolean;
  grip: boolean;
  row: HTMLElement;
  x0: number;
  y0: number;
  state: "pending" | "held" | "drag";
  timer: number | null;
  items: HTMLElement[];
  boxes: Box[];
  from: number;
  to: number;
  /** The list's box and its own scroll when the drag started. */
  list0: { left: number; top: number; scrollLeft: number; scrollTop: number };
  slot: HTMLElement | null;
};

/** Elements in a row that keep their own press: the arrows and anything else you click. */
const OWN_PRESS = "button, a, input, select, textarea, summary, [data-reorder-skip]";

export interface ReorderOptions {
  /** Runs once the drop is in, after `onMove` (the hand order sends the new order then). */
  onEnd?: () => void;
  /** Whether the entry at `from` may go to `to`; the drop goes to the nearest place it may. */
  canMove?: (from: number, to: number) => boolean;
  /** No drags while the answer is on its way. */
  disabled?: boolean;
}

/**
 * Drag to reorder a list. Spread `row` on each entry (an element of the list itself), mark a
 * grip with `grip`, and put `list` on the list. `onMove(from, to)` runs once, on the drop.
 */
export function useReorder(axis: Axis, onMove: (from: number, to: number) => void, opts: ReorderOptions = {}) {
  const listEl = useRef<HTMLElement | null>(null);
  const press = useRef<Press | null>(null);
  const latest = useRef({ axis, onMove, opts });
  latest.current = { axis, onMove, opts };

  // One finish and one Escape listener for the hook's life, so the listener comes off again.
  const [finish, onKey] = useState(() => {
    const end = (commit: boolean) => {
      const p = press.current;
      press.current = null;
      reorderHold.active = false;
      window.removeEventListener("keydown", key, true);
      if (!p) return;
      if (p.timer !== null) window.clearTimeout(p.timer);
      p.row.classList.remove("reorder-held");
      if (p.state !== "drag") return;
      // Put everything back without animating, in the same frame React moves the entry.
      listEl.current?.classList.remove("reordering");
      p.row.classList.remove("reorder-dragging");
      for (const el of p.items) el.style.transform = "";
      p.slot?.remove();
      if (commit && p.to !== p.from) {
        latest.current.onMove(p.from, p.to);
        latest.current.opts.onEnd?.();
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && press.current?.state === "drag") {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    return [end, key] as const;
  })[0];

  // A finger that has picked a row up must not scroll the page: a touchmove listener that can
  // cancel has to be on the element before the touch starts (React's own are passive).
  const touchMove = useCallback((e: TouchEvent) => {
    if (press.current && press.current.state !== "pending" && e.cancelable) e.preventDefault();
  }, []);
  const list = useCallback(
    (el: HTMLElement | null) => {
      listEl.current?.removeEventListener("touchmove", touchMove);
      listEl.current = el;
      el?.addEventListener("touchmove", touchMove, { passive: false });
    },
    [touchMove],
  );
  useEffect(() => () => finish(false), [finish]);

  const start = (p: Press) => {
    const el = listEl.current;
    if (!el) return finish(false);
    p.items = [...el.querySelectorAll<HTMLElement>(":scope > [data-reorder]")];
    p.from = p.items.indexOf(p.row);
    if (p.from < 0) return finish(false);
    p.boxes = p.items.map((it) => {
      const r = it.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    const lr = el.getBoundingClientRect();
    p.list0 = { left: lr.left, top: lr.top, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
    p.to = p.from;
    p.state = "drag";
    reorderHold.active = true;
    p.row.classList.remove("reorder-held");
    p.row.classList.add("reorder-dragging");
    el.classList.add("reordering");
    const slot = document.createElement("div");
    slot.className = `reorder-slot ${latest.current.axis}`;
    slot.setAttribute("aria-hidden", "true");
    // Inside the list, under its entries, so it never covers a card's image.
    el.appendChild(slot);
    p.slot = slot;
    place(p);
    window.addEventListener("keydown", onKey, true);
  };

  /** Put the drop marker where the entry would land, in the list's own coordinates. */
  const place = (p: Press) => {
    if (!p.slot) return;
    const b = landing(p.boxes, p.from, p.to, latest.current.axis);
    const radius = getComputedStyle(p.row).borderRadius;
    Object.assign(p.slot.style, { left: `${b.left - p.list0.left + p.list0.scrollLeft}px`, top: `${b.top - p.list0.top + p.list0.scrollTop}px`, width: `${b.width}px`, height: `${b.height}px`, borderRadius: radius });
  };

  const drag = (p: Press, e: React.PointerEvent) => {
    const { axis: ax, opts: o } = latest.current;
    // How far the entries have moved on screen since the drag started: the page or the list scrolled.
    const el = listEl.current;
    const lr = el?.getBoundingClientRect();
    const sx = el && lr ? lr.left - p.list0.left - (el.scrollLeft - p.list0.scrollLeft) : 0;
    const sy = el && lr ? lr.top - p.list0.top - (el.scrollTop - p.list0.scrollTop) : 0;
    const x = e.clientX - sx;
    const y = e.clientY - sy;
    p.row.style.transform = `translate(${ax === "y" ? 0 : x - p.x0}px, ${y - p.y0}px)`;
    const to = allowedTarget(p.from, dropIndex(p.boxes, p.from, x, y, ax), o.canMove);
    if (to !== p.to) {
      p.to = to;
      shifts(p.boxes, p.from, to, ax).forEach((s, k) => {
        if (k !== p.from) p.items[k]!.style.transform = s.dx || s.dy ? `translate(${s.dx}px, ${s.dy}px)` : "";
      });
    }
    place(p);
  };

  const row = {
    "data-reorder": "",
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (latest.current.opts.disabled || press.current || !e.isPrimary) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const target = e.target as Element;
      const gripEl = target.closest("[data-reorder-grip]");
      const grip = !!gripEl && e.currentTarget.contains(gripEl);
      const own = target.closest(OWN_PRESS);
      if (!grip && own && e.currentTarget.contains(own)) return;
      const touch = e.pointerType === "touch";
      // A finger on a card image that reads on a long press: leave it to reading and scrolling.
      if (touch && !grip && target.closest("[data-reads]")) return;
      const p: Press = { pointer: e.pointerId, touch, grip, row: e.currentTarget, x0: e.clientX, y0: e.clientY, state: "pending", timer: null, items: [], boxes: [], from: -1, to: -1, list0: { left: 0, top: 0, scrollLeft: 0, scrollTop: 0 }, slot: null };
      press.current = p;
      // Keep the pointer's events coming here even when it leaves the row. Capture on the pressed
      // element itself, so a click on it still lands on it (a touch is captured there already).
      if (!touch) {
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          /* an element that can't hold capture still gets the moves over the row */
        }
      }
      if (touch && !grip) {
        p.timer = window.setTimeout(() => {
          p.timer = null;
          if (press.current !== p) return;
          p.state = "held";
          reorderHold.active = true;
          p.row.classList.add("reorder-held");
          navigator.vibrate?.(8);
        }, HOLD_MS);
      }
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p || p.pointer !== e.pointerId) return;
      if (p.state === "drag") return drag(p, e);
      const moved = movedPast(p.x0, p.y0, e.clientX, e.clientY, dragSlop(e.pointerType));
      if (p.state === "held") {
        start(p);
        if (press.current === p) drag(p, e);
        return;
      }
      if (!moved) return;
      // A finger that moves before the hold is a scroll, not a drag.
      if (p.touch && !p.grip) return finish(false);
      start(p);
      if (press.current === p) drag(p, e);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      if (press.current?.pointer === e.pointerId) finish(true);
    },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
      if (press.current?.pointer === e.pointerId) finish(false);
    },
    onContextMenu: (e: React.MouseEvent) => {
      // A long press on a phone opens the context menu; not while it is holding a row.
      if (press.current && press.current.state !== "pending") e.preventDefault();
    },
  };

  return { list, row, grip: { "data-reorder-grip": "" } as const };
}
