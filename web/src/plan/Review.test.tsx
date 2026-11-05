import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { PlanBundle, PlanDeck, Review as Answer, Swap } from "@yama/core/plan";
import { planView } from "./view";
import { ANSWER_MEANING, PlanAnswer, Review, toAnswerLine } from "./Review";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { planSummariesKey, type PlanSummary } from "../research/view";
import { InstalledTick } from "./marks";

const outlet = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("./PlanLayout", () => ({ usePlanOutlet: () => outlet.value, PlansHead: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock("../advisor/AskClaude", () => ({ AskClaude: () => null }));
vi.mock("./outbox", () => ({
  outbox: { enqueue: () => {}, sync: async () => {}, dismiss: () => {} },
  deviceId: () => "device",
  useOutbox: () => ({ pending: [], rejected: [] }),
  useOutboxState: () => ({ syncing: false, error: null }),
}));

const deck = (over: Partial<PlanDeck> = {}): PlanDeck => ({
  key: "riders", name: "Riders of Rohan", source: "import", status: "active", product: null, commander: [], color_identity: null, owner_changes: [],
  bracket: null, groups: [], notes: [], deck_id: null, sort: 1, updated_at: "2026-10-28T00:00:00Z", states: {}, ...over,
});
const swap = (over: Partial<Swap> & Pick<Swap, "key" | "in">): Swap => ({
  deck: "riders", stage: "planned", role: "swap", parent: null, src: "owned", src_declared: null, store_label: null, out: null,
  plan_card: null, later_out: null, after_print: false, tier: null, band: null, group: null, sort: 0, game_changer: null, got: null,
  order_item: null, print_order: null, listing: null, when: null, advice: null, why: null, why_out: null, note: null, upgrade: null,
  retired: false, retired_at: null, updated_at: "2026-10-28T00:00:00Z", ...over,
});
const answer = (decision: Answer["decision"]): Answer => ({ decision, note: null, cut: null, deck: null, card: null, at: "2026-10-28T01:00:00Z", origin: "import" });

function bundle(swaps: Swap[], reviews: Record<string, Answer>, decks = [deck()]): PlanBundle {
  return {
    rev: "1", revision: 1, head: null, notes: [], game_changers: null, library: null, settings: [], stores: [], decks, swaps, aliases: {}, orders: [],
    quotes: [], reviews, marks: {}, inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] }, names: {}, unresolved: [],
    cards: {}, market: {}, market_by_printing: {}, printing_ids: {}, prices_as_of: null,
  };
}

const note = (over: Partial<PlanSummary> = {}): PlanSummary => ({
  id: "owned-now", title: "Buildable now", revision: 1, updated_at: "2026-10-30T00:00:00Z", visibility: "private", share_token: null, decks: 2, copied_by: null, art: [],
  deck_plans: [
    { key: "riders-of-rohan", name: "Riders of Rohan", commander: "Éowyn", builds: [{ id: "b2", label: "Bracket 2" }], recommended: "b2", preferred: null, to_answer: 4, art: null, identity: "RW" },
    { key: "ahoy", name: "Ahoy Mateys", commander: "Admiral Brass", builds: [{ id: "b2", label: "Bracket 2" }], recommended: "b2", preferred: null, to_answer: 0, art: null, identity: "UB" },
  ],
  ...over,
});

function render(node: React.ReactNode, b: PlanBundle, notes: PlanSummary[] = []) {
  outlet.value = { view: planView(b), userId: "owner" };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(planSummariesKey("owner"), notes);
  const html = renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter initialEntries={["/decks/plan/review"]}>{node}</MemoryRouter></QueryClientProvider>);
  qc.clear();
  return html;
}

