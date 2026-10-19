import {
  basisText,
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
import { artCredits } from "../components/ArtPanel";
import { Crop } from "../components/Crop";
import { Details } from "../components/ui";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { BoughtLine, MarkBoughtSheet, marketSentence, unmarkBought } from "./marks";
import type { PlanView } from "./view";

const DECIDED: Record<string, { label: string; tone: "good" | "warn" | "plain" }> = {
  want: { label: "You want it", tone: "good" },
  unsure: { label: "Unsure", tone: "warn" },
  no: { label: "You said no", tone: "plain" },
};

/** "Market $3.44" from the row's market basis, or what Yama is missing. */
function marketShort(r: BuyRow, view: PlanView): string {
  if (!view.oracleId(r.swap.in) && r.market?.kind !== "recorded") return "Not in Yama's card data yet";
  if (!r.market) return "No market price";
  return `Market ${usd(r.market.usd)}`;
}

/** `/decks/plan/buy`: every card to buy, by the store whose cart it can go in (design: Buy). */
export function Buy() {
  const { view, userId } = usePlanOutlet();
  const list = useMemo(() => buyList(view.b, { answers: view.answers, marks: view.markBy }), [view]);
  const [marking, setMarking] = useState<BuyRow | null>(null);
  const settings = view.b.settings as unknown as RuleSet[];
  const rules = rulesAt(settings, view.today);
  const unsettled = rules?.rules.needs_confirmation ?? [];
  const limit = rules?.rules.max_over_market_pct;
  const asOf = view.b.prices_as_of;
  const age = daysBetween(asOf, view.today);
  const cartNames = cartStoreNames(view.b.stores);
  const recorded = view.b.swaps.filter((s) => !s.retired && s.order_item && view.markBy.get(s.key)?.bought?.value);
  const realOrders = view.b.orders.filter((o) => o.kind === "real" && !o.retired);
  const row = (r: BuyRow) => <BuyItem key={r.swap.key} r={r} view={view} onMark={() => setMarking(r)} />;
  const shownArtists = [...list.stores.flatMap((g) => g.rows), ...list.noPrice, ...list.elsewhere].map((r) => view.card(r.swap.in)?.artist);

  return (
    <>
      <PlansHead title="Buy list" />
      <div className="area-note warn" role="note">
        <p>
          {list.checkedOn.length ? `Stock and prices checked ${list.checkedOn.map(fmtDate).join(", ")}. Recheck before going in.` : "No store stock checks in the plan."}
          {limit != null ? ` Your rule: never more than ${limit}% over market.` : ""}
          {age != null && age > STALE_DAYS ? ` Yama's prices haven't updated for ${age} days.` : ""}
        </p>
        <Details>
          <p>
            A market price isn't a quote from any store, and a listing doesn't promise the card is still there.{" "}
            {asOf ? `Market prices are TCGplayer market via Scryfall, as of ${fmtDate(asOf)}.` : "Yama has no market prices for these cards yet."} Flags use your
            shopping rules in force on each check date.
          </p>
          {unsettled.length > 0 && <p>Not settled yet: {unsettled.join("; ")}.</p>}
        </Details>
      </div>

      <div className="plan-figures">
        <div className="plan-figure">
          <b className="num">{list.count}</b>
          <span>cards to buy</span>
        </div>
        {list.total != null ? (
          <div className="plan-figure">
            <b className="num">{usd(list.total)}</b>
            <span>listed at stores, before tax{list.unpriced ? `; ${list.unpriced} without a listed price` : ""}</span>
          </div>
        ) : list.unpriced > 0 ? (
          <div className="plan-figure">
            <b className="num">{list.unpriced}</b>
            <span>without a listed price, so no total</span>
          </div>
        ) : null}
        {list.marked.length > 0 && (
          <div className="plan-figure">
            <b className="num">{list.marked.length}</b>
            <span>marked bought, not recorded yet</span>
          </div>
        )}
      </div>

      {list.count === 0 && list.marked.length === 0 && <p className="empty">Nothing to buy. Proposals to buy show up here until you say no or your plan records the order.</p>}

      <div className="buy-stores">
        {list.stores.map((g) => (
          <section key={g.store.key} className="buy-store" aria-label={g.store.name}>
            <header className="buy-store-head">
              <span className="buy-store-name">
                <b>{g.store.name}</b>
                <span>
                  {g.rows.length === 1 ? "1 card" : `${g.rows.length} cards`}, {usd(g.total)} before tax
                  {g.store.location ? `. ${g.store.location}` : ""}
                </span>
              </span>
              {g.cartUrl && (
                <a className="button primary buy-cart" href={g.cartUrl} target="_blank" rel="noreferrer" title="Replaces what's in that cart now">
                  Fill the cart
                </a>
              )}
            </header>
            {g.store.note && <p className="buy-store-note">{g.store.note}</p>}
            {g.rows.map(row)}
            {g.cartUrl && <p className="buy-store-note">Filling the {g.store.short ?? g.store.name} cart replaces what's in it now.</p>}
          </section>
        ))}
      </div>

      {list.noPrice.length > 0 && (
        <section className="buy-store" aria-label="In stock, no listed price">
          <header className="buy-store-head">
            <span className="buy-store-name">
              <b>In stock, no listed price</b>
              <span>Ask the store for the price first. Not in a cart link or the totals.</span>
            </span>
          </header>
          {list.noPrice.map(row)}
        </section>
      )}

      {list.elsewhere.length > 0 && (
        <section className="plan-section buy-elsewhere" aria-labelledby="buy-elsewhere">
          <h2 id="buy-elsewhere" className="plan-section-head">
            Not stocked at {cartNames.length ? "your stores" : "a store with a cart link"} <span className="num dim">{list.elsewhere.length}</span>
          </h2>
          <p className="small dim">
            {cartNames.length ? `Not at ${cartNames.join(" or ")}. ` : ""}Ask in store, or add them to the next print order.
          </p>
          {list.elsewhere.map((r) => (
            <ElsewhereRow key={r.swap.key} r={r} view={view} onMark={() => setMarking(r)} />
          ))}
        </section>
      )}
      {shownArtists.some(Boolean) && <p className="small dim art-credits">{artCredits(shownArtists)}</p>}

      {(list.marked.length > 0 || recorded.length > 0) && (
        <section className="plan-section" aria-labelledby="buy-marked">
          <h2 id="buy-marked" className="plan-section-head">
            Marked bought <span className="num dim">{list.marked.length + recorded.length}</span>
          </h2>
          <p className="dim small">Out of the totals and carts. A card counts as yours once your plan records the order.</p>
          {list.marked.map((r) => (
            <div key={r.swap.key} className="buy-row is-bought">
              <Crop src={view.card(r.swap.in)?.image_art_crop} />
              <span className="buy-row-text">
                <span className="buy-row-top">
                  <b>{r.swap.in}</b>
                </span>
                <span className="buy-row-meta">{r.deck?.name}</span>
                <BoughtLine swap={r.swap} view={view} />
                <span className="row">
                  <button className="quiet small" onClick={() => setMarking(r)}>Change</button>
                  <button className="quiet small" onClick={() => unmarkBought(userId, r.swap)}>I didn't buy it</button>
                </span>
              </span>
            </div>
          ))}
          {recorded.map((s) => (
            <div key={s.key} className="buy-row is-bought">
              <Crop src={view.card(s.in)?.image_art_crop} />
              <span className="buy-row-text">
                <span className="buy-row-top">
                  <b>{s.in}</b>
                </span>
                <span className="buy-row-meta">{view.deckName(s.deck)}</span>
                <BoughtLine swap={s} view={view} />
              </span>
            </div>
          ))}
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
        <section className="plan-section" aria-labelledby="buy-orders">
          <h2 id="buy-orders" className="plan-section-head">Your orders</h2>
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

function BuyItem({ r, view, onMark }: { r: BuyRow; view: PlanView; onMark: () => void }) {
  const s = r.swap;
  const decided: { label: string; tone: "good" | "warn" | "plain" } =
    (r.decision ? DECIDED[r.decision] : undefined) ?? (s.stage === "planned" ? { label: "In the plan", tone: "good" } : { label: "Not decided", tone: "plain" });
  const q = r.listing;
  return (
    <div className="buy-row">
      <Crop src={view.card(s.in)?.image_art_crop} />
      <span className="buy-row-text">
        <span className="buy-row-top">
          <b>{s.in}</b>
          <b className="num">{q ? usd(r.price) : ""}</b>
        </span>
        <span className="buy-row-meta">
          {r.deck?.name}
          {r.replaces ? `, replaces ${r.replaces}${r.yourCut ? " (your cut)" : ""}` : ", no slot named"}
        </span>
        {q && (
          <span className="buy-row-meta">
            {q.result ?? "Listed"}
            {q.price_from_text ? " (price from the stock note)" : ""}, checked {fmtDate(q.checked)}. {marketShort(r, view)}
            {r.market ? (r.market.kind === "recorded" ? " (recorded in your plan)" : `, ${r.market.date ? fmtDate(r.market.date) : "no date"}`) : ""}
          </span>
        )}
        {!q && <span className="buy-row-meta">{marketSentence(r.market, !!view.oracleId(s.in) || r.market?.kind === "recorded")}</span>}
        {r.check?.flags.map((f) => (
          <span key={f.id} className={`buy-flag${f.tone === "warn" ? " warn" : ""}`}>
            {f.text}
          </span>
        ))}
        {r.check?.rules && r.check.flags.length > 0 && (
          <span className="buy-row-meta">
            Judged by your rules from {fmtDate(r.check.rules.effective_from)}
            {r.check.rules.note ? ` (${r.check.rules.note})` : ""}.
          </span>
        )}
        {r.others.length > 0 && (
          <span className="buy-row-meta">
            Also checked:{" "}
            {r.others.map((o, i) => (
              <span key={i}>
                {i > 0 ? "; " : ""}
                {o.store_label ?? (o.store ? view.ctx.stores.get(o.store)?.name : null) ?? "a store"}{" "}
                {o.url ? (
                  <a href={o.url} target="_blank" rel="noreferrer">
                    {o.result ?? (o.in_stock === false ? "not in stock" : "checked")}
                  </a>
                ) : (
                  o.result ?? (o.in_stock === false ? "not in stock" : "checked")
                )}{" "}
                ({fmtDate(o.checked)})
              </span>
            ))}
          </span>
        )}
        {s.advice && <span className="buy-row-meta">{s.advice}</span>}
        {r.decision === "no" && s.stage === "planned" && <span className="buy-row-meta">You said no. Nothing changes until you and your planner decide what to do with this swap.</span>}
        <span className="buy-row-actions">
          <button className="buy-mark" onClick={onMark}>Mark bought</button>
          <span className={`pill${decided.tone === "plain" ? " quiet" : ` ${decided.tone}`}`}>{decided.label}</span>
          {s.stage === "proposed" && <span className="pill quiet">Proposed</span>}
          {s.stage === "planned" && s.role === "standin" && <span className="pill quiet">Stand-in</span>}
        </span>
      </span>
    </div>
  );
}

/** A card no store with a cart has: who else was checked, and the market price. */
function ElsewhereRow({ r, view, onMark }: { r: BuyRow; view: PlanView; onMark: () => void }) {
  const s = r.swap;
  const other = r.others.find((o) => o.in_stock !== false) ?? r.others[0];
  const otherStore = other ? (other.store_label ?? (other.store ? view.ctx.stores.get(other.store)?.name : null) ?? "a store") : null;
  return (
    <div className="buy-mini">
      <Crop src={view.card(s.in)?.image_art_crop} size="sm" />
      <span className="buy-mini-text">
        <b>{s.in}</b>
        <span>
          {r.deck?.name}
          {r.replaces ? `, replaces ${r.replaces}` : ""}.{" "}
          {other ? (
            <>
              {otherStore}: {other.url ? <a href={other.url} target="_blank" rel="noreferrer">{other.result ?? (other.in_stock === false ? "not in stock" : "checked")}</a> : other.result ?? (other.in_stock === false ? "not in stock" : "checked")}
              {other.price != null ? `, ${usd(other.price)}` : ""} ({fmtDate(other.checked)})
            </>
          ) : (
            "No store stock recorded"
          )}
        </span>
        {r.decision && <span className={DECIDED[r.decision]?.tone === "good" ? "good" : undefined}>{DECIDED[r.decision]?.label}</span>}
      </span>
      <span className="buy-mini-side">
        <span className="num" title={r.market ? `${basisText(r.market)} (${r.market.source})` : undefined}>
          {r.market ? `Market ${usd(r.market.usd)}` : "No price"}
        </span>
        {r.market && <span className="small dim">{r.market.kind === "recorded" ? "Recorded in your plan" : r.market.date ? fmtDate(r.market.date) : "No date"}</span>}
        <button className="quiet small" onClick={onMark}>Mark bought</button>
      </span>
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
