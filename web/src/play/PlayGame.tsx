import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { identityKeys, MANA } from "@yama/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { api, API_BASE } from "../api";
import { useMe } from "../auth";
import { ErrorText, Pips, Sheet } from "../components/ui";
import type { CardView, OnlineGame, SeatInfo, ServerMessage, View } from "./types";
import "./play.css";

function playSocketUrl(id: string) {
  const base = new URL(API_BASE || location.origin);
  const proto = base.protocol === "https:" ? "wss" : "ws";
  const token = API_BASE ? localStorage.getItem("yama.token") : null;
  return `${proto}://${base.host}/api/play/${id}/ws${token ? `?token=${token}` : ""}`;
}

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

function Board({ id, live }: { id: string; live: boolean }) {
  const [msg, setMsg] = useState<Extract<ServerMessage, { type: "view" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const socket = useRef<WebSocket | null>(null);

  // Finished games: one fetch of the final board, no socket.
  useEffect(() => {
    if (live) return;
    api<Extract<ServerMessage, { type: "view" }>>(`/api/play/${id}/view`).then(setMsg, (e) => setError(String(e.message ?? e)));
  }, [id, live]);

  useEffect(() => {
    if (!live) return;
    let closed = false;
    let attempt = 0;
    let timer: number | null = null;
    const open = () => {
      const ws = new WebSocket(playSocketUrl(id));
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (m) => {
        const data = JSON.parse(m.data) as ServerMessage;
        if (data.type === "view") {
          setMsg(data);
          setError(null);
        } else setError(data.message);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = window.setTimeout(open, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };
    open();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket.current?.close();
    };
  }, [id, live]);

  const send = (data: unknown) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(data));

  if (!msg) return <main className="page"><p className="dim">{error ?? (!live ? "Loading the final board…" : connected ? "Loading the game…" : "Connecting…")}</p></main>;
  const { view, you, seats, images } = msg;
  const seatName = (n: number) => seats.find((s) => s.seat === n)?.name ?? `Seat ${n + 1}`;
  const identity = (n: number) => seats.find((s) => s.seat === n)?.color_identity ?? "";
  const others = view.players.filter((p) => p.seat !== you);
  const mine = view.players.find((p) => p.seat === you);
  // The server passes for you when passing is all you could do; don't flash that choice.
  const decision = view.decision && !(view.decision.options.length === 1 && view.decision.options[0]!.label.startsWith("Pass")) ? view.decision : null;
  const options = decision?.options.filter((o) => focus === null || o.object === focus) ?? [];

  return (
    <div className="play">
      <header className="play-top">
        <Link to="/play" className="small">Leave</Link>
        <span className="small dim">
          Turn {view.turn}, {seatName(view.active)}'s {view.phase.toLowerCase()}
        </span>
        <button className="quiet small" onClick={() => setLogOpen(true)}>Game log</button>
      </header>

      <div className="opponents">
        {others.map((p) => (
          <div key={p.seat} className={`opp${view.active === p.seat ? " active" : ""}${p.eliminated ? " out" : ""}`} style={{ borderTopColor: MANA[identityKeys(identity(p.seat))[0]!].fill }}>
            <span className="small">{seatName(p.seat)}</span>
            <b className="num">{p.eliminated ? "out" : p.life}</b>
            <span className="small dim num">
              {p.hand} in hand{p.poison ? `, ${p.poison} poison` : ""}
            </span>
          </div>
        ))}
      </div>

      <main className="field">
        {others.map((p) => (
          <Zone key={p.seat} title={seatName(p.seat)} cards={view.battlefield.filter((c) => c.controller === p.seat)} images={images} focus={focus} setFocus={setFocus} decisionObjects={decision} />
        ))}
        {view.stack.length > 0 && (
          <section className="stack-zone">
            <h3 className="small">On the stack</h3>
            <ol>
              {[...view.stack].reverse().map((s, i) => (
                <li key={i}>{s.name} <span className="dim small">({seatName(s.controller)})</span></li>
              ))}
            </ol>
          </section>
        )}
        {you !== null && (
          <Zone title="Your board" cards={view.battlefield.filter((c) => c.controller === you)} images={images} focus={focus} setFocus={setFocus} decisionObjects={decision} mine />
        )}
        {you !== null && (
          <Zone title="Command zone" cards={view.command_zone.filter((c) => c.owner === you)} images={images} focus={focus} setFocus={setFocus} decisionObjects={decision} />
        )}
      </main>

      {you !== null && (
        <footer className="me">
          <div className="me-line">
            <span>
              <b className="num me-life">{mine?.life}</b> <span className="dim small">life{mine?.poison ? `, ${mine.poison} poison` : ""}, {mine?.library} in library</span>
            </span>
            <span className="small dim">{connected ? "" : "Reconnecting…"}</span>
          </div>
          <div className="hand">
            {view.hand.map((c) => (
              <Tile key={c.id} card={c} image={images[c.name]} selected={focus === c.id} playable={!!decision?.options.some((o) => o.object === c.id)} onClick={() => setFocus(focus === c.id ? null : c.id)} />
            ))}
          </div>
          {view.over ? (
            <p className="decision-prompt">{view.winner === null ? "The game is a draw." : view.winner === you ? "You won." : `${seatName(view.winner)} won.`}</p>
          ) : decision ? (
            <div className="decision">
              <p className="decision-prompt">
                {decision.prompt}
                {focus !== null && <button className="quiet small" onClick={() => setFocus(null)}>Show every option</button>}
              </p>
              <div className="options">
                {options.map((o) => (
                  <button key={o.index} onClick={() => { send({ type: "choose", revision: decision.revision, index: o.index }); setFocus(null); }}>
                    {o.label}
                  </button>
                ))}
                {options.length === 0 && <span className="dim small">Nothing to do with that card right now.</span>}
              </div>
            </div>
          ) : (
            <p className="decision-prompt dim">Waiting for {view.waiting_on.map(seatName).join(" and ") || "the game"}…</p>
          )}
          {error && <p className="error small">{error}</p>}
        </footer>
      )}

      {logOpen && (
        <Sheet label="Game log" onClose={() => setLogOpen(false)}>
          <div className="stack">
            <div className="sheet-head">
              <h2>Game log</h2>
              <button className="quiet" onClick={() => setLogOpen(false)}>Close</button>
            </div>
            <ol className="log">
              {[...view.log].reverse().map((l, i) => (
                <li key={i}><span className="faint small num">T{l.turn}</span> {l.text}</li>
              ))}
            </ol>
            {you !== null && !view.over && (
              <button className="quiet error" onClick={() => confirm("Concede this game?") && send({ type: "concede" })}>Concede</button>
            )}
          </div>
        </Sheet>
      )}
    </div>
  );
}

function Zone({ title, cards, images, focus, setFocus, decisionObjects, mine }: {
  title: string;
  cards: CardView[];
  images: Record<string, string>;
  focus: number | null;
  setFocus: (id: number | null) => void;
  decisionObjects: View["decision"];
  mine?: boolean;
}) {
  const sorted = useMemo(
    () => [...cards].sort((a, b) => Number(a.types.includes("Land")) - Number(b.types.includes("Land")) || a.name.localeCompare(b.name)),
    [cards],
  );
  if (!cards.length && !mine) return null;
  return (
    <section className="zone">
      <h3 className="small dim">{title}</h3>
      <div className="tiles">
        {sorted.map((c) => (
          <Tile key={c.id} card={c} image={images[c.name]} selected={focus === c.id} playable={!!decisionObjects?.options.some((o) => o.object === c.id)} onClick={() => setFocus(focus === c.id ? null : c.id)} />
        ))}
        {!cards.length && <span className="faint small">Nothing yet.</span>}
      </div>
    </section>
  );
}

function Tile({ card, image, selected, playable, onClick }: { card: CardView; image?: string; selected: boolean; playable: boolean; onClick: () => void }) {
  const counters = Object.entries(card.counters);
  return (
    <button className={`tile${card.tapped ? " tapped" : ""}${selected ? " selected" : ""}${playable ? " playable" : ""}`} onClick={onClick} aria-label={`${card.name}${card.tapped ? ", tapped" : ""}`}>
      {image ? <img src={image} alt="" loading="lazy" /> : <span className="tile-name">{card.name}</span>}
      {(card.power !== null || card.loyalty !== null) && (
        <span className="tile-stat num">{card.loyalty !== null ? card.loyalty : `${card.power}/${card.toughness}`}</span>
      )}
      {counters.length > 0 && <span className="tile-counters small">{counters.map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}</span>}
    </button>
  );
}

export type { SeatInfo };
