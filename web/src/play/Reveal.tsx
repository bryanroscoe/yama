// Cards revealed to everyone, or shown to you alone (design/screens/GZones' "Revealed" panel; the
// review's build plan section 10). The server puts a reveal only in the feeds of the seats allowed
// to see it (play/src/feed.rs): a public reveal for everyone, a private look ("look at target
// player's hand") for the player looking. It stays up until dismissed (PP-52) and is kept in the log.

import { cardName, list, type Names, type Shown } from "./feed";
import type { CardMeta } from "./types";
import { Button } from "../components/ui";

export function RevealPanel({ group, more, names, meta, tone, onRead, onClose, wide }: {
  /** One reveal, or a run of them by the same player. */
  group: Shown[];
  /** How many more are waiting after this one. */
  more: number;
  names: Names;
  meta: Record<string, CardMeta>;
  tone: (seat: number) => string | undefined;
  onRead: (name: string) => void;
  onClose: () => void;
  wide: boolean;
}) {
  const h = group[0]!;
  const cards = group.flatMap((g) => g.cards);
  const who = h.seat === names.you ? "You" : names.Who(h.seat);
  const title = h.kind === "revealed" ? `${who} revealed` : h.whose !== undefined && h.whose !== h.seat ? `${who} looked at ${h.whose === names.you ? "your" : `${names.Who(h.whose)}'s`} cards` : `${who} looked at`;
  const style = tone(h.seat) ? ({ ["--seat" as string]: `var(--${tone(h.seat)})` } as React.CSSProperties) : undefined;
  return (
    <aside className={`reveal${wide ? " wide" : ""}`} aria-label={title} role="status" style={style}>
      <span className="reveal-head">
        <span className="seat-dot" aria-hidden="true" />
        <b>{title}</b>
        <Button className="gi-close" aria-label="Dismiss" onClick={onClose}>×</Button>
      </span>
      <div className={`reveal-cards${cards.length > 1 ? " many" : ""}`}>
        {cards.map((c, i) => {
          const img = c.name ? meta[c.name]?.image : null;
          return (
            // Keyed by name too, so a new card never shows the last one's image while it loads.
            <Button key={`${i}:${c.name ?? ""}`} className="zone-card" onClick={() => c.name && onRead(c.name)} onContextMenu={(e) => (e.preventDefault(), c.name && onRead(c.name))} aria-label={cardName(c)}>
              {img ? <img src={img} alt="" /> : <span className="hc-name">{cardName(c)}</span>}
            </Button>
          );
        })}
      </div>
      <span className="dim small">{list(cards.map(cardName))}</span>
      <span className="reveal-tags">
        <span className="reveal-tag">{h.kind === "revealed" ? "Seen by everyone" : "Only you see these"}</span>
        <span className="reveal-tag">In the game log</span>
      </span>
      {more > 0 && <Button variant="outline" size="small" onClick={onClose}>Next ({more} more)</Button>}
    </aside>
  );
}
