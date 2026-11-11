import { HelpPopover } from "../components/HelpPopover";
import { CardHover } from "../components/CardRef";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { api, type Card, type SearchResult } from "../api";
import { isNetworkError } from "../cardDetail";
import { isGuest } from "../guest";
import { CardImage, ErrorText, Dialog } from "../components/ui";
import { offlineSearch } from "../offline/cards";
import { ReleaseCalendar } from "../components/Upcoming";
import { queryChips, withoutTerm } from "./cardQuery";
import { CardView } from "./CardView";
import "./cards.css";
import { priceSource, usd, plural } from "@yama/core";

const EXAMPLES = [
  { q: "id<=ug is:commander", label: "Simic commanders" },
  { q: 't:land o:"enters tapped" -o:"unless" id<=wr', label: "Boros taplands" },
  { q: 'o:"draw a card" mv<=2 id<=ub', label: "Cheap Dimir draw" },
  { q: "kw:flying t:creature pow>=4", label: "Big flyers" },
];

/** A search hit with what the grid shows under it. Offline hits have no price or ownership. */
type Hit = Card & { usd?: number | null; price_date?: string | null; owned?: number; owned_in?: string | null };

function SearchIcon() {
  return (
    <svg className="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </svg>
  );
}

const ORDERS = [
  { value: "edhrec", label: "Most played" },
  { value: "name", label: "Name" },
  { value: "mv", label: "Mana value" },
  { value: "color", label: "Color" },
  { value: "usd", label: "Price, high to low" },
  { value: "usd_asc", label: "Price, low to high" },
  { value: "released", label: "Newest" },
  { value: "released_asc", label: "Oldest" },
];

