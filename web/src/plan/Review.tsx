import { CardHover, CardRef } from "../components/CardRef";
import {
  answerState,
  buyList,
  cheapestMarket,
  deckLogs,
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
  toggleDecision,
  usd,
  type Decision,
  type PlanDeck,
  type PriceFlag,
  type Quote,
  type Review as Answer,
  type ReviewFilter,
  type ReviewItem,
  type ReviewRecord,
} from "@yama/core/plan";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router";
import { artCredits } from "../components/ArtPanel";
import { Crop } from "../components/Crop";
import { Details, ZoomableCard } from "../components/ui";
import { deviceId, outbox, useOutbox, useOutboxState } from "./outbox";
import { AskClaude } from "../advisor/AskClaude";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { marketSentence } from "./marks";
import type { PlanView } from "./view";

const DECISIONS: { id: Decision; label: string; key: string }[] = [
  { id: "want", label: "Want", key: "W" },
  { id: "unsure", label: "Unsure", key: "U" },
  { id: "no", label: "No", key: "N" },
];
const DECISION_WORD: Record<Decision, string> = { want: "Want", unsure: "Unsure", no: "Don't want" };

/** The filter chips in the order the design shows them. */
const FILTER_ORDER: ReviewFilter[] = ["undecided", "want", "unsure", "no", "proposed", "all"];

/** Queue a full answer for a swap key. The page shows it at once; the outbox sends it. */
function sendAnswer(userId: string, swapKey: string, deckKey: string | null, current: Answer | undefined, change: Partial<ReviewRecord>) {
  const record = reviewRecord(current, change);
  outbox.enqueue(userId, { kind: "review", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), swap_key: swapKey, deck_key: deckKey, ...record });
}

const WIDE = "(min-width: 1100px)";
const subscribeWide = (cb: () => void) => {
  const m = window.matchMedia(WIDE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
/** Laptops get the queue beside one proposal; narrower screens a column of cards. */
function useWide(): boolean {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE).matches, () => false);
}

/** A Scryfall image URL at another size ("small" to "normal"), for bundles saved before the full image was sent. */
function normalOf(url: string | null | undefined): string | null {
  return url ? url.replace("/small/", "/normal/") : null;
}

