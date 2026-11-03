// Shared table, host side: this phone stays the source of truth and streams its state to
// everyone who scanned the code. Their taps come back as events and go through our dispatch.

import { RELAY_TOKEN, relayShareKey, type TableEvent } from "@yama/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, API_BASE, publicOrigin } from "../api";
import { dispatch, getGame, isPosted, subscribeTable, subscribeTableEnd, sync, useTable as useCurrentTable, setSharedReadOnly, setSharedHost, prepareSharing, refreshSharedGame } from "./store";
import { chosenLayout, subscribeLayout } from "./layouts";
import { getShowArt, subscribeShowArt } from "./art";
import { getCountTurns, subscribeCountTurns } from "./turns";

/**
 * Where shared tables meet. Set (production): Yama's relay on Cloudflare (relay/), which works
 * while Yama's own server is offline and needs no account, only the share key. Unset (local
 * development, a self-hosted copy): the server's own relay, for signed-in guests.
 */
export const EDGE_RELAY = (import.meta.env.VITE_RELAY_URL as string | undefined)?.replace(/\/$/, "") ?? "";

/** Which relay a shared game meets on. */
export type Relay = "edge" | "server";
/**
 * Join links say which: `#k=<key>&r=cf` is the Cloudflare relay, no `r` the server's. Phones
 * keep the app they loaded until they reload, so during a deploy an old host's link must still
 * send a new guest to the server, and a new host's link a new guest to Cloudflare.
 */
const EDGE_MARK = "cf";

function serverWsUrl(gameId: string, role: "host" | "guest", key: string) {
  const base = new URL(API_BASE || location.origin);
  const proto = base.protocol === "https:" ? "wss" : "ws";
  // Browsers can't set headers on WebSockets, so native apps pass their token in the URL.
  const token = API_BASE ? localStorage.getItem("yama.token") : null;
  return `${proto}://${base.host}/api/table/${gameId}/ws?role=${role}&key=${encodeURIComponent(key)}${token ? `&token=${token}` : ""}`;
}

/** The connection a phone following `gameId` opens with the key from its link. */
export function guestWsUrl(gameId: string, key: string, relay: Relay) {
  return relay === "edge" ? `${EDGE_RELAY}/table/${gameId}/ws?role=guest&key=${encodeURIComponent(key)}` : serverWsUrl(gameId, "guest", key);
}

/**
 * What a join link (or, after a reload, what this phone kept from it) says: the share key and
 * the relay. A Cloudflare link opened by a build without the Cloudflare relay falls back to the
 * server's, where the host isn't, rather than nowhere.
 */
export function joinLink(gameId: string): { key: string; relay: Relay } {
  const hash = new URLSearchParams(location.hash.slice(1));
  const fromLink = hash.get("k");
  if (fromLink) {
    localStorage.setItem(`yama.guestkey.${gameId}`, fromLink);
    if (hash.get("r") === EDGE_MARK) localStorage.setItem(`yama.guestrelay.${gameId}`, EDGE_MARK);
    else localStorage.removeItem(`yama.guestrelay.${gameId}`);
  }
  const key = fromLink ?? localStorage.getItem(`yama.guestkey.${gameId}`) ?? "";
  const edge = EDGE_RELAY && localStorage.getItem(`yama.guestrelay.${gameId}`) === EDGE_MARK;
  return { key, relay: edge ? "edge" : "server" };
}

/** The #fragment of a link to `gameId` on `relay`. */
export function joinFragment(key: string, relay: Relay) {
  return `#k=${key}${relay === "edge" ? `&r=${EDGE_MARK}` : ""}`;
}

/** Which relay this phone hosts `gameId` on. */
function hostRelay(gameId: string): Relay {
  // A game this phone already shared through the server (before 2026-11) stays there with its
  // random key, so the phones that scanned it stay in.
  return EDGE_RELAY && !localStorage.getItem(`yama.share.${gameId}`) ? "edge" : "server";
}

function hostWsUrl(gameId: string) {
  return hostRelay(gameId) === "edge" ? `${EDGE_RELAY}/table/${gameId}/ws?role=host&secret=${hostCreds(gameId).secret}` : serverWsUrl(gameId, "host", shareKey(gameId));
}

