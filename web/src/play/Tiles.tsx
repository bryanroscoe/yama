// Cards on the online board: square art tiles on the battlefield, whole cards in the hand.
// Highlights are rings and badges around or on top of the image; the image itself is never
// filtered or faded. A tapped tile turns its art, never its name or numbers.

import { useRef, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { MANA } from "@yama/core";
import { shortName } from "./text";
import type { CardMeta, CardView } from "./types";
import type { Pile } from "./model";

export interface TileHandlers {
  /** Click (or tap): select, toggle an attacker, assign a blocker. */
  onPick: (p: Pile) => void;
  /** Double-click: play the card when it has exactly one option. */
  onDouble?: (p: Pile) => void;
  /** Long-press, right-click or the inspector button: the card with its rules text. */
  onRead: (c: CardView) => void;
  /** Hover with a mouse: the full-size preview, placed beside `el`. */
  onHover: (c: CardView | null, el?: Element) => void;
  /** A press that may become a drag (Board decides whether this card can be dragged now). */
  onPress?: (p: Pile, where: "hand" | "field", e: PointerEvent<HTMLElement>) => void;
}

/** Long-press opens the inspector (PP-69); the click that ends a long-press does nothing else. */
function usePress(card: CardView, h: TileHandlers) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        h.onRead(card);
      }, 400);
    },
    // A finger that moves is dragging the card, not holding it to read it.
    onPointerMove: (e: PointerEvent) => {
      if (timer.current !== null && start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      clear();
      fired.current = true;
      h.onRead(card);
    },
    consumed: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}

function Stat({ card }: { card: CardView }) {
  if (card.loyalty !== null) return <span className="ft-pt loyalty num">{card.loyalty}</span>;
  if (card.power === null) return null;
  const hurt = card.damage > 0;
  return (
    <span className={`ft-pt num${hurt ? " hurt" : ""}`}>
      {card.power}/{hurt ? (card.toughness ?? 0) - card.damage : card.toughness}
    </span>
  );
}

