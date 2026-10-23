// Changes Claude staged through Yama's tools (docs/mcp-design.md, slice 2). Nothing changes until
// the person presses Apply here: under the answer that staged it, or on Decks, Changes from Claude.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { AreaHead } from "../components/DeckTabs";
import { Details, ErrorText } from "../components/ui";
import { applyChange, changesKey, discardChange, stagedChanges, type StagedChange } from "./api";
import "./advisor.css";

const VIA: Record<StagedChange["via"], string> = {
  question: "From Ask Claude",
  key: "From Claude with a key",
  oauth: "From a Claude app",
};

/** One staged change, with Apply and Discard while it waits. */
export function ChangeCard({ change, onNavigate, onDecided }: { change: StagedChange; onNavigate?: () => void; onDecided?: (id: string) => void }) {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: (what: "apply" | "discard") => (what === "apply" ? applyChange(change.id) : discardChange(change.id)),
    onSettled: (_data, _err, what) => {
      onDecided?.(change.id);
      void qc.invalidateQueries({ queryKey: changesKey });
      // An applied change can touch decks, plans, the lab or the collection.
      if (what === "apply") void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "assistant" && q.queryKey[0] !== "advisor" });
    },
  });
  const shown = decide.data ?? change;
  const busy = decide.isPending;
  return (
    <div className={`ask-change is-${shown.status}`}>
      <p className="ask-change-what">
        <b>{shown.summary}</b>
      </p>
      {shown.detail && (
        <Details label="Details">
          <pre className="ask-change-detail">{shown.detail}</pre>
        </Details>
      )}
      {shown.status === "pending" ? (
        <>
          {shown.error && (
            <p className="error small" role="alert">
              {shown.error}
            </p>
          )}
          <div className="ask-change-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => decide.mutate("apply")}>
              {busy && decide.variables === "apply" ? "Applying…" : "Apply"}
            </button>
            <button type="button" className="outline" disabled={busy} onClick={() => decide.mutate("discard")}>
              Discard
            </button>
          </div>
          {!shown.error && <p className="small dim">Waiting for your review. Nothing has changed yet.</p>}
        </>
      ) : shown.status === "applied" ? (
        <p className="small" role="status">
          Applied.{" "}
          {shown.result?.link ? (
            <Link to={shown.result.link} onClick={onNavigate}>
              {shown.result.label ?? "Open"}
            </Link>
          ) : (
            shown.result?.label
          )}
        </p>
      ) : (
        <p className="small dim" role="status">Discarded.</p>
      )}
      <ErrorText error={decide.error} />
    </div>
  );
}

/** "Claude has 2 changes for you to review": shown on Decks while any wait. */
export function ChangesBanner() {
  const waiting = useQuery({ queryKey: [...changesKey, "pending"], queryFn: () => stagedChanges(), staleTime: 30_000 });
  const n = waiting.data?.length ?? 0;
  if (!n) return null;
  return (
    <p className="ask-changes-banner">
      Claude has {n === 1 ? "a change" : `${n} changes`} for you to review. <Link to="/decks/changes">Review {n === 1 ? "it" : "them"}</Link>
    </p>
  );
}

/** Decks, Changes from Claude: everything waiting, then what was decided lately. */
export function ChangesPage() {
  const all = useQuery({ queryKey: [...changesKey, "all"], queryFn: () => stagedChanges({ all: true }) });
  // A change decided on this visit stays in place, showing what became of it, until the page is left.
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const keep = (id: string) => setKept((k) => new Set(k).add(id));
  const waiting = all.data?.filter((c) => c.status === "pending" || kept.has(c.id)) ?? [];
  const decided = all.data?.filter((c) => c.status !== "pending" && !kept.has(c.id)) ?? [];
  const groups = [...new Set(waiting.map((c) => c.via))];
  return (
    <main className="page">
      <AreaHead title="Changes from Claude" back={{ to: "/decks", label: "Decks" }} />
      <p className="dim">
        Claude stages changes here instead of making them: to a deck, a plan, the lab or your collection. Nothing changes until you press Apply.
      </p>
      <ErrorText error={all.error} />
      {all.isPending && <p className="dim">Loading…</p>}
      {all.data && !waiting.some((c) => c.status === "pending") && <p>Nothing is waiting for your review.</p>}
      {groups.map((via) => (
        <section key={via} className="ask-changes-group">
          <h2 className="small dim">{VIA[via]}</h2>
          <div className="ask-changes-list">
            {waiting
              .filter((c) => c.via === via)
              .map((c) => (
                <ChangeCard key={c.id} change={c} onDecided={keep} />
              ))}
          </div>
        </section>
      ))}
      {decided.length > 0 && (
        <Details label={`Decided lately (${decided.length})`}>
          <div className="ask-changes-list">
            {decided.map((c) => (
              <ChangeCard key={c.id} change={c} />
            ))}
          </div>
        </Details>
      )}
    </main>
  );
}
