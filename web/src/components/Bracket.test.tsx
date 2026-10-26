import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeckCheck } from "../api";
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

  it("explains the provisional Core suggestion visibly on the deck page", () => {
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
    const visible = html.split('<details class="bracket-guide">')[0]!;
    expect(visible).toContain("Why this suggestion?");
    expect(visible).toContain("Start with Core (2)");
    expect(visible).toContain("never assigns it automatically");
    expect(visible).toContain("Choose or change your bracket");
    expect(html).toContain("How Yama suggests a bracket");
    client.clear();
  });
});
