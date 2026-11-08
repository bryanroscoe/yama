import { useMemo, useState } from "react";
import { priceSource, usd, type DeckView } from "../api";
import { CardHover } from "../components/CardRef";
import { CopyButton } from "../plan/parts";
import { copiesIn, priceRows, priceText, priceTotal, printingLabel, shownRows, type PriceRow, type PriceShow, type PriceSort } from "./priceList";
import "./price-list.css";

const SHOWS: { show: PriceShow; label: string }[] = [
  { show: "all", label: "Whole deck" },
  { show: "proxy", label: "Proxies" },
  { show: "real", label: "Real cards" },
  { show: "need", label: "Still need" },
];

const cards = (n: number) => (n === 1 ? "1 card" : `${n} cards`);

/** What every card in the deck costs at its cheapest printing, which cards are proxies, and the
 *  printing to buy. Prices are TCGplayer market references with their date, never store quotes. */
export function DeckPriceList({ deck, onOpen }: { deck: DeckView; onOpen: (oracleId: string) => void }) {
  const [show, setShow] = useState<PriceShow>("all");
  const [sort, setSort] = useState<PriceSort>("price");
  const rows = useMemo(() => priceRows(deck.cards), [deck.cards]);
  const visible = useMemo(() => shownRows(rows, show, sort), [rows, show, sort]);
  const source = priceSource(deck.ownership.price_date);
  const total = priceTotal(rows, show);
  const notes = [
    total.unpriced > 0 && `${cards(total.unpriced)} without a price, left out`,
    total.basics > 0 && `basic lands left out`,
  ].filter(Boolean);
  return (
    <section className="price-view" aria-label="Card prices">
      <div className="price-shows" role="tablist" aria-label="Which cards">
        {SHOWS.map(({ show: s, label }) => {
          const t = priceTotal(rows, s);
          if (s !== "all" && t.copies === 0) return null;
          return (
            <button key={s} role="tab" aria-selected={show === s} onClick={() => setShow(s)}>
              <span>{label}</span>
              <b className="num">{usd(t.usd)}</b>
              <span className="dim small">{cards(t.copies)}</span>
            </button>
          );
        })}
      </div>
      <div className="price-head">
        <p className="small">
          <b className="num">{usd(total.usd)}</b> for {cards(total.copies)} at each card's cheapest printing
          {notes.length > 0 && <span className="dim"> ({notes.join("; ")})</span>}.
        </p>
        <div className="price-tools">
          <div className="price-sort" role="group" aria-label="Sort">
            <button aria-pressed={sort === "price"} onClick={() => setSort("price")}>Priciest first</button>
            <button aria-pressed={sort === "name"} onClick={() => setSort("name")}>A to Z</button>
          </div>
          <CopyButton text={priceText(visible, show, source)} label="Copy as text" className="outline" />
        </div>
      </div>
      {visible.length === 0 ? <p className="empty">No cards here.</p> : (
        <ol className="price-rows">
          {visible.map((r) => <PriceLine key={r.key} r={r} show={show} onOpen={onOpen} />)}
        </ol>
      )}
      <p className="dim small price-note">
        Cheapest nonfoil paper printing of each card. {source}. A market reference, not a store's price or proof it's in stock; your own printings may be worth more or less.
      </p>
    </section>
  );
}

function PriceLine({ r, show, onOpen }: { r: PriceRow; show: PriceShow; onOpen: (oracleId: string) => void }) {
  const n = copiesIn(r, show);
  return (
    <li className="price-row">
      <span className="price-row-text">
        <button className="price-row-name" onClick={() => onOpen(r.oracle_id)}>
          {n > 1 ? `${n} ` : ""}
          <CardHover name={r.name} oracleId={r.oracle_id} image={r.entry.card?.image_normal} />
        </button>
        <span className="price-row-meta small">
          <Kind r={r} />
          {r.cheapest ? (
            <span className="dim">
              Cheapest:{" "}
              <a href={`https://scryfall.com/card/${encodeURIComponent(r.cheapest.set_code)}/${encodeURIComponent(r.cheapest.collector_number)}`} target="_blank" rel="noreferrer">
                {r.cheapest.set_name} ({printingLabel(r.cheapest)})
              </a>
            </span>
          ) : null}
          {r.yours && r.cheapest && (r.yours.set_code !== r.cheapest.set_code || r.yours.collector_number !== r.cheapest.collector_number) && (
            <span className="dim">Yours: {printingLabel(r.yours)}{r.yours.finish !== "nonfoil" ? `, ${r.yours.finish}` : ""}</span>
          )}
        </span>
      </span>
      <span className="price-row-price num">
        {r.each == null ? <span className="dim">No price</span> : <b>{usd(r.each * n)}</b>}
        {r.each != null && n > 1 && <span className="dim small">{usd(r.each)} each</span>}
      </span>
    </li>
  );
}

/** Real, proxy or not owned, in words; a card split between them says how many of each. */
function Kind({ r }: { r: PriceRow }) {
  const parts: [number, string, string][] = [
    [r.real, "real", "have"],
    [r.proxy, r.proxy === 1 ? "proxy" : "proxies", "proxy"],
    [r.need, "not owned", "need"],
  ];
  const present = parts.filter(([n]) => n > 0);
  const only = present.length === 1 ? present[0] : undefined;
  if (only) {
    const tone = only[2];
    const label = tone === "have" ? "Real" : tone === "proxy" ? "Proxy" : "Not owned";
    return <span className={`price-kind ${tone}`}>{label}</span>;
  }
  return (
    <span className="price-kind">
      {present.map(([n, word, tone], i) => (
        <span key={tone} className={tone}>{i > 0 ? ", " : ""}{n} {word}</span>
      ))}
    </span>
  );
}
