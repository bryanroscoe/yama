import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { api, type GameRow } from "../api";
import { useMe } from "../auth";
import { ErrorText, Loading } from "../components/ui";
import { usePendingDeletes } from "./store";
import { isPlaceholderName } from "./playerNames";
import { recentGameText } from "./recent";
import "./gameHistory.css";
import { fmtDate } from "@yama/core";

const FILTERS = [["all", "All games"], ["unfinished", "Unfinished"], ["unnamed", "Unnamed"]] as const;
const PAGE_SIZE = 50;

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
        {FILTERS.map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => change("filter", key)}>{label}</button>)}
      </div>
      <div className="gh-search">
        <label>Find a player or commander<input type="search" value={search} maxLength={100} placeholder="Kelly, Atraxa…" onChange={(e) => change("q", e.target.value, true)} /></label>
        <label>Order<select value={order} onChange={(e) => change("order", e.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
      </div>
      {filter === "unfinished" && <p className="dim">Games still in progress or abandoned.</p>}
      {filter === "unnamed" && <p className="dim">Games with an unnamed human seat or a temporary name like Player 2, Guest 1 or Dude 2.</p>}
      <ErrorText error={games.error} />
      {games.isPending && <Loading>Loading games…</Loading>}
      {games.data && shown.length === 0 && <p>No matching games on this page.</p>}
      <ol className="gh-list">
        {shown.map((g) => {
          const text = recentGameText(g);
          const unnamed = g.seats.filter((s) => !s.ai_kind && (!s.display_name?.trim() || isPlaceholderName(s.display_name)));
          return (
            <li key={g.id}>
              <Link className="gh-game" to={g.mode === "in_person" ? `/table/games/${g.id}` : `/play/${g.id}`} state={{ history: `/table/games?${params}` }}>
                <span className="gh-game-head"><b>{g.status === "abandoned" ? "Abandoned" : text.title}{text.with ? ` with ${text.with}` : ""}</b><time dateTime={g.started_at}>{fmtDate(g.started_at)}</time></span>
                <span className="gh-players">{g.seats.map((s) => `${s.display_name?.trim() || `Seat ${s.seat + 1}`}${s.commander_name ? ` (${s.commander_name})` : ""}`).join(", ")}</span>
                <span className="gh-meta">{g.status === "in_progress" ? "Unfinished" : g.status === "abandoned" ? "Abandoned" : "Finished"}{unnamed.length ? `, ${unnamed.length} unnamed ${unnamed.length === 1 ? "player" : "players"}` : ""}{g.turns ? `, ${g.turns} ${g.mode === "online" ? "player turns" : "turns"}` : ""}</span>
              </Link>
            </li>
          );
        })}
      </ol>
      <nav className="gh-pages" aria-label="Game history pages">
        <button disabled={offset === 0 || games.isPending} onClick={() => change("offset", String(Math.max(0, offset - PAGE_SIZE)))}>Previous</button>
        <span>Page {Math.floor(offset / PAGE_SIZE) + 1}</span>
        <button disabled={!games.data?.has_more || games.isPending} onClick={() => change("offset", String(offset + PAGE_SIZE))}>Next</button>
      </nav>
    </main>
  );
}
