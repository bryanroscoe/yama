// A plain chooser for the decisions `act` answers (play/src/act.rs; the logic is answer.ts): the
// source card, the engine's question, a counter, and the choice itself. Cards in your hand or
// on the battlefield are picked on the board (Board.tsx); library cards and the like show in a
// zone view (ChooserZone). It never has its own confirm button: the main button in the rail or
// dock sends the answer, and Esc backs out (Bryan's decisions 6 and 7). The polished widgets come
// later from design/screens/GYesNo, GPickN, GOrder, GSplit, GNumber and GName.

import type { CardMeta, CardView, Pending } from "./types";
import { adjust, counter, left, move, setNumber, togglePick, type Draft } from "./answer";

interface Props {
  p: Pending;
  draft: Draft;
  onDraft: (d: Draft) => void;
  meta: Record<string, CardMeta>;
  /** A seat in words: "you", "Sam". */
  who: (seat: number) => string;
  /** Where a pick of cards is made: on the board, in the zone view, or (anything else) in this list. */
  place: "board" | "zone" | "list";
  onRead: (c: CardView) => void;
  cardById: Map<number, CardView>;
  disabled: boolean;
}

/** The rail's (or dock's) body for a decision: source, question, counter and the choice. */
export function ChooserBody({ p, draft, onDraft, meta, who, place, onRead, cardById, disabled }: Props) {
  const source = p.source;
  const sourceCard = source ? cardById.get(source.id) : undefined;
  const count = counter(p, draft);
  return (
    <div className="chooser">
      {source && (
        <button type="button" className="chooser-source" onClick={() => sourceCard && onRead(sourceCard)} disabled={!sourceCard}>
          {source.art ? <img src={source.art} alt="" /> : <span className="row-blank" />}
          <span className="row-text">
            <b>{source.name}</b>
            <span>{source.artist ? `Art: ${source.artist}` : who(source.controller) === "you" ? "Yours" : `${who(source.controller)}'s`}</span>
          </span>
        </button>
      )}
      {p.oracle && <p className="chooser-oracle">{p.oracle}</p>}
      {count && <p className="chooser-count" aria-live="polite">{count}</p>}
      {draft.kind === "pick" && place === "list" && <PickList p={p} draft={draft} onDraft={onDraft} who={who} disabled={disabled} />}
      {draft.kind === "pick" && place !== "list" && (
        <p className="rail-help">
          {p.purpose === "scry"
            ? "Pick the cards to keep on top, in the order they should be. The rest go to the bottom."
            : p.purpose === "surveil"
              ? "Pick the cards to keep on top, in the order they should be. The rest go to your graveyard."
              : place === "board"
                ? "Pick the cards with an amber ring."
                : "Pick the cards to choose them."}
          {draft.ids.length > 0 && ` Chosen: ${draft.ids.map((id) => p.options.find((o) => o.id === id)?.name ?? "a card").join(", ")}.`}
        </p>
      )}
      {draft.kind === "order" && <OrderList p={p} draft={draft} onDraft={onDraft} meta={meta} disabled={disabled} />}
      {draft.kind === "split" && <SplitList p={p} draft={draft} onDraft={onDraft} who={who} disabled={disabled} />}
      {draft.kind === "number" && <NumberPick p={p} draft={draft} onDraft={onDraft} disabled={disabled} />}
      {draft.kind === "text" && <TextPick p={p} draft={draft} onDraft={onDraft} disabled={disabled} />}
    </div>
  );
}

function optionWords(o: Pending["options"][number], who: (seat: number) => string) {
  if (o.zone === "player") return o.controller === undefined ? o.name : who(o.controller) === "you" ? "You" : o.name;
  return o.name;
}

