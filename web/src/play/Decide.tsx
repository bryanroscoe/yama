// The generic decision widgets (design/README.md, "Generic decision widgets"; the boards GYesNo,
// GPickN, GOrder, GSplit, GNumber, GName and GPairUp, and batch 1's GScry, GSearch, GTriggers,
// GModes, GDamage and GChoices), driven by a decision's `pending` (play/src/act.rs). The logic is
// in answer.ts; Board.tsx places these and sends the answer.
//
// The rules every widget keeps: the main button in the rail (laptop) or dock (phone) confirms, so
// nothing here has a confirm of its own; Esc puts the draft back (Board); right-click or a
// long-press reads a card; every art crop names its artist; and the words are the engine's and the
// card's own, never invented.

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MANA } from "@yama/core";
import { api } from "../api";
import { ManaCost } from "../components/ui";
import { useCardArt } from "../components/useCardArt";
import {
  adjust,
  canMoveOrder,
  canRememberOrder,
  castable,
  counter,
  isCastOffer,
  isFaceChoice,
  isPermanentPick,
  isPlaces,
  isScry,
  isSeatPick,
  isTapping,
  isTargeting,
  isTopOrBottom,
  isWordPick,
  keepOnTop,
  keypad,
  left,
  lethalOf,
  move,
  moveTo,
  nameMatches,
  orderTag,
  phyrexianLife,
  piles,
  phyrexianMana,
  pickTag,
  rememberLabels,
  restHere,
  room,
  setNumber,
  splitTag,
  stepNumber,
  togglePick,
  typeDigit,
  type Draft,
  type Remember,
  type Stage,
  type TimeMove,
} from "./answer";
import { seatHeadOf, tileOf } from "./DragLayer";
import { reachable, roomSpot, shortcutCount, stepStop, timeAfter, timeChoices, timeCounters } from "./rare";
import type { CardMeta, DecisionOption, Pending, TogetherView } from "./types";

/** What the widgets need from the board around them. */
export interface WidgetContext {
  meta: Record<string, CardMeta>;
  /** "Your" or "Sam's", for a seat. */
  whose: (seat: number) => string;
  /** "you" or "Sam", for a seat. */
  who: (seat: number) => string;
  /** A seat's colour token ("seat-2"), for its dot. */
  tone: (seat: number) => string | undefined;
  /** Read a card at full size (right-click or long-press). */
  onRead: (name: string, id?: number) => void;
  /** The zone the options come from, in words, and what else is in it (GPickN's filter line). */
  zone: { label: string; total: number | null; others: string[] };
  /** Damage already on a permanent, for the lethal hint. */
  damageOf: (id: number) => number;
  /** Cards on the battlefield, for a name widget's "in play first". */
  inPlay: { name: string; seat: number }[];
  /** Your life now, for Phyrexian mana's "Life: 38 → 36". */
  life?: number;
  /** The table-wide decision in progress, as you may see it: the votes cast, the piles (GTogether). */
  together?: TogetherView;
  /** A seat's commander art and its artist, and its life, for the seat picker (GRareRules). */
  seat?: (n: number) => { art: string | null; artist: string | null; life: number | null };
  /** How many cards a seat's library holds, for top or bottom. */
  library?: (n: number) => number | undefined;
  /** Everyone else at the table, by seat: "What Sam and Jules see" (GRareCards). */
  others?: number[];
}

interface Props {
  p: Pending;
  draft: Draft;
  onDraft: (d: Draft) => void;
  ctx: WidgetContext;
  /** A phone: the dock's sheet. */
  compact: boolean;
  disabled: boolean;
}

const COPYRIGHT = "© Wizards of the Coast";
const IMAGES = "Card images from Scryfall, © Wizards of the Coast.";

/** What not paying means, in red with a mark (ward's "your spell is countered"). */
export function Warn({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <span className="dw-warn" role="note">
      <span aria-hidden="true">!</span>
      {text}
    </span>
  );
}

/** "Your Reveillark", "Sam's Smothering Tithe". */
function sourceLine(p: Pending, ctx: WidgetContext): string {
  if (!p.source) return "";
  return `${ctx.whose(p.source.controller)} ${p.source.name}`;
}

const seatDot = (tone: string | undefined): CSSProperties | undefined => (tone ? ({ ["--seat" as string]: `var(--${tone})` } as CSSProperties) : undefined);

/** Right-click, or a long press on a touch screen, reads the card; the click a long press ends with does nothing else. */
function useRead(read: () => void) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      if (e.pointerType === "mouse") return;
      start.current = { x: e.clientX, y: e.clientY };
      clear();
      timer.current = window.setTimeout(() => {
        fired.current = true;
        read();
      }, 400);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (timer.current !== null && start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      clear();
      fired.current = true;
      read();
    },
  };
  /** True once, right after a long press or right-click read the card. */
  const consumed = () => {
    const was = fired.current;
    fired.current = false;
    return was;
  };
  return { handlers, consumed };
}

/** A whole card you can pick: amber ring when you may, white ring and its number once picked. */
function CardPick({ o, img, at, onPick, onRead, disabled, label }: { o: DecisionOption; img: string | null; at: number; onPick: () => void; onRead: () => void; disabled: boolean; label?: string }) {
  const { handlers, consumed } = useRead(onRead);
  return (
    <button
      type="button"
      className={`dw-card${at >= 0 ? " picked" : o.eligible ? " pick" : ""}`}
      aria-pressed={at >= 0}
      aria-label={`${o.name}${at >= 0 ? `, chosen ${at + 1}` : ""}`}
      disabled={disabled}
      onClick={() => !consumed() && onPick()}
      {...handlers}
    >
      {img ? <img src={img} alt="" draggable={false} /> : <span className="dw-card-name">{o.name}</span>}
      {at >= 0 && <span className="pick-badge num">{label ?? at + 1}</span>}
    </button>
  );
}

/** The heading every dialog shares: the source's art and credit, the question, its Oracle text, the counter. */
function Head({ p, ctx, count, compact, image = false, extra }: { p: Pending; ctx: WidgetContext; count?: string; compact: boolean; image?: boolean; extra?: ReactNode }) {
  const s = p.source;
  const art = image ? s?.image : s?.art;
  const { handlers } = useRead(() => s && ctx.onRead(s.name, s.id));
  return (
    <div className={`dw-head${image ? " image" : ""}`}>
      {art ? <img className="dw-head-art" src={art} alt="" {...handlers} /> : s ? <span className="dw-head-art blank" /> : null}
      <span className="dw-head-text">
        {s && (
          <span className="dw-source-line">
            {sourceLine(p, ctx)}
            {s.artist && !image && !compact ? `. Art: ${s.artist}, ${COPYRIGHT}` : ""}
          </span>
        )}
        <h2>{p.prompt}</h2>
        {!compact && p.oracle && <span className="dw-oracle">{p.oracle}</span>}
        {!compact && <Warn text={p.warn} />}
      </span>
      {extra ?? (count ? <span className="dw-count" aria-live="polite">{count}</span> : null)}
      {compact && p.oracle && <span className="dw-oracle wide">{p.oracle}</span>}
      {compact && p.warn && (
        <span className="wide">
          <Warn text={p.warn} />
        </span>
      )}
      {/* A phone has no room beside the art, so its credit goes under the question. */}
      {compact && s?.artist && art && !image && <span className="dw-credit wide">Art: {s.artist}, {COPYRIGHT}</span>}
    </div>
  );
}

// ── yes or no (GYesNo) ─────────────────────────────────────────────────────

