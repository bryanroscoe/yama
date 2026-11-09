// The deck page's Cards tab (SPEC 1b and 0b; boards Deck and PhoneDeck): every list control in view
// (Show, View, Group by, Sort, the total and Copy the list), the type bar that jumps to a group,
// and collapsible groups with their count and price.
import { useMemo, useState, type ReactNode } from "react";
import { usd, type DeckEntry, type DeckView } from "../api";
import { artCredits } from "../components/ArtPanel";
import { CardHover } from "../components/CardRef";
import { Crop } from "../components/Crop";
import { CardImage } from "../components/ui";
import { CopyButton } from "../plan/parts";
import { cardGroups, cardRows, copiesShown, priceOf, showCounts, shownText, type CardGroupBy, type CardRow, type CardShow, type CardSort } from "./cardList";
import { printingLabel } from "./priceList";
import "./cards-tab.css";

export type CardView = "pictures" | "list" | "table";

/** A choice kept on this device (the layout you like), read safely. */
function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function keep(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
  return (
    <span className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

const copies = (n: number) => (n === 1 ? "1 card" : `${n} cards`);

export function useCardControls() {
  const [show, setShow] = useState<CardShow>("all");
  const [view, setViewState] = useState<CardView>(() => stored("yama.deck.view", ["pictures", "list", "table"] as const, typeof window !== "undefined" && window.matchMedia?.("(min-width: 900px)").matches ? "pictures" : "list"));
  const [groupBy, setGroupState] = useState<CardGroupBy>(() => stored("yama.deck.group", ["type", "mv", "none"] as const, "type"));
  const [sort, setSortState] = useState<CardSort>(() => stored("yama.deck.sort", ["mv", "name", "price"] as const, "mv"));
  return {
    show,
    setShow,
    view,
    setView: (v: CardView) => (keep("yama.deck.view", v), setViewState(v)),
    groupBy,
    setGroupBy: (v: CardGroupBy) => (keep("yama.deck.group", v), setGroupState(v)),
    sort,
    setSort: (v: CardSort) => (keep("yama.deck.sort", v), setSortState(v)),
  };
}

export function DeckCardsTab({
  deck,
  controls,
  outAt,
  atBracket,
  priceLine,
  status,
  onOpen,
}: {
  deck: DeckView;
  controls: ReturnType<typeof useCardControls>;
  /** Cards going out at the bracket being previewed. */
  outAt: ReadonlySet<string>;
  atBracket: number | null;
  /** "TCGplayer market via Scryfall, Nov 8". */
  priceLine: string;
  /** Where your copies are, or that you need it (the list view's second line). */
  status: (e: DeckEntry) => ReactNode;
  onOpen: (oracleId: string) => void;
}) {
  const { show, setShow, view, setView, groupBy, setGroupBy, sort, setSort } = controls;
  const rows = useMemo(() => cardRows(deck.cards), [deck.cards]);
  const counts = showCounts(rows);
  const groups = useMemo(() => cardGroups(rows, show, groupBy, sort), [rows, show, groupBy, sort]);
  const total = priceOf(rows, show);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set((localStorage.getItem("yama.deck.collapsed") ?? "").split("|").filter(Boolean));
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string) => {
    const next = new Set(collapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setCollapsed(next);
    try {
      localStorage.setItem("yama.deck.collapsed", [...next].join("|"));
    } catch {
      // Storage blocked: the choice lasts for this page.
    }
  };
  const typeBar = groupBy === "type" && show === "all" ? groups : [];
  const artists = view === "list" ? groups.flatMap((g) => (collapsed.has(g.id) ? [] : g.rows.map((r) => (r.entry.card?.image_art_crop ? r.entry.card.artist : null)))) : [];
  const empty =
    show === "need" ? "Nothing to get. Every card is a real copy or a proxy." : show === "proxy" ? "No proxies in this list." : "No cards in this list yet.";

  const chip = (r: CardRow) =>
    outAt.has(r.entry.name) ? <span className="card-chip out">Out at Bracket {atBracket}</span> : r.need > 0 ? <span className="card-chip need">Need{r.need > 1 ? ` ${r.need}` : ""}</span> : r.proxy > 0 && r.real === 0 ? <span className="card-chip proxy">Proxy</span> : null;
  const label = (r: CardRow) => {
    const n = copiesShown(r, show);
    return `${n > 1 ? `${n} ` : ""}${r.entry.name}${r.need ? `, need ${r.need}` : ""}${r.proxy && !r.real ? ", proxy" : ""}${outAt.has(r.entry.name) ? `, out at Bracket ${atBracket}` : ""}`;
  };

  return (
    <div className="cards-tab">
      <div className="cards-controls">
        <div className="cards-controls-row">
          <Segmented<CardShow>
            label="Show"
            value={show}
            onChange={setShow}
            options={[
              ["all", <>Whole deck <span className="num">{counts.all}</span></>],
              ["need", <>Still need <span className="num">{counts.need}</span></>],
              ["proxy", <>Proxies <span className="num">{counts.proxy}</span></>],
            ]}
          />
          <Segmented<CardView> label="View" value={view} onChange={setView} options={[["pictures", "Pictures"], ["list", "List"], ["table", "Table"]]} />
          <span className="cards-total">
            <b className="num">{total.usd != null ? usd(total.usd) : "No price"}</b>
            <span className="dim">{total.unpriced ? `${copies(total.unpriced)} without a price. ` : ""}{priceLine}</span>
          </span>
          <CopyButton text={shownText(rows, show)} label="Copy the list" className="cards-copy" />
        </div>
        <div className="cards-controls-row">
          <span className="cards-control-label">
            <span aria-hidden="true">Group by</span>
            <Segmented<CardGroupBy> label="Group by" value={groupBy} onChange={setGroupBy} options={[["type", "Type"], ["mv", "Mana value"], ["none", "None"]]} />
          </span>
          <span className="cards-control-label">
            <span aria-hidden="true">Sort</span>
            <Segmented<CardSort> label="Sort" value={sort} onChange={setSort} options={[["mv", "Mana value"], ["name", "Name"], ["price", "Price"]]} />
          </span>
        </div>
      </div>

      {typeBar.length > 1 && (
        <nav className="type-bar" aria-label="Jump to a card type">
          <span className="type-bar-track" aria-hidden="true">
            {typeBar.map((g, i) => (
              <span key={g.id} style={{ flexGrow: g.count, background: `var(--type-${i % 8})` }} />
            ))}
          </span>
          <span className="type-bar-links">
            {typeBar.map((g, i) => (
              <a key={g.id} href={`#${g.id}`}>
                <span className="type-bar-dot" style={{ background: `var(--type-${i % 8})` }} aria-hidden="true" />
                {g.title} <span className="dim num">{g.count}</span>
              </a>
            ))}
          </span>
        </nav>
      )}

      {groups.length === 0 && <p className="cards-empty">{empty}</p>}

      {groups.map((g) => {
        const open = !collapsed.has(g.id);
        return (
          <section key={g.id} id={g.id} className="cards-group" aria-labelledby={`${g.id}-h`}>
            <h2 className="cards-group-head" id={`${g.id}-h`}>
              <button type="button" aria-expanded={open} onClick={() => toggle(g.id)}>
                <span className="cards-group-title">{g.title}</span>
                <span className="dim num">{g.count}</span>
                <span className="cards-group-price dim num">
                  {g.usd != null ? usd(g.usd) : ""}
                  {g.unpriced ? `${g.usd != null ? ", " : ""}${g.unpriced} without a price` : ""}
                </span>
                <svg className="cards-group-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </h2>
            {open && view === "pictures" && (
              <div className="cards-pictures">
                {g.rows.map((r) => (
                  <button key={r.key} type="button" className="cards-picture" onClick={() => onOpen(r.entry.oracle_id)} aria-label={label(r)}>
                    <CardHover name={r.entry.name} oracleId={r.entry.oracle_id} image={r.entry.card?.image_normal}>
                      <CardImage src={r.entry.card?.image_normal} name={r.entry.name} />
                    </CardHover>
                    {copiesShown(r, show) > 1 && <span className="qty-badge num">×{copiesShown(r, show)}</span>}
                    {chip(r)}
                  </button>
                ))}
              </div>
            )}
            {open && view === "list" && (
              <div className="cards-rows">
                {g.rows.map((r) => (
                  <button key={r.key} type="button" className="cards-row" onClick={() => onOpen(r.entry.oracle_id)}>
                    <Crop src={r.entry.card?.image_art_crop} size="sm" />
                    <span className="cards-row-text">
                      <span className="cards-row-name">
                        {copiesShown(r, show) > 1 ? `${copiesShown(r, show)} ` : ""}
                        <CardHover name={r.entry.name} oracleId={r.entry.oracle_id} image={r.entry.card?.image_normal} />
                      </span>
                      {status(r.entry)}
                    </span>
                    {chip(r)}
                    <span className="cards-row-price dim num">{r.entry.cheapest_usd != null ? usd(r.entry.cheapest_usd * copiesShown(r, show)) : "No price"}</span>
                  </button>
                ))}
              </div>
            )}
            {open && view === "table" && (
              <div className="cards-table-wrap">
                <table className="cards-table">
                  <thead>
                    <tr>
                      <th scope="col">Card</th>
                      <th scope="col">Mana value</th>
                      <th scope="col">Copy</th>
                      <th scope="col">Cheapest printing</th>
                      <th scope="col" className="num">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => {
                      const n = copiesShown(r, show);
                      const p = r.entry.cheapest_printing;
                      return (
                        <tr key={r.key}>
                          <td>
                            <button type="button" className="cards-table-name" onClick={() => onOpen(r.entry.oracle_id)}>
                              {n > 1 ? `${n} ` : ""}
                              <CardHover name={r.entry.name} oracleId={r.entry.oracle_id} image={r.entry.card?.image_normal} />
                            </button>
                          </td>
                          <td className="num">{r.type === "Lands" ? "" : r.mv}</td>
                          <td>{chip(r) ?? <span className="dim">Real</span>}</td>
                          <td className="dim">
                            {p ? (
                              <a href={`https://scryfall.com/card/${encodeURIComponent(p.set_code)}/${encodeURIComponent(p.collector_number)}`} target="_blank" rel="noreferrer">
                                {p.set_name} ({printingLabel(p)})
                              </a>
                            ) : null}
                          </td>
                          <td className="num">{r.entry.cheapest_usd != null ? usd(r.entry.cheapest_usd * n) : <span className="dim">No price</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
      {artists.some(Boolean) && <p className="cards-credits dim">{artCredits(artists)}</p>}
    </div>
  );
}
