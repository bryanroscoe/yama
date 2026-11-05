import { CardRef, CardText } from "../components/CardRef";
import { fmtDate, orderText, printPlan, usd, type PrintLine, type PrintOrder } from "@yama/core/plan";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { artCredits } from "../components/ArtPanel";
import { Crop } from "../components/Crop";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { PrintsHowTo } from "./howto";
import { CopyButton } from "./parts";
import type { PlanView } from "./view";

/** How many lines an order shows before "Show all". */
const PEEK = 6;

/** `/decks/plan/prints`: what's on each print order, and what the next one would hold (design: Prints). */
export function Prints() {
  const { view } = usePlanOutlet();
  const plan = useMemo(() => printPlan(view.b, { answers: view.answers, today: view.today }), [view]);
  const printer = plan.printer?.name ?? "your printer";
  const nothing = !plan.placed.length && !plan.received.length && !plan.next.count;
  return (
    <>
      <PlansHead
        title="Prints"
        action={
          plan.placed.length || plan.received.length ? (
            <Link className="button outline" to="/decks/plan/prints/swap">
              Swap sheet
            </Link>
          ) : undefined
        }
      />
      <PrintsHowTo open={nothing} />
      {nothing && <p className="empty">No prints yet. Prints appear once a tracked plan prints a card.</p>}
      {plan.doubleFaced.length > 0 && (
        <p className="area-note">Double-faced: {plan.doubleFaced.map((l) => `${l.card} (print the back, ${l.back})`).join("; ")}.</p>
      )}
      <div className="prints-cols">
        <div className="prints-main">
          {plan.placed.map((o) => (
            <OrderSection key={o.order.key} o={o} view={view} />
          ))}
          {plan.received.map((o) => (
            <OrderSection key={o.order.key} o={o} view={view} />
          ))}
        </div>
        <NextOrder view={view} plan={plan} printer={printer} />
      </div>
    </>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const listText = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "Placed by 15 Oct 2026. Not arrived yet." and what isn't recorded about it. */
function orderLines(o: PrintOrder): { when: string; facts: string | null } {
  const ord = o.order;
  const when = ord.date_ordered ? `Placed ${fmtDate(ord.date_ordered)}` : ord.placed_by ? `Placed by ${fmtDate(ord.placed_by)}` : "Placed, date not recorded";
  const state = ord.status === "received" ? `Arrived${ord.date_fulfilled ? ` ${fmtDate(ord.date_fulfilled)}` : ""}.` : "Not arrived yet.";
  const missing = [ord.order_number ? null : "order number", ord.total == null && ord.subtotal == null ? "cost" : null, ord.card_stock ? null : "card stock"].filter(Boolean) as string[];
  const known = [ord.order_number ? `order ${ord.order_number}` : null, ord.total != null ? `total ${usd(ord.total)}` : null, ord.card_stock ? `card stock ${ord.card_stock}` : null].filter(Boolean) as string[];
  // The order's own note usually says what isn't recorded; don't say it twice.
  const notRecorded = missing.length && !/not recorded/i.test(ord.note ?? "") ? `${cap(listText(missing))} not recorded.` : "";
  const facts = [known.length ? `${cap(listText(known))}.` : "", notRecorded].filter(Boolean).join(" ");
  return { when: `${when}. ${state}`, facts: facts || null };
}

function OrderSection({ o, view }: { o: PrintOrder; view: PlanView }) {
  const [byDeck, setByDeck] = useState(false);
  const [all, setAll] = useState(false);
  const text = orderText(o.lines.map((l) => ({ card: l.card, qty: 1 })));
  const who = (o.order.store ? view.ctx.stores.get(o.order.store)?.name : null) ?? o.order.vendor;
  const { when, facts } = orderLines(o);
  const decks = new Set(o.lines.map((l) => l.deck?.key)).size;
  const sorted = byDeck ? [...o.lines].sort((a, b) => (a.deck?.sort ?? 0) - (b.deck?.sort ?? 0) || (a.card.toLowerCase() < b.card.toLowerCase() ? -1 : 1)) : o.lines;
  const shown = all ? sorted : sorted.slice(0, PEEK);
  return (
    <>
      <section className="prints-order" aria-label={`${o.order.status === "received" ? "Arrived" : "On order"}: ${who}`}>
        <div className="prints-order-head">
          <span className="prints-order-title">
            <span className="dim">{o.order.status === "received" ? "Arrived" : "On order"}</span>
            <h2>{who}</h2>
            <span className="dim">{when}</span>
          </span>
          <b className="prints-count num" aria-label={`${o.count} cards`}>
            {o.count}
          </b>
        </div>
        <span className="small dim">
          {o.distinct} different {o.distinct === 1 ? "card" : "cards"}. {facts ?? ""} {o.order.note ?? ""}
        </span>
        {o.missing.length > 0 && (
          <p className="small">
            <span className="pill warn">Check</span> In the plan as on this order but not on its card list: {o.missing.map((l) => `${l.card} (${l.deck?.name})`).join(", ")}.
          </p>
        )}
        {o.extra.length > 0 && (
          <p className="small">
            <span className="pill warn">Check</span> On the order's card list but no plan print accounts for: {o.extra.map((l) => `${l.qty} ${l.card}`).join(", ")}.
          </p>
        )}
        <div className="row">
          <CopyButton text={text} label="Copy the order" />
        </div>
      </section>

      <section className="plan-section" aria-label="What each print replaces">
        <div className="prints-lines-head">
          <h2 className="plan-section-head">What each print replaces</h2>
          <button className="quiet small" aria-pressed={byDeck} onClick={() => setByDeck(!byDeck)}>
            {byDeck ? "A to Z" : "By deck"}
          </button>
        </div>
        <PrintLines
          lines={shown}
          view={view}
          byDeck={byDeck}
          after={
            o.lines.length > PEEK && (
              <p className="small dim prints-more">
                {all ? null : `And ${o.lines.length - PEEK} more across ${decks} ${decks === 1 ? "deck" : "decks"}. `}
                <button className="quiet small" onClick={() => setAll(!all)}>
                  {all ? "Show fewer" : `Show all ${o.lines.length}`}
                </button>
              </p>
            )
          }
        />
      </section>
    </>
  );
}

function NextOrder({ view, plan, printer }: { view: PlanView; plan: ReturnType<typeof printPlan>; printer: string }) {
  const n = plan.next;
  const t = n.tier;
  const tierText = !t.tiers.length
    ? `No print tiers recorded for ${printer}.`
    : t.size == null
      ? `More than your largest recorded tier (${t.tiers[t.tiers.length - 1]}).`
      : `${t.free} free ${t.free === 1 ? "slot" : "slots"} in the ${t.size} tier. Recorded tiers: ${t.tiers.join(", ")}; smaller steps may not be recorded.`;
  const fill = t.size ? Math.min(1, n.count / t.size) : null;
  return (
    <section className="prints-next" aria-labelledby="prints-next">
      <div className="prints-next-head">
        <h2 id="prints-next">Next order, draft</h2>
        <span className="small dim num">{t.size && n.count ? `${n.count} of ${t.size}` : n.count ? `${n.count} ${n.count === 1 ? "card" : "cards"}` : "Empty"}</span>
      </div>
      {fill != null && n.count > 0 && (
        <span className="prints-bar" role="img" aria-label={`${n.count} of ${t.size} slots used`}>
          <span style={{ width: `${(fill * 100).toFixed(1)}%` }} />
        </span>
      )}
      {n.count === 0 ? (
        <p className="small dim">No prints waiting.</p>
      ) : (
        <>
          <p className="small">{tierText}</p>
          <p className="small dim">
            {n.each != null
              ? `Print cost: ${n.eachNote ?? `${usd(n.each)} a card`}; ${n.eachNote?.startsWith("at least") ? "at least " : "about "}${usd(n.estimate)} total.`
              : "No print cost in your settings."}
          </p>
          <div className="row">
            <CopyButton text={orderText(n.lines.map((l) => ({ card: l.card, qty: 1 })))} label="Copy the next order" />
            <Link className="button outline" to="/decks/plan/prints/mpc">
              Print with MakePlayingCards
            </Link>
          </div>
          <PrintLines lines={n.lines} view={view} byDeck={false} />
        </>
      )}
    </section>
  );
}

function PrintLines({ lines, view, byDeck, after }: { lines: PrintLine[]; view: PlanView; byDeck: boolean; after?: ReactNode }) {
  let lastDeck: string | null = null;
  const artists = lines.flatMap((l) => [l.card, l.standin?.in ?? l.takesOut]).map((n) => view.card(n)?.artist);
  return (
    <div className="prints-lines">
      {lines.map((l) => {
        const head = byDeck && l.deck?.key !== lastDeck ? l.deck?.name ?? "No deck" : null;
        lastDeck = l.deck?.key ?? null;
        const out = l.standin ? l.standin.in : l.takesOut;
        return (
          <div key={l.swap.key}>
            {head && <h3 className="plan-group-head">{head}</h3>}
            <div className="prints-line">
              <Crop src={view.card(l.card)?.image_art_crop} />
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M19 12H5M11 6l-6 6 6 6" />
              </svg>
              <Crop src={out ? view.card(out)?.image_art_crop : null} empty={!out} />
              <span className="prints-line-text">
                <b><CardRef name={l.card} oracleId={view.oracleId(l.card)} image={view.card(l.card)?.image_normal}/></b>
                <span>
                  {byDeck ? "" : `${l.deck?.name ?? "No deck"}, `}
                  <CardText text={l.standin
                    ? `replaces the stand-in ${l.standin.in}, which holds ${l.cut}'s slot.${l.standin.later_out ? ` Its later cut, ${l.standin.later_out}, is a suggestion, not in the plan.` : ""}`
                    : l.takesOut ? `replaces ${l.takesOut}.` : "no slot named."} names={[l.standin?.in,l.cut,l.standin?.later_out,l.takesOut].filter((n):n is string=>!!n)}/>
                </span>
                {(l.proposed || l.back) && (
                  <span className="prints-line-pills">
                    {l.proposed && <span className="pill">Proposed, you want it</span>}
                    {l.back && <span className="pill warn">Double-faced: print {l.back}</span>}
                  </span>
                )}
              </span>
            </div>
          </div>
        );
      })}
      {after}
      {artists.some(Boolean) && <p className="small dim">{artCredits(artists)}</p>}
    </div>
  );
}
