// The deck page's Plan tab, /decks/:id/plan (deck page SPEC, section 0; boards Deck and PhoneDeck,
// Plan state): the plan in progress with what's left as card pairs, then the plans waiting for your
// OK, the ideas you sent for it that are still open (only when there are some: Yama doesn't find
// gaps by itself yet), then one line to the earlier ones.

import { PLAN_STATE_LABEL, STEP_LABEL, type IdeaOp } from "@yama/core/plan";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link } from "react-router";
import { useMe } from "../auth";
import { ErrorText, Loading, EmptyState } from "../components/ui";
import { outbox, useOutbox } from "../plan/outbox";
import { planHref } from "../plan/href";
import { SwapPair } from "../plan/parts";
import { usePlan } from "../plan/store";
import { planView, type PlanView } from "../plan/view";
import { planSummaries, planSummariesKey } from "../research/view";
import { deckPlanHub, type DeckPlanHub } from "./deckPlanHub";
import "../plan/plans.css";
import "./deckTabs.css";

/** Changes shown under Left to do before "[n] more". */
const LEFT_SHOWN = 3;

const changesWord = (n: number) => (n === 1 ? "1 change" : `${n} changes`);

export function DeckPlanTab({ deckId, deckName }: { deckId: string; deckName: string }) {
  const userId = useMe().data?.id;
  const data = usePlan(userId);
  const box = useOutbox(userId);
  const notes = useQuery({ queryKey: planSummariesKey(userId), queryFn: planSummaries, enabled: !!userId });
  const view = useMemo(
    () => (data.bundle && userId ? planView(data.bundle, outbox.localOps(userId)) : null),
    // `box` moves when a tap lands in the outbox, so the counts follow answers made on this device.
    [data.bundle, box, userId],
  );
  const local = useMemo(() => [...box.sent.map((x) => x.op), ...box.pending].filter((op): op is IdeaOp => op.kind === "idea"), [box]);
  const hub = useMemo(() => (view ? deckPlanHub(view, deckId, notes.data, deckName, local) : null), [view, deckId, notes.data, deckName, local]);

  if (!hub) {
    if (data.error) return <ErrorText error={data.error} />;
    return data.pending ? <Loading>Loading the plan…</Loading> : <NoPlan />;
  }
  const { current, upNext, ideas, earlier } = hub;
  return (
    <div className="deck-plan-tab">
      {current ? <CurrentPlan current={current} view={view!} /> : !upNext.length && <NoPlan />}

      {upNext.length > 0 && (
        <section className="deck-tab-section" aria-labelledby="deck-plan-next">
          <h2 id="deck-plan-next">Up next</h2>
          <div className="deck-tab-rows">
            {upNext.map((u) => (
              <div key={`${u.deck.key}/${u.plan.next?.n}`} className="deck-tab-row">
                <span className="deck-tab-row-main">
                  <b>{u.label}</b>
                  <span className="tag warn">{PLAN_STATE_LABEL.waiting}</span>
                  <span className="dim">{changesWord(u.changes)}</span>
                </span>
                <Link className="button" to={`${planHref(u.deck.key)}${u.hash}`}>
                  Review
                </Link>
              </div>
            ))}
          </div>
        </section>
      )}

      {ideas.length > 0 && (
        <section className="deck-tab-section" aria-labelledby="deck-plan-ideas">
          <h2 id="deck-plan-ideas">Ideas</h2>
          <ul className="plans-rows">
            {ideas.map((i) => (
              <li key={i.op_id} className="plans-row">
                <SwapPair cardIn={i.in} cardOut={i.out} view={view!} />
                <span className="plans-row-main">
                  <span>
                    <b>{i.in}</b> {i.out && <span className="dim">replaces {i.out}</span>}
                  </span>
                  <span className="small dim">{i.seq <= (view!.b.inputs.pulled_through ?? 0) ? `Picked up by ${view!.app}` : `Waiting for ${view!.app}`}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {earlier > 0 && (
        <Link className="deck-plan-earlier" to="/decks/plans/archived">
          Earlier: {earlier === 1 ? "1 archived plan" : `${earlier} archived plans`}
        </Link>
      )}
    </div>
  );
}

function NoPlan() {
  return (
    <section aria-label="Plan">
      <EmptyState title="No plan for this deck" action={<Link to="/decks/plans">How plans work</Link>} />
    </section>
  );
}

function CurrentPlan({ current, view }: { current: NonNullable<DeckPlanHub["current"]>; view: PlanView }) {
  const { deck, plan, steps, installed, next } = current;
  const total = steps.length;
  const left = steps.filter((s) => s.step !== "in");
  const shown = left.slice(0, LEFT_SHOWN);
  const pct = total ? Math.round((installed / total) * 100) : 0;
  return (
    <section className="deck-plan-current" aria-labelledby="deck-plan-current">
      <div className="deck-plan-head">
        <span className="deck-plan-title">
          <h2 id="deck-plan-current">Current plan</h2>
          <span className="tag good">{PLAN_STATE_LABEL[plan.state]}</span>
        </span>
        <Link className="button" to={planHref(deck.key)}>
          Open the plan
        </Link>
      </div>
      <div className="deck-plan-count">
        <span>
          <b className="num">
            {installed} of {total}
          </b>{" "}
          in
        </span>
        <span className="plans-bar big" role="img" aria-label={`${installed} of ${total} changes in`}>
          <span style={{ width: `${pct}%` }} />
        </span>
      </div>
      {next && (
        <span>
          <b>Next:</b> {next}
        </span>
      )}
      {left.length > 0 && (
        <div className="deck-plan-left">
          <h3>Left to do</h3>
          <ul className="plans-rows">
            {shown.map(({ swap: s, step, out }) => (
              <li key={s.key} className="plans-row">
                <SwapPair cardIn={s.in} cardOut={out} view={view} />
                <span className="plans-row-main">
                  <span>
                    <b>{s.in}</b> {out && <span className="dim">replaces {out}</span>}
                  </span>
                  <span className="small dim">{STEP_LABEL[step]}</span>
                </span>
              </li>
            ))}
            {left.length > shown.length && (
              <li className="plans-row">
                <Link to={`${planHref(deck.key)}#left-to-do`}>{left.length - shown.length} more</Link>
              </li>
            )}
          </ul>
        </div>
      )}
    </section>
  );
}
