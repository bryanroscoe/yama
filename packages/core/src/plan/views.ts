// The review list (docs/planner-design.md section 7, `reviewItems`): every live swap of every deck,
// with its answer, counts for the deck chips, the filters and a search over reasons, stores and
// notes. Answers that reach no live swap are listed by `answerIndex` as orphans; the page shows
// them in their own section.
//
// Review is one to-do list (Bryan, 2026-10-28: "a lot of them act like they're already reviewed.
// Then I go into them and I haven't reviewed them"). Only a proposal with no decision needs an
// answer. Answered proposals, and planned swaps (already in the plan), come after it in their own
// sections, and no count calls a planned swap "not decided".

import type { Tone } from "./changes";
import type { Mark, PlanBundle, PlanDeck, Quote, Review, Swap } from "./types";

export type ReviewGroupId = "proposed" | "now" | "standins" | "prints" | "optional";

/** In page order. Proposals come first: they're the ones that need an answer. */
export const REVIEW_GROUPS: { id: ReviewGroupId; label: string }[] = [
  { id: "proposed", label: "Proposed, not in the plan" },
  { id: "now", label: "Plan: swap in now" },
  { id: "standins", label: "Stand-ins until prints arrive" },
  { id: "prints", label: "Plan: when your prints arrive" },
  { id: "optional", label: "Optional extras" },
];

export type ReviewFilter = "undecided" | "proposed" | "want" | "unsure" | "no" | "all";

export const REVIEW_FILTERS: { id: ReviewFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "undecided", label: "To answer" },
  { id: "proposed", label: "Proposals" },
  { id: "want", label: "Want" },
  { id: "unsure", label: "Unsure" },
  { id: "no", label: "Don't want" },
];

/** Where an item sits on the page: the to-do list first, then the rest, collapsed. */
export type ReviewSection = "open" | "answered" | "planned";

export const REVIEW_SECTIONS: { id: ReviewSection; label: string; about: string }[] = [
  { id: "open", label: "Waiting for your answer", about: "Proposals nobody has answered yet." },
  { id: "answered", label: "You've answered", about: "Change an answer any time; agents read the newest one." },
  {
    id: "planned",
    label: "Already in the plan",
    about: "These swaps were agreed earlier, so they don't need an answer. Say no or add a note only if you've changed your mind.",
  },
];

/** A proposal with no decision needs an answer; a note or a cut alone doesn't answer it. */
export function reviewSectionOf(s: Swap, answer: Review | undefined): ReviewSection {
  if (s.stage !== "proposed") return "planned";
  return answer?.decision ? "answered" : "open";
}

export interface ReviewItem {
  swap: Swap;
  section: ReviewSection;
  group: ReviewGroupId;
  answer: Review | undefined;
  /** Recorded market benchmarks and store stock checks for this swap, newest first. */
  quotes: Quote[];
  /** Lower-case text the search looks in. */
  haystack: string;
}

export interface ReviewDeck {
  deck: PlanDeck;
  items: ReviewItem[];
  counts: Record<ReviewFilter, number>;
  sections: Record<ReviewSection, number>;
}

export function reviewGroupOf(s: Swap): ReviewGroupId {
  if (s.stage === "proposed") return "proposed";
  if (s.role === "standin") return "standins";
  if (s.role === "optional") return "optional";
  return s.src === "print" || s.after_print ? "prints" : "now";
}

export function matchesFilter(item: ReviewItem, filter: ReviewFilter): boolean {
  const d = item.answer?.decision ?? null;
  switch (filter) {
    case "all":
      return true;
    case "undecided":
      return item.section === "open";
    case "proposed":
      return item.swap.stage === "proposed";
    default:
      return d === filter;
  }
}

/** Items that pass the filter and contain every word of the search. */
export function filterItems(items: ReviewItem[], filter: ReviewFilter, query: string): ReviewItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((i) => matchesFilter(i, filter) && words.every((w) => i.haystack.includes(w)));
}

/**
 * One entry per deck that isn't archived, in plan order, with each live swap as an item in
 * section, group and plan order (proposals waiting for an answer first). `answers` is keyed by live swap key (aliases already followed), as `answerIndex`
 * returns it.
 */