/** The strip over the live board for a "may"; the rail's buttons answer it. */
export function YesNoStrip({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  const s = p.source;
  const remember = draft.kind === "yesno" ? draft.remember : "ask";
  const labels = rememberLabels(p);
  const { handlers } = useRead(() => s && ctx.onRead(s.name, s.id));
  return (
    <section className={`dw-strip${compact ? " compact" : ""}`} role="alertdialog" aria-label={p.prompt}>
      {s?.art && (
        <span className="dw-strip-art">
          <img src={s.art} alt="" {...handlers} />
          {!compact && s.artist && <span className="dw-credit">Art: {s.artist}, {COPYRIGHT}</span>}
        </span>
      )}
      <span className="dw-strip-body">
        {s && (
          <span className="dw-source-line" style={seatDot(ctx.tone(s.controller))}>
            <span className="seat-dot" aria-hidden="true" />
            {sourceLine(p, ctx)}
          </span>
        )}
        <b className="dw-question">{p.prompt}</b>
        {p.oracle && <span className="dw-oracle">{p.oracle}</span>}
        <Warn text={p.warn} />
        {/* Where the engine can remember the answer, or Yama can (an unless-cost, the command zone). */}
        {p.remember && draft.kind === "yesno" && (
          <span className="dw-remember">
            <span className="dw-remember-label">{p.remember === "yama" ? "For the rest of this game" : "Remember for this card"}</span>
            <span className="dw-seg" role="radiogroup" aria-label="Remember this answer">
              {(["ask", "always", "never"] as Remember[]).map((r) => (
                <button key={r} type="button" role="radio" aria-checked={remember === r} className={remember === r ? "on" : ""} disabled={disabled} onClick={() => onDraft({ kind: "yesno", remember: r })}>
                  {compact && r === "ask" ? "Ask" : labels[r]}
                </button>
              ))}
            </span>
          </span>
        )}
        {p.remember === "engine" && (
          <span className="dw-note">{remember === "ask" ? "You'll be asked each time." : "The engine gives this answer for this card from now on, for the rest of the game."}</span>
        )}
        {p.remember === "yama" && (
          <span className="dw-note">{remember === "ask" ? "You'll be asked each time." : "Yama answers this for you for the rest of the game. Each answer shows in your log, where you can turn it off."}</span>
        )}
        {compact && s?.artist && <span className="dw-credit">Art: {s.artist}, {COPYRIGHT}</span>}
      </span>
    </section>
  );
}

// ── pick N in a zone (GPickN, GSearch, GChoices) ──────────────────────────

/** Cards to pick that aren't on the board (or, on a phone, any cards): a grid of whole cards. */
export function ZonePick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  const [q, setQ] = useState("");
  if (draft.kind !== "pick") return null;
  const eligible = p.options.filter((o) => o.eligible);
  // Cards shown but not choosable (a dig's cards that fail its filter), and the zone's other cards,
  // are named, never shown faded (design/screens/GPickN).
  const others = [...p.options.filter((o) => !o.eligible).map((o) => o.name), ...ctx.zone.others];
  const total = ctx.zone.total ?? p.options.length + ctx.zone.others.length;
  const s = q.trim().toLowerCase();
  const shown = s ? eligible.filter((o) => o.name.toLowerCase().includes(s) || (ctx.meta[o.name]?.oracle_text ?? "").toLowerCase().includes(s)) : eligible;
  const picked = (o: DecisionOption) => draft.ids.indexOf(o.id);
  // "in your graveyard", "in Sam's graveyard", "on the battlefield".
  const label = ctx.zone.label;
  const where = label.startsWith("Your ") ? `in your ${label.slice(5)}` : label === "The battlefield" ? "on the battlefield" : label === "These cards" ? "here" : `in ${label}`;
  return (
    <div className={`dw-zone${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-chips">
        <span className="dw-chip">{ctx.zone.label}</span>
        {p.filter && <span className="dw-chip">{p.filter}</span>}
        {total > eligible.length && <span className="dw-qualify">{eligible.length} of {total} cards qualify</span>}
      </div>
      {eligible.length > 12 && (
        <input type="search" className="dw-filter" placeholder="Filter by name or text" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the cards" />
      )}
      <div className="dw-cards">
        {shown.map((o) => (
          <CardPick
            key={o.id}
            o={o}
            img={o.img ?? ctx.meta[o.name]?.image ?? null}
            at={picked(o)}
            disabled={disabled}
            label={p.purpose === "discard" && picked(o) >= 0 && !p.ordered ? "Discard" : undefined}
            onPick={() => onDraft(togglePick(p, draft, o.id))}
            onRead={() => ctx.onRead(o.name, Number(o.id))}
          />
        ))}
        {!eligible.length && <p className="dw-empty">No card here qualifies.</p>}
      </div>
      {others.length > 0 && (
        <details className="dw-others">
          <summary>
            {others.length} other {others.length === 1 ? "card" : "cards"} {where} {others.length === 1 ? "doesn't" : "don't"} qualify
          </summary>
          <p>{others.join(", ")}.</p>
        </details>
      )}
      <p className="dw-foot">{compact ? "Long-press a card to read it. " : "Right-click a card to read it. "}{IMAGES}</p>
    </div>
  );
}

// ── scry and surveil (GScry, GScryPhone) ───────────────────────────────────

/** Two piles: what stays on top (left is drawn first) and what goes to the bottom or graveyard. */
export function ScryPiles({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const byId = new Map(p.options.map((o) => [o.id, o]));
  const top = draft.ids.map((id) => byId.get(id)).filter((o): o is DecisionOption => !!o);
  const away = p.options.filter((o) => !draft.ids.includes(o.id));
  const awayName = p.purpose === "surveil" ? "graveyard" : "bottom";
  const img = (o: DecisionOption) => o.img ?? ctx.meta[o.name]?.image ?? null;
  const send = (o: DecisionOption, keep: boolean) => onDraft(keepOnTop(p, draft, o.id, keep));
  const drawTag = (i: number) => (i === 0 ? "Next draw" : `Then ${i + 1}`);
  const summary = top.length
    ? `Next draw: ${top[0]!.name}.${away.length ? ` ${away.map((o) => o.name).join(" and ")} ${away.length === 1 ? "goes" : "go"} to the ${awayName === "bottom" ? "bottom" : "graveyard"}.` : ""}`
    : `All ${away.length} go to the ${awayName === "bottom" ? "bottom" : "graveyard"}.`;

  if (compact) {
    // GScryPhone: one row per card, the ones on top first in the order they'll be drawn.
    const rows = [...top.map((o, i) => ({ o, i, on: true })), ...away.map((o) => ({ o, i: -1, on: false }))];
    return (
      <div className="dw-scry compact">
        <Head p={p} ctx={ctx} count={counter(p, draft)} compact />
        <ol className="dw-scry-rows">
          {rows.map(({ o, i, on }) => (
            <li key={o.id} className={on ? "on" : ""}>
              <ReadImg src={img(o)} name={o.name} onRead={() => ctx.onRead(o.name, Number(o.id))} />
              <span className="dw-scry-row-body">
                <span className="dw-scry-row-head">
                  <b>{o.name}</b>
                  <span>{on ? (i === 0 ? "Drawn first" : i === 1 ? "Drawn second" : `Top, card ${i + 1}`) : p.purpose === "surveil" ? "Graveyard" : "Bottom"}</span>
                </span>
                <span className="dw-scry-row-controls">
                  <span className="dw-seg" role="radiogroup" aria-label={`${o.name} goes`}>
                    <button type="button" role="radio" aria-checked={on} className={on ? "on" : ""} disabled={disabled} onClick={() => send(o, true)}>Top</button>
                    <button type="button" role="radio" aria-checked={!on} className={!on ? "on" : ""} disabled={disabled} onClick={() => send(o, false)}>
                      {p.purpose === "surveil" ? "Graveyard" : "Bottom"}
                    </button>
                  </span>
                  {on && top.length > 1 && (
                    <span className="dw-arrows">
                      <button type="button" className="outline" aria-label={`Draw ${o.name} sooner`} disabled={disabled || i === 0} onClick={() => onDraft(move(draft, i, -1))}>↑</button>
                      <button type="button" className="outline" aria-label={`Draw ${o.name} later`} disabled={disabled || i === top.length - 1} onClick={() => onDraft(move(draft, i, 1))}>↓</button>
                    </span>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <p className="dw-foot">Cards kept on top are listed first, in the order you'll draw them. Long-press a card to read it.</p>
      </div>
    );
  }

  return (
    <div className="dw-scry">
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={false} />
      <div className="dw-piles">
        <section className="dw-pile top" aria-label="Top of library">
          <header>
            <b>Top of library</b>
            <span>{top.length > 2 ? `Left is drawn first. Click a card to send it to the ${awayName === "bottom" ? "bottom" : "graveyard"}` : "Left is drawn first"}</span>
          </header>
          {/* Three or more on top: smaller cards, so they stay in one row (a click still sends one away). */}
          <div className={`dw-pile-cards${top.length > 2 ? " many" : ""}`}>
            {top.map((o, i) => (
              <div key={o.id} className="dw-pile-card">
                <span className={`dw-tag${i === 0 ? " first" : ""}`}>{drawTag(i)}</span>
                <ReadButton className="dw-pile-img" label={`${o.name}. Send to the ${awayName}`} disabled={disabled} onClick={() => send(o, false)} onRead={() => ctx.onRead(o.name, Number(o.id))}>
                  {img(o) ? <img src={img(o)!} alt="" draggable={false} /> : <span className="dw-card-name">{o.name}</span>}
                </ReadButton>
                <span className="dw-arrows">
                  <button type="button" className="outline" aria-label={`Move ${o.name} earlier`} disabled={disabled || i === 0} onClick={() => onDraft(move(draft, i, -1))}>←</button>
                  {top.length <= 2 && (
                    <button type="button" className="outline" disabled={disabled} onClick={() => send(o, false)}>
                      {p.purpose === "surveil" ? "To graveyard" : "To bottom"}
                    </button>
                  )}
                  <button type="button" className="outline" aria-label={`Move ${o.name} later`} disabled={disabled || i === top.length - 1} onClick={() => onDraft(move(draft, i, 1))}>→</button>
                </span>
              </div>
            ))}
            {!top.length && <p className="dw-empty">Nothing kept on top.</p>}
          </div>
        </section>
        <section className="dw-pile away" aria-label={p.purpose === "surveil" ? "Graveyard" : "Bottom of library"}>
          <header>
            <b>{p.purpose === "surveil" ? "Graveyard" : "Bottom of library"}</b>
            <span>Order doesn't matter</span>
          </header>
          <div className="dw-pile-cards">
            {away.map((o) => (
              <ReadButton key={o.id} className="dw-pile-img small" label={`${o.name}. Keep on top`} disabled={disabled} onClick={() => send(o, true)} onRead={() => ctx.onRead(o.name, Number(o.id))}>
                {img(o) ? <img src={img(o)!} alt="" draggable={false} /> : <span className="dw-card-name">{o.name}</span>}
                <span className="dw-hint">Click to keep on top</span>
              </ReadButton>
            ))}
            {!away.length && <p className="dw-empty">Click a card on the left to send it here.</p>}
          </div>
        </section>
      </div>
      <p className="dw-summary">{summary}</p>
      <p className="dw-foot">{IMAGES}</p>
    </div>
  );
}

function ReadImg({ src, name, onRead }: { src: string | null; name: string; onRead: () => void }) {
  const { handlers } = useRead(onRead);
  return src ? <img className="dw-row-img" src={src} alt={name} {...handlers} /> : <span className="dw-row-img blank" />;
}

function ReadButton({ className, label, disabled, onClick, onRead, children }: { className: string; label: string; disabled: boolean; onClick: () => void; onRead: () => void; children: ReactNode }) {
  const { handlers, consumed } = useRead(onRead);
  return (
    <button type="button" className={className} aria-label={label} disabled={disabled} onClick={() => !consumed() && onClick()} {...handlers}>
      {children}
    </button>
  );
}

// ── put in order (GOrder, GTriggers) ───────────────────────────────────────

/**
 * Drag to reorder: a press on a handle follows the pointer and moves its entry past each
 * neighbour's middle. The arrows do the same one step at a time. `onEnd` runs when the press
 * lets go (the hand order sends the new order then, not at every step).
 */
export function useReorder(axis: "x" | "y", onMove: (from: number, to: number) => void, onEnd?: () => void) {
  const list = useRef<HTMLOListElement>(null);
  const drag = useRef<{ i: number; pointer: number } | null>(null);
  return {
    list,
    handle: (i: number) => ({
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { i, pointer: e.pointerId };
      },
      onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId || !list.current) return;
        const items = [...list.current.querySelectorAll<HTMLElement>(":scope > [data-reorder]")];
        const at = axis === "x" ? e.clientX : e.clientY;
        let to = d.i;
        items.forEach((el, k) => {
          const r = el.getBoundingClientRect();
          const mid = axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2;
          if (k < d.i && at < mid) to = Math.min(to, k);
          if (k > d.i && at > mid) to = Math.max(to, k);
        });
        if (to !== d.i) {
          onMove(d.i, to);
          d.i = to;
        }
      },
      onPointerUp: () => {
        if (drag.current) onEnd?.();
        drag.current = null;
      },
      onPointerCancel: () => {
        if (drag.current) onEnd?.();
        drag.current = null;
      },
    }),
  };
}

const Grip = ({ cols }: { cols: number }) => (
  <span className="dw-grip" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${cols}, 4px)` }}>
    {Array.from({ length: 6 }, (_, i) => <span key={i} />)}
  </span>
);

