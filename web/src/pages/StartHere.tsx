// Start here: the first four things to do with an account, on the signed-in Home until they are
// done (Bryan, 12 Nov 2026). Each step is done when the account's own data says so, not when
// someone ticks it, so it can't drift from what is there. "Hide this list" is for someone who
// doesn't want a step (no playgroup, say): it is remembered on this device only.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type CollectionSummary, type DeckSummary, type GameRow, type Playgroup } from "../api";
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

/**
 * The list, for the signed-in Home. Home passes the decks and games it has already asked for.
 * Nothing shows until all four answers are in, so the list never flashes for an account that
 * finished it, and nothing shows if one can't be had (offline): it is a prompt, not a status.
 */
export function StartHere({ userId, decks, games }: { userId: string; decks: DeckSummary[] | undefined; games: GameRow[] | undefined }) {
  const collection = useQuery({ queryKey: ["collection-summary"], queryFn: ({ signal }) => api<CollectionSummary>("/api/collection/summary", { signal }) });
  const groups = useQuery({ queryKey: ["playgroups"], queryFn: ({ signal }) => api<Playgroup[]>("/api/playgroups", { signal }) });
  const [hidden, setHidden] = useState(() => wasHidden(userId));
  if (hidden || !decks || !games || !collection.data || !groups.data) return null;
  const steps = startSteps({ decks: decks.length, copies: collection.data.copies, playgroups: groups.data.length, games: games.length });
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const hide = () => {
    try {
      localStorage.setItem(hiddenKey(userId), "1");
    } catch {
      // Storage is off: hidden for this visit only.
    }
    setHidden(true);
  };
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
      <p>
        <Button variant="quiet" size="small" onClick={hide}>Hide this list</Button>
      </p>
    </section>
  );
}
