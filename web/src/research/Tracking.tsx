import { planHref } from "../plan/href";
import { installedState, localBuyRule, rulesAt, type PlanDeck, type RuleSet, type Swap } from "@yama/core/plan";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError } from "../api";
import { useMe } from "../auth";
import { Button, ButtonLink, ErrorText, Loading } from "../components/ui";
import { outbox, useOutbox } from "../plan/outbox";
import { usePlan } from "../plan/store";
import { planView } from "../plan/view";
import type { Build, ResearchBundle, ResearchDeck } from "./api";
import { fmtDate, usd } from "@yama/core";

/**
 * A note's build as a deck's plan (server/src/plan/notes.rs): using it makes the build a plan
 * version waiting for your OK, which, once approved, is what Get the cards, installed ticks and
 * the assistant's plan tools work from. People never see "track" or "planner".
 */

export interface Tracked {
  plan_deck_key: string;
  name: string;
  build_id: string;
  build_label: string;
  deck_id: string | null;
  swaps: number;
  warnings: string[];
  link: string;
}

/** The plan deck tracking this note's deck, if any (stopped ones too), from the plan bundle. */
export function useTracked(
  noteId: string,
  deckKey: string,
): { ready: boolean; error: unknown; deck: PlanDeck | null; swaps: Swap[]; status: (s: Swap) => string | null } {
  const userId = useMe().data?.id;
  const plan = usePlan(userId);
  const box = useOutbox(userId);
  return useMemo(() => {
    const b = plan.bundle;
    // Until the plans are here, nobody can say what's tracked: nothing may be tracked or switched.
    const ready = !!b;
    const deck = b?.decks.find((d) => d.note?.id === noteId && d.note.deck === deckKey) ?? null;
    if (!b || !deck || !userId) return { ready, error: plan.error, deck, swaps: [], status: () => null };
    const view = planView(b, outbox.localOps(userId));
    const swaps = view.swapsOf(deck.key);
    // Where a tracked swap's card is: in the deck, bought, or still to get.
    const status = (s: Swap) => {
      const marks = view.markBy.get(s.key);
      if (installedState(s, marks?.installed).on) return "In the deck";
      if (marks?.bought?.value) return "Bought";
      return s.src === "owned" ? "Yours, to put in" : s.src === "print" ? "To print" : "To buy";
    };
    return { ready, error: plan.error, deck, swaps, status };
    // `box` changes when a tap lands in the outbox, so ticks made here show at once.
  }, [plan.bundle, plan.error, box, userId, noteId, deckKey]);
}

/** The swaps a tracked build made for one of its swaps: one per copy (`id`, `id#2`, …). */
export function trackedSwaps(swaps: Swap[], noteId: string, deckKey: string, buildId: string, swapId: string): Swap[] {
  const key = `n|${noteId}|${deckKey}|${buildId}|${swapId}`;
  return swaps.filter((s) => !s.retired && (s.key === key || s.key.startsWith(`${key}#`)));
}

function conflictText(e: unknown): string | null {
  return e instanceof ApiError && e.status === 409 ? "This plan changed since the page loaded. Reload the page to see the new version, then try again." : null;
}

/**
 * A note is an archived plan (Bryan, 2026-11-06: one plan per deck): kept for reference, never a
 * current plan. "Use a deck from it" makes this build that deck's next plan version, waiting for
 * your OK on Plans (`POST /api/plan/from-note` with `proposed`). Owner only.
 */
export function TrackPanel({ bundle, deck, build }: { bundle: ResearchBundle; deck: ResearchDeck; build: Build }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const userId = useMe().data?.id;
  const { ready, error: planError, deck: tracked } = useTracked(bundle.document.id, deck.key);
  const [result, setResult] = useState<Tracked | null>(null);
  // Returned, so the button stays busy until the refreshed plans say what's there now.
  const refresh = () => qc.invalidateQueries({ queryKey: ["plan", userId] });
  const use = useMutation({
    mutationFn: () =>
      api<Tracked>("/api/plan/from-note", {
        method: "POST",
        json: { note_id: bundle.document.id, deck_key: deck.key, build_id: build.id, op_id: crypto.randomUUID(), expected_note_hash: bundle.content_hash ?? undefined, proposed: true },
      }),
    onSuccess: async (r) => {
      setResult(r);
      await refresh();
      if (!r.warnings.length) navigate(planHref(r.plan_deck_key));
    },
  });
  if (!ready) {
    return (
      <section className="note-track" aria-label="Archived plan">
        {planError ? <ErrorText error={planError} /> : <Loading>Checking your plans…</Loading>}
      </section>
    );
  }
  const active = tracked && tracked.status !== "archived";
  const thisBuild = active && tracked.note?.build === build.id;
  return (
    <section className="note-track" aria-label="Archived plan">
      <p>
        <span className="tag plain">Archived</span> <b>{deck.name}: {build.label}</b>. This note is kept for reference. Nothing in it is on your shopping list.
      </p>
      {thisBuild ? (
        <div className="row">
          <span>This build is {tracked.name}'s plan now.</span>
          <ButtonLink variant="primary" to={planHref(tracked.key)}>Open the plan</ButtonLink>
        </div>
      ) : (
        <div className="row">
          <ButtonLink to="/decks/plans">Go to Plans</ButtonLink>
          <Button variant="primary" disabled={use.isPending} onClick={() => use.mutate()}>
            {use.isPending ? "Adding…" : "Use a deck from it"}
          </Button>
          <span className="small dim">Makes this build a new version of {deck.name}'s plan, waiting for your OK. Until you approve it, the plan you have keeps going.</span>
        </div>
      )}
      {result && result.warnings.length > 0 && (
        <>
          <ul className="small warn note-track-warnings" aria-label="Check these">
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <Link to={planHref(result.plan_deck_key)}>Open the plan waiting for your OK</Link>
        </>
      )}
      {conflictText(use.error) ? <p className="small warn" role="alert">{conflictText(use.error)}</p> : <ErrorText error={use.error} />}
    </section>
  );
}

/** Whether the plans have answered (or failed): a plan's shopping list waits for it, so its limit
 *  doesn't change under the page, and the answers being typed beside it, once it has loaded. */
export function usePlansSettled(): boolean {
  const userId = useMe().data?.id;
  return !usePlan(userId).pending;
}

/** The account's own buy limit (Plans, Settings, Shopping rules), when its rule in force names
 *  one: a plan's shopping list starts there instead of the shared pages' suggested $2. */
export function useBuyRule(): { upto: string; text: string } | null {
  const userId = useMe().data?.id;
  const plan = usePlan(userId);
  return useMemo(() => {
    const settings = (plan.bundle?.settings ?? []) as unknown as RuleSet[];
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const found = localBuyRule(rulesAt(settings, today));
    const max = found.rule?.max_usd;
    // Only a limit the shopping list can take (`uptoOf`: up to $1,000).
    if (max == null || !Number.isFinite(max) || max < 0 || max > 1000 || !found.from) return null;
    const dollars = max.toFixed(2);
    return { upto: dollars, text: `Starting at your shopping rule from ${fmtDate(found.from)}: buy cards up to ${usd(max)}.` };
  }, [plan.bundle]);
}
