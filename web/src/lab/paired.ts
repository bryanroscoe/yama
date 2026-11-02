// Your paired batch runs, read for one plan deck: the commander-decks export names each list
// `<who>/<deck key>-<state>` ("bryan/riders-of-rohan-after"), so a plan deck finds its stock, now
// and after-prints results by key. These are RAW win rates (wins out of games played), not the
// rating model's; pages say so. No React here.

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { BatchComparison, BatchVariant, RunListItem } from "./api";
import { fmtDate } from "./logic";

export interface PlanVersion {
  /** "stock", "now", "after", or another state the export used ("proposed-bracket-3"). */
  state: string;
  /** "Stock", "Now", "After prints", "Proposed bracket 3". */
  label: string;
  /** What the list is, in a few words. */
  note: string;
  variant: BatchVariant;
}

export interface PlanSim {
  run: RunListItem;
  versions: PlanVersion[];
  comparisons: BatchComparison[];
}

const LABELS: Record<string, [string, string]> = {
  stock: ["Stock", "The precon as printed"],
  now: ["Now", "Cards in hand"],
  after: ["After prints", "Once the print order arrives"],
};

export function stateLabel(state: string): [string, string] {
  const known = LABELS[state];
  if (known) return known;
  const words = state.replace(/-/g, " ");
  return [words.charAt(0).toUpperCase() + words.slice(1), "A list from your planner"];
}

/** The state a variant id names for this deck key, or null when it's another deck's list. */
export function variantState(id: string, key: string): string | null {
  const tail = id.split("/").pop() ?? id;
  return tail.startsWith(`${key}-`) ? tail.slice(key.length + 1) : null;
}

/** Your newest paired run with lists for this plan deck, or null. */
export function pairedFor(runs: RunListItem[] | undefined, key: string): PlanSim | null {
  const mine = (runs ?? [])
    .filter((r) => !r.global && r.kind === "paired" && r.paired?.variants.some((v) => variantState(v.id, key) != null))
    .sort((a, b) => ((b.analysed_at ?? b.created_at) < (a.analysed_at ?? a.created_at) ? -1 : 1));
  const run = mine[0];
  if (!run?.paired) return null;
  const versions = run.paired.variants
    .map((variant) => {
      const state = variantState(variant.id, key);
      if (!state) return null;
      const [label, note] = stateLabel(state);
      return { state, label, note, variant };
    })
    .filter((v): v is PlanVersion => v != null);
  return { run, versions, comparisons: run.paired.comparisons };
}

/**
 * "phase-rs v0.113.0, 58 games each, easy AI, 19 Oct 2026": the short label beside a plan's
 * simulated numbers (engine, games, AI level, date). Without `versions`, no games.
 */
export function simShort(run: Pick<RunListItem, "engine" | "difficulty" | "analysed_at" | "created_at">, versions?: PlanVersion[]): string {
  return [
    run.engine ?? "an unrecorded engine",
    versions ? gamesEach(versions) : null,
    `${(run.difficulty ?? "unrecorded").toLowerCase()} AI`,
    fmtDate(run.analysed_at ?? run.created_at),
  ]
    .filter(Boolean)
    .join(", ");
}

/** "57 to 58 games each", "58 games each". */
export function gamesEach(versions: PlanVersion[]): string {
  const g = versions.map((v) => v.variant.games);
  if (!g.length) return "no games";
  const lo = Math.min(...g);
  const hi = Math.max(...g);
  return lo === hi ? `${lo} games each` : `${lo} to ${hi} games each`;
}

/** The runs list the lab pages already ask for, shared through the query cache. */
export const useRuns = (enabled = true) => useQuery({ queryKey: ["lab", "runs"], queryFn: ({ signal }) => api<RunListItem[]>("/api/lab/runs", { signal }), enabled, staleTime: 60_000 });
