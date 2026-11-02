// Shared table, guest side: follow the host's game on your own phone. Two views: your seat big
// with everyone else along the top, or the whole table. Tap anyone to see or change their
// totals; the host's phone keeps the game and only it can end it.

import { panelFills, RELAY_TOKEN, replay, turnsCounted, type LoggedEvent, type TableEvent, type TableSetup } from "@yama/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArtPanel, artCredits } from "../components/ArtPanel";
import { Pips, Sheet } from "../components/ui";
import { guestWsUrl, joinFragment, joinLink } from "./share";
import { useLandscape } from "./layouts";
import { useScreenAwake } from "./wakeLock";
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
  // A new game (the table played again) starts fresh: its own key, seat and connection.
  return <GuestGame key={gameId} gameId={gameId} />;
}

function GuestGame({ gameId }: { gameId: string }) {
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
  const [view, setViewState] = useState<View>(() => (localStorage.getItem(VIEW) === "table" ? "table" : "mine"));
  const [sheetSeat, setSheetSeat] = useState<number | null>(null);
  const [knockSeat, setKnockSeat] = useState<number | null>(null);
  const [attack, setAttack] = useState<{ seat: number; partner: boolean } | null>(null);
  /** The player taking commander damage, Lifetap's way: tap the commander that hit them. */
  const [taking, setTaking] = useState<number | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const navigate = useNavigate();
  const landscape = useLandscape();
  // A guest phone sits on the table too: keep its screen on.
  useScreenAwake();
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
        const msg = JSON.parse(m.data);
        if (msg.type === "host") setHostOnline(msg.connected);
        else if (msg.type === "state" && msg.next?.gameId && msg.next?.key) {
          // The table is playing again: follow it to the next game, in the same seat.
          const next = msg.next as { gameId: string; key: string; relay?: string };
          const mine = localStorage.getItem(`yama.guest.${gameId}`);
          if (mine !== null) localStorage.setItem(`yama.guest.${next.gameId}`, mine);
          navigate(`/table/join/${next.gameId}${joinFragment(next.key, next.relay === "cf" ? "edge" : "server")}`, { replace: true });
        } else if (msg.type === "state") setSnapshot({ setup: msg.setup, log: msg.log });
      };
      ws.onclose = (e) => {
        setConnected(false);
        // The relay says why: joining by code is switched off (don't keep trying), or too many
        // tries from this network (wait a minute).
        if (e.code === 4403 || e.code === 4429) {
          setTurnedAway(e.reason || "The table's relay turned this phone away.");
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
  }, [gameId, key, relay]);

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
          {turnedAway
            ? turnedAway
            : noLink
            ? key
              ? relay === "edge"
                ? "Can't reach the table yet. If the host just started the game, or several phones on this Wi-Fi just joined, it connects in a few seconds; if not, ask them to show the code again."
                : "This table isn't being shared yet. If the host just started the game it connects in a moment; if not, ask them to show the code again."
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
  // Commander damage always shows the whole table: that's where it comes from and goes.
  const busy = !!attack || taking !== null;
  const shown: View = !me || busy ? "table" : view;
  const credited = (shown === "table" ? state.players : others).map((p) => artFor(p.seat)).filter((a) => !!a).map((a) => a!.artist);
  const grid = uprightLayout(state.players.length, landscape);
  const panel = (s: number, area: string, vertical = false) => {
    const p = state.players.find((x) => x.seat === s)!;
    return (
      <Panel
        key={s}
        p={p}
        rot={0}
        area={area}
        active={turnsCounted(state) && state.activeSeat === s}
        state={state}
        pending={pendingDelta(snapshot!.log, s)}
        fill={fillOf(s)}
        artFor={artFor}
        onOpen={() => setSheetSeat(s)}
        onKnockOut={() => setKnockSeat(s)}
        vertical={vertical}
        attack={attack}
        onAttack={(partner) => {
          setTaking(null);
          setAttack(attack?.seat === s && attack.partner === partner ? null : { seat: s, partner });
        }}
        taking={taking}
        onTake={() => {
          setAttack(null);
          setTaking(taking === s ? null : s);
        }}
      />
    );
  };

  return (
    <DispatchContext.Provider value={send}>
      <div className={`guest view-${shown}`}>
        <div className="guest-bar">
          {me ? (
            <div className="segmented" role="group" aria-label="View">
              <button type="button" aria-pressed={shown === "mine"} disabled={busy} onClick={() => setView("mine")}>My seat</button>
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
                const note = p.eliminated ? (p.eliminated.uncounted ? "Out" : `Out on turn ${p.eliminated.turn}`) : turnsCounted(state) && state.activeSeat === p.seat ? "Their turn" : p.poison > 0 ? `${p.poison} poison` : "";
                return (
                  <li key={p.seat}>
                    <button className="guest-tile-btn" onClick={() => setSheetSeat(p.seat)} aria-label={`${p.name}, ${p.eliminated ? "out" : `${p.life} life`}. Open`}>
                      <ArtPanel
                        as="span"
                        className={`guest-tile${p.eliminated ? " out" : ""}${turnsCounted(state) && state.activeSeat === p.seat ? " active" : ""}`}
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
            className={`table guest-table guest-grid${busy ? " attacking" : ""}`}
            style={{ position: "relative", inset: "auto", gridTemplateColumns: `repeat(${grid.cols}, 1fr)`, gridTemplateRows: `repeat(${grid.rows}, 1fr)` }}
          >
            {grid.cells.map(({ seat: s, area }) => panel(s, area))}
          </div>
        )}

        <div className="guest-status">
          {busy ? (
            <button className="primary" onClick={() => { setAttack(null); setTaking(null); }}>Done with commander damage</button>
          ) : (
            <p className="guest-status-line" role="status" style={{ margin: 0 }}>
              <span className={`status-dot ${live ? "good" : "warn"}`} aria-hidden="true" />
              {live
                ? `Following ${host && host.seat !== me?.seat ? `${host.name}'s` : "the host's"} phone. Tap anyone to change their totals.`
                : connected
                  ? "The host's phone is offline. Changes will wait until it's back."
                  : (turnedAway ?? "Reconnecting…")}
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
              onTake={() => {
                setTaking(sheetSeat);
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
        {lethal.ask && sheetSeat === null && knockSeat === null && !busy && (
          <Sheet label="Out of the game?" onClose={lethal.dismiss}>
            <LethalSheet state={state} seat={lethal.ask.seat} loss={lethal.ask.loss} onDone={lethal.dismiss} />
          </Sheet>
        )}
      </div>
    </DispatchContext.Provider>
  );
}
