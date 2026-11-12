// Paying mana by hand (design/screens/GPay, GPayPhone and GCast's source menu; logic in pay.ts).
// On a laptop the sources are tapped where they sit on the board, so the rail only shows the cost
// and its pips, the pool, what can't be undone, and "Tap mana for me"; graveyard cards for delve
// are listed here, since they aren't on the board. On a phone the dock's sheet lists every source
// as a button (GPayPhone). A source that can make more than one thing opens a small menu of its
// choices (GCast's Command Tower menu). The main button in the rail or dock confirms.

import { useEffect, useRef } from "react";
import { SymbolText } from "../components/ManaSymbols";
import { MANA } from "@yama/core";
import { artCredits } from "../components/ArtPanel";
import { Warn } from "./Decide";
import { TAP_MANA, choiceAct, keptNote, paidInFull, paymentStatus, penaltyText, pipsLabel, poolText, sourceClick, sourceChip } from "./pay";
import type { Act, CardMeta, ManaChoiceView, ManaSourceView, PaymentView, TapMana } from "./types";
import { Button, Field } from "../components/ui";

/** A mana colour's fill for a dot ("any" is a split of all five). */
function fill(code: string): string {
  if (code === "any") return `conic-gradient(${MANA.W.fill} 0 20%, ${MANA.U.fill} 0 40%, ${MANA.B.fill} 0 60%, ${MANA.R.fill} 0 80%, ${MANA.G.fill} 0)`;
  const k = code as keyof typeof MANA;
  return MANA[k]?.fill ?? MANA.C.fill;
}

/** The cost one symbol at a time: white once the pool covers it. */
export function Pips({ p, big = false }: { p: PaymentView; big?: boolean }) {
  if (!p.pips.length) return null;
  return (
    <span className={`pay-pips${big ? " big" : ""}`} role="img" aria-label={pipsLabel(p)}>
      {p.pips.map((x, i) => (
        <span key={i} className={`pay-pip${x.paid ? " paid" : ""}`}>{x.symbol}</span>
      ))}
    </span>
  );
}

function TapManaSetting({ value, onChange, disabled }: { value: TapMana; onChange: (t: TapMana) => void; disabled: boolean }) {
  return (
    <Field className="pay-setting" label="Tap mana for me">
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as TapMana)}>
        {TAP_MANA.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>
    </Field>
  );
}

