import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { PlanBundle, PlanDeck } from "@yama/core/plan";
import { buildToMake, deckGroups, fromLine, PlansForDeck, trackedNote } from "./PlanTiles";
import { ChangesTable } from "./parts";
import { planSummariesKey, type DeckPlanSummary, type PlanSummary } from "./view";

const plan = (over: Partial<DeckPlanSummary> & Pick<DeckPlanSummary, "key" | "name">): DeckPlanSummary => ({
  commander: "Éowyn", builds: [{ id: "b2", label: "Bracket 2" }, { id: "b3", label: "Bracket 3" }], recommended: "b2", preferred: null, to_answer: 0, art: null, identity: "RW", ...over,
});
const note = (id: string, title: string, decks: DeckPlanSummary[]): PlanSummary => ({
  id, title, revision: 1, updated_at: "2026-11-01T00:00:00Z", visibility: "private", share_token: null, decks: decks.length, copied_by: null, art: [], deck_plans: decks,
});
const deck = (over: Partial<PlanDeck> & Pick<PlanDeck, "key" | "name">): PlanDeck => ({
  source: "import", status: "active", product: null, commander: [], color_identity: null, owner_changes: [], bracket: null, groups: [], notes: [], deck_id: null,
  sort: 1, updated_at: "2026-11-01T00:00:00Z", states: {}, ...over,
});

// Two notes plan Riders of Rohan; one plans Ahoy Mateys too. A plan file tracks Riders; a note's
// build of Ahoy Mateys is tracked under another key.
const newer = note("owned-now", "Buildable now", [plan({ key: "riders-of-rohan", name: "Riders of Rohan" }), plan({ key: "ahoy", name: "Ahoy Mateys", preferred: "b3" })]);
const older = note("review", "Deck review", [plan({ key: "riders-of-rohan", name: "Riders of Rohan" }), plan({ key: "borg", name: "We Are the Borg", recommended: null })]);
const riders = deck({ key: "riders-of-rohan", name: "Riders of Rohan" });
const ahoy = deck({ key: "ahoy-2", name: "Ahoy Mateys", source: "yama", note: { id: "owned-now", deck: "ahoy", build: "b3" } });

describe("plans by deck", () => {
  it("makes one entry per deck, whichever notes plan it, tracked ones first", () => {
    const groups = deckGroups([newer, older], [riders, ahoy, deck({ key: "gone", name: "Gone", status: "archived" })]);
    expect(groups.map((g) => g.name)).toEqual(["Riders of Rohan", "Ahoy Mateys", "We Are the Borg"]);
    const [r, a, b] = groups;
    expect(r!.notes.map((n) => n.note.id)).toEqual(["owned-now", "review"]);
    expect(r!.tracked).toEqual([riders]);
    // Ahoy Mateys's tracked copy has another key but follows the note's deck.
    expect(trackedNote(a!)).toBe(ahoy);
    expect(trackedNote(r!)).toBeUndefined();
    expect(b!.tracked).toEqual([]);
  });

  it("says which plan a tile opens, how many more there are, and the build to make", () => {
    const [r, a, b] = deckGroups([newer, older], [riders, ahoy]);
    expect(fromLine(r!, riders)).toBe("From your plan file, 2 more plans");
    expect(fromLine(a!, ahoy)).toBe("From Buildable now");
    expect(fromLine(b!)).toBe("From Deck review");
    expect(buildToMake(newer.deck_plans[1]!)).toBe("Your pick: Bracket 3, 1 more build.");
    expect(buildToMake(newer.deck_plans[0]!)).toBe("Recommended: Bracket 2, 1 more build.");
    expect(buildToMake(older.deck_plans[1]!)).toBe("2 builds.");
  });

  it("switches between a deck's plans on its pages, the one shown marked", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["me"], { id: "owner" });
    qc.setQueryData(planSummariesKey("owner"), [newer, older]);
    qc.setQueryData(["plan-cache", "owner"], null);
    qc.setQueryData(["plan", "owner"], { decks: [riders, ahoy] } as unknown as PlanBundle);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PlansForDeck name="Riders of Rohan" current={{ note: "review" }} />
          <PlansForDeck name="We Are the Borg" current={{ note: "review" }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    qc.clear();
    expect(html).toContain('aria-label="Plans for Riders of Rohan"');
    expect(html).toContain('href="/decks/research/owned-now/riders-of-rohan"');
    expect(html).toContain('aria-current="page" href="/decks/research/review/riders-of-rohan"');
    expect(html).toMatch(/href="\/decks\/plan\/d\/riders-of-rohan"[^>]*>Your plan file/);
    // A deck with one plan has nothing to switch to.
    expect(html).not.toContain("We Are the Borg");
  });

  it("leads each change's cards with their pictures, at Scryfall's small size", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ChangesTable rows={[{ add: "Sol Ring", cut: "Mind Stone", n: 1, why: "Faster.", notes: [], add_image: "https://cards.scryfall.io/normal/front/s/r/sol.jpg", cut_image: null, swap: "sol" }]} />
      </MemoryRouter>,
    );
    expect(html).toContain('src="https://cards.scryfall.io/small/front/s/r/sol.jpg"');
    // A card with no picture keeps the picture's place, its name shown once.
    expect(html).toContain('<span class="thumb note-thumb" aria-hidden="true"></span>');
    expect(html.match(/>Mind Stone</g)).toHaveLength(1);
    // The picture is decoration beside the name, so a screen reader says the name once.
    expect(html).toContain('<img class="thumb note-thumb" src="https://cards.scryfall.io/small/front/s/r/sol.jpg" alt=""');
  });
});
