import { useEffect, useRef, useState } from "react";
import { api, ApiError, usd } from "../api";
import { ErrorText } from "../components/ui";
import type { SellCard } from "./sellList";
import { canCheck, currentOffer, offerKey, offerTotals, type BuylistOffer } from "./buylistOffers";

const LABELS: Record<BuylistOffer["status"], string> = {
  accepting: "Online offer", not_accepting: "Not currently accepting", unmatched: "No exact match",
  check_printing: "Check printing", ambiguous: "Check printing", unknown: "Offer unknown",
};
function url(c: SellCard) { return `/api/sell/mothership/${encodeURIComponent(c.scryfall_id)}`; }

export function OfferSummary({ total }: { total: ReturnType<typeof offerTotals> }) {
  return <p>
    <b>{total.copies > 0 ? `${total.copies} copies: ${usd(total.cash)} cash${total.creditUnknown === 0 ? ` or ${usd(total.credit)} store credit` : ""}` : "No qualifying cash offers among the checked selections"}</b>
    {total.creditUnknown > 0 && <>
      {total.creditUnknown < total.copies && `; known store credit subtotal: ${usd(total.credit)}`}
      {`; credit unknown for ${total.creditUnknown} ${total.creditUnknown === 1 ? "copy" : "copies"}`}
    </>}. Shared store quantity limits applied.
    {total.unchecked > 0 && ` ${total.unchecked} selected copies haven't been checked.`}
  </p>;
}

/** An explicit check, saved on the account; no cart submission or collection mutation. */
export function SellOffers({ cards, qty, onChoose }: { cards: SellCard[]; qty: (c: SellCard) => number; onChoose: (counts: Map<string, number>) => void }) {
  const [offers, setOffers] = useState(new Map<string, BuylistOffer>());
  const [histories, setHistories] = useState(new Map<string, BuylistOffer[]>());
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const selected = cards.filter((c) => qty(c) > 0 && canCheck(c));
  const unique = [...new Map(selected.map((c) => [offerKey(c), c])).values()];
  const total = offerTotals(selected, offers, qty, now);
  const skipped = cards.filter((c) => qty(c) > 0 && !canCheck(c)).reduce((n,c) => n + qty(c), 0);
  const [show, setShow] = useState(30);

  const check = async () => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setRunning(true); setDone(0); setError(null);
    // Freeze the selection for this run. Results are keyed by printing/condition/finish,
    // and totals always use the current selection and quantity.
    try {
      for (let i = 0; i < unique.length; i++) {
        const c = unique[i]!;
        const offer = await api<BuylistOffer>(url(c), { method: "POST", json: { finish: c.finish, condition: c.condition }, signal: abort.signal });
        if (abort.signal.aborted) break;
        setOffers((m) => new Map(m).set(offerKey(c), offer));
        setHistories((m) => { const next = new Map(m); next.delete(offerKey(c)); return next; });
        setDone(i + 1);
      }
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof ApiError ? new Error(`${e.message} Completed checks are saved.`) : e);
    } finally {
      if (controller.current === abort) setRunning(false);
    }
  };
  const history = async (c: SellCard) => {
    try {
      const rows = await api<BuylistOffer[]>(`${url(c)}?${new URLSearchParams({ finish: c.finish, condition: c.condition })}`);
      setHistories((m) => new Map(m).set(offerKey(c), rows));
      // Historical checks never become active offers or overwrite a newer lookup.
    } catch (e) { setError(e); }
  };
  return (
    <section className="stack sell-offers" aria-label="Local buylist offers">
      <h3>Local buylist offers</h3>
      <div className="row">
        <button className="outline" disabled={running || unique.length === 0} onClick={() => void check()}>Check Mothership ({unique.length})</button>
        {running && <button className="quiet" onClick={() => { controller.current?.abort(); setRunning(false); }}>Stop</button>}
        <a href="https://buylist.mothershipatx.com/retailer/buylist" target="_blank" rel="noreferrer">Open buylist</a>
      </div>
      <p className="small dim">Exact printing, condition and finish. Checks are saved to your account and reused for six hours. Leaving this sheet stops further checks.</p>
      {skipped > 0 && <p className="small dim">{skipped} copies excluded: non-English, proxies, signed, altered or misprinted.</p>}
      {(running || done > 0) && <p role="status">{done} checks completed{running ? "; checking selected cards…" : "."}</p>}
      <ErrorText error={error} />
      {offers.size > 0 && <OfferSummary total={total} />}
      {total.copies > 0 && <button className="outline" disabled={running} onClick={() => onChoose(offerTotals(selected, offers, qty).quantities)}>Use offered copies for the Storepass list</button>}
      <p className="small dim">Online offers are indicative. Mothership confirms grading, quantity and acceptance. No sale is submitted here.</p>
      <ul className="sell-list">
        {unique.slice(0, show).map((c) => {
          const key = offerKey(c), o = offers.get(key), rows = histories.get(key);
          return <li key={key}>
            <div className="row"><b>{c.name}</b><span className="small dim">{c.set_code?.toUpperCase()} #{c.collector_number}, {c.finish}, {c.condition}</span></div>
            {o && <>
              <p className="small">{currentOffer(o, now) ? LABELS[o.status] : "Past check"}{o.cash_usd != null ? `: ${usd(o.cash_usd)} cash each` : ""}{o.credit_usd != null ? ` / ${usd(o.credit_usd)} credit each` : ""}. {new Date(o.checked_at).toLocaleString()}.</p>
              <p className="small dim">{o.note}</p>
            </>}
            <button className="quiet small" onClick={() => void history(c)}>Saved checks</button>
            {rows && <div className="small">
              {rows.length === 0 ? "No saved checks for this printing yet." : <ul>{rows.map((r) => <li key={r.checked_at}>{new Date(r.checked_at).toLocaleString()}: {LABELS[r.status]}, cash {usd(r.cash_usd)}, credit {usd(r.credit_usd)}</li>)}</ul>}
            </div>}
          </li>;
        })}
      </ul>
      {unique.length > show && <button className="quiet" onClick={() => setShow((n) => n + 30)}>Show more cards</button>}
    </section>
  );
}
