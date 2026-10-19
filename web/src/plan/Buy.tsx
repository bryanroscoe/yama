import {
  buyList,
  cartStoreNames,
  daysBetween,
  deliveryList,
  fmtDate,
  rulesAt,
  STALE_DAYS,
  usd,
  type BuyRow,
  type Order,
  type RuleSet,
} from "@yama/core/plan";
import { useMemo, useState } from "react";
import { usePlanOutlet } from "./PlanLayout";
import { BoughtLine, MarkBoughtSheet, marketSentence, unmarkBought } from "./marks";
import { StatusTag, Thumb } from "./parts";
import type { PlanView } from "./view";

const DECIDED: Record<string, { label: string; tone: "good" | "warn" | "plain" }> = {
  want: { label: "You want it", tone: "good" },
  unsure: { label: "Unsure", tone: "warn" },
  no: { label: "You said no", tone: "plain" },
};

/** `/decks/plan/buy`: every card to buy, by the store whose cart it can go in. */
export function Buy() {
  const { view, userId } = usePlanOutlet();
  const list = useMemo(() => buyList(view.b, { answers: view.answers, marks: view.markBy }), [view]);
  const [marking, setMarking] = useState<BuyRow | null>(null);
  const settings = view.b.settings as unknown as RuleSet[];
  const unsettled = rulesAt(settings, view.today)?.rules.needs_confirmation ?? [];
  const asOf = view.b.prices_as_of;
  const age = daysBetween(asOf, view.today);
  const cartNames = cartStoreNames(view.b.stores);
  const recorded = view.b.swaps.filter((s) => !s.retired && s.order_item && view.markBy.get(s.key)?.bought?.value);
  const realOrders = view.b.orders.filter((o) => o.kind === "real" && !o.retired);
  const row = (r: BuyRow) => <BuyItem key={r.swap.key} r={r} view={view} userId={userId} onMark={() => setMarking(r)} />;

  return (
    <>
      <div className="page-head">
        <h1>Buy</h1>
      </div>
      <div className="plan-banner small">
        <p>
          {list.checkedOn.length
            ? `Stock and prices were checked ${list.checkedOn.map(fmtDate).join(", ")}; recheck before going in.`
            : "No store stock checks in the plan."}{" "}
          A market price isn't a quote from any store, and a listing doesn't promise the card is still there.
        </p>
        <p className="dim">
          {asOf ? `Market prices are TCGplayer market via Scryfall, as of ${fmtDate(asOf)}.` : "Yama has no market prices for these cards yet."}
          {age != null && age > STALE_DAYS ? ` Yama's prices haven't updated for ${age} days.` : ""} Flags use your shopping rules in force on each check date.
          {unsettled.length > 0 ? ` Not settled yet: ${unsettled.join("; ")}.` : ""}
        </p>
      </div>

      <div className="figures">
        <div className="figure">
          <b className="num">{list.count}</b>
          <span>cards to buy</span>
        </div>
        {list.total != null ? (
          <div className="figure">
            <b className="num">{usd(list.total)}</b>
            <span>
              listed, before tax{list.unpriced ? `; ${list.unpriced} without a listed price` : ""}
            </span>
          </div>
        ) : list.unpriced > 0 ? (
          <div className="figure">
            <b className="num">{list.unpriced}</b>
            <span>without a listed price, so no total</span>
          </div>
        ) : null}
        {list.marked.length > 0 && (
          <div className="figure">
            <b className="num">{list.marked.length}</b>
            <span>marked bought, not recorded yet</span>
          </div>
        )}
      </div>

      {list.count === 0 && list.marked.length === 0 && <p className="empty">Nothing to buy. Proposals to buy show up here until you say no or your plan records the order.</p>}

      {list.stores.map((g) => (
        <section key={g.store.key} className="stack plan-store">
          <h3>
            {g.store.name} <span className="dim small num">{g.rows.length === 1 ? "1 card" : `${g.rows.length} cards`}, {usd(g.total)} before tax at listed prices</span>
          </h3>
          {g.store.location && <p className="dim small">{g.store.location}{g.store.note ? `. ${g.store.note}` : ""}</p>}
          {g.cartUrl && (
            <p className="row">
              <a className="button primary" href={g.cartUrl} target="_blank" rel="noreferrer">
                Fill the {g.store.short ?? g.store.name} cart
              </a>
              <span className="faint small">Replaces what's in that cart now.</span>
            </p>
          )}
          <div className="list">{g.rows.map(row)}</div>
        </section>
      ))}

      {list.noPrice.length > 0 && (
        <section className="stack plan-store">
          <h3>
            In stock, no listed price <span className="dim num">{list.noPrice.length}</span>
          </h3>
          <p className="dim small">A store lists these, but the check didn't record a price, so they aren't in a cart link or the totals. Ask the store for the price first.</p>
          <div className="list">{list.noPrice.map(row)}</div>
        </section>
      )}

      {list.elsewhere.length > 0 && (
        <section className="stack plan-store">
          <h3>
            Not stocked at {cartNames.length ? cartNames.join(" or ") : "a store with a cart link"} <span className="dim num">{list.elsewhere.length}</span>
          </h3>
          <p className="dim small">Ask in store, or print these with the next print order.</p>
          <div className="list">{list.elsewhere.map(row)}</div>
        </section>
      )}

      {(list.marked.length > 0 || recorded.length > 0) && (
        <section className="stack plan-store">
          <h3>
            Marked bought <span className="dim num">{list.marked.length + recorded.length}</span>
          </h3>
          <p className="dim small">Out of the totals and carts. A card counts as yours once your plan records the order.</p>
          <div className="list">
            {list.marked.map((r) => (
              <div key={r.swap.key} className="swap-row">
                <Thumb name={r.swap.in} card={view.card(r.swap.in)} oracleId={view.oracleId(r.swap.in)} />
                <div className="swap-body">
                  <p className="swap-title">
                    <b>{r.swap.in}</b> <span className="dim">{r.deck?.name}</span>
                  </p>
                  <BoughtLine swap={r.swap} view={view} />
                  <div className="row">
                    <button className="quiet small" onClick={() => setMarking(r)}>Change</button>
                    <button className="quiet small" onClick={() => unmarkBought(userId, r.swap)}>I didn't buy it</button>
                  </div>
                </div>
              </div>
            ))}
            {recorded.map((s) => (
              <div key={s.key} className="swap-row">
                <Thumb name={s.in} card={view.card(s.in)} oracleId={view.oracleId(s.in)} />
                <div className="swap-body">
                  <p className="swap-title">
                    <b>{s.in}</b> <span className="dim">{view.deckName(s.deck)}</span>
                  </p>
                  <BoughtLine swap={s} view={view} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {list.declined.length > 0 && (
        <details className="plan-fold">
          <summary>
            Left out because you said no <span className="dim num">{list.declined.length}</span>
          </summary>
          <ul className="small">
            {list.declined.map((r) => (
              <li key={r.swap.key}>
                {r.swap.in} <span className="dim">({r.deck?.name})</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {realOrders.length > 0 && (
        <section className="stack plan-orders">
          <h3>Your orders</h3>
          <p className="dim small">Each order A to Z, with the deck each card goes in, for sorting a delivery.</p>
          {realOrders.map((o) => (
            <Delivery key={o.key} order={o} view={view} />
          ))}
        </section>
      )}

      {marking && <MarkBoughtSheet swap={marking.swap} view={view} userId={userId} storeKey={marking.store?.key ?? null} onClose={() => setMarking(null)} />}
    </>
  );
}

function BuyItem({ r, view, userId, onMark }: { r: BuyRow; view: PlanView; userId: string; onMark: () => void }) {
  const s = r.swap;
  const decided: { label: string; tone: "good" | "warn" | "plain" } =
    (r.decision ? DECIDED[r.decision] : undefined) ?? (s.stage === "planned" ? { label: "In the plan", tone: "good" } : { label: "Not decided", tone: "plain" });
  const q = r.listing;
  return (
    <div className="swap-row">
      <div className="swap-thumbs">
        {r.replaces ? <Thumb name={r.replaces} card={view.card(r.replaces)} oracleId={view.oracleId(r.replaces)} dim /> : <span className="plan-thumb-empty" aria-hidden />}
        <span className="swap-arrow" aria-hidden>→</span>
        <Thumb name={s.in} card={view.card(s.in)} oracleId={view.oracleId(s.in)} />
      </div>
      <div className="swap-body">
        <p className="swap-title">
          <b>{s.in}</b> <span className="dim">{r.deck?.name}</span>
        </p>
        <p className="small">
          {r.replaces ? <>For {r.replaces}{r.yourCut ? " (your cut)" : ""}.</> : "No slot named."}
        </p>
        <div className="row swap-tags">
          <StatusTag {...decided} />
          {s.stage === "proposed" && <span className="tag">Proposed</span>}
          {s.stage === "planned" && s.role === "standin" && <span className="tag">Stand-in</span>}
        </div>
        {q ? (
          <p className="small">
            <b className="num">{usd(r.price)}</b>
            {q.price_from_text ? " (from the stock note)" : ""} at {r.store?.short ?? r.store?.name}: {q.result ?? "listed"}{" "}
            <span className="faint">
              (checked {fmtDate(q.checked)}; {q.source})
            </span>
          </p>
        ) : null}
        <p className="small dim">{marketSentence(r.market, !!view.oracleId(s.in) || r.market?.kind === "recorded")}</p>
        {r.check?.flags.map((f) => (
          <p key={f.id} className="small">
            <span className={`tag${f.tone === "warn" ? " warn" : ""}`}>{f.tone === "warn" ? "Check" : "Note"}</span> {f.text}
          </p>
        ))}
        {r.check?.rules && r.check.flags.length > 0 && <p className="faint small">Judged by your rules from {fmtDate(r.check.rules.effective_from)}{r.check.rules.note ? ` (${r.check.rules.note})` : ""}.</p>}
        {r.others.length > 0 && (
          <ul className="small plan-stock">
            {r.others.map((o, i) => (
              <li key={i}>
                {o.store_label ?? (o.store ? view.ctx.stores.get(o.store)?.name : null) ?? "A store"}:{" "}
                {o.url ? (
                  <a href={o.url} target="_blank" rel="noreferrer">
                    {o.result ?? (o.in_stock === false ? "Not in stock" : "Checked")}
                  </a>
                ) : (
                  o.result ?? (o.in_stock === false ? "Not in stock" : "Checked")
                )}{" "}
                <span className="faint">(checked {fmtDate(o.checked)})</span>
              </li>
            ))}
          </ul>
        )}
        {s.advice && <p className="small">{s.advice}</p>}
        {r.decision === "no" && s.stage === "planned" && <p className="small">You said no. Nothing changes until you and your planner decide what to do with this swap.</p>}
        <div className="row">
          <button className="small" onClick={onMark}>Mark bought</button>
        </div>
      </div>
    </div>
  );
}

const SCAN: Record<string, string> = { ok: "Scanned as listed", diff: "Scanned as another printing" };

function Delivery({ order, view }: { order: Order; view: PlanView }) {
  const lines = useMemo(() => deliveryList(order, view.b), [order, view.b]);
  const store = order.store ? view.ctx.stores.get(order.store) : undefined;
  const cards = order.items.reduce((n, i) => n + i.qty, 0);
  const scanDate = view.b.library?.scan?.date;
  return (
    <details className="plan-fold">
      <summary>
        {store?.name ?? order.vendor}
        {order.date_ordered ? `, ordered ${fmtDate(order.date_ordered)}` : ""} <span className="dim small num">{cards === 1 ? "1 card" : `${cards} cards`}</span>
      </summary>
      <p className="small dim">
        {order.total != null ? `Total ${usd(order.total)}` : order.subtotal != null ? `Subtotal ${usd(order.subtotal)}` : "Total not recorded"}
        {order.subtotal_note ? ` (${order.subtotal_note.replace(/\.$/, "")})` : ""}.
        {order.fulfillment ? ` ${order.fulfillment.charAt(0).toUpperCase()}${order.fulfillment.slice(1)}.` : ""}
        {scanDate ? ` Scan from ${fmtDate(scanDate)}.` : ""}
      </p>
      <div className="list">
        {lines.map((l) => (
          <div key={l.line} className="list-row plan-delivery">
            <span>
              <span className="title">
                {l.qty > 1 ? `${l.qty} ` : ""}
                {l.card}
              </span>
              <br />
              <span className="small dim">
                {l.deck ? view.deckName(l.deck) : "No deck"}
                {l.replaces ? `, for ${l.replaces}` : ""}
                {l.role && l.role !== "plan card" ? `. ${l.role.charAt(0).toUpperCase()}${l.role.slice(1)}` : ""}.
              </span>
              {l.flags.length > 0 && (
                <>
                  <br />
                  <span className="small">{l.flags.map((f) => f.text).join(" ")}</span>
                </>
              )}
            </span>
            <span className="small plan-delivery-side">
              <span className="num">{l.unitPrice == null ? "price not recorded" : usd(l.unitPrice)}</span>
              {l.arrived === false ? (
                <span className="tag bad">Never arrived</span>
              ) : l.scans.length ? (
                l.scans.map((x, i) => (
                  <span key={i} className={`tag${x.scan === "ok" ? " good" : x.scan === "diff" ? " warn" : ""}`}>
                    {x.scan ? SCAN[x.scan] : "Not in the scan"}
                    {x.scan === "diff" && x.scanned ? ` (${x.scanned.set.toUpperCase()} ${x.scanned.num})` : ""}
                  </span>
                ))
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
