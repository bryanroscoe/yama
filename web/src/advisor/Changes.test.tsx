import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ChangeCard, ChangesBanner, ChangesPage } from "./Changes";
import { changesKey, type ProposalCard, type StagedChange } from "./api";
import { ProposalText } from "./Proposal";

// The page's unrelated navigation uses a browser-only offline store.
vi.mock("../components/DeckTabs", () => ({ AreaHead: ({ title }: { title: string }) => <h1>{title}</h1> }));

const card = (name: string, qty = 1): ProposalCard => ({ oracle_id: name, name, qty, image: null, mana_cost: null, type_line: "Creature" });
const change: StagedChange = {
  id: "change", kind: "edit_deck", summary: "An unreadable old summary with all additions and removals", detail: "Why: old details",
  via: "oauth", conversation_id: null, message_id: null, status: "pending", error: null, result: null,
  created_at: "2026-10-27T00:00:00Z", decided_at: null,
  preview: {
    kind: "deck_edit", target: "Eternal Might", target_id: "deck",
    add: [card("Varina, Lich Queen"), card("Kindred Discovery")], remove: [card("Twisted Abomination", 2)],
    explanation: "1. Draw cards from attacks.\n2. Keep drawing when Zombies enter.",
    checks: "Cards (commander and main): 100.\nCommander checks: no problems found.",
  },
};

function render(component: ReactNode, data?: StagedChange[]) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  if (data) {
    client.setQueryData([...changesKey, "all"], data);
    client.setQueryData([...changesKey, "pending"], data.filter((c) => c.status === "pending"));
  }
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter>{component}</MemoryRouter></QueryClientProvider>);
  client.clear();
  return html;
}

describe("suggested change review", () => {
  it("shows authoritative additions, removals, quantities and reasons without the old summary wall", () => {
    const html = render(<ChangeCard change={change} />);
    expect(html).toContain("Eternal Might");
    expect(html).toContain("2 cards in, 2 cards out");
    expect(html).toContain('aria-label="Cards to add"');
    expect(html).toContain('aria-label="Cards to remove"');
    expect(html).toContain("Varina, Lich Queen");
    expect(html).toContain("Twisted Abomination");
    expect(html).toContain("2 × ");
    expect(html).toContain("<ol><li>Draw cards from attacks.</li><li>Keep drawing when Zombies enter.</li></ol>");
    expect(html).not.toContain("unreadable old summary");
    expect(html.indexOf("Why these changes")).toBeLessThan(html.indexOf('<details class="details-fold">'));
    expect(html).toContain(">Apply</button>");
    expect(html).toContain(">Discard</button>");
  });

  it("uses runtime card images with zoom, while missing images keep the card name", () => {
    const withImage = { ...change, preview: { ...change.preview!, add: [{ ...card("Varina"), image: "https://cards.scryfall.io/normal/front/v/varina.jpg" }] } };
    const html = render(<ChangeCard change={withImage} />);
    expect(html).toContain('aria-label="Show Varina larger"');
    expect(html).toContain('src="https://cards.scryfall.io/normal/front/v/varina.jpg"');
    expect(html).toContain("Twisted Abomination");
  });

  it("keeps unsupported and older proposals readable and escapes external HTML", () => {
    const html = render(<ChangeCard change={{ ...change, preview: undefined, kind: "set_condition", summary: "Mark copies lightly played", detail: 'Why: 1. First reason\n2. <script>alert("x")</script>' }} />);
    expect(html).toContain("Mark copies lightly played");
    expect(html).toContain("<ol><li>First reason</li>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("labels the page, sources and banner without assuming an assistant provider", () => {
    const html = render(<><ChangesBanner /><ChangesPage /></>, [change, { ...change, id: "key", via: "key" }]);
    expect(html).toContain("Suggested changes");
    expect(html).toContain("2 suggested changes are");
    expect(html).toContain("From an external app through MCP");
    expect(html).toContain("From MCP with a script key");
    expect(html).not.toContain("Claude");
  });

  it("retains decided state and error handling without offering Apply after a decision", () => {
    const applied = render(<ChangeCard change={{ ...change, status: "applied", result: { link: "/decks/deck", label: "Open deck" } }} />);
    expect(applied).toContain('href="/decks/deck"');
    expect(applied).not.toContain(">Apply</button>");
    const failed = render(<ChangeCard change={{ ...change, error: "The deck changed since this was suggested." }} />);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The deck changed since this was suggested.");
    expect(failed).toContain(">Apply</button>");
  });
});

describe("proposal text", () => {
  it("keeps a pasted deck list a card a line instead of one paragraph", () => {
    const html = renderToStaticMarkup(<ProposalText text={"Why: a list.\n\nCommander\n1 Kraum, Ludevic's Opus\n1 Tymna the Weaver\n\nDeck\n1 Ad Nauseam\n1 Ancient Tomb"} />);
    expect(html).toContain('<ul class="proposal-deck-list"><li>1 Kraum, Ludevic&#x27;s Opus</li><li>1 Tymna the Weaver</li></ul>');
    expect(html).toContain("<p>Deck</p>");
    expect(html).not.toContain("Opus 1 Tymna");
    // One numbered line on its own stays prose.
    expect(renderToStaticMarkup(<ProposalText text={"Cards: 100\n2 changes since then."} />)).not.toContain("proposal-deck-list");
  });
});
