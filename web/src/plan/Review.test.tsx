import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { PlanBundle, PlanDeck, Review as Answer, Swap } from "@yama/core/plan";
import { planView } from "./view";
import { ANSWER_MEANING, Review, toAnswerLine } from "./Review";
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

function page(b: PlanBundle, query = "") {
  outlet.value = { view: planView(b), userId: "owner" };
  return renderToStaticMarkup(<MemoryRouter initialEntries={[`/decks/plan/review${query}`]}><Review /></MemoryRouter>);
}

describe("Review is one to-do list", () => {
  // Riders-like state: a planned swap with an imported want, a planned swap with no answer, an
  // answered proposal and one still waiting.
  const swaps = [
    swap({ key: "planned-want", in: "Volcanic Island", out: "Mount Doom", sort: 1 }),
    swap({ key: "planned-none", in: "Arid Mesa", out: "Throne of the High City", sort: 2 }),
    swap({ key: "p-unsure", in: "Levitation", out: "Thought Vessel", stage: "proposed", sort: 3 }),
    swap({ key: "p-open", in: "Archangel of Tithes", out: "Frontier Warmonger", stage: "proposed", sort: 4 }),
  ];
  const b = bundle(swaps, { "planned-want": answer("want"), "p-unsure": answer("unsure") });

  it("says what an answer does, and counts only proposals with no answer", () => {
    const html = page(b);
    expect(html).toContain(ANSWER_MEANING.replace(/'/g, "&#x27;"));
    expect(html).toContain("1 proposal is waiting for your answer.");
    expect(html).toContain("1 to answer");
    expect(html).toContain("Waiting for your answer");
  });

  it("puts the unanswered proposal first and keeps answered and planned swaps closed", () => {
    const html = page(b);
    const open = html.indexOf("Archangel of Tithes");
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(html.indexOf("You&#x27;ve answered"));
    expect(html.indexOf("You&#x27;ve answered")).toBeLessThan(html.indexOf("Already in the plan"));
    // Closed sections draw no cards until opened: the planned swaps and the answered one aren't shown.
    expect(html).not.toContain("Volcanic Island");
    expect(html).not.toContain("Arid Mesa");
    expect(html).not.toContain("Levitation");
    expect(html).toMatch(/<details class="review-group review-section-closed"><summary/);
  });

  it("says when nothing is left", () => {
    const done = bundle(swaps, { "p-open": answer("no"), "p-unsure": answer("unsure") });
    expect(page(done)).toContain("Nothing in Riders of Rohan is waiting for your answer.");
    expect(toAnswerLine([{ sections: { open: 0 } }])).toBe("Nothing is waiting for your answer.");
    expect(toAnswerLine([{ sections: { open: 2 } }, { sections: { open: 3 } }, { sections: { open: 0 } }])).toBe("5 proposals are waiting for your answer, in 2 decks.");
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
