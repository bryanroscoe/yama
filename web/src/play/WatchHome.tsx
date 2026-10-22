// Watch AIs play: seat 2 to 4 decks (yours or precons), give each an AI, choose who goes first,
// and watch the computer play every seat (server/src/watch.rs). Built from the Play online
// artboards' new-game seats; there's no artboard of its own.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type DeckSummary } from "../api";
import { ArtMosaic } from "../components/ArtMosaic";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { ErrorText } from "../components/ui";
import type { PreconItem, PreconList } from "../lab/api";
import { ago } from "./PlayHome";
import { shortName } from "./text";
import { LEVELS, SPEEDS, statusLine, tableNames, watchRequest, type Level, type WatchSeatPlan, type WatchSummary } from "./watch";
import type { Speed } from "./types";
import "./play.css";

const BackArrow = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
);

export function WatchHome() {
  const games = useQuery({ queryKey: ["watch"], queryFn: () => api<WatchSummary[]>("/api/watch"), refetchInterval: 5000 });
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const precons = useQuery({ queryKey: ["precons"], queryFn: () => api<PreconList>("/api/precons") });
  const status = useQuery({ queryKey: ["play-status"], queryFn: () => api<{ enabled: boolean; reason: string | null }>("/api/play/status") });
  const listArt = (games.data ?? []).flatMap((g) => g.seats.filter((s) => s.commander_art));
  return (
    <main className="page play-home watch-home">
      <Link to="/play" className="lobby-back"><BackArrow />Play online</Link>
      <div className="ph-head">
        <h1>Watch AIs play</h1>
        <p className="dim">
          Seat 2 to 4 decks, yours or precons, and give each a computer player. They play it out while you watch, at your speed. These games don't count in anyone's stats.
        </p>
      </div>
      {status.data && !status.data.enabled && <p className="dim">The rules engine isn't running on this server: {status.data.reason}</p>}
      <div className="ph-cols">
        {status.data?.enabled && decks.data && precons.data && <WatchSetup decks={decks.data} precons={precons.data.precons} />}
        <div className="ph-side">
          <section className="ph-games" aria-labelledby="wh-games-h">
            <h2 id="wh-games-h">Your watched games</h2>
            <ErrorText error={games.error} />
            {games.data && games.data.length === 0 && <p className="dim">None yet. A finished game stays here for half an hour after you last look at it.</p>}
            <ul className="ph-game-list">
              {(games.data ?? []).map((g) => {
                const left = Object.values(g.missing_cards).reduce((n, c) => n + c.length, 0);
                return (
                  <li key={g.id}>
                    <Link to={`/play/watch/${g.id}`} className="ph-game">
                      <ArtMosaic className="ph-game-art" arts={g.seats.map((s) => s.commander_art)} />
                      <span className="ph-game-text">
                        <span className={`ph-game-status${g.status.finished ? " dim" : ""}`}>{statusLine(g)}</span>
                        <span className="ph-game-who">
                          {tableNames(g.seats)}
                          {left > 0 && `, ${left} ${left === 1 ? "card" : "cards"} the engine can't play left out`}
                          <span className="ph-game-who-when">, {ago(g.created_at)}</span>
                        </span>
                      </span>
                      <span className="ph-game-when">{ago(g.created_at)}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {listArt.length > 0 && <p className="ph-credit">{artCredits(listArt.map((s) => s.commander_artist))}</p>}
          </section>
        </div>
      </div>
    </main>
  );
}

function WatchSetup({ decks, precons }: { decks: DeckSummary[]; precons: PreconItem[] }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Repeats of an earlier list are left out; sorted by name with the set for twins of a name.
  const choices = precons.filter((p) => !p.same_list_as).sort((a, b) => a.name.localeCompare(b.name));
  const pick = (i: number) => choices.length ? choices[(i * 37 + 11) % choices.length]!.id : "";
  const [seats, setSeats] = useState<WatchSeatPlan[]>(() =>
    [0, 1, 2, 3].map((i) => ({
      source: i === 0 && decks.length ? "deck" : "precon",
      deckId: decks[i % Math.max(1, decks.length)]?.id ?? "",
      preconId: pick(i),
      level: "Medium" as Level,
    })),
  );
  const [first, setFirst] = useState<number | null>(null);
  const [reveal, setReveal] = useState(false);
  const [speed, setSpeed] = useState<Speed>("1x");
  const [editing, setEditing] = useState<number | null>(null);
  const update = (i: number, patch: Partial<WatchSeatPlan>) => setSeats((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const shuffle = () =>
    setSeats((all) => all.map((s) => (s.source === "precon" && choices.length ? { ...s, preconId: choices[Math.floor(Math.random() * choices.length)]!.id } : s)));
  const create = useMutation({
    mutationFn: () => api<{ id: string }>("/api/watch", { method: "POST", json: watchRequest(seats, first, reveal, speed) }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["watch"] });
      navigate(`/play/watch/${r.id}`);
    },
  });

  if (!decks.length && !choices.length) {
    return (
      <section className="ph-new">
        <h2>New game</h2>
        <p className="dim">Add a deck first (Decks tab). The precon catalog isn't on this server yet.</p>
      </section>
    );
  }
  // Each seat's deck, titled by its first commander ("Éowyn"), as the board names seats.
  const shown = seats.map((s) => {
    if (s.source === "deck") {
      const d = decks.find((x) => x.id === s.deckId);
      return d ? { name: d.name, title: shortName(d.commanders[0] ?? d.name), art: d.commander_image, artist: d.commander_artist } : undefined;
    }
    const p = choices.find((x) => x.id === s.preconId);
    return p ? { name: p.name, title: shortName(p.commanders[0] ?? p.name), art: p.art?.url ?? null, artist: p.art?.artist ?? null } : undefined;
  });
  const seatTitle = (i: number) => shown[i]?.title ?? `Seat ${i + 1}`;
  return (
    <section className="ph-new" aria-labelledby="wh-new-h">
      <div className="ph-new-head">
        <h2 id="wh-new-h">New game</h2>
        {choices.length > 0 && seats.some((s) => s.source === "precon") && (
          <button type="button" className="quiet" onClick={shuffle}>Random precons</button>
        )}
      </div>
      <ol className="ph-seats">
        {seats.map((s, i) => {
          const deck = shown[i];
          return (
            <li key={i} className={`ph-seat${editing === i ? " editing" : ""}`}>
              <ArtPanel className="ph-seat-head" art={deck?.art} artist={deck?.artist} wash="bottom" empty={!deck} credit={false}>
                <span className="ph-seat-who">{deck ? seatTitle(i) : "No deck"}</span>
                <span className="ph-seat-n">Seat {i + 1}</span>
              </ArtPanel>
              <div className="ph-seat-row">
                <span className="ph-seat-thumb" aria-hidden="true">
                  {deck?.art ? <img src={deck.art} alt="" /> : i + 1}
                </span>
                <span className="ph-seat-sum">
                  <b>{deck?.name ?? "No deck"}</b>
                  <span>{s.source === "deck" ? "Your deck" : "Precon"}, {s.level.toLowerCase()} computer</span>
                </span>
                <button type="button" className="ph-change" aria-expanded={editing === i} aria-label={`Change seat ${i + 1}`} onClick={() => setEditing(editing === i ? null : i)}>
                  {editing === i ? "Done" : "Change"}
                </button>
              </div>
              <div className="ph-seat-fields">
                <div className="segmented ph-kind" role="group" aria-label={`Deck for seat ${i + 1}`}>
                  <button type="button" aria-pressed={s.source === "deck"} disabled={!decks.length} onClick={() => update(i, { source: "deck" })}>Your decks</button>
                  <button type="button" aria-pressed={s.source === "precon"} disabled={!choices.length} onClick={() => update(i, { source: "precon" })}>Precons</button>
                </div>
                {s.source === "deck" ? (
                  <label>
                    Deck
                    <select value={s.deckId} onChange={(e) => update(i, { deckId: e.target.value })}>
                      {decks.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </label>
                ) : (
                  <label>
                    Precon
                    <select value={s.preconId} onChange={(e) => update(i, { preconId: e.target.value })}>
                      {choices.map((p) => (
                        <option key={p.id} value={p.id}>{p.name} ({p.set_code}{p.released ? `, ${p.released.slice(0, 4)}` : ""})</option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="ph-skills" role="group" aria-label={`Computer for seat ${i + 1}`}>
                  {LEVELS.map((k) => (
                    <button key={k} type="button" aria-pressed={s.level === k} onClick={() => update(i, { level: k })}>{k}</button>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {shown.some((d) => d?.art) && <p className="ph-credit">{artCredits(shown.map((d) => (d?.art ? d.artist : null)))}</p>}

      <div className="wh-options">
        <label className="wh-first">
          Goes first
          <select value={first ?? ""} onChange={(e) => setFirst(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">Random, as at a table</option>
            {seats.map((_, i) => <option key={i} value={i}>Seat {i + 1}{shown[i] ? `: ${seatTitle(i)}` : ""}</option>)}
          </select>
        </label>
        <div className="wh-speed">
          <span className="wh-label" id="wh-speed-l">Speed</span>
          <div className="segmented" role="group" aria-labelledby="wh-speed-l">
            {SPEEDS.map((x) => (
              <button key={x.speed} type="button" aria-pressed={speed === x.speed} aria-label={x.long} onClick={() => setSpeed(x.speed)}>{x.label}</button>
            ))}
          </div>
        </div>
        <label className="pb-check wh-reveal">
          <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
          Start with every hand face up
        </label>
      </div>

      <ErrorText error={create.error} />
      <div className="ph-new-foot">
        <span className="ph-seat-buttons">
          {seats.length < 4 && (
            <button type="button" className="outline ph-add" onClick={() => setSeats((a) => [...a, { source: "precon", deckId: decks[0]?.id ?? "", preconId: pick(a.length), level: "Medium" }])}>
              Add a seat
            </button>
          )}
          {seats.length > 2 && (
            <button
              type="button"
              className="quiet ph-remove"
              onClick={() => {
                setSeats((a) => a.slice(0, -1));
                if (first !== null && first >= seats.length - 1) setFirst(null);
              }}
            >
              Remove the last seat
            </button>
          )}
        </span>
        <button type="button" className="primary ph-open" onClick={() => create.mutate()} disabled={create.isPending || shown.some((d) => !d)}>
          {create.isPending ? "Starting…" : "Start watching"}
        </button>
      </div>
    </section>
  );
}
