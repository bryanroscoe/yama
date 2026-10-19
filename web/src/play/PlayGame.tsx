import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { useMe } from "../auth";
import { ErrorText, Pips } from "../components/ui";
import { BracketChips } from "../components/Bracket";
import { Board } from "./Board";
import type { OnlineGame } from "./types";

export function PlayGame() {
  const { id = "" } = useParams();
  const game = useQuery({
    queryKey: ["play", id],
    queryFn: () => api<OnlineGame>(`/api/play/${id}`),
    refetchInterval: (q) => (q.state.data?.status === "lobby" ? 2000 : false),
  });
  if (game.error) return <main className="page"><ErrorText error={game.error} /></main>;
  if (!game.data) return <main className="page" />;
  if (game.data.status === "lobby") return <Lobby game={game.data} />;
  return <Board id={id} live={game.data.status === "in_progress"} />;
}

function Lobby({ game }: { game: OnlineGame }) {
  const qc = useQueryClient();
  const me = useMe();
  const start = useMutation({
    mutationFn: () => api(`/api/play/${game.id}/start`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["play", game.id] }),
  });
  const isHost = game.host === me.data?.id;
  const open = game.seats.filter((s) => !s.ai && !s.deck_name).length;
  return (
    <main className="page">
      <p className="small"><Link to="/play">Play online</Link></p>
      <h1>Waiting for players</h1>
      <p>
        Friends join from Play online with the code <b className="num" style={{ letterSpacing: "0.08em", fontSize: "var(--t-lg)" }}>{game.code}</b>.
      </p>
      <div className="list">
        {game.seats.map((s) => (
          <div key={s.seat} className="list-row" style={{ gridTemplateColumns: "auto 1fr auto" }}>
            <Pips identity={s.color_identity} />
            <span>
              <span className="title">{s.deck_name ? s.name : "Open seat"}</span>
              {s.ai && <span className="dim"> (computer, {s.ai.toLowerCase()})</span>}
              <br />
              <span className="dim small">{s.deck_name ?? "Waiting for someone to join"}</span>
              {(s.bracket != null || s.estimate) && (
                <>
                  <br />
                  <BracketChips declared={s.bracket} estimate={s.estimate} />
                </>
              )}
            </span>
            <span className="small dim">Seat {s.seat + 1}</span>
          </div>
        ))}
      </div>
      {Object.entries(game.missing_cards).map(([deck, cards]) => (
        <p key={deck} className="small dim">
          {deck}: {cards.length} {cards.length === 1 ? "card isn't" : "cards aren't"} supported by the rules engine yet and will be left out ({cards.join(", ")}).
        </p>
      ))}
      <ErrorText error={start.error} />
      {isHost ? (
        <div className="row" style={{ marginTop: "1rem" }}>
          <button className="primary" disabled={open > 0 || start.isPending} onClick={() => start.mutate()}>
            {open > 0 ? `Waiting for ${open} more` : "Start the game"}
          </button>
        </div>
      ) : (
        <p className="dim">The host starts the game when everyone's here.</p>
      )}
    </main>
  );
}
