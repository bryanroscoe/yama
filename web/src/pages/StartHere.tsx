// Start here: the first four things to do with an account, on the signed-in Home until they are
// done (Bryan, 12 Nov 2026). Each step is done when the account's own data says so, not when
// someone ticks it, so it can't drift from what is there. "Hide this list" is for someone who
// doesn't want a step (no playgroup, say): it is remembered on this device only, and not offered
// while an admin views as someone, whose list it isn't.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CollectionSummary, type DeckSummary, type GameRow, type Playgroup } from "../api";
import { useMe } from "../auth";
import { Button, ButtonLink } from "../components/ui";

export interface StartStep {
  id: "deck" | "collection" | "playgroup" | "game";
  title: string;
  text: string;
  done: boolean;
  links: { to: string; label: string }[];
}

/** The four steps, in order, with whether each is done for an account that has these. */
export function startSteps(has: { decks: number; copies: number; playgroups: number; games: number }): StartStep[] {
  return [
    {
      id: "deck",
      title: "Add a deck",
      text: "Import a list from anywhere, or start from a precon.",
      done: has.decks > 0,
      links: [
        { to: "/decks/import", label: "Add a deck" },
        { to: "/lab", label: "Start from a precon" },
      ],
    },
    { id: "collection", title: "Bring your collection", text: "Import a file from another app, or add cards from search.", done: has.copies > 0, links: [{ to: "/collection", label: "Open Collection" }] },
    { id: "playgroup", title: "Start or join a playgroup", text: "Keep your group's games, decks and stats together.", done: has.playgroups > 0, links: [{ to: "/group", label: "Open Playgroup" }] },
    // `games`: ones the account sat in (gamesPlayed), not ones it only recorded.
    { id: "game", title: "Play a game", text: "Count life at the table, or play the computer online.", done: has.games > 0, links: [{ to: "/play/table", label: "Start a game" }] },
  ];
}

const hiddenKey = (userId: string) => `yama.starthere.hidden.${userId}`;

/** Whether this account's list was hidden on this device. Storage that can't be read says no. */
function wasHidden(userId: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(userId)) === "1";
  } catch {
    return false;
  }
}

/** How many of `games` the account sat in. A game it only recorded for others isn't one it played. */
export function gamesPlayed(games: GameRow[], userId: string): number {
  return games.filter((g) => g.seats.some((s) => s.user_id === userId)).length;
}

/** What the list needs to know about one of its four questions. */
interface Asked {
  isSuccess: boolean;
  isFetchedAfterMount: boolean;
  isStale: boolean;
}

/**
 * Whether a question has a current answer: one Yama's server gave since Home opened, or one
 * still fresh when it opened (`freshAtOpen`: asked within the app's stale time, a moment ago on
 * another page), with no failure since. An older answer kept from an earlier visit may be out of
 * date (a step done on another device), and one that can't be had (offline) is no answer.
 */
export const answered = (q: Pick<Asked, "isSuccess" | "isFetchedAfterMount">, freshAtOpen: boolean): boolean => q.isSuccess && (q.isFetchedAfterMount || freshAtOpen);

/**
 * The list, for the signed-in Home. Home passes its decks and games questions, which it has
 * already asked. Nothing shows until all four have a current answer, so the list never flashes
 * for an account that finished it, on this device or another, and nothing shows if one can't be
 * had (offline): it is a prompt, not a status.
 */
export function StartHere({ userId, decks, games }: { userId: string; decks: Asked & { data: DeckSummary[] | undefined }; games: Asked & { data: GameRow[] | undefined } }) {
  const viewing = !!useMe().data?.viewing;
  const collection = useQuery({ queryKey: ["collection-summary"], queryFn: ({ signal }) => api<CollectionSummary>("/api/collection/summary", { signal }) });
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: ({ signal }) => api<Playgroup[]>("/api/playgroups", { signal }) });
  const [hidden, setHidden] = useState(() => wasHidden(userId));
  const asked = [decks, games, collection, groups];
  // Which answers were still fresh when Home opened: noted once, since every answer goes stale
  // in time while the page stays open, and the list mustn't leave then.
  const [fresh] = useState(() => asked.map((q) => !q.isStale));
  if (hidden || !asked.every((q, i) => answered(q, fresh[i] ?? false))) return null;
  if (!decks.data || !games.data || !collection.data || !groups.data) return null;
  const steps = startSteps({ decks: decks.data.length, copies: collection.data.copies, playgroups: groups.data.length, games: gamesPlayed(games.data, userId) });
  if (steps.every((s) => s.done)) return null;
  const hide = () => {
    try {
      localStorage.setItem(hiddenKey(userId), "1");
    } catch {
      // Storage is off: hidden for this visit only.
    }
    setHidden(true);
  };
  return <StartHereList steps={steps} onHide={viewing ? undefined : hide} />;
}

/** The list as drawn. `onHide`: absent where hiding isn't offered. */
export function StartHereList({ steps, onHide }: { steps: StartStep[]; onHide?: () => void }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <section className="home-start-here" aria-labelledby="home-start-here-title">
      <div className="home-start-here-head">
        <h2 id="home-start-here-title">Start here</h2>
        <p className="dim">{done} of {steps.length} done</p>
      </div>
      <ol className="home-steps">
        {steps.map((s, i) => (
          <li key={s.id} className={s.done ? "is-done" : undefined}>
            <span className="home-step-mark num" aria-hidden="true">{s.done ? "✓" : i + 1}</span>
            <span className="home-step-text">
              <b>{s.title}</b>
              <span>{s.done ? "Done." : s.text}</span>
            </span>
            {!s.done && (
              <span className="home-step-links">
                {s.links.map((l, n) => (
                  <ButtonLink key={l.to} variant={n === 0 ? "secondary" : "outline"} to={l.to}>{l.label}</ButtonLink>
                ))}
              </span>
            )}
          </li>
        ))}
      </ol>
      {onHide && (
        <p>
          <Button variant="quiet" size="small" onClick={onHide}>Hide this list</Button>
        </p>
      )}
    </section>
  );
}
