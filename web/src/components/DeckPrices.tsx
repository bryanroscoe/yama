import { type BuylistValue, type DeckView, type SinglesValue, type SealedPrice } from "../api";
import { Details } from "./ui";
import { shortDate, usd } from "@yama/core";

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

/** A deck tile's price: the amount alone ("$61.32", or "$61.32, partial" when some copies have
 *  no price). The source and dates are said once for the whole grid, by `singlesSourceLine`. */
export function SinglesAmount({ value }: { value: SinglesValue | undefined }) {
  if (!value) return null;
  if (value.usd == null) return <span>No price</span>;
  return <span title={value.unpriced_copies > 0 ? `${copies(value.unpriced_copies)} without a price` : undefined}>
    <b>{usd(value.usd)}</b>{value.unpriced_copies > 0 ? ", partial" : ""}
  </span>;
}

/** Where a grid of tile prices comes from and their dates, once: "Deck prices are what the
 *  singles cost: TCGplayer market via Scryfall, Nov 19 to Nov 20." Null when no tile has a price. */
export function singlesSourceLine(values: (SinglesValue | undefined)[]): string | null {
  const dated = values.filter((v): v is SinglesValue => !!v?.newest_date);
  if (!dated.length) return null;
  const oldest = dated.map((v) => v.oldest_date ?? v.newest_date!).sort()[0]!;
  const newest = dated.map((v) => v.newest_date!).sort().at(-1)!;
  const sources = [...new Set(dated.map((v) => v.source))].join(", ");
  const dates = oldest === newest ? shortDate(newest) : `${shortDate(oldest)} to ${shortDate(newest)}`;
  const partial = values.some((v) => v && v.usd != null && v.unpriced_copies > 0);
  return `Deck prices are what the singles cost: ${sources}, ${dates}.${partial ? " Partial means some cards have no price." : ""}`;
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

/** Dated printing-specific references precede market estimates. The public feed cannot establish
 *  an economical sale, so no automatic cash total or arbitrary bulk-price cutoff is applied. */
export function BuylistReferences({ b }: { b: BuylistValue }) {
  const notes = [
    b.no_offer_copies > 0 && `${copies(b.no_offer_copies)} with no buylist price (unknown, not $0)`,
    b.unmatched_copies > 0 && `${copies(b.unmatched_copies)} not near-mint English, so the price doesn't apply`,
    b.basics > 0 && `${b.basics === 1 ? "1 basic land" : `${b.basics} basic lands`}; review each printing, including premium versions`,
  ].filter(Boolean);
  return <section aria-label="Buylist references">
    <h2>Buylist references</h2>
    {b.copies === 0
      ? <p>None of this deck's cards are real copies in your collection, so there's nothing to price for selling.</p>
      : <p>{b.offered_copies > 0 ? `A dated price for ${b.offered_copies} of your ${copies(b.copies)}` : `No buylist price for any of your ${copies(b.copies)}`}.
          <span className="dim"> {b.provider}, {shortDate(b.date)}: prices for near-mint copies, not a confirmed sale or an offer from your stores.</span>
        </p>}
    <p className="dim small">Review cards individually before estimating saleable cash. Separate ordinary basics and bulk; check premium printings, quantity limits, shipping, fees and final condition grading. These prices are not added into a resale total.</p>
    {notes.length > 0 && <p className="dim small">{notes.join("; ")}.</p>}
    {b.cards.length > 0 && <Details label="Prices by printing">
      <ul className="buylist-cards">{b.cards.map((c) => <li key={`${c.name}-${c.set_code}-${c.collector_number}-${c.finish}`}>
        {c.qty} {c.name} <span className="dim">({c.set_code?.toUpperCase()} {c.collector_number}{c.finish !== "nonfoil" ? `, ${c.finish}` : ""})</span>: <span className="num">{usd(c.offer_usd)}</span>{c.qty > 1 ? " each" : ""}{c.basic ? <span className="dim"> (basic land; review this printing)</span> : null}
      </li>)}</ul>
    </Details>}
  </section>;
}

export function DeckPrices({ singles, sealed, precon = false, ownership, buylist }: { singles: SinglesValue | undefined; sealed?: SealedPrice | null; precon?: boolean; ownership?: DeckView["ownership"]; buylist?: BuylistValue | null }) {
  return <>
  {buylist && <BuylistReferences b={buylist} />}
  <section aria-label="Deck market value">
    <h2>Market value (estimate)</h2>
    {precon && <p>Sealed deck: {sealed ? <><a href={sealed.url} target="_blank" rel="noreferrer">{usd(sealed.usd)}</a>. {sealed.source}, {shortDate(sealed.price_date)} ({sealed.product_name})</> : "No price"}</p>}
    <p><SinglesPrice value={singles} /></p>
    {ownership && <OwnershipValue o={ownership} />}
    <Details label="How market value is estimated">
      {precon && !sealed && <p>No matching sealed market price yet.</p>}
      <p>Replacement cost at each card's cheapest eligible nonfoil paper printing. Includes commanders, basics and cards played as proxies; excludes sideboards. Actual printings, finishes and condition affect value. Market references aren't store quotes or resale offers{buylist ? ", and separate from the buylist references above" : ""}.</p>
    </Details>
  </section>
  </>;
}
