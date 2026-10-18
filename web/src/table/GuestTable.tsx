// Shared table, guest side: follow the host's game and keep your own seat on your own phone.

import { panelFills, replay, type LoggedEvent, type TableEvent, type TableSetup } from "@yama/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Pips, Sheet } from "../components/ui";
import { wsUrl } from "./share";
import { DispatchContext, Panel, PlayerSheet, pendingDelta } from "./TablePlay";
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
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let timer: number | null = null;
    const open = () => {
      const ws = new WebSocket(wsUrl(gameId, "guest"));
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
  }, [gameId]);

  const state = useMemo(() => (snapshot ? replay(snapshot.setup, snapshot.log) : null), [snapshot]);
  const send = (event: TableEvent) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "event", event }));
  };
  const chooseSeat = (s: number) => {
    localStorage.setItem(`yama.guest.${gameId}`, String(s));
    setSeat(s);
  };

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
  return (
    <DispatchContext.Provider value={send}>
      <div className="guest">
        <div className="guest-others">
          {others.map((p) => (
            <div key={p.seat} className={`guest-other${p.eliminated ? " out" : ""}${state.activeSeat === p.seat ? " active" : ""}`}>
              <span className="small">{p.name}</span>
              <b className="num">{p.eliminated ? "out" : p.life}</b>
            </div>
          ))}
        </div>
        <div className="table guest-table" style={{ position: "relative", inset: "auto" }}>
          <Panel
            p={me}
            rot={0}
            area="1 / 1"
            active={state.activeSeat === me.seat}
            state={state}
            pending={pendingDelta(snapshot!.log, me.seat)}
            fill={fills[state.players.indexOf(me)]!}
            onOpen={() => setSheet(true)}
          />
        </div>
        {(hostOnline === false || !connected) && (
          <p className="guest-status small" role="status">
            {connected ? "The host's phone is offline. Changes will wait until it's back." : "Reconnecting…"}
          </p>
        )}
        {sheet && (
          <Sheet label="Your seat" onClose={() => setSheet(false)}>
            <PlayerSheet state={state} seat={me.seat} onClose={() => setSheet(false)} />
          </Sheet>
        )}
      </div>
    </DispatchContext.Provider>
  );
}
