// The board's drag overlay: the card that follows the pointer while you drag it out of your hand,
// the arrow from an attacker, blocker or spell to the pointer, and the arrows of the attacks and
// blocks you're building (PP-26, PP-40, PP-41, PP-42). One fixed layer with pointer-events: none.
// Your arrows are your seat color (--seat-1, blue); other seats' attacks are drawn in their seat
// colors (design/tokens.md).
// Moves go straight to the DOM (transform and the path's `d`), never through React state, so a
// drag stays at frame rate.

import { forwardRef, useImperativeHandle, useLayoutEffect, useReducer, useRef } from "react";
import { arcPath, centre, type Point } from "./drag";

export type ArrowTone = "attack" | "block" | "aim";

/** Another seat's arrow color (board.css, --seat-N): seat-2 is the first opponent in turn order. */
export type SeatTone = "seat-2" | "seat-3" | "seat-4" | "seat-5" | "seat-6";

const TONES = ["attack", "block", "aim", "seat-2", "seat-3", "seat-4", "seat-5", "seat-6"] as const;

export interface DragLayerHandle {
  /** Lift a card image from `rect`, held at the pointer's offset inside it. */
  lift(img: string | null, name: string, rect: DOMRect, x: number, y: number): void;
  /** Move the lifted card; `ok` and `note` describe what letting go would do. */
  carry(x: number, y: number, ok: boolean | null, note: string | null): void;
  /** Let go: glide back to `back` (or vanish), or stay parked where it is (`park`). */
  drop(how: { back: DOMRect } | "vanish" | "park"): void;
  /** Hide a parked card. */
  clear(): void;
  /** Where the lifted or parked card is now, for an arrow that starts at it. */
  parkedAt(): Point | null;
  /** Draw the live arrow, or hide it with `null`. */
  arrow(from: Point | null, to?: Point, tone?: ArrowTone): void;
}

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export const DragLayer = forwardRef<DragLayerHandle>(function DragLayer(_props, ref) {
  const ghost = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const name = useRef<HTMLSpanElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const path = useRef<SVGPathElement>(null);
  const grab = useRef({ dx: 0, dy: 0, w: 120, h: 168 });
  const at = useRef<Point | null>(null);

  const carry = (x: number, y: number, ok: boolean | null, text: string | null) => {
    const g = ghost.current;
    if (!g) return;
    const { dx, dy } = grab.current;
    at.current = { x: x - dx + grab.current.w / 2, y: y - dy + grab.current.h / 2 };
    g.style.transform = `translate3d(${x - dx}px, ${y - dy}px, 0) rotate(${ok ? -2 : 0}deg) scale(${ok ? 1.06 : 1})`;
    g.dataset.ok = ok === null ? "" : ok ? "yes" : "no";
    if (note.current) {
      note.current.hidden = !text;
      note.current.textContent = text ?? "";
    }
  };

  useImperativeHandle(ref, () => ({
    lift(src, cardName, rect, x, y) {
      const g = ghost.current;
      if (!g) return;
      grab.current = { dx: x - rect.left, dy: y - rect.top, w: rect.width, h: rect.height };
      g.style.width = `${rect.width}px`;
      g.style.transition = "none";
      if (img.current) {
        img.current.hidden = !src;
        if (src) img.current.src = src;
      }
      if (name.current) {
        name.current.hidden = !!src;
        name.current.textContent = cardName;
      }
      g.dataset.state = "carry";
      g.hidden = false;
      carry(x, y, null, null);
    },
    carry,
    drop(how) {
      const g = ghost.current;
      if (!g) return;
      if (note.current) note.current.hidden = true;
      if (how === "park") {
        g.dataset.state = "parked";
        g.dataset.ok = "";
        return;
      }
      at.current = null;
      if (how === "vanish" || reduced()) {
        g.hidden = true;
        return;
      }
      g.style.transition = "transform 160ms ease-out";
      g.style.transform = `translate3d(${how.back.left}px, ${how.back.top}px, 0)`;
      window.setTimeout(() => {
        if (g.dataset.state === "carry") g.hidden = true;
      }, 170);
    },
    clear() {
      const g = ghost.current;
      if (g && g.dataset.state === "parked") g.hidden = true;
      at.current = null;
    },
    parkedAt() {
      return ghost.current && !ghost.current.hidden ? at.current : null;
    },
    arrow(from, to, tone = "aim") {
      const p = path.current;
      if (!p) return;
      if (!from || !to) {
        p.style.display = "none";
        return;
      }
      p.style.display = "";
      p.setAttribute("d", arcPath(from, to));
      p.setAttribute("class", `drag-arrow ${tone}`);
      p.setAttribute("marker-end", `url(#pb-head-${tone})`);
    },
  }));

  return (
    <div className="drag-layer" aria-hidden="true">
      <svg className="drag-svg">
        <ArrowHeads prefix="pb-head" />
        <path ref={path} className="drag-arrow" style={{ display: "none" }} />
      </svg>
      <div ref={ghost} className="drag-ghost" hidden>
        <img ref={img} alt="" draggable={false} />
        <span ref={name} className="drag-ghost-name" />
        <span ref={note} className="drag-ghost-note" hidden />
      </div>
    </div>
  );
});

