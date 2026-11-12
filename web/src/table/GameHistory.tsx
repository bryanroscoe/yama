import { useQuery } from "@tanstack/react-query";
import { GAME_WORDS } from "@yama/core";
import { Link, useSearchParams } from "react-router";
import { api, type GameRow } from "../api";
import { useMe } from "../auth";
import { Button, ButtonLink, EmptyState, ErrorText, Field, Loading } from "../components/ui";
import { usePendingDeletes } from "./store";
import { isPlaceholderName } from "./playerNames";
import { recentGameText, turnsText } from "./recent";
import "./gameHistory.css";
import { fmtDate } from "@yama/core";

const FILTERS = [["all", "All games"], ["unfinished", "Unfinished"], ["unnamed", "Unnamed"]] as const;
const PAGE_SIZE = 50;

/**
 * Why a page of the history is empty: the account has no games at all ("none"), a filter or a
 * search found nothing ("no-match"), or the page is past the last game ("past-end").
 */
export function emptyHistory({ filter, search, offset }: { filter: string; search: string; offset: number }): "none" | "no-match" | "past-end" {
  if (offset > 0) return "past-end";
  return filter !== "all" || search.trim() ? "no-match" : "none";
}

export function GameHistoryPage() {
  const me = useMe().data;
  const [params, setParams] = useSearchParams();
  const filter = FILTERS.some(([key]) => key === params.get("filter")) ? params.get("filter")! : "all";
  const order = params.get("order") === "oldest" ? "oldest" : "newest";
  const search = params.get("q") ?? "";
  const rawOffset = Number(params.get("offset") ?? 0);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 4_294_967_295 ? rawOffset : 0;
  const query = new URLSearchParams({ filter, order, q: search, offset: String(offset) });
  const games = useQuery({
    queryKey: ["games", "history", me?.id, filter, order, search, offset],
    queryFn: ({ signal }) => api<{ games: GameRow[]; has_more: boolean }>(`/api/games/history?${query}`, { signal }),
    enabled: !!me,
  });
  const deleting = usePendingDeletes();
  const shown = games.data?.games.filter((g) => !deleting.includes(g.id)) ?? [];
  // Nothing to show, for one of three reasons, each with its own way on.
  // (A page whose games are all waiting to be deleted, with more after it, just pages on.)
  const empty = games.data && shown.length === 0 && !games.data.has_more ? emptyHistory({ filter, search, offset }) : null;
  const change = (key: string, value: string, replace = false) => {
    // BrowserRouter updates the address before its React transition commits. A quick filter
    // change followed by typing must build on that address, not the previous render's params.
    const next = new URLSearchParams(window.location.search);
    next.set(key, value);
    if (key !== "offset") next.delete("offset");
    setParams(next, { replace });
  };

  return (
    <main className="page game-history">
      <header className="gh-head">
        <nav className="gh-crumbs" aria-label="Related pages"><Link to="/">Table</Link><Link to="/group">Playgroup stats</Link></nav>
        <h1>Game history</h1>
      </header>
      <p className="dim">Review old games or delete ones you recorded.</p>
      <div className="gh-filters" role="group" aria-label="Show games">
        {FILTERS.map(([key, label]) => <Button key={key} aria-pressed={filter === key} onClick={() => change("filter", key)}>{label}</Button>)}
      </div>
      <div className="gh-search">
        <Field label="Find a player or commander"><input type="search" value={search} maxLength={100} placeholder="Kelly, Atraxa…" onChange={(e) => change("q", e.target.value, true)} /></Field>
        <Field label="Order"><select value={order} onChange={(e) => change("order", e.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></Field>
      </div>
      {filter === "unfinished" && <p className="dim">Games still going, or abandoned.</p>}
      {filter === "unnamed" && <p className="dim">Games with an unnamed human seat or a temporary name like Player 2, Guest 1 or Dude 2.</p>}
      <ErrorText error={games.error} />
      {games.isPending && <Loading>Loading games…</Loading>}
      {empty === "none" && (
        <EmptyState
          title="No games yet"
          action={
            <>
              <ButtonLink variant="primary" to="/">Start a game</ButtonLink>
              <ButtonLink variant="outline" to="/" state={{ log: true }}>Log one you played</ButtonLink>
            </>
          }
        >
          Games you play at the table, online or log afterwards are listed here.
        </EmptyState>
      )}
      {empty === "no-match" && (
        <EmptyState action={<ButtonLink variant="outline" to="/table/games">Show all games</ButtonLink>}>
          No games match{search ? ` “${search}”` : ""}{filter === "unfinished" ? " among unfinished games" : filter === "unnamed" ? " among games with unnamed players" : ""}.
        </EmptyState>
      )}
      {empty === "past-end" && (
        <EmptyState action={<Button variant="outline" onClick={() => change("offset", "0")}>Back to the first page</Button>}>
          No more games on this page.
        </EmptyState>
      )}
      <ol className="gh-list">
        {shown.map((g) => {
          const text = recentGameText(g);
          const unnamed = g.seats.filter((s) => !s.ai_kind && (!s.display_name?.trim() || isPlaceholderName(s.display_name)));
          return (
            <li key={g.id}>
              <Link className="gh-game" to={g.mode === "in_person" ? `/table/games/${g.id}` : `/play/${g.id}`} state={{ history: `/table/games?${params}` }}>
                <span className="gh-game-head"><b>{g.status === "abandoned" ? GAME_WORDS.abandoned : text.title}{text.with ? ` with ${text.with}` : ""}</b><time dateTime={g.started_at}>{fmtDate(g.started_at)}</time></span>
                <span className="gh-players">{g.seats.map((s) => `${s.display_name?.trim() || `Seat ${s.seat + 1}`}${s.commander_name ? ` (${s.commander_name})` : ""}`).join(", ")}</span>
                <span className="gh-meta">{g.status === "in_progress" ? GAME_WORDS.going : g.status === "abandoned" ? GAME_WORDS.abandoned : GAME_WORDS.finished}{unnamed.length ? `, ${unnamed.length} unnamed ${unnamed.length === 1 ? "player" : "players"}` : ""}{g.turns ? `, ${turnsText(g)}` : ""}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      {/* One page of games, or none, has nothing to page through. */}
      {(offset > 0 || games.data?.has_more) && (
        <nav className="gh-pages" aria-label="Game history pages">
          <Button disabled={offset === 0 || games.isPending} onClick={() => change("offset", String(Math.max(0, offset - PAGE_SIZE)))}>Previous</Button>
          <span>Page {Math.floor(offset / PAGE_SIZE) + 1}</span>
          <Button disabled={!games.data?.has_more || games.isPending} onClick={() => change("offset", String(offset + PAGE_SIZE))}>Next</Button>
        </nav>
      )}
    </main>
  );
}
