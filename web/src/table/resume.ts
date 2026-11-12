// Opening Yama with a game in progress goes straight to it (Bryan, 12 Nov 2026): the life
// counter's game on this device, if someone touched it lately. A game left on the device from
// another night stays on Home as a card to go back to, so an old game never takes over every
// visit.
import type { LocalGame } from "./store";

/** How lately a game was touched for Yama to open on it: a long game night. */
export const RESUME_WITHIN_MS = 12 * 60 * 60 * 1000;

/** When the game was last touched: its newest event, or its start. NaN when neither is a date. */
export function lastTouched(game: Pick<LocalGame, "setup" | "log">): number {
  const times = [game.setup.startedAt, ...game.log.map((l) => l.at)].map((t) => Date.parse(t)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
}

/** Whether Yama opens on this game. A clock set back (a touch "in the future") still counts. */
export function resumesOnOpen(game: Pick<LocalGame, "setup" | "log"> | null | undefined, now: number): boolean {
  if (!game) return false;
  const at = lastTouched(game);
  return Number.isFinite(at) && now - at <= RESUME_WITHIN_MS;
}

// True only for the page load that opened Yama at `/`, until Home has been on screen once.
let opening = false;

/** A visit began at `pathname`: only one that began at Home can open on a game. */
export function visitBeganAt(pathname: string) {
  opening = pathname === "/";
}
if (typeof location !== "undefined") visitBeganAt(location.pathname);

/** Whether this is the first look at Home on a visit that opened there. */
export const isOpening = () => opening;

/** Home has been shown (or has sent the visit on to its game): later looks at it are just Home. */
export function opened() {
  opening = false;
}
