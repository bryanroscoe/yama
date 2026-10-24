// Graveyards, exile and the command zone (design/screens/GZones; the review's build plan section
// 10). Any player's public zones open from their graveyard or exile count, whoever is deciding.
// A tab per zone with its count; a library only ever shows its count. Each card says how it got
// there when this board saw it happen (play/src/feed.rs). Face-down exiled cards show only to
// whoever may look at them: the server names them for that seat alone.

import { useEffect, useMemo, useState } from "react";
import { Sheet } from "../components/ui";
import { cameText, type Names } from "./feed";
import type { CardMeta, CardView, View } from "./types";

export type BrowsedZone = "graveyard" | "exile" | "command";

const TYPE_FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "creature", label: "Creatures", test: (c: CardView) => c.types.includes("Creature") },
  { id: "spell", label: "Instants and sorceries", test: (c: CardView) => c.types.includes("Instant") || c.types.includes("Sorcery") },
  { id: "other", label: "Other", test: (c: CardView) => !c.types.some((t) => t === "Creature" || t === "Instant" || t === "Sorcery") },
] as const;

/** A seat's cards in one zone, newest first (the engine keeps zones oldest first). */
export function zoneCards(view: View, seat: number, zone: BrowsedZone): CardView[] {
  const cards =
    zone === "graveyard"
      ? view.players.find((p) => p.seat === seat)?.graveyard ?? []
      : zone === "exile"
        ? view.exile.filter((c) => c.owner === seat)
        : view.command_zone.filter((c) => c.owner === seat);
  return [...cards].reverse();
}

export function ZoneBrowser(props: {
  view: View;
  seat: number;
  zone: BrowsedZone;
  names: Names;
  meta: Record<string, CardMeta>;
  art: (seat: number) => { art: string | null; artist: string | null };
  tone: (seat: number) => string | undefined;
  wide: boolean;
  canHover: boolean;
  onPick: (seat: number, zone: BrowsedZone) => void;
  onRead: (c: CardView) => void;
  onHover: (c: CardView | null, el?: Element) => void;
  onClose: () => void;
  /** A card is being read over it: Esc closes that first. */
  paused?: boolean;
}) {
  const { view, seat, zone, names, meta, wide, onClose, paused } = props;
  const [type, setType] = useState<(typeof TYPE_FILTERS)[number]["id"]>("all");
  const [q, setQ] = useState("");
  useEffect(() => setType("all"), [seat, zone]);
  useEffect(() => {
    if (!wide || paused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, onClose, paused]);
  const all = zoneCards(view, seat, zone);
  const filter = TYPE_FILTERS.find((t) => t.id === type)!;
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter((c) => filter.test(c) && (!s || c.name.toLowerCase().includes(s) || (meta[c.name]?.type_line ?? "").toLowerCase().includes(s)));
  }, [all, filter, q, meta]);
  const player = view.players.find((p) => p.seat === seat);
  const whose = seat === names.you ? "Your" : `${names.Who(seat)}'s`;
  const count = (z: BrowsedZone) => zoneCards(view, seat, z).length;
  const tabs: { id: BrowsedZone; label: string }[] = [
    { id: "graveyard", label: `Graveyard ${count("graveyard")}` },
    { id: "exile", label: `Exile ${count("exile")}` },
    { id: "command", label: `Command zone ${count("command")}` },
  ];
  const foot =
    zone === "graveyard"
      ? "Newest first. A library is never shown, only its count."
      : zone === "exile"
        ? "Newest first. Face-down cards show only to whoever may look at them."
        : "Commanders and emblems.";
  const a = props.art(seat);
  const body = (
    <div className="gz">
      <div className="gz-head">
        {a.art ? <img className="gz-art" src={a.art} alt="" style={{ ["--seat" as string]: props.tone(seat) ? `var(--${props.tone(seat)})` : undefined } as React.CSSProperties} /> : <span className="gz-art blank" />}
        <h2>{whose} cards</h2>
        <button type="button" className="gi-close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      {/* Whose cards: every player's public zones can be read, at any time. */}
      <div className="gz-seats" role="group" aria-label="Player">
        {view.players.map((p) => (
          <button
            key={p.seat}
            type="button"
            className={`gz-seat${p.seat === seat ? " on" : ""}`}
            aria-pressed={p.seat === seat}
            style={props.tone(p.seat) ? ({ ["--seat" as string]: `var(--${props.tone(p.seat)})` } as React.CSSProperties) : undefined}
            onClick={() => props.onPick(p.seat, zone)}
          >
            <span className="seat-dot" aria-hidden="true" />
            {p.seat === names.you ? "You" : names.Who(p.seat)}
          </button>
        ))}
      </div>
      <div role="tablist" aria-label="Zone" className="gi-tabs">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={zone === t.id} className={zone === t.id ? "on" : undefined} onClick={() => props.onPick(seat, t.id)}>
            {t.label}
          </button>
        ))}
        <button type="button" role="tab" aria-selected={false} aria-disabled="true" disabled className="gz-hidden">
          Library {player?.library ?? 0}, hidden
        </button>
      </div>
      <div className="gz-types" role="group" aria-label="Card types">
        {TYPE_FILTERS.map((t) => (
          <button key={t.id} type="button" className={`gz-type${type === t.id ? " on" : ""}`} aria-pressed={type === t.id} onClick={() => setType(t.id)}>
            {t.label} {all.filter(t.test).length}
          </button>
        ))}
        {all.length > 12 && <input type="search" placeholder="Filter by name or type" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter by name or type" />}
      </div>
      <div className="gz-grid">
        {shown.map((c) => (
          <figure key={c.id} className="gz-card">
            <button
              type="button"
              className="zone-card"
              aria-label={`${c.name}${c.came ? `, ${cameText(c.came)}` : ""}`}
              onClick={() => props.onRead(c)}
              onContextMenu={(e) => (e.preventDefault(), props.onRead(c))}
              onMouseEnter={(e) => props.canHover && props.onHover(c, e.currentTarget)}
              onMouseLeave={() => props.onHover(null)}
            >
              {meta[c.name]?.image ? <img src={meta[c.name]!.image!} alt="" loading="lazy" /> : <span className="hc-name">{c.name}</span>}
              {c.face_down && <span className="gz-down">Face down</span>}
            </button>
            {c.came && <figcaption>{cameText(c.came)}</figcaption>}
          </figure>
        ))}
        {!shown.length && <p className="dim gz-empty">{all.length ? "Nothing here matches." : "Empty."}</p>}
      </div>
      <p className="small dim gz-foot">
        {foot} {props.canHover ? "Hover a card for a large copy; right-click to read it." : "Tap a card to read it."}
        {a.art && a.artist ? ` Art at the top: ${a.artist}, © Wizards of the Coast.` : ""}
      </p>
    </div>
  );
  if (!wide) return <Sheet label={`${whose} cards`} onClose={onClose}>{body}</Sheet>;
  return (
    <div className="gi-overlay" onClick={onClose}>
      <section className="gz-dialog" role="dialog" aria-modal="true" aria-label={`${whose} cards`} onClick={(e) => e.stopPropagation()}>
        {body}
      </section>
    </div>
  );
}
