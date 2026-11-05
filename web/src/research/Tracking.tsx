import { fmtDate, installedState, localBuyRule, rulesAt, type PlanDeck, type RuleSet, type Swap } from "@yama/core/plan";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api, ApiError } from "../api";
import { useMe } from "../auth";
import { ErrorText } from "../components/ui";
import { outbox, useOutbox } from "../plan/outbox";
import { usePlan } from "../plan/store";
import { planView } from "../plan/view";
import type { Build, ResearchBundle, ResearchDeck } from "./api";

/**
 * Tracking a plan's build: the plan stays the note, its face; tracking makes one build the deck's
 * plan in the planner (server/src/plan/notes.rs), which is what Buy, Trip, Prints, installed ticks
 * and the assistant's plan tools work from. People see "Track this build", never the planner.
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

/** "Track this build", or what's tracked now with Switch and Stop. Owner only. */
export function TrackPanel({ bundle, deck, build }: { bundle: ResearchBundle; deck: ResearchDeck; build: Build }) {
  const qc = useQueryClient();
  const userId = useMe().data?.id;
  const { ready, error: planError, deck: tracked } = useTracked(bundle.document.id, deck.key);
  const [result, setResult] = useState<Tracked | null>(null);
  // Returned, so the button stays busy until the refreshed plans say what's tracked now.
  const refresh = () => qc.invalidateQueries({ queryKey: ["plan", userId] });
  const track = useMutation({
    mutationFn: () =>
      api<Tracked>("/api/plan/from-note", {
        method: "POST",
        json: { note_id: bundle.document.id, deck_key: deck.key, build_id: build.id, op_id: crypto.randomUUID(), expected_note_hash: bundle.content_hash ?? undefined },
      }),
    onSuccess: (r) => {
      setResult(r);
      return refresh();
    },
  });
  const stop = useMutation({
    mutationFn: (key: string) => api<{ plan_deck_key: string }>(`/api/plan/from-note/${encodeURIComponent(key)}`, { method: "DELETE" }),
    onSuccess: () => {
      setResult(null);
      return refresh();
    },
  });
  const busy = track.isPending || stop.isPending;
  if (!ready) {
    return (
      <section className="note-track" aria-label="Track this build">
        {planError ? <ErrorText error={planError} /> : <p className="dim" role="status">Checking what you track…</p>}
      </section>
    );
  }
  const active = tracked && tracked.status !== "archived";
  const thisBuild = active && tracked.note?.build === build.id;
  const otherBuild = active && !thisBuild ? deck.builds.find((b) => b.id === tracked.note?.build) : null;
  const error = track.error ?? stop.error;
  return (
    <section className="note-track" aria-label="Track this build">
      {thisBuild ? (
        <>
          <p>
            <b>You're tracking this build</b> as your {tracked.name} plan. Its cards to buy are on your <Link to="/decks/plan/buy">buy list</Link> and{" "}
            <Link to="/decks/plan/trip">store trip</Link>, prints on <Link to="/decks/plan/prints">Prints</Link>, and each change below shows where its card is.
          </p>
          <div className="row">
            <Link className="button primary" to={`/decks/plan/d/${encodeURIComponent(tracked.key)}`}>Open the tracked plan</Link>
            <button type="button" className="quiet" disabled={busy} onClick={() => confirm(`Stop tracking ${tracked.name}? It leaves your buy list and prints; your answers and ticks are kept if you track it again.`) && stop.mutate(tracked.key)}>
              Stop tracking
            </button>
          </div>
        </>
      ) : otherBuild ? (
        <>
          <p>
            <b>You're tracking {otherBuild.label}</b> for this deck. Switching makes this build the plan instead. Your ticks and bought marks on {otherBuild.label} are kept and come back if you switch back.
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => track.mutate()}>
              {track.isPending ? "Switching…" : "Switch to this build"}
            </button>
            <Link className="button outline" to={`/decks/plan/d/${encodeURIComponent(tracked!.key)}`}>Open the tracked plan</Link>
          </div>
        </>
      ) : (
        <>
          <p>
            <b>Ready to make this build?</b> Track it: its cards to buy go on your buy list and store trip, its prints on Prints, and you tick each change as it goes into the deck.
            You can switch builds or stop at any time, and the plan itself doesn't change.
            {tracked && tracked.status === "archived" ? " You tracked this deck before; your ticks and bought marks on a build come back when you track it again." : ""}
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => track.mutate()}>
              {track.isPending ? "Tracking…" : "Track this build"}
            </button>
          </div>
        </>
      )}
      {result && result.warnings.length > 0 && (
        <ul className="small warn note-track-warnings" aria-label="Check these">
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {result && !result.deck_id && <p className="small dim">No Yama deck has this deck's name, so ticks come from you; link a deck from the tracked plan's page to read them from the deck.</p>}
      {conflictText(error) ? <p className="small warn" role="alert">{conflictText(error)}</p> : <ErrorText error={error} />}
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
    return { upto: dollars, text: `Starting at your shopping rule from ${fmtDate(found.from)}: buy cards up to $${dollars}.` };
  }, [plan.bundle]);
}