function PickList({ p, draft, onDraft, who, disabled }: { p: Pending; draft: Extract<Draft, { kind: "pick" }>; onDraft: (d: Draft) => void; who: (seat: number) => string; disabled: boolean }) {
  return (
    <ul className="option-list chooser-list">
      {p.options.map((o) => {
        const n = draft.ids.filter((x) => x === o.id).length;
        const at = draft.ids.indexOf(o.id);
        return (
          <li key={o.id}>
            <button
              type="button"
              className={`chooser-row${n ? " picked" : o.eligible ? " pick" : ""}`}
              aria-pressed={n > 0}
              disabled={disabled || !o.eligible}
              onClick={() => onDraft(togglePick(p, draft, o.id))}
            >
              <span className="row-text">
                <b>{optionWords(o, who)}</b>
                {o.text && <span>{o.text}</span>}
              </span>
              {n > 0 && <span className="pick-badge num">{p.repeat ? `×${n}` : at + 1}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function OrderList({ p, draft, onDraft, meta, disabled }: { p: Pending; draft: Extract<Draft, { kind: "order" }>; onDraft: (d: Draft) => void; meta: Record<string, CardMeta>; disabled: boolean }) {
  const triggers = p.answer === "order_triggers";
  return (
    <ol className="option-list chooser-list">
      {draft.ids.map((id, i) => {
        const o = p.options.find((x) => x.id === id);
        const art = o?.art ?? (o ? meta[o.name]?.art : null);
        return (
          <li key={id} className="order-row">
            <span className="pick-badge num">{i + 1}</span>
            {art ? <img src={art} alt="" /> : <span className="row-blank" />}
            <span className="row-text">
              <b>{o?.name ?? "A trigger"}</b>
              {o?.text && <span>{o.text}</span>}
              {triggers && (i === 0 || i === draft.ids.length - 1) && <span className="order-edge">{i === 0 ? "Resolves first" : "Resolves last"}</span>}
            </span>
            <span className="order-moves">
              <button type="button" className="quiet small" aria-label={`Move ${o?.name ?? "it"} up`} disabled={disabled || i === 0} onClick={() => onDraft(move(draft, i, -1))}>Up</button>
              <button type="button" className="quiet small" aria-label={`Move ${o?.name ?? "it"} down`} disabled={disabled || i === draft.ids.length - 1} onClick={() => onDraft(move(draft, i, 1))}>Down</button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SplitList({ p, draft, onDraft, who, disabled }: { p: Pending; draft: Extract<Draft, { kind: "split" }>; onDraft: (d: Draft) => void; who: (seat: number) => string; disabled: boolean }) {
  const rest = left(p, draft);
  return (
    <ul className="option-list chooser-list">
      {p.options.map((o) => {
        const n = draft.amounts[o.id] ?? 0;
        return (
          <li key={o.id} className="split-row">
            <span className="row-text">
              <b>{optionWords(o, who)}</b>
              <span>
                {o.lethal !== undefined ? `${o.lethal} is lethal` : o.toughness !== undefined ? `Toughness ${o.toughness}` : o.zone === "player" ? "The player" : ""}
              </span>
            </span>
            <span className="stepper">
              <button type="button" className="outline small" aria-label={`Less to ${o.name}`} disabled={disabled || n <= 0} onClick={() => onDraft(adjust(p, draft, o.id, -1))}>−</button>
              <b className="num" aria-label={`${n} to ${o.name}`}>{n}</b>
              <button type="button" className="outline small" aria-label={`More to ${o.name}`} disabled={disabled || rest <= 0} onClick={() => onDraft(adjust(p, draft, o.id, 1))}>+</button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function NumberPick({ p, draft, onDraft, disabled }: { p: Pending; draft: Extract<Draft, { kind: "number" }>; onDraft: (d: Draft) => void; disabled: boolean }) {
  const cost = p.previews?.find(([x]) => x === draft.value)?.[1];
  return (
    <div className="number-pick">
      <span className="stepper big">
        <button type="button" className="outline" aria-label="One less" disabled={disabled || draft.value <= p.min} onClick={() => onDraft(setNumber(p, draft.value - 1))}>−</button>
        <input
          type="number"
          inputMode="numeric"
          min={p.min}
          max={p.max}
          value={draft.value}
          aria-label={p.answer === "choose_x" ? "X" : "Number"}
          disabled={disabled}
          onChange={(e) => e.target.value !== "" && onDraft(setNumber(p, Number(e.target.value)))}
        />
        <button type="button" className="outline" aria-label="One more" disabled={disabled || draft.value >= p.max} onClick={() => onDraft(setNumber(p, draft.value + 1))}>+</button>
      </span>
      <p className="rail-help">
        From {p.min} to {p.max}
        {cost ? `. Total cost ${cost}` : ""}
      </p>
      {p.max > p.min && (
        <button type="button" className="quiet small" disabled={disabled || draft.value === p.max} onClick={() => onDraft(setNumber(p, p.max))}>
          Most: {p.max}
        </button>
      )}
    </div>
  );
}

function TextPick({ p, draft, onDraft, disabled }: { p: Pending; draft: Extract<Draft, { kind: "text" }>; onDraft: (d: Draft) => void; disabled: boolean }) {
  return (
    <div className="text-pick">
      {p.freeEntry && (
        <input
          type="text"
          value={draft.value}
          placeholder={p.choiceType ? `Type a ${p.choiceType}` : "Type your answer"}
          aria-label={p.prompt}
          disabled={disabled}
          onChange={(e) => onDraft({ kind: "text", value: e.target.value })}
        />
      )}
      {p.options.length > 0 && (
        <div className="rail-options">
          {p.options.map((o) => (
            <button key={o.id} type="button" className={draft.value === o.id ? "primary-outline picked" : "outline"} aria-pressed={draft.value === o.id} disabled={disabled} onClick={() => onDraft({ kind: "text", value: o.id })}>
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A zone view for picks among cards that aren't on the board (the top of your library for a scry,
 * a search): each card full size, an amber ring on what you may pick, a white ring and its number
 * on what you've picked. Over the table on a laptop; a strip in the dock on a phone.
 */
export function ChooserZone({ p, draft, onDraft, meta, onRead, compact, disabled }: {
  p: Pending;
  draft: Extract<Draft, { kind: "pick" }>;
  onDraft: (d: Draft) => void;
  meta: Record<string, CardMeta>;
  onRead: (name: string) => void;
  compact: boolean;
  disabled: boolean;
}) {
  return (
    <section className={`chooser-zone${compact ? " compact" : ""}`} aria-label={p.prompt}>
      {!compact && (
        <header>
          <b>{p.prompt}</b>
          <span className="dim">{counter(p, draft)}</span>
        </header>
      )}
      <div className="chooser-cards">
        {p.options.map((o) => {
          const at = draft.ids.indexOf(o.id);
          const img = o.img ?? meta[o.name]?.image ?? null;
          return (
            <button
              key={o.id}
              type="button"
              className={`zone-pick${at >= 0 ? " picked" : o.eligible ? " pick" : " no"}`}
              aria-pressed={at >= 0}
              aria-label={`${o.name}${at >= 0 ? `, chosen ${at + 1}` : o.eligible ? "" : ", can't be chosen"}`}
              disabled={disabled || !o.eligible}
              onClick={() => onDraft(togglePick(p, draft, o.id))}
              onContextMenu={(e) => (e.preventDefault(), onRead(o.name))}
            >
              {img ? <img src={img} alt="" draggable={false} /> : <span className="hc-name">{o.name}</span>}
              {at >= 0 && <span className="pick-badge num">{at + 1}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
