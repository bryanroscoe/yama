// phase's own board (phase's web client, served at /board/) on a Yama game. It resumes a game
// from the session it keeps in localStorage, so Yama writes that session for the viewer's seat
// and opens the board's game page. The server end is /api/play/{id}/board (server/src/play/board.rs);
// the signed-in account's cookie decides the seat there, so the token is only a label.

/** phase's `WS_SESSION_STORAGE_KEY` (client/src/services/multiplayerSession.ts). */
export const PHASE_SESSION_KEY = "phase-ws-session";

export interface PhaseSession {
  gameCode: string;
  playerToken: string;
  fullKey: { game_code: string; generation: number };
  serverUrl: string;
  timestamp: number;
}

/** The session phase's board resumes `gameId` from, for `seat`, on this site. */
export function phaseSession(gameId: string, seat: number, loc: { protocol: string; host: string }, now = Date.now()): PhaseSession {
  const ws = loc.protocol === "https:" ? "wss:" : "ws:";
  return {
    gameCode: gameId,
    playerToken: `yama-seat-${seat}`,
    // Yama games have one generation (yama_play::board::session_key).
    fullKey: { game_code: gameId, generation: 1 },
    serverUrl: `${ws}//${loc.host}/api/play/${encodeURIComponent(gameId)}/board`,
    timestamp: now,
  };
}

/** Where phase's board shows a game it resumes. */
export function phaseBoardUrl(gameId: string): string {
  // Phase maps `host` to its network provider; without a join code the
  // saved session above selects reconnect. `online` falls back to local play.
  return `/board/game/${encodeURIComponent(gameId)}?mode=host`;
}

/** Open `gameId` for `seat` on phase's board, in place of this page. */
export function openPhaseBoard(gameId: string, seat: number) {
  localStorage.setItem(PHASE_SESSION_KEY, JSON.stringify(phaseSession(gameId, seat, window.location)));
  window.location.assign(phaseBoardUrl(gameId));
}
