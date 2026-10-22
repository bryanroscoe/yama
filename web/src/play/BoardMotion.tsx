// Board motion (PP-53 to PP-56): cards fly between zones, leave for their pile instead of
// vanishing, draws slide in from the library, life totals tick with a floating number, the stack
// resolves visibly, a turn and the end of the game get a moment. Built from board-to-board
// differences (motion.ts), drawn with the Web Animations API on `transform` and `opacity` only.
// Nothing here blocks input or waits for the engine: each new board settles at once and the
// animations play over it, shortened at watch speeds and off for reduced motion.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { deltaText, dur, lifeChanges, lifeOf, MS, stackChange, tickValue, turnBegan, zonesOf, type StackItem } from "./motion";
import type { CardMeta, View } from "./types";

/** The current motion scale (motion.ts, motionScale): 0 means no motion. */
export const MotionContext = createContext(1);

/** A number that counts to its new value instead of jumping (life totals). */
export function Tick({ value }: { value: number }) {
  const scale = useContext(MotionContext);
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (scale === 0 || from.current === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    const ms = Math.max(120, dur(MS.lifeTick, scale));
    let frame = requestAnimationFrame(function step(now) {
      const t = (now - start) / ms;
      setShown(tickValue(a, value, t));
      if (t < 1) frame = requestAnimationFrame(step);
      else from.current = value;
    });
    return () => {
      cancelAnimationFrame(frame);
      from.current = value;
    };
  }, [value, scale]);
  return <>{shown}</>;
}

interface Seen {
  rect: DOMRect;
  img: string | null;
  kind: "ft" | "hc";
  /** Lifted by a drag when this was measured: it reappears where it was dropped, not from here. */
  dragged: boolean;
}

export interface MotionOptions {
  you: number | null;
  /** The seat at the bottom of the board. */
  bottom: number;
  scale: number;
  meta: Record<string, CardMeta>;
  /** Words for the turn banner and the end of the game. */
  turnText: (seat: number) => string | null;
  endText: (view: View) => string;
  endArt: (view: View) => string | null;
}

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Measure every card on the board by id (a stack of tokens is one tile holding every id). */
function measure(root: HTMLElement) {
  const els = new Map<number, HTMLElement>();
  const seen = new Map<number, Seen>();
  for (const el of root.querySelectorAll<HTMLElement>(".ft[data-ids], .hc[data-id]")) {
    if (el.closest(".sheet")) continue;
    const kind = el.classList.contains("ft") ? "ft" : "hc";
    const ids = kind === "ft" ? (el.dataset.ids ?? "").split(" ").map(Number) : [Number(el.dataset.id)];
    const rect = el.getBoundingClientRect();
    if (!rect.width) continue;
    const img = el.querySelector("img")?.getAttribute("src") ?? null;
    for (const id of ids) {
      if (!Number.isFinite(id) || els.has(id)) continue;
      els.set(id, el);
      seen.set(id, { rect, img, kind, dragged: el.classList.contains("drag-src") });
    }
  }
  return { els, seen };
}

function flyFrom(el: HTMLElement, from: DOMRect, to: DOMRect, ms: number, delay = 0) {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && Math.abs(sx - 1) < 0.02) return;
  el.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, transformOrigin: "0 0" },
      { transform: "translate(0, 0) scale(1, 1)", transformOrigin: "0 0" },
    ],
    { duration: ms, delay, easing: EASE, fill: "backwards", composite: "add" },
  );
}

