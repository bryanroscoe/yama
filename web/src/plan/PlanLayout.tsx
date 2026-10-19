import { fmtDate, type PlanHead } from "@yama/core/plan";
import { useMemo } from "react";
import { Outlet, useOutletContext } from "react-router";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { DeckTabs } from "./DeckTabs";
import { usePlan } from "./store";
import { planView, type PlanView } from "./view";
import "./plan.css";

export interface PlanOutlet {
  view: PlanView;
}

export function usePlanOutlet(): PlanOutlet {
  return useOutletContext<PlanOutlet>();
}

/** The Plans section of the Decks tab: the segmented control, then the page, from one bundle. */
export function PlanLayout() {
  const me = useMe();
  const plan = usePlan(me.data?.id);
  const view = useMemo(() => (plan.bundle ? planView(plan.bundle) : null), [plan.bundle]);
  return (
    <main className="page plan">
      <DeckTabs />
      {plan.offline && (
        <p className="plan-banner small" role="status">
          No connection. This is the copy of your plans saved on this device{plan.bundle?.head ? `, imported ${fmtDate(plan.bundle.head.imported_at)}` : ""}.
        </p>
      )}
      {plan.pending && <p className="dim">Loading your plans…</p>}
      <ErrorText error={plan.error} />
      {view && <Outlet context={{ view } satisfies PlanOutlet} />}
    </main>
  );
}

/** "a1b2c3d4e5f6": the first 12 digits of a content hash, as pages show it. */
export const shortHash = (h: string | null | undefined) => (h ? h.slice(0, 12) : "");

/** The facts about where an imported plan came from, as one sentence. */
export function headSentence(head: PlanHead): string {
  const parts = [`Imported ${fmtDate(head.imported_at)}`];
  if (head.guide_version != null) parts.push(`guide v${head.guide_version}${head.guide_date ? ` of ${fmtDate(head.guide_date)}` : ""}`);
  parts.push(`plan ${shortHash(head.content_hash)}`);
  if (head.git_sha) parts.push(`commit ${head.git_sha.slice(0, 7)}${head.dirty ? " with uncommitted changes" : ""}`);
  return `${parts.join(", ")}.`;
}
