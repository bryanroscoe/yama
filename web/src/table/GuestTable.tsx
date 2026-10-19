// Shared table, guest side: follow the host's game and keep your own seat on your own phone.

import { panelFills, replay, type LoggedEvent, type TableEvent, type TableSetup } from "@yama/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { Pips, Sheet } from "../components/ui";
import { wsUrl } from "./share";
import { DispatchContext, KnockOut, Panel, PlayerSheet, pendingDelta, useTableArt } from "./TablePlay";
import "./table.css";

interface Snapshot {
  setup: TableSetup;
  log: LoggedEvent[];
}

export function GuestTable() {
  const { gameId = "" } = useParams();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [hostOnline, setHostOnline] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  const [seat, setSeat] = useState<number | null>(() => {
    const saved = localStorage.getItem(`yama.guest.${gameId}`);
    return saved === null ? null : Number(saved);
  });
  const [sheet, setSheet] = useState(false);
  const [knocking, setKnocking] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  // The share key comes in the link's #fragment; keep it so a reload can reconnect.
  const [key] = useState(() => {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("k");
    if (fromLink) localStorage.setItem(`yama.guestkey.${gameId}`, fromLink);
    return fromLink ?? localStorage.getItem(`yama.guestkey.${gameId}`) ?? "";
  });

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: number | null = null;
    const open = () => {
      const ws = new WebSocket(wsUrl(gameId, "guest", key));
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.type === "host") setHostOnline(msg.connected);
        else if (msg.type === "state") setSnapshot({ setup: msg.setup, log: msg.log });
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = window.setTimeout(open, Math.min(15_000, 1000 * 2 ** attempt++));
      };
    };
    open();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket.current?.close();
    };
  }, [gameId, key]);

  const state = useMemo(() => (snapshot ? replay(snapshot.setup, snapshot.log) : null), [snapshot]);
  const artFor = useTableArt(state?.players ?? []);
  const send = (event: TableEvent) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "event", event }));
  };
  const chooseSeat = (s: number) => {
    localStorage.setItem(`yama.guest.${gameId}`, String(s));
    setSeat(s);
  };

  if (!key) {
    return (
      <main className="page">
        <h1>Joining the table</h1>
        <p className="dim">This link is missing its code. Scan the QR code on the host's phone again.</p>
      </main>
    );
  }
  if (!state) {
    return (
      <main className="page">
        <h1>Joining the table</h1>
        <p className="dim">
          {!connected ? "Connecting to Yama…" : hostOnline === false ? "Waiting for the host's phone to come back online." : "Waiting for the game…"}
        </p>
        <p><Link to="/">Back to Yama</Link></p>
      </main>
    );
  }

  const me = seat === null ? undefined : state.players.find((p) => p.seat === seat);
  if (!me) {
    return (
      <main className="page">
        <h1>Which seat is yours?</h1>
        <div className="list">
          {state.players.map((p) => (
            <button key={p.seat} className="list-row" onClick={() => chooseSeat(p.seat)}>
              <Pips identity={p.colorIdentity} />
              <span>
                <span className="title">{p.name}</span>
                {p.commanderName && <span className="dim"> playing {p.commanderName}</span>}
              </span>
              <span className="num">{p.life}</span>
            </button>
          ))}
        </div>
      </main>
    );
  }

  const fills = panelFills(state.players.map((p) => p.colorIdentity));
  const others = state.players.filter((p) => p.seat !== me.seat);
  const host = state.players[0];
  const otherArtists = others.map((p) => artFor(p.seat)).filter((a) => !!a).map((a) => a!.artist);
  const live = connected && hostOnline !== false;
  return (
    <DispatchContext.Provider value={send}>
      <div className="guest">
        <ul className="guest-others" aria-label="Everyone else">
          {others.map((p) => {
            const a = artFor(p.seat);
            const note = p.eliminated ? `Out on turn ${p.eliminated.turn}` : state.activeSeat === p.seat ? "Their turn" : p.poison > 0 ? `${p.poison} poison` : "";
            return (
              <ArtPanel
                key={p.seat}
                as="li"
                className={`guest-tile${p.eliminated ? " out" : ""}${state.activeSeat === p.seat ? " active" : ""}`}
                art={a?.art}
                artist={a?.artist}
                wash="bottom"
                credit={false}
              >
                <span className="guest-tile-who">
                  <span className="guest-tile-note">{note}</span>
                  <span className="guest-tile-name">{p.name}</span>
                </span>
                <b className="num">{p.eliminated ? "Out" : p.life}</b>
              </ArtPanel>
            );
          })}
        </ul>
        <div className="table guest-table" style={{ position: "relative", inset: "auto" }}>
          <Panel
            p={me}
            rot={0}
            area="1 / 1"
            active={state.activeSeat === me.seat}
            state={state}
            pending={pendingDelta(snapshot!.log, me.seat)}
            fill={fills[state.players.indexOf(me)]!}
            artFor={artFor}
            onOpen={() => setSheet(true)}
            onKnockOut={() => setKnocking(true)}
            vertical
          />
        </div>
        <div className="guest-status">
          <p className="guest-status-line" role="status" style={{ margin: 0 }}>
            <span className={`status-dot ${live ? "good" : "warn"}`} aria-hidden="true" />
            {live
              ? `Following ${host && host.seat !== me.seat ? `${host.name}'s` : "the host's"} phone. Your taps go to the table.`
              : connected
                ? "The host's phone is offline. Changes will wait until it's back."
                : "Reconnecting…"}
          </p>
          {otherArtists.length > 0 && <span className="guest-credit">{artCredits(otherArtists)}</span>}
        </div>
        {sheet && (
          <Sheet label="Your seat" onClose={() => setSheet(false)}>
            <PlayerSheet state={state} seat={me.seat} onClose={() => setSheet(false)} artFor={artFor} />
          </Sheet>
        )}
        {knocking && (
          <Sheet label="Knock out" onClose={() => setKnocking(false)}>
            <KnockOut state={state} seat={me.seat} onDone={() => setKnocking(false)} />
          </Sheet>
        )}
      </div>
    </DispatchContext.Provider>
  );
}