/** `/decks/plan/review`: answer every swap and proposal, deck by deck, on or offline (design: Review, ReviewWide). */
export function Review() {
  const { view, userId } = usePlanOutlet();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const decks = useMemo(() => reviewItems(view.b, view.answers), [view]);
  // Price flags (over your limit, cheaper as a print...) from the buy list, by swap.
  const flags = useMemo(() => {
    const list = buyList(view.b, { answers: view.answers, marks: view.markBy });
    const m = new Map<string, PriceFlag[]>();
    for (const r of [...list.stores.flatMap((g) => g.rows), ...list.noPrice, ...list.elsewhere, ...list.declined]) if (r.check?.flags.length) m.set(r.swap.key, r.check.flags);
    return m;
  }, [view]);
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
  const ordered = REVIEW_GROUPS.flatMap((g) => shown.filter((i) => i.group === g.id));
  const imported = view.b.decks.some((d) => d.source === "import");
  const selKey = params.get("item");
  const selected = ordered.find((i) => i.swap.key === selKey) ?? ordered[0] ?? null;
  const selIndex = selected ? ordered.indexOf(selected) : -1;
  const select = (i: ReviewItem | undefined) => i && set("item", i.swap.key);

  // Laptop keys: W, U and N answer the open proposal; J and K move through the queue.
  const live = useRef({ selected, ordered, selIndex, userId, select });
  live.current = { selected, ordered, selIndex, userId, select };
  useEffect(() => {
    if (!wide) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      const { selected: sel, ordered: list, selIndex: at, userId: uid, select: go } = live.current;
      const k = e.key.toLowerCase();
      const pick = DECISIONS.find((d) => d.key.toLowerCase() === k);
      if (pick && sel) {
        e.preventDefault();
        sendAnswer(uid, sel.swap.key, sel.swap.deck, sel.answer, { decision: toggleDecision(sel.answer?.decision, pick.id) });
      } else if ((k === "j" || k === "k") && list.length) {
        e.preventDefault();
        go(list[Math.max(0, Math.min(list.length - 1, at + (k === "j" ? 1 : -1)))]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide]);

  const left = current ? current.counts.undecided : 0;
  // Keep the chosen deck's chip in view when the row scrolls sideways.
  const chipsRef = useRef<HTMLDivElement>(null);
  const currentKey = current?.deck.key;
  useEffect(() => {
    const row = chipsRef.current;
    const chip = row?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (row && chip && (chip.offsetLeft < row.scrollLeft || chip.offsetLeft + chip.offsetWidth > row.scrollLeft + row.clientWidth)) {
      row.scrollLeft = chip.offsetLeft - 8;
    }
  }, [currentKey]);
  const filters = current && (
    <div className="review-filters" role="group" aria-label="Show">
      {FILTER_ORDER.map((id) => {
        const f = REVIEW_FILTERS.find((x) => x.id === id)!;
        return (
          <button key={id} aria-pressed={id === filter} onClick={() => set("show", id === "all" ? null : id)}>
            {f.label} <span className="num">{current.counts[id]}</span>
          </button>
        );
      })}
    </div>
  );
  const search = (
    <input
      type="search"
      className="review-search"
      value={query}
      placeholder={wide ? "Search" : "Search cards, reasons, stores and notes"}
      aria-label="Search cards, reasons, stores and notes"
      onChange={(e) => {
        setQuery(e.target.value);
        set("q", e.target.value || null);
      }}
    />
  );

  return (
    <>
      <PlansHead title="Review" status={<SyncStatus view={view} userId={userId} />} action={<AskClaude context={{ kind: "review" }} about="your proposals" />} />
      <Details label="How review works">
        {imported && <p>
          Your answers go to your {view.app} inbox. A want joins the plan when the plan is updated there; a no on a planned swap changes nothing until you and
          your planner decide.
        </p>}
        <p>Keyboard shortcuts: W want, U unsure, N no. J and K move between proposals.</p>
      </Details>
      <SyncLine view={view} userId={userId} />
      <div className="review-decks" role="tablist" aria-label="Decks" ref={chipsRef}>
        {decks.map((d) => {
          const art = view.art(d.deck);
          return (
            <button key={d.deck.key} role="tab" aria-selected={d.deck.key === current?.deck.key} onClick={() => set("deck", d.deck.key)}>
              {art ? <img src={art} alt="" className="review-deck-art" loading="lazy" /> : <span className="review-deck-art" />}
              {d.deck.name}
              <span className="num review-deck-count">
                {d.counts.undecided}/{d.counts.all}
              </span>
            </button>
          );
        })}
      </div>

      {current && wide && (
        <div className="review-panes">
          <nav className="review-queue" aria-label="Proposals">
            {search}
            {filters}
            {ordered.length === 0 && <p className="empty">Nothing here matches.</p>}
            {REVIEW_GROUPS.map((g) => {
              const items = ordered.filter((i) => i.group === g.id);
              if (!items.length) return null;
              return (
                <div key={g.id} className="review-queue-group">
                  <h2 className="review-queue-head">
                    {g.label} <span className="num">{items.length}</span>
                  </h2>
                  {items.map((i) => (
                    <QueueRow key={i.swap.key} item={i} view={view} current={i === selected} onPick={() => select(i)} />
                  ))}
                </div>
              );
            })}
            {ordered.length > 0 && <p className="small dim">{artCredits(ordered.map((i) => view.card(i.swap.in)?.artist))}</p>}
          </nav>
          <section className="review-detail" aria-label={selected ? `${selected.swap.in}${selected.swap.out ? ` for ${selected.swap.out}` : ""}` : "Proposal"}>
            {selected ? (
              <ReviewCard
                key={selected.swap.key}
                item={selected}
                deck={current.deck}
                view={view}
                userId={userId}
                flags={flags.get(selected.swap.key)}
                wide
                position={`${selIndex + 1} of ${ordered.length}`}
                left={left}
              />
            ) : (
              <p className="empty">Pick a proposal.</p>
            )}
          </section>
        </div>
      )}
      {current && !wide && (
        <>
          {filters}
          {search}
          {ordered.length === 0 && <p className="empty">Nothing here matches.</p>}
          {REVIEW_GROUPS.map((g) => {
            const items = ordered.filter((i) => i.group === g.id);
            if (!items.length) return null;
            return (
              <section key={g.id} className="review-group">
                <h2 className="review-group-head">
                  {g.label} <span className="num">{items.length}</span>
                </h2>
                {items.map((i) => (
                  <ReviewCard key={i.swap.key} item={i} deck={current.deck} view={view} userId={userId} flags={flags.get(i.swap.key)} />
                ))}
              </section>
            );
          })}
          {ordered.length > 0 && <p className="small dim">Card images from Scryfall. ™ &amp; © Wizards of the Coast.</p>}
        </>
      )}
      <Orphans view={view} userId={userId} />
      {decks.some((d) => view.art(d.deck)) && (
        <p className="small dim review-credit">{artCredits(decks.map((d) => (view.art(d.deck) ? view.card(d.deck.commander[0])?.artist : null)))}</p>
      )}
    </>
  );
}

/** Where this phone's answers are, in one line with a dot: waiting here, in Yama, or picked up. */
function SyncStatus({ view, userId }: { view: PlanView; userId: string }) {
  const box = useOutbox(userId);
  const { pending_pull, pulled_at } = view.b.inputs;
  const n = box.pending.length;
  const [tone, text] =
    n > 0
      ? ["warn", "Saved on this phone, waiting to sync"]
      : pending_pull > 0
        ? ["plain", `${pending_pull} waiting for ${view.app} to pick up`]
        : pulled_at
          ? ["good", `Picked up by ${view.app}, ${fmtDate(pulled_at)}`]
          : [null, null];
  if (!text) return null;
  return (
    <span className={`review-status ${tone}`} role="status">
      {text}
    </span>
  );
}

/** The details behind the status: answers to send now, and any Yama refused. */
function SyncLine({ view, userId }: { view: PlanView; userId: string }) {
  const box = useOutbox(userId);
  const state = useOutboxState();
  const { pending_pull, pulled_at } = view.b.inputs;
  const n = box.pending.length;
  if (!n && !box.rejected.length && !pending_pull && !pulled_at) return null;
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

function QueueRow({ item, view, current, onPick }: { item: ReviewItem; view: PlanView; current: boolean; onPick: () => void }) {
  const s = item.swap;
  const d = item.answer?.decision ?? null;
  return (
    <button className="review-qrow" aria-current={current ? "true" : undefined} onClick={onPick}>
      <Crop src={view.card(s.in)?.image_art_crop} size="sm" />
      <span className="review-qrow-text">
        <span className="review-qrow-in"><CardHover name={s.in} oracleId={view.oracleId(s.in)} image={view.card(s.in)?.image_normal}/></span>
        <span className="review-qrow-out">{s.out?<>for <CardHover name={s.out} oracleId={view.oracleId(s.out)} image={view.card(s.out)?.image_normal}/></>:"no slot"}</span>
      </span>
      <span className={`review-qrow-state ${d ?? "open"}`}>{d ? DECISION_WORD[d] : "Open"}</span>
    </button>
  );
}

const ReviewCard = memo(function ReviewCard({
  item,
  deck,
  view,
  userId,
  flags,
  wide = false,
  position,
  left,
}: {
  item: ReviewItem;
  deck: PlanDeck;
  view: PlanView;
  userId: string;
  flags: PriceFlag[] | undefined;
  wide?: boolean;
  position?: string;
  left?: number;
}) {
  const s = item.swap;
  const a = item.answer;
  const state = answerState(a, { source: deck.source, pulledThrough: view.b.inputs.pulled_through ?? 0, app: view.app });
  const status = swapStatus(s, deckLogs(deck), view.deckName, view.ctx.orders);
  const send = (change: Partial<ReviewRecord>) => sendAnswer(userId, s.key, s.deck, a, change);
  const bench = item.quotes.filter((q) => q.kind === "market_benchmark");
  const stock = item.quotes.filter((q) => q.kind === "stock_check");
  const priced = s.src !== "owned";
  const id = view.oracleId(s.in);
  const inCard = view.card(s.in);
  const outCard = view.card(s.out);
  const Title = wide ? "h2" : "b";
  return (
    <article className={`review-card${wide ? " is-wide" : ""}${a?.decision ? ` answered-${a.decision}` : ""}`} aria-label={wide ? undefined : `${s.in}${s.out ? ` for ${s.out}` : ""}`}>
      <figure className="review-fig">
        <span className="review-stack">
          <ZoomableCard src={inCard?.image_normal ?? normalOf(inCard?.image_small)} name={s.in} className="card-img review-in" />
          {s.out && (
            <span className="review-cut">
              <ZoomableCard src={outCard?.image_normal ?? normalOf(outCard?.image_small)} name={s.out} className="card-img review-out" />
              <span>Cut</span>
            </span>
          )}
        </span>
        {wide && <figcaption className="small dim">Card images from Scryfall. ™ &amp; © Wizards of the Coast.</figcaption>}
      </figure>
      <div className="review-body">
        <div className="review-title">
          <Title className="review-name"><CardRef name={s.in} oracleId={view.oracleId(s.in)} image={inCard?.image_normal}/></Title>
          <span className="dim">
            {s.out?<>for <CardRef name={s.out} oracleId={view.oracleId(s.out)} image={outCard?.image_normal}/></>:"No slot named"}
            {position ? `. ${s.stage === "proposed" ? "Proposal" : "Swap"} ${position}` : ""}
            {wide && left != null ? `, ${left} not decided in ${deck.name}` : ""}.
          </span>
        </div>
        <span className="review-pills">
          {status && <span className={`pill${status.tone === "plain" ? "" : ` ${status.tone}`}`}>{status.label}</span>}
          {s.stage === "proposed" && <span className="pill quiet">Proposed</span>}
          {s.role === "standin" && <span className="pill">Stand-in</span>}
          {s.role === "optional" && <span className="pill">Optional</span>}
          {s.tier && <span className="pill quiet">{s.tier}</span>}
          {s.game_changer && <span className="pill quiet">Game Changer</span>}
        </span>
        {s.why && (
          <p className="review-why">
            <b>Why:</b> {s.why}
          </p>
        )}
        {s.why_out && (
          <p className="review-why dim">
            <b>Why cut:</b> {s.why_out}
          </p>
        )}
        <p className="small dim review-source">{swapSource(s, view.ctx)}</p>
        {s.when && <p className="small">{/^when\b/i.test(s.when) ? s.when : `When: ${s.when}`}</p>}
        {s.advice && <p className="small">{s.advice}</p>}
        {s.later_out && <p className="small">Later cut (suggested, not in the plan): {s.later_out}</p>}
        {s.note && <p className="small dim">Note: {s.note}</p>}

        {priced && (stock.length > 0 || bench.length > 0 || !!id || !!flags?.length) && (
          <div className="review-prices">
            {stock.map((q, i) => (
              <StockLine key={i} q={q} view={view} />
            ))}
            {bench.map((q, i) => (
              <span key={`b${i}`} className="review-price dim">
                <span>
                  {q.source}
                  {q.printing ? `, ${q.printing}` : ""}, checked {fmtDate(q.checked)}
                </span>
                <span className="num">{usd(q.price)}</span>
              </span>
            ))}
            {id && <span className="review-price dim review-market">{marketSentence(cheapestMarket(s.in, view.b), true, "Yama's market price")}</span>}
            {flags?.map((f) => (
              <span key={f.id} className={`review-flag${f.tone === "warn" ? " warn" : ""}`}>
                {f.text}
              </span>
            ))}
          </div>
        )}

        <div className="review-decide" role="group" aria-label={`Your answer for ${s.in}`}>
          {DECISIONS.map((d) => (
            <button
              key={d.id}
              className={`decide-${d.id}`}
              aria-pressed={a?.decision === d.id}
              aria-keyshortcuts={wide ? d.key : undefined}
              onClick={() => send({ decision: toggleDecision(a?.decision, d.id) })}
            >
              {d.id === "no" && !wide ? "Don't want" : d.label}
              {wide && <span className="review-key" aria-hidden="true">{d.key}</span>}
            </button>
          ))}
        </div>
        <div className="review-fields">
          {s.stage === "proposed" && <CutPicker deck={deck} suggested={s.out} value={a?.cut ?? null} onPick={(cut) => send({ cut })} />}
          <NoteBox value={a?.note ?? ""} label={`Note for ${s.in}`} onSave={(note) => send({ note })} />
        </div>
        {a?.decision === "no" && s.stage === "planned" && (
          <p className="small">You said no. Nothing changes until you and your planner decide what to do with this swap.</p>
        )}
        {state && (
          <p className="small dim review-state">
            {state.label}
            {a?.origin === "import" && a.at ? `, ${fmtDate(a.at)}` : ""}.
          </p>
        )}
      </div>
    </article>
  );
});

function StockLine({ q, view }: { q: Quote; view: PlanView }) {
  const store = q.store_label ?? (q.store ? view.ctx.stores.get(q.store)?.name : null) ?? "A store";
  const result = q.result ?? (q.in_stock === true ? "In stock" : q.in_stock === false ? "Not in stock" : "Checked");
  return (
    <span className="review-stock">
      <span className="review-price">
        <span>
          {store}: {result}
        </span>
        <b className="num">{q.price != null ? usd(q.price) : q.in_stock === false ? "" : "No price"}</b>
      </span>
      <span className="review-price dim small">
        <span>
          Checked {fmtDate(q.checked)}; source: {q.source}
        </span>
        {q.url && (
          <a href={q.url} target="_blank" rel="noreferrer">
            Store page
          </a>
        )}
      </span>
    </span>
  );
}

/** Pick what a proposal takes out, from the after-prints list. Empty means its suggested cut. */
function CutPicker({ deck, suggested, value, onPick }: { deck: PlanDeck; suggested: string | null; value: string | null; onPick: (cut: string | null) => void }) {
  const names = useMemo(
    () => [...new Set((deck.states.after?.cards ?? []).filter((c) => c.board === "main").map((c) => c.name))].sort((x, y) => x.localeCompare(y)),
    [deck],
  );
  return (
    <label className="review-field">
      Cut something else
      <select value={value ?? ""} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">{suggested ? `${suggested} (proposed)` : "Pick a cut"}</option>
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
    <label className="review-field">
      Note
      <input
        aria-label={label}
        placeholder="Anything to tell the planner"
        value={text}
        maxLength={2000}
        onFocus={() => (focused.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          focused.current = false;
          setSeen(text);
          if (text.trim() !== value.trim()) onSave(text);
        }}
      />
    </label>
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
                {r.decision ? `. ${DECISION_WORD[r.decision]}` : ""}
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
