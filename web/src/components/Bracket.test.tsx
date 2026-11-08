import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DeckCheck, DeckEntry } from "../api";
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
      <BracketPanel deckId="deck" versionId="v1" declared={null} gameChangers={[]} reservedList={[]} cards={[]} onCard={() => {}} onDeclare={() => {}} />
    </QueryClientProvider>);
    const explanation = html.match(/<details class="details-fold"><summary>Why this suggestion\?<\/summary>(.*?)<\/details>/s)?.[1];
    expect(explanation).toContain("Start with Core (2)");
    expect(explanation).toContain("never assigns it automatically");
    expect(html).toContain("Choose or change your bracket");
    expect(html).toContain("How Yama suggests a bracket");
    client.clear();
  });

  it("shows an unofficial power estimate inside the suggested bracket's band, with its factors", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const entry = (name: string, type_line: string, cmc: number, oracle_text: string, produced_mana = ""): DeckEntry => ({
      oracle_id: name, name, qty: 1, board: "main", owned: 1, in_deck_container: 0, proxies: 0, locations: {}, needed: 0,
      cheapest_usd: null, printing: null, produced_mana,
      card: { type_line, cmc, oracle_text, mana_cost: null } as unknown as DeckEntry["card"],
    });
    const check: DeckCheck = {
      enabled: false, version_id: "v1", source: "Commander Spellbook", source_url: "https://commanderspellbook.com/",
      pending: false, retrying: false, next_try_at: null, error: null, gave_up: false, archived: false,
      requested_at: cached.checked_at,
      result: {
        checked_at: cached.checked_at, bracket_tag: "P", bracket_label: "Powerful", bracket: 3,
        game_changers: ["Demonic Tutor"], mld: [], extra_turns: [], combos: [], unrecognized: [],
      },
    };
    client.setQueryData(["deck-check", "deck", "v1"], check);
    const cards = [
      entry("Sol Ring", "Artifact", 1, "{T}: Add {C}{C}.", "C"),
      entry("Demonic Tutor", "Sorcery", 2, "Search your library for a card, put that card into your hand, then shuffle."),
      entry("Ulamog, the Ceaseless Hunger", "Legendary Creature — Eldrazi", 10, ""),
    ];
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>
      <BracketPanel deckId="deck" versionId="v1" declared={3} gameChangers={["Demonic Tutor"]} reservedList={["Grim Monolith"]} cards={cards} onCard={() => {}} onDeclare={() => {}} />
    </QueryClientProvider>);
    // 5 + cheap mana 0.0375 + tutors 0.05 + Game Changers 0.075 + Reserve List 0.025; the 4.33
    // average gives the curve nothing.
    expect(html).toContain("About 5.2 / 10");
    expect(html).toContain("Reserve List cards");
    expect(html).toContain("+0.03");
    expect(html).toContain("Unofficial Yama estimate");
    expect(html).toContain("How the power estimate adds up");
    expect(html).toContain("suggestion sets a 5–7 range");
    expect(html).not.toContain("·");
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
      <BracketPanel deckId="deck" versionId="v1" declared={null} gameChangers={[]} reservedList={[]} cards={[]} onCard={() => {}} onDeclare={() => {}} />
    </QueryClientProvider>);
    expect(html).not.toContain("/ 10");
    client.clear();
  });
});
