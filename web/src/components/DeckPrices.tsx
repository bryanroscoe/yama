import { shortDate, usd, type DeckView, type SinglesValue, type SealedPrice } from "../api";
import { Details } from "./ui";

export function SinglesPrice({ value }: { value: SinglesValue | undefined }) {
  if (!value) return null;
  const dates = value.oldest_date === value.newest_date
    ? shortDate(value.newest_date)
    : `${shortDate(value.oldest_date)} to ${shortDate(value.newest_date)}`;
  return <span>
    <b>{usd(value.usd)}</b> in singles{value.unpriced_copies > 0 ? ` (partial: ${copies(value.unpriced_copies)} without a price)` : ""}
    {value.newest_date && <span className="dim small">. {value.source}, {dates}</span>}
  </span>;
}

const copies = (n: number) => (n === 1 ? "1 copy" : `${n} copies`);
const unpriced = (n: number | undefined) => (n ? `, ${n} without a price` : "");

/** What's left to get costs, or null when none of it has a price (unknown, not $0). */
export function neededCost(o: DeckView["ownership"]): number | null {
  return o.needed_cost_usd === 0 && o.needed_without_price > 0 ? null : o.needed_cost_usd;
}

/** Your part of the deck's value: the real cards you own, the cards proxies stand in for (what
 *  real copies would cost) and what's left to get. Same prices as the singles value. */
export function OwnershipValue({ o }: { o: DeckView["ownership"] }) {
  const proxies = o.proxies ?? 0;
  return <dl className="deck-value-split">
    <div>
      <dt>Real cards you own</dt>
      <dd>{o.owned ? <><b className="num">{usd(o.owned_value_usd ?? null)}</b> <span className="dim">{copies(o.owned)}{unpriced(o.owned_without_price)}</span></> : <b>None yet</b>}</dd>
    </div>
    {proxies > 0 && <div>
      <dt>Proxies</dt>
      <dd><b className="num">{usd(o.proxy_value_usd ?? null)}</b> <span className="dim">to replace {copies(proxies)} with real cards{unpriced(o.proxies_without_price)}</span></dd>
    </div>}
    <div>
      <dt>Still to get</dt>
      <dd>{o.needed ? <><b className="num">{usd(neededCost(o))}</b> <span className="dim">{copies(o.needed)}, basics excluded{unpriced(o.needed_without_price)}</span></> : <b>Nothing</b>}</dd>
    </div>
  </dl>;
}

export function DeckPrices({ singles, sealed, precon = false, ownership }: { singles: SinglesValue | undefined; sealed?: SealedPrice | null; precon?: boolean; ownership?: DeckView["ownership"] }) {
  return <section aria-label="Deck market value">
    <h2>Market value</h2>
    {precon && <p>Sealed deck: {sealed ? <><a href={sealed.url} target="_blank" rel="noreferrer">{usd(sealed.usd)}</a>. {sealed.source}, {shortDate(sealed.price_date)} ({sealed.product_name})</> : "No price"}</p>}
    <p><SinglesPrice value={singles} /></p>
    {ownership && <OwnershipValue o={ownership} />}
    <Details label="How market value is estimated">
      {precon && !sealed && <p>No matching sealed market price yet.</p>}
      <p>Replacement cost at each card's cheapest eligible nonfoil paper printing. Includes commanders, basics and cards played as proxies; excludes sideboards. Actual printings, finishes and condition affect value. Market references aren't store quotes or resale offers.</p>
    </Details>
  </section>;
}