const token = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const HOST_PREFIX = "yama.host.";
/** Credentials for games this long ago are dropped when a new game gets its own. */
const KEEP_CREDS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * This phone's credentials for hosting `gameId`: a secret that never leaves it (except to the
 * relay, to prove it's the host) and the share key derived from it, for the QR code.
 */
function hostCreds(gameId: string): { secret: string; key: string } {
  const k = HOST_PREFIX + gameId;
  try {
    const saved = JSON.parse(localStorage.getItem(k) ?? "null") as { secret?: unknown } | null;
    if (typeof saved?.secret === "string" && RELAY_TOKEN.test(saved.secret)) return { secret: saved.secret, key: relayShareKey(gameId, saved.secret) };
  } catch {
    /* unreadable: start over */
  }
  forgetOldCreds();
  const secret = token();
  localStorage.setItem(k, JSON.stringify({ secret, at: Date.now() }));
  return { secret, key: relayShareKey(gameId, secret) };
}

function forgetOldCreds() {
  try {
    const old: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(HOST_PREFIX)) continue;
      const at = (JSON.parse(localStorage.getItem(k) ?? "null") as { at?: unknown } | null)?.at;
      if (typeof at !== "number" || Date.now() - at > KEEP_CREDS_MS) old.push(k);
    }
    for (const k of old) localStorage.removeItem(k);
  } catch {
    /* storage unavailable: nothing to tidy */
  }
}

/** The share key for a game this phone hosts. It rides in the QR link's #fragment. */
export function shareKey(gameId: string): string {
  return (hostRelay(gameId) === "server" ? localStorage.getItem(`yama.share.${gameId}`) : null) ?? hostCreds(gameId).key;
}

/** Guests may adjust the table, but only the host's phone ends the game. */
const GUEST_EVENTS = new Set<TableEvent["type"]>([
  "life", "poison", "commander_damage", "counter", "commander_cast", "monarch", "initiative", "day_night", "pass_turn", "eliminate", "revive", "seat", "set_first",
]);

export { publicOrigin } from "../api";

type Status = { gameId: string | null; connected: boolean; following?: string | null };
let status: Status = { gameId: null, connected: false };
const listeners = new Set<() => void>();
const setStatus = (s: Partial<Status>) => {
  status = { ...status, ...s };
  for (const l of listeners) l();
};

let socket: WebSocket | null = null;
let unsubscribe: (() => void) | null = null;
let retry: number | null = null;
let postWait: number | null = null;
let liveTimer: number | null = null;
let liveRegistration: { preserveOnStop: boolean } | null = null;
let lastGame: ReturnType<typeof getGame> = null;
let nextGame: { gameId: string; key: string; relay?: string } | null = null;
const hostingKey = (owner: string) => `yama.table.hosting.${owner}`;
/** The last snapshot sent: the store emits on every sync, and most change nothing. */
let lastSent: string | null = null;

/**
 * The game goes to the relay at most this often while it changes (always the newest; nothing is
 * lost), so guests tapping fast can't make this phone use up its share of the relay's messages.
 */
export const SNAPSHOT_EVERY_MS = 200;
let lastSentAt = 0;
let snapshotTimer: number | null = null;

/** Send the game soon: now if the last one went long enough ago, else once the wait is over. */
function queueSnapshot() {
  if (snapshotTimer !== null) return;
  const wait = Math.max(0, lastSentAt + SNAPSHOT_EVERY_MS - Date.now());
  snapshotTimer = window.setTimeout(() => {
    snapshotTimer = null;
    sendSnapshot();
  }, wait);
}

function sendSnapshot() {
  const g = getGame();
  if (!socket || socket.readyState !== WebSocket.OPEN || !g || g.setup.id !== status.gameId) return;
  const msg = JSON.stringify({ type: "state", setup: g.setup, log: g.log, layout: chosenLayout(g.setup.players.length), countTurns: getCountTurns(), showArt: getShowArt() });
  if (msg === lastSent) return;
  lastGame = g;
  lastSent = msg;
  lastSentAt = Date.now();
  socket.send(msg);
}