export function reviewItems(b: Pick<PlanBundle, "decks" | "swaps" | "quotes" | "stores">, answers: Map<string, Review>): ReviewDeck[] {
  const storeName = new Map(b.stores.map((s) => [s.key, s.name]));
  const quotesOf = new Map<string, Quote[]>();
  for (const q of b.quotes) if (q.swap) quotesOf.set(q.swap, [...(quotesOf.get(q.swap) ?? []), q]);
  const order = new Map(REVIEW_GROUPS.map((g, i) => [g.id, i]));
  const sectionOrder = new Map(REVIEW_SECTIONS.map((g, i) => [g.id, i]));
  return [...b.decks]
    .filter((d) => d.status !== "archived")
    .sort((a, b) => a.sort - b.sort)
    .map((deck) => {
      const items = b.swaps
        .filter((s) => s.deck === deck.key && !s.retired)
        .map((swap): ReviewItem => {
          const quotes = [...(quotesOf.get(swap.key) ?? [])].sort((x, y) => (x.checked < y.checked ? 1 : x.checked > y.checked ? -1 : 0));
          const answer = answers.get(swap.key);
          const text = [
            swap.in, swap.out, swap.plan_card, swap.why, swap.why_out, swap.note, swap.when, swap.advice, swap.later_out, swap.store_label,
            swap.listing, swap.tier, swap.group, answer?.note,
            ...quotes.flatMap((q) => [q.store_label, q.store ? storeName.get(q.store) : null, q.result, q.printing]),
          ];
          return { swap, section: reviewSectionOf(swap, answer), group: reviewGroupOf(swap), answer, quotes, haystack: text.filter(Boolean).join("\n").toLowerCase() };
        })
        .sort(
          (x, y) =>
            sectionOrder.get(x.section)! - sectionOrder.get(y.section)! || order.get(x.group)! - order.get(y.group)! || x.swap.sort - y.swap.sort,
        );
      const counts = Object.fromEntries(
        (["all", "undecided", "proposed", "want", "unsure", "no"] as ReviewFilter[]).map((f) => [f, items.filter((i) => matchesFilter(i, f)).length]),
      ) as Record<ReviewFilter, number>;
      const sections = Object.fromEntries(REVIEW_SECTIONS.map((g) => [g.id, items.filter((i) => i.section === g.id).length])) as Record<ReviewSection, number>;
      return { deck, items, counts, sections };
    });
}

export interface AnswerStateOptions {
  /** The deck's source: an imported deck's answers go to its export side's inbox. */
  source: "import" | "yama";
  /** `inputs.pulled_through`. */
  pulledThrough: number;
  /** Who picks answers up, as the banner names it ("commander-decks"). */
  app: string;
}

/** Where an answer stands on its way to the planner, in words. Null when there's nothing to say. */
export function answerState(r: Review | undefined, opts: AnswerStateOptions): { label: string; tone: Tone } | null {
  if (!r) return null;
  if (r.local === "pending") return { label: "Saved on this phone, waiting to sync", tone: "warn" };
  if (r.origin === "import") return { label: `From ${opts.app}`, tone: "plain" };
  if (opts.source === "yama") return { label: "Saved", tone: "good" };
  if (r.seq != null && r.seq <= opts.pulledThrough) return { label: `Picked up by ${opts.app}`, tone: "good" };
  return { label: `Saved in Yama, waiting for ${opts.app} to pick it up`, tone: "plain" };
}

/** Where an installed tick or bought mark stands on its way to the planner. Null with no mark. */
export function markState(m: Mark | undefined, opts: AnswerStateOptions): { label: string; tone: Tone } | null {
  if (!m) return null;
  if (m.local === "pending") return { label: "Saved on this phone, waiting to sync", tone: "warn" };
  if (opts.source === "yama") return { label: "Saved", tone: "good" };
  if (m.seq != null && m.seq <= opts.pulledThrough) return { label: `Picked up by ${opts.app}`, tone: "good" };
  return { label: `Saved in Yama, waiting for ${opts.app} to pick it up`, tone: "plain" };
}
