import { fmtDate, type PlanHead } from "@yama/core/plan";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, type ReactNode } from "react";
import { Outlet, useMatch, useOutletContext } from "react-router";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { AreaHead, SubNav } from "../components/DeckTabs";
import { outbox, useOutbox } from "./outbox";
import { usePlan } from "./store";
import { planView, type PlanView } from "./view";
import "./plan.css";

export interface PlanOutlet {
  view: PlanView;
  userId: string;
  /** The no-connection banner, for a page that places it itself (a plan deck's, under its art). */
  banner?: ReactNode;
}

export function usePlanOutlet(): PlanOutlet {
  return useOutletContext<PlanOutlet>();
}

/** The Plans pages, in order. */
const PLAN_PAGES: { to: string; label: string; end?: boolean }[] = [
  { to: "/decks/plan", label: "Overview", end: true },
  { to: "/decks/plan/review", label: "Review" },
  { to: "/decks/plan/buy", label: "Buy" },
  { to: "/decks/plan/prints", label: "Prints" },
  { to: "/decks/plan/spares", label: "Spares" },
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

  // A plan deck's page opens on full-bleed commander art, like a deck's page.
  const deckPage = !!useMatch("/decks/plan/d/:key");
  const banner = plan.offline && (
    <p className="plan-banner small" role="status">
      No connection. This is the copy of your plans saved on this device{plan.bundle?.head ? `, imported ${fmtDate(plan.bundle.head.imported_at)}` : ""}.
      {box.pending.length ? ` Your answers are saved on this phone and go to Yama when you're back online.` : ""}
    </p>
  );
  return (
    <main className={deckPage && view ? "plan plan-deck-page" : "page plan"}>
      {!deckPage && banner}
      {!view && (
        <>
          <PlansHead title="Plans" index />
          {plan.pending && <p className="dim">Loading your plans…</p>}
          <ErrorText error={plan.error} />
        </>
      )}
      {view && userId && <Outlet context={{ view, userId, banner: deckPage ? banner : null } satisfies PlanOutlet} />}
    </main>
  );
}

/**
 * The head of a Plans page: its title, Decks | Plans | Lab, and the Plans pages under it (once
 * there are plans). Pages other than the overview get a back button to it on phones.
 */
export function PlansHead({ title, index = false, action, status }: { title: ReactNode; index?: boolean; action?: ReactNode; status?: ReactNode }) {
  const { view } = useOutletContext<PlanOutlet | undefined>() ?? {};
  const hasPlans = !!view && view.b.decks.length > 0;
  return (
    <AreaHead
      title={title}
      index={index}
      back={{ to: "/decks/plan", label: "Back to plans" }}
      action={action}
      status={status}
      nav={hasPlans ? <SubNav label="Plans pages" pages={PLAN_PAGES} /> : undefined}
    />
  );
}

/** "a1b2c3d4e5f6": the first 12 digits of a content hash, as pages show it. */
export const shortHash = (h: string | null | undefined) => (h ? h.slice(0, 12) : "");

/**
 * Which file an imported plan came from: guide version, content hash and commit, as one sentence
 * for a page's Details disclosure (visible copy says only where it was planned and when).
 */
export function headDetails(head: PlanHead): string {
  const parts: string[] = [];
  if (head.guide_version != null) parts.push(`Guide v${head.guide_version}${head.guide_date ? ` of ${fmtDate(head.guide_date)}` : ""}`);
  parts.push(`plan ${shortHash(head.content_hash)}`);
  if (head.git_sha) parts.push(`commit ${head.git_sha.slice(0, 7)}${head.dirty ? " with uncommitted changes" : ""}`);
  const text = parts.join(", ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}
