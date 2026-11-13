// One online game: the lobby while seats fill (design/screens/PlayLobby and LobbyPhone), then
// the board.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, publicOrigin } from "../api";
import { useMe } from "../auth";
import { usePlayerId } from "../guestPlay";
import { ArtPanel, artCredit } from "../components/ArtPanel";
import { ask } from "../components/confirm";
import { queryFailure, RefreshFailed } from "../components/QueryError";
import { BackLink, Button, ErrorText, Pips } from "../components/ui";
import { AlphaTag, ALPHA_NOTE } from "../components/AlphaTag";
import { BracketChips } from "../components/Bracket";
import { useCardArt } from "../components/useCardArt";
import { Board } from "./Board";
import type { OnlineGame } from "./types";
import "./play.css";

export function PlayGame() {
  const { id = "" } = useParams();
  const game = useQuery({
    queryKey: ["play", id],
    queryFn: ({ signal }) => api<OnlineGame>(`/api/play/${id}`, { signal }),
    // The lobby fills as friends join: every 4 s while it's on screen (it was 2 s), and at once on
    // coming back to the tab. A game that can't run on its saved engine is asked about every 15 s.
    refetchInterval: (q) => (q.state.data?.runtime_error ? 15_000 : q.state.data?.status === "lobby" ? 4000 : false),
    refetchOnWindowFocus: "always",
  });
  // Only with no game to show, or when the game is gone or not yours: one failed check (the lobby
  // asks every 4 s) leaves the lobby or board up. A table the host cancelled, or a game they
  // deleted, is gone for everyone who had it open: say so, with the way back.
  if (queryFailure(game) === "page") {
    return (
      <main className="page">
        <p><Link to="/play">Play online</Link></p>
        {game.error instanceof ApiError && game.error.status === 404 ? (
          <p role="alert">This game isn't here any more. Its host may have closed the table or deleted the game.</p>
        ) : (
          <ErrorText error={game.error} />
        )}
      </main>
    );
  }
  if (!game.data) return <main className="page" />;
  if (game.data.runtime_error) return <Stranded game={game.data} reason={game.data.runtime_error} />;
  if (game.data.status === "lobby") return <Lobby game={game.data} notice={<RefreshFailed query={game} what="this game" />} />;
  // Keyed by game, so a rematch starts with a fresh board (nothing carried over from the last one).
  return <Board key={id} id={id} live={game.data.status === "in_progress"} phaseBoard={game.data.phase_board === true} />;
}

/** A game whose saved engine this server can't run: nobody can play or finish it, so the host
 * may delete it. It already takes no place among the games they may have open. */
function Stranded({ game, reason }: { game: OnlineGame; reason: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => api(`/api/play/${game.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["play"] });
      navigate("/play", { replace: true });
    },
  });
  return (
    <main className="page">
      <Link to="/play">Play online</Link>
      <p role="alert">{reason}</p>
      {game.stranded && (
        <>
          <p>This game can’t be continued on this version of Yama. It doesn’t count toward the games you may have open, so you can start new ones. You may also delete it.</p>
          <ErrorText error={remove.error} />
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={async () => (await ask({ title: "Delete this game?", body: "It comes out of the history and stats of everyone who played it.", confirm: "Delete the game", danger: true })) && remove.mutate()}
          >
            {remove.isPending ? "Deleting…" : "Delete this game"}
          </Button>
        </>
      )}
    </main>
  );
}

function Lobby({ game, notice }: { game: OnlineGame; notice?: ReactNode }) {
  const qc = useQueryClient();
  const me = useMe();
  const playerId = usePlayerId();
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: () => api(`/api/play/${game.id}/start`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["play", game.id] }),
  });
  // A table nobody ended up playing at: the host takes it down, which also frees its place
  // among the games they may have open.
  const cancel = useMutation({
    mutationFn: () => api(`/api/play/${game.id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["play"] });
      navigate("/play", { replace: true });
    },
  });
  const isHost = !!playerId && game.host === playerId;
  const open = game.seats.filter((s) => !s.ai && !s.deck_name).length;
  // Older servers send only the commander's name; look its art up then.
  const lookups = useCardArt(game.seats.filter((s) => !s.commander_art).map((s) => s.commander));
  const artOf = (s: OnlineGame["seats"][number]) =>
    s.commander_art ? { art: s.commander_art, artist: s.commander_artist ?? null } : s.commander ? lookups.get(s.commander) : undefined;
  const link = `${publicOrigin()}/play?code=${encodeURIComponent(game.code)}`;
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
  // Who takes the first turn: the host's choice when the table was made, or the engine's roll.
  const firstSeat = game.first != null ? game.seats.find((s) => s.seat === game.first) : undefined;
  const goesFirst = !firstSeat
    ? "The first player is rolled for when the game starts."
    : firstSeat.ai
      ? `The computer in seat ${firstSeat.seat + 1} goes first.`
      : firstSeat.deck_name
        ? `${firstSeat.seat === game.you ? "You go" : `${firstSeat.name} goes`} first.`
        : `Whoever takes seat ${firstSeat.seat + 1} goes first.`;
  const missing = Object.entries(game.missing_cards);
  return (
    <main className="page lobby">
      <div className="lobby-top">
        <BackLink inline to="/play" label="Back to Play online" text="Play online" />
        <span className="lobby-group">{game.playgroup ? `${game.playgroup}, counts toward group stats` : "Not counted in group stats"}</span>
      </div>
      {notice}

      <div className="lobby-head">
        <div className="lobby-title">
          <h1>
            {title}
            <AlphaTag />
          </h1>
          <p className="dim">Friends open Play online, enter the code and pick a deck. Their seat fills in here. {goesFirst} {ALPHA_NOTE}</p>
        </div>
        <div className="lobby-code" role="group" aria-label="Table code">
          <span className="lobby-code-text">
            <span className="lobby-code-label">Table code</span>
            <span className="lobby-code-value">{game.code}</span>
          </span>
          <Button onClick={share}>{copied ? "Copied" : <><span className="lobby-copy-long">Copy link</span><span className="lobby-copy-short">Share</span></>}</Button>
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
          <ErrorText error={start.error ?? cancel.error} />
          {!isHost && <p className="dim">The host starts the game when everyone's here.</p>}
        </div>
        {isHost && (
          <div className="lobby-actions">
            <Button
              variant="quiet"
              disabled={cancel.isPending || start.isPending}
              onClick={async () => (await ask({ title: "Close this table?", body: "Its code stops working, and the table closes for anyone who joined.", confirm: "Close the table", danger: true })) && cancel.mutate()}
            >
              {cancel.isPending ? "Closing…" : "Close this table"}
            </Button>
            <Button variant="primary" className="lobby-start" disabled={open > 0 || start.isPending || cancel.isPending} onClick={() => start.mutate()}>
              {open > 0 ? "Start when everyone's in" : start.isPending ? "Starting…" : "Start the game"}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
