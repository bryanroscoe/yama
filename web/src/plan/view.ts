// Lookups the plan pages share, built once per bundle and outbox state.
import {
  answerIndex,
  localDate,
  markIndex,
  overlayMarks,
  overlayReviews,
  sourceContext,
  type LocalOp,
  type Mark,
  type MarkPair,
  type PlanBundle,
  type PlanCard,
  type PlanDeck,
  type Review,
  type SourceContext,
  type Swap,
  type DeckPlanState,
  type PlanDecision,
  overlayPlan,
  planOf as basePlanOf,
} from "@yama/core/plan";

export interface PlanView {
  b: PlanBundle;
  ctx: SourceContext;
  /** The bundle's answers with this device's taps laid over them, by key as stored. */
  reviews: Record<string, Review>;
  marks: Record<string, { installed?: Mark; bought?: Mark }>;
  /** Each live swap's current answer (aliases followed, tombstones dropped, taps included). */
  answers: Map<string, Review>;
  orphans: [string, Review][];
  /** Each live swap's installed tick and bought mark (aliases followed, taps included). */
  markBy: Map<string, MarkPair>;
  /** Marks whose swap is no longer in the plan. */
  markOrphans: [string, MarkPair][];
  /** Today on this device, YYYY-MM-DD: picks the rule set for prices checked today. */
  today: string;
  oracleId: (name: string | null | undefined) => string | undefined;
  card: (name: string | null | undefined) => PlanCard | undefined;
  deck: (key: string) => PlanDeck | undefined;
  deckName: (key: string | null | undefined) => string;
  swapsOf: (deckKey: string) => Swap[];
  /** The commander's art crop from Scryfall, for the wash behind a deck. */
  art: (deck: PlanDeck) => string | null;
  /** Who picks answers up for imported decks, as the banner names it. */
  app: string;
  /** The deck's plan state, with this device's own decisions (approve, keep, archive) laid over it. */
  planOf: (deck: PlanDeck) => DeckPlanState;
}

export function planView(b: PlanBundle, local: LocalOp[] = []): PlanView {
  const ctx = sourceContext(b);
  const live = b.swaps.filter((s) => !s.retired).map((s) => s.key);
  const reviews = overlayReviews(b.reviews, local);
  const { answers, orphans } = answerIndex(reviews, b.aliases, live);
  const marks = overlayMarks(b.marks ?? {}, local);
  const { marks: markBy, orphans: markOrphans } = markIndex(marks, b.aliases, live);
  const oracleId = (name: string | null | undefined) => (name ? b.names[name.trim()] : undefined);
  const card = (name: string | null | undefined) => {
    const id = oracleId(name);
    return id ? b.cards[id] : undefined;
  };
  const byDeck = new Map<string, Swap[]>();
  for (const s of b.swaps) byDeck.set(s.deck, [...(byDeck.get(s.deck) ?? []), s]);
  // Whole-plan decisions still on this device, by deck, in the order they were made.
  const decisions = new Map<string, PlanDecision[]>();
  for (const { op } of local) {
    if (op.kind === "plan") decisions.set(op.deck_key, [...(decisions.get(op.deck_key) ?? []), { deck_key: op.deck_key, action: op.action, version: op.version }]);
  }
  return {
    b,
    ctx,
    reviews,
    marks,
    answers,
    orphans,
    markBy,
    markOrphans,
    today: localDate(),
    oracleId,
    card,
    deck: (key) => ctx.decks.get(key),
    deckName: (key) => (key ? ctx.decks.get(key)?.name ?? key : "another deck"),
    swapsOf: (key) => byDeck.get(key) ?? [],
    art: (deck) => deck.commander.map((c) => card(c)?.image_art_crop).find(Boolean) ?? null,
    app: b.head?.app ?? "your planner",
    planOf: (deck) => overlayPlan(basePlanOf(deck, b.swaps), decisions.get(deck.key) ?? []),
  };
}
