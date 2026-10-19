import {
  answerState,
  filterItems,
  fmtDate,
  isAnswer,
  opTime,
  REVIEW_FILTERS,
  REVIEW_GROUPS,
  reviewItems,
  reviewRecord,
  swapSource,
  swapStatus,
  deckLogs,
  toggleDecision,
  usd,
  type Decision,
  type PlanDeck,
  type Quote,
  type Review as Answer,
  type ReviewFilter,
  type ReviewItem,
  type ReviewRecord,
} from "@yama/core/plan";
import { memo, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { deviceId, outbox, useOutbox, useOutboxState } from "./outbox";
import { usePlanOutlet } from "./PlanLayout";
import { StatusTag, Thumb } from "./parts";
import type { PlanView } from "./view";

const DECISIONS: { id: Decision; label: string }[] = [
  { id: "want", label: "Want" },
  { id: "unsure", label: "Unsure" },
  { id: "no", label: "Don't want" },
];

/** Queue a full answer for a swap key. The page shows it at once; the outbox sends it. */
function sendAnswer(userId: string, swapKey: string, deckKey: string | null, current: Answer | undefined, change: Partial<ReviewRecord>) {
  const record = reviewRecord(current, change);
  outbox.enqueue(userId, { kind: "review", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), swap_key: swapKey, deck_key: deckKey, ...record });
}