const TapMark = () => (
  <svg className="tap-mark" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 2.5h3.5a3 3 0 0 1 0 6H4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M5.5 6.5 3.5 8.5l2 2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export interface TileLook {
  playable?: boolean;
  selected?: boolean;
  /** In the attack you're building, or attacking now. */
  attacking?: boolean;
  /** In the blocks you're building, or blocking now. */
  blocking?: boolean;
  /** A creature you could add to an attack or a block. */
  ready?: boolean;
  /** "Commander" etc. on a dark chip at the bottom left. */
  tag?: string;
  /** A legal target for the spell or ability being cast. */
  target?: boolean;
  /** You can pick it for the current choice (an amber ring). */
  pick?: boolean;
  /** Picked for the current choice: its place in the picks (a white ring and the number). */
  picked?: number;
}

/** Engine counter keys in words: "plus1plus1" is "+1/+1". */
export function counterName(key: string): string {
  const k = key.toLowerCase().replace(/_/g, " ");
  if (k === "plus1plus1" || k === "p1p1") return "+1/+1";
  if (k === "minus1minus1" || k === "m1m1") return "−1/−1";
  return k;
}

/**
 * A square battlefield tile (design/tokens.md, "Battlefield tiles"): the art crop, a name bar
 * along the top, P/T bottom-right, and badges. Its size comes from the row's --tile.
 */
export function FieldTile({ pile, meta, look, h, label: extraLabel }: { pile: Pile; meta?: CardMeta; look: TileLook; h: TileHandlers; label?: string }) {
  const c = pile.card;
  const press = usePress(c, h);
  const count = pile.ids.length;
  const counters = Object.entries(c.counters);
  const attacking = look.attacking || !!c.attacking;
  const blocking = look.blocking || !!c.blocking;
  const label = [
    count > 1 ? `${count} ${c.name}` : c.name,
    c.commander && "commander",
    c.tapped && "tapped",
    attacking && "attacking",
    blocking && "blocking",
    c.sick && "summoning sick",
    look.ready && !attacking && !blocking && "ready",
    look.playable && "has options",
    look.target && "can be targeted",
    look.pick && "can be chosen",
    look.picked && `chosen ${look.picked}`,
    extraLabel,
  ]
    .filter(Boolean)
    .join(", ");
  const cls = [
    "ft",
    c.tapped && "tapped",
    look.playable && "playable",
    look.ready && "ready",
    look.selected && "selected",
    look.target && "target",
    look.pick && "pick",
    look.picked && "picked",
    attacking && "attacking",
    blocking && "blocking",
    c.commander && "commander",
    !meta?.art && "no-art",
  ]
    .filter(Boolean)
    .join(" ");
  const badge = attacking ? "Attacking" : blocking ? "Blocking" : look.tag ?? (c.sick && c.power !== null ? "Sick" : null);
  return (
    <button
      type="button"
      className={cls}
      data-id={c.id}
      data-ids={pile.ids.join(" ")}
      aria-label={label}
      aria-pressed={look.selected || attacking || blocking ? true : undefined}
      onClick={() => !press.consumed() && h.onPick(pile)}
      onDoubleClick={() => h.onDouble?.(pile)}
      onMouseEnter={(e) => h.onHover(c, e.currentTarget)}
      onMouseLeave={() => h.onHover(null)}
      onPointerDown={(e) => {
        press.onPointerDown(e);
        h.onPress?.(pile, "field", e);
      }}
      onPointerMove={press.onPointerMove}
      onPointerUp={press.onPointerUp}
      onPointerLeave={press.onPointerLeave}
      onPointerCancel={press.onPointerCancel}
      onContextMenu={press.onContextMenu}
    >
      <span className="ft-art" aria-hidden="true">
        {meta?.art && <img src={meta.art} alt="" loading="lazy" draggable={false} />}
      </span>
      <span className="ft-bar">
        <span className="ft-name">{shortName(c.name)}</span>
        {c.tapped && <TapMark />}
      </span>
      {counters.length > 0 && (
        <span className="ft-counters">{counters.map(([k, v]) => `${counterName(k)} ×${v}`).join(", ")}</span>
      )}
      <Stat card={c} />
      {badge && <span className={`ft-badge${attacking ? " bad" : blocking ? " block" : badge === "Sick" ? " sick" : ""}`}>{badge}</span>}
      {count > 1 && <span className="ft-count num">×{count}</span>}
      {look.playable && !look.target && <span className="dot" aria-hidden="true" />}
      {look.picked && <span className="pick-badge num" aria-hidden="true">{look.picked}</span>}
      {look.target && (
        <svg className="aim" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8 1v4M8 11v4M1 8h4M11 8h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

/** A whole card in your hand (or the command zone), readable where it is. */
export function HandCard({ card, meta, look, h, style, caption }: {
  card: CardView;
  meta?: CardMeta;
  look: TileLook;
  h: TileHandlers;
  style?: React.CSSProperties;
  caption?: ReactNode;
}) {
  const press = usePress(card, h);
  const pile: Pile = { key: String(card.id), card, ids: [card.id] };
  const label = [card.name, look.tag, look.playable && "can play", look.pick && "can be chosen", look.picked && `chosen ${look.picked}`, caption && typeof caption === "string" ? caption : null]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      className={`hc${look.playable ? " playable" : ""}${look.selected ? " selected" : ""}${look.pick ? " pick" : ""}${look.picked ? " picked" : ""}`}
      style={style}
      data-id={card.id}
      aria-label={label}
      aria-pressed={look.selected ? true : undefined}
      onClick={() => !press.consumed() && h.onPick(pile)}
      onDoubleClick={() => h.onDouble?.(pile)}
      onMouseEnter={(e) => h.onHover(card, e.currentTarget)}
      onMouseLeave={() => h.onHover(null)}
      onPointerDown={(e) => {
        press.onPointerDown(e);
        h.onPress?.(pile, "hand", e);
      }}
      onPointerMove={press.onPointerMove}
      onPointerUp={press.onPointerUp}
      onPointerLeave={press.onPointerLeave}
      onPointerCancel={press.onPointerCancel}
      onContextMenu={press.onContextMenu}
    >
      {meta?.image ? <img src={meta.image} alt="" loading="lazy" draggable={false} /> : <span className="hc-name">{card.name}</span>}
      {caption && <span className="hc-caption">{caption}</span>}
      {look.picked && <span className="pick-badge num" aria-hidden="true">{look.picked}</span>}
    </button>
  );
}

/** Mana dots for a land summary: one dot per color group (a dual shows two halves). */
export function ManaDot({ colors }: { colors: string }) {
  if (colors === "*") return <span className="mdot any" aria-hidden="true" />;
  const keys = colors.split("").filter((k): k is keyof typeof MANA => k in MANA);
  if (keys.length <= 1) {
    const k = keys[0] ?? "C";
    return <span className={`mdot${k === "B" ? " dark" : ""}`} style={{ background: MANA[k].fill }} aria-hidden="true" />;
  }
  const stops = keys.map((k, i) => `${MANA[k].fill} ${(i / keys.length) * 100}% ${((i + 1) / keys.length) * 100}%`).join(", ");
  return <span className="mdot" style={{ background: `conic-gradient(${stops})` }} aria-hidden="true" />;
}

export const COLOR_NAME: Record<string, string> = { W: "white", U: "blue", B: "black", R: "red", G: "green", C: "colorless", "*": "any color" };
