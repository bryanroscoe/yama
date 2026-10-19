// One online game: the lobby while seats fill (design/screens/PlayLobby and LobbyPhone), then
// the board.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { useMe } from "../auth";
import { ArtPanel, artCredit } from "../components/ArtPanel";
import { ErrorText, Pips } from "../components/ui";
import { BracketChips } from "../components/Bracket";
import { useCardArt } from "../components/useCardArt";
import { Board } from "./Board";
import type { OnlineGame } from "./types";
import "./play.css";

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

const BackArrow = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

function Lobby({ game }: { game: OnlineGame }) {
  const qc = useQueryClient();
  const me = useMe();
  const [copied, setCopied] = useState(false);
  const start = useMutation({
    mutationFn: () => api(`/api/play/${game.id}/start`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["play", game.id] }),
  });
  const isHost = game.host === me.data?.id;
  const open = game.seats.filter((s) => !s.ai && !s.deck_name).length;
  // Older servers send only the commander's name; look its art up then.
  const lookups = useCardArt(game.seats.filter((s) => !s.commander_art).map((s) => s.commander));
  const artOf = (s: OnlineGame["seats"][number]) =>
    s.commander_art ? { art: s.commander_art, artist: s.commander_artist ?? null } : s.commander ? lookups.get(s.commander) : undefined;
  const link = `${location.origin}/play?code=${encodeURIComponent(game.code)}`;
  const share = async () => {
    const text = `Join my Yama game with the code ${game.code}`;
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: "Yama", text, url: link });
      else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* the person closed the share sheet */
    }
  };
  const title = open === 0 ? "Everyone's in" : open === 1 ? "Waiting for one more" : `Waiting for ${open} more`;
  const missing = Object.entries(game.missing_cards);
  return (
    <main className="page lobby">
      <div className="lobby-top">
        <Link to="/play" className="lobby-back"><BackArrow />Play online</Link>
        <span className="lobby-group">{game.playgroup ? `${game.playgroup}, counts toward group stats` : "Not counted in group stats"}</span>
      </div>

      <div className="lobby-head">
        <div className="lobby-title">
          <h1>{title}</h1>
          <p className="dim">Friends open Play online, enter the code and pick a deck. Their seat fills in here.</p>
        </div>
        <div className="lobby-code" role="group" aria-label="Table code">
          <span className="lobby-code-text">
            <span className="lobby-code-label">Table code</span>
            <span className="lobby-code-value">{game.code}</span>
          </span>
          <button type="button" onClick={share}>{copied ? "Copied" : <><span className="lobby-copy-long">Copy link</span><span className="lobby-copy-short">Share</span></>}</button>
        </div>
      </div>

      <ol className="lobby-grid" aria-label="Seats">
        {game.seats.map((s) => {
          const taken = !!s.deck_name;
          const art = artOf(s);
          const name = taken ? (s.ai ? "Computer" : s.name) : "Open seat";
          const detail = taken ? `${s.deck_name}${s.ai ? `, ${s.ai.toLowerCase()}` : ""}` : "Waiting for someone with the code";
          return (
            <ArtPanel as="li" key={s.seat} className="lobby-tile" art={art?.art} artist={art?.artist} wash="bottom" empty={!taken} credit={false}>
              <span className="lobby-seat-n">Seat {s.seat + 1}</span>
              <span className="lobby-tile-body">
                <span className="lobby-name">{name}</span>
                <span className="lobby-detail">{detail}</span>
                {taken && <Pips identity={s.color_identity} />}
                {(s.bracket != null || s.estimate) && (
                  <span className="lobby-bracket"><BracketChips declared={s.bracket} estimate={s.estimate} /></span>
                )}
                <span className={`lobby-state ${taken ? "good" : "warn"}`}>{taken ? "Ready" : "Waiting"}</span>
                {art?.art && <span className="lobby-credit">{artCredit(art.artist)}</span>}
              </span>
            </ArtPanel>
          );
        })}
      </ol>

      <div className="lobby-foot">
        <div className="lobby-notes">
          {missing.map(([deck, cards]) => (
            <p key={deck} role="note" className="lobby-note">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8v5M12 16.5v.01" />
              </svg>
              <span>
                <b>{deck}</b> has {cards.length} {cards.length === 1 ? "card" : "cards"} the rules engine doesn't support yet. {cards.length === 1 ? "It'll" : "They'll"} be left out: {cards.join(", ")}.
              </span>
            </p>
          ))}
          <ErrorText error={start.error} />
          {!isHost && <p className="dim">The host starts the game when everyone's here.</p>}
        </div>
        {isHost && (
          <button type="button" className="primary lobby-start" disabled={open > 0 || start.isPending} onClick={() => start.mutate()}>
            {open > 0 ? "Start when everyone's in" : "Start the game"}
          </button>
        )}
      </div>
    </main>
  );
}
