import {
  answerState,
  isAnswer,
  opTime,
  reviewItems,
  reviewRecord,
  toggleDecision,
  fmtDate,
  type Decision,
  type PlanDeck,
  type Review as Answer,
  type ReviewRecord,
  type Swap,
} from "@yama/core/plan";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { artCredits } from "../components/ArtPanel";
import { Crop } from "../components/Crop";
import { ErrorText } from "../components/ui";
import { deckGroups, trackedNote } from "../research/PlanTiles";
import { deckHref, planSummaries, planSummariesKey } from "../research/view";
import { deviceId, outbox, useOutbox, useOutboxState } from "./outbox";
import { AskClaude } from "../advisor/AskClaude";
import { PlansHead, usePlanOutlet } from "./PlanLayout";
import { ReviewHowTo } from "./howto";
import type { PlanView } from "./view";

const DECISIONS: Decision[] = ["want", "unsure", "no"];
const DECISION_WORD: Record<Decision, string> = { want: "Want", unsure: "Unsure", no: "Don't want" };

/** Queue a full answer for a swap key. The page shows it at once; the outbox sends it. */
function sendAnswer(userId: string, swapKey: string, deckKey: string | null, current: Answer | undefined, change: Partial<ReviewRecord>) {
  const record = reviewRecord(current, change);
  outbox.enqueue(userId, { kind: "review", op_id: crypto.randomUUID(), device_id: deviceId(), at: opTime(), swap_key: swapKey, deck_key: deckKey, ...record });
}

/** What an answer does, in one sentence at the top of Review (Bryan, 2026-10-28: "I just don't know what the point of reviewing is"). */
export const ANSWER_MEANING =
  "Answer each proposed change: Want means your assistant moves it into your plan; Unsure and Don't want keep it out, and your assistant reads your note.";

/** The to-do line under it: how many proposals for tracked decks wait for an answer, the count
 *  the Plans tab shows. */
export function toAnswerLine(decks: { open: number }[]): string {
  const open = decks.reduce((n, d) => n + d.open, 0);
  const with_ = decks.filter((d) => d.open > 0).length;
  if (!open) return "No proposals for your tracked decks are waiting for your answer.";
  return `${open === 1 ? "1 proposal is" : `${open} proposals are`} waiting for your answer${with_ > 1 ? `, in ${with_} decks` : ""}.`;
}

/** One plan for a deck with changes to answer, and where you answer them. */
interface ToAnswer {
  key: string;
  label: string;
  open: number;
  to: string;
}

/**
 * `/decks/plan/review`: what's waiting for your answer, deck by deck. You answer on the deck's
 * plan page, beside each change, the way a plan's page always has (Bryan, 2026-11-05: "I like
 * the review thing you built into the deck plan. That's better."), so this page is the list of
 * where answers are waiting, not a second place to give them.
 */
