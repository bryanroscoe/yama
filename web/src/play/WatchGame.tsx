// One watched all-AI game: the online board in watch mode (Board, `watch`).

import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api } from "../api";
import { queryFailure } from "../components/QueryError";
import { ButtonLink, ErrorText } from "../components/ui";
import { Board } from "./Board";
import type { WatchSummary } from "./watch";
import "./play.css";

export function WatchGame() {
  const { id = "" } = useParams();
  // Check the game exists (and is yours) before opening its socket.
  const game = useQuery({ queryKey: ["watch", id], queryFn: () => api<WatchSummary>(`/api/watch/${id}`), retry: false });
  // The board stays through a check that got no answer; a game that's gone (cleared, or the
  // server restarted) says so.
  if (queryFailure(game) === "page") {
    return (
      <main className="page stack">
        <ErrorText error={game.error} />
        <p className="dim">Watched games end when the server restarts, and finished ones are cleared after half an hour.</p>
        <ButtonLink to="/play/watch" variant="outline">Set up a game</ButtonLink>
      </main>
    );
  }
  if (!game.data) return <main className="page" />;
  return <Board key={id} id={id} live watch />;
}
