// Installed ticks and "bought it" marks, and the market price line the plan pages share. Ticks and
// marks are the owner's claims: they go to the planner's inbox as ops and never change a list or
// make an order. A missing price stays "no price".
import {
  basisText,
  boughtInfo,
  cheapestMarket,
  installedState,
  markState,
  opTime,
  type BoughtOp,
  type InstalledOp,
  type Mark,
  type MarketBasis,
  type Swap,
} from "@yama/core/plan";
import { useState } from "react";
import { Link } from "react-router";
import { Button, Dialog, StatusPill } from "../components/ui";
import { deviceId, outbox } from "./outbox";
import type { PlanView } from "./view";
import { fmtDate, usd, NO_PRICE } from "@yama/core";

function stateOf(view: PlanView, s: Swap, m: Mark | undefined) {
  const deck = view.deck(s.deck);
  return markState(m, { source: deck?.source ?? "import", pulledThrough: view.b.inputs.pulled_through ?? 0, app: view.app });
}

/**
 * Whether a planned swap is in the deck. With a Yama deck, its current list says (read only; edit
 * the deck to change it). Without one, "I've put this in the deck": a tick, starting from the
 * planner's install record (a newer tick here wins), with where the tick is on its way and when
 * the state is the planner's.
 */
export function InstalledTick({ swap, view, userId, compact = false, short = false }: { swap: Swap; view: PlanView; userId: string; compact?: boolean; short?: boolean }) {
  const m = view.markBy.get(swap.key)?.installed;
  const st = installedState(swap, m);
  const on = st.on;
  // The deck decides: no tick to set, just what its current list says and where to change it.
  const yd = view.deck(swap.deck)?.yama_deck;
  if (st.from === "deck" && yd) {
    const card = swap.role === "standin" ? swap.in : "This swap";
    return (
      <div className={`plan-tick plan-tick-deck${compact ? " small" : ""}${short ? " plan-tick-short" : ""}`}>
        <StatusPill tone={on || swap.deck_superseded ? "good" : "neutral"}>
          {on ? "In the deck" : swap.deck_superseded ? "Its print is in" : st.skipped ? "Skipped" : "Not in the deck yet"}
        </StatusPill>
        {!short && (
          <span className="faint small">
            {on
              ? `${card} is in ${yd.name}'s current list.`
              : swap.deck_superseded
                ? `${swap.in} is out of ${yd.name}: the print it held a slot for is in.`
                : `${card} isn't in ${yd.name}'s current list.`}{" "}
            <Link to={`/decks/${yd.id}`}>{on ? "Open the deck" : "Change the deck"}</Link>
          </span>
        )}
      </div>
    );
  }
  const state = m && st.from === "yama" ? stateOf(view, swap, m) : null;
  const agrees = st.on === (st.planStatus === "installed");
  const plan = !st.planStatus
    ? null
    : st.from === "yama" && !agrees
      ? `Recorded as ${st.planStatus} in ${view.app}; your newer tick here wins.`
      : st.planStatus === "skipped"
        ? `Recorded as skipped in ${view.app}, so it isn't waiting to go in.`
        : `Recorded as installed in ${view.app}.`;
  const toggle = () => {
    const op: InstalledOp = { kind: "installed", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), swap_key: swap.key, deck_key: swap.deck, value: !on };
    outbox.enqueue(userId, op);
  };
  return (
    <div className={`plan-tick${compact ? " small" : ""}${short ? " plan-tick-short" : ""}`}>
      <label>
        <input type="checkbox" checked={on} onChange={toggle} />
        {short ? "In the deck" : swap.role === "standin" ? `I've put ${swap.in} in the deck` : "I've put this in the deck"}
      </label>
      {plan && <span className="faint small">{plan}</span>}
      {state && (on || state.tone === "warn") && <span className="faint small">{state.label}.</span>}
    </div>
  );
}

