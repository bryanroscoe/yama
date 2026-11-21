import { HelpPopover } from "../components/HelpPopover";
import { CardHover } from "../components/CardRef";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { api, ApiError, errorMessage, unanswered, type Card, type SearchResult } from "../api";
import { isNetworkError } from "../cardDetail";
import { isGuest } from "../guest";
import { Button, ButtonLink, CardImage, Details, Dialog, ErrorText, Pager } from "../components/ui";
import { offlineCardNames, offlineSearch } from "../offline/cards";
import { ReleaseCalendar } from "../components/Upcoming";
import { cardNamed, didYouMean, exactNameQuery, nameBeingTyped, nameQuery, queryChips, searchableNames, searchErrorWords, withoutTerm, wordsToLookUp } from "./cardQuery";
import { CardSearchBox } from "./CardSearchBox";
import { CardView } from "./CardView";
import "./cards.css";
import { orderUsed, priceSource, usd, plural } from "@yama/core";
import { BugButton } from "../bugs/BugButton";

const EXAMPLES = [
  { q: "id<=ug is:commander", label: "Simic commanders" },
  { q: 't:land o:"enters tapped" -o:"unless" id<=wr', label: "Boros taplands" },
  { q: 'o:"draw a card" mv<=2 id<=ub', label: "Cheap Dimir draw" },
  { q: "kw:flying t:creature pow>=4", label: "Big flyers" },
];

/** A search hit with what the grid shows under it. Offline hits have no price or ownership. */
type Hit = Card & { usd?: number | null; price_date?: string | null; owned?: number; owned_in?: string | null };

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

/** What the search understands: behind the "?" by the heading, and under a search that found nothing or couldn't be read. */
const SYNTAX = (
  <>
    <p>Search works like Scryfall: <code>o:</code> rules text, <code>t:</code> type, <code>id&lt;=</code> fits a commander, <code>mv</code>, <code>pow</code>, <code>f:commander</code>, <code>is:gamechanger</code>, <code>-</code> to exclude, <code>or</code> and parentheses.</p>
    <p>Also <code>set:cmm</code>, <code>a:</code> artist, <code>year&gt;=2020</code>, <code>usd&lt;5</code> (a card with no price never matches a price; <code>set:</code>, <code>a:</code> and <code>year</code> side by side are about the same printing) and <code>is:reserved</code>, <code>is:partner</code>, <code>is:mdfc</code>.</p>
  </>
);

/**
 * Names to look for a misspelled one among. An account's device keeps the name of every card (the
 * offline copy): all of them. Without that copy, the most played cards that share a long word with
 * what was typed, from the search itself ("bolt" finds Lightning Bolt for "lightnig bolt").
 */
async function nameCandidates(typed: string, guest: boolean, signal: AbortSignal): Promise<string[]> {
  const saved = await offlineCardNames().catch(() => null);
  if (saved?.length) return searchableNames(saved);
  const pages = await Promise.all(
    wordsToLookUp(typed).map((w) => api<SearchResult>(`/api/${guest ? "guest/" : ""}cards/search?q=${encodeURIComponent(w)}&order=edhrec&page=1`, { signal }).catch(() => null)),
  );
  return pages.flatMap((p) => p?.cards.map((c) => c.name) ?? []);
}

/**
 * A search that couldn't be read, as a sentence; null when the failure isn't about the query (no
 * answer, too many searches), which says its own piece.
 */