/** Close codes after which trying again can't help. */
const REPLACED = 4000; // this game is being shared from another tab or device now
const TOO_LARGE = 1009; // the game outgrew the relay's message limit

function open(gameId: string, attempt = 0) {
  const ws = new WebSocket(hostWsUrl(gameId));
  let opened = false;
  socket = ws;
  ws.onopen = () => {
    opened = true;
    lastSent = null;
    setStatus({ connected: true });
    sendSnapshot();
  };
  ws.onmessage = (m) => {
    try {
      const msg = JSON.parse(m.data) as { type: string; event?: TableEvent };
      if (msg.type === "event" && msg.event && GUEST_EVENTS.has(msg.event.type)) dispatch(msg.event);
      // The Cloudflare relay slept and lost its newest copy, and someone joined.
      else if (msg.type === "resend") {
        lastSent = null;
        sendSnapshot();
      }
    } catch {
      /* ignore malformed */
    }
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    if (e.code === REPLACED || e.code === TOO_LARGE) {
      // Not this phone's to share any more (another tab has the same game), or never will be:
      // stop, but leave the share key with the server for whoever took over.
      reset({ preserveLive: true });
      return;
    }
    setStatus({ connected: false });
    // Keep trying while we're still sharing this game; the table works offline meanwhile.
    if (status.gameId === gameId) {
      const next = opened ? 0 : attempt + 1;
      // Too many from this network (the relay closes with 4429): wait out the minute rather than
      // knocking again and using up the table's shared allowance. Otherwise back off, spread out.
      const wait = e.code === 4429 ? 60_000 : Math.min(15_000, 1000 * 2 ** next) * (0.75 + Math.random() / 2);
      retry = window.setTimeout(() => open(gameId, next), wait);
    }
  };
}

/**
 * Tell the phones following this game that the table is playing again, with the next game's
 * link: they follow it without scanning again. Sent just before this game finishes.
 */
export function announceNext(nextId: string) {
  const g = getGame();
  if (!socket || socket.readyState !== WebSocket.OPEN || !g || g.setup.id !== status.gameId) return;
  // If the connection is down right now, guests scan the new game's code instead.
  const next = { gameId: nextId, key: shareKey(nextId), ...(hostRelay(nextId) === "edge" ? { relay: EDGE_MARK } : {}) };
  nextGame = next;
  socket.send(JSON.stringify({ type: "state", setup: g.setup, log: g.log, next }));
}

/** The link a phone opens to join `gameId`, share key in the #fragment. */
export function joinUrl(gameId: string): string {
  return `${publicOrigin()}/table/join/${gameId}${joinFragment(shareKey(gameId), hostRelay(gameId))}`;
}

function useQrSvg(url: string, on: boolean): string {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    // Stopped sharing: no code left on screen for anyone to scan into an empty room.
    if (!on) return setSvg("");
    // The QR library loads only when a table is shared.
    let live = true;
    void import("qrcode")
      .then((QRCode) => QRCode.default.toString(url, { type: "svg", margin: 1, color: { dark: "#0b0c0e", light: "#f2efe8" } }))
      .then((svg) => live && setSvg(svg));
    return () => {
      live = false;
    };
  }, [on, url]);
  return svg;
}

let hostAttempt = 0;
let releaseHostLock: (() => void) | null = null;

export function startHosting(gameId: string) {
  if (status.gameId === gameId) return;
  prepareSharing();
  stopHosting();
  const attempt = ++hostAttempt;
  setStatus({ gameId, connected: false, following: null });
  // A reload may restore sharing, but a second tab must never steal it. The lock is released
  // by the browser when the document closes; no timers or expired leases decide ownership.
  if (typeof navigator !== "undefined" && navigator.locks) {
    setSharedReadOnly(gameId);
    void navigator.locks.request(`yama-table-host:${gameId}`, { ifAvailable: true }, async (lock) => {
      if (attempt !== hostAttempt) return;
      if (!lock) {
        setStatus({ gameId: null, connected: false, following: gameId });
        return;
      }
      const held = new Promise<void>((resolve) => { releaseHostLock = resolve; });
      if (!activateHosting(gameId)) return;
      await held;
    });
  } else {
    // Older embedded browsers can still explicitly host; automatic reload recovery below
    // requires browser locks so merely opening another app window never takes over.
    activateHosting(gameId);
  }
}

