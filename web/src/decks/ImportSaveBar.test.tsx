import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Visibility } from "../api";
import { SaveBar } from "./ImportPage";
import type { Draft } from "./importLogic";
import { createOpIds } from "./saveOps";

import type { ImportCard } from "./importLogic";

// One card, so the draft is ready to save and only the choice can hold the button.
const sol = { oracle_id: "o-sol", name: "Sol Ring", type_line: "Artifact", color_identity: "", qty: 1, board: "main", maybe: false, can_be_commander: false, any_number: false } as unknown as ImportCard;
const draft: Draft = { name: "Riders of Rohan", cards: [sol], unknown: [], commanderMarked: false, commanderGuessed: false };

/** The save bar of a new deck for an account whose new decks start as `start`, with or without a handle. */
function bar(start: Visibility | null, handle: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], { id: "u1" });
  if (start) client.setQueryData(["sharing", "u1"], { handle, new_deck_visibility: start, collection_public: false, share_lab_results: false, decks: { private: 0, link: 0, public: 0 } });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SaveBar opIdFor={createOpIds()} drafts={[draft]} draft={draft} target="" setTarget={() => {}} picked={null} setPicked={() => {}} handle="" setHandle={() => {}} note="" setNote={() => {}} decks={[]} formatLabel={null} onSaved={() => {}} onSavedMany={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

const pressed = (html: string) => [...html.matchAll(/aria-pressed="true"[^>]*>([^<]+)</g)].map((m) => m[1]);

describe("the save step of a new deck", () => {
  it("asks who can see it, starting at the account's default", () => {
    expect(pressed(bar("private", null))).toEqual(["Private"]);
    expect(pressed(bar("link", null))).toEqual(["Link only"]);
    expect(pressed(bar("public", "saget"))).toEqual(["Public"]);
  });

  it("holds Add the deck until the choice is on screen, so no deck is added that the person did not choose for", () => {
    const html = bar(null, null);
    expect(html).not.toContain("Who can see it");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add the deck</);
    // With the choice shown the button is live.
    expect(bar("private", null)).not.toMatch(/<button[^>]*disabled=""[^>]*>Add the deck</);
  });

  it("asks for a handle only when the deck would be public and the account has none", () => {
    const first = bar("public", null);
    expect(first).toContain("Your handle");
    expect(first).toContain("public by link until you pick one");
    expect(bar("public", "saget")).not.toContain("Your handle");
    expect(bar("link", null)).not.toContain("Your handle");
    expect(bar("private", null)).not.toContain("Your handle");
  });
});
