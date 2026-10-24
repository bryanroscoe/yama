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
  canRememberOrder,
  counter,
  isScry,
  isTapping,
  isTargeting,
  keepOnTop,
  keypad,
  left,
  lethalOf,
  move,
  moveTo,
  nameMatches,
  orderTag,
  rememberLabels,
  restHere,
  setNumber,
  splitTag,
  stepNumber,
  togglePick,
  typeDigit,
  type Draft,
  type Remember,
  type Stage,
} from "./answer";
import { seatHeadOf, tileOf } from "./DragLayer";
import type { CardMeta, DecisionOption, Pending } from "./types";

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
      </span>
      {extra ?? (count ? <span className="dw-count" aria-live="polite">{count}</span> : null)}
      {compact && p.oracle && <span className="dw-oracle wide">{p.oracle}</span>}
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
        {/* Only where the engine itself can remember the answer; Yama's own remembering comes later. */}
        {p.remember === "engine" && draft.kind === "yesno" && (
          <span className="dw-remember">
            <span className="dw-remember-label">Remember for this card</span>
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
  const { list, handle } = useReorder(compact ? "y" : "x", (from, to) => onDraft(moveTo(draft, from, to)));
  if (draft.kind !== "order") return null;
  const byId = new Map(p.options.map((o) => [o.id, o]));
  const n = draft.ids.length;
  const top = p.destination === "top";
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
            return (
              <li key={id} data-reorder className="dw-order-item">
                <span className={`dw-tag${i === 0 ? " first" : ""}`}>{orderTag(p, i, n)}</span>
                <span className="dw-order-card" {...handle(i)}>
                  <ReadImg src={img(o)} name={name} onRead={() => ctx.onRead(name, Number(id))} />
                  <span className="pick-badge num">{i + 1}</span>
                </span>
                {compact && <b className="dw-order-name">{name}</b>}
                <span className="dw-arrows">
                  <button type="button" className="outline" aria-label={`Move ${name} ${top ? "nearer the top" : "higher"}`} disabled={disabled || i === 0} onClick={() => onDraft(move(draft, i, -1))}>
                    {compact ? "↑" : "←"}
                  </button>
                  {!compact && (
                    <span className="dw-grip-wrap" title="Drag" {...handle(i)}>
                      <Grip cols={3} />
                    </span>
                  )}
                  <button type="button" className="outline" aria-label={`Move ${name} ${top ? "deeper" : "lower"}`} disabled={disabled || i === n - 1} onClick={() => onDraft(move(draft, i, 1))}>
                    {compact ? "↓" : "→"}
                  </button>
                </span>
              </li>
            );
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
          <span className="dw-left">
            <b className={`num${rest === 0 ? " done" : ""}`}>{rest}</b>
            <span>{compact ? "left" : `of ${p.total ?? 0} left`}</span>
          </span>
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
                <span>
                  <span className="seat-dot" aria-hidden="true" />
                  {splitWho(o, ctx, damage)}
                </span>
                {compact && tag && <span className={`dw-tag${tag.dies ? (theirs ? " good" : " bad") : ""}`}>{tag.text}</span>}
              </span>
              {!compact && tag && <span className={`dw-tag${tag.dies ? (theirs ? " good" : " bad") : ""}`}>{tag.text}</span>}
              <span className="dw-split-controls">
                <Stepper
                  name={o.name}
                  n={n}
                  lessOff={disabled || n <= min}
                  moreOff={disabled || rest <= 0}
                  onLess={() => onDraft(adjust(p, draft, o.id, -1))}
                  onMore={() => onDraft(adjust(p, draft, o.id, 1))}
                />
                {!compact && rest > 0 && (
                  <button type="button" className="outline small" disabled={disabled} onClick={() => onDraft(restHere(p, draft, o.id))}>
                    Rest here
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <p className="dw-foot">
        Starts at the engine's split.{min > 0 ? ` Each gets at least ${min}.` : ""} {artists.length ? `Art: ${artists.join(", ")}, ${COPYRIGHT}.` : ""}
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
              moreOff={disabled || rest <= 0}
              onLess={() => onDraft(adjust(p, draft, o.id, -1))}
              onMore={() => onDraft(adjust(p, draft, o.id, 1))}
            />
            {tag && <span className={`dw-tag${tag.dies ? (theirs ? " good" : " bad") : ""}`}>{tag.text}</span>}
          </div>
        );
      })}
    </div>
  );
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

// ── the rail and the banner ────────────────────────────────────────────────

/** The status pill over the battlefield while you pick on the board or split onto targets. */
export function PickBanner({ p, draft }: { p: Pending; draft: Draft }) {
  return (
    <div className="dw-banner" role="status">
      {p.source?.art && <img src={p.source.art} alt="" />}
      <span>{p.prompt}</span>
      <span className="dw-banner-count">{counter(p, draft)}</span>
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
      {stage === "board" && (
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
      {stage === "steppers" && (
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
  if (draft.kind === "yesno") return <YesNoStrip {...props} />;
  if (draft.kind === "order") return p.answer === "order_triggers" ? <TriggerOrder {...props} /> : <OrderCards {...props} />;
  if (draft.kind === "split") return <SplitRows {...props} />;
  if (draft.kind === "number") return <NumberPick {...props} />;
  if (draft.kind === "text") return <NamePick {...props} />;
  if (isScry(p)) return <ScryPiles {...props} />;
  if (p.answer === "select_modes") return <ModePick {...props} />;
  if (p.answer === "choose_replacement") return <ReplacePick {...props} />;
  if (p.answer === "choose_pair") return <PairList {...props} />;
  return <ZonePick {...props} />;
}
