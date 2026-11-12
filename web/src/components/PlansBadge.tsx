import { useMemo } from "react";
import { useMe } from "../auth";
import { outbox, useOutbox } from "../plan/outbox";
import { usePlan } from "../plan/store";
import { planView } from "../plan/view";

/** Plans and new plan versions waiting for your OK. */
function useToReview(): number {
  const userId = useMe().data?.id;
  const plan = usePlan(userId);
  const box = useOutbox(userId);
  return useMemo(() => {
    if (!plan.bundle || !userId) return 0;
    const view = planView(plan.bundle, outbox.localOps(userId));
    return view.b.decks.filter((d) => {
      const p = view.planOf(d);
      return p.next != null && p.state !== "archived";
    }).length;
    // `box` changes when a tap lands in the outbox, so the count follows decisions made here.
  }, [plan.bundle, box, userId]);
}

/** The count beside Plans in the Workshop's strip: a small warn pill, nothing at zero. */
export default function PlansBadge() {
  const toReview = useToReview();
  if (toReview <= 0) return null;
  return (
    <span className="tab-sections-badge num">
      <span className="visually-hidden">, </span>
      {toReview}
      <span className="visually-hidden"> waiting for your OK</span>
    </span>
  );
}
