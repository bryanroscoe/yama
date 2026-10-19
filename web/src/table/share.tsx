// Shared table, host side: this phone stays the source of truth and streams its state to
// everyone who scanned the code. Their taps come back as events and go through our dispatch.

import type { TableEvent } from "@yama/core";
import QRCode from "qrcode";
import { useEffect, useState, useSyncExternalStore } from "react";
import { API_BASE } from "../api";
import { dispatch, getGame, subscribeTable } from "./store";

export function wsUrl(gameId: string, role: "host" | "guest", key: string) {
  const base = new URL(API_BASE || location.origin);
  const proto = base.protocol === "https:" ? "wss" : "ws";
  // Browsers can't set headers on WebSockets, so native apps pass their token in the URL.
  const token = API_BASE ? localStorage.getItem("yama.token") : null;
  return `${proto}://${base.host}/api/table/${gameId}/ws?role=${role}&key=${encodeURIComponent(key)}${token ? `&token=${token}` : ""}`;
}

/** The share key for a game this phone hosts. It rides in the QR link's #fragment. */
export function shareKey(gameId: string): string {
  const k = `yama.share.${gameId}`;
  let key = localStorage.getItem(k);
  if (!key) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    key = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(k, key);
  }
  return key;
}

/** Guests may adjust the table, but only the host's phone ends the game. */
const GUEST_EVENTS = new Set<TableEvent["type"]>([
  "life", "poison", "commander_damage", "counter", "commander_cast", "monarch", "initiative", "day_night", "pass_turn", "eliminate", "revive",
]);

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
  const ws = new WebSocket(wsUrl(gameId, "host", shareKey(gameId)));
  socket = ws;
  ws.onopen = () => {
    setStatus({ connected: true });
    sendSnapshot();
  };
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data) as { type: string; event?: TableEvent };
      if (msg.type === "event" && msg.event && GUEST_EVENTS.has(msg.event.type)) dispatch(msg.event);
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

/**
 * "Everyone's phone", in the table menu: the code to scan, and the link for anyone who'd rather
 * tap. Sharing starts when someone asks for the code, not whenever the menu opens.
 */
export function ShareCard({ gameId }: { gameId: string }) {
  const hosting = useHosting();
  const sharing = hosting.gameId === gameId;
  const [svg, setSvg] = useState("");
  const url = `${publicOrigin()}/table/join/${gameId}#k=${shareKey(gameId)}`;
  useEffect(() => {
    if (!sharing) return;
    QRCode.toString(url, { type: "svg", margin: 1, color: { dark: "#0b0c0e", light: "#f2efe8" } }).then(setSvg);
  }, [sharing, url]);
  return (
    <section className="tm-share" aria-labelledby="tm-share-title">
      {sharing && svg ? (
        <div className="tm-qr" dangerouslySetInnerHTML={{ __html: svg }} aria-label="Join code" role="img" />
      ) : (
        <button className="tm-qr tm-qr-off" onClick={() => startHosting(gameId)} aria-label="Show the join code">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
          </svg>
        </button>
      )}
      <div className="tm-share-text">
        <h3 id="tm-share-title">Everyone's phone</h3>
        <p>Friends scan this, pick their seat and keep their own total.{sharing ? " This phone keeps the game, so it works even if the signal drops." : ""}</p>
        {sharing ? (
          <>
            <p role="status" className="tm-status">
              <span className={`status-dot ${hosting.connected ? "good" : "warn"}`} aria-hidden="true" />
              {hosting.connected ? "Live: phones that join follow along" : "Connecting to Yama…"}
            </p>
            <div className="tm-share-actions">
              {"share" in navigator && (
                <button className="small" onClick={() => void navigator.share({ title: "Join our game on Yama", url })}>Send the link</button>
              )}
              <button className="quiet small" onClick={stopHosting}>Stop sharing</button>
            </div>
          </>
        ) : (
          <div className="tm-share-actions">
            <button className="small" onClick={() => startHosting(gameId)}>Show the code</button>
          </div>
        )}
      </div>
    </section>
  );
}
