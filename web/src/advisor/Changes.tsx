// Suggested changes from Yama's assistant or external MCP clients. Only Apply changes the data.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { usePower } from "../auth";
import { AreaHead } from "../components/DeckTabs";
import { ChangesHowTo } from "../plan/howto";
import { Button, Details, ErrorText, Loading } from "../components/ui";
import { applyChange, changesKey, discardChange, stagedChanges, type StagedChange } from "./api";
import { Proposal, ProposalText } from "./Proposal";
import "./advisor.css";

const VIA: Record<StagedChange["via"], string> = {
  question: "From Yama’s assistant",
  key: "From MCP with a script key",
  oauth: "From an external app through MCP",
};

/** One staged change, with Apply and Discard while it waits. */
/** Staged changes that start simulations when applied. */
const SIMULATIONS: StagedChange["kind"][] = ["start_lab_run", "more_lab_games", "run_lab_again"];
/** What part of Yama a change is about, as a tag before it: a plan's changes say so. */
const AREA: Partial<Record<StagedChange["kind"], string>> = {
  track_build: "Plan",
  approve_plan: "Plan",
  propose_swap: "Plan",
  answer_review: "Plan",
  mark_bought: "Plan",
  mark_installed: "Plan",
  swap_in_prints: "Plan",
};

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
  // Applying a staged lab run starts simulations: admins and power users only (the server refuses
  // anyone else). Discard stays.
  const power = usePower();
  const canApply = power || !SIMULATIONS.includes(shown.kind);
  return (
    <div className={`ask-change is-${shown.status}`}>
      <p className="ask-change-what">
        {AREA[shown.kind] && <span className="pill quiet ask-change-area">{AREA[shown.kind]}</span>}
        <b>{shown.preview?.target ?? shown.summary}</b>
      </p>
      {shown.preview ? <Proposal preview={shown.preview} /> : shown.detail && <ProposalText text={shown.detail} />}
      {shown.status === "pending" ? (
        <>
          {shown.error && (
            <p className="error small" role="alert">
              {shown.error}
            </p>
          )}
          <div className="ask-change-actions">
            {canApply && (
              <Button variant="primary" disabled={busy} onClick={() => decide.mutate("apply")}>
                {busy && decide.variables === "apply" ? "Applying…" : shown.kind === "delete_deck" ? "Delete" : shown.kind === "remove_from_collection" ? "Remove" : "Apply"}
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => decide.mutate("discard")}>
              Discard
            </Button>
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

/** Shown on Decks while suggested changes wait for review. */
export function ChangesBanner() {
  const waiting = useQuery({ queryKey: [...changesKey, "pending"], queryFn: () => stagedChanges(), staleTime: 30_000 });
  const n = waiting.data?.length ?? 0;
  if (!n) return null;
  return (
    <p className="ask-changes-banner">
      {n === 1 ? "A suggested change is" : `${n} suggested changes are`} waiting for your review. <Link to="/decks/changes">Review {n === 1 ? "it" : "them"}</Link>
    </p>
  );
}

/** Suggested changes: everything waiting, then what was decided lately. */
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
      <AreaHead title="Suggested changes" back={{ to: "/decks", label: "Decks" }} />
      <ChangesHowTo open={!!all.data && !waiting.some((c) => c.status === "pending")} />
      <ErrorText error={all.error} />
      {all.isPending && <Loading />}
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
