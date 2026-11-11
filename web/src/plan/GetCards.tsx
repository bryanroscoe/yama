import {
  changeKind,
  changeStep,
  deckLogs,
  inForce,
  inForceBundle,
  inForceSwaps,
  planTrip,
  printPlan,
  spares as sparesOf,
  type PlanDeck,
  type Swap,
} from "@yama/core/plan";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { useScrollToHash } from "../components/useScrollToHash";
import { InstalledTick, sendBought, unmarkBought } from "./marks";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { planHref } from "./Plans";
import type { PlanView } from "./view";
import "./plans.css";
import { fmtDate, usd, plural } from "@yama/core";

const cardsWord = (n: number) => plural(n, "card");

/**
 * `/decks/plans/get` (design board "GetCards"): everything your approved plans still need, in the
 * order you'd do it: buy, print, move between decks, put in. Only plans in force count; one
 * waiting for your OK puts nothing here. `?deck=` shows one plan's.
 */
export function GetCards() {
  const { view, userId } = usePlanOutlet();
  const [params, setParams] = useSearchParams();
  useScrollToHash(true);
  const live = view.b.decks.filter((d) => inForce(view.planOf(d))).sort((a, b) => a.sort - b.sort);
  const deck = live.find((d) => d.key === params.get("deck")) ?? null;
  const shown = deck ? [deck] : live;
  const gated = useMemo(() => inForceBundle(view.b, view.planOf, view.answers, deck?.key), [view, deck?.key]);
  const trip = useMemo(
    () => planTrip({ ...gated, shopping_wants: deck ? [] : gated.shopping_wants, wishlist: [] }, { today: view.today, answers: view.answers, bought: (k) => !!view.markBy.get(k)?.bought?.value }),
    [gated, view, deck],
  );
  const prints = useMemo(() => printPlan(gated, { answers: view.answers, today: view.today }), [gated, view]);
  const spares = useMemo(() => sparesOf(gated, view.answers), [gated, view.answers]);
  const steps = useMemo(
    () => shown.flatMap((d) => inForceSwaps(d, view.planOf(d), view.b.swaps, view.answers).map((s) => ({ swap: s, deck: d, step: changeStep(s, view.markBy.get(s.key), view.ctx.orders) }))),
    [shown, view],
  );
  const swapOf = new Map(view.b.swaps.map((s) => [s.key, s]));
  const buyRows = trip.stops.flatMap((st) => st.rows.map((r) => ({ stop: st, row: r })));
  const bought = steps.filter((s) => changeKind(s.swap) === "buy" && view.markBy.get(s.swap.key)?.bought?.value && s.step !== "in");
  const notCovered = trip.print.filter((p) => p.want.needed);
  const moves = steps.filter((s) => s.step === "to_move");
  const putIn = steps.filter((s) => s.step === "in_hand");
  const free = [...spares.now, ...spares.extras].filter((x) => x.free);
  const byDeckPrints = new Map<string, number>();
  for (const l of prints.next.lines) byDeckPrints.set(l.deck?.name ?? l.swap.deck, (byDeckPrints.get(l.deck?.name ?? l.swap.deck) ?? 0) + 1);
  const placed = prints.placed.reduce((n, o) => n + o.count, 0);
  const pick = (key: string | null) => setParams(key ? { deck: key } : {}, { replace: true, preventScrollReset: true });
  const stores = trip.stops.map((s) => s.store.short ?? s.store.name);

  return (
    <>
      <PlansHead title="Get the cards" />
      <p className="dim plans-lede">Everything your approved plans still need, in the order you'd do it.</p>
      <p><Link to="/decks/plans/get/sourcing">Source cards across all decks</Link> — preview saved builds and optional real replacements together, including plans not yet approved.</p>
      {live.length === 0 ? (
        <div className="plans-empty">
          <p>Nothing to get yet. Approve a plan on <Link to="/decks/plans">Plans</Link> and its buys, prints and moves show up here.</p>
          {(view.b.shopping_wants?.length ?? 0) > 0 && (
            <p>
              Cards you added to your shopping list by hand are on the <Link to="/decks/plans/get/trip">store trip</Link>.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="segmented plans-filter" role="group" aria-label="Show plans">
            <button type="button" aria-pressed={!deck} onClick={() => pick(null)}>
              All approved plans
            </button>
            {live.map((d) => (
              <button key={d.key} type="button" aria-pressed={deck?.key === d.key} onClick={() => pick(d.key)}>
                {d.name}
              </button>
            ))}
          </div>

          <nav className="plans-steps" aria-label="Steps">
            <a href="#buy">
              <span className="plans-step-n">1</span>
              <b>Buy {buyRows.length}</b>
              <span className="small dim">{buyRows.length ? `${trip.total != null ? usd(trip.total) : "No prices"}${stores.length ? ` at ${stores.join(", ")}` : ""}` : "Nothing to buy"}</span>
            </a>
            <a href="#print">
              <span className="plans-step-n">2</span>
              <b>Print {prints.next.count}</b>
              <span className="small dim">On the next order</span>
            </a>
            <a href="#move">
              <span className="plans-step-n">3</span>
              <b>Move {moves.length}</b>
              <span className="small dim">From one deck to another</span>
            </a>
            <a href="#putin">
              <span className="plans-step-n">4</span>
              <b>Put in {putIn.length}</b>
              <span className="small dim">In hand, ready to sleeve</span>
            </a>
          </nav>

          <section id="buy" className="plans-section" aria-labelledby="h-buy">
            <div className="plans-section-head">
              <h2 id="h-buy">1. Buy</h2>
              <span className="dim">At the stores you go to, from their newest stock check, under your shopping rule. Tick each one as you buy it.</span>
            </div>
            {trip.stops.map((st) => (
              <div key={st.store.key} className="plans-store">
                <div className="plans-store-head">
                  <span className="plans-list-main">
                    <b>{st.store.name}</b>
                    <span className="small dim">
                      {cardsWord(st.rows.length)}, {usd(st.total)} listed before tax
                      {trip.checkedOn.length ? `, checked ${fmtDate(trip.checkedOn[trip.checkedOn.length - 1])}` : ""}
                    </span>
                  </span>
                  {st.cartUrl && (
                    <a className="button outline" href={st.cartUrl} target="_blank" rel="noreferrer">
                      Fill the cart
                    </a>
                  )}
                </div>
                <ul className="plans-rows">
                  {st.rows.map((r) => {
                    const s = swapOf.get(r.want.id);
                    return (
                      <li key={r.want.id} className="plans-row">
                        {s ? (
                          <label className="plans-check">
                            <input
                              type="checkbox"
                              checked={false}
                              onChange={() => sendBought(userId, s, { value: true, store_key: st.store.key, store_label: null, price_paid: r.offer.price, qty: 1, on: view.today })}
                              aria-label={`Bought ${r.want.card}`}
                            />
                          </label>
                        ) : null}
                        <span className="plans-row-main">
                          <b>{r.want.card}</b>
                          <span className="small dim">{r.offer.quote.printing ?? r.offer.quote.result ?? ""}</span>
                        </span>
                        <span className="small dim">for {r.want.deckName ?? "your list"}</span>
                        <span className="small">{usd(r.offer.price)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {buyRows.length === 0 && <p className="dim">Nothing to buy at your stores right now.</p>}
            {bought.length > 0 && (
              <details className="plans-details">
                <summary>Bought ({bought.length})</summary>
                <ul className="plans-rows">
                  {bought.map(({ swap: s, deck: d }) => (
                    <li key={s.key} className="plans-row">
                      <label className="plans-check">
                        <input type="checkbox" checked onChange={() => unmarkBought(userId, s)} aria-label={`Not bought: ${s.in}`} />
                      </label>
                      <span className="plans-row-main">
                        <b>{s.in}</b>
                      </span>
                      <span className="small dim">for {d.name}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {notCovered.length > 0 && (
              <details className="plans-details">
                <summary>Not at your stores or over your rule ({notCovered.length})</summary>
                <p className="small dim">These count toward no total. Print them, or check another store.</p>
                <ul className="plans-plain small">
                  {notCovered.map((p) => (
                    <li key={p.want.id}>
                      {p.want.card} <span className="dim">for {p.want.deckName ?? "your list"}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="small">
              <Link to={`/decks/plans/get/trip${deck ? `?deck=${encodeURIComponent(deck.key)}` : ""}`}>Plan the store trip</Link>: choose stores, compare fewer stops, carts, sealed products and your wishlist.
            </p>
          </section>

          <section id="print" className="plans-section" aria-labelledby="h-print">
            <div className="plans-section-head">
              <h2 id="h-print">2. Print</h2>
              <span className="dim">One order for every plan.</span>
            </div>
            <div className="plans-store">
              <span className="plans-list-main">
                <b>{cardsWord(prints.next.count)}</b>
                <span className="small dim">{[...byDeckPrints].map(([n, c]) => `${n} ${c}`).join(", ") || "Nothing for the next order yet."}</span>
                {prints.printer && prints.next.tier.size != null && (
                  <span className="small dim">
                    {prints.printer.name}'s next project size is {prints.next.tier.size}
                    {prints.next.tier.free ? `: ${prints.next.tier.free} free slots` : ""}.
                    {prints.next.estimate != null ? ` About ${usd(prints.next.estimate)}.` : ""}
                  </span>
                )}
              </span>
              {prints.next.count > 0 && (
                <div className="row plans-links">
                  <Link className="button primary" to="/decks/plans/get/mpc">
                    Print with MakePlayingCards
                  </Link>
                  <Link className="button outline" to="/decks/plans/get/swap-sheet">
                    Swap sheet
                  </Link>
                </div>
              )}
            </div>
            {placed > 0 && (
              <details className="plans-details">
                <summary>Ordered and on the way ({placed})</summary>
                <ul className="plans-plain small">
                  {prints.placed.map((o) => (
                    <li key={o.order.key}>
                      {o.order.vendor}
                      {o.order.date_ordered ? `, ordered ${fmtDate(o.order.date_ordered)}` : o.order.placed_by ? `, placed by ${fmtDate(o.order.placed_by)}` : ""}: {cardsWord(o.count)}
                    </li>
                  ))}
                </ul>
                <p className="small dim">When an order arrives, your plan file records it and its cards move to Put in.</p>
              </details>
            )}
          </section>

          <section id="move" className="plans-section" aria-labelledby="h-move">
            <div className="plans-section-head">
              <h2 id="h-move">3. Move between decks</h2>
              <span className="dim">Cards one plan takes from another deck. Do these when you rebuild both.</span>
            </div>
            {moves.length === 0 ? (
              <p className="dim">No moves waiting.</p>
            ) : (
              <ul className="plans-rows">
                {moves.map(({ swap: s, deck: d }) => (
                  <li key={s.key} className="plans-row">
                    <span className="plans-row-main">
                      <b>{s.in}</b>
                      <span className="small dim">
                        {moveFrom(s, view)} to {d.name}
                      </span>
                    </span>
                    <span className="small">{moveReady(s, d) ? "Ready" : "Waits for that deck's own change"}</span>
                  </li>
                ))}
              </ul>
            )}
            {free.length > 0 && (
              <details className="plans-details">
                <summary>Spares: out of a deck, in no plan ({free.length})</summary>
                <p className="small dim">Cards a plan took out that no other plan wants. Keep them for later plans, or sell them.</p>
                <ul className="plans-plain small">
                  {free.map((x) => (
                    <li key={`${x.from.key}/${x.card}`}>
                      {x.card} <span className="dim">from {x.from.name}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section id="putin" className="plans-section" aria-labelledby="h-putin">
            <div className="plans-section-head">
              <h2 id="h-putin">4. Put in</h2>
              <span className="dim">Cards you have now, by deck. The takeout sheet says what comes out for each.</span>
            </div>
            {putIn.length === 0 && <p className="dim">Nothing in hand waiting to go in.</p>}
            {shown
              .map((d) => ({ d, rows: putIn.filter((p) => p.deck.key === d.key) }))
              .filter((x) => x.rows.length)
              .map(({ d, rows }) => (
                <div key={d.key} className="plans-store">
                  <div className="plans-store-head">
                    <span className="plans-list-main">
                      <Link to={planHref(d.key)}>
                        <b>{d.name}</b>
                      </Link>
                      <span className="small dim">{rows.map((r) => r.swap.in).join(", ")}</span>
                    </span>
                    <div className="row plans-links">
                      <Link className="button outline" to={`/decks/plans/get/swap-sheet?sheet=takeout&deck=${encodeURIComponent(d.key)}`}>
                        Takeout sheet
                      </Link>
                      {d.yama_deck && (
                        <Link className="button outline" to={`/decks/${d.yama_deck.id}/scan`}>
                          Scan when done
                        </Link>
                      )}
                    </div>
                  </div>
                  <ul className="plans-rows">
                    {rows.map(({ swap: s }) => (
                      <li key={s.key} className="plans-row">
                        <span className="plans-row-main">
                          <b>{s.in}</b> {s.out && <span className="small dim">for {s.out}</span>}
                        </span>
                        <InstalledTick swap={s} view={view} userId={userId} compact short />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </section>

          <div className="small dim plans-footer-links">
            <Link to="/decks/plans/settings">Your stores and shopping rule</Link>
            <Link to="/decks/plans/get/swap-cards">Print swap cards</Link>
          </div>
        </>
      )}
    </>
  );
}

function moveFrom(s: Swap, view: PlanView): string {
  return s.got?.how === "deck" ? (s.got.deck_name ?? view.deckName(s.got.deck)) : "Another deck";
}

/** A move waits while the plan's now list says the donor deck still needs the card. */
function moveReady(s: Swap, d: PlanDeck): boolean {
  return deckLogs(d).now.get(s.key) !== "waiting-move";
}
