import { fmtDate, type PlanHead } from "@yama/core/plan";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { DeckTabs } from "./DeckTabs";
import { outbox, useOutbox } from "./outbox";
import { usePlan } from "./store";
import { planView, type PlanView } from "./view";
import "./plan.css";

export interface PlanOutlet {
  view: PlanView;
  userId: string;
}

export function usePlanOutlet(): PlanOutlet {
  return useOutletContext<PlanOutlet>();
}

/** The Plans pages, in order. Buy, Prints and Spares come in the next slice. */
const PLAN_PAGES: { to: string; label: string; end?: boolean }[] = [
  { to: "/decks/plan", label: "Overview", end: true },
  { to: "/decks/plan/review", label: "Review" },
  { to: "/decks/plan/settings", label: "Settings" },
];

/** After a sync, wait this long for more taps before fetching the bundle again. */
const REFRESH_AFTER_SYNC_MS = 8000;

/** The Plans section of the Decks tab: the segmented control, then the page, from one bundle. */
export function PlanLayout() {
  const me = useMe();
  const userId = me.data?.id;
  const qc = useQueryClient();
  const plan = usePlan(userId);
  const box = useOutbox(userId);
  const view = useMemo(() => (plan.bundle ? planView(plan.bundle, outbox.localOps(userId)) : null), [plan.bundle, box, userId]);

  // Sent taps stay on screen until a bundle that includes them arrives.
  const revision = plan.bundle?.revision;
  useEffect(() => {
    if (userId && revision != null) outbox.prune(userId, revision);
  }, [userId, revision]);

  // Refresh the bundle a little after taps reach the server (the overlay shows them meanwhile),
  // and send anything left from an earlier visit.
  useEffect(() => {
    if (!userId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = outbox.onSynced((u) => {
      if (u !== userId) return;
      clearTimeout(timer);
      timer = setTimeout(() => void qc.invalidateQueries({ queryKey: ["plan", userId] }), REFRESH_AFTER_SYNC_MS);
    });
    if (outbox.pendingCount(userId)) void outbox.sync(userId);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [userId, qc]);

  return (
    <main className="page plan">
      <DeckTabs />
      {view && view.b.decks.length > 0 && (
        <nav className="plan-subnav" aria-label="Plans pages">
          {PLAN_PAGES.map((p) => (
            <NavLink key={p.to} to={p.to} end={p.end}>
              {p.label}
            </NavLink>
          ))}
        </nav>
      )}
      {plan.offline && (
        <p className="plan-banner small" role="status">
          No connection. This is the copy of your plans saved on this device{plan.bundle?.head ? `, imported ${fmtDate(plan.bundle.head.imported_at)}` : ""}.
          {box.pending.length ? ` Your answers are saved on this phone and go to Yama when you're back online.` : ""}
        </p>
      )}
      {plan.pending && <p className="dim">Loading your plans…</p>}
      <ErrorText error={plan.error} />
      {view && userId && <Outlet context={{ view, userId } satisfies PlanOutlet} />}
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
