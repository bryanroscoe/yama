// A callout when another player's spell, ability or creature does something to you or your cards
// (Bryan, 17 Nov 2026, after "Kinsbaile Cavalier was destroyed by Vindicate" went by unseen: "the
// game should definitely pause a little bit slower and let me know that this happened"). The
// server rests on it too (beat_ms); this says what happened with the card that did it, stays long
// enough to read at the chosen speed, and goes away by itself or when dismissed. It never blocks
// the game: the live board and your choices stay current underneath.

import { useEffect, useRef, useState } from "react";
import { ActionBar, Button } from "../components/ui";
import { lineText, type Names } from "./feed";
import { hitCueMs } from "./motion";
import { happeningCards, hitsOnYou } from "./review";
import type { CardMeta, Happening } from "./types";

export function HitCues({ events, names, meta, scale, mine, onRead, onReview }: {
  events?: Happening[];
  names: Names;
  meta: Record<string, CardMeta>;
  /** The play speed's scale (motion.ts): Slow keeps the callout longest. */
  scale: number;
  /** Whether a card on the battlefield is yours (damage to your creatures). */
  mine: (id: number) => boolean;
  onRead: (name: string, id?: number) => void;
  /** Open the timeline at this happening. */
  onReview: (seq: number) => void;
}) {
  const seen = useRef<number | null>(null);
  const [queue, setQueue] = useState<Happening[][]>([]);
  const [held, setHeld] = useState(false);
  const cue = queue[0];
  useEffect(() => {
    if (!events) return;
    const latest = Math.max(-1, ...events.map((e) => e.seq));
    // Only what happens from now on: not the history a reconnect or a first board carries.
    if (seen.current !== null && !document.hidden) {
      const fresh = hitsOnYou(events, seen.current, names.you, mine);
      if (fresh.length) setQueue((q) => [...q, fresh.slice(0, 4)].slice(-3));
    }
    seen.current = Math.max(seen.current ?? -1, latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);
  useEffect(() => {
    if (!cue || held) return;
    const t = window.setTimeout(() => setQueue((q) => q.slice(1)), hitCueMs(scale));
    return () => window.clearTimeout(t);
  }, [cue, held, scale]);
  if (!cue) return null;
  const dismiss = () => (setQueue((q) => q.slice(1)), setHeld(false));
  const doers = [...new Set(cue.map(doerOf))];
  const doer = doers.length === 1 ? doers[0]! : null;
  const cards = cue.flatMap(happeningCards).filter((c, i, all) => all.findIndex((o) => o.name === c.name) === i).slice(0, 2);
  return (
    <aside
      className="hit-cue"
      role="status"
      aria-live="polite"
      key={cue[0]!.seq}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      {cards.length > 0 && (
        <div className="hit-cue-cards">
          {cards.map((c) => {
            const image = c.name ? meta[c.name]?.image : null;
            return image ? (
              <Button key={`${c.name}-${c.id ?? ""}`} className="hit-cue-card" onClick={() => onRead(c.name!, c.id)} aria-label={`Read ${c.name}`}>
                <img src={image} alt={c.name} />
              </Button>
            ) : null;
          })}
        </div>
      )}
      <div className="hit-cue-text">
        <b>{doer === null ? "Done to you" : `${names.Who(doer)} did this`}</b>
        {cue.map((h) => <span key={h.seq}>{lineText(h, names)}</span>)}
        <ActionBar as="span" className="hit-cue-buttons">
          <Button variant="outline" size="small" onClick={() => (onReview(cue[0]!.seq), dismiss())}>Step through what happened</Button>
          <Button variant="quiet" size="small" onClick={dismiss}>Dismiss</Button>
        </ActionBar>
      </div>
    </aside>
  );
}

/** Who did it to you: the seat whose card did it, else whose turn it was. */
export function doerOf(h: Happening): number {
  switch (h.kind) {
    case "moved":
      return h.by_seat ?? h.active;
    case "control":
      return h.to;
    case "damage":
      return h.by ?? h.active;
    default:
      return h.active;
  }
}