export function searchProblem(e: unknown): string | null {
  if (!e || unanswered(e)) return null;
  const message = errorMessage(e);
  const known = searchErrorWords(message);
  if (known) return known;
  // Any other "bad request" is still about the query: its own words when they are a sentence.
  if (e instanceof ApiError && e.status === 400) return /^[A-Z].*[.!?]$/.test(message) ? message : "Yama couldn't read that search.";
  return null;
}

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
  // A name picked from the box's suggestions: search for it and open that card. Back from the
  // card is then the results for the name. The card is found by its exact name, on its own, not
  // in the results: they may be sorted another way, or run past the first page.
  const [picked, setPicked] = useState<string | null>(null);
  // The card that lookup found, kept for the card page: signed out, the page is drawn from a
  // search hit, and the results on screen may not have this card on their first page.
  const [pickedHit, setPickedHit] = useState<Card | null>(null);
  const pickName = (name: string) => {
    setPicked(name);
    set({ q: nameQuery(name), page: "1" });
  };
  const pickedCard = useQuery({
    queryKey: ["card-named", picked],
    queryFn: ({ signal }) => api<SearchResult>(`/api/${guest ? "guest/" : ""}cards/search?q=${encodeURIComponent(exactNameQuery(picked!))}&order=name&page=1`, { signal }),
    enabled: !!picked,
    retry: false,
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    // Wait for the address to carry the pick's search, so Back from the card lands on it.
    if (!picked || q !== nameQuery(picked)) return;
    if (pickedCard.isError) return setPicked(null);
    if (!pickedCard.data) return;
    setPicked(null);
    const card = cardNamed(pickedCard.data.cards, picked);
    if (!card) return;
    setPickedHit(card);
    openCard(card.oracle_id);
    // Once per pick, when the card is found; openCard reads the address as it is then.
  }, [picked, q, pickedCard.data, pickedCard.isError]);
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
  // A page turn starts at the top of the new page: the pager is under the last card, and the
  // address changing doesn't move the scroll. Only when the summary is off-screen, so a new search
  // typed at the top (which also goes back to page 1) stays where it is.
  const summary = useRef<HTMLDivElement>(null);
  const turned = useRef(page);
  useEffect(() => {
    if (turned.current === page) return;
    turned.current = page;
    const el = summary.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight) el.scrollIntoView({ block: "start" });
  }, [page]);
  // Nothing found for plain words is most often a misspelled name: offer the nearest ones.
  const queryNote = searchProblem(results.error);
  const none = !!q && !!results.data && !results.isPlaceholderData && results.data.total === 0;
  const typedName = nameBeingTyped(q);
  const meant = useQuery({
    queryKey: ["did-you-mean", typedName?.toLowerCase(), guest],
    queryFn: async ({ signal }) => didYouMean(typedName!, await nameCandidates(typedName!, guest, signal)),
    enabled: none && !!typedName && !results.data?.offline,
    staleTime: Infinity,
    retry: false,
  });
  const sort = (
    <label className="cards-sort">
      Sort
      <select className="cards-chip outline cards-order-chip" value={order} onChange={(e) => set({ order: e.target.value, page: "1" })} aria-label="Sort by">
        {ORDERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );

  return (
    <>
      <main className="page cards-page" aria-hidden={open ? true : undefined}>
        <div className="help-heading">
          <h1>Cards</h1>
          <HelpPopover label="Search syntax">{SYNTAX}</HelpPopover>
          {/* Cards in hand go straight to the collection's scanner. */}
          {!guest && <ButtonLink variant="outline" size="small" className="cards-scan" to="/collection?scan=1">Scan my cards</ButtonLink>}
          <BugButton />
        </div>
        <form
          className="cards-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setPicked(null);
            set({ q: draft, page: "1" });
          }}
        >
          <CardSearchBox
            value={draft}
            onChange={(v) => {
              // Typing again is a new search: a name picked a moment ago no longer opens its card.
              setDraft(v);
              setPicked(null);
            }}
            onPick={pickName}
            suggest
            guest={guest}
          />
          <select className="cards-order" value={order} onChange={(e) => set({ order: e.target.value, page: "1" })} aria-label="Sort by">
            {ORDERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <Button type="submit" className="visually-hidden">Search</Button>
        </form>

        {!q && (
          <div className="cards-help">
            <div className="cards-chips">
              {EXAMPLES.map((e) => (
                <Button key={e.q} className="cards-chip" onClick={() => set({ q: e.q, page: "1" })}>{e.label}</Button>
              ))}
            </div>
            {/* The release calendar keeps watched sets for an account. */}
            {!guest && <ReleaseCalendar />}
          </div>
        )}

        {queryNote ? (
          <div className="cards-problem">
            <p className="error" role="alert">{queryNote}</p>
            <Details label="Search syntax">{SYNTAX}</Details>
          </div>
        ) : (
          <ErrorText error={results.error} />
        )}
        {/* A search that couldn't be read keeps its chips, so the term at fault can be taken out. */}
        {q && !results.data && results.error && chips.length > 0 && (
          <div className="cards-summary">
            <div className="cards-chips-row">
              {/* As typed, not in words: a term the search can't read has no meaning to put into words. */}
              {chips.map((c) => (
                <span key={c.raw} className="cards-chip term">
                  {c.raw}
                  <Button aria-label={`Remove ${c.raw}`} onClick={() => set({ q: withoutTerm(q, c.raw), page: "1" })}>×</Button>
                </span>
              ))}
            </div>
          </div>
        )}
        {q && results.data && (
          <>
            <div className="cards-summary" ref={summary}>
              {/* Phones: the count with the sort at its right, always on screen (the chips above it scroll sideways). */}
              {/* Nothing found says so in words below: no "0 cards" over it (offline, the line still says where it searched). */}
              {(!none || results.data.offline) && <div className="cards-count-line">
                <span className="cards-count">
                  {plural(results.data.total, "card")}
                  {results.data.offline ? ", searched on this device while offline" : ""}
                  {results.data.offline && orderUsed(order) !== order ? ", in name order (prices and release dates aren't kept on the device)" : ""}
                  <span className="cards-narrow">{priceDate ? `. Prices: ${priceSource(priceDate)}.` : ""}</span>
                </span>
                {results.data.total > 1 && sort}
              </div>}
              {chips.length > 0 && (
                <div className="cards-chips-row">
                  {chips.map((c) => (
                    <span key={c.raw} className="cards-chip term">
                      {c.label}
                      <Button aria-label={`Remove ${c.label}`} onClick={() => set({ q: withoutTerm(q, c.raw), page: "1" })}>×</Button>
                    </span>
                  ))}
                </div>
              )}
              {priceDate && <span className="cards-prices">Prices: {priceSource(priceDate)}</span>}
            </div>
            {none && (
              <div className="cards-none">
                <p className="cards-none-head">No card matches{typedName ? ` "${typedName}"` : " that search"}.</p>
                {(meant.data?.length ?? 0) > 0 && (
                  <div className="cards-meant">
                    <span>Did you mean</span>
                    {meant.data!.map((name) => (
                      <Button key={name} className="cards-chip" onClick={() => set({ q: nameQuery(name), page: "1" })}>{name}</Button>
                    ))}
                  </div>
                )}
                <p className="dim">
                  {typedName ? "Check the spelling, or type just part of the name." : chips.length > 1 ? "Take one of the filters above off (its ×) to find more." : "Nothing fits that filter."}
                </p>
                <Details label="Search syntax">{SYNTAX}</Details>
              </div>
            )}
            <ul className="cards-grid">
              {results.data.cards.map((c) => {
                const owned = c.owned ?? 0;
                return (
                  <li key={c.oracle_id}>
                    <Button className="cards-card" data-id={c.oracle_id} onClick={() => openCard(c.oracle_id)} aria-label={c.name}>
                      <CardHover name={c.name} oracleId={c.oracle_id} image={c.image_normal}><CardImage src={c.image_normal} name={c.name}/></CardHover>
                    </Button>
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
              <Pager label="Card search pages" page={page} pages={pages} onPrevious={page > 1 ? () => set({ page: String(page - 1) }) : undefined} onNext={page < pages ? () => set({ page: String(page + 1) }) : undefined} />
            )}
          </>
        )}
      </main>
      {open && <CardPage oracleId={open} onClose={closeCard} backLabel={q ? "Search results" : "Cards"} hit={results.data?.cards.find((c) => c.oracle_id === open) ?? (pickedHit?.oracle_id === open ? pickedHit : undefined)} />}
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
/** `hit`: the card as already loaded, shown to someone without an account (CardView). */
export function CardSheet({ oracleId, onClose, readOnly = false, hit }: { oracleId: string; onClose: () => void; readOnly?: boolean; hit?: Card }) {
  return (
    <Dialog label="Card" onClose={onClose}>
      <div className="card-sheet2">
        <CardView oracleId={oracleId} onBack={onClose} backLabel="Close" readOnly={readOnly} close hit={hit} />
      </div>
    </Dialog>
  );
}
