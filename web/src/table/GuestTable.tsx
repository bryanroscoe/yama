// Shared table, guest side: follow the host's game on your own phone. Two views: your seat big
// with everyone else along the top, or the whole table. Tap anyone to see or change their
// totals; the host's device keeps the game and only it can end it.

import { RELAY_TOKEN, replay, type LoggedEvent, type TableEvent, type TableSetup } from "@yama/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Pips } from "../components/ui";
import { guestWsUrl, joinFragment, joinLink } from "./share";
import type { LayoutKey } from "./layouts";
import { useMe } from "../auth";
import { forgetTable, rememberTable } from "./following";
import { useScreenAwake } from "./wakeLock";
import { DispatchContext, TableScreen } from "./TablePlay";
import "./table.css";

interface Snapshot {
  setup: TableSetup;
  log: LoggedEvent[];
  layout?: LayoutKey;
  countTurns?: boolean;
  showArt?: boolean;
}

/** A seat number, or "watch" for following without one. */
const WATCH = -1;

export function GuestTable() {
  const { gameId = "" } = useParams();
  // A new game (the table played again) starts fresh: its own key, seat and connection.
  return <GuestGame key={gameId} gameId={gameId} />;
}

function GuestGame({ gameId }: { gameId: string }) {
  const user = useMe().data?.id ?? null;
  const [ended, setEnded] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [hostOnline, setHostOnline] = useState<boolean | null>(null);
  const [connected, setConnected] = useState(false);
  /** Connection attempts that closed without ever opening: the link was refused. */
  const [refused, setRefused] = useState(0);
  /** Why the relay turned this phone away (it closed with a reason), if it did. */
  const [turnedAway, setTurnedAway] = useState<string | null>(null);
  const [seat, setSeat] = useState<number | null>(() => {
    const saved = localStorage.getItem(`yama.guest.${gameId}`);
    return saved === null ? null : Number(saved);
  });
  const socket = useRef<WebSocket | null>(null);
  const navigate = useNavigate();

  // A guest phone sits on the table too: keep its screen on once the game has loaded (and through
  // a dropped connection after that), but not on a join that never got in.
  useScreenAwake(snapshot !== null);
  // The share key and relay come in the link's #fragment; kept so a reload can reconnect. The
  // game's own creator (following from another device) needs no key on the server's relay.
  const [{ key, relay }] = useState(() => joinLink(gameId));

  useEffect(() => {
    // The Cloudflare relay refuses a link without a whole key every time: don't keep asking.
    if (relay === "edge" && !RELAY_TOKEN.test(key)) {
      setRefused(2);
      return;
    }
    let closed = false;
    let attempt = 0;
    let timer: number | null = null;
    const open = () => {
      const ws = new WebSocket(guestWsUrl(gameId, key, relay));
      let opened = false;
      socket.current = ws;
      ws.onopen = () => {
        opened = true;
        attempt = 0;
        setRefused(0);
        setConnected(true);
        // Let in: any earlier refusal is over (a refusal opens and closes at once, so its reason
        // is set again by the close that follows).
        setTurnedAway(null);
      };
      ws.onmessage = (m) => {
        if (closed || socket.current !== ws) return;
        let msg;
        try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.type === "host") setHostOnline(msg.connected);
        else if (msg.type === "state" && msg.next?.gameId && msg.next?.key) {
          // The table is playing again: follow it to the next game, in the same seat.
          const next = msg.next as { gameId: string; key: string; relay?: string };
          const mine = localStorage.getItem(`yama.guest.${gameId}`);
          if (mine !== null) localStorage.setItem(`yama.guest.${next.gameId}`, mine);
          navigate(`/table/join/${next.gameId}${joinFragment(next.key, next.relay === "cf" ? "edge" : "server")}`, { replace: true });
        } else if (msg.type === "state" && msg.ended) {
          setEnded(true);
          forgetTable(user, gameId);
        } else if (msg.type === "state" && msg.setup?.id === gameId && Array.isArray(msg.log)) {
          setSnapshot({ setup: msg.setup, log: msg.log, layout: msg.layout, countTurns: msg.countTurns, showArt: msg.showArt });
          if (msg.log.some((l: LoggedEvent) => l.event.type === "finish")) {
            setEnded(true);
            forgetTable(user, gameId);
          } else {
            rememberTable(user, { gameId, key, relay, names: msg.setup.players.map((p: { name: string }) => p.name).join(", ") });
          }
        }
      };
      ws.onclose = (e) => {
        if (closed || socket.current !== ws) return;
        setConnected(false);
        // The relay says why: joining by code is switched off (don't keep trying), or too many
        // tries from this network (wait a minute).
        if (e.code === 4403 || e.code === 4429) {
          setTurnedAway(e.reason || "The table's relay turned this device away.");
          if (e.code === 4403) return;
          if (!closed) timer = window.setTimeout(open, 60_000);
          return;
        }
        if (opened) setTurnedAway(null);
        if (!opened) setRefused((r) => r + 1);
        // Spread out (2 s up, with jitter): a table's phones share one Wi-Fi address, and the
        // relay's rule in front allows only a few connections from it every 10 s, the host's too.
        if (!closed) timer = window.setTimeout(open, Math.min(15_000, 2000 * 2 ** attempt++) * (0.75 + Math.random() / 2));
      };
    };
    open();
    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket.current?.close();
    };
  }, [gameId, key, relay, user]);

  const state = useMemo(() => (snapshot ? replay(snapshot.setup, snapshot.log) : null), [snapshot]);
  const me = seat === null || seat === WATCH ? undefined : state?.players.find((p) => p.seat === seat);
  const send = (event: TableEvent) => {
    if (!ended && hostOnline === true && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "event", event }));
  };
  const chooseSeat = (s: number) => {
    localStorage.setItem(`yama.guest.${gameId}`, String(s));
    setSeat(s);
  };


  if (ended) return (
    <main className="page">
      <h1>This table has ended</h1>
      <p className="dim">The host finished or discarded this game. Open Table to find the next one.</p>
      <Link className="button primary" to="/">Back to Table</Link>
    </main>
  );

  if (!state) {
    const noLink = refused >= 2 && !connected;
    return (
      <main className="page">
        <h1>Joining the table</h1>
        <p className="dim">
          {turnedAway
            ? turnedAway
            : noLink
            ? key
              ? relay === "edge"
                ? "Can't reach the table yet. If the host just started the game, or several devices on this Wi-Fi just joined, it connects in a few seconds; if not, ask them to show the code again."
                : "This table isn't being shared yet. If the host just started the game it connects in a moment; if not, ask them to show the code again."
              : "This link is missing its code. Scan the QR code on the host's device again."
            : !connected
              ? "Connecting to Yama…"
              : hostOnline === false
                ? "Waiting for the host's device to come back online."
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

  const live = connected && hostOnline === true;
  const status = live ? "Following the host’s device. Changes go to the shared table." : connected ? "The host’s device is offline. Wait for it to reconnect before changing totals." : (turnedAway ?? "Reconnecting. Wait before changing totals.");
  return (
    <DispatchContext.Provider value={send}>
      <TableScreen game={snapshot!} state={state} following={{
        seat, onChooseSeat: chooseSeat,
        status, layout: snapshot?.layout, countTurns: snapshot?.countTurns, showArt: snapshot?.showArt,
      }} />
      {!live && <div className="following-status" role="status">{status}</div>}
    </DispatchContext.Provider>
  );
}