/** `/decks/plan/review`: answer every swap and proposal, deck by deck, on or offline. */
export function Review() {
  const { view, userId } = usePlanOutlet();
  const [params, setParams] = useSearchParams();
  const decks = useMemo(() => reviewItems(view.b, view.answers), [view]);
  const deckKey = params.get("deck") ?? decks.find((d) => d.counts.undecided > 0 && d.items.some((i) => i.swap.stage === "proposed"))?.deck.key ?? decks[0]?.deck.key;
  const current = decks.find((d) => d.deck.key === deckKey) ?? decks[0];
  const filter = (REVIEW_FILTERS.find((f) => f.id === params.get("show"))?.id ?? "all") as ReviewFilter;
  const [query, setQuery] = useState(params.get("q") ?? "");
  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const shown = current ? filterItems(current.items, filter, query) : [];
  const imported = view.b.decks.some((d) => d.source === "import");

  return (
    <>
      <div className="page-head">
        <h1>Review</h1>
      </div>
      {imported && (
        <p className="dim small">
          Your answers go to your {view.app} inbox. A want joins the plan when the plan is updated there; a no on a planned swap changes nothing until you and
          your planner decide.
        </p>
      )}
      <SyncLine view={view} userId={userId} />

      <div className="plan-chips plan-chips-decks" role="tablist" aria-label="Decks">
        {decks.map((d) => (
          <button key={d.deck.key} role="tab" aria-selected={d.deck.key === current?.deck.key} onClick={() => set("deck", d.deck.key)}>
            {d.deck.name} <span className="num dim">{d.counts.undecided}/{d.counts.all}</span>
          </button>
        ))}
      </div>
      {current && (
        <>
          <div className="plan-chips plan-chips-small" role="group" aria-label="Show">
            {REVIEW_FILTERS.map((f) => (
              <button key={f.id} aria-pressed={f.id === filter} onClick={() => set("show", f.id === "all" ? null : f.id)}>
                {f.label} <span className="num dim">{current.counts[f.id]}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            className="plan-search"
            value={query}
            placeholder="Search cards, reasons, stores and notes"
            aria-label="Search"
            onChange={(e) => {
              setQuery(e.target.value);
              set("q", e.target.value || null);
            }}
          />
          {shown.length === 0 && <p className="empty">Nothing here matches.</p>}
          {REVIEW_GROUPS.map((g) => {
            const items = shown.filter((i) => i.group === g.id);
            if (!items.length) return null;
            return (
              <section key={g.id}>
                <h3>
                  {g.label} <span className="dim num">{items.length}</span>
                </h3>
                <div className="list">
                  {items.map((i) => (
                    <ReviewRow key={i.swap.key} item={i} deck={current.deck} view={view} userId={userId} />
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
      <Orphans view={view} userId={userId} />
    </>
  );
}

/** Where this phone's answers are: waiting here, in Yama, or picked up by the planner. */
function SyncLine({ view, userId }: { view: PlanView; userId: string }) {
  const box = useOutbox(userId);
  const state = useOutboxState();
  const { pending_pull, pulled_at } = view.b.inputs;
  const n = box.pending.length;
  return (
    <div className="plan-sync small" role="status">
      {n > 0 && (
        <p>
          <span className="tag warn">{n === 1 ? "1 answer" : `${n} answers`} on this phone</span> waiting to sync
          {state.error ? `. Yama can't be reached (${state.error}); they go when you're back online.` : "."}{" "}
          <button className="quiet small" onClick={() => void outbox.sync(userId)} disabled={state.syncing}>
            {state.syncing ? "Sending…" : "Send now"}
          </button>
        </p>
      )}
      {pending_pull > 0 && (
        <p className="dim">
          {pending_pull === 1 ? "1 thing you did here is" : `${pending_pull} things you did here are`} waiting for {view.app} to pick {pending_pull === 1 ? "it" : "them"} up.
        </p>
      )}
      {pulled_at && <p className="faint">{view.app} last picked up your answers {fmtDate(pulled_at)}.</p>}
      {box.rejected.map((r) => (
        <p key={r.op.op_id}>
          <span className="tag bad">Not saved</span> Yama refused an answer{"swap_key" in r.op ? ` for ${r.op.swap_key.split("|").slice(2, 3).join("") || r.op.swap_key}` : ""}: {r.error}{" "}
          <button className="quiet small" onClick={() => outbox.dismiss(userId, r.op.op_id)}>Dismiss</button>
        </p>
      ))}
    </div>
  );
}

const ReviewRow = memo(function ReviewRow({ item, deck, view, userId }: { item: ReviewItem; deck: PlanDeck; view: PlanView; userId: string }) {
  const s = item.swap;
  const a = item.answer;
  const state = answerState(a, { source: deck.source, pulledThrough: view.b.inputs.pulled_through ?? 0, app: view.app });
  const status = swapStatus(s, deckLogs(deck), view.deckName);
  const send = (change: Partial<ReviewRecord>) => sendAnswer(userId, s.key, s.deck, a, change);
  const bench = item.quotes.filter((q) => q.kind === "market_benchmark");
  const stock = item.quotes.filter((q) => q.kind === "stock_check");
  const priced = s.src !== "owned";
  const id = view.oracleId(s.in);
  const market = priced && id ? view.b.market[id] : undefined;
  return (
    <div className={`swap-row review-row${a?.decision ? ` answered-${a.decision}` : ""}`}>
      <div className="swap-thumbs">
        {s.out ? <Thumb name={s.out} card={view.card(s.out)} oracleId={view.oracleId(s.out)} dim /> : <span className="plan-thumb-empty" aria-hidden />}
        <span className="swap-arrow" aria-hidden>→</span>
        <Thumb name={s.in} card={view.card(s.in)} oracleId={id} />
      </div>
      <div className="swap-body">
        <p className="swap-title">
          <b>{s.in}</b>
          {s.out ? <span className="dim"> for {s.out}</span> : <span className="dim"> (no slot)</span>}
        </p>
        <div className="row swap-tags">
          {s.role === "standin" && <span className="tag">Stand-in</span>}
          {s.role === "optional" && <span className="tag">Optional</span>}
          {s.tier && <span className="tag">{s.tier}</span>}
          {status && <StatusTag {...status} />}
          {s.game_changer && <span className="tag">Game Changer</span>}
        </div>
        <p className="small dim">{swapSource(s, view.ctx)}</p>
        {s.why && <p className="small">{s.why}</p>}
        {s.why_out && (
          <p className="small dim">
            {s.out ? `${s.out}: ` : ""}
            {s.why_out}
          </p>
        )}
        {s.when && <p className="small">{/^when\b/i.test(s.when) ? s.when : `When: ${s.when}`}</p>}
        {s.advice && <p className="small">{s.advice}</p>}
        {s.later_out && <p className="small">Later cut (suggested, not in the plan): {s.later_out}</p>}
        {s.note && <p className="small dim">Note: {s.note}</p>}
        {bench.map((q, i) => (
          <p key={`b${i}`} className="small dim">
            {q.source}: {usd(q.price)}
            {q.printing ? ` for ${q.printing}` : ""}, checked {fmtDate(q.checked)}.
          </p>
        ))}
        {priced && id && (
          <p className="small dim">
            {market ? `Yama's market price: ${usd(market.usd)} for ${market.printing}, ${fmtDate(market.date)} (${market.source}).` : "Yama's market price: no price in Yama's price data."}
          </p>
        )}
        {stock.length > 0 && (
          <ul className="small plan-stock">
            {stock.map((q, i) => (
              <StockLine key={i} q={q} view={view} />
            ))}
          </ul>
        )}

        <div className="plan-decide" role="group" aria-label={`Your answer for ${s.in}`}>
          {DECISIONS.map((d) => (
            <button key={d.id} className={`decide-${d.id}`} aria-pressed={a?.decision === d.id} onClick={() => send({ decision: toggleDecision(a?.decision, d.id) })}>
              {d.label}
            </button>
          ))}
        </div>
        {s.stage === "proposed" && <CutPicker deck={deck} suggested={s.out} value={a?.cut ?? null} onPick={(cut) => send({ cut })} />}
        <NoteBox value={a?.note ?? ""} label={`Note for ${s.in}`} onSave={(note) => send({ note })} />
        {a?.decision === "no" && s.stage === "planned" && (
          <p className="small">You said no. Nothing changes until you and your planner decide what to do with this swap.</p>
        )}
        {state && (
          <p className="small">
            <StatusTag {...state} />
            {a?.origin === "import" && a.at ? <span className="faint"> {fmtDate(a.at)}</span> : null}
          </p>
        )}
      </div>
    </div>
  );
});

function StockLine({ q, view }: { q: Quote; view: PlanView }) {
  const store = q.store_label ?? (q.store ? view.ctx.stores.get(q.store)?.name : null) ?? "A store";
  const result = q.result ?? (q.in_stock === true ? "In stock" : q.in_stock === false ? "Not in stock" : "Checked");
  return (
    <li>
      {store}: {q.url ? <a href={q.url} target="_blank" rel="noreferrer">{result}</a> : result}{" "}
      <span className="faint">
        (checked {fmtDate(q.checked)}; source: {q.source})
      </span>
    </li>
  );
}

/** Pick what a proposal takes out, from the after-prints list. Empty means its suggested cut. */
function CutPicker({ deck, suggested, value, onPick }: { deck: PlanDeck; suggested: string | null; value: string | null; onPick: (cut: string | null) => void }) {
  const names = useMemo(
    () => [...new Set((deck.states.after?.cards ?? []).filter((c) => c.board === "main").map((c) => c.name))].sort((x, y) => x.localeCompare(y)),
    [deck],
  );
  return (
    <label className="small plan-cut">
      Takes out
      <select value={value ?? ""} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">{suggested ? `${suggested} (suggested)` : "Pick a cut"}</option>
        {names
          .filter((n) => n !== suggested)
          .map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
      </select>
    </label>
  );
}

/** A note saved when the box loses focus, and only if it changed. */
function NoteBox({ value, label, onSave }: { value: string; label: string; onSave: (note: string) => void }) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const [seen, setSeen] = useState(value);
  if (value !== seen && !focused.current) {
    // The answer changed somewhere else (another device, an import): show it.
    setSeen(value);
    setText(value);
  }
  return (
    <textarea
      className="plan-note"
      aria-label={label}
      placeholder="Note: why, or what to try instead"
      value={text}
      rows={1}
      maxLength={2000}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        focused.current = false;
        setSeen(text);
        if (text.trim() !== value.trim()) onSave(text);
      }}
    />
  );
}

/** Answers whose swap left the plan (renamed with no alias, or removed). Kept, never dropped. */
function Orphans({ view, userId }: { view: PlanView; userId: string }) {
  const live = view.orphans.filter(([, r]) => isAnswer(r));
  if (!live.length) return null;
  return (
    <section className="plan-orphans stack">
      <h3>
        Answers for swaps no longer in the plan <span className="dim num">{live.length}</span>
      </h3>
      <p className="dim small">Yama keeps these so nothing you said is lost. Your planner sees them too.</p>
      <div className="list">
        {live.map(([key, r]) => (
          <div key={key} className="list-row">
            <span>
              <span className="title">{r.card ?? key.split("|")[2] ?? key}</span>
              <br />
              <span className="small dim">
                {r.deck ?? key.split("|")[1] ?? ""}
                {r.decision ? `. ${DECISIONS.find((d) => d.id === r.decision)?.label}` : ""}
                {r.cut ? `. Cut: ${r.cut}` : ""}
                {r.note ? `. ${r.note}` : ""}
              </span>
            </span>
            <button className="quiet small" onClick={() => sendAnswer(userId, key, null, r, { decision: null, note: null, cut: null })}>
              Clear
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
