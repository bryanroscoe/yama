import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PlanBundle } from "@yama/core/plan";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

const plan = vi.hoisted(() => ({ bundle: undefined as unknown, pending: false }));
vi.mock("../auth", () => ({ useMe: () => ({ data: { id: "owner" } }) }));
vi.mock("../plan/store", () => ({ usePlan: () => ({ bundle: plan.bundle, pending: plan.pending, error: null, offline: false }) }));
vi.mock("../plan/outbox", () => ({ useOutbox: () => ({ sent: [], pending: [] }), outbox: { localOps: () => [] } }));

const { DeckPlanTab } = await import("./DeckPlanTab");

function render(bundle: unknown) {
  plan.bundle = bundle;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DeckPlanTab deckId="d1" deckName="Terra" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const empty = {
  rev: "1", revision: 1, head: null, notes: [], game_changers: null, library: null, settings: [], stores: [], decks: [], swaps: [], aliases: {}, orders: [], quotes: [],
  reviews: {}, marks: {}, inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] }, names: {}, unresolved: [], cards: {},
  market: {}, market_by_printing: {}, printing_ids: {}, prices_as_of: null,
} as unknown as PlanBundle;

const swap = (key: string, installed: boolean, sort: number) => ({
  key, deck: "terra", stage: "planned", role: "swap", parent: null, src: "owned", out: `Out ${key}`, in: `In ${key}`, sort, got: null, deck_installed: installed, retired: false, updated_at: "",
});

describe("the Plan tab", () => {
  it("says there's no plan, with one link", () => {
    const html = render(empty);
    expect(html).toContain("No plan for this deck");
    expect(html.match(/<a /g)).toHaveLength(1);
  });

  it("shows the plan in progress: count, next step, the first changes left as pairs, then how many more", () => {
    const swaps = [swap("a", true, 0), swap("b", false, 1), swap("c", false, 2), swap("d", false, 3), swap("e", false, 4)];
    const deck = {
      key: "terra", name: "Terra", source: "yama", status: "active", commander: ["Terra"], color_identity: "WBR", bracket: null, notes: [], deck_id: "d1", sort: 0, states: {},
      plan: { state: "in_progress", version: 1, approved_at: null, next: null, changes: 5, installed: 1, questions: [], archived_at: null, archived_note: null },
    };
    const html = render({ ...empty, decks: [deck], swaps });
    expect(html).toContain("Current plan");
    expect(html).toContain("In progress");
    expect(html).toMatch(/1 of 5<\/b> in/);
    expect(html).toContain("<b>Next:</b> put in 4 cards you have");
    expect(html).toContain("<b>In b</b> <span class=\"dim\">replaces Out b</span>");
    expect(html).toContain("In d");
    expect(html).not.toContain("In e");
    expect(html).toContain(">1 more</a>");
    expect(html).toContain('href="/decks/plans/terra"');
    expect(html).not.toContain("Up next");
    expect(html).not.toContain("Ideas");
  });
});
