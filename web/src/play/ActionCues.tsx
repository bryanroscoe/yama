import { useEffect, useRef, useState } from "react";
import type { CardMeta, Happening } from "./types";
import { lineText, type Names } from "./feed";

/** Use action-time filtered events, so even a cast and resolution in one AI batch is visible. */
export function actionCues(events: Happening[], after: number): Happening[] {
  return events.filter((e) => e.seq > after && (e.kind === "cast" || e.kind === "activated" || e.kind === "land" || (e.kind === "moved" && e.from === "stack")));
}
export function ActionCues({ events, names, meta, scale }: { events?: Happening[]; names: Names; meta: Record<string, CardMeta>; scale: number }) {
  const seen = useRef<number | null>(null);
  const [queue, setQueue] = useState<Happening[]>([]);
  const cue = queue[0];
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  useEffect(() => {
    if (!events) return;
    const latest = Math.max(-1, ...events.map((e) => e.seq));
    if (seen.current !== null && scale > 0 && !document.hidden) {
      const fresh = actionCues(events, seen.current);
      if (fresh.length) setQueue((q) => [...q, ...fresh].slice(-6));
    }
    seen.current = Math.max(seen.current ?? -1, latest);
  }, [events, scale]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) setQueue([]); };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);
  useEffect(() => {
    if (scale === 0) { setQueue([]); return; }
    if (!cue) return;
    const t = window.setTimeout(() => setQueue((q) => q.slice(1)), Math.max(350, 850 * scale));
    return () => window.clearTimeout(t);
  }, [cue, scale]);
  if (!cue || scale === 0 || !("card" in cue)) return null;
  const name = cue.card.name;
  const image = name ? meta[name]?.image : null;
  return <div className={`action-cue${reduced ? " reduced" : ""}`} key={cue.seq} role="status" style={{ animationDuration: `${350 * scale}ms` }}>
    {image && <img src={image} alt={name ?? "Card"} />}
    <span>{lineText(cue, names)}</span>
  </div>;
}
