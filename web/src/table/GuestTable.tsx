// Shared table, guest side: follow the host's game on your own phone. Two views: your seat big
// with everyone else along the top, or the whole table. Tap anyone to see or change their
// totals; the host's phone keeps the game and only it can end it.

import { panelFills, replay, type LoggedEvent, type TableEvent, type TableSetup } from "@yama/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { Pips, Sheet } from "../components/ui";
import { wsUrl } from "./share";
import { DispatchContext, KnockOut, LethalSheet, Panel, PlayerSheet, pendingDelta, uprightLayout, useLethalPrompt, useTableArt } from "./TablePlay";
import "./table.css";

interface Snapshot {
  setup: TableSetup;
  log: LoggedEvent[];
}

type View = "mine" | "table";
const VIEW = "yama.guest.view";
/** A seat number, or "watch" for following without one. */
const WATCH = -1;

export function GuestTable() {
  const { gameId = "" } = useParams();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [hostOnline, setHostOnline] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  /** Connection attempts that closed without ever opening: the link was refused. */
  const [refused, setRefused] = useState(0);
  const [seat, setSeat] = useState<number | null>(() => {
    const saved = localStorage.getItem(`yama.guest.${gameId}`);
    return saved === null ? null : Number(saved);
  });
  const [view, setViewState] = useState<View>(() => (localStorage.getItem(VIEW) === "table" ? "table" : "mine"));
  const [sheetSeat, setSheetSeat] = useState<number | null>(null);
  const [knockSeat, setKnockSeat] = useState<number | null>(null);
  const [attack, setAttack] = useState<{ seat: number; partner: boolean } | null>(null);
  const socket = useRef<WebSocket | null>(null);
  // The share key comes in the link's #fragment; keep it so a reload can reconnect. The game's
  // own creator (following from another device) needs none.
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
      let opened = false;
      socket.current = ws;
      ws.onopen = () => {
        opened = true;
        attempt = 0;
        setRefused(0);
        setConnected(true);
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.type === "host") setHostOnline(msg.connected);
        else if (msg.type === "state") setSnapshot({ setup: msg.setup, log: msg.log });
      };
      ws.onclose = () => {
        setConnected(false);
        if (!opened) setRefused((r) => r + 1);
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
  const me = seat === null || seat === WATCH ? undefined : state?.players.find((p) => p.seat === seat);
  const lethal = useLethalPrompt(me ? state : null, me?.seat ?? null);
  const send = (event: TableEvent) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "event", event }));
  };
  const chooseSeat = (s: number) => {
    localStorage.setItem(`yama.guest.${gameId}`, String(s));
    setSeat(s);
    if (s === WATCH) setView("table");
  };
  const setView = (v: View) => {
    localStorage.setItem(VIEW, v);
    setViewState(v);
  };

  if (!state) {
    const noLink = refused >= 2 && !connected;
    return (
      <main className="page">
        <h1>Joining the table</h1>
        <p className="dim">
          {noLink
            ? key
              ? "This table isn't being shared right now. Ask the host to show the code again, then scan it."
              : "This link is missing its code. Scan the QR code on the host's phone again."
            : !connected
              ? "Connecting to Yama…"
              : hostOnline === false
                ? "Waiting for the host's phone to come back online."
                : "Waiting for the game…"}
        </p>
        <p><Link to="/">Back to Yama</Link></p>
      </main>
    );
  }

  if (seat === null || (seat !== WATCH && !me)) {
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
          <button className="list-row" onClick={() => chooseSeat(WATCH)}>
            <span />
            <span>
              <span className="title">Just following</span>
              <span className="dim"> see the whole table</span>
            </span>
            <span />
          </button>
        </div>
      </main>
    );
  }

  const fills = panelFills(state.players.map((p) => p.colorIdentity));
  const fillOf = (s: number) => fills[state.players.findIndex((p) => p.seat === s)]!;
  const others = state.players.filter((p) => p.seat !== me?.seat);
  const host = state.players[0];
  const live = connected && hostOnline !== false;
  // A commander attack always shows the whole table: that's where the damage goes.
  const shown: View = !me || attack ? "table" : view;
  const credited = (shown === "table" ? state.players : others).map((p) => artFor(p.seat)).filter((a) => !!a).map((a) => a!.artist);
  const grid = uprightLayout(state.players.length);
  const panel = (s: number, area: string, vertical = false) => {
    const p = state.players.find((x) => x.seat === s)!;
    return (
      <Panel
        key={s}
        p={p}
        rot={0}
        area={area}
        active={state.activeSeat === s}
        state={state}
        pending={pendingDelta(snapshot!.log, s)}
        fill={fillOf(s)}
        artFor={artFor}
        onOpen={() => setSheetSeat(s)}
        onKnockOut={() => setKnockSeat(s)}
        vertical={vertical}
        attack={attack}
        onAttack={(partner) => setAttack(attack?.seat === s && attack.partner === partner ? null : { seat: s, partner })}
      />
    );
  };

  return (
    <DispatchContext.Provider value={send}>
      <div className={`guest view-${shown}`}>
        <div className="guest-bar">
          {me ? (
            <div className="segmented" role="group" aria-label="View">
              <button type="button" aria-pressed={shown === "mine"} disabled={!!attack} onClick={() => setView("mine")}>My seat</button>
              <button type="button" aria-pressed={shown === "table"} onClick={() => setView("table")}>Whole table</button>
            </div>
          ) : (
            <span className="guest-bar-title">Following the table</span>
          )}
          <button className="quiet small" onClick={() => { localStorage.removeItem(`yama.guest.${gameId}`); setSeat(null); }}>
            {me ? "Change seat" : "Pick a seat"}
          </button>
        </div>

        {shown === "mine" && me ? (
          <>
            <ul className="guest-others" aria-label="Everyone else. Tap a player to see or change their totals">
              {others.map((p) => {
                const a = artFor(p.seat);
                const note = p.eliminated ? `Out on turn ${p.eliminated.turn}` : state.activeSeat === p.seat ? "Their turn" : p.poison > 0 ? `${p.poison} poison` : "";
                return (
                  <li key={p.seat}>
                    <button className="guest-tile-btn" onClick={() => setSheetSeat(p.seat)} aria-label={`${p.name}, ${p.eliminated ? "out" : `${p.life} life`}. Open`}>
                      <ArtPanel
                        as="span"
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
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="table guest-table" style={{ position: "relative", inset: "auto" }}>
              {panel(me.seat, "1 / 1", true)}
            </div>
          </>
        ) : (
          <div
            className={`table guest-table guest-grid${attack ? " attacking" : ""}`}
            style={{ position: "relative", inset: "auto", gridTemplateColumns: `repeat(${grid.cols}, 1fr)`, gridTemplateRows: `repeat(${grid.rows}, 1fr)` }}
          >
            {grid.cells.map(({ seat: s, area }) => panel(s, area))}
          </div>
        )}

        <div className="guest-status">
          {attack ? (
            <button className="primary" onClick={() => setAttack(null)}>Done dealing damage</button>
          ) : (
            <p className="guest-status-line" role="status" style={{ margin: 0 }}>
              <span className={`status-dot ${live ? "good" : "warn"}`} aria-hidden="true" />
              {live
                ? `Following ${host && host.seat !== me?.seat ? `${host.name}'s` : "the host's"} phone. Tap anyone to change their totals.`
                : connected
                  ? "The host's phone is offline. Changes will wait until it's back."
                  : "Reconnecting…"}
            </p>
          )}
          {credited.length > 0 && <span className="guest-credit">{artCredits(credited)}</span>}
        </div>
        {sheetSeat !== null && (
          <Sheet label={sheetSeat === me?.seat ? "Your seat" : "Player"} onClose={() => setSheetSeat(null)}>
            <PlayerSheet
              state={state}
              seat={sheetSeat}
              onClose={() => setSheetSeat(null)}
              artFor={artFor}
              onAttack={(partner) => {
                setAttack({ seat: sheetSeat, partner });
                setSheetSeat(null);
              }}
            />
          </Sheet>
        )}
        {knockSeat !== null && (
          <Sheet label="Knock out" onClose={() => setKnockSeat(null)}>
            <KnockOut state={state} seat={knockSeat} onDone={() => setKnockSeat(null)} />
          </Sheet>
        )}
        {lethal.ask && sheetSeat === null && knockSeat === null && !attack && (
          <Sheet label="Out of the game?" onClose={lethal.dismiss}>
            <LethalSheet state={state} seat={lethal.ask.seat} loss={lethal.ask.loss} onDone={lethal.dismiss} />
          </Sheet>
        )}
      </div>
    </DispatchContext.Provider>
  );
}
