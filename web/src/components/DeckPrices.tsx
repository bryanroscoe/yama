import { shortDate, usd, type SinglesValue, type SealedPrice } from "../api";

export function SinglesPrice({ value }: { value: SinglesValue | undefined }) {
  if (!value) return null;
  const dates = value.oldest_date === value.newest_date
    ? shortDate(value.newest_date)
    : `${shortDate(value.oldest_date)} to ${shortDate(value.newest_date)}`;
  return <span>
    <b>{usd(value.usd)}</b> in singles{value.unpriced_copies > 0 ? ` (partial: ${value.unpriced_copies} copies without a price)` : ""}
    {value.newest_date && <span className="dim small">. {value.source}, {dates}</span>}
  </span>;
}

export function DeckPrices({ singles, sealed, precon = false }: { singles: SinglesValue | undefined; sealed?: SealedPrice | null; precon?: boolean }) {
  return <section aria-label="Deck market value">
    <h2>Market value</h2>
    {precon && <p>Sealed deck: {sealed ? <><a href={sealed.url} target="_blank" rel="noreferrer">{usd(sealed.usd)}</a>. {sealed.source}, {shortDate(sealed.price_date)} ({sealed.product_name})</> : "No price: no unambiguous product match with a market snapshot yet."}</p>}
    <p><SinglesPrice value={singles} /></p>
    <p className="dim small">Singles estimate uses each card's cheapest eligible nonfoil paper printing, including commanders and basics, excluding sideboards. Quantities count; this is the list's replacement value, including cards played as proxies. Actual printings, finishes and condition can change the value. Market references are not store quotes or sale proceeds.</p>
  </section>;
}