describe("Review lists where answers wait", () => {
  // A plan file's Riders of Rohan: a planned swap with an imported want, a planned swap with no
  // answer, an answered proposal and one still waiting. A note plans it too, with 4 to answer.
  const swaps = [
    swap({ key: "planned-want", in: "Volcanic Island", out: "Mount Doom", sort: 1 }),
    swap({ key: "planned-none", in: "Arid Mesa", out: "Throne of the High City", sort: 2 }),
    swap({ key: "p-unsure", in: "Levitation", out: "Thought Vessel", stage: "proposed", sort: 3 }),
    swap({ key: "p-open", in: "Archangel of Tithes", out: "Frontier Warmonger", stage: "proposed", sort: 4 }),
  ];
  const b = bundle(swaps, { "planned-want": answer("want"), "p-unsure": answer("unsure") });

  it("says what an answer does and lists, deck by deck, where answers wait", () => {
    const html = render(<Review />, b, [note()]);
    expect(html).toContain(ANSWER_MEANING.replace(/'/g, "&#x27;"));
    // The count is the proposals for tracked decks, as the Plans tab's; the plan's changes are listed apart.
    expect(html).toContain("1 proposal is waiting for your answer.");
    expect(html.indexOf("Proposed for decks you track")).toBeLessThan(html.indexOf("In your plans"));
    // The deck in each list, a line per plan with answers waiting, each to where you answer them.
    expect(html.match(/review-list-deck/g)).toHaveLength(2);
    expect(html).toContain('href="/decks/research/owned-now/riders-of-rohan#changes-head"');
    expect(html).toContain("Buildable now</span><span class=\"pill num quiet\">4 to answer");
    expect(html).toContain('href="/decks/plan/d/riders#proposed"');
    expect(html).toContain("Your plan file</span><span class=\"pill num warn\">1 to answer");
    // A deck with nothing waiting isn't listed, and no swap is answered here.
    expect(html).not.toContain("Ahoy Mateys");
    expect(html).not.toContain("Archangel of Tithes");
  });

  it("says when nothing is left", () => {
    const done = bundle(swaps, { "p-open": answer("no"), "p-unsure": answer("unsure") });
    const html = render(<Review />, done, [note({ deck_plans: [] })]);
    expect(html).toContain("No proposals for your tracked decks are waiting for your answer.");
    expect(html).toContain("You&#x27;ve answered every change in the builds you&#x27;d make.");
    expect(toAnswerLine([{ open: 2 }, { open: 3 }, { open: 0 }])).toBe("5 proposals are waiting for your answer, in 2 decks.");
  });

  it("answers a proposal beside it, as a plan's changes do, and says where the note goes", () => {
    const view = planView(b);
    const html = render(<PlanAnswer swap={swaps[2]!} deck={view.deck("riders")!} view={view} userId="owner" />, b);
    expect(html).toContain('aria-pressed="true">Unsure</button>');
    expect(html).toContain('aria-pressed="false">Want</button>');
    expect(html).toContain("Don&#x27;t want</button>");
    expect(html).toContain("Cut something else");
    expect(html).toContain("picks it up with your answers");
  });
});

describe("installed state from the deck", () => {
  const yd = { id: "deck-1", name: "Riders of Rohan", configuration: null, version_id: "v1", list_at: "2026-10-28T00:00:00Z", linked: true };
  const tick = (s: Swap, d: PlanDeck) => {
    const view = planView(bundle([s], {}, [d]));
    return renderToStaticMarkup(<MemoryRouter><InstalledTick swap={s} view={view} userId="owner" /></MemoryRouter>);
  };

  it("reads the deck's list instead of a tick when a deck is linked", () => {
    const html = tick(swap({ key: "a", in: "Volcanic Island", out: "Mount Doom", deck_installed: true, upgrade: { id: "u", status: "planned" } }), deck({ yama_deck: yd }));
    expect(html).toContain("In the deck");
    expect(html).toContain("This swap is in Riders of Rohan&#x27;s current list.");
    expect(html).toContain('href="/decks/deck-1"');
    expect(html).not.toContain('type="checkbox"');
    const out = tick(swap({ key: "a", in: "Volcanic Island", out: "Mount Doom", deck_installed: false, upgrade: { id: "u", status: "installed" } }), deck({ yama_deck: yd }));
    expect(out).toContain("Not in the deck yet");
  });

  it("keeps the tick when no deck is linked", () => {
    const html = tick(swap({ key: "a", in: "Volcanic Island", out: "Mount Doom", deck_installed: null }), deck());
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("I&#x27;ve put this in the deck");
  });
});
