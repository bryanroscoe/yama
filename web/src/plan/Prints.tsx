import { fmtDate, orderText, printPlan, usd, type PrintLine, type PrintOrder } from "@yama/core/plan";
import { useMemo, useState } from "react";
import { usePlanOutlet } from "./PlanLayout";
import { CopyButton, Thumb } from "./parts";
import type { PlanView } from "./view";

/** `/decks/plan/prints`: what's on each print order, and what the next one would hold. */
export function Prints() {
  const { view } = usePlanOutlet();
  const plan = useMemo(() => printPlan(view.b, { answers: view.answers, today: view.today }), [view]);
  const printer = plan.printer?.name ?? "your printer";
  const nothing = !plan.placed.length && !plan.received.length && !plan.next.count;
  return (
    <>
      <div className="page-head">
        <h1>Prints</h1>
      </div>
      {nothing && <p className="empty">No prints in the plan.</p>}
      {plan.doubleFaced.length > 0 && (
        <p className="plan-callout small">
          Double-faced: {plan.doubleFaced.map((l) => `${l.card} (print the back, ${l.back})`).join("; ")}.
        </p>
      )}
      {plan.placed.map((o) => (
        <OrderSection key={o.order.key} o={o} view={view} />
      ))}
      <NextOrder view={view} plan={plan} printer={printer} />
      {plan.received.map((o) => (
        <OrderSection key={o.order.key} o={o} view={view} />
      ))}
    </>
  );
}

function orderSentence(o: PrintOrder, view: PlanView): string {
  const ord = o.order;
  const who = (ord.store ? view.ctx.stores.get(ord.store)?.name : null) ?? ord.vendor;
  const when = ord.date_ordered ? `placed ${fmtDate(ord.date_ordered)}` : ord.placed_by ? `placed by ${fmtDate(ord.placed_by)}` : "placed, date not recorded";
  const state = ord.status === "received" ? `arrived${ord.date_fulfilled ? ` ${fmtDate(ord.date_fulfilled)}` : ""}` : "not arrived";
  const missing = [ord.order_number ? null : "order number", ord.total == null && ord.subtotal == null ? "cost" : null, ord.card_stock ? null : "card stock"].filter(Boolean);
  const known = [ord.order_number ? `order ${ord.order_number}` : null, ord.total != null ? `total ${usd(ord.total)}` : null, ord.card_stock ? `card stock ${ord.card_stock}` : null].filter(Boolean);
  // The order's own note usually says what isn't recorded; don't say it twice.
  const notRecorded = missing.length && !/not recorded/i.test(ord.note ?? "") ? ` ${cap(listText(missing as string[]))} not recorded.` : "";
  return `${who}, ${when}, ${state}.${known.length ? ` ${cap(listText(known as string[]))}.` : ""}${notRecorded}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const listText = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function OrderSection({ o, view }: { o: PrintOrder; view: PlanView }) {
  const [byDeck, setByDeck] = useState(false);
  const text = orderText(o.lines.map((l) => ({ card: l.card, qty: 1 })));
  return (
    <section className="stack plan-store">
      <h3>
        {o.order.status === "received" ? "Arrived" : "On order"} <span className="dim small num">{o.count === 1 ? "1 card" : `${o.count} cards`}, {o.distinct} different</span>
      </h3>
      <p className="small">{orderSentence(o, view)}</p>
      {o.order.note && <p className="dim small">{o.order.note}</p>}
      {o.missing.length > 0 && (
        <p className="small">
          <span className="tag warn">Check</span> In the plan as on this order but not on its card list: {o.missing.map((l) => `${l.card} (${l.deck?.name})`).join(", ")}.
        </p>
      )}
      {o.extra.length > 0 && (
        <p className="small">
          <span className="tag warn">Check</span> On the order's card list but no plan print accounts for: {o.extra.map((l) => `${l.qty} ${l.card}`).join(", ")}.
        </p>
      )}
      <div className="row">
        <CopyButton text={text} label="Copy the order" />
        <button className="quiet" aria-pressed={byDeck} onClick={() => setByDeck(!byDeck)}>
          {byDeck ? "A to Z" : "By deck"}
        </button>
      </div>
      <PrintLines lines={o.lines} view={view} byDeck={byDeck} />
    </section>
  );
}

function NextOrder({ view, plan, printer }: { view: PlanView; plan: ReturnType<typeof printPlan>; printer: string }) {
  const n = plan.next;
  const t = n.tier;
  const tierText = !t.tiers.length
    ? `No print tiers recorded for ${printer}.`
    : t.size == null
      ? `More than your largest recorded tier (${t.tiers[t.tiers.length - 1]}).`
      : `Fits the ${t.size} tier with ${t.free} free ${t.free === 1 ? "slot" : "slots"}. Recorded tiers: ${t.tiers.join(", ")}; smaller steps may not be recorded.`;
  return (
    <section className="stack plan-store">
      <h3>
        Next order <span className="dim small num">{n.count === 1 ? "1 card" : `${n.count} cards`}</span>
      </h3>
      {n.count === 0 ? (
        <p className="dim small">Nothing yet. Planned prints that aren't on a placed order, and proposed prints you want, go here.</p>
      ) : (
        <>
          <p className="small">{tierText}</p>
          <p className="small dim">
            {n.each != null
              ? `Print cost ${n.eachNote ?? `${usd(n.each)} each`} (your setting), so ${n.eachNote?.startsWith("at least") ? "at least " : "about "}${usd(n.estimate)} for these. A print cost, not a market price.`
              : "No print cost in your settings."}
          </p>
          <div className="row">
            <CopyButton text={orderText(n.lines.map((l) => ({ card: l.card, qty: 1 })))} label="Copy the next order" />
          </div>
          <PrintLines lines={n.lines} view={view} byDeck={false} />
        </>
      )}
    </section>
  );
}

function PrintLines({ lines, view, byDeck }: { lines: PrintLine[]; view: PlanView; byDeck: boolean }) {
  const sorted = byDeck ? [...lines].sort((a, b) => (a.deck?.sort ?? 0) - (b.deck?.sort ?? 0) || (a.card.toLowerCase() < b.card.toLowerCase() ? -1 : 1)) : lines;
  let lastDeck: string | null = null;
  return (
    <div className="list">
      {sorted.map((l) => {
        const head = byDeck && l.deck?.key !== lastDeck ? l.deck?.name ?? "No deck" : null;
        lastDeck = l.deck?.key ?? null;
        return (
          <div key={l.swap.key}>
            {head && <h4 className="plan-group-head">{head}</h4>}
            <div className="list-row plan-print">
              <Thumb name={l.card} card={view.card(l.card)} oracleId={view.oracleId(l.card)} />
              <span>
                <span className="title">{l.card}</span>
                <br />
                <span className="small dim">
                  {byDeck ? "" : `${l.deck?.name ?? "No deck"}. `}
                  {l.standin
                    ? `Takes out the stand-in ${l.standin.in}, which holds ${l.cut}'s slot.${l.standin.later_out ? ` Its later cut, ${l.standin.later_out}, is a suggestion, not in the plan.` : ""}`
                    : l.takesOut
                      ? `Takes out ${l.takesOut}.`
                      : "No slot named."}
                </span>
              </span>
              <span className="row plan-slot-tags">
                {l.proposed && <span className="tag">Proposed, you want it</span>}
                {l.back && <span className="tag warn">Double-faced: print {l.back}</span>}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