function activateHosting(gameId: string): boolean {
  if (!refreshSharedGame(gameId)) { reset(); return false; }
  setSharedHost(gameId);
  setSharedReadOnly(null);
  const game = getGame();
  if (game?.owner) localStorage.setItem(hostingKey(game.owner), gameId);
  lastGame = game;
  const off = [subscribeTable(() => {
    const g = getGame();
    if (!g || g.setup.id !== gameId) {
      stopHosting();
    } else queueSnapshot();
  }), subscribeTableEnd((ended) => {
    if (ended.setup.id !== gameId || socket?.readyState !== WebSocket.OPEN) return;
    // Retained by the relay for sleeping phones too. Account switches do not end a game.
    socket.send(JSON.stringify({ type: "state", setup: ended.setup, log: ended.log, ended: true, ...(nextGame ? { next: nextGame } : {}) }));
  }), subscribeLayout(queueSnapshot), subscribeShowArt(queueSnapshot), subscribeCountTurns(queueSnapshot)];
  unsubscribe = () => { for (const f of off) f(); };
  if (hostRelay(gameId) === "edge") {
    // The Cloudflare relay needs nothing from Yama's server, so the table is live at once.
    open(gameId);
    void tellOwnDevices(gameId);
  } else {
    // The server's relay only lets the game's creator host a game it already has.
    void untilPosted(gameId).then((ok) => ok && !socket && open(gameId));
  }
  return true;
}

/**
 * Whether the server has `gameId` yet: a game started a moment ago (setup with everyone's
 * phones, or a rematch) uploads first. Offline, it keeps trying while this game is still being
 * shared; the table works meanwhile. False if sharing stopped first.
 */
async function untilPosted(gameId: string): Promise<boolean> {
  for (let attempt = 0; status.gameId === gameId && !isPosted(gameId); attempt++) {
    await sync();
    if (status.gameId !== gameId || isPosted(gameId)) break;
    await new Promise((r) => (postWait = window.setTimeout(r, Math.min(15_000, 1000 * 2 ** attempt))));
  }
  return status.gameId === gameId;
}

const livePath = (gameId: string) => `/api/table/${gameId}/live`;
/** Live discovery expires after three minutes without a heartbeat. */
const LIVE_REFRESH_MS = 60 * 1000;

/**
 * Leave the share key with Yama's server, for the creator's own other devices: the creator and the selected playgroup can
 * follow it live. Best effort; the
 * table doesn't need it.
 */
async function tellOwnDevices(gameId: string) {
  const attempt = hostAttempt;
  const registration = { preserveOnStop: false };
  liveRegistration = registration;
  if (!(await untilPosted(gameId)) || attempt !== hostAttempt) return;
  const put = () => attempt === hostAttempt
    ? api(livePath(gameId), { method: "PUT", json: { key: shareKey(gameId) } }).catch(() => undefined)
    : Promise.resolve();
  await put();
  // A terminal closure must not erase a successor's key when an older PUT finishes late.
  // An explicit stop still cleans up its delayed PUT, unless this phone started it again.
  if (attempt !== hostAttempt) {
    if (!registration.preserveOnStop && status.gameId !== gameId) await api(livePath(gameId), { method: "DELETE" }).catch(() => undefined);
    return;
  }
  liveTimer = window.setInterval(() => void put(), LIVE_REFRESH_MS);
}

/** Stop sharing on this phone, without telling the server. */
function reset({ preserveLive = false }: { preserveLive?: boolean } = {}) {
  if (liveRegistration) liveRegistration.preserveOnStop = preserveLive;
  liveRegistration = null;
  if (lastGame?.owner && localStorage.getItem(hostingKey(lastGame.owner)) === status.gameId) localStorage.removeItem(hostingKey(lastGame.owner));
  for (const t of [retry, postWait, snapshotTimer]) if (t) window.clearTimeout(t);
  if (liveTimer) window.clearInterval(liveTimer);
  retry = postWait = liveTimer = snapshotTimer = null;
  unsubscribe?.();
  unsubscribe = null;
  const s = socket;
  socket = null;
  lastSent = null;
  lastGame = null;
  nextGame = null;
  s?.close();
  hostAttempt++;
  releaseHostLock?.();
  releaseHostLock = null;
  setSharedHost(null);
  setSharedReadOnly(null);
  setStatus({ gameId: null, connected: false, following: null });
}

