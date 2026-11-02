import { useMemo, useState } from "react";
import { shortDate, usd } from "../api";
import { saveFile } from "../download";
import { Details, ErrorText, Sheet } from "../components/ui";
import { leftOut, overLimit, SELL_FORMATS, sellable, sellText, special, type SellCard, type SellFormat } from "./sellList";

/** The last format used, remembered on this device. */
const FORMAT = "yama.sell.format";
const SHOW = 50;
const MORE = 200;
const CONDITION: Record<string, string> = { NM: "near mint", LP: "lightly played", MP: "moderately played", HP: "heavily played", DMG: "damaged" };

export type SellItem = SellCard & { container_kind: string | null; unit_price_usd: number | null; price_date: string | null };

function storedFormat(): SellFormat {
  const f = localStorage.getItem(FORMAT);
  return f && f in SELL_FORMATS ? (f as SellFormat) : "sortswift";
}

/** Cards in the current view, narrowed and ticked, written out for a store's buylist. */
export function SellSheet({ items, from, inDeckBox, onClose }: { items: SellItem[]; from: string; inDeckBox: boolean; onClose: () => void }) {
  const [format, setFormatState] = useState<SellFormat>(storedFormat);
  const setFormat = (f: SellFormat) => {
    setFormatState(f);
    localStorage.setItem(FORMAT, f);
  };
  const [min, setMin] = useState("");
  const [unpriced, setUnpriced] = useState(false);
  // Cards in deck boxes are usually being played; leave them out unless this view is a deck box.
  const [decks, setDecks] = useState(inDeckBox);
  /** How many of a row to sell, when not all of them; 0 leaves it out. */
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  const [limit, setLimit] = useState(SHOW);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const floor = Number(min);
  const minimum = min.trim() !== "" && Number.isFinite(floor) && floor > 0 ? floor : null;
  const deckCopies = items.filter((i) => i.container_kind === "deck" && !i.proxy).reduce((n, i) => n + i.qty, 0);
  const shown = useMemo(
    () =>
      items.filter((i) => {
        if (!decks && i.container_kind === "deck") return false;
        if (minimum === null) return true;
        return i.unit_price_usd == null ? unpriced : i.unit_price_usd >= minimum;
      }),
    [items, decks, minimum, unpriced],
  );
  const noPrice = minimum === null ? 0 : items.filter((i) => !i.proxy && i.unit_price_usd == null && (decks || i.container_kind !== "deck")).reduce((n, i) => n + i.qty, 0);
  const cards = sellable(format, shown) as SellItem[];
  const out = leftOut(format, shown);
  const qty = (c: SellCard) => counts.get(c.id) ?? c.qty;
  const text = sellText(format, cards, qty);
  const chosen = cards.filter((c) => qty(c) > 0);
  const value = chosen.reduce((v, c) => v + (c.unit_price_usd ?? 0) * qty(c), 0);
  const valueless = chosen.filter((c) => c.unit_price_usd == null).reduce((n, c) => n + qty(c), 0);
  const day = shortDate(chosen.map((c) => c.price_date).filter((d): d is string => !!d).sort().at(-1)) ?? null;
  const flagged = chosen.filter((c) => special(c).length > 0);
  const limitNote = overLimit(format, text);
  const info = SELL_FORMATS[format];
  const set = (id: string, n: number) => setCounts((m) => new Map(m).set(id, n));
  const all = (n: (c: SellCard) => number) => setCounts(new Map(cards.map((c) => [c.id, n(c)])));

  const download = () => saveFile(new Blob([text.text], { type: `${info.mime};charset=utf-8` }), info.file).catch(setError);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? new Error(`Couldn't copy: ${e.message}`) : e);
    }
  };

  return (
    <Sheet label="Sell list" onClose={onClose}>
      <div className="stack sell-sheet">
        <div className="sheet-head">
          <h2>Sell list</h2>
          <button className="quiet" onClick={onClose}>Close</button>
        </div>
        <p className="dim">
          From {from}. To choose cards by hand, put them in a list (New, then List) and open it here. Proxies are never included.
        </p>

        <div className="segmented sell-formats" role="group" aria-label="Format">
          {(Object.keys(SELL_FORMATS) as SellFormat[]).map((f) => (
            <button key={f} aria-pressed={format === f} onClick={() => setFormat(f)}>{SELL_FORMATS[f].label}</button>
          ))}
        </div>
        <p className="small">{info.how}</p>

        <div className="sell-filters">
          <label className="sell-min">
            Worth at least
            <span className="sell-money">
              $<input type="number" inputMode="decimal" min="0" step="0.5" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" />
            </span>
          </label>
          {minimum !== null && noPrice > 0 && (
            <label className="sell-check">
              <input type="checkbox" checked={unpriced} onChange={(e) => setUnpriced(e.target.checked)} />
              Include {noPrice.toLocaleString()} {noPrice === 1 ? "card" : "cards"} with no price
            </label>
          )}
          {deckCopies > 0 && !inDeckBox && (
            <label className="sell-check">
              <input type="checkbox" checked={decks} onChange={(e) => setDecks(e.target.checked)} />
              Include {deckCopies.toLocaleString()} {deckCopies === 1 ? "card" : "cards"} in deck boxes
            </label>
          )}
        </div>

        <p className="sell-total" role="status">
          <b className="num">
            {text.copies.toLocaleString()} {text.copies === 1 ? "card" : "cards"}
          </b>
          {text.copies > 0 && (
            <span className="dim">
              {" "}
              {usd(value)} market value{day ? ` on ${day}` : ""}
              {valueless > 0 ? `, ${valueless.toLocaleString()} with no price` : ""}. A buylist pays less than market; each store sets its own offer.
            </span>
          )}
        </p>
        {limitNote && <p className="error">{limitNote}</p>}
        <div className="row">
          {info.paste ? (
            <>
              <button className="primary" disabled={text.copies === 0} onClick={() => void copy()}>{copied ? "Copied" : "Copy the list"}</button>
              <button className="outline" disabled={text.copies === 0} onClick={() => void download()}>Download</button>
            </>
          ) : (
            <>
              <button className="primary" disabled={text.copies === 0} onClick={() => void download()}>Download CSV</button>
              <button className="outline" disabled={text.copies === 0} onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
            </>
          )}
        </div>
        <ErrorText error={error} />
        {flagged.length > 0 && (
          <p className="small dim">
            {flagged.length === 1 ? "1 card is" : `${flagged.length} cards are`} signed, altered or misprinted
            {format === "sortswift" ? ", said in the Notes column" : ", which this format can't say"}. Check {flagged.length === 1 ? "its" : "their"} offer with the store.
          </p>
        )}
        {out.length > 0 && (
          <Details label={`Left out: ${out.reduce((n, x) => n + x.card.qty, 0).toLocaleString()}`}>
            <ul className="small sell-out">
              {out.map(({ card, why }) => (
                <li key={card.id}>
                  {card.qty > 1 ? `${card.qty} ` : ""}
                  {card.name ?? card.scryfall_id}: {why}
                </li>
              ))}
            </ul>
          </Details>
        )}

        {cards.length > 0 && (
          <>
            <div className="sell-pick">
              <span className="small dim">
                {chosen.length.toLocaleString()} of {cards.length.toLocaleString()} {cards.length === 1 ? "row" : "rows"} ticked
              </span>
              <button className="quiet small" onClick={() => all((c) => c.qty)}>Tick all</button>
              <button className="quiet small" onClick={() => all(() => 0)}>Untick all</button>
            </div>
            <ul className="sell-list">
              {cards.slice(0, limit).map((c) => {
                const n = qty(c);
                const tags = [c.finish !== "nonfoil" && c.finish[0]!.toUpperCase() + c.finish.slice(1), c.lang !== "en" && c.lang, ...special(c)].filter(Boolean);
                return (
                  <li key={c.id}>
                    <label className="sell-row">
                      <input type="checkbox" checked={n > 0} onChange={(e) => set(c.id, e.target.checked ? c.qty : 0)} />
                      <span className="sell-row-text">
                        <span className="sell-row-name">
                          {c.name}
                          {tags.map((t) => <span key={String(t)} className="tag">{t}</span>)}
                        </span>
                        <span className="small dim">
                          {(c.set_code ?? "").toUpperCase()} #{c.collector_number}, {CONDITION[c.condition] ?? c.condition}
                        </span>
                      </span>
                      <span className="coll-price num">{usd(c.unit_price_usd)}</span>
                    </label>
                    {c.qty > 1 && (
                      <label className="sell-qty small">
                        <input type="number" min="0" max={c.qty} value={n} onChange={(e) => set(c.id, Math.max(0, Math.min(c.qty, Math.floor(Number(e.target.value) || 0))))} />
                        of {c.qty}
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
            {cards.length > limit && (
              <button className="coll-more" onClick={() => setLimit((l) => l + MORE)}>
                {cards.length - limit > MORE ? `Show ${MORE} more of ${(cards.length - limit).toLocaleString()}` : `Show the last ${(cards.length - limit).toLocaleString()}`}
              </button>
            )}
          </>
        )}
        {cards.length === 0 && <p className="empty">Nothing here to sell{minimum !== null ? ` worth at least ${usd(minimum)}` : ""}.</p>}
      </div>
    </Sheet>
  );
}
