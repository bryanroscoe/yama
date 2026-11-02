import { fmtDate } from "@yama/core/plan";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, type DeckSummary } from "../api";

/**
 * What the Agent notes section is (Bryan, 2026-10-28, asked whether Research is "essentially just
 * state for you to base, like an MCP context"; it is). Notes are yama-research/1 documents agents
 * keep with `save_research`; they change no deck, plan, collection or order.
 */
export function AgentNotesAbout() {
  return (
    <div className="research-about" role="note">
      <p>
        Research saved by your agents. Decisions go to <Link to="/decks/plan/review">Review</Link>.
      </p>
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
