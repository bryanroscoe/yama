// One watched all-AI game: the online board in watch mode (Board, `watch`).

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { ErrorText } from "../components/ui";
import { Board } from "./Board";
import type { WatchSummary } from "./watch";
import "./play.css";

export function WatchGame() {
  const { id = "" } = useParams();
  // Check the game exists (and is yours) before opening its socket.
  const game = useQuery({ queryKey: ["watch", id], queryFn: () => api<WatchSummary>(`/api/watch/${id}`), retry: false });
  if (game.error) {
    return (
      <main className="page stack">
        <ErrorText error={game.error} />
        <p className="dim">Watched games end when the server restarts, and finished ones are cleared after half an hour.</p>
        <Link to="/play/watch" className="button outline">Set up a game</Link>
      </main>
    );
  }
  if (!game.data) return <main className="page" />;
  return <Board key={id} id={id} live watch />;
}
