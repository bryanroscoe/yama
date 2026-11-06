// A plan deck's own parts, on its plan page: the Yama deck it's for, and ideas for the planner.
import { fmtDate, opTime, type IdeaOp, type PlanDeck } from "@yama/core/plan";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type DeckSummary } from "../api";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { linkDeck } from "./api";
import { deviceId, outbox, useOutbox } from "./outbox";
import type { PlanView } from "./view";

// ── The Yama deck this plan is for ──────────────────────────────────────────

export function LinkDeck({ deck }: { deck: PlanDeck }) {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const [open, setOpen] = useState(false);
  const decks = useQuery({ queryKey: ["decks"], queryFn: ({ signal }) => api<DeckSummary[]>("/api/decks", { signal }), enabled: open || !!deck.deck_id });
  const linked = decks.data?.find((d) => d.id === deck.deck_id);
  const link = useMutation({
    mutationFn: (id: string | null) => linkDeck(deck.key, id),
    onSuccess: () => {
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["plan", userId] });
    },
  });
  return (
    <section className="plan-link stack">
      <h3>Your deck in Yama</h3>
      {deck.deck_id ? (
        <p className="small">
          This plan is for {linked ? <Link to={`/decks/${linked.id}`}>{linked.name}</Link> : "a deck that's archived or no longer yours"}.{" "}
          <button className="quiet small" onClick={() => link.mutate(null)} disabled={link.isPending}>Unlink</button>
        </p>
      ) : (
        <p className="dim small">Link a deck to see its game results here.</p>
      )}
      {open ? (
        <div className="row">
          <select defaultValue="" onChange={(e) => e.target.value && link.mutate(e.target.value)} aria-label="Your Yama deck" style={{ flex: "1 1 14rem" }}>
            <option value="" disabled>
              {decks.isPending ? "Loading your decks…" : "Pick a deck"}
            </option>
            {decks.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.folder ? ` (${d.folder})` : ""}
              </option>
            ))}
          </select>
          <button className="quiet" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      ) : (
        <div className="row">
          <button onClick={() => setOpen(true)}>{deck.deck_id ? "Link another deck" : "Link a Yama deck"}</button>
        </div>
      )}
      <ErrorText error={link.error ?? decks.error} />
    </section>
  );
}

// ── Ideas for the planner ───────────────────────────────────────────────────

/**
 * "Suggest a change": an imported plan can't be edited here (its export owns it), so an idea goes
 * to the planner's inbox as an `idea` op, with what the planner later did with it.
 */
export function Ideas({ deck, view }: { deck: PlanDeck; view: PlanView }) {
  const userId = useMe().data?.id;
  const box = useOutbox(userId);
  const [open, setOpen] = useState(false);
  const [inn, setInn] = useState("");
  const [out, setOut] = useState("");
  const [why, setWhy] = useState("");
  const [saved, setSaved] = useState(false);
  const sent = view.b.inputs.ideas.filter((i) => i.deck_key === deck.key);
  const local = [...box.sent.map((x) => x.op), ...box.pending].filter((op): op is IdeaOp => op.kind === "idea" && op.deck_key === deck.key && !sent.some((i) => i.op_id === op.op_id));
  const pendingIds = new Set(box.pending.map((op) => op.op_id));
  const submit = () => {
    if (!userId || !inn.trim()) return;
    outbox.enqueue(userId, {
      kind: "idea", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), deck_key: deck.key,
      in: inn.trim(), out: out.trim() || null, why: why.trim() || null,
    });
    setInn("");
    setOut("");
    setWhy("");
    setOpen(false);
    setSaved(true);
  };
  return (
    <section className="plan-link stack">
      <h3>Ideas for your planner</h3>
      <p className="dim small">
        {deck.source === "import"
          ? `Suggestions go to your ${view.app} inbox; they don't edit the plan.`
          : "Suggest a change to come back to."}
      </p>
      {(sent.length > 0 || local.length > 0) && (
        <ul className="small">
          {local.map((i) => (
            <li key={i.op_id}>
              {i.in}
              {i.out ? ` for ${i.out}` : ""}
              {i.why ? `: ${i.why}` : ""} <span className="faint">{pendingIds.has(i.op_id) ? "Saved on this phone, waiting to sync." : "Saved in Yama."}</span>
            </li>
          ))}
          {sent.map((i) => (
            <li key={i.op_id}>
              {i.in}
              {i.out ? ` for ${i.out}` : ""}
              {i.why ? `: ${i.why}` : ""}{" "}
              <span className="faint">
                {fmtDate(i.at)}.{" "}
                {i.outcome ? `${i.outcome}.` : i.seq <= (view.b.inputs.pulled_through ?? 0) ? `Picked up by ${view.app}.` : `Waiting for ${view.app} to pick it up.`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {saved && !open && <p className="small" role="status">Saved. It goes to your planner's inbox.</p>}
      {open ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label>
            Card to put in
            <input value={inn} onChange={(e) => setInn(e.target.value)} required maxLength={200} />
          </label>
          <label>
            Card to take out (optional)
            <input value={out} onChange={(e) => setOut(e.target.value)} maxLength={200} />
          </label>
          <label>
            Why (optional)
            <textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={2000} />
          </label>
          <div className="row">
            <button className="primary" disabled={!inn.trim()}>Send to the inbox</button>
            <button type="button" className="quiet" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="row">
          <button onClick={() => { setSaved(false); setOpen(true); }} disabled={!userId}>Suggest a change</button>
        </div>
      )}
    </section>
  );
}
