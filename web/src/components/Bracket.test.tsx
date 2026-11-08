import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeckCheck } from "../api";
import { analysisView } from "../decks/analysisFixture";
import { BracketChips, BracketPanel } from "./Bracket";

const cached = { tag: "E", label: "Exhibition", bracket: 1, checked_at: "2026-10-25T00:00:00Z" };

describe("bracket suggestions", () => {
  it("corrects cached E/1 chips everywhere while keeping a deliberately declared 1", () => {
    const html = renderToStaticMarkup(<BracketChips declared={1} estimate={cached} />);
    expect(html).toContain("Bracket <b>1</b>");
    expect(html).toContain("Suggested <b>2</b>");
    expect(html).not.toContain("Suggested <b>1</b>");
    expect(html).toContain("Core starting point");
  });

  it("keeps the provisional explanation available beside the suggestion and bracket action", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const check: DeckCheck = {
      enabled: false, version_id: "v1", source: "Commander Spellbook", source_url: "https://commanderspellbook.com/",
      pending: false, retrying: false, next_try_at: null, error: null, gave_up: false, archived: false,
      requested_at: cached.checked_at,
      result: {
        checked_at: cached.checked_at, bracket_tag: "E", bracket_label: "Exhibition", bracket: 1,
        game_changers: [], mld: [], extra_turns: [], combos: [], unrecognized: [],
      },
    };
    client.setQueryData(["deck-check", "deck", "v1"], check);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <BracketPanel deckId="deck" versionId="v1" declared={null} gameChangers={[]} onCard={() => {}} onDeclare={() => {}} />
    </QueryClientProvider>);
    const explanation = html.match(/<details class="details-fold"><summary>Why this suggestion\?<\/summary>(.*?)<\/details>/s)?.[1];
    expect(explanation).toContain("Start with Core (2)");
    expect(explanation).toContain("never assigns it automatically");
    expect(html).toContain("Choose or change your bracket");
    expect(html).toContain("How Yama suggests a bracket");
    client.clear();
  });

  it("shows the power level from the deck's analysis beside the brackets", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["deck-analysis", "deck", "v1"], analysisView(5.4));
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <BracketPanel deckId="deck" versionId="v1" declared={3} gameChangers={[]} onCard={() => {}} onDeclare={() => {}} />
    </QueryClientProvider>);
    expect(html).toContain("Power level, 1 to 10");
    expect(html).toContain("5.4");
    expect(html).toContain("±0.4");
    expect(html).toContain("Focused casual, unofficial Yama estimate");
    expect(html).not.toContain("·");
    client.clear();
  });

  it("shows no power level before the analysis arrives", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, enabled: false } } });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <BracketPanel deckId="deck" versionId="v1" declared={null} gameChangers={[]} onCard={() => {}} onDeclare={() => {}} />
    </QueryClientProvider>);
    expect(html).not.toContain("Power level, 1 to 10");
    client.clear();
  });

  it("shows the power level even when the bracket tag gives no suggestion", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const check: DeckCheck = {
      enabled: false, version_id: "v1", source: "Commander Spellbook", source_url: "https://commanderspellbook.com/",
      pending: false, retrying: false, next_try_at: null, error: null, gave_up: false, archived: false,
      requested_at: cached.checked_at,
      result: {
        checked_at: cached.checked_at, bracket_tag: "B", bracket_label: "Banned", bracket: null,
        game_changers: [], mld: [], extra_turns: [], combos: [], unrecognized: [],
      },
    };
    client.setQueryData(["deck-check", "deck", "v1"], check);
    client.setQueryData(["deck-analysis", "deck", "v1"], analysisView(4.1));
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <BracketPanel deckId="deck" versionId="v1" declared={null} gameChangers={[]} onCard={() => {}} onDeclare={() => {}} />
    </QueryClientProvider>);
    expect(html).toContain("Power level, 1 to 10");
    expect(html).toContain("4.1");
    client.clear();
  });

  it("shows no power estimate for a tag Yama can't turn into a bracket", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const check: DeckCheck = {
      enabled: false, version_id: "v1", source: "Commander Spellbook", source_url: "https://commanderspellbook.com/",
      pending: false, retrying: false, next_try_at: null, error: null, gave_up: false, archived: false,
      requested_at: cached.checked_at,
      result: {
        checked_at: cached.checked_at, bracket_tag: "B", bracket_label: "Banned", bracket: null,
        game_changers: [], mld: [], extra_turns: [], combos: [], unrecognized: [],
      },
    };
    client.setQueryData(["deck-check", "deck", "v1"], check);
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <BracketPanel deckId="deck" versionId="v1" declared={null} gameChangers={[]} onCard={() => {}} onDeclare={() => {}} />
    </QueryClientProvider>);
    expect(html).not.toContain("/ 10");
    client.clear();
  });
});