/** Where a bought mark is, in words: what you said, then whether the plan has an order for it. */
export function BoughtLine({ swap, view }: { swap: Swap; view: PlanView }) {
  const m = view.markBy.get(swap.key)?.bought;
  const info = boughtInfo(m);
  if (!m || !info) return null;
  const store = info.store_label ?? (info.store_key ? view.ctx.stores.get(info.store_key)?.short ?? view.ctx.stores.get(info.store_key)?.name : null);
  const outcome = view.b.inputs.outcomes.find((o) => o.op_id === m.op_id)?.outcome;
  const order = swap.order_item ? view.ctx.orders.get(swap.order_item.order) : undefined;
  const state = stateOf(view, swap, m);
  return (
    <p className="small plan-bought">
      You marked this bought{info.on ? ` on ${fmtDate(info.on)}` : ""}
      {store ? ` at ${store}` : ""}
      {info.price_paid != null ? ` for ${usd(info.price_paid)}` : ", price not given"}
      {info.qty > 1 ? ` (${info.qty} copies)` : ""}.{" "}
      {order
        ? `Recorded as order ${order.vendor}${order.date_ordered ? `, ${fmtDate(order.date_ordered)}` : ""}.`
        : outcome
          ? `${outcome.replace(/\.$/, "")}.`
          : "It isn't an order until your plan records it."}
      {state && !order && !outcome && <span className="faint"> {state.label}.</span>}
    </p>
  );
}

export function sendBought(userId: string, swap: Swap, fields: Omit<BoughtOp, "kind" | "op_id" | "device_id" | "at" | "swap_key" | "deck_key">) {
  const op: BoughtOp = { kind: "bought", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), swap_key: swap.key, deck_key: swap.deck, ...fields };
  outbox.enqueue(userId, op);
}

/** Take back a bought mark ("I didn't buy it after all"). */
export function unmarkBought(userId: string, swap: Swap) {
  sendBought(userId, swap, { value: false, store_key: null, store_label: null, price_paid: null, qty: 1, on: null });
}

/** "Mark bought": which store, what you paid (optional), how many and when. */
export function MarkBoughtSheet({ swap, view, userId, storeKey, onClose }: { swap: Swap; view: PlanView; userId: string; storeKey: string | null; onClose: () => void }) {
  const stores = view.b.stores.filter((s) => !s.retired && s.kind !== "printer");
  const [store, setStore] = useState<string>(storeKey ?? stores[0]?.key ?? "");
  const [other, setOther] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("1");
  const [on, setOn] = useState(view.today);
  const priceValue = price.trim() === "" ? null : Number(price);
  const priceOk = priceValue == null || (Number.isFinite(priceValue) && priceValue >= 0);
  const qtyValue = Math.floor(Number(qty));
  const ok = priceOk && qtyValue >= 1 && qtyValue <= 100 && /^\d{4}-\d{2}-\d{2}$/.test(on) && (store !== "" || other.trim() !== "");
  const submit = () => {
    if (!ok) return;
    sendBought(userId, swap, {
      value: true,
      store_key: store || null,
      store_label: store ? null : other.trim(),
      price_paid: priceValue == null ? null : Math.round(priceValue * 100) / 100,
      qty: qtyValue,
      on,
    });
    onClose();
  };
  return (
    <Dialog title={<>Mark {swap.in} bought</>} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="dim small">
          This goes to your {view.app} inbox. It isn't an order and doesn't count the card as yours until your plan records the purchase.
        </p>
        <label>
          Where
          <select value={store} onChange={(e) => setStore(e.target.value)}>
            {stores.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
            <option value="">Somewhere else</option>
          </select>
        </label>
        {store === "" && (
          <label>
            Store
            <input value={other} onChange={(e) => setOther(e.target.value)} maxLength={200} required />
          </label>
        )}
        <label>
          Paid for one copy (leave empty if you don't know)
          <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder={NO_PRICE} />
        </label>
        {!priceOk && <p className="error small">A price is a number, like 0.75.</p>}
        <div className="row">
          <label style={{ flex: "1 1 6rem" }}>
            Copies
            <input type="number" min={1} max={100} value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label style={{ flex: "2 1 10rem" }}>
            Bought on
            <input type="date" value={on} onChange={(e) => setOn(e.target.value)} required />
          </label>
        </div>
        <div className="row">
          <Button type="submit" variant="primary" disabled={!ok}>Mark bought</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** "Market: $0.51 for AFC #175, 18 Oct 2026 (TCGplayer market via Scryfall, cheapest non-foil)." */
export function marketSentence(m: MarketBasis | null, known = true, label = "Market"): string {
  if (!known) return `${label}: this card isn't in Yama's card data yet.`;
  if (!m) return `${label}: no price in Yama's price data.`;
  const what = m.kind === "recorded" ? `${label} (recorded in your plan)` : label;
  return `${what}: ${basisText(m)} (${m.source}).${m.stale ? " That's older than Yama's other prices." : ""}`;
}

/** Yama's cheapest market price for a card, as a sentence, with its date (and "last priced" when old). */
export function MarketLine({ card, view }: { card: string; view: PlanView }) {
  return <p className="small dim">{marketSentence(cheapestMarket(card, view.b), !!view.oracleId(card))}</p>;
}

