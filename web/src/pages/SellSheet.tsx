import { useState } from "react";
import { SellOffers } from "./SellOffers";
import { saveFile } from "../download";
import { Details, ErrorText, Sheet, EmptyState } from "../components/ui";
import { leftOut, overLimit, SELL_FORMATS, sellable, sellText, special, type SellCard, type SellFormat } from "./sellList";
import { shortDate, usd, count, plural } from "@yama/core";

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
  /** How many of a row to sell, where chosen; 0 leaves it out. */
  const [counts, setCounts] = useState<Map<string, number>>(new Map());
  /** Rows not chosen one by one: all their copies (at first, and after Tick all) or none (after Untick all). */
  const [rest, setRest] = useState<"all" | "none">("all");
  const [limit, setLimit] = useState(SHOW);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const floor = Number(min);
  const minimum = min.trim() !== "" && Number.isFinite(floor) && floor > 0 ? floor : null;
  const worth = (i: SellItem, withUnpriced: boolean) => minimum === null || (i.unit_price_usd == null ? withUnpriced : i.unit_price_usd >= minimum);
  const copies = (rows: SellItem[]) => rows.reduce((n, i) => n + i.qty, 0);
  // What each checkbox would add: cards this format can take that pass the other filters.
  const usable = sellable(format, items) as SellItem[];
  const deckCopies = copies(usable.filter((i) => i.container_kind === "deck" && worth(i, unpriced)));
  const noPrice = minimum === null ? 0 : copies(usable.filter((i) => i.unit_price_usd == null && (decks || i.container_kind !== "deck")));
  const shown = items.filter((i) => (decks || i.container_kind !== "deck") && worth(i, unpriced));
  const cards = sellable(format, shown) as SellItem[];
  const out = leftOut(format, shown);
  // Never more than the row holds now: the collection can change while the sheet is open.
  const qty = (c: SellCard) => Math.min(c.qty, counts.get(c.id) ?? (rest === "all" ? c.qty : 0));
  const text = sellText(format, cards, qty);
  const chosen = cards.filter((c) => qty(c) > 0);
  const value = chosen.reduce((v, c) => v + (c.unit_price_usd ?? 0) * qty(c), 0);
  const valueless = chosen.filter((c) => c.unit_price_usd == null).reduce((n, c) => n + qty(c), 0);
  // Each price is its printing's newest snapshot, so the sum can span days: say the range.
  const days = chosen.filter((c) => c.unit_price_usd != null).map((c) => c.price_date).filter((d): d is string => !!d).sort();
  const oldest = shortDate(days[0]);
  const newest = shortDate(days.at(-1));
  const dates = !newest ? "date unknown" : oldest === newest ? newest : `${oldest} to ${newest}`;
  const flagged = chosen.filter((c) => special(c).length > 0).reduce((n, c) => n + qty(c), 0);
  const limitNote = overLimit(format, text);
  const info = SELL_FORMATS[format];
  const set = (id: string, n: number) => setCounts((m) => new Map(m).set(id, n));
  const all = (r: "all" | "none") => {
    setRest(r);
    setCounts(new Map());
  };

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
          From {from}. To choose cards by hand, move them into a list (New, then List) and open it here. Proxies are never included.
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
              Include {plural(noPrice, "card")} with no price
            </label>
          )}
          {deckCopies > 0 && !inDeckBox && (
            <label className="sell-check">
              <input type="checkbox" checked={decks} onChange={(e) => setDecks(e.target.checked)} />
              Include {plural(deckCopies, "card")} in deck boxes
            </label>
          )}
        </div>

        <p className="sell-total">
          <b className="num">
            {plural(text.copies, "card")}
          </b>
          {text.copies > 0 && (
            <span className="dim">
              {" "}
              {valueless < text.copies ? `${usd(value)} market value (TCGplayer market via Scryfall, ${dates})${valueless > 0 ? `, ${count(valueless)} with no price` : ""}.` : "No market price for any of them."} Each store sets its own offer.
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
        {flagged > 0 && (
          <p className="small dim">
            {flagged === 1 ? "1 card is" : `${count(flagged)} cards are`} signed, altered or misprinted
            {format === "sortswift" ? ", said in the Notes column" : ", which this format can't say"}. Check {flagged === 1 ? "its" : "their"} offer with the store.
          </p>
        )}
        {out.length > 0 && (
          <Details label={`Left out: ${count(out.reduce((n, x) => n + x.card.qty, 0))}`}>
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

        <Details label="Local buylist offers"><SellOffers cards={shown.filter((c) => qty(c) > 0)} qty={qty} onChoose={(counts) => { setRest("none"); setCounts(new Map(counts)); setFormat("storepass"); }} /></Details>

        {cards.length > 0 && (
          <>
            <div className="sell-pick">
              <span className="small dim">
                {count(chosen.length)} of {count(cards.length)} {cards.length === 1 ? "row" : "rows"} ticked
              </span>
              <button className="quiet small" onClick={() => all("all")}>Tick all</button>
              <button className="quiet small" onClick={() => all("none")}>Untick all</button>
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
                        <input type="number" min="0" max={c.qty} value={n} aria-label={`Copies of ${c.name} to sell`} onChange={(e) => set(c.id, Math.max(0, Math.min(c.qty, Math.floor(Number(e.target.value) || 0))))} />
                        of {c.qty}
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
            {cards.length > limit && (
              <button className="coll-more" onClick={() => setLimit((l) => l + MORE)}>
                {cards.length - limit > MORE ? `Show ${MORE} more of ${count(cards.length - limit)}` : `Show the last ${count(cards.length - limit)}`}
              </button>
            )}
          </>
        )}
        {cards.length === 0 && <EmptyState>Nothing here to sell{minimum !== null ? ` worth at least ${usd(minimum)}` : ""}.</EmptyState>}
      </div>
    </Sheet>
  );
}