export function CardsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const order = params.get("order") ?? "name";
  const page = Number(params.get("page") ?? 1);
  const open = params.get("card");
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);

  // Signed out, Yama's guest search (limited per address): the same cards, without ownership.
  const guest = isGuest();
  const results = useQuery({
    queryKey: ["search", q, order, page, guest],
    queryFn: async ({ signal }): Promise<{ total: number; page: number; page_size: number; cards: Hit[]; offline?: boolean }> => {
      try {
        return await api<SearchResult>(`/api/${guest ? "guest/" : ""}cards/search?q=${encodeURIComponent(q)}&order=${order}&page=${page}`, { signal });
      } catch (e) {
        if (isNetworkError(e)) return offlineSearch(q, order, page);
        throw e;
      }
    },
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    setParams(next);
  };
  // The card page rides in the URL, so the back button closes it and the results keep their place.
  const openCard = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("card", id);
    setParams(next);
  };
  const closeCard = () => {
    if ((window.history.state as { idx?: number } | null)?.idx) window.history.back();
    else {
      const next = new URLSearchParams(params);
      next.delete("card");
      setParams(next, { replace: true });
    }
  };
  // Closing the card page puts focus back on the card it came from.
  const lastOpen = useRef<string | null>(null);
  useEffect(() => {
    if (open) lastOpen.current = open;
    else if (lastOpen.current) {
      document.querySelector<HTMLButtonElement>(`.cards-card[data-id="${lastOpen.current}"]`)?.focus();
      lastOpen.current = null;
    }
  }, [open]);
  const pages = results.data ? Math.ceil(results.data.total / results.data.page_size) : 0;
  const chips = queryChips(q);
  const priceDate = results.data?.cards.find((c) => c.price_date)?.price_date;

  return (
    <>
      <main className="page cards-page" aria-hidden={open ? true : undefined}>
        <div className="help-heading">
          <h1>Cards</h1>
          <HelpPopover label="Search syntax">
            <p>Search works like Scryfall: <code>o:</code> rules text, <code>t:</code> type, <code>id&lt;=</code> fits a commander, <code>mv</code>, <code>pow</code>, <code>f:commander</code>, <code>is:gamechanger</code>, <code>-</code> to exclude, <code>or</code> and parentheses.</p>
            <p>Also <code>set:cmm</code>, <code>a:</code> artist, <code>year&gt;=2020</code>, <code>usd&lt;5</code> (a card with no price never matches a price) and <code>is:reserved</code>, <code>is:partner</code>, <code>is:mdfc</code>.</p>
          </HelpPopover>
        </div>
        <form
          className="cards-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: draft, page: "1" });
          }}
        >
          <label className="cards-box">
            <span className="visually-hidden">Search cards</span>
            <SearchIcon />
            <input
              type="search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Name, or syntax like t:elf id<=gw"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="search"
            />
          </label>
          <select className="cards-order" value={order} onChange={(e) => set({ order: e.target.value, page: "1" })} aria-label="Sort by">
            {ORDERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button className="visually-hidden">Search</button>
        </form>

        {!q && (
          <div className="cards-help">
            <div className="cards-chips">
              {EXAMPLES.map((e) => (
                <button key={e.q} className="cards-chip" onClick={() => set({ q: e.q, page: "1" })}>{e.label}</button>
              ))}
            </div>
            {/* The release calendar keeps watched sets for an account. */}
            {!guest && <ReleaseCalendar />}
          </div>
        )}

        <ErrorText error={results.error} />
        {q && results.data && (
          <>
            <div className="cards-summary">
              <span className="cards-count">
                {plural(results.data.total, "card")}
                {results.data.offline ? ", searched on this device while offline" : ""}
                <span className="cards-narrow">{priceDate ? `. Prices: ${priceSource(priceDate)}.` : ""}</span>
              </span>
              <div className="cards-chips-row">
                {chips.map((c) => (
                  <span key={c.raw} className="cards-chip term">
                    {c.label}
                    <button aria-label={`Remove ${c.label}`} onClick={() => set({ q: withoutTerm(q, c.raw), page: "1" })}>×</button>
                  </span>
                ))}
                {/* Phones: the sort order is the last chip. */}
                <select className="cards-chip outline cards-order-chip" value={order} onChange={(e) => set({ order: e.target.value, page: "1" })} aria-label="Sort by">
                  {ORDERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              {priceDate && <span className="cards-prices">Prices: {priceSource(priceDate)}</span>}
            </div>
            <ul className="cards-grid">
              {results.data.cards.map((c) => {
                const owned = c.owned ?? 0;
                return (
                  <li key={c.oracle_id}>
                    <button className="cards-card" data-id={c.oracle_id} onClick={() => openCard(c.oracle_id)} aria-label={c.name}>
                      <CardHover name={c.name} oracleId={c.oracle_id} image={c.image_normal}><CardImage src={c.image_normal} name={c.name}/></CardHover>
                    </button>
                    {!results.data!.offline && (
                      <span className="cards-meta">
                        {!guest && (
                          <span className={owned ? "own good" : "own"}>
                            {owned === 0 ? "Not owned" : c.owned_in ? `In ${c.owned_in}` : `You own ${owned}`}
                          </span>
                        )}
                        <span className="num price">{usd(c.usd)}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
            {pages > 1 && (
              <nav className="cards-pages" aria-label="Pages">
                <button disabled={page <= 1} onClick={() => set({ page: String(page - 1) })}>Previous</button>
                <span className="dim num">Page {page} of {pages}</span>
                <button disabled={page >= pages} onClick={() => set({ page: String(page + 1) })}>Next</button>
              </nav>
            )}
          </>
        )}
      </main>
      {open && <CardPage oracleId={open} onClose={closeCard} backLabel={q ? "Search results" : "Cards"} hit={results.data?.cards.find((c) => c.oracle_id === open)} />}
    </>
  );
}

/** The Cards tab's card page: over the results, so closing it keeps their scroll. */
function CardPage({ oracleId, onClose, backLabel, hit }: { oracleId: string; onClose: () => void; backLabel: string; hit?: Card }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="card-page" role="dialog" aria-modal="true" aria-label="Card">
      <CardView key={oracleId} oracleId={oracleId} onBack={onClose} backLabel={backLabel} hit={hit} />
    </div>
  );
}

/** One card's details and printings, as a sheet over another screen. `readOnly` (plan pages) hides the buttons that add copies to your collection. */
export function CardSheet({ oracleId, onClose, readOnly = false }: { oracleId: string; onClose: () => void; readOnly?: boolean }) {
  return (
    <Dialog label="Card" onClose={onClose}>
      <div className="card-sheet2">
        <CardView oracleId={oracleId} onBack={onClose} backLabel="Close" readOnly={readOnly} close />
      </div>
    </Dialog>
  );
}