/** Graveyard cards to exile for delve: not on the board, so they're picked here. */
function Delve({ p, meta, onAct, disabled }: { p: PaymentView; meta: Record<string, CardMeta>; onAct: (a: Act) => void; disabled: boolean }) {
  const cards = p.sources.filter((s) => s.zone === "graveyard");
  if (!cards.length) return null;
  return (
    <div className="pay-delve">
      <span className="dim small">Your graveyard. Each card you exile pays {"{1}"}.</span>
      <div className="pay-delve-cards">
        {cards.map((s) => (
          <Button key={s.id} className="pay-delve-card pick" disabled={disabled} aria-label={`Exile ${s.name}`} onClick={() => onAct(choiceAct(s, s.choices[0]!))}>
            {meta[s.name]?.image ? <img src={meta[s.name]!.image!} alt="" /> : <span>{s.name}</span>}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * The rail's body while paying on a laptop (GPay): cost, pool, what's final, the setting. With
 * `summary`, only the cost and the pool, under a question asked while paying (the Treasure prompt).
 */
export function PaymentRail({ p, meta, tapMana, onTapMana, onAct, disabled, summary = false }: {
  p: PaymentView;
  meta: Record<string, CardMeta>;
  tapMana: TapMana | undefined;
  onTapMana: (t: TapMana) => void;
  onAct: (a: Act) => void;
  disabled: boolean;
  summary?: boolean;
}) {
  const pool = poolText(p);
  const note = keptNote(p);
  if (summary) {
    return (
      <div className="pay-rail summary">
        {p.payingFor && p.cost && <p className="small dim">Paying <SymbolText text={p.cost} /> for {p.payingFor.name}</p>}
        <Pips p={p} />
        <p className="pay-pool">
          <span className="dim">Mana pool:</span>
          {pool.length ? pool.map((t) => <span key={t} className="pay-chip">{t}</span>) : <span className="pay-chip dim">empty</span>}
        </p>
        {note && <Warn text={note} />}
      </div>
    );
  }
  return (
    <div className="pay-rail">
      <p className="pay-status">{paymentStatus(p, false)}</p>
      <Pips p={p} big />
      <p className="pay-pool">
        <span className="dim">Mana pool:</span>
        {pool.length ? pool.map((t) => <span key={t} className="pay-chip">{t}</span>) : <span className="pay-chip dim">empty</span>}
      </p>
      {p.convoke && p.convoke !== "delve" && (
        <p className="small dim">
          {p.convoke === "convoke"
            ? "Convoke: click your untapped creatures to tap them. Each pays {1} or one mana of its color."
            : p.convoke === "improvise"
              ? "Improvise: click your untapped artifacts to tap them. Each pays {1}."
              : "Waterbend: click your untapped creatures and artifacts to tap them. Each pays {1}."}
        </p>
      )}
      <Delve p={p} meta={meta} onAct={onAct} disabled={disabled} />
      {note && <Warn text={note} />}
      {tapMana && <TapManaSetting value={tapMana} onChange={onTapMana} disabled={disabled} />}
      <p className="small dim">Untapping only works for sources that just make mana. Anything that hurts you or is sacrificed is final.</p>
    </div>
  );
}

/**
 * The dock's sheet while paying on a phone (GPayPhone): the spell, its pips, and every source as
 * a button, amber while you can tap it.
 */
export function PaymentSheet({ p, meta, onAct, menu, onMenu, disabled, cardName, onField }: {
  p: PaymentView;
  meta: Record<string, CardMeta>;
  onAct: (a: Act) => void;
  menu: ManaSourceView | null;
  onMenu: (s: ManaSourceView | null) => void;
  disabled: boolean;
  /** A card's name by id, for sources already tapped (they're no longer listed as sources). */
  cardName: (id: number) => string | undefined;
  /** Whether a card is on the battlefield (a creature tapped for convoke stays listed, tapped). */
  onField: (id: number) => boolean;
}) {
  const spell = p.payingFor ? meta[p.payingFor.name] : undefined;
  // Sources you can use, then the ones you've tapped: given back on a tap, final, or tapped for
  // this payment (a rock, a creature for convoke).
  const tapped = p.pool.map((m) => m.source).filter((id): id is number => id !== undefined && onField(id));
  const shown = [...p.sources.filter((s) => s.zone !== "graveyard").map((s) => s.id), ...p.untap, ...p.kept.map((k) => k.id), ...tapped];
  const ids = [...new Set(shown)];
  const name = (id: number) => p.sources.find((s) => s.id === id)?.name ?? p.kept.find((k) => k.id === id)?.name ?? cardName(id) ?? null;
  const note = keptNote(p);
  const credits = artCredits(ids.map((id) => meta[name(id) ?? ""]?.artist));
  return (
    <section className="pay-sheet" aria-label={p.payingFor ? `Pay for ${p.payingFor.name}` : "Paying"}>
      <div className="pay-sheet-head">
        {spell?.image && <img src={spell.image} alt="" />}
        <span>
          <b>{p.payingFor ? `Pay for ${p.payingFor.name}` : "Pay for the mana ability"}</b>
          <span className="dim small">{paymentStatus(p, true)}</span>
        </span>
      </div>
      <Pips p={p} big />
      <div className="pay-sources">
        {ids.map((id) => {
          const chip = sourceChip(p, [id]);
          const click = sourceClick(p, [id]);
          const n = name(id) ?? "A source";
          const art = meta[n]?.art ?? null;
          const can = !!click && click.does !== "untap";
          return (
            <Button
              key={id}
              className={`pay-source${can ? " pick" : ""}${chip?.tapped ? " tapped" : ""}`}
              disabled={disabled || !click}
              aria-label={`${n}, ${chip?.text ?? ""}`}
              onClick={() => {
                if (!click) return;
                if (click.does === "menu") onMenu(menu?.id === click.source.id ? null : click.source);
                else onAct(click.act);
              }}
            >
              {art ? <img src={art} alt="" /> : <span className="blank" />}
              <span>
                <b>{n}</b>
                <span className="small"><SymbolText text={chip?.text} /></span>
              </span>
            </Button>
          );
        })}
      </div>
      {menu && <ChoiceList source={menu} onPick={(c) => (onAct(choiceAct(menu, c)), onMenu(null))} disabled={disabled} />}
      <Delve p={p} meta={meta} onAct={onAct} disabled={disabled} />
      {poolText(p).length > 0 && <p className="small dim">Pool: {poolText(p).join(", ")}</p>}
      {note && <Warn text={note} />}
      {credits && <p className="pb-credit">{credits}</p>}
      {!paidInFull(p) && p.payRest && <p className="small dim">Pay the rest taps what's still needed.</p>}
    </section>
  );
}

/** A source's choices as buttons: what each adds, and what it costs beyond the tap. */
function ChoiceList({ source, onPick, disabled }: { source: ManaSourceView; onPick: (c: ManaChoiceView) => void; disabled: boolean }) {
  return (
    <div className="mana-choices" role="menu" aria-label={`Use ${source.name}`}>
      {source.choices.map((c) => (
        <Button key={c.key} role="menuitem" className="mana-choice" disabled={disabled} onClick={() => onPick(c)}>
          <span className="mana-dots" aria-hidden="true">
            {c.mana.map((m, i) => (
              <span key={i} className="mana-dot" style={{ background: fill(m) }} />
            ))}
          </span>
          <span className="mana-choice-text"><SymbolText text={c.text} /></span>
          {/* A land's row says it taps; an ability's text and convoke's say so themselves. */}
          <span className={`mana-choice-cost${c.penalty ? " bad" : ""}`}>{c.penalty ? penaltyText(c.penalty) : c.kind === "tap" ? "Tap" : ""}</span>
        </Button>
      ))}
    </div>
  );
}

/**
 * The menu over a source's tile on a laptop (GCast's "Use Command Tower"): its name, art and
 * artist, and a row for each thing it can make. Esc or a click elsewhere closes it.
 */
export function ManaMenu({ source, meta, at, onPick, onClose, disabled }: {
  source: ManaSourceView;
  meta: Record<string, CardMeta>;
  at: { left: number; top: number };
  onPick: (a: Act) => void;
  onClose: () => void;
  disabled: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    // After this click has finished, so the click that opened it doesn't close it.
    const t = window.setTimeout(() => window.addEventListener("pointerdown", away), 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("pointerdown", away);
    };
  }, [onClose]);
  const m = meta[source.name];
  return (
    <section ref={ref} className="mana-menu" style={{ left: at.left, top: at.top }} aria-label={`Use ${source.name}`}>
      <span className="mana-menu-head">
        {m?.art ? <img src={m.art} alt="" /> : <span className="blank" />}
        <span>
          <b>{source.name}</b>
          {m?.artist && <span className="dim">Art: {m.artist}</span>}
        </span>
      </span>
      <ChoiceList source={source} onPick={(c) => onPick(choiceAct(source, c))} disabled={disabled} />
    </section>
  );
}
