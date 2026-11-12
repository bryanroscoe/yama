import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { MANA, ago, plural } from "@yama/core";
import { api } from "../api";
import { ArtCredits, ArtPanel } from "../components/ArtPanel";
import { BRACKETS, BracketChips } from "../components/Bracket";
import { CheckRow } from "../components/Field";
import { AreaHead } from "../components/DeckTabs";
import { Pager } from "../components/Pager";
import { Button, ButtonLink, EmptyState, ErrorText, Field, Loading, Pips } from "../components/ui";
import "../pages/decks.css";
import "./browse.css";
import { NO_FILTER, apiQuery, isFiltered, readFilter, toggleColor, writeFilter, type BrowseFilter } from "./filter";

/** One listed deck, as the listing API gives it (server/src/sharing/browse.rs). */
export interface ListedDeck {
  /** Its shared page is `/d/<token>`. */
  token: string;
  name: string;
  handle: string;
  commanders: string[];
  color_identity: string;
  art: { url: string; artist: string; card: string } | null;
  bracket: number | null;
  card_count: number;
  updated_at: string;
  precon: { id: string; name: string } | null;
}

export interface Listing {
  decks: ListedDeck[];
  page: number;
  pages: number;
  total: number;
}

const COLORS = ["W", "U", "B", "R", "G", "C"] as const;

/** How long after the last keystroke a typed filter is applied. */
const TYPING_MS = 300;

/**
 * Browse (`/decks/browse`): the decks people have made public, newest first. Open to everyone,
 * signed in or not. A tile opens the deck's shared page; "Save a copy" starts an import of its
 * list, which asks for sign-in first when there is none.
 */
export function BrowsePage() {
  const [params, setParams] = useSearchParams();
  const address = params.toString();
  const filter = useMemo(() => readFilter(new URLSearchParams(address)), [address]);
  const listing = useQuery({
    queryKey: ["browse", apiQuery(filter)],
    queryFn: ({ signal }) => api<Listing>(`/api/public/browse${apiQuery(filter)}`, { signal }),
    placeholderData: keepPreviousData,
  });
  // A change lands on the filter the address holds now, and goes back to the first page.
  // Typing more into a search replaces its step in the history; starting one adds a step, so
  // Back from a search returns to the list as it was.
  const change = (patch: Partial<BrowseFilter>, typing = false) => {
    const now = readFilter(new URLSearchParams(window.location.search));
    const starts = (Object.keys(patch) as (keyof BrowseFilter)[]).some((k) => !now[k]);
    setParams(writeFilter({ ...now, page: 0, ...patch }), { replace: typing && !starts });
  };
  // Clearing starts the tools afresh, so text typed a moment ago and still waiting for its
  // pause is dropped with everything else instead of coming back after the clear.
  const [cleared, setCleared] = useState(0);
  const clear = () => {
    setCleared((n) => n + 1);
    change({ ...NO_FILTER });
  };
  const data = listing.data;
  const preconName = filter.precon && filter.precon !== "any" ? (data?.decks.find((d) => d.precon?.id === filter.precon)?.precon?.name ?? null) : null;
  return (
    <main className="page">
      <AreaHead index title="Browse decks" />
      <p className="dim browse-about">
        Commander decks people have made public on Yama, the most recently saved first. Open one to see its list, or save a copy to make it yours. A deck is marked as started from a precon when its
        list still holds at least half of that precon's own cards.
      </p>
      <BrowseTools key={cleared} filter={filter} onChange={change} onClear={clear} preconName={preconName} total={data?.total} />
      <ErrorText error={listing.error} />
      {!data && listing.isPending && <Loading>Loading decks…</Loading>}
      {data && data.total === 0 &&
        (isFiltered(filter) ? (
          <EmptyState variant="boxed" action={<Button onClick={clear}>Clear filters</Button>}>
            No decks match.
          </EmptyState>
        ) : (
          <EmptyState>No public decks yet. A deck its builder makes public shows up here.</EmptyState>
        ))}
      {data && data.decks.length > 0 && (
        <>
          <ul className="deck-tiles browse-tiles">
            {data.decks.map((d) => (
              <li key={d.token}>
                <BrowseTile deck={d} />
              </li>
            ))}
          </ul>
          {data.pages > 1 && (
            <Pager
              label="Pages of decks"
              page={data.page + 1}
              pages={data.pages}
              busy={listing.isFetching}
              onPrevious={data.page > 0 ? () => change({ page: data.page - 1 }) : undefined}
              onNext={data.page + 1 < data.pages ? () => change({ page: data.page + 1 }) : undefined}
            />
          )}
          {data.decks.some((d) => d.art) && <ArtCredits artists={data.decks.map((d) => d.art?.artist)} />}
        </>
      )}
    </main>
  );
}