function ArrowHeads({ prefix }: { prefix: string }) {
  return (
    <defs>
      {TONES.map((t) => (
        <marker key={t} id={`${prefix}-${t}`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" className={`drag-head ${t}`} />
        </marker>
      ))}
    </defs>
  );
}

/**
 * One arrow on the board: the attack or blocks being built and the targets being chosen (yours,
 * blue), or another seat's attack, block or targets (in its seat color). It runs from a card, a
 * row of the stack list or a point (the card you just cast, parked where you let go) to a seat
 * (an opponent's header, or your portrait) or a card.
 */
export interface PlanArrow {
  from: number | { stack: number; source?: number } | { point: Point };
  to: { seat: number } | { id: number };
  tone: "attack" | "block" | SeatTone;
}

/** Hidden stack/details rows must never produce a (0,0) arrow or animation. */
export function visibleAnchor(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  let left = Math.max(0, r.left), top = Math.max(0, r.top);
  let right = Math.min(window.innerWidth, r.right), bottom = Math.min(window.innerHeight, r.bottom);
  for (let parent: HTMLElement | null = el; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (parent === el) continue;
    const clip = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
  }
  // A mostly clipped source is not a useful arrow origin: prefer its visible stack card.
  return right - left >= r.width * 0.8 && bottom - top >= r.height * 0.8;
}

/** A row of the stack list (`data-stack-id`), where a spell's arrows start. */
export function stackRowOf(root: ParentNode, id: number): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>(`[data-stack-id="${id}"]`)].find(visibleAnchor) ?? null;
}

const fromKey = (f: PlanArrow["from"]) => (typeof f === "number" ? `${f}` : "stack" in f ? `s${f.stack}` : `${Math.round(f.point.x)},${Math.round(f.point.y)}`);

/** A card's tile on the board (a stack of tokens is one tile holding every id). */
export function tileOf(root: ParentNode, id: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-ids~="${id}"]`);
}

/** A seat's header, where arrows to a player end. */
export function seatHeadOf(root: ParentNode, seat: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-seat="${seat}"] .opp-head`) ?? root.querySelector<HTMLElement>(`[data-seat="${seat}"]`);
}

/** The arrows of the attack and blocks you're building, kept drawn until you send them. */
export function PlanArrows({ arrows, root }: { arrows: PlanArrow[]; root: React.RefObject<HTMLElement | null> }) {
  const [, remeasure] = useReducer((n: number) => n + 1, 0);
  const svg = useRef<SVGSVGElement>(null);
  const key = arrows.map((a) => `${fromKey(a.from)}>${"seat" in a.to ? `s${a.to.seat}` : a.to.id}`).join(",");
  useLayoutEffect(() => {
    const el = svg.current;
    const r = root.current;
    if (!el || !r) return;
    const paths: string[] = [];
    // A stack of identical attackers is one tile: one arrow from it to each place it attacks.
    const drawn = new Set<string>();
    for (const a of arrows) {
      const permanent = typeof a.from === "object" && "stack" in a.from && a.from.source !== undefined ? tileOf(r, a.from.source) : null;
      const from = typeof a.from === "number" ? tileOf(r, a.from) : "stack" in a.from ? (permanent && visibleAnchor(permanent) ? permanent : stackRowOf(r, a.from.stack)) : null;
      const to = "seat" in a.to ? seatHeadOf(r, a.to.seat) : tileOf(r, a.to.id);
      if ((!from && !(typeof a.from === "object" && "point" in a.from)) || !to || !visibleAnchor(to) || (from && !visibleAnchor(from))) continue;
      const pair = `${from?.dataset.ids ?? fromKey(a.from)}>${"seat" in a.to ? `s${a.to.seat}` : a.to.id}>${a.tone}`;
      if (drawn.has(pair)) continue;
      drawn.add(pair);
      const tr = to.getBoundingClientRect();
      // From a stack row: its left edge, toward the board. From a point: the point itself.
      const start = !from ? (a.from as { point: Point }).point : from.hasAttribute("data-stack-id") ? { x: from.getBoundingClientRect().left + 6, y: centre(from.getBoundingClientRect()).y } : centre(from.getBoundingClientRect());
      // Arrows to a player end at the near edge of their header or portrait; to a card, at its centre.
      const end = "seat" in a.to ? { x: tr.left + tr.width / 2, y: start.y < tr.top ? tr.top + 6 : tr.bottom - 6 } : centre(tr);
      const theirs = a.tone.startsWith("seat-") ? " theirs" : "";
      paths.push(`<path class="plan-arrow ${a.tone}${theirs}" d="${arcPath(start, end)}" marker-end="url(#pb-plan-head-${a.tone})"/>`);
    }
    // Other seats' arrows first, so yours are drawn on top.
    paths.sort((x, y) => Number(y.includes(" theirs")) - Number(x.includes(" theirs")));
    el.querySelector("g")!.innerHTML = paths.join("");
  });
  useLayoutEffect(() => {
    if (!arrows.length) return;
    const on = () => remeasure();
    window.addEventListener("resize", on);
    window.addEventListener("scroll", on, true);
    const ro = typeof ResizeObserver !== "undefined" && root.current ? new ResizeObserver(on) : null;
    if (ro && root.current) ro.observe(root.current);
    return () => {
      window.removeEventListener("resize", on);
      window.removeEventListener("scroll", on, true);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!arrows.length) return null;
  return (
    <svg ref={svg} className="plan-svg" aria-hidden="true">
      <ArrowHeads prefix="pb-plan-head" />
      <g />
    </svg>
  );
}
