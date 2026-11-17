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

/** Where each entry sits after the one at `from` moves to `to`: entry `order[m]` at place `m`. */
function reordered(n: number, from: number, to: number): number[] {
  const order = Array.from({ length: n }, (_, k) => k);
  order.splice(to, 0, ...order.splice(from, 1));
  return order;
}

/**
 * Where the entry that ends up at place `m` would start on screen. A column stacks the places as
 * they were (so a split marker or a wider gap between two places stays where it is) and adds how
 * much taller or shorter the entries above it are now. A row (cards of one size, possibly
 * wrapping) uses the place's own box.
 */
function placeAt(boxes: readonly Box[], order: readonly number[], m: number, axis: Axis): { left: number; top: number } {
  const at = boxes[m]!;
  if (axis === "x") return { left: at.left, top: at.top };
  let top = at.top;
  for (let i = 0; i < m; i++) top += boxes[order[i]!]!.height - boxes[i]!.height;
  return { left: boxes[order[m]!]!.left, top };
}

/**
 * How far each entry slides while the one at `from` is held over `to`, so the others show the
 * order it would make. The dragged entry's own offset is 0 here: it follows the pointer instead.
 */
export function shifts(boxes: readonly Box[], from: number, to: number, axis: Axis): { dx: number; dy: number }[] {
  const out = boxes.map(() => ({ dx: 0, dy: 0 }));
  if (from === to) return out;
  const order = reordered(boxes.length, from, to);
  order.forEach((k, m) => {
    if (k === from || k === m) return;
    const p = placeAt(boxes, order, m, axis);
    out[k] = { dx: p.left - boxes[k]!.left, dy: p.top - boxes[k]!.top };
  });
  return out;
}

/** The box the dragged entry would fill at `to`, for the drop marker. */
export function landing(boxes: readonly Box[], from: number, to: number, axis: Axis): Box {
  const me = boxes[from]!;
  const p = placeAt(boxes, reordered(boxes.length, from, to), to, axis);
  return { left: p.left, top: p.top, width: me.width, height: me.height };
}

/**
 * The press holding a row, across every list: while it's held, a long press picks the row up
 * rather than reading the card; and a long press that reads a card ends a press that hasn't
 * become a drag yet (`cancel`), so the card isn't dragged out from under its reader.
 */
export const reorderHold: { active: boolean; cancel: (() => void) | null } = { active: false, cancel: null };