/** A text filter that waits for a pause in typing before it changes the address. */
function useTyped(value: string, apply: (next: string) => void): [string, (next: string) => void] {
  const [text, setText] = useState(value);
  // The address changed some other way (Back, Clear filters): show what it says.
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => apply(text), TYPING_MS);
    return () => clearTimeout(timer);
    // `apply` is new every render; only the text and the address decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, value]);
  return [text, setText];
}

function BrowseTools({ filter, onChange, onClear, preconName, total }: { filter: BrowseFilter; onChange: (patch: Partial<BrowseFilter>, typing?: boolean) => void; onClear: () => void; preconName: string | null; total: number | undefined }) {
  const [q, setQ] = useTyped(filter.q, (next) => onChange({ q: next }, true));
  const [commander, setCommander] = useTyped(filter.commander, (next) => onChange({ commander: next }, true));
  return (
    <div className="deck-index-tools" role="search" aria-label="Find a public deck">
      <input
        type="search"
        className="deck-index-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search public decks by name or commander"
        aria-label="Search public decks by name or commander"
        maxLength={100}
      />
      <div className="deck-index-fields">
        <Field label="Commander">
          <input value={commander} onChange={(e) => setCommander(e.target.value)} maxLength={100} autoComplete="off" />
        </Field>
        <div className="deck-index-colors" role="group" aria-label="Colors the deck includes">
          <span className="deck-index-label" aria-hidden="true">Colors</span>
          <span className="deck-index-pips">
            {COLORS.map((k) => (
              <Button key={k} aria-pressed={filter.colors.includes(k)} aria-label={MANA[k].name} title={MANA[k].name} onClick={() => onChange({ colors: toggleColor(filter.colors, k) })}>
                <Pips identity={k} label={false} />
              </Button>
            ))}
          </span>
        </div>
        <Field label="Declared bracket">
          <select value={filter.bracket} onChange={(e) => onChange({ bracket: e.target.value })}>
            <option value="">Any</option>
            {BRACKETS.map((b) => (
              <option key={b.value} value={String(b.value)}>
                {b.value}, {b.name}
              </option>
            ))}
          </select>
        </Field>
        <CheckRow className="browse-precon" checked={!!filter.precon} onChange={(e) => onChange({ precon: e.target.checked ? "any" : "" })}>
          {filter.precon && filter.precon !== "any" ? `Started from ${preconName ?? "this precon"}` : "Started from a precon"}
        </CheckRow>
      </div>
      {/* Always here, so a screen reader hears the count when a filter narrows the list. */}
      <p className="small deck-index-count">
        <span role="status">{total === undefined ? "" : isFiltered(filter) ? `${plural(total, "deck")} match` : plural(total, "public deck")}</span>
        {(isFiltered(filter) || q.trim() !== "" || commander.trim() !== "") && <Button variant="quiet" onClick={onClear}>Clear filters</Button>}
      </p>
    </div>
  );
}

function BrowseTile({ deck: d }: { deck: ListedDeck }) {
  return (
    <>
      {/* The shared page is drawn by the server, so this is a document link, not a route. */}
      <a href={`/d/${d.token}`} className="deck-tile">
        {/* One credit line for every tile's art sits under the grid. */}
        <ArtPanel art={d.art?.url} artist={d.art?.artist} wash="bottom" empty={!d.commanders.length} credit={false}>
          <Pips identity={d.color_identity} />
          <span className="deck-tile-name">{d.name}</span>
          <span className="deck-tile-meta deck-tile-cmdr">{d.commanders.join(" and ") || "No commander set"}</span>
          {d.bracket != null && (
            <span className="deck-tile-meta deck-tile-bracket">
              <BracketChips declared={d.bracket} />
            </span>
          )}
          {d.precon && <span className="deck-tile-meta">Started from {d.precon.name}</span>}
          <span className="deck-tile-foot num">
            <span>{plural(d.card_count, "card")}</span>
            <span>By @{d.handle}</span>
            <span>Updated {ago(d.updated_at)}</span>
          </span>
        </ArtPanel>
      </a>
      <ButtonLink variant="quiet" size="small" className="browse-copy" to={`/decks/import?shared=${encodeURIComponent(d.token)}`} aria-label={`Save a copy of ${d.name}`}>
        Save a copy
      </ButtonLink>
    </>
  );
}
