import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { useMe } from "../auth";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { ErrorText, Pips } from "../components/ui";
import { useCardArt } from "../components/useCardArt";
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
  const arts = useCardArt(game.seats.map((s) => s.commander));
  const shownArt = game.seats.map((s) => (s.commander ? arts.get(s.commander) : undefined)).filter((a) => a?.art);
  return (
    <main className="page">
      <p className="small"><Link to="/play">Play online</Link></p>
      <h1>Waiting for players</h1>
      <p>
        Friends join from Play online with the code <b className="num" style={{ letterSpacing: "0.08em", fontSize: "var(--t-lg)" }}>{game.code}</b>.
      </p>
      <ol className="lobby-seats" aria-label="Seats">
        {game.seats.map((s) => {
          const taken = !!s.deck_name;
          const art = s.commander ? arts.get(s.commander) : undefined;
          return (
            <ArtPanel as="li" key={s.seat} className="lobby-seat" art={art?.art} artist={art?.artist} wash="bottom" empty={!taken} credit={false}>
              <span className="seat-n">Seat {s.seat + 1}</span>
              <span className="seat-name">{taken ? (s.ai ? `Computer, ${s.ai.toLowerCase()}` : s.name) : "Open seat"}</span>
              <span className="seat-what">
                <span className="seat-cmdr">{s.deck_name ?? "Needs the code"}</span>
                {taken && <Pips identity={s.color_identity} label={false} />}
              </span>
              <span className={`seat-state ${taken ? "good" : "warn"}`}>{taken ? "Ready" : "Waiting"}</span>
            </ArtPanel>
          );
        })}
      </ol>
      {shownArt.length > 0 && <p className="small dim">{artCredits(shownArt.map((a) => a!.artist))}</p>}
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