export function stopHosting() {
  const gameId = status.gameId;
  if (gameId && hostRelay(gameId) === "edge") void api(livePath(gameId), { method: "DELETE" }).catch(() => undefined);
  reset();
}

/** A reload resumes only sharing explicitly started for this account's current game. */
export function restoreHosting(user: string | null, markerChanged = false) {
  const game = getGame();
  const marked = !!user && game?.owner === user && localStorage.getItem(hostingKey(user)) === game.setup.id;
  const starting = status.gameId === game?.setup.id && lastGame === null;
  if ((status.gameId || status.following) && (!user || game?.owner !== user || game?.setup.id !== (status.gameId ?? status.following) || (!marked && (!starting || markerChanged)))) stopHosting();
  if (marked && game && (typeof navigator === "undefined" || navigator.locks)) startHosting(game.setup.id);
}
export function useRestoreHosting(user: string | null) {
  const { game } = useCurrentTable();
  useEffect(() => {
    restoreHosting(user);
    const onStorage = (event: StorageEvent) => {
      if (user && (event.key === null || event.key === hostingKey(user))) restoreHosting(user, true);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [user, game?.setup.id]);
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
export function ShareCard({ gameId, onBigger }: { gameId: string; onBigger?: () => void }) {
  const hosting = useHosting();
  const sharing = hosting.gameId === gameId;
  const url = joinUrl(gameId);
  const svg = useQrSvg(url, sharing);
  return (
    <section className="tm-share" aria-labelledby="tm-share-title">
      {sharing && svg ? (
        onBigger ? (
          <button className="tm-qr tm-qr-btn" onClick={onBigger} aria-label="Show the join code full size" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="tm-qr" dangerouslySetInnerHTML={{ __html: svg }} aria-label="Join code" role="img" />
        )
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

/**
 * The join code as big as the sheet allows, for the table to scan at the start of a game (or a
 * late arrival). Sharing starts when this opens.
 */
export function JoinSheet({ gameId, onDone }: { gameId: string; onDone: () => void }) {
  const hosting = useHosting();
  const sharing = hosting.gameId === gameId;
  const url = joinUrl(gameId);
  const svg = useQrSvg(url, sharing);
  useEffect(() => {
    if (!sharing) startHosting(gameId);
    // Only on opening: "Stop sharing" here stays stopped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);
  return (
    <div className="stack join-sheet">
      <div className="sheet-head">
        <h2>Everyone on their own phone</h2>
        <button className="quiet" onClick={onDone}>Done</button>
      </div>
      <p className="dim" style={{ margin: 0 }}>
        Scan this with a phone camera, pick your seat and keep your own totals.{hostRelay(gameId) === "edge" ? " No account needed." : " Everyone signs in to Yama with Google the first time."}
      </p>
      {sharing && svg ? <div className="join-qr" dangerouslySetInnerHTML={{ __html: svg }} aria-label="Join code" role="img" /> : <div className="join-qr join-qr-wait" aria-hidden="true" />}
      <p role="status" className="tm-status">
        <span className={`status-dot ${hosting.connected ? "good" : "warn"}`} aria-hidden="true" />
        {!sharing ? "Not sharing" : hosting.connected ? "Live: phones that join follow along" : "Connecting to Yama…"}
      </p>
      <div className="row">
        {"share" in navigator && <button onClick={() => void navigator.share({ title: "Join our game on Yama", url })}>Send the link</button>}
        {sharing ? (
          <button className="quiet" onClick={stopHosting}>Stop sharing</button>
        ) : (
          <button onClick={() => startHosting(gameId)}>Share again</button>
        )}
      </div>
      <p className="small dim" style={{ margin: 0 }}>This phone keeps the game, so it carries on if the signal drops. The code stays in the table menu.</p>
    </div>
  );
}
