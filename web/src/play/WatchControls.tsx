// The controls for a watched all-AI game, where a seat's decision area would be: play and pause,
// one step, speed, hands face up, which seat sits at the bottom, and the end-of-game card.

import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { usePower } from "../auth";
import { api } from "../api";
import { ArtPanel } from "../components/ArtPanel";
import { ErrorText } from "../components/ui";
import { SPEEDS, seatName } from "./watch";
import type { SeatInfo, Speed, View, WatchStatus } from "./types";
import { count } from "@yama/core";

export type WatchMessage =
  | { type: "play" }
  | { type: "pause" }
  | { type: "step" }
  | { type: "speed"; speed: Speed }
  | { type: "reveal"; on: boolean }
  | { type: "stop" };

export function WatchControls({ id, status, view, seats, art, pov, onPov, send, compact = false }: {
  id: string;
  status: WatchStatus;
  view: View;
  seats: SeatInfo[];
  art: (seat: number) => { art: string | null; artist: string | null };
  pov: number;
  onPov: (seat: number) => void;
  send: (m: WatchMessage) => void;
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const power = usePower();
  const again = useMutation({
    mutationFn: () => api<{ id: string }>(`/api/watch/${id}/again`, { method: "POST" }),
    onSuccess: (r) => navigate(`/play/watch/${r.id}`),
  });
  const name = (n: number) => seatName(seats.find((s) => s.seat === n), n);

  if (status.finished) {
    const winner = view.winner;
    const a = winner !== null ? art(winner) : null;
    return (
      <div className={`watch-panel done${compact ? " compact" : ""}`}>
        {a?.art && !compact && (
          <ArtPanel className="watch-winner" art={a.art} artist={a.artist} wash="bottom">
            <span className="watch-winner-name">{name(winner!)}</span>
          </ArtPanel>
        )}
        <p className="watch-end">
          {status.stopped ?? (winner === null ? `A draw on turn ${view.turn}` : `${name(winner)} wins on turn ${view.turn}`)}
        </p>
        <p className="small dim">{count(status.actions)} moves by the computer.</p>
        <ErrorText error={again.error} />
        {power && (
          <div className="watch-end-buttons">
            <button type="button" className="primary" onClick={() => again.mutate()} disabled={again.isPending}>Watch again</button>
            <Link to="/play/watch" className="button outline">Set up another</Link>
          </div>
        )}
      </div>
    );
  }

  const paused = !status.playing;
  return (
    <div className={`watch-panel${compact ? " compact" : ""}`}>
      {status.idle && <p className="watch-note" role="status">Paused while nobody was watching. It carries on now you're back.</p>}
      <div className="watch-main">
        <button
          type="button"
          className="primary watch-play"
          aria-keyshortcuts="Space"
          onClick={() => send(paused ? { type: "play" } : { type: "pause" })}
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
          <span>{paused ? "Play" : "Pause"}</span>
        </button>
        <button type="button" className="outline watch-step" onClick={() => send({ type: "step" })} disabled={!paused} aria-keyshortcuts="ArrowRight" title="Play until something changes, then pause">
          Next move
        </button>
      </div>
      <div className="segmented watch-speed" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button key={s.speed} type="button" aria-pressed={status.speed === s.speed && !paused} aria-label={s.long} onClick={() => send({ type: "speed", speed: s.speed })}>
            {s.label}
          </button>
        ))}
      </div>
      <label className="pb-check watch-reveal">
        <input type="checkbox" checked={status.reveal} onChange={(e) => send({ type: "reveal", on: e.target.checked })} />
        Show every hand
      </label>
      <div className="watch-pov" role="group" aria-label="Watch from">
        <span className="watch-pov-label">Watch from</span>
        <span className="watch-pov-seats">
          {view.players.map((p) => {
            const a = art(p.seat);
            return (
              <button key={p.seat} type="button" className="watch-seat" aria-pressed={pov === p.seat} onClick={() => onPov(p.seat)} title={name(p.seat)}>
                {a.art ? <img src={a.art} alt="" /> : <span className="watch-seat-n">{p.seat + 1}</span>}
                <span className="watch-seat-name">{name(p.seat)}</span>
              </button>
            );
          })}
        </span>
      </div>
      {!compact && (
        <button type="button" className="quiet watch-stop" onClick={() => confirm("Stop this game? You can still look at the board.") && send({ type: "stop" })}>
          Stop the game
        </button>
      )}
    </div>
  );
}

const PlayIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M7 4.5v15l13-7.5z" />
  </svg>
);
const PauseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z" />
  </svg>
);
