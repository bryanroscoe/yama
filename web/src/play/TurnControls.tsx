// Turn controls on the online board (design/screens/GPriority, GButtons, GSettings, GTogether's
// Resolve all tab, GLog's automatic answers). The logic and wording live in turns.ts; these are
// the pieces Board.tsx places: the ways to pass, a pass mode's chip, the Resolve all ledger and
// the game settings (trigger yields, automatic answers, hand order, concede).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { artCredits } from "../components/ArtPanel";
import { useReorder } from "./Decide";
import type { SeatTone } from "./model";
import { PLAY_SPEEDS, type PlaySpeed } from "./motion";
import { TAP_MANA } from "./pay";
import { answerBy, moved, shift, type PassChoice, type SettingsSection } from "./turns";
import type { Act, CardMeta, CardView, ResolveAllView, StackItem, TapMana, TurnsView } from "./types";
import { Button, Segmented } from "../components/ui";

const seatDot = (tone: SeatTone | undefined) => (tone ? ({ ["--seat" as string]: `var(--${tone})` } as React.CSSProperties) : undefined);

/** GPriority's list of ways to pass. Each line says what it does and its key (keys are laptop only). */
export function PassList({ choices, onPick, keys, disabled }: { choices: PassChoice[]; onPick: (c: PassChoice) => void; keys: boolean; disabled: boolean }) {
  return (
    <ul className="pass-list" aria-label="Ways to pass">
      {choices.map((c) => (
        <li key={c.id}>
          <Button className={c.on ? "on" : ""} aria-pressed={c.id === "full" ? !!c.on : undefined} disabled={disabled || c.disabled} onClick={() => onPick(c)}>
            <b>{c.label}{c.id === "full" ? (c.on ? ", on" : ", off") : ""}</b>
            {keys && c.key && <kbd>{c.key}</kbd>}
            <span>{c.hint}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The ways to pass, over the rail's buttons on a laptop (GPriority). Esc or a click outside closes it. */
export function PassMenu({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="pass-menu-scrim" onClick={onClose} />
      <section className="pass-menu" role="dialog" aria-label="Ways to pass">
        {children}
      </section>
    </>
  );
}

/** While a way to pass is on: what it's doing, and Stop (GPriority). */
export function ModeChip({ label, onStop, disabled }: { label: string; onStop: () => void; disabled?: boolean }) {
  return (
    <div className="mode-chip" role="status">
      <span>{label}</span>
      <Button onClick={onStop} disabled={disabled}>Cancel passing</Button>
    </div>
  );
}

/**
 * Resolve all, while the engine asks everyone (GTogether's consent tab): the stack, top first, and
 * who has agreed. The person asked answers with the main button (Agree) or Keep priority.
 */
export function ConsentBody({ ask, stack, meta, Who, tone, you, compact }: {
  ask: ResolveAllView;
  stack: StackItem[];
  meta: Record<string, CardMeta>;
  Who: (seat: number) => string;
  tone: (seat: number) => SeatTone | undefined;
  you: number | null;
  compact: boolean;
}) {
  const agreed = ask.seats.filter((s) => s.agreed).length;
  const state = (s: ResolveAllView["seats"][number]) => (s.seat === ask.asked_by ? "Asked" : s.agreed ? "Agreed" : s.deciding ? "Deciding" : "Not yet");
  const shown = [...stack].reverse();
  return (
    <div className={`consent${compact ? " compact" : ""}`}>
      <p className="consent-why">
        {ask.asked_by === you ? "You asked" : `${Who(ask.asked_by)} asked`} to resolve everything on the stack. Agreeing passes for you until the stack is empty; anything new put on it asks everyone again.
      </p>
      {!compact && (
        <>
          <h3>On the stack, top first</h3>
          <ol className="consent-stack">
            {shown.map((s, i) => (
              <li key={s.id ?? i}>
                {meta[s.name]?.art ? <img src={meta[s.name]!.art!} alt="" /> : <span className="blank" />}
                <span>
                  <b><span className="seat-dot" style={seatDot(tone(s.controller))} aria-hidden="true" />{s.name}</b>
                  <span className="dim small">{s.controller === you ? "Yours" : `${Who(s.controller)}'s`}{s.trigger ? " trigger" : ""}</span>
                  {s.text && <span className="small">{s.text}</span>}
                </span>
              </li>
            ))}
          </ol>
          {shown.some((s) => meta[s.name]?.art) && <p className="pb-credit">{artCredits(shown.map((s) => meta[s.name]?.artist))}</p>}
        </>
      )}
      <h3>Who has agreed, {agreed} of {ask.seats.length}</h3>
      <ul className="consent-ledger">
        {ask.seats.map((s) => (
          <li key={s.seat} className={s.seat === you ? "you" : ""}>
            <span className="seat-dot" style={seatDot(tone(s.seat))} aria-hidden="true" />
            <b>{Who(s.seat)}</b>
            <span className={s.agreed ? "good" : ""}>{state(s)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const SECTIONS: { id: SettingsSection; label: string; short: string }[] = [
  { id: "yields", label: "Trigger yields", short: "Yields" },
  { id: "answers", label: "Automatic answers", short: "Answers" },
  { id: "hand", label: "Hand order", short: "Hand" },
  { id: "speed", label: "Playback speed", short: "Speed" },
  { id: "pay", label: "Paying mana", short: "Mana" },
  { id: "rewind", label: "Rewind", short: "Rewind" },
  { id: "concede", label: "Concede", short: "Concede" },
];

/**
 * This game's settings (GSettings, GSettingsPhone): trigger yields, the answers the engine gives
 * for you, your hand's order and conceding. Changes go to the game at once; conceding is confirmed
 * only with the main button (the rail's on a laptop, `buttons` at the foot of the sheet on a phone).
 */
export function GameSettings({ section, onSection, turns, hand, meta, whose, tone, onAct, onTapMana, disabled, compact, buttons, speed, onSpeed, solo, rewindSteps = 0, rewindChanged = false }: {
  rewindSteps?: number;
  rewindChanged?: boolean;
  speed?: PlaySpeed;
  onSpeed?: (speed: PlaySpeed) => void;
  solo?: boolean;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  turns: TurnsView;
  /** "Tap mana for me", saved with your account. */
  onTapMana?: (t: TapMana) => void;
  hand: CardView[];
  meta: Record<string, CardMeta>;
  whose: (seat: number) => string;
  tone: (seat: number) => SeatTone | undefined;
  onAct: (a: Act) => void;
  disabled: boolean;
  compact: boolean;
  buttons?: ReactNode;
}) {
  const counts: Partial<Record<SettingsSection, number>> = { yields: turns.yields.length, answers: turns.answers.length };
  const nav = compact ? (
    <div role="tablist" aria-label="Sections" className="gs-tabs">
      {SECTIONS.filter((s) => s.id !== "rewind" || solo).map((s) => (
        <Button key={s.id} role="tab" aria-selected={section === s.id} className={`${section === s.id ? "on" : ""}${s.id === "concede" ? " bad" : ""}`} onClick={() => onSection(s.id)}>
          {s.id === "concede" && solo ? "End game" : s.short}
        </Button>
      ))}
    </div>
  ) : (
    <nav aria-label="Sections" className="gs-nav">
      <h2>This game</h2>
      {SECTIONS.filter((s) => s.id !== "rewind" || solo).map((s) => (
        <Button key={s.id} aria-current={section === s.id} className={`${section === s.id ? "on" : ""}${s.id === "concede" ? " bad" : ""}`} onClick={() => onSection(s.id)}>
          {s.id === "concede" && solo ? "End game" : s.label}
          {counts[s.id] !== undefined && <span>{counts[s.id]}</span>}
        </Button>
      ))}
      <p className="gs-note">Settings here last for this game. Stops and the ways to pass are in the turn strip.</p>
    </nav>
  );
  return (
    <div className={`gs${compact ? " compact" : ""}`}>
      {compact && <b className="gs-title">This game</b>}
      {nav}
      <div className="gs-body">
        {section === "yields" && <Yields turns={turns} meta={meta} whose={whose} tone={tone} onAct={onAct} disabled={disabled} compact={compact} />}
        {section === "answers" && <Answers turns={turns} meta={meta} whose={whose} onAct={onAct} disabled={disabled} />}
        {section === "hand" && <HandOrder hand={hand} meta={meta} onAct={onAct} disabled={disabled} compact={compact} />}
        {section === "pay" && <Paying value={turns.tap_mana} onChange={onTapMana} disabled={disabled} />}
        {section === "speed" && <div className="gs-speed"><h3>Playback speed</h3><p>Card movement, effects and combat cues. Saved on this device.</p><Segmented label="Playback speed" value={speed} onChange={(v) => onSpeed?.(v)} options={PLAY_SPEEDS} /></div>}
        {section === "rewind" && <div><h3>Correct a mistake</h3><p>Undo your last decision and everything the computers did afterward, including plays, targets, payments, discards and combat choices. Repeat to go back further.</p><p>{rewindSteps} of up to 8 recent decisions available. Cards revealed since that decision return to their earlier state; you still know what you saw.</p><p>Available during a solo game. History survives reconnecting, but ends when the server restarts or the game finishes.</p>{rewindChanged && <p role="status">A newer choice was made. Cancel and reopen Rewind to review it.</p>}</div>}
        {section === "concede" && (solo ? <p>End this game against the computers now. It is saved as abandoned, with no winner.</p> : <Concede compact={compact} />)}
      </div>
      {buttons}
    </div>
  );
}

function Yields({ turns, meta, whose, tone, onAct, disabled, compact }: { turns: TurnsView; meta: Record<string, CardMeta>; whose: (seat: number) => string; tone: (seat: number) => SeatTone | undefined; onAct: (a: Act) => void; disabled: boolean; compact: boolean }) {
  return (
    <>
      <p className="gs-lede">
        <b>Trigger yields</b>
        While one of these triggers is on top of the stack, Yama passes priority for you. {compact ? "Long-press a trigger on the stack to add one." : "Add one by right-clicking a trigger on the stack."}
      </p>
      {turns.yields.map((y) => (
        <div key={y.id} className="gs-row">
          {meta[y.name]?.art ? <img src={meta[y.name]!.art!} alt="" /> : <span className="blank" />}
          <span className="gs-what">
            <b>
              {y.controller !== undefined && <span className="seat-dot" style={seatDot(tone(y.controller))} aria-hidden="true" />}
              {y.name}
            </b>
            <span className="dim small">{y.controller !== undefined ? `${whose(y.controller)} trigger, ` : ""}{y.every ? "it and its copies" : "this one only"}</span>
            {y.text && !compact && <span className="small">{y.text}</span>}
          </span>
          <Button variant="outline" disabled={disabled} onClick={() => onAct(y.remove)}>Remove</Button>
        </div>
      ))}
      {!turns.yields.length && <p className="gs-empty">No yields. Yama stops for every trigger your stops cover.</p>}
      {turns.yields.some((y) => meta[y.name]?.art) && <p className="pb-credit">{artCredits(turns.yields.map((y) => meta[y.name]?.artist))}</p>}
    </>
  );
}

function Answers({ turns, meta, whose, onAct, disabled }: { turns: TurnsView; meta: Record<string, CardMeta>; whose: (seat: number) => string; onAct: (a: Act) => void; disabled: boolean }) {
  return (
    <>
      <p className="gs-lede">
        <b>Automatic answers</b>
        Answers you asked to be remembered. The log shows each one when it's used.
      </p>
      {turns.answers.map((a) => (
        <div key={a.id} className="gs-row">
          {meta[a.name]?.art ? <img src={meta[a.name]!.art!} alt="" /> : <span className="blank" />}
          <span className="gs-what">
            <b>{a.owner !== undefined ? `${whose(a.owner)} ${a.name}` : a.name}</b>
            <span>{a.answer}</span>
            <span className="dim small">{answerBy(a)}</span>
          </span>
          <Button variant="outline" disabled={disabled} onClick={() => onAct(a.forget)}>Turn off</Button>
        </div>
      ))}
      {!turns.answers.length && <p className="gs-empty">No automatic answers. Yama will ask every time.</p>}
      {turns.answers.some((a) => meta[a.name]?.art) && <p className="pb-credit">{artCredits(turns.answers.map((a) => meta[a.name]?.artist))}</p>}
    </>
  );
}

/**
 * Your hand's order: drag a card, or pick one and move it with the arrows. The order goes to the
 * game when a drag ends or an arrow is pressed (ReorderHand); only you see it.
 */
function HandOrder({ hand, meta, onAct, disabled, compact }: { hand: CardView[]; meta: Record<string, CardMeta>; onAct: (a: Act) => void; disabled: boolean; compact: boolean }) {
  const ids = hand.map((c) => c.id);
  const key = [...ids].sort((a, b) => a - b).join(",");
  // The order shown: the game's, until you move something (then yours, until the game agrees).
  const [order, setOrderState] = useState<number[]>(ids);
  const current = useRef(order);
  const setOrder = (next: number[]) => {
    current.current = next;
    setOrderState(next);
  };
  const [sel, setSel] = useState<number | null>(ids[0] ?? null);
  useEffect(() => {
    // A card played or drawn, or the game's order arriving: show the game's order.
    setOrder(ids);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ids.join(",")]);
  const send = (next: number[]) => onAct({ kind: "reorder_hand", order: next });
  const drag = useReorder("x", (from, to) => setOrder(moved(current.current, from, to)), () => send(current.current));
  const step = (by: -1 | 1) => {
    if (sel === null) return;
    const next = shift(order, sel, by);
    if (next !== order) {
      setOrder(next);
      send(next);
    }
  };
  const byId = new Map(hand.map((c) => [c.id, c]));
  const at = sel === null ? -1 : order.indexOf(sel);
  return (
    <>
      <p className="gs-lede">
        <b>Hand order</b>
        {compact ? "Tap a card, then move it with the arrows, or drag it. Only you see the order." : "Drag a card to move it, or pick one and use the arrows. Only you see the order."}
      </p>
      {!hand.length && <p className="gs-empty">No cards in your hand.</p>}
      <ol className="gs-hand" ref={drag.list}>
        {order.map((id, i) => {
          const c = byId.get(id);
          if (!c) return null;
          const grab = drag.handle(i);
          return (
            <li key={id} data-reorder>
              <Button
                className={id === sel ? "on" : ""}
                aria-pressed={id === sel}
                aria-label={`${c.name}, card ${i + 1} of ${order.length}`}
                disabled={disabled}
                onClick={() => setSel(id)}
                onPointerDown={(e) => {
                  setSel(id);
                  grab.onPointerDown(e);
                }}
                onPointerMove={grab.onPointerMove}
                onPointerUp={grab.onPointerUp}
                onPointerCancel={grab.onPointerCancel}
              >
                {meta[c.name]?.image ? <img src={meta[c.name]!.image!} alt="" draggable={false} /> : <span className="gs-card-name">{c.name}</span>}
              </Button>
            </li>
          );
        })}
      </ol>
      {hand.length > 0 && (
        <span className="gs-arrows">
          <Button variant="outline" aria-label="Move left" disabled={disabled || at <= 0} onClick={() => step(-1)}>←</Button>
          <Button variant="outline" aria-label="Move right" disabled={disabled || at < 0 || at >= order.length - 1} onClick={() => step(1)}>→</Button>
          <span className="dim small">{at >= 0 ? `${byId.get(sel!)?.name} is card ${at + 1} of ${order.length}.` : ""}</span>
        </span>
      )}
      {hand.length > 0 && <p className="pb-credit">Card images from Scryfall, ™ & © Wizards of the Coast.</p>}
    </>
  );
}

/** "Tap mana for me" (GPay's setting): how your spells pay, saved for every game. */
function Paying({ value, onChange, disabled }: { value?: TapMana; onChange?: (t: TapMana) => void; disabled: boolean }) {
  return (
    <>
      <p className="gs-lede">
        <b>Tap mana for me</b>
        How your spells pay. Saved for every game. Paying by hand, you tap lands and rocks on the board, and Pay the rest taps what's still needed.
      </p>
      <div role="radiogroup" aria-label="Tap mana for me" className="gs-radios">
        {TAP_MANA.map((t) => (
          <label key={t.id} className={`gs-radio${value === t.id ? " on" : ""}`}>
            <input type="radio" name="tap-mana" checked={value === t.id} disabled={disabled || !onChange || !value} onChange={() => onChange?.(t.id)} />
            {t.label}
          </label>
        ))}
      </div>
      {!value && <p className="gs-empty">This server doesn't keep this setting yet.</p>}
    </>
  );
}

function Concede({ compact }: { compact: boolean }) {
  return (
    <>
      {!compact && (
        <p className="gs-lede">
          <b>Concede</b>
          You can concede at any time, even while someone else is deciding.
        </p>
      )}
      <div role="alert" className="gs-warning">
        <b>
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3l10 18H2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M12 10v5M12 18v.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          This can't be undone
        </b>
        <span>You leave the game. Everything you own leaves with you, and the others play on. The game counts as a loss for you.</span>
      </div>
      <p className="dim small">{compact ? "Confirm with the button below. Cancel keeps you in the game." : "Confirm with the main button. Esc or Cancel keeps you in the game."}</p>
    </>
  );
}
