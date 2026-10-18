// Shared table, host side: this phone stays the source of truth and streams its state to
// everyone who scanned the code. Their taps come back as events and go through our dispatch.

import type { TableEvent } from "@yama/core";
import QRCode from "qrcode";
import { useEffect, useState, useSyncExternalStore } from "react";
import { API_BASE } from "../api";
import { dispatch, getGame, subscribeTable } from "./store";

export function wsUrl(gameId: string, role: "host" | "guest") {
  const base = new URL(API_BASE || location.origin);
  const proto = base.protocol === "https:" ? "wss" : "ws";
  // Browsers can't set headers on WebSockets, so native apps pass their token in the URL.
  const token = API_BASE ? localStorage.getItem("yama.token") : null;
  return `${proto}://${base.host}/api/table/${gameId}/ws?role=${role}${token ? `&token=${token}` : ""}`;
}

/** Links people open on their own phones always point at the web app. */
export function publicOrigin() {
  return (import.meta.env.VITE_PUBLIC_URL as string | undefined) ?? (API_BASE || location.origin);
}

type Status = { gameId: string | null; connected: boolean };
let status: Status = { gameId: null, connected: false };
const listeners = new Set<() => void>();
const setStatus = (s: Partial<Status>) => {
  status = { ...status, ...s };
  for (const l of listeners) l();
};

let socket: WebSocket | null = null;
let unsubscribe: (() => void) | null = null;
let retry: number | null = null;

function sendSnapshot() {
  const g = getGame();
  if (!socket || socket.readyState !== WebSocket.OPEN || !g || g.setup.id !== status.gameId) return;
  socket.send(JSON.stringify({ type: "state", setup: g.setup, log: g.log }));
}

function open(gameId: string, attempt = 0) {
  const ws = new WebSocket(wsUrl(gameId, "host"));
  socket = ws;
  ws.onopen = () => {
    setStatus({ connected: true });
    sendSnapshot();
  };
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data) as { type: string; event?: TableEvent };
      if (msg.type === "event" && msg.event) dispatch(msg.event);
    } catch {
      /* ignore malformed */
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    setStatus({ connected: false });
    // Keep trying while we're still sharing this game; the table works offline meanwhile.
    if (status.gameId === gameId) {
      retry = window.setTimeout(() => open(gameId, attempt + 1), Math.min(15_000, 1000 * 2 ** attempt));
    }
  };
}

export function startHosting(gameId: string) {
  if (status.gameId === gameId) return;
  stopHosting();
  setStatus({ gameId, connected: false });
  unsubscribe = subscribeTable(() => {
    const g = getGame();
    if (!g || g.setup.id !== gameId) stopHosting(); // game finished or discarded
    else sendSnapshot();
  });
  open(gameId);
}

export function stopHosting() {
  if (retry) window.clearTimeout(retry);
  retry = null;
  unsubscribe?.();
  unsubscribe = null;
  const s = socket;
  socket = null;
  s?.close();
  setStatus({ gameId: null, connected: false });
}

export function useHosting() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

/** Shown inside the table menu: the code to scan, and the link for anyone who'd rather tap. */
export function ShareSheet({ gameId }: { gameId: string; onClose: () => void }) {
  const hosting = useHosting();
  const [svg, setSvg] = useState("");
  const url = `${publicOrigin()}/table/join/${gameId}`;
  useEffect(() => {
    startHosting(gameId);
    QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#13201C", light: "#ECE5D3" } }).then(setSvg);
  }, [gameId, url]);
  return (
    <div className="stack">
      <h3>Share with the table</h3>
      <p className="dim small">
        Everyone scans this with their phone camera, picks their seat, and keeps their own life total. This phone keeps the
        game, so it works even if the signal drops.
      </p>
      <div className="qr" dangerouslySetInnerHTML={{ __html: svg }} aria-label="Join code" role="img" />
      <div className="row">
        {"share" in navigator && (
          <button onClick={() => void navigator.share({ title: "Join our game on Yama", url })}>Send the link</button>
        )}
        <button className="quiet" onClick={stopHosting}>Stop sharing</button>
      </div>
      <p className="small faint">{hosting.connected ? "Live: phones that join will follow along." : "Connecting to Yama…"}</p>
    </div>
  );
}
