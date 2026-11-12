// Home (`/`): where Yama opens and where the wordmark goes (Bryan, 12 Nov 2026). Signed out it
// says what Yama is and lists what works without an account. Signed in it puts a game in progress
// on top, then starting a game, your recent decks and your playgroup's latest games. The life
// counter's setup, which used to be this page, is at /play/table.
import { useQuery } from "@tanstack/react-query";
import { fmtDateTime } from "@yama/core";
import { useEffect } from "react";
import { Link, Navigate } from "react-router";
import { api, publicOrigin, type DeckSummary, type GameRow } from "../api";
import { useMe } from "../auth";
import { artCredits } from "../components/ArtPanel";
import { ButtonLink, CardThumb, EmptyState, ErrorText } from "../components/ui";
import { gameSummary } from "../table/history";
import { RecentGameRows } from "../table/RecentGameRows";
import { isOpening, opened, resumesOnOpen } from "../table/resume";
import { usePendingDeletes, useTable } from "../table/store";
import "./homePage.css";

/**
 * What works without an account, in the order Home lists it. `page`: a page the server draws (a
 * document link). A new public page is one line here: Check a deck (`/check`) goes first and
 * Browse decks (`/decks/browse`) before the precons, once those routes exist.
 */
export const HOME_LINKS: { to: string; title: string; text: string; action: string; page?: boolean }[] = [
  { to: "/play/table", title: "Start a game", text: "A life counter for up to six players. Games stay on this device.", action: "Count life" },
  { to: "/play", title: "Play the computer", text: "A game of Commander online, with precons to choose from. In alpha: expect bugs and slow turns.", action: "Play online" },
  { to: "/precons", title: "Find your next precon", text: "Every Commander precon: stock lists, rankings and upgrades.", action: "Browse precons", page: true },
  { to: "/commanders", title: "Look up a commander", text: "Commanders ranked by how they do in real games.", action: "Browse commanders", page: true },
  { to: "/cards", title: "Search cards", text: "Every card, with rulings, printings and dated market prices.", action: "Search" },
];

/** Decks and games on Home: a look, not the whole list. */
const RECENT_DECKS = 4;
const LATEST_GAMES = 3;

export function HomePage() {
  const me = useMe();
  const { game, state } = useTable();
  // Opening Yama with a game in progress goes straight to it: once, on the visit's first look
  // at Home (table/resume.ts). Coming Home later shows Home, with the game on top.
  const straight = isOpening() && !!game && !!state && !state.finished && resumesOnOpen(game, Date.now());
  useEffect(opened, []);
  if (straight) return <Navigate to="/table/play" replace />;
  return me.data ? <SignedInHome /> : <SignedOutHome />;
}

function SignedOutHome() {
  return (
    <main className="page home-page">
      <header className="home-intro">
        <h1>Commander, at your table.</h1>
        <p className="home-lede">Yama is a free Magic: The Gathering app for Commander players. Count life, look up cards and compare precons without an account. Sign in to keep your decks, your collection and your playgroup's games.</p>
        <p>
          <ButtonLink variant="primary" to="/signin">Sign in</ButtonLink>
        </p>
      </header>
      <section aria-labelledby="home-open-title">
        <h2 id="home-open-title">No account needed</h2>
        <div className="home-links">
          {HOME_LINKS.map((l) => {
            const inner = (
              <>
                <h3>{l.title}</h3>
                <p>{l.text}</p>
                <span className="home-link-action">{l.action} <span aria-hidden="true">→</span></span>
              </>
            );
            return l.page ? <a key={l.to} className="home-link" href={`${publicOrigin()}${l.to}`}>{inner}</a> : <Link key={l.to} className="home-link" to={l.to}>{inner}</Link>;
          })}
        </div>
      </section>
    </main>
  );
}

function SignedInHome() {
  const { game, state } = useTable();
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }) });
  const games = useQuery({ queryKey: ["games"], queryFn: ({ signal }) => api<GameRow[]>("/api/games", { signal }) });
  // A game deleted while offline stays out of the list until Yama catches up.
  const deleting = usePendingDeletes();
  // A deck's other configurations sit under it on the Decks page; Home shows the deck once.
  const recent = decks.data?.filter((d) => !d.parent_id).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, RECENT_DECKS);
  const latest = games.data?.filter((g) => !deleting.includes(g.id)).slice(0, LATEST_GAMES);
  const pictured = recent?.filter((d) => d.commander_image) ?? [];
  const going = !!game && !!state && !state.finished;
  return (
    <main className="page home-page">
      <h1>Home</h1>
      {going && (
        <section className="home-resume" aria-labelledby="home-resume-title">
          <div>
            <h2 id="home-resume-title">Game in progress</h2>
            <p>{gameSummary(state)}</p>
            <p className="small dim">Started {fmtDateTime(game.setup.startedAt)}, on this device.</p>
          </div>
          <ButtonLink variant="primary" to="/table/play">Back to the table</ButtonLink>
        </section>
      )}
      <section aria-labelledby="home-start-title">
        <h2 id="home-start-title">Start a game</h2>
        <div className="home-start">
          {/* One primary: going back to a game in progress, else starting one. */}
          <ButtonLink variant={going ? "secondary" : "primary"} to="/play/table">Count life at the table</ButtonLink>
          <ButtonLink variant="outline" to="/play">Play online</ButtonLink>
          <ButtonLink variant="outline" to="/play/table" state={{ log: true }}>Log a game you played</ButtonLink>
        </div>
      </section>
      <section aria-labelledby="home-decks-title">
        <h2 id="home-decks-title">Your recent decks</h2>
        <ErrorText error={decks.error} />
        {recent?.length === 0 && (
          <EmptyState
            variant="compact"
            action={
              <>
                <ButtonLink to="/decks/import">Add a deck</ButtonLink>
                <ButtonLink variant="outline" to="/lab">Start from a precon</ButtonLink>
              </>
            }
          >
            No decks yet. Import a list, or start from a precon.
          </EmptyState>
        )}
        {!!recent?.length && (
          <>
            <ul className="home-decks">
              {recent.map((d) => (
                <li key={d.id}>
                  <Link to={`/decks/${d.id}`} className="home-deck">
                    <span className="home-deck-art"><CardThumb src={d.commander_image} /></span>
                    <span className="home-deck-text">
                      <b>{d.name}</b>
                      {d.commanders.length > 0 && <span>{d.commanders.join(" and ")}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {pictured.length > 0 && <p className="small dim home-credit">{artCredits(pictured.map((d) => d.commander_artist))}</p>}
            <p className="home-more"><Link to="/decks">All your decks</Link></p>
          </>
        )}
      </section>
      <section aria-labelledby="home-games-title">
        <h2 id="home-games-title">Your playgroup's latest games</h2>
        <ErrorText error={games.error} />
        {latest?.length === 0 && <p className="dim">No games yet. A game you finish on the life counter, play online or log shows up here.</p>}
        {!!latest?.length && <RecentGameRows games={latest} />}
        <p className="home-more">
          <Link to="/table/games">All games</Link>
          <Link to="/group">Playgroup stats</Link>
        </p>
      </section>
    </main>
  );
}