type Press = {
  pointer: number;
  touch: boolean;
  grip: boolean;
  row: HTMLElement;
  x0: number;
  y0: number;
  /** The pointer's last place, to redraw the drag when the page scrolls under it. */
  x: number;
  y: number;
  state: "pending" | "held" | "drag";
  timer: number | null;
  items: HTMLElement[];
  boxes: Box[];
  /** A single row: the dragged entry only moves across it, so it never leaves the strip. */
  oneRow: boolean;
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

  /** The entries now, in the order they're drawn. */
  const entries = () => (listEl.current ? [...listEl.current.querySelectorAll<HTMLElement>(":scope > [data-reorder]")] : []);

  /** Put the drop marker where the entry would land, in the list's own coordinates. */
  const place = (p: Press) => {
    if (!p.slot) return;
    const b = landing(p.boxes, p.from, p.to, latest.current.axis);
    Object.assign(p.slot.style, { left: `${b.left - p.list0.left + p.list0.scrollLeft}px`, top: `${b.top - p.list0.top + p.list0.scrollTop}px`, width: `${b.width}px`, height: `${b.height}px` });
  };

  const drag = (p: Press, clientX: number, clientY: number) => {
    const { axis: ax, opts: o } = latest.current;
    p.x = clientX;
    p.y = clientY;
    // How far the entries have moved on screen since the drag started: the page or the list scrolled.
    const el = listEl.current;
    const lr = el?.getBoundingClientRect();
    const sx = el && lr ? lr.left - p.list0.left - (el.scrollLeft - p.list0.scrollLeft) : 0;
    const sy = el && lr ? lr.top - p.list0.top - (el.scrollTop - p.list0.scrollTop) : 0;
    const x = clientX - sx;
    const y = clientY - sy;
    p.row.style.transform = `translate(${ax === "y" ? 0 : x - p.x0}px, ${p.oneRow ? 0 : y - p.y0}px)`;
    const to = allowedTarget(p.from, dropIndex(p.boxes, p.from, x, y, ax), o.canMove);
    if (to !== p.to) {
      p.to = to;
      shifts(p.boxes, p.from, to, ax).forEach((s, k) => {
        if (k !== p.from) p.items[k]!.style.transform = s.dx || s.dy ? `translate(${s.dx}px, ${s.dy}px)` : "";
      });
    }
    place(p);
  };
  const dragNow = useRef(drag);
  dragNow.current = drag;

  // One set of window listeners for the hook's life, so each comes off again. They end a press
  // wherever the pointer is let go (even off the list, or after the pressed element was redrawn),
  // cancel a drag on Escape, and redraw it when the page scrolls under a still pointer.
  const [win] = useState(() => {
    const end = (commit: boolean) => {
      const p = press.current;
      press.current = null;
      if (reorderHold.cancel === cancel) {
        reorderHold.cancel = null;
        reorderHold.active = false;
      }
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      if (!p) return;
      if (p.timer !== null) window.clearTimeout(p.timer);
      p.row.classList.remove("reorder-held");
      if (p.state !== "drag") return;
      // Put everything back without animating, in the same frame React moves the entry.
      listEl.current?.classList.remove("reordering");
      p.row.classList.remove("reorder-dragging");
      for (const el of p.items) el.style.transform = "";
      p.slot?.remove();
      // The list changed under the drag (a new decision, a card drawn): the places it measured
      // no longer mean the same entries, so the drop does nothing.
      const now = entries();
      const same = now.length === p.items.length && now.every((el, k) => el === p.items[k]);
      if (commit && same && p.to !== p.from) {
        latest.current.onMove(p.from, p.to);
        latest.current.opts.onEnd?.();
      }
    };
    const cancel = () => end(false);
    const up = (e: PointerEvent) => {
      if (press.current?.pointer === e.pointerId) end(e.type === "pointerup");
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && press.current?.state === "drag") {
        e.preventDefault();
        e.stopPropagation();
        end(false);
      }
    };
    const scroll = () => {
      const p = press.current;
      if (p?.state === "drag") dragNow.current(p, p.x, p.y);
    };
    const listen = () => {
      reorderHold.cancel = cancel;
      window.addEventListener("pointerup", up, true);
      window.addEventListener("pointercancel", up, true);
      window.addEventListener("keydown", key, true);
      window.addEventListener("scroll", scroll, true);
    };
    return { end, listen };
  });
  const finish = win.end;

  // A finger that has picked a row up must not scroll the page: a touchmove listener that can
  // cancel has to be on the element before the touch starts (React's own are passive).
  const touchMove = useCallback((e: TouchEvent) => {
    // A pen (an Apple Pencil sends touch events) drags like a mouse, so it never scrolls a row.
    const p = press.current;
    if (p && (p.state !== "pending" || !p.touch) && e.cancelable) e.preventDefault();
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
    p.items = entries();
    p.from = p.items.indexOf(p.row);
    if (!el || p.from < 0) return finish(false);
    p.boxes = p.items.map((it) => {
      const r = it.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    p.oneRow = latest.current.axis === "x" && p.boxes.every((b) => Math.abs(b.top - p.boxes[0]!.top) < 1);
    const lr = el.getBoundingClientRect();
    p.list0 = { left: lr.left, top: lr.top, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
    p.to = p.from;
    p.state = "drag";
    reorderHold.active = true;
    p.row.classList.remove("reorder-held");
    p.row.classList.add("reorder-dragging");
    el.classList.add("reordering");
    const slot = document.createElement("div");
    slot.className = "reorder-slot";
    slot.setAttribute("aria-hidden", "true");
    slot.style.borderRadius = getComputedStyle(p.row).borderRadius;
    // Inside the list, under its entries, so it never covers a card's image.
    el.appendChild(slot);
    p.slot = slot;
    place(p);
  };

  const row = {
    "data-reorder": "",
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (latest.current.opts.disabled || !e.isPrimary) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // A press whose end never reached us (a new primary pointer means it's over): drop it.
      if (press.current) finish(false);
      const target = e.target as Element;
      const gripEl = target.closest("[data-reorder-grip]");
      const grip = !!gripEl && e.currentTarget.contains(gripEl);
      const own = target.closest(OWN_PRESS);
      if (!grip && own && e.currentTarget.contains(own)) return;
      const touch = e.pointerType === "touch";
      // A finger on a card image that reads on a long press: leave it to reading and scrolling.
      if (touch && !grip && target.closest("[data-reads]")) return;
      const p: Press = { pointer: e.pointerId, touch, grip, row: e.currentTarget, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, state: "pending", timer: null, items: [], boxes: [], oneRow: false, from: -1, to: -1, list0: { left: 0, top: 0, scrollLeft: 0, scrollTop: 0 }, slot: null };
      // Another list's press ends here too: only one is ever held.
      reorderHold.cancel?.();
      press.current = p;
      win.listen();
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
      if (p.state === "drag") return drag(p, e.clientX, e.clientY);
      if (p.state === "pending") {
        if (!movedPast(p.x0, p.y0, e.clientX, e.clientY, dragSlop(e.pointerType))) return;
        // A finger that moves before the hold is a scroll, not a drag.
        if (p.touch && !p.grip) return finish(false);
      }
      start(p);
      if (press.current === p) drag(p, e.clientX, e.clientY);
    },
    onContextMenu: (e: React.MouseEvent) => {
      // A long press on a phone opens the context menu; not while it is holding a row.
      if (press.current && press.current.state !== "pending") e.preventDefault();
    },
  };

  return { list, row, grip: { "data-reorder-grip": "" } as const };
}