/** Cards in an order (GOrder): left to right is the order sent, with the destination drawn beside them. */
export function OrderCards({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  // A dig's rest split by someone else keeps its two piles: only the order within each moves.
  const { list, handle } = useReorder(compact ? "y" : "x", (from, to) => canMoveOrder(p, from, to) && onDraft(moveTo(draft, from, to)));
  if (draft.kind !== "order") return null;
  const byId = new Map(p.options.map((o) => [o.id, o]));
  const n = draft.ids.length;
  // Telling Time: the first `topCount` go on top, the rest to the bottom, with a line between.
  const split = p.topCount !== undefined && p.topCount > 0 && p.topCount < n ? p.topCount : null;
  const top = p.destination === "top" || (p.topCount ?? 0) > 0;
  const img = (o: DecisionOption | undefined) => (o ? o.img ?? ctx.meta[o.name]?.image ?? null : null);
  return (
    <div className={`dw-order${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-order-body">
        <div className={`dw-edge ${top ? "top" : "bottom"}`} aria-hidden={!compact}>
          <span className="dw-edge-pile">
            <span className="dw-edge-line" />
          </span>
          <span>{top ? "Top of your library" : "Bottom of your library"}</span>
        </div>
        <ol className="dw-order-list" ref={list}>
          {draft.ids.map((id, i) => {
            const o = byId.get(id);
            const name = o?.name ?? "A card";
            return [
              split === i && (
                <li key="split" className="dw-order-split" aria-hidden="true">
                  <span>Bottom of your library</span>
                </li>
              ),
              <li key={id} data-reorder className="dw-order-item">
                <span className={`dw-tag${i === 0 ? " first" : ""}`}>{orderTag(p, i, n)}</span>
                <span className="dw-order-card" {...handle(i)}>
                  <ReadImg src={img(o)} name={name} onRead={() => ctx.onRead(name, Number(id))} />
                  <span className="pick-badge num">{i + 1}</span>
                </span>
                {compact && <b className="dw-order-name">{name}</b>}
                <span className="dw-arrows">
                  <button type="button" className="outline" aria-label={`Move ${name} ${top ? "nearer the top" : "higher"}`} disabled={disabled || i === 0 || !canMoveOrder(p, i, i - 1)} onClick={() => onDraft(move(draft, i, -1))}>
                    {compact ? "↑" : "←"}
                  </button>
                  {!compact && (
                    <span className="dw-grip-wrap" title="Drag" {...handle(i)}>
                      <Grip cols={3} />
                    </span>
                  )}
                  <button type="button" className="outline" aria-label={`Move ${name} ${top ? "deeper" : "lower"}`} disabled={disabled || i === n - 1 || !canMoveOrder(p, i, i + 1)} onClick={() => onDraft(move(draft, i, 1))}>
                    {compact ? "↓" : "→"}
                  </button>
                </span>
              </li>,
            ];
          })}
        </ol>
      </div>
      <p className="dw-foot">{compact ? "Press and hold a card to drag it. " : "Drag a card, or use the arrows; left to right is the order it's sent. "}{IMAGES}</p>
    </div>
  );
}

/** Triggers in order (GTriggers): the top one resolves first; each row is the trigger's own Oracle text. */
export function TriggerOrder({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  const { list, handle } = useReorder("y", (from, to) => onDraft(moveTo(draft, from, to)));
  if (draft.kind !== "order") return null;
  const byId = new Map(p.options.map((o) => [o.id, o]));
  const n = draft.ids.length;
  return (
    <div className={`dw-triggers${compact ? " compact" : ""}`}>
      <div className="dw-head">
        <span className="dw-head-text">
          <h2>{p.prompt}</h2>
          <span className="dw-oracle">The top one resolves first.</span>
        </span>
        <span className="dw-count">{counter(p, draft)}</span>
      </div>
      <ol className="dw-trigger-list" ref={list}>
        {draft.ids.map((id, i) => {
          const o = byId.get(id);
          const art = o?.art ?? (o ? ctx.meta[o.name]?.art : null);
          const artist = o?.artist ?? (o ? ctx.meta[o.name]?.artist : null);
          const name = o?.name ?? "A trigger";
          return (
            <li key={id} data-reorder className="dw-trigger">
              <span className="dw-grip-wrap" title="Drag" {...handle(i)}>
                <Grip cols={2} />
              </span>
              <b className="dw-trigger-n">{i + 1}</b>
              <ReadImg src={art ?? null} name={name} onRead={() => o && ctx.onRead(o.name)} />
              <span className="dw-trigger-text">
                <b>{name}</b>
                {o?.text && <span>{o.text}</span>}
                <span className="dw-credit">
                  {orderTag(p, i, n) === "Then" ? "" : `${orderTag(p, i, n)}. `}
                  {artist ? `Art: ${artist}` : ""}
                </span>
              </span>
              <span className="dw-arrows col">
                <button type="button" className="outline" aria-label={`Move ${name} up`} disabled={disabled || i === 0} onClick={() => onDraft(move(draft, i, -1))}>↑</button>
                <button type="button" className="outline" aria-label={`Move ${name} down`} disabled={disabled || i === n - 1} onClick={() => onDraft(move(draft, i, 1))}>↓</button>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="dw-foot">Drag a handle or use the arrows. {COPYRIGHT}.</p>
    </div>
  );
}

// ── split a number (GSplit, GDamage, GTargetsMore) ─────────────────────────

function Stepper({ name, n, onLess, onMore, lessOff, moreOff, size = "md" }: { name: string; n: number; onLess: () => void; onMore: () => void; lessOff: boolean; moreOff: boolean; size?: "sm" | "md" }) {
  return (
    <span className={`dw-stepper ${size}`} role="group" aria-label={`Amount for ${name}`}>
      <button type="button" aria-label={`One less to ${name}`} disabled={lessOff} onClick={onLess}>−</button>
      <output aria-live="polite" className="num">{n}</output>
      <button type="button" aria-label={`One more to ${name}`} disabled={moreOff} onClick={onMore}>+</button>
    </span>
  );
}

/** Whose it is and what kills it, for a row of a split: "Sam's, lethal 2", "The player". */
function splitWho(o: DecisionOption, ctx: WidgetContext, damage: number): string {
  const mine = o.controller !== undefined && ctx.who(o.controller) === "you";
  const whose = o.zone === "player" ? (mine ? "You" : "The player") : o.controller === undefined ? "" : mine ? "Yours" : `${ctx.who(o.controller)}'s`;
  const lethal = lethalOf(o, damage);
  return [whose, lethal !== undefined ? `lethal ${lethal}` : ""].filter(Boolean).join(", ");
}

/** A split as rows of steppers: on a phone, and on a laptop when the targets can't all carry their own. */
export function SplitRows({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "split") return null;
  const rest = left(p, draft);
  const given = (p.total ?? 0) - rest;
  const min = p.perOptionMin ?? 0;
  // Every art crop shown names its artist: the source's is in the heading, the targets' (laptop) here.
  const artists = [...new Set((compact ? [] : p.options.map((o) => (o.art ?? ctx.meta[o.name]?.art ? o.artist ?? ctx.meta[o.name]?.artist : null))).filter((a): a is string => !!a))];
  return (
    <div className={`dw-split${compact ? " compact" : ""}`}>
      <Head
        p={p}
        ctx={ctx}
        compact={compact}
        extra={
          // Counters that may move or come off up to a total count up; everything else counts down.
          p.upTo ? (
            <span className="dw-left">
              <b className="num">{given}</b>
              <span>of {p.total ?? 0}</span>
            </span>
          ) : (
            <span className="dw-left">
              <b className={`num${rest === 0 ? " done" : ""}`}>{rest}</b>
              <span>{compact ? "left" : `of ${p.total ?? 0} left`}</span>
            </span>
          )
        }
      />
      <div className="dw-split-rows">
        {p.options.map((o) => {
          const n = draft.amounts[o.id] ?? 0;
          const damage = o.zone === "player" ? 0 : ctx.damageOf(Number(o.id));
          const tag = splitTag(p, o, n, damage);
          const theirs = o.controller !== undefined && ctx.who(o.controller) !== "you";
          const art = o.art ?? ctx.meta[o.name]?.art ?? null;
          return (
            <div key={o.id} className="dw-split-row">
              {!compact && (
                <span className="dw-split-art">{art ? <img src={art} alt="" /> : null}</span>
              )}
              <span className="dw-split-text" style={seatDot(o.controller !== undefined ? ctx.tone(o.controller) : undefined)}>
                <b>{o.name}</b>
                {o.text && <span>{o.text}</span>}
                {o.controller !== undefined && (
                  <span>
                    <span className="seat-dot" aria-hidden="true" />
                    {splitWho(o, ctx, damage)}
                  </span>
                )}
                {o.cap !== undefined && <span>{p.answer === "move_counters" ? `${o.cap} can move` : `${o.cap} on it`}</span>}
                {compact && tag && <span className={`dw-tag${tag.dies ? (theirs ? " good" : " bad") : ""}`}>{tag.text}</span>}
              </span>
              {!compact && tag && <span className={`dw-tag${tag.dies ? (theirs ? " good" : " bad") : ""}`}>{tag.text}</span>}
              <span className="dw-split-controls">
                <Stepper
                  name={o.name}
                  n={n}
                  lessOff={disabled || n <= min}
                  moreOff={disabled || room(p, draft, o.id) <= 0}
                  onLess={() => onDraft(adjust(p, draft, o.id, -1))}
                  onMore={() => onDraft(adjust(p, draft, o.id, 1))}
                />
                {!compact && room(p, draft, o.id) > 0 && (
                  <button type="button" className="outline small" disabled={disabled} onClick={() => onDraft(restHere(p, draft, o.id))}>
                    {p.unit === "counters" ? "All" : "Rest here"}
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <p className="dw-foot">
        {p.unit === "mana" ? "One colour for each mana." : p.unit === "counters" ? (p.upTo ? "Any number, none included." : `Exactly ${p.total ?? 0}.`) : "Starts at the engine's split."}
        {min > 0 ? ` Each gets at least ${min}.` : ""} {artists.length ? `Art: ${artists.join(", ")}, ${COPYRIGHT}.` : ""}
      </p>
    </div>
  );
}

/** Where a split's option sits on the board: a permanent's tile, an opponent's header or your portrait. */
function anchorOf(root: HTMLElement, o: DecisionOption, ctx: WidgetContext): HTMLElement | null {
  if (o.zone === "player" && o.controller !== undefined) {
    if (ctx.who(o.controller) === "you") return root.querySelector<HTMLElement>(`.portrait[data-seat="${o.controller}"]`);
    return seatHeadOf(root, o.controller);
  }
  return tileOf(root, Number(o.id));
}

/**
 * A split on the board itself (GTargetsMore, GDamage): a stepper on each target and its lethal
 * hint under it. Positioned over the elements it belongs to, measured after every board.
 */
export function SplitSteppers({ p, draft, onDraft, ctx, disabled, root }: Props & { root: React.RefObject<HTMLElement | null> }) {
  const marks = useRef(new Map<string, HTMLDivElement>());
  const [, remeasure] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const r = root.current;
    if (!r) return;
    for (const o of p.options) {
      const el = marks.current.get(o.id);
      const at = anchorOf(r, o, ctx);
      if (!el) continue;
      if (!at) {
        el.hidden = true;
        continue;
      }
      const box = at.getBoundingClientRect();
      el.hidden = false;
      el.style.left = `${box.left}px`;
      el.style.top = `${box.top}px`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
    }
  });
  useEffect(() => {
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
  }, [root]);
  if (draft.kind !== "split") return null;
  const rest = left(p, draft);
  const min = p.perOptionMin ?? 0;
  return (
    <div className="dw-steppers">
      {p.options.map((o) => {
        const n = draft.amounts[o.id] ?? 0;
        const tag = splitTag(p, o, n, o.zone === "player" ? 0 : ctx.damageOf(Number(o.id)));
        const theirs = o.controller !== undefined && ctx.who(o.controller) !== "you";
        return (
          <div
            key={o.id}
            className={`dw-mark${o.zone === "player" ? " seat" : ""}`}
            ref={(el) => {
              if (el) marks.current.set(o.id, el);
              else marks.current.delete(o.id);
            }}
            hidden
          >
            <Stepper
              size="sm"
              name={o.name}
              n={n}
              lessOff={disabled || n <= min}
              moreOff={disabled || rest <= 0 || room(p, draft, o.id) <= 0}
              onLess={() => onDraft(adjust(p, draft, o.id, -1))}
              onMore={() => onDraft(adjust(p, draft, o.id, 1))}
            />
            {tag && <span className={`dw-tag${tag.dies ? (theirs ? " good" : " bad") : ""}`}>{tag.text}</span>}
            {/* Counters: how many it has of the kind, and what that becomes. */}
            {p.unit === "counters" && o.group !== undefined && <span className="dw-tag">{counterLine(p, o, n)}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** A permanent's counters of an option's kind, and what they become: "+1/+1 ×1 → ×3". */
function counterLine(p: Pending, o: DecisionOption, n: number): string {
  const kind = (o.text ?? "").replace(/ counters$/, "") || (o.counters?.[0]?.[0] ?? "");
  const has = o.counters?.find(([k]) => k === kind)?.[1] ?? 0;
  const after = p.answer === "move_counters" ? has + n : has - n;
  return n ? `${kind} ×${has} → ×${after}` : `${kind} ×${has}`;
}

// ── a number (GNumber, GModes' X) ──────────────────────────────────────────

/** A number: X with its cost preview and Max, or a chosen number with a keypad. Digit keys type it. */
export function NumberPick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  // Digit keys type the number and the arrows step it, unless you're typing somewhere else.
  const latest = useRef({ p, draft, onDraft, disabled });
  latest.current = { p, draft, onDraft, disabled };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { p, draft, onDraft, disabled } = latest.current;
      if (disabled || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        onDraft(typeDigit(p, draft, Number(e.key)));
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        onDraft(stepNumber(p, draft, e.key === "ArrowUp" ? 1 : -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (draft.kind !== "number") return null;
  const v = draft.value;
  const keys = keypad(p);
  const x = p.answer === "choose_x";
  const cost = x && v !== null ? p.previews?.find(([n]) => n === v)?.[1] : undefined;
  const s = p.source;
  const image = s?.image ?? (s ? ctx.meta[s.name]?.image : null);
  const manaCost = s ? ctx.meta[s.name]?.mana_cost ?? null : null;
  return (
    <div className={`dw-number${compact ? " compact" : ""}`}>
      {!compact && image && (
        <aside className="dw-number-card">
          <ReadImg src={image} name={s!.name} onRead={() => ctx.onRead(s!.name, s!.id)} />
          {s?.artist && <span className="dw-credit">Art: {s.artist}, {COPYRIGHT}</span>}
        </aside>
      )}
      <div className="dw-number-body">
        {compact ? (
          <Head p={p} ctx={ctx} compact />
        ) : (
          <span className="dw-head-text">
            {s && (
              <span className="dw-source-line">
                {s.name}
                {manaCost ? ", " : ""}
                {manaCost && <ManaCost cost={manaCost} />}
              </span>
            )}
            <h2>{p.prompt}</h2>
            {p.oracle && <span className="dw-oracle">{p.oracle}</span>}
          </span>
        )}
        {x ? (
          <>
            <div className="dw-x">
              <span className="dw-x-label">
                <b>X</b>
                <span>From {p.min} to {p.max}.</span>
              </span>
              <span className="dw-x-controls">
                <Stepper name="X" n={v ?? p.min} lessOff={disabled || (v ?? p.min) <= p.min} moreOff={disabled || (v ?? p.min) >= p.max} onLess={() => onDraft(stepNumber(p, draft, -1))} onMore={() => onDraft(stepNumber(p, draft, 1))} />
                <button type="button" className="outline" disabled={disabled || v === p.max} onClick={() => onDraft(setNumber(p, p.max))}>Max</button>
              </span>
            </div>
            {cost && (
              <div className="dw-cost">
                <span>Total cost, from the engine's preview</span>
                <b><ManaCost cost={cost} /></b>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="dw-big-stepper">
              <button type="button" aria-label="One less" disabled={disabled || (v !== null && v <= p.min)} onClick={() => onDraft(stepNumber(p, draft, -1))}>−</button>
              <output aria-live="polite" className="num">{v ?? "–"}</output>
              <button type="button" aria-label="One more" disabled={disabled || (v !== null && v >= p.max)} onClick={() => onDraft(stepNumber(p, draft, 1))}>+</button>
            </div>
            {keys ? (
              <div className="dw-keys" role="radiogroup" aria-label={`Numbers ${p.min} to ${p.max}`}>
                {keys.map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={v === n} className={v === n ? "on" : "pick"} disabled={disabled} onClick={() => onDraft(setNumber(p, n))}>
                    {n}
                  </button>
                ))}
              </div>
            ) : (
              <button type="button" className="outline dw-max" disabled={disabled || v === p.max} onClick={() => onDraft(setNumber(p, p.max))}>Max: {p.max}</button>
            )}
          </>
        )}
        <span className="dw-note">
          {x ? "" : `From ${p.min} to ${p.max}. `}
          {compact ? "" : "Digit keys type it; ↑ and ↓ step."}
        </span>
      </div>
    </div>
  );
}

// ── a name or word (GName, GChoices) ───────────────────────────────────────

/** The five colours, for a colour choice: a swatch beside each name. */
const COLOR_FILL: Record<string, string> = { white: MANA.W.fill, blue: MANA.U.fill, black: MANA.B.fill, red: MANA.R.fill, green: MANA.G.fill, colorless: MANA.C.fill };

/**
 * A name: typed, with matches from Yama's card names (cards in play first), or picked from the
 * engine's fixed list. ↑ and ↓ move through the matches; Enter picks one; the rail confirms.
 */
export function NamePick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [found, setFound] = useState<string[]>([]);
  const free = !!p.freeEntry;
  const cardNames = free && p.choiceType === "card name";
  // Yama's card names for what's typed (GET /api/cards/autocomplete), a moment after typing stops.
  useEffect(() => {
    if (!cardNames || q.trim().length < 2) return setFound([]);
    let live = true;
    const t = window.setTimeout(() => {
      api<string[]>(`/api/cards/autocomplete?q=${encodeURIComponent(q.trim())}`).then(
        (names) => live && setFound(names),
        () => live && setFound([]),
      );
    }, 150);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, cardNames]);
  const fixed = free ? null : p.options.map((o) => o.name);
  // A type or word in play: a card on the battlefield whose type line has it.
  const typeLines = ctx.inPlay.map((c) => ctx.meta[c.name]?.type_line ?? "");
  const inPlay = free ? ctx.inPlay.map((c) => c.name) : (fixed ?? []).filter((w) => typeLines.some((t) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t)));
  const matches = nameMatches(q, fixed, inPlay, free && !cardNames && q.trim() ? [q.trim()] : found).slice(0, 12);
  const shownHi = Math.min(hi, Math.max(0, matches.length - 1));
  const highlighted = matches[shownHi]?.name ?? (draft.kind === "text" ? draft.value : "");
  const art = useCardArt(cardNames && highlighted && !ctx.meta[highlighted]?.art ? [highlighted] : []);
  if (draft.kind !== "text") return null;
  const preview = cardNames ? (ctx.meta[highlighted]?.art ? { art: ctx.meta[highlighted]!.art, artist: ctx.meta[highlighted]!.artist } : art.get(highlighted) ?? null) : null;
  const pick = (name: string) => onDraft({ kind: "text", value: name });
  const where = (name: string, inPlayNow: boolean) => {
    const c = ctx.inPlay.find((x) => x.name === name);
    if (c) return { text: `On the battlefield, ${ctx.who(c.seat) === "you" ? "yours" : ctx.who(c.seat)}`, seat: c.seat };
    if (inPlayNow) return { text: "In play", seat: undefined };
    return { text: cardNames ? "Card" : "", seat: undefined };
  };
  const color = p.choiceType === "color";
  return (
    <div className={`dw-name${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-name-grid">
        <div className="dw-name-main">
          {(free || p.options.length > 8) && (
            <input
              type="text"
              className="dw-name-input"
              value={q}
              autoFocus={!compact}
              disabled={disabled}
              placeholder={cardNames ? "Type a card name" : free ? `Type a ${p.choiceType ?? "word"}` : "Filter the list"}
              aria-label={p.prompt}
              aria-controls="dw-name-list"
              onChange={(e) => {
                setQ(e.target.value);
                setHi(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setHi((h) => Math.max(0, Math.min(matches.length - 1, h + (e.key === "ArrowDown" ? 1 : -1))));
                } else if (e.key === "Enter" && matches[shownHi]) {
                  e.preventDefault();
                  pick(matches[shownHi]!.name);
                } else if (e.key === "Escape" && q) {
                  e.stopPropagation();
                  setQ("");
                }
              }}
            />
          )}
          <div className="dw-name-list" id="dw-name-list" role="listbox" aria-label="Matches">
            {matches.map((m, i) => {
              const on = draft.value === m.name;
              const w = where(m.name, m.inPlay);
              return (
                <button
                  key={m.name}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`dw-name-row${on ? " picked" : " pick"}${i === shownHi ? " hi" : ""}`}
                  disabled={disabled}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => pick(m.name)}
                >
                  {color && COLOR_FILL[m.name.toLowerCase()] && <span className="dw-swatch" style={{ background: COLOR_FILL[m.name.toLowerCase()] }} aria-hidden="true" />}
                  <b>{m.name}</b>
                  {w.text && (
                    <span className="dw-where" style={seatDot(w.seat !== undefined ? ctx.tone(w.seat) : undefined)}>
                      {w.seat !== undefined && <span className="seat-dot" aria-hidden="true" />}
                      {w.text}
                    </span>
                  )}
                </button>
              );
            })}
            {!matches.length && <p className="dw-empty">{cardNames && q.trim().length < 2 ? "Type at least two letters." : "Nothing matches."}</p>}
          </div>
          <span className="dw-note">{cardNames ? "Names come from Yama's card list. Cards in play come first." : free ? "Any word; the engine checks it." : "Only the engine's list. Ones in play come first."}</span>
        </div>
        {!compact && cardNames && (
          <aside className="dw-name-preview" aria-label="Highlighted">
            <span className="dw-note">Highlighted</span>
            {preview?.art ? <img src={preview.art} alt="" /> : <span className="dw-name-blank">The card's art loads from Scryfall here.</span>}
            <b>{highlighted || "Nothing yet"}</b>
            {preview?.artist && <span className="dw-credit">Art: {preview.artist}, {COPYRIGHT}</span>}
          </aside>
        )}
      </div>
    </div>
  );
}

// ── modes (GModes) ─────────────────────────────────────────────────────────

/** The line of the Oracle text that says how many modes to choose ("Choose one —"). */
function ruleLine(oracle: string | undefined): string | null {
  if (!oracle) return null;
  const lines = oracle.split("\n");
  const first = lines.findIndex((l) => l.trim().startsWith("•"));
  return first > 0 ? lines[first - 1]!.trim() : null;
}

/** Modes as tiles: one to choose (radios) or several (checkboxes), each in the card's Oracle words. */
export function ModePick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const s = p.source;
  const multi = p.max > 1;
  const image = s?.image ?? (s ? ctx.meta[s.name]?.image : null);
  const manaCost = s ? ctx.meta[s.name]?.mana_cost ?? null : null;
  const rule = ruleLine(p.oracle);
  return (
    <div className={`dw-modes${compact ? " compact" : ""}`}>
      <div className="dw-head image">
        {image && <ReadImg src={image} name={s!.name} onRead={() => ctx.onRead(s!.name, s!.id)} />}
        <span className="dw-head-text">
          {s && (
            <span className="dw-source-line">
              {s.name}
              {manaCost ? ", " : ""}
              {manaCost && <ManaCost cost={manaCost} />}
            </span>
          )}
          <h2>{p.prompt}</h2>
          {rule && <span className="dw-oracle">{rule}</span>}
        </span>
        <span className="dw-count">{counter(p, draft)}</span>
      </div>
      <div className="dw-mode-list" role={multi ? "group" : "radiogroup"} aria-label="Modes">
        {p.options.map((o) => {
          const times = draft.ids.filter((x) => x === o.id).length;
          return (
            <button
              key={o.id}
              type="button"
              role={multi ? "checkbox" : "radio"}
              aria-checked={times > 0}
              className={`dw-mode${times ? " picked" : o.eligible ? " pick" : ""}${multi ? " multi" : ""}`}
              disabled={disabled || !o.eligible}
              onClick={() => onDraft(togglePick(p, draft, o.id))}
            >
              <span className="dw-mark-box" aria-hidden="true">{times && multi ? "✓" : ""}</span>
              <span className="dw-mode-text">
                {o.text ?? o.name}
                {!o.eligible && <span className="dw-note">Can't be chosen now.</span>}
              </span>
              {p.repeat && times > 0 && <span className="pick-badge num">×{times}</span>}
            </button>
          );
        })}
      </div>
      <p className="dw-foot">Mode text is the card's Oracle text. {image ? IMAGES : ""}</p>
    </div>
  );
}

// ── replacement effects (GReplace) ─────────────────────────────────────────

/** Which replacement effect applies first, with "use this order whenever" where the engine offers it. */
export function ReplacePick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const first = draft.ids[0];
  return (
    <div className={`dw-replace${compact ? " compact" : ""}`}>
      <div className="dw-head">
        <span className="dw-head-text">
          <h2>Which applies first?</h2>
          <span className="dw-oracle">{p.prompt}.</span>
        </span>
      </div>
      <div className="dw-replace-list" role="radiogroup" aria-label="Applies first">
        {p.options.map((o) => {
          const on = first === o.id;
          const img = o.img ?? ctx.meta[o.name]?.image ?? null;
          return (
            <button key={o.id} type="button" role="radio" aria-checked={on} className={`dw-replace-row${on ? " picked" : " pick"}`} disabled={disabled} onClick={() => onDraft(togglePick(p, draft, o.id))}>
              {img && !compact ? <img src={img} alt="" /> : null}
              <span className="dw-replace-text">
                <b>{o.name}</b>
                {o.text && <span>{o.text}</span>}
              </span>
              {first !== undefined && <span className={`dw-tag${on ? " first" : ""}`}>{on ? "Applies first" : "Then this"}</span>}
            </button>
          );
        })}
      </div>
      {canRememberOrder(p) && (
        <label className="dw-check">
          <input type="checkbox" checked={!!draft.remember} disabled={disabled} onChange={(e) => onDraft({ ...draft, remember: e.target.checked })} />
          Use this order whenever these two apply to the same event
        </label>
      )}
      <p className="dw-foot">{IMAGES}</p>
    </div>
  );
}

// ── pair up (GPairUp) ──────────────────────────────────────────────────────

/** Soulbond on a phone: the creature entering, and the ones it may pair with. */
export function PairList({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  return (
    <div className={`dw-pair${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <span className="dw-note">Pair it with</span>
      <div className="dw-pair-list">
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          const art = o.art ?? ctx.meta[o.name]?.art ?? null;
          return (
            <button key={o.id} type="button" aria-pressed={on} className={`dw-pair-row${on ? " picked" : " pick"}`} disabled={disabled} onClick={() => onDraft(togglePick(p, draft, o.id))}>
              <span className="dw-pair-art">{art && <img src={art} alt="" />}</span>
              <b>{o.name}</b>
              {o.artist && <span className="dw-credit">Art: {o.artist}</span>}
              {on && <span className="pick-badge num">1</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── paying (GMana, GCosts) ─────────────────────────────────────────────────

/** A mana symbol's colour, for a swatch: the first colour of "W", "WU" or "W/U". */
function manaFill(code: string): string {
  const k = code.replace(/[^WUBRGC]/g, "")[0] as keyof typeof MANA | undefined;
  return k ? MANA[k].fill : MANA.C.fill;
}

/** The ink that reads on that colour. */
function manaInk(code: string): string {
  const k = code.replace(/[^WUBRGC]/g, "")[0] as keyof typeof MANA | undefined;
  return k ? MANA[k].ink : MANA.C.ink;
}

/**
 * A colour of mana (GMana's first tab): a tile per colour the engine offers, or per whole
 * combination for a filter land, or per way to pay a mana ability's hybrid cost.
 */
export function ManaColorPick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const single = p.purpose === "color";
  return (
    <div className={`dw-mana${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} compact={compact} />
      <div className="dw-mana-list" role="radiogroup" aria-label={p.prompt}>
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          const codes = single ? [o.id] : o.id.split("");
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`dw-mana-tile${on ? " picked" : o.eligible ? " pick" : ""}`}
              disabled={disabled || !o.eligible}
              onClick={() => onDraft(togglePick(p, draft, o.id))}
            >
              <span className="dw-swatches" aria-hidden="true">
                {codes.map((c, i) => (
                  <span key={i} className="dw-swatch big" style={{ background: manaFill(c) }} />
                ))}
              </span>
              <b>{o.name}</b>
            </button>
          );
        })}
      </div>
      {single && <p className="dw-note">The colours the engine offers for this source.</p>}
    </div>
  );
}

/**
 * Phyrexian mana (GMana): one switch per Phyrexian symbol, mana or 2 life, with what that leaves
 * your life at and the mana still to pay. A symbol only one way can pay shows that way, fixed.
 */
export function PhyrexianPick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const life = phyrexianLife(p, draft);
  const mana = phyrexianMana(p, draft);
  const set = (id: string, withLife: boolean) => {
    const on = draft.ids.includes(id);
    if (on !== withLife) onDraft(togglePick(p, draft, id));
  };
  return (
    <div className={`dw-phyrexian${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} compact={compact} />
      <div className="dw-shards">
        {p.options.map((o) => {
          const withLife = draft.ids.includes(o.id);
          return (
            <div key={o.id} className="dw-shard">
              <span className="dw-shard-pip" style={{ background: manaFill(o.name), color: manaInk(o.name) }} aria-hidden="true">{o.name.replace(/[{}]/g, "")}</span>
              <span className="dw-shard-text">
                <b>{o.name} in the cost</b>
                <span>{o.eligible ? `Pay with ${o.cost ?? "mana"} or 2 life.` : o.text}</span>
              </span>
              <span className="dw-seg" role="radiogroup" aria-label={`Pay ${o.name} with`}>
                <button type="button" role="radio" aria-checked={!withLife} className={withLife ? "" : "on"} disabled={disabled || !o.eligible} onClick={() => set(o.id, false)}>
                  {o.cost ?? "Mana"}
                </button>
                <button type="button" role="radio" aria-checked={withLife} className={withLife ? "on" : ""} disabled={disabled || !o.eligible} onClick={() => set(o.id, true)}>
                  2 life
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <p className="dw-shard-sum">
        {ctx.life !== undefined && (
          <>
            Life: <b className="num">{ctx.life} → {ctx.life - life}</b>.{" "}
          </>
        )}
        Mana still to pay: <b>{mana || "none"}</b>.
      </p>
    </div>
  );
}

/**
 * An extra cost (GCosts): kicker as two rows with what the spell costs either way, another
 * optional cost as pay or don't, or an activation's alternative costs. The card is shown whole.
 */
export function CostRows({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const s = p.source;
  const image = s?.image ?? (s ? ctx.meta[s.name]?.image ?? null : null);
  return (
    <div className={`dw-costs${compact ? " compact" : ""}`}>
      <div className="dw-head image">
        {image && s && !compact && <ReadImg src={image} name={s.name} onRead={() => ctx.onRead(s.name, s.id)} />}
        <span className="dw-head-text">
          {s && <span className="dw-source-line">{sourceLine(p, ctx)}</span>}
          <h2>{p.prompt}</h2>
          {!compact && p.oracle && <span className="dw-oracle">{p.oracle}</span>}
        </span>
      </div>
      <div className={`dw-cost-list${p.options.length === 2 ? " two" : ""}`} role="radiogroup" aria-label={p.prompt}>
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`dw-cost${on ? " picked" : o.eligible ? " pick" : ""}`}
              disabled={disabled || !o.eligible}
              onClick={() => onDraft(togglePick(p, draft, o.id))}
            >
              <b>{o.name}</b>
              {o.cost && <b className="dw-cost-mana">{o.cost}</b>}
              {!o.eligible && <span className="dw-note">Can't be paid now.</span>}
            </button>
          );
        })}
      </div>
      {p.purpose === "kicker" && p.options[0]?.name === "Kick again" && <p className="dw-note">A multikicker card asks again after each kick.</p>}
      {image && !compact && <p className="dw-foot">{IMAGES}</p>}
    </div>
  );
}

// ── ways to cast (GCastWays) ───────────────────────────────────────────────

/**
 * A card the engine offers to cast: what cascade, discover or ripple went through and the card it
 * found (exiled cards are face up, so everyone sees them; a ripple's are revealed), or a card with
 * madness or miracle, whole. The rail's buttons cast it or don't.
 */
export function CastOfferCard({ p, ctx, compact }: Props) {
  const img = (o: DecisionOption) => o.img ?? ctx.meta[o.name]?.image ?? null;
  // A reveal-until's find is shown the same way, after the cards it went past (GLibrary).
  const run = ["cascade", "discover", "ripple", "kept"].includes(p.purpose);
  const hit = p.options[p.options.length - 1];
  const misses = run ? p.options.slice(0, -1) : [];
  const read = (o: DecisionOption) => () => ctx.onRead(o.name, Number(o.id));
  return (
    <div className={`dw-offer${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} compact={compact} />
      {hit && run && (
        <section className="dw-run" aria-label="The cards it went through">
          <span className="dw-note">{p.purpose === "ripple" || p.purpose === "kept" ? "Revealed from the top of your library, in order" : "Exiled from the top of your library, in order"}</span>
          <div className="dw-run-cards">
            {misses.map((o) => (
              <figure key={o.id} className="dw-run-miss">
                <ReadImg src={img(o)} name={o.name} onRead={read(o)} />
              </figure>
            ))}
            {misses.length > 0 && <span className="dw-run-arrow" aria-hidden="true">→</span>}
            <figure className="dw-run-hit">
              <ReadImg src={img(hit)} name={hit.name} onRead={read(hit)} />
              <figcaption>{hit.name}</figcaption>
            </figure>
          </div>
        </section>
      )}
      {hit && !run && (
        <figure className="dw-offer-card">
          <ReadImg src={img(hit)} name={hit.name} onRead={read(hit)} />
        </figure>
      )}
      {isCastOffer(p) && !castable(p) && <Warn text="There isn't the mana to cast it now." />}
      <p className="dw-foot">{compact ? "Long-press a card to read it. " : "Right-click a card to read it. "}{IMAGES}</p>
    </div>
  );
}

/**
 * How a card is cast: an adventurer card's creature or adventure, a modal card's two spell faces,
 * the mana cost or a keyword's cost, one of several ways from the same zone, or a mutating
 * creature over or under. Each is a tile with its card, cost and words: the face's own Oracle
 * text where it has one (Yama's card data), else the engine's name and cost.
 */
export function FaceChoice({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const meta = p.source ? ctx.meta[p.source.name] : undefined;
  const halves = p.answer === "choose_adventure_face" || p.answer === "choose_modal_face";
  const mutate = p.answer === "choose_mutate_side";
  const face = (name: string) => meta?.faces?.find((f) => f.name === name);
  const img = (o: DecisionOption) => {
    if (p.answer === "choose_modal_face" && o.id === "back") return meta?.back_image ?? meta?.image ?? null;
    if (mutate) return o.img ?? ctx.meta[o.name]?.image ?? null;
    return meta?.image ?? o.img ?? null;
  };
  const title = (o: DecisionOption) => (!mutate ? o.name : o.id === "top" ? `On top: ${o.name}` : `Underneath: ${o.name} stays on top`);
  const line = (o: DecisionOption) => {
    if (mutate) return o.power !== undefined && o.toughness !== undefined ? `${o.power}/${o.toughness}` : "";
    return [o.cost, halves ? face(o.name)?.type_line : null].filter(Boolean).join(". ");
  };
  // Each half has its own words; the head keeps the whole card's for a cost or a way to cast.
  const head = halves ? { ...p, oracle: undefined } : p;
  return (
    <div className={`dw-faces${compact ? " compact" : ""}`}>
      <Head p={head} ctx={ctx} compact={compact} />
      <div className="dw-face-list" role="radiogroup" aria-label={p.prompt}>
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          const text = halves ? face(o.name)?.oracle_text : null;
          return (
            <ReadButton
              key={o.id}
              className={`dw-face${on ? " picked" : o.eligible ? " pick" : ""}`}
              label={`${title(o)}${on ? ", chosen" : ""}`}
              disabled={disabled || !o.eligible}
              onClick={() => onDraft(togglePick(p, draft, o.id))}
              onRead={() => ctx.onRead(mutate ? o.name : p.source?.name ?? o.name, mutate ? undefined : p.source?.id)}
            >
              {img(o) ? <img src={img(o)!} alt="" draggable={false} /> : <span className="dw-card-name">{o.name}</span>}
              <span className="dw-face-text">
                <b>{title(o)}</b>
                {line(o) && <span className="dw-face-cost">{line(o)}</span>}
                {text && <span>{text}</span>}
                {!o.eligible && <span className="dw-note">Can't be cast now.</span>}
              </span>
            </ReadButton>
          );
        })}
      </div>
      <p className="dw-foot">{compact ? "Long-press a card to read it. " : "Right-click a card to read it. "}{IMAGES}</p>
    </div>
  );
}

// ── permanents and proliferate on a phone (GPermanentsPhone, GCountersPhone) ──

/** One permanent as a tile: its art, an amber ring until picked, then white with its number, and the line under it. */
function PickTile({ o, at, tag, art, tone, disabled, onPick, onRead }: { o: DecisionOption; at: number; tag: { text: string; tone: string } | null; art: string | null; tone?: string; disabled: boolean; onPick: () => void; onRead: () => void }) {
  const { handlers, consumed } = useRead(onRead);
  return (
    <button
      type="button"
      className={`dw-tile${at >= 0 ? " picked" : o.eligible ? " pick" : ""}`}
      aria-pressed={at >= 0}
      aria-label={`${o.name}${at >= 0 ? ", chosen" : o.eligible ? ", can be chosen" : ""}${tag ? `, ${tag.text}` : ""}`}
      disabled={disabled || !o.eligible}
      onClick={() => !consumed() && onPick()}
      style={seatDot(tone)}
      {...handlers}
    >
      <span className="dw-tile-art">{art && <img src={art} alt="" draggable={false} />}</span>
      <span className="dw-tile-name">
        {tone && <span className="seat-dot" aria-hidden="true" />}
        {o.name}
      </span>
      {at >= 0 && <span className="pick-badge num">{at + 1}</span>}
      {tag && <span className={`dw-tile-tag ${tag.tone}`}>{tag.text}</span>}
    </button>
  );
}

/**
 * Permanents picked on a phone: the legend to keep, what a clone copies, the Ring-bearer, a Jace
 * token and the rest as tiles in the dock's sheet; for proliferate, players with counters as rows
 * above them. Long-press reads a card; the dock's button confirms.
 */
export function TilePick({ p, draft, onDraft, ctx, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const players = p.options.filter((o) => o.zone === "player");
  const cards = p.options.filter((o) => o.zone !== "player");
  const art = (o: DecisionOption) => o.art ?? ctx.meta[o.name]?.art ?? null;
  const artists = [...new Set(cards.map((o) => (art(o) ? o.artist ?? ctx.meta[o.name]?.artist : null)).filter((a): a is string => !!a))];
  return (
    <div className="dw-tiles compact">
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact />
      {players.length > 0 && (
        <div className="dw-player-rows">
          {players.map((o) => {
            const at = draft.ids.indexOf(o.id);
            const tag = pickTag(p, draft, o.id);
            return (
              <button
                key={o.id}
                type="button"
                className={`dw-player-row${at >= 0 ? " picked" : o.eligible ? " pick" : ""}`}
                aria-pressed={at >= 0}
                disabled={disabled || !o.eligible}
                style={seatDot(o.controller !== undefined ? ctx.tone(o.controller) : undefined)}
                onClick={() => onDraft(togglePick(p, draft, o.id))}
              >
                <span className="seat-dot" aria-hidden="true" />
                <b>{o.name}</b>
                {tag && <span>{tag.text}</span>}
                {at >= 0 && <span className="pick-badge num">{at + 1}</span>}
              </button>
            );
          })}
        </div>
      )}
      <div className="dw-tile-grid">
        {cards.map((o) => (
          <PickTile
            key={o.id}
            o={o}
            at={draft.ids.indexOf(o.id)}
            tag={pickTag(p, draft, o.id, true)}
            art={art(o)}
            tone={o.controller !== undefined && ctx.who(o.controller) !== "you" ? ctx.tone(o.controller) : undefined}
            disabled={disabled}
            onPick={() => onDraft(togglePick(p, draft, o.id))}
            onRead={() => ctx.onRead(o.name, Number(o.id))}
          />
        ))}
      </div>
      <p className="dw-foot">{artists.length ? `Art: ${artists.join(", ")}, ${COPYRIGHT}. ` : ""}Long-press a card to read it.</p>
    </div>
  );
}

// ── everyone takes part (GTogether) ────────────────────────────────────────

/** "Art: A, B and C, © Wizards of the Coast", for a widget's art crops; empty when there are none. */
function artLine(artists: (string | null | undefined)[]): string {
  const names = [...new Set(artists.filter((a): a is string => !!a))];
  if (!names.length) return "";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Art: ${list}, ${COPYRIGHT}.`;
}

/** Seats in words for a line: "you", "Sam". */
const whoOf = (ctx: WidgetContext, n: number) => ctx.who(n);

/**
 * A vote (Council's Judgment): the options as art tiles in a grid, each with whose it is, the dots
 * of who voted for it and its count; beside them, the voting order and what leads so far. The
 * votes cast are public as they're cast (the engine scrubs a secret vote's).
 */
export function VotePanel({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const vote = ctx.together?.kind === "vote" ? ctx.together : null;
  const mine = draft.ids[0];
  // The votes so far, by the option's place, with yours (being chosen) added.
  const at = (id: string) => p.options.findIndex((o) => o.id === id);
  const ballots: [number, number][] = [...(vote?.ballots ?? [])];
  const me = vote?.voters.find((v) => v.state === "voting")?.seat;
  if (mine !== undefined && me !== undefined) ballots.push([me, at(mine)]);
  const tally = (i: number) => ballots.filter((b) => b[1] === i).length;
  const most = Math.max(0, ...p.options.map((_, i) => tally(i)));
  const lead = most > 0 ? p.options.filter((_, i) => tally(i) === most).map((o) => o.name) : [];
  const art = (o: DecisionOption) => o.art ?? ctx.meta[o.name]?.art ?? null;
  const cards = p.options.some((o) => o.zone);
  const credit = artLine(p.options.map((o) => (art(o) ? o.artist ?? ctx.meta[o.name]?.artist : null)));
  const stateOf = (seat: number, state: string) => {
    if (state === "voting") return seat === me && mine !== undefined ? `Your vote: ${p.options[at(mine)]?.name ?? ""}` : ctx.who(seat) === "you" ? "Voting now" : "Voting";
    if (state === "next") return "Votes later";
    const theirs = ballots.filter((b) => b[0] === seat).map((b) => p.options[b[1]]?.name).filter(Boolean);
    return vote?.secret || !theirs.length ? "Voted" : `Voted: ${theirs.join(", ")}`;
  };
  return (
    <div className={`dw-vote${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-vote-body">
        <div className={`dw-vote-grid${cards ? "" : " words"}`} role="radiogroup" aria-label={p.prompt}>
          {p.options.map((o, i) => {
            const on = mine === o.id;
            const n = tally(i);
            const voters = ballots.filter((b) => b[1] === i).map((b) => b[0]);
            const a = art(o);
            return (
              <ReadButton
                key={o.id}
                className={`dw-vote-opt${on ? " picked" : o.eligible ? " pick" : ""}`}
                label={`${o.name}, ${n} ${n === 1 ? "vote" : "votes"}${on ? ", your vote" : ""}`}
                disabled={disabled || !o.eligible}
                onClick={() => onDraft(togglePick(p, draft, o.id))}
                onRead={() => cards && ctx.onRead(o.name)}
              >
                <span className="dw-vote-art">
                  {a && <img src={a} alt="" draggable={false} />}
                  <span className="dw-vote-name">{o.name}</span>
                  {n > 0 && <span className="dw-vote-count num">{n}</span>}
                  {compact && voters.length > 0 && (
                    <span className="dw-voters">
                      {voters.map((v, k) => <span key={k} className="seat-dot" style={seatDot(ctx.tone(v))} title={ctx.who(v)} />)}
                    </span>
                  )}
                </span>
                {!compact && (
                  <span className="dw-vote-under">
                    {o.controller !== undefined && (
                      <span className="dw-vote-owner" style={seatDot(ctx.tone(o.controller))}>
                        <span className="seat-dot" aria-hidden="true" />
                        {ctx.whose(o.controller) === "Your" ? "Yours" : ctx.whose(o.controller)}
                      </span>
                    )}
                    <span className="dw-voters">
                      {voters.map((v, k) => <span key={k} className="seat-dot" style={seatDot(ctx.tone(v))} title={ctx.who(v)} />)}
                    </span>
                  </span>
                )}
              </ReadButton>
            );
          })}
        </div>
        {vote && (
          <div className="dw-ledger" aria-label="Voting order">
            {!compact && <b>Voting order</b>}
            {vote.voters.map((v) => (
              <span key={v.seat} className={`dw-ledger-row${v.state === "voting" ? " now" : ""}`} style={seatDot(ctx.tone(v.seat))}>
                <span className="seat-dot" aria-hidden="true" />
                <b>{ctx.who(v.seat) === "you" ? "You" : ctx.who(v.seat)}</b>
                <span>{stateOf(v.seat, v.state)}</span>
              </span>
            ))}
            {lead.length > 0 && !compact && (
              <span className="dw-note">
                Most votes so far: {lead.join(", ")} ({most} {lead.length > 1 ? "each" : most === 1 ? "vote" : "votes"}).
              </span>
            )}
            {vote.secret && <span className="dw-note">The votes are secret until everyone has voted.</span>}
          </div>
        )}
      </div>
      <p className="dw-foot">{credit ? `${credit} ` : ""}{cards ? (compact ? "Long-press a card to read it." : "Right-click a card to read it.") : ""}</p>
    </div>
  );
}

/**
 * Piles (Fact or Fiction): separating the cards, a click moving a card to the other pile; or
 * choosing one of the two piles someone else made.
 */
export function PilesPanel({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const choosing = p.purpose === "piles_choose";
  const { a, b } = piles(p, draft);
  const img = (o: DecisionOption) => o.img ?? ctx.meta[o.name]?.image ?? null;
  const chooser = ctx.together?.kind === "piles" ? ctx.together.chooser : undefined;
  const pile = (key: "a" | "b", cards: DecisionOption[]) => {
    const on = choosing && draft.ids[0] === key;
    const title = `Pile ${key.toUpperCase()}`;
    const count = `${cards.length} ${cards.length === 1 ? "card" : "cards"}`;
    const body = (
      <>
        <span className="dw-pile2-head">
          <b>{title}</b>
          <span>{count}</span>
        </span>
        <span className="dw-pile2-cards">
          {cards.map((o) =>
            choosing ? (
              <ReadImg key={o.id} src={img(o)} name={o.name} onRead={() => ctx.onRead(o.name, Number(o.id))} />
            ) : (
              <ReadButton
                key={o.id}
                className="dw-pile2-card pick"
                label={`${o.name}, in ${title}. Move it to the other pile`}
                disabled={disabled}
                onClick={() => onDraft(togglePick(p, draft, o.id))}
                onRead={() => ctx.onRead(o.name, Number(o.id))}
              >
                {img(o) ? <img src={img(o)!} alt="" draggable={false} /> : <span className="dw-card-name">{o.name}</span>}
              </ReadButton>
            ),
          )}
          {!cards.length && <span className="dw-note">Empty</span>}
        </span>
      </>
    );
    return choosing ? (
      <button key={key} type="button" role="radio" aria-checked={on} aria-label={`${title}, ${count}${on ? ", chosen" : ""}`} className={`dw-pile2${on ? " picked" : " pick"}`} disabled={disabled} onClick={() => onDraft(togglePick(p, draft, key))}>
        {body}
      </button>
    ) : (
      <div key={key} className="dw-pile2">
        {body}
      </div>
    );
  };
  return (
    <div className={`dw-piles2${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-pile2-list" role={choosing ? "radiogroup" : undefined} aria-label={choosing ? "Piles" : undefined}>
        {pile("a", a)}
        {pile("b", b)}
      </div>
      <p className="dw-foot">
        {choosing
          ? "Choose a pile; the Oracle text says where each goes. "
          : `${compact ? "Tap" : "Click"} a card to move it to the other pile. A pile may be empty.${chooser !== undefined ? ` ${whoOf(ctx, chooser) === "you" ? "You" : whoOf(ctx, chooser)} then ${whoOf(ctx, chooser) === "you" ? "choose" : "chooses"} one pile.` : ""} `}
        {IMAGES}
      </p>
    </div>
  );
}

/**
 * The engine's own words as choices (a villainous choice's branches, a guess, ways to share out
 * life totals); for a villainous choice, who else faces it and who has chosen.
 */
export function WordPick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const branch = ctx.together?.kind === "branch" ? ctx.together : null;
  const others = branch?.facing.filter(([seat]) => ctx.who(seat) !== "you") ?? [];
  const stateText = { chose: "Chose", choosing: "Choosing", waiting: "Waiting" } as const;
  return (
    <div className={`dw-words${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-mode-list" role="radiogroup" aria-label={p.prompt}>
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`dw-mode${on ? " picked" : o.eligible ? " pick" : ""}`}
              disabled={disabled || !o.eligible}
              onClick={() => onDraft(togglePick(p, draft, o.id))}
            >
              <span className="dw-mark-box" aria-hidden="true" />
              <span className="dw-mode-text">{o.name}</span>
            </button>
          );
        })}
      </div>
      {others.length > 0 && (
        <div className="dw-facing">
          <b>Who else faces it</b>
          <span className="dw-facing-row">
            {others.map(([seat, state]) => (
              <span key={seat} className="dw-chip-seat" style={seatDot(ctx.tone(seat))}>
                <span className="seat-dot" aria-hidden="true" />
                <b>{ctx.who(seat)}</b>
                <span>{stateText[state]}</span>
              </span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Coins and dice kept or ignored (Krark's Thumb, a d20 rolled twice): each result as a coin or a
 * die face, amber where it may be chosen, white once chosen. Only the rolls the engine allows may
 * be ignored.
 */
export function LuckPick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const coin = p.purpose === "coin";
  return (
    <div className={`dw-luck${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-luck-list" role={p.max === 1 ? "radiogroup" : "group"} aria-label={p.prompt}>
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          const face = coin ? o.name.slice(0, 1) : o.name;
          const state = on ? (coin ? "Kept" : "Ignored") : o.eligible ? (coin ? "Keep this one" : "Ignore this one") : "Can't be ignored";
          return (
            <button
              key={o.id}
              type="button"
              role={p.max === 1 ? "radio" : "checkbox"}
              aria-checked={on}
              aria-label={`${coin ? o.name : `Roll ${o.name}`}, ${state}`}
              className={`dw-luck-opt${on ? " picked" : o.eligible ? " pick" : ""}`}
              disabled={disabled || !o.eligible}
              onClick={() => onDraft(togglePick(p, draft, o.id))}
            >
              <span className={`dw-luck-face num${coin ? " coin" : " die"}`} aria-hidden="true">{face}</span>
              <b>{coin ? o.name : `Rolled ${o.name}`}</b>
              <span className="dw-note">{state}</span>
            </button>
          );
        })}
      </div>
      <p className="dw-foot">{coin ? `${p.options.length} coins were flipped for one flip. Heads is a win.` : "Only the rolls the engine allows can be ignored."}</p>
    </div>
  );
}

// ── choosing a player (GRareRules) ─────────────────────────────────────────

/** The seat picker: each player on their commander's art, with their life and the art's credit. */
export function SeatPicker({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  return (
    <div className={`dw-seats${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-seat-list" role="radiogroup" aria-label="Players">
        {p.options.map((o) => {
          const seat = o.controller ?? Number(o.id.slice(1));
          const info = ctx.seat?.(seat);
          const on = draft.ids.includes(o.id);
          const name = ctx.who(seat) === "you" ? "You" : ctx.who(seat);
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${name}${info?.life !== null && info?.life !== undefined ? `, ${info.life} life` : ""}${on ? ", chosen" : ""}`}
              className={`dw-seat${on ? " picked" : o.eligible ? " pick" : ""}`}
              style={seatDot(ctx.tone(seat))}
              disabled={disabled || !o.eligible}
              onClick={() => onDraft(togglePick(p, draft, o.id))}
            >
              {info?.art && <img className="dw-seat-art" src={info.art} alt="" draggable={false} />}
              <span className="dw-seat-wash" aria-hidden="true" />
              <span className="dw-seat-text">
                <b>
                  <span className="seat-dot" aria-hidden="true" />
                  {name}
                </b>
                {info?.art && <span className="dw-credit">Art: {info.artist ?? "unknown"}, {COPYRIGHT}</span>}
              </span>
              {info?.life !== null && info?.life !== undefined && <b className="dw-seat-life num">{info.life}</b>}
              {on && <span className="dw-seat-tag">Chosen</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── the library (GLibrary) ─────────────────────────────────────────────────

/**
 * Top or bottom of a library: the card (and, in a clash, everyone's revealed card) beside two
 * choices, with how many cards the library holds.
 */
export function TopOrBottomPick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const shown = p.shown ?? [];
  const card = shown[0];
  const clash = p.purpose === "clash";
  const owner = clash ? undefined : card?.controller;
  const whose = owner === undefined || ctx.who(owner) === "you" ? "your" : `${ctx.who(owner)}'s`;
  const size = owner !== undefined ? ctx.library?.(owner) : undefined;
  const img = (o: DecisionOption) => o.img ?? ctx.meta[o.name]?.image ?? null;
  const notes = { top: size !== undefined ? `On top of the other ${size} cards.` : "", bottom: size !== undefined ? `Under the other ${size} cards.` : "" } as Record<string, string>;
  return (
    <div className={`dw-tob${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-tob-body">
        <div className="dw-tob-cards">
          {shown.map((o, i) => (
            <figure key={o.id} className={i === 0 ? "mine" : ""}>
              <ReadImg src={img(o)} name={o.name} onRead={() => ctx.onRead(o.name)} />
              {clash && o.controller !== undefined && (
                <figcaption style={seatDot(ctx.tone(o.controller))}>
                  <span className="seat-dot" aria-hidden="true" />
                  {i === 0 ? "Yours" : `${ctx.whose(o.controller)}`}
                </figcaption>
              )}
            </figure>
          ))}
        </div>
        <div className="dw-tob-list" role="radiogroup" aria-label="Where it goes">
          {p.options.map((o) => {
            const on = draft.ids.includes(o.id);
            return (
              <button key={o.id} type="button" role="radio" aria-checked={on} className={`dw-tob-opt ${o.id}${on ? " picked" : " pick"}`} disabled={disabled} onClick={() => onDraft(togglePick(p, draft, o.id))}>
                <span className="dw-tob-mark" aria-hidden="true">
                  <span />
                </span>
                <span className="dw-tob-text">
                  <b>{o.name} of {whose} library</b>
                  {notes[o.id] && <span>{notes[o.id]}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {clash && <p className="dw-foot">Each clashing player puts their card on the top or bottom, in turn order. {IMAGES}</p>}
    </div>
  );
}

/**
 * Cards split between two places (the Cultivate split, manifest dread): the picked ones in the
 * first place, the rest in the second. A click moves a card; with one of two to place, it swaps.
 */
export function PlacesPick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick" || !p.places) return null;
  const [first, second] = p.places as [string, string];
  const img = (o: DecisionOption) => o.img ?? ctx.meta[o.name]?.image ?? null;
  const tapped = /tapped/.test(first);
  const zone = (label: string, cards: DecisionOption[], picked: boolean) => (
    <div className={`dw-place${picked ? " first" : ""}`}>
      <span className="dw-pile2-head">
        <b>{label}</b>
        <span>{cards.length} {cards.length === 1 ? "card" : "cards"}</span>
      </span>
      <span className="dw-place-cards">
        {cards.map((o) => (
          <ReadButton
            key={o.id}
            className={`dw-place-card${picked ? " picked" : " pick"}${picked && tapped ? " tapped" : ""}`}
            label={`${o.name}: ${label}. ${picked ? "Picked" : "Move it here instead"}`}
            disabled={disabled}
            onClick={() => onDraft(togglePick(p, draft, o.id))}
            onRead={() => ctx.onRead(o.name, Number(o.id))}
          >
            {img(o) ? <img src={img(o)!} alt="" draggable={false} /> : <span className="dw-card-name">{o.name}</span>}
          </ReadButton>
        ))}
      </span>
    </div>
  );
  return (
    <div className={`dw-places${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <div className="dw-place-list">
        {zone(first, p.options.filter((o) => draft.ids.includes(o.id)), true)}
        {zone(second, p.options.filter((o) => !draft.ids.includes(o.id)), false)}
      </div>
      <p className="dw-foot">{compact ? "Tap" : "Click"} a card to move it. {IMAGES}</p>
    </div>
  );
}

// ── the rarer cards and rules (GRareCards, GRareRules) ─────────────────────

/** A face-down 2/2 (CR 708.2a): no name, no art; its controller sees what it is. */
function FaceDownTile({ name, pt = "2/2" }: { name: string; pt?: string }) {
  return (
    <span className="fd-tile" aria-label={`Face down, ${name}`}>
      <span className="fd-head">Face down</span>
      <b className="fd-name">{name}</b>
      {pt && <span className="fd-pt num">{pt}</span>}
    </span>
  );
}

/** "Sam", "Sam and Jules", "Computer, Sam and Jules". */
function namesList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "everyone else";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * A morph cast face down (GRareCards): the card, then what you'll see of it next to what everyone
 * else will (a 2/2 with no name). The main button casts it face down for {3}, the second face up.
 */
export function FaceDownCast({ p, ctx, compact }: Props) {
  const name = p.source?.name ?? "It";
  const others = (ctx.others ?? []).map((n) => ctx.who(n));
  const image = p.source ? ctx.meta[p.source.name]?.image ?? p.source.image : null;
  return (
    <div className={`dw-fd${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} compact={compact} />
      <div className="dw-fd-body">
        {!compact && image && <ReadImg src={image} name={name} onRead={() => p.source && ctx.onRead(p.source.name, p.source.id)} />}
        <div className="dw-fd-views">
          <div className="dw-fd-view">
            <b>What you see</b>
            <span className="dw-fd-row">
              <FaceDownTile name={name} />
              <span className="dw-note">Cast for {p.options.find((o) => o.id === "alternative")?.cost ?? "{3}"}, it enters as a 2/2 with no name that only you can read.</span>
            </span>
          </div>
          <div className="dw-fd-view">
            <b>What {namesList(others)} {others.length === 1 ? "sees" : "see"}</b>
            <span className="dw-fd-row">
              <FaceDownTile name="No name" />
              <span className="dw-note">A 2/2 creature with no name, no text and no colour, until it's turned face up or leaves.</span>
            </span>
          </div>
        </div>
      </div>
      <p className="dw-foot">{compact ? "Long-press the card to read it. " : "Right-click the card to read it. "}{IMAGES}</p>
    </div>
  );
}

/** Revealing a companion before the game (GRareCards): the card, picked to reveal; everyone sees it. */
export function CompanionPanel({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  return (
    <div className={`dw-companion${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} compact={compact} />
      <div className="dw-cards">
        {p.options.map((o) => (
          <CardPick
            key={o.id}
            o={o}
            img={o.img ?? ctx.meta[o.name]?.image ?? null}
            at={draft.ids.indexOf(o.id)}
            label="Reveal"
            disabled={disabled}
            onPick={() => onDraft(togglePick(p, draft, o.id))}
            onRead={() => ctx.onRead(o.name)}
          />
        ))}
      </div>
      <p className="dw-note">The engine offers only a companion whose condition your deck meets. Everyone sees the revealed companion for the whole game; you may pay {"{3}"} to put it into your hand once, when you could cast a sorcery.</p>
      <p className="dw-foot">{compact ? "Long-press the card to read it. " : "Right-click the card to read it. "}{IMAGES}</p>
    </div>
  );
}

/** Meld (GRareCards): each pair the engine lists, the two cards and what they become. */
export function MeldPanel({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  const img = (o: DecisionOption) => o.img ?? ctx.meta[o.name]?.image ?? null;
  return (
    <div className={`dw-meld${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} compact={compact} />
      <div className="dw-meld-list" role="radiogroup" aria-label={p.prompt}>
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          const parts = (p.shown ?? []).filter((c) => c.group === o.id);
          const [a, b, result] = parts;
          return (
            <button key={o.id} type="button" role="radio" aria-checked={on} aria-label={`${o.name}, into ${o.text ?? ""}`} className={`dw-meld-row${on ? " picked" : " pick"}`} disabled={disabled} onClick={() => onDraft(togglePick(p, draft, o.id))}>
              {a && <ReadImg src={img(a)} name={a.name} onRead={() => ctx.onRead(a.name, Number(a.id))} />}
              <b className="dw-meld-op" aria-hidden="true">+</b>
              {b && <ReadImg src={img(b)} name={b.name} onRead={() => ctx.onRead(b.name, Number(b.id))} />}
              <b className="dw-meld-op" aria-hidden="true">→</b>
              {result && <ReadImg src={img(result)} name={result.name} onRead={() => ctx.onRead(result.name)} />}
              <span className="dw-meld-text">
                <b>{o.text}</b>
                <span>{o.name}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="dw-foot">{IMAGES}</p>
    </div>
  );
}

const DUNGEON_CREDIT = "Dungeon card images from Scryfall, © Wizards of the Coast.";

/** Choosing a dungeon to venture into (GRareRules): each dungeon card with its first room. */
export function DungeonPick({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "pick") return null;
  return (
    <div className={`dw-dungeons${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} compact={compact} />
      <div className="dw-dungeon-list" role="radiogroup" aria-label="Dungeons">
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          const [room, ...text] = (o.text ?? "").split(": ");
          return (
            <button key={o.id} type="button" role="radio" aria-checked={on} className={`dw-dungeon${on ? " picked" : " pick"}`} disabled={disabled} onClick={() => onDraft(togglePick(p, draft, o.id))}>
              {o.img && <img src={o.img} alt={o.name} draggable={false} />}
              <b>{o.name}</b>
              {room && (
                <span className="dw-note">
                  First room: <b>{room}</b>. {text.join(": ")}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="dw-foot">{DUNGEON_CREDIT}</p>
    </div>
  );
}

/**
 * The next room (GRareRules): the dungeon's rooms laid out as they're drawn on its card, the room
 * your marker is on in your colour, the rooms it leads to amber, the one picked white.
 */
export function DungeonRooms({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  const map = p.dungeons?.[0];
  if (draft.kind !== "pick" || !map) return null;
  // A phone has no room for the map: the card, the room you're in, and the rooms you can go to.
  if (compact) return <DungeonRoomList p={p} draft={draft} onDraft={onDraft} ctx={ctx} compact disabled={disabled} />;
  const width = compact ? 320 : 620;
  const height = compact ? 360 : 470;
  const boxW = compact ? 130 : 186;
  const boxH = compact ? 70 : 88;
  const next = reachable(map);
  const pick = draft.ids[0];
  const at = (i: number) => {
    const s = roomSpot(map, i, width - boxW, height - boxH);
    return { left: s.x, top: s.y };
  };
  const edges = map.rooms.flatMap((r) =>
    r.next.map((n) => {
      const a = at(r.index);
      const b = at(n);
      const live = r.index === map.current;
      const tone = live ? (String(n) === pick ? "on" : "can") : "off";
      return { key: `${r.index}-${n}`, x1: a.left + boxW / 2, y1: a.top + boxH, x2: b.left + boxW / 2, y2: b.top, tone };
    }),
  );
  return (
    <div className={`dw-rooms${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={map.current !== undefined ? `Room ${map.current + 1} of ${map.rooms.length}` : undefined} compact={compact} />
      <div className="dw-rooms-body">
        {!compact && (
          <span className="dw-rooms-card">
            <img src={map.image} alt={map.name} draggable={false} />
            <span className="dw-credit">{DUNGEON_CREDIT}</span>
          </span>
        )}
        <div className="dw-room-map" style={{ width, height }}>
          <svg aria-hidden="true" width={width} height={height}>
            {edges.map((e) => (
              <line key={e.key} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} className={`dw-room-edge ${e.tone}`} />
            ))}
          </svg>
          {map.rooms.map((r) => {
            const here = r.index === map.current;
            const can = next.has(r.index);
            const on = String(r.index) === pick;
            const tag = here ? "You are here" : on ? "Next" : can ? "Can go" : "";
            return (
              <button
                key={r.index}
                type="button"
                className={`dw-room${here ? " here" : ""}${on ? " picked" : can ? " pick" : ""}`}
                style={{ ...at(r.index), width: boxW, minHeight: boxH, ...seatDot(here ? "seat-1" : undefined) }}
                aria-pressed={on}
                aria-label={`${r.name}${here ? ", you are here" : can ? ", can be chosen" : ""}`}
                disabled={disabled || !can}
                onClick={() => onDraft(togglePick(p, draft, String(r.index)))}
              >
                <span className="dw-room-head">
                  <b>{r.name}</b>
                  {tag && <span className="dw-room-tag">{tag}</span>}
                </span>
                <span className="dw-room-text">{r.text}</span>
              </button>
            );
          })}
        </div>
      </div>
      {compact && <p className="dw-foot">{DUNGEON_CREDIT}</p>}
    </div>
  );
}

/** The next room on a phone (GRareRules): the dungeon card, then the room you're in and the rooms it leads to. */
function DungeonRoomList({ p, draft, onDraft, ctx, disabled }: Props) {
  const map = p.dungeons?.[0];
  if (draft.kind !== "pick" || !map) return null;
  const here = map.rooms.find((r) => r.index === map.current);
  return (
    <div className="dw-rooms compact">
      <Head p={p} ctx={ctx} count={map.current !== undefined ? `Room ${map.current + 1} of ${map.rooms.length}` : undefined} compact />
      <img className="dw-rooms-thumb" src={map.image} alt={map.name} draggable={false} />
      {here && (
        <span className="dw-room-row here" style={seatDot("seat-1")}>
          <span className="dw-room-head">
            <b>{here.name}</b>
            <span className="dw-room-tag">You are here</span>
          </span>
          <span className="dw-room-text">{here.text}</span>
        </span>
      )}
      <div className="dw-room-rows" role="radiogroup" aria-label="Rooms you can go to">
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          return (
            <button key={o.id} type="button" role="radio" aria-checked={on} className={`dw-room-row${on ? " picked" : " pick"}`} disabled={disabled} onClick={() => onDraft(togglePick(p, draft, o.id))}>
              <span className="dw-room-head">
                <b>{o.name}</b>
                <span className="dw-room-tag">{on ? "Next" : "Can go"}</span>
              </span>
              <span className="dw-room-text">{o.text}</span>
            </button>
          );
        })}
      </div>
      <p className="dw-foot">{DUNGEON_CREDIT}</p>
    </div>
  );
}

const TIME_WORDS: Record<TimeMove, string> = { remove: "Remove one", leave: "Leave", add: "Add one" };

/**
 * Time travel (GRareRules): each suspended card and each permanent with time counters, with
 * remove one, leave or add one. The engine asks in two steps; Yama sends both at once.
 */
export function TimeTravelRows({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  if (draft.kind !== "time") return null;
  const choices = timeChoices(p.step);
  const img = (o: DecisionOption) => o.img ?? ctx.meta[o.name]?.image ?? null;
  return (
    <div className={`dw-time${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} count={counter(p, draft)} compact={compact} />
      <p className="dw-note">
        {p.step === "add"
          ? "The time counters to remove are settled: you may add one to each of these."
          : "For each, you may remove a time counter or add one. Yama sends the engine the removals first, then the additions."}
      </p>
      <div className="dw-time-list">
        {p.options
          .filter((o) => o.eligible)
          .map((o) => {
            const move = draft.moves[o.id] ?? "leave";
            const now = timeCounters(o.counters);
            return (
              <div key={o.id} className="dw-time-row">
                <ReadImg src={img(o)} name={o.name} onRead={() => ctx.onRead(o.name, Number(o.id))} />
                <span className="dw-time-text">
                  <b>{o.name}</b>
                  <span className="dw-note">{o.zone === "exile" ? "Suspended, in exile" : "On the battlefield"}</span>
                  <span>
                    Time counters: <b className="num">{now}</b> → <b className="num">{timeAfter(now, move)}</b>
                  </span>
                </span>
                <span className="dw-seg" role="radiogroup" aria-label={o.name}>
                  {choices.map((c) => (
                    <button key={c} type="button" role="radio" aria-checked={move === c} className={move === c ? "on" : "pick"} disabled={disabled || (c === "remove" && now === 0)} onClick={() => onDraft({ kind: "time", moves: { ...draft.moves, [o.id]: c } })}>
                      {TIME_WORDS[c]}
                    </button>
                  ))}
                </span>
              </div>
            );
          })}
      </div>
      <p className="dw-foot">{IMAGES}</p>
    </div>
  );
}

/**
 * Loop shortcuts (GRareRules): proposing the loop the engine found with one of its counts, or
 * answering someone's proposal by accepting it or stopping it early; the pre-cast shortcut's
 * stopping places are the engine's own. Who has answered shows below.
 */
export function ShortcutPanel({ p, draft, onDraft, ctx, compact, disabled }: Props) {
  const s = p.shortcut;
  const image = p.source ? ctx.meta[p.source.name]?.image ?? p.source.image ?? null : null;
  const word = { answered: "Answered", deciding: "Deciding", next: "Next" } as const;
  const people = s?.responders.length ? (
    <span className="dw-facing-row">
      {s.responders.map(([seat, state]) => (
        <span key={seat} className="dw-chip-seat" style={seatDot(ctx.tone(seat))}>
          <span className="seat-dot" aria-hidden="true" />
          <b>{ctx.who(seat) === "you" ? "You" : ctx.who(seat)}</b>
          <span>{word[state]}</span>
        </span>
      ))}
    </span>
  ) : null;
  const loop = s && (
    <div className="dw-loop-found">
      {image && <ReadImg src={image} name={p.source?.name ?? ""} onRead={() => p.source && ctx.onRead(p.source.name)} />}
      <span className="dw-loop-text">
        {s.grows?.length ? (
          <span>
            Grows without limit: <b>{s.grows.join(", ")}</b>
          </span>
        ) : null}
        {s.wins && <span>{s.wins}{s.winner !== undefined ? `: ${ctx.who(s.winner) === "you" ? "you win" : `${ctx.who(s.winner)} wins`}` : ""}.</span>}
      </span>
    </div>
  );
  if (p.purpose === "shortcut_response" && draft.kind === "number") {
    const value = draft.value;
    const shown = value ?? s?.count;
    return (
      <div className={`dw-shortcut${compact ? " compact" : ""}`}>
        <Head p={p} ctx={ctx} compact={compact} />
        {loop}
        <div className="dw-loop-stop">
          <span>Or stop it early, after</span>
          <span className="dw-stepper">
            <button type="button" aria-label="Fewer" disabled={disabled || (value !== null && value <= p.min)} onClick={() => onDraft({ kind: "number", value: stepStop(value, -1, p.min, p.max) })}>−</button>
            <output className="num" aria-live="polite">{shown ?? "All"}</output>
            <button type="button" aria-label="More" disabled={disabled || value === null} onClick={() => onDraft({ kind: "number", value: stepStop(value, 1, p.min, p.max) })}>+</button>
          </span>
          <span>times, and take priority there.</span>
        </div>
        {people}
        <p className="dw-foot">Accepting lets it run {shortcutCount(s?.count)}. Shortening it names the place you'll make a different choice.</p>
      </div>
    );
  }
  if (draft.kind !== "pick") return null;
  return (
    <div className={`dw-shortcut${compact ? " compact" : ""}`}>
      <Head p={p} ctx={ctx} compact={compact} />
      {loop}
      {p.purpose === "shortcut" && <b className="dw-loop-ask">Repeat how many times?</b>}
      <div className="dw-mode-list" role="radiogroup" aria-label={p.prompt}>
        {p.options.map((o) => {
          const on = draft.ids.includes(o.id);
          return (
            <button key={o.id} type="button" role="radio" aria-checked={on} className={`dw-mode${on ? " picked" : o.eligible ? " pick" : ""}`} disabled={disabled || !o.eligible} onClick={() => onDraft(togglePick(p, draft, o.id))}>
              <span className="dw-mark-box" aria-hidden="true" />
              <span className="dw-mode-text">{o.name}</span>
            </button>
          );
        })}
      </div>
      {people}
      {p.purpose === "shortcut" && <p className="dw-foot">The engine pins each repeated choice to what you just did. Every other player then accepts or shortens it, in turn order.</p>}
    </div>
  );
}

// ── the rail and the banner ────────────────────────────────────────────────

/** The status pill over the battlefield while you pick on the board or split onto targets. */
export function PickBanner({ p, draft }: { p: Pending; draft: Draft }) {
  const count = counter(p, draft);
  return (
    <div className="dw-banner" role="status">
      {p.source?.art && <img src={p.source.art} alt="" />}
      <span>{p.prompt}</span>
      {count && <span className="dw-banner-count">{count}</span>}
    </div>
  );
}

/**
 * The rail's body (laptop) for a decision these widgets answer: the source card with its art
 * credit, and what the stage over the table doesn't already say.
 */
export function DecisionRail({ p, draft, ctx, stage, disabled, onReset, onDraft }: {
  p: Pending;
  draft: Draft;
  ctx: WidgetContext;
  stage: Stage;
  disabled: boolean;
  onReset: () => void;
  onDraft?: (d: Draft) => void;
}) {
  const s = p.source;
  const { handlers, consumed } = useRead(() => s && ctx.onRead(s.name, s.id));
  const rest = draft.kind === "split" ? left(p, draft) : 0;
  const names = draft.kind === "pick" ? draft.ids.map((id) => p.options.find((o) => o.id === id)?.name ?? "a card") : [];
  return (
    <div className="chooser">
      {s && (
        <button type="button" className="chooser-source" onClick={() => !consumed() && ctx.onRead(s.name, s.id)} {...handlers}>
          {s.art ? <img src={s.art} alt="" /> : <span className="row-blank" />}
          <span className="row-text">
            <b>{s.name}</b>
            <span>{s.artist ? `Art: ${s.artist}` : ctx.whose(s.controller)}</span>
          </span>
        </button>
      )}
      {stage === "strip" && <p className="rail-help">Answer with the buttons below.</p>}
      {p.warn && <Warn text={p.warn} />}
      {/* The Treasure prompt (GPay): paying automatically needs a source that's sacrificed. */}
      {p.answer === "tap_mana" && (
        <p className="rail-help">
          Paying automatically needs {p.options.length === 1 ? "it" : "one of these"}, and your setting asks before sacrificing anything. Keep {p.options.length === 1 ? "it" : "them"} to pay by hand instead.
        </p>
      )}
      {stage === "board" && p.answer !== "tap_mana" && (
        <>
          {p.oracle && <p className="chooser-oracle">{p.oracle}</p>}
          <p className="chooser-count" aria-live="polite">{counter(p, draft)}</p>
          <p className="rail-help">
            {p.answer === "choose_pair"
              ? "Click the creature to pair it with."
              : isTargeting(p)
                ? "Click a card or player with an amber ring. Esc takes the pick back."
                : isTapping(p)
                  ? "Click the creatures to tap."
                  : p.purpose === "proliferate"
                    ? "Click the permanents and players with an amber ring. Click again to unpick."
                    : p.purpose === "ninjutsu"
                      ? "Click an unblocked attacker with an amber ring. Esc or Cancel backs out."
                      : p.purpose === "cipher"
                        ? "Click the creature to encode it on, or don't encode it."
                        : p.purpose === "entry_attack"
                          ? "Click the player or permanent it attacks."
                          : "Click the cards with an amber ring."}
            {names.length > 0 && ` Chosen: ${names.join(", ")}.`}
          </p>
          {/* Every choice as a list too, for anything hard to reach on the board. */}
          {draft.kind === "pick" && onDraft && (isTargeting(p) || isTapping(p)) && (
            <details className="chooser-list">
              <summary>All {p.options.filter((o) => o.eligible).length} choices as a list</summary>
              <ul>
                {p.options
                  .filter((o) => o.eligible)
                  .map((o) => {
                    const at = draft.ids.indexOf(o.id);
                    return (
                      <li key={o.id}>
                        <button type="button" className={`chooser-row${at >= 0 ? " picked" : ""}`} aria-pressed={at >= 0} disabled={disabled} onClick={() => onDraft(togglePick(p, draft, o.id))}>
                          {o.art ? <img src={o.art} alt="" /> : <span className="row-blank" />}
                          <span>
                            {o.name}
                            {o.zone === "player" || o.controller === undefined ? "" : `, ${ctx.whose(o.controller) === "Your" ? "yours" : ctx.whose(o.controller)}`}
                            {o.id === p.current ? ", its target now" : ""}
                          </span>
                        </button>
                      </li>
                    );
                  })}
              </ul>
            </details>
          )}
        </>
      )}
      {stage === "steppers" && p.unit === "counters" && (
        <>
          <p className="dw-rail-left">
            <b className={`num${!p.upTo && rest === 0 ? " done" : ""}`}>{p.upTo ? (p.total ?? 0) - rest : rest}</b>
            <span>{p.upTo ? `of ${p.total ?? 0}` : "left to remove"}</span>
          </p>
          {p.oracle && <p className="chooser-oracle">{p.oracle}</p>}
          <p className="rail-help">{p.upTo ? "Any number, none included: set them with the steppers on the board." : "Set them with the steppers on the board."}</p>
        </>
      )}
      {stage === "steppers" && p.unit !== "counters" && (
        <>
          <p className="dw-rail-left">
            <b className={`num${rest === 0 ? " done" : ""}`}>{rest}</b>
            <span>of {p.total ?? 0} left</span>
          </p>
          {p.oracle && <p className="chooser-oracle">{p.oracle}</p>}
          <p className="rail-help">
            The engine's split is filled in; change it on the targets.{(p.perOptionMin ?? 0) > 0 ? ` Each gets at least ${p.perOptionMin}.` : ""}
          </p>
          <button type="button" className="outline small" disabled={disabled || draft.kind !== "split"} onClick={onReset}>
            Reset to the default split
          </button>
        </>
      )}
      {stage === "dialog" && counter(p, draft) && <p className="chooser-count" aria-live="polite">{counter(p, draft)}</p>}
    </div>
  );
}

/** The widget for a decision's dialog (laptop) or sheet (phone). */
export function DecisionStage(props: Props) {
  const { p, draft } = props;
  // The rarer cards and rules (GRareCards, GRareRules).
  if (p.purpose === "face_down") return <FaceDownCast {...props} />;
  if (p.purpose === "companion") return <CompanionPanel {...props} />;
  if (p.purpose === "meld") return <MeldPanel {...props} />;
  if (p.purpose === "dungeon") return <DungeonPick {...props} />;
  if (p.purpose === "dungeon_room") return <DungeonRooms {...props} />;
  if (p.answer === "time_travel") return <TimeTravelRows {...props} />;
  if (p.purpose === "shortcut" || p.purpose === "shortcut_response" || p.purpose === "precast_response") return <ShortcutPanel {...props} />;
  if (p.answer === "choose_entry_attack_target" && p.options.every((o) => o.zone === "player")) return <SeatPicker {...props} />;
  if (isCastOffer(p) || p.purpose === "kept") return <CastOfferCard {...props} />;
  // Everyone takes part, choosing a player, and the library (GTogether, GRareRules, GLibrary).
  if (p.purpose === "vote") return <VotePanel {...props} />;
  if (p.purpose === "piles_split" || p.purpose === "piles_choose") return <PilesPanel {...props} />;
  if (p.purpose === "coin" || p.purpose === "die") return <LuckPick {...props} />;
  if (isSeatPick(p)) return <SeatPicker {...props} />;
  if (isTopOrBottom(p)) return <TopOrBottomPick {...props} />;
  if (isWordPick(p)) return <WordPick {...props} />;
  if (isPlaces(p)) return <PlacesPick {...props} />;
  if (draft.kind === "yesno") return <YesNoStrip {...props} />;
  if (isFaceChoice(p)) return <FaceChoice {...props} />;
  if (props.compact && isPermanentPick(p)) return <TilePick {...props} />;
  if (draft.kind === "order") return p.answer === "order_triggers" ? <TriggerOrder {...props} /> : <OrderCards {...props} />;
  if (draft.kind === "split") return <SplitRows {...props} />;
  if (draft.kind === "number") return <NumberPick {...props} />;
  if (draft.kind === "text") return <NamePick {...props} />;
  if (isScry(p)) return <ScryPiles {...props} />;
  if (p.answer === "choose_mana_color" || p.answer === "pay_mana_ability_mana") return <ManaColorPick {...props} />;
  if (p.answer === "pay_phyrexian") return <PhyrexianPick {...props} />;
  if (p.answer === "decide_optional_cost" || p.answer === "choose_cost_branch") return <CostRows {...props} />;
  if (p.answer === "select_modes") return <ModePick {...props} />;
  if (p.answer === "choose_replacement") return <ReplacePick {...props} />;
  if (p.answer === "choose_pair") return <PairList {...props} />;
  return <ZonePick {...props} />;
}