export function Review() {
  const { view, userId } = usePlanOutlet();
  const notes = useQuery({ queryKey: planSummariesKey(userId), queryFn: planSummaries, enabled: !!userId });
  const proposals = useMemo(() => new Map(reviewItems(view.b, view.answers).map((d) => [d.deck.key, d.sections.open])), [view]);
  // Two lists, deck by deck: proposals for decks you track (what the Plans tab's count counts),
  // then the changes in your plans you haven't answered, which wait as long as you like.
  const { tracked, planned } = useMemo(() => {
    const tracked: Row[] = [];
    const planned: Row[] = [];
    for (const g of deckGroups(notes.data ?? [], view.b.decks)) {
      const shown = trackedNote(g) ?? g.tracked[0];
      const art = shown ? { image: view.art(shown), artist: view.card(shown.commander[0])?.artist } : { image: g.notes[0]?.plan.art?.image, artist: g.notes[0]?.plan.art?.artist };
      const fromPlanFile: ToAnswer[] = g.tracked
        .filter((d) => (proposals.get(d.key) ?? 0) > 0)
        .map((d) => ({ key: `p:${d.key}`, label: d.note ? "Proposed for your tracked plan" : "Your plan file", open: proposals.get(d.key)!, to: `/decks/plan/d/${encodeURIComponent(d.key)}#proposed` }));
      const fromNotes: ToAnswer[] = g.notes
        .filter(({ plan }) => plan.to_answer > 0)
        .map(({ note, plan }) => ({ key: `n:${note.id}`, label: note.title, open: plan.to_answer, to: `${deckHref(note.id, plan.key)}#changes-head` }));
      if (fromPlanFile.length) tracked.push({ id: g.id, name: g.name, art, plans: fromPlanFile, open: fromPlanFile.reduce((n, p) => n + p.open, 0) });
      if (fromNotes.length) planned.push({ id: g.id, name: g.name, art, plans: fromNotes, open: fromNotes.reduce((n, p) => n + p.open, 0) });
    }
    return { tracked, planned };
  }, [notes.data, view, proposals]);
  const shown = [...tracked, ...planned];

  return (
    <>
      <PlansHead title="Review" status={<SyncStatus view={view} userId={userId} />} action={<AskClaude context={{ kind: "review" }} about="your proposals" />} />
      <ReviewHowTo open={!shown.length} />
      <p className="review-lede">{ANSWER_MEANING}</p>
      <p className="small dim review-todo" role="status">{toAnswerLine(tracked)}</p>
      <SyncLine view={view} userId={userId} />
      {tracked.length > 0 && (
        <section className="plan-section" aria-labelledby="review-tracked">
          <h2 id="review-tracked" className="plan-section-head">Proposed for decks you track</h2>
          <DeckRows rows={tracked} urgent />
        </section>
      )}
      <section className="plan-section" aria-labelledby="review-plans">
        <h2 id="review-plans" className="plan-section-head">In your plans</h2>
        <p className="small dim plan-tracked-about">
          Changes your assistant suggested in the plans it saved that you haven't answered. Answer the ones you care about, the build you'd make first; the rest can wait.
        </p>
        <ErrorText error={notes.error} />
        {!notes.data && !notes.error && <p className="dim">Counting what's waiting…</p>}
        {notes.data && (planned.length ? <DeckRows rows={planned} /> : <p className="dim">{notes.data.length ? "You've answered every change in the builds you'd make." : "No plans yet."}</p>)}
      </section>
      {shown.some((r) => r.art.image) && <p className="small dim review-credit">{artCredits([...new Map(shown.map((r) => [r.id, r])).values()].map((r) => (r.art.image ? r.art.artist : null)))}</p>}
      <Orphans view={view} userId={userId} />
    </>
  );
}

interface Row {
  id: string;
  name: string;
  art: { image: string | null | undefined; artist: string | null | undefined };
  plans: ToAnswer[];
  open: number;
}

/** Each deck with answers waiting, and a line per plan that has them, to its page. `urgent`
 *  counts are the tracked decks' proposals; a plan's changes can wait, so theirs are quiet. */
function DeckRows({ rows, urgent = false }: { rows: Row[]; urgent?: boolean }) {
  return (
    <ul className="review-list">
      {rows.map((r) => (
        <li key={r.id} className="review-list-deck">
          <Crop src={r.art.image} size="sm" />
          <span className="review-list-body">
            <b className="review-list-name">{r.name}</b>
            {r.plans.map((p) => (
              <Link key={p.key} to={p.to} className="review-list-plan">
                <span>{p.label}</span>
                <span className={`pill num${urgent ? " warn" : " quiet"}`}>{p.open} to answer</span>
              </Link>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A proposal's answer beside it on a tracked deck's page, as a plan's changes take theirs: Want,
 * Unsure or Don't want, a cut instead of the proposed one, and a note for your assistant. Saved on
 * this device first (the outbox), then in Yama.
 */
export function PlanAnswer({ swap, deck, view, userId }: { swap: Swap; deck: PlanDeck; view: PlanView; userId: string }) {
  const a = view.answers.get(swap.key);
  const [note, setNote] = useState(a?.note ?? "");
  const send = (change: Partial<ReviewRecord>) => sendAnswer(userId, swap.key, swap.deck, a, change);
  const state = answerState(a, { source: deck.source, pulledThrough: view.b.inputs.pulled_through ?? 0, app: view.app });
  const where =
    deck.source === "import"
      ? `Saved in Yama with your answer, only for you. ${view.app} picks it up with your answers, and your assistant reads it through Yama's tools.`
      : "Saved in Yama with your answer, only for you; your assistant reads it through Yama's tools the next time it works on this plan.";
  return (
    <div className="research-review is-compact plan-answer">
      <div className="research-review-actions" role="group" aria-label={`Your answer for ${swap.in}`}>
        {DECISIONS.map((d) => (
          <button
            key={d}
            type="button"
            className={`small ${a?.decision === d ? "primary" : "outline"}`}
            aria-pressed={a?.decision === d}
            onClick={() => send({ decision: toggleDecision(a?.decision, d) })}
          >
            {DECISION_WORD[d]}
          </button>
        ))}
        <span className="small dim" role="status">
          {state ? `${state.label}${a?.origin === "import" && a.at ? `, ${fmtDate(a.at)}` : ""}` : "No answer yet"}
        </span>
      </div>
      {a?.decision === "no" && swap.stage === "planned" && <p className="small">You said no. Nothing changes until you and your planner decide what to do with this swap.</p>}
      <details className="research-note-fold" open={!!a?.note || !!a?.cut}>
        <summary className="small">{a?.note ? "Your note for your assistant" : swap.stage === "proposed" ? "Add a note, or cut something else" : "Add a note for your assistant"}</summary>
        {swap.stage === "proposed" && <CutPicker deck={deck} suggested={swap.out} value={a?.cut ?? null} onPick={(cut) => send({ cut })} />}
        <label className="research-note">
          <span className="visually-hidden">Your note for {swap.in}</span>
          <textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="row research-note-save">
          <button type="button" className="outline small" disabled={note.trim() === (a?.note ?? "").trim()} onClick={() => send({ note: note.trim() || null })}>
            Save note
          </button>
          <span className="small dim">{where}</span>
        </div>
      </details>
    </div>
  );
}

/** Where this phone's answers are, in one line with a dot: waiting here, in Yama, or picked up. */
function SyncStatus({ view, userId }: { view: PlanView; userId: string }) {
  const box = useOutbox(userId);
  const { pending_pull, pulled_at } = view.b.inputs;
  const n = box.pending.length;
  const [tone, text] =
    n > 0
      ? ["warn", "Saved on this phone, waiting to sync"]
      : pending_pull > 0
        ? ["plain", `${pending_pull} waiting for ${view.app} to pick up`]
        : pulled_at
          ? ["good", `Picked up by ${view.app}, ${fmtDate(pulled_at)}`]
          : [null, null];
  if (!text) return null;
  return (
    <span className={`review-status ${tone}`} role="status">
      {text}
    </span>
  );
}

/** The details behind the status: answers to send now, and any Yama refused. */
function SyncLine({ view, userId }: { view: PlanView; userId: string }) {
  const box = useOutbox(userId);
  const state = useOutboxState();
  const { pending_pull, pulled_at } = view.b.inputs;
  const n = box.pending.length;
  if (!n && !box.rejected.length && !pending_pull && !pulled_at) return null;
  return (
    <div className="plan-sync small" role="status">
      {n > 0 && (
        <p>
          <span className="tag warn">{n === 1 ? "1 answer" : `${n} answers`} on this phone</span> waiting to sync
          {state.error ? `. Yama can't be reached (${state.error}); they go when you're back online.` : "."}{" "}
          <button className="quiet small" onClick={() => void outbox.sync(userId)} disabled={state.syncing}>
            {state.syncing ? "Sending…" : "Send now"}
          </button>
        </p>
      )}
      {pending_pull > 0 && (
        <p className="dim">
          {pending_pull === 1 ? "1 thing you did here is" : `${pending_pull} things you did here are`} waiting for {view.app} to pick {pending_pull === 1 ? "it" : "them"} up.
        </p>
      )}
      {pulled_at && <p className="faint">{view.app} last picked up your answers {fmtDate(pulled_at)}.</p>}
      {box.rejected.map((r) => (
        <p key={r.op.op_id}>
          <span className="tag bad">Not saved</span> Yama refused an answer{"swap_key" in r.op ? ` for ${r.op.swap_key.split("|").slice(2, 3).join("") || r.op.swap_key}` : ""}: {r.error}{" "}
          <button className="quiet small" onClick={() => outbox.dismiss(userId, r.op.op_id)}>Dismiss</button>
        </p>
      ))}
    </div>
  );
}


/** Pick what a proposal takes out, from the after-prints list. Empty means its suggested cut. */
function CutPicker({ deck, suggested, value, onPick }: { deck: PlanDeck; suggested: string | null; value: string | null; onPick: (cut: string | null) => void }) {
  const names = useMemo(
    () => [...new Set((deck.states.after?.cards ?? []).filter((c) => c.board === "main").map((c) => c.name))].sort((x, y) => x.localeCompare(y)),
    [deck],
  );
  return (
    <label className="review-field">
      Cut something else
      <select value={value ?? ""} onChange={(e) => onPick(e.target.value || null)}>
        <option value="">{suggested ? `${suggested} (proposed)` : "Pick a cut"}</option>
        {names
          .filter((n) => n !== suggested)
          .map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
      </select>
    </label>
  );
}


/** Answers whose swap left the plan (renamed with no alias, or removed). Kept, never dropped. */
function Orphans({ view, userId }: { view: PlanView; userId: string }) {
  const live = view.orphans.filter(([, r]) => isAnswer(r));
  if (!live.length) return null;
  return (
    <section className="plan-orphans stack">
      <h3>
        Answers for swaps no longer in the plan <span className="dim num">{live.length}</span>
      </h3>
      <p className="dim small">Previous answers, kept for your planner.</p>
      <div className="list">
        {live.map(([key, r]) => (
          <div key={key} className="list-row">
            <span>
              <span className="title">{r.card ?? key.split("|")[2] ?? key}</span>
              <br />
              <span className="small dim">
                {r.deck ?? key.split("|")[1] ?? ""}
                {r.decision ? `. ${DECISION_WORD[r.decision]}` : ""}
                {r.cut ? `. Cut: ${r.cut}` : ""}
                {r.note ? `. ${r.note}` : ""}
              </span>
            </span>
            <button className="quiet small" onClick={() => sendAnswer(userId, key, null, r, { decision: null, note: null, cut: null })}>
              Clear
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
