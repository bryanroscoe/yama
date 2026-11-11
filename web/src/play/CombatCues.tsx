import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { combatCues, enqueueCombatCues, type CombatCue } from "./combatPresentation";
import { arcPath, centre } from "./drag";
import { seatHeadOf, tileOf } from "./DragLayer";
import { lineText, type Names } from "./feed";
import type { Happening, Hit, Seen, Speed } from "./types";

/** A presentation queue only: legal actions and the live board always stay current. */
export function CombatCues({ events, names, root, speed, scale = 1 }: { events?: Happening[]; names: Names; root: RefObject<HTMLElement | null>; speed?: Speed; scale?: number }) {
  const seen = useRef<number | null>(null);
  const [queue, setQueue] = useState<CombatCue[]>([]);
  const cue = queue[0];
  const [paths, setPaths] = useState<string[]>([]);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (!events) return;
    const latest = Math.max(-1, ...events.map((e) => e.seq));
    if (seen.current !== null) {
      const fresh = combatCues(events, seen.current);
      if (fresh.length && !document.hidden && speed !== "end" && scale > 0) setQueue((q) => enqueueCombatCues(q, fresh));
    }
    seen.current = Math.max(seen.current ?? -1, latest);
  }, [events, speed, scale]);
  useEffect(() => {
    if (speed === "end" || scale === 0) { setQueue([]); return; }
    if (!cue) return;
    const timer = window.setTimeout(() => setQueue((q) => q.slice(1)), (speed === "4x" ? 350 : speed === "2x" ? 700 : 1400) * scale);
    return () => window.clearTimeout(timer);
  }, [cue, speed, scale]);
  useEffect(() => {
    const hide = () => { if (document.hidden) setQueue([]); };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);
  useLayoutEffect(() => {
    const r = root.current;
    if (!cue || !r) { setPaths([]); return; }
    const measure = () => {
      const card = (c: Seen) => c.id === undefined ? null : tileOf(r, c.id);
      const target = (t: Hit) => t.kind === "player" ? seatHeadOf(r, t.seat) : card(t.card);
      const lines: string[] = [];
      const add = (from: Element | null, to: Element | null) => {
        if (!from || !to) return;
        const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
        if (a.width && b.width) lines.push(arcPath(centre(a), centre(b)));
      };
      for (const e of cue.events) {
        if (e.kind === "attack") for (const a of e.attacks) add(card(a.card) ?? seatHeadOf(r, e.seat), target(a.at));
        if (e.kind === "block") for (const [b, a] of e.blocks) add(card(b), card(a));
        if (e.kind === "damage") add(card(e.source) ?? (e.by === undefined ? null : seatHeadOf(r, e.by)), target(e.to));
      }
      setPaths([...new Set(lines)]);
    };
    measure();
    window.addEventListener("resize", measure);
    r.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); r.removeEventListener("scroll", measure, true); };
  }, [cue, root]);
  if (!cue) return null;
  const atYou = cue.kind === "attack" && cue.events.some((e) => e.kind === "attack" && e.attacks.some((a) => a.at.kind === "player" && a.at.seat === names.you));
  return (
    <div className={`combat-cue ${cue.kind}${reduced ? " reduced" : ""}`}>
      <svg className="combat-cue-arrows" aria-hidden="true">
        <defs><marker id="combat-cue-head" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="currentColor" /></marker></defs>
        {paths.map((d, i) => <g key={`${cue.events[0]!.seq}-${i}`}>
          <path d={d} pathLength="1" className="combat-cue-path" markerEnd="url(#combat-cue-head)" />
          {cue.kind === "damage" && !reduced && <circle r="7" fill="currentColor"><animateMotion dur="0.65s" path={d} fill="freeze" /></circle>}
        </g>)}
      </svg>
      <div className="combat-cue-notice" role="status" aria-live="polite" key={cue.events[0]!.seq}>
        <b>{atYou ? "You are under attack" : cue.kind === "attack" ? "Attack declared" : cue.kind === "block" ? "Blockers declared" : cue.kind === "summary" ? "Combat update" : "Damage dealt"}</b>
        {cue.events.slice(0, 3).map((e) => <span key={e.seq}>{lineText(e, names)}</span>)}
        {cue.events.length + (cue.omitted ?? 0) > 3 && <span>{Math.max(0, cue.events.length - 3) + (cue.omitted ?? 0)} more events. See Game log for every hit.</span>}
      </div>
    </div>
  );
}
