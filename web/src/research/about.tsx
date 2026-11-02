import { fmtDate } from "@yama/core/plan";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type DeckSummary } from "../api";

/**
 * What the Agent notes section is (Bryan, 2026-10-28, asked whether Research is "essentially just
 * state for you to base, like an MCP context"; it is). Notes are yama-research/1 documents agents
 * keep with `save_research`; they change no deck, plan, collection or order.
 */
export function AgentNotesAbout({ short = false }: { short?: boolean }) {
  return (
    <div className="research-about" role="note">
      <p>
        <b>Agent notes are what Claude and other agents save while they research your decks</b>, so the next agent can pick up where the last one stopped.
        Nothing here changes your decks, plans, collection or orders, and nothing here needs you to do anything.
      </p>
      {!short && (
        <p className="small dim">
          A note names your decks. When one of those decks has changed since the note was saved, the note says so, and an agent reads the current list again
          before relying on it. Anything you should decide shows up in <Link to="/decks/plan/review">Review</Link>.
        </p>
      )}
      {short && (
        <p className="small dim">
          Anything you should decide shows up in <Link to="/decks/plan/review">Review</Link>.
        </p>
      )}
    </div>
  );
}

/** Live main decks by lower-case name: the decks a note's deck names refer to. */
function byName(decks: DeckSummary[]): Map<string, DeckSummary> {
  const out = new Map<string, DeckSummary>();
  for (const d of decks) if (!d.parent_id) out.set(d.name.trim().toLowerCase(), d);
  return out;
}

/** The Yama deck a note's deck names, when it changed after the note was saved. */
export function changedSince(decks: DeckSummary[], name: string, savedAt: string): DeckSummary | null {
  const d = byName(decks).get(name.trim().toLowerCase());
  return d && d.updated_at > savedAt ? d : null;
}

/** "Your Riders of Rohan deck changed after this note was saved", when it did. */
export function DeckChanged({ name, savedAt }: { name: string; savedAt: string }) {
  const decks = useQuery({ queryKey: ["decks"], queryFn: () => api<DeckSummary[]>("/api/decks") });
  const d = decks.data ? changedSince(decks.data, name, savedAt) : null;
  if (!d) return null;
  return (
    <p className="small warn">
      Your <Link to={`/decks/${d.id}`}>{d.name}</Link> deck changed on {fmtDate(d.updated_at)}, after this note was saved. It may be out of date.
    </p>
  );
}
