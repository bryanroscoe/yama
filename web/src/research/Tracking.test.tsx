import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { PlanBundle, PlanDeck, Swap } from "@yama/core/plan";
import type { ResearchBundle } from "./api";
import { TrackPanel, trackedSwaps, useBuyRule, useTracked } from "./Tracking";

vi.mock("../plan/outbox", () => ({
  outbox: { localOps: () => [], enqueue: () => {}, sync: async () => {} },
  deviceId: () => "device",
  useOutbox: () => ({ pending: [], rejected: [] }),
}));

const planDeck = (over: Partial<PlanDeck> = {}): PlanDeck => ({
  key: "party", name: "Party Time", source: "yama", status: "active", product: null, commander: [], color_identity: null, owner_changes: [],
  bracket: null, groups: [], notes: [], deck_id: null, sort: 1, updated_at: "2026-11-05T00:00:00Z", states: {}, note: { id: "upgrades", deck: "party", build: "b3" }, ...over,
});
const swap = (over: Partial<Swap> & Pick<Swap, "key" | "in">): Swap => ({
  deck: "party", stage: "planned", role: "swap", parent: null, src: "buy", src_declared: null, store_label: null, out: null,
  plan_card: null, later_out: null, after_print: false, tier: null, band: null, group: null, sort: 0, game_changer: null, got: null,
  order_item: null, print_order: null, listing: null, when: null, advice: null, why: null, why_out: null, note: null, upgrade: null,
  retired: false, retired_at: null, updated_at: "2026-11-05T00:00:00Z", ...over,
});
function planBundle(decks: PlanDeck[], swaps: Swap[] = [], settings: unknown[] = []): PlanBundle {
  return {
    rev: "1", revision: 1, head: null, notes: [], game_changers: null, library: null, settings: settings as PlanBundle["settings"], stores: [], decks, swaps, aliases: {}, orders: [],
    quotes: [], reviews: {}, marks: {}, inputs: { pending_pull: 0, pulled_through: 0, pulled_at: null, outcomes: [], ideas: [] }, names: {}, unresolved: [],
    cards: {}, market: {}, market_by_printing: {}, printing_ids: {}, prices_as_of: null,
  };
}
const list = "Commander\n1 Nalia\nDeck\n99 Plains";
const note: ResearchBundle = {
  document: { schema: "yama-research/1", id: "upgrades", title: "Upgrades", generated_at: "2026-11-05", decks: [{ key: "party", name: "Party Time", commander: "Nalia", builds: [{ id: "b2", label: "Bracket 2", list }, { id: "b3", label: "Bracket 3", list }] }] },
  revision: 1, updated_at: "2026-11-05", content_hash: "abc", target_hashes: {}, reviews: [],
};

function render(node: React.ReactNode, plan: PlanBundle | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  qc.setQueryData(["me"], { id: "owner" });
  qc.setQueryData(["plan-cache", "owner"], null);
  if (plan) qc.setQueryData(["plan", "owner"], plan);
  const html = renderToStaticMarkup(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
  qc.clear();
  return html;
}
const deckOf = note.document.decks[0]!;

describe("tracking a plan's build", () => {
  it("offers nothing until the plans say what's tracked", () => {
    const html = render(<TrackPanel bundle={note} deck={deckOf} build={deckOf.builds[1]!} />, null);
    expect(html).toContain("Checking what you track");
    expect(html).not.toContain("</button>");
  });
  it("offers to track a build no plan follows, and says what tracking does", () => {
    const html = render(<TrackPanel bundle={note} deck={deckOf} build={deckOf.builds[1]!} />, planBundle([]));
    expect(html).toContain(">Track this build</button>");
    expect(html).toContain("buy list");
    expect(html).toContain("the plan itself doesn&#x27;t change");
  });
  it("says this build is tracked, opens the tracked plan and offers to stop", () => {
    const html = render(<TrackPanel bundle={note} deck={deckOf} build={deckOf.builds[1]!} />, planBundle([planDeck()]));
    expect(html).toContain("You&#x27;re tracking this build");
    expect(html).toContain('href="/decks/plan/d/party"');
    expect(html).toContain(">Stop tracking</button>");
    expect(html).not.toContain(">Track this build</button>");
  });
  it("offers to switch when another build of the deck is tracked", () => {
    const html = render(<TrackPanel bundle={note} deck={deckOf} build={deckOf.builds[0]!} />, planBundle([planDeck()]));
    expect(html).toContain("You&#x27;re tracking Bracket 3");
    expect(html).toContain(">Switch to this build</button>");
  });
  it("offers to track again after stopping", () => {
    const html = render(<TrackPanel bundle={note} deck={deckOf} build={deckOf.builds[1]!} />, planBundle([planDeck({ status: "archived" })]));
    expect(html).toContain(">Track this build</button>");
    expect(html).toContain("You tracked this deck before");
  });
  it("finds every copy a tracked swap made, and where each card is", () => {
    const swaps = [
      swap({ key: "n|upgrades|party|b3|stp", in: "Swords to Plowshares" }),
      swap({ key: "n|upgrades|party|b3|plains", in: "Island", src: "print" }),
      swap({ key: "n|upgrades|party|b3|plains#2", in: "Island", src: "print" }),
      swap({ key: "n|upgrades|party|b3|plains#3", in: "Island", retired: true }),
      swap({ key: "n|upgrades|party|b2|plains", in: "Island" }),
    ];
    expect(trackedSwaps(swaps, "upgrades", "party", "b3", "plains").map((s) => s.key)).toEqual(["n|upgrades|party|b3|plains", "n|upgrades|party|b3|plains#2"]);
    function States() {
      const t = useTracked("upgrades", "party");
      return <p>{t.swaps.map((s) => `${s.in}: ${t.status(s)}`).join("; ")}</p>;
    }
    const html = render(<States />, planBundle([planDeck()], swaps));
    expect(html).toContain("Swords to Plowshares: To buy");
    expect(html).toContain("Island: To print");
  });
  it("starts a plan's shopping list at the account's own buy rule", () => {
    function Rule() {
      const r = useBuyRule();
      return <p>{r ? `${r.upto}|${r.text}` : "none"}</p>;
    }
    const set = { effective_from: "2026-10-01", origin: "yama", rules: { local_buy: { max_usd: 3, tiers: [] } } };
    expect(render(<Rule />, planBundle([], [], [set]))).toContain("3.00|Starting at your shopping rule from 1 Oct 2026: buy cards up to $3.00.");
    expect(render(<Rule />, planBundle([]))).toContain("none");
  });
});
