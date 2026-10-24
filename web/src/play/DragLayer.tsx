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
 * One arrow of the attack or blocks being built (yours, blue), or of another seat's attack (in
 * its seat color): from a card to a seat (an opponent's header, or your portrait) or a card.
 */
export interface PlanArrow {
  from: number;
  to: { seat: number } | { id: number };
  tone: "attack" | "block" | SeatTone;
}

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
  const key = arrows.map((a) => `${a.from}>${"seat" in a.to ? `s${a.to.seat}` : a.to.id}`).join(",");
  useLayoutEffect(() => {
    const el = svg.current;
    const r = root.current;
    if (!el || !r) return;
    const paths: string[] = [];
    // A stack of identical attackers is one tile: one arrow from it to each place it attacks.
    const drawn = new Set<string>();
    for (const a of arrows) {
      const from = tileOf(r, a.from);
      const to = "seat" in a.to ? seatHeadOf(r, a.to.seat) : tileOf(r, a.to.id);
      if (!from || !to) continue;
      const pair = `${from.dataset.ids}>${"seat" in a.to ? `s${a.to.seat}` : a.to.id}>${a.tone}`;
      if (drawn.has(pair)) continue;
      drawn.add(pair);
      const fr = from.getBoundingClientRect();
      const tr = to.getBoundingClientRect();
      const start = centre(fr);
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
    const ro = typeof ResizeObserver !== "undefined" && root.current ? new ResizeObserver(on) : null;
    if (ro && root.current) ro.observe(root.current);
    return () => {
      window.removeEventListener("resize", on);
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