function pop(el: HTMLElement, ms: number) {
  el.animate([{ transform: "scale(0.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: ms, easing: EASE, composite: "add" });
}

/** A short-lived element in the motion layer, removed when its animation ends. */
function spawn(layer: HTMLElement, make: (el: HTMLDivElement) => void, frames: Keyframe[], opts: KeyframeAnimationOptions) {
  const el = document.createElement("div");
  make(el);
  layer.appendChild(el);
  const a = el.animate(frames, opts);
  a.onfinish = a.oncancel = () => el.remove();
  return el;
}

const centreOf = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/**
 * Animate the board from one View to the next. `options` is a ref the board fills in on each
 * render (the hook runs before the board knows its seats and names).
 */
export function useBoardMotion(root: RefObject<HTMLElement | null>, layer: RefObject<HTMLElement | null>, view: View | undefined, options: RefObject<MotionOptions | null>) {
  const prevCards = useRef<Map<number, Seen> | null>(null);
  const prevLife = useRef<Map<number, number> | null>(null);
  const prevStack = useRef<StackItem[]>([]);
  const prevStackEls = useRef<{ rect: DOMRect; node: HTMLElement }[]>([]);
  const prevTurn = useRef<{ turn: number; active: number } | null>(null);
  const prevOver = useRef<boolean | null>(null);
  const lastRevision = useRef<number | null>(null);

  // Every render measures the board, so a resize or an opened panel never makes a stale start.
  // Only a new board animates.
  useLayoutEffect(() => {
    const r = root.current;
    const L = layer.current;
    const o = options.current;
    if (!r || !view || !o) return;
    const { you, bottom, meta, turnText, endText, endArt } = o;
    const scale = reducedMotion() ? 0 : o.scale;
    const now = measure(r);
    const fresh = lastRevision.current !== null && lastRevision.current !== view.revision;
    const zones = zonesOf(view, you);
    const prev = prevCards.current;
    const stackMoved = fresh ? stackChange(prevStack.current, view.stack) : { left: 0, added: [] };
    /** The stack's top item now (a spell just cast lands there). */
    const stackTop = r.querySelector<HTMLElement>(".rail-stack .stack-list > li.top")?.getBoundingClientRect() ?? null;
    /** The item that just resolved, where it was (a permanent spell comes from there). */
    const resolvedFrom = stackMoved.left > 0 ? prevStackEls.current[0]?.rect ?? null : null;

    if (fresh && prev && L && scale > 0) {
      const moving = new Set<HTMLElement>();
      let draws = 0;
      const libraryChip = r.querySelector<HTMLElement>(`[data-zone="library"][data-zone-seat="${bottom}"]`)?.getBoundingClientRect();
      for (const [id, el] of now.els) {
        if (moving.has(el)) continue;
        const was = prev.get(id);
        const to = now.seen.get(id)!.rect;
        if (was && !was.dragged) {
          moving.add(el);
          const flight = was.kind !== now.seen.get(id)!.kind;
          flyFrom(el, was.rect, to, dur(flight ? MS.flight : MS.reflow, scale));
          continue;
        }
        if (was?.dragged) {
          moving.add(el);
          pop(el, dur(MS.pop, scale));
          continue;
        }
        // New to the board: drawn into your hand, cast from a hidden hand, or a new token.
        const z = zones.get(id);
        if (now.seen.get(id)!.kind === "hc" && z?.zone === "hand" && libraryChip && el.closest(".hand-fan")) {
          moving.add(el);
          const from = new DOMRect(libraryChip.left, libraryChip.top - to.height / 2, to.width * 0.5, to.height * 0.5);
          flyFrom(el, from, to, dur(MS.draw, scale), dur(MS.drawStagger, scale) * draws++);
          continue;
        }
        if (z?.zone === "battlefield" && resolvedFrom) {
          moving.add(el);
          const c = centreOf(resolvedFrom);
          flyFrom(el, new DOMRect(c.x - to.width / 4, c.y - to.height / 4, to.width / 2, to.height / 2), to, dur(MS.flight, scale));
          continue;
        }
        if (z?.zone === "battlefield" && z.seat !== bottom) {
          const head = r.querySelector<HTMLElement>(`[data-seat="${z.seat}"] .opp-head`)?.getBoundingClientRect();
          if (head) {
            moving.add(el);
            const c = centreOf(head);
            flyFrom(el, new DOMRect(c.x - to.width / 4, c.y - to.height / 4, to.width / 2, to.height / 2), to, dur(MS.flight, scale));
            continue;
          }
        }
        moving.add(el);
        pop(el, dur(MS.pop, scale));
      }
      // Cards that left the board fly to their pile (graveyard, exile, hand, command zone).
      let left = 0;
      for (const [id, was] of prev) {
        if (now.els.has(id) || left > 12) continue;
        left++;
        const z = zones.get(id);
        const target = z
          ? r.querySelector<HTMLElement>(`[data-zone="${z.zone}"][data-zone-seat="${z.seat}"]`) ?? (z.seat !== bottom ? r.querySelector<HTMLElement>(`[data-seat="${z.seat}"] .opp-head`) : null)
          : null;
        // Gone from sight while the stack grew: it was cast, so it goes onto the stack.
        const to = target?.getBoundingClientRect() ?? (!z && stackMoved.added.length > 0 ? stackTop ?? undefined : undefined);
        const from = was.rect;
        const dx = to ? centreOf(to).x - centreOf(from).x : 0;
        const dy = to ? centreOf(to).y - centreOf(from).y : -12;
        spawn(
          L,
          (g) => {
            g.className = `motion-ghost ${was.kind}`;
            g.style.left = `${from.left}px`;
            g.style.top = `${from.top}px`;
            g.style.width = `${from.width}px`;
            g.style.height = `${from.height}px`;
            if (was.img) {
              const img = document.createElement("img");
              img.src = was.img;
              img.alt = "";
              g.appendChild(img);
            }
          },
          [
            { transform: "translate(0, 0) scale(1)", opacity: 1 },
            { transform: `translate(0, -10px) scale(1.06)`, opacity: 1, offset: 0.2 },
            { transform: `translate(${dx}px, ${dy}px) scale(${to ? 0.35 : 0.8})`, opacity: 0 },
          ],
          { duration: dur(MS.leave, scale), easing: EASE },
        );
      }
    }

    // Life: the total ticks (Tick), the number pops, and a floating "−3" rises from it.
    const changes = fresh ? lifeChanges(prevLife.current, view) : [];
    if (L && scale > 0) {
      for (const { seat, delta } of changes) {
        const target = r.querySelector<HTMLElement>(`[data-life-seat="${seat}"]`);
        if (!target) continue;
        const t = target.getBoundingClientRect();
        target.animate([{ transform: "scale(1)" }, { transform: "scale(1.22)" }, { transform: "scale(1)" }], { duration: dur(MS.lifeTick, scale), easing: EASE });
        spawn(
          L,
          (f) => {
            f.className = `motion-float ${delta < 0 ? "minus" : "plus"}`;
            f.textContent = deltaText(delta);
            f.style.left = `${t.left + t.width / 2}px`;
            f.style.top = `${t.top}px`;
          },
          [
            { transform: "translate(-50%, 0)", opacity: 0 },
            { transform: "translate(-50%, -12px)", opacity: 1, offset: 0.15 },
            { transform: "translate(-50%, -60px)", opacity: 0 },
          ],
          { duration: Math.max(400, dur(MS.lifeFloat, scale)), easing: "ease-out" },
        );
        if (seat === bottom && delta <= -5) {
          spawn(L, (e) => (e.className = "motion-hit"), [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 300, easing: "ease-out" });
        }
      }
    }

    // The stack: a resolved item slides out to the right (new items slide in by CSS).
    const stack = view.stack;
    if (fresh && L && scale > 0) {
      const { left } = stackMoved;
      // The list shows the top first, so the items that left are the first `left` of last time.
      for (const { rect, node } of prevStackEls.current.slice(0, left)) {
        spawn(
          L,
          (g) => {
            g.className = "motion-stack-out";
            g.style.left = `${rect.left}px`;
            g.style.top = `${rect.top}px`;
            g.style.width = `${rect.width}px`;
            // Inside a stack list so it keeps its look; its own slide-in doesn't run again.
            const list = document.createElement("ol");
            list.className = "stack-list";
            node.style.animation = "none";
            list.appendChild(node);
            g.appendChild(list);
          },
          [
            { transform: "translateX(0)", opacity: 1 },
            { transform: "translateX(28px)", opacity: 0 },
          ],
          { duration: dur(MS.stack, scale), easing: "ease-in" },
        );
      }
      // An opponent's spell shows large for a moment before it settles on the stack (PP-48).
      const { added } = stackMoved;
      const table = r.querySelector<HTMLElement>(".pb-table, .pb-mine");
      for (const item of added) {
        if (scale < 1 || item.controller === you || you === null || !table) continue;
        const img = meta[item.name]?.image;
        if (!img) continue;
        const tr = table.getBoundingClientRect();
        spawn(
          L,
          (s) => {
            s.className = "motion-spotlight";
            s.style.left = `${tr.left + tr.width / 2}px`;
            s.style.top = `${tr.top + tr.height * 0.42}px`;
            const i = document.createElement("img");
            i.src = img;
            i.alt = "";
            s.appendChild(i);
          },
          [
            { transform: "translate(-50%, -50%) scale(0.85)", opacity: 0 },
            { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0.18 },
            { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0.75 },
            { transform: "translate(-50%, -50%) scale(0.9)", opacity: 0 },
          ],
          { duration: MS.spotlight, easing: "ease-out" },
        );
        break;
      }
    }

    // A turn begins: a short banner for yours (watching: every seat's, at normal speed).
    const turnSeat = you ?? view.active;
    if (fresh && L && scale >= (you === null ? 1 : 0.5) && turnBegan(prevTurn.current, view, turnSeat) && !view.over) {
      const text = turnText(view.active);
      const table = r.querySelector<HTMLElement>(".pb-table, .pb-mine");
      if (text && table) {
        const tr = table.getBoundingClientRect();
        spawn(
          L,
          (b) => {
            b.className = "motion-banner";
            b.textContent = text;
            b.style.left = `${tr.left + tr.width / 2}px`;
            b.style.top = `${tr.top + tr.height * 0.45}px`;
          },
          [
            { transform: "translate(-50%, -50%) scale(0.92)", opacity: 0 },
            { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0.2 },
            { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0.7 },
            { transform: "translate(-50%, -50%) scale(1.03)", opacity: 0 },
          ],
          { duration: dur(MS.banner, Math.max(scale, 0.6)), easing: "ease-out" },
        );
      }
    }

    // The game ends: the winner's moment, even at watch speeds (not with reduced motion).
    if (prevOver.current === false && view.over && L && !reducedMotion()) {
      const table = r.querySelector<HTMLElement>(".pb-table, .pb-mine");
      const tr = (table ?? r).getBoundingClientRect();
      const art = endArt(view);
      spawn(
        L,
        (e) => {
          e.className = "motion-end";
          e.style.left = `${tr.left + tr.width / 2}px`;
          e.style.top = `${tr.top + tr.height * 0.42}px`;
          if (art) {
            const i = document.createElement("img");
            i.src = art;
            i.alt = "";
            e.appendChild(i);
          }
          const t = document.createElement("span");
          t.textContent = endText(view);
          e.appendChild(t);
        },
        [
          { transform: "translate(-50%, -50%) scale(0.8)", opacity: 0 },
          { transform: "translate(-50%, -50%) scale(1.04)", opacity: 1, offset: 0.12 },
          { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0.2 },
          { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0.85 },
          { transform: "translate(-50%, -50%) scale(1)", opacity: 0 },
        ],
        { duration: MS.end, easing: "ease-out" },
      );
    }

    // Remember this board for next time.
    prevCards.current = now.seen;
    if (fresh || lastRevision.current === null) {
      prevLife.current = lifeOf(view);
      prevStack.current = stack.map((s) => ({ name: s.name, controller: s.controller }));
      prevTurn.current = { turn: view.turn, active: view.active };
      prevOver.current = view.over;
      lastRevision.current = view.revision;
    }
    prevStackEls.current = [...r.querySelectorAll<HTMLElement>(".rail-stack .stack-list > li, .sheet .stack-list > li")].map((li) => ({
      rect: li.getBoundingClientRect(),
      node: li.cloneNode(true) as HTMLElement,
    }));
  });
}
