import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { DeckView } from "../api";
import { Button } from "../components/ui";
import { ResetConfirm, ShareDeck, shareLabel, VISIBILITY_CHOICES } from "./ShareDeck";

/** The buttons in an element tree, by their text. */
function buttons(node: ReactNode, out: { text: string; onClick?: () => void }[] = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) buttons(n, out);
    return out;
  }
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
  if (el.type === Button) out.push({ text: String(el.props.children), onClick: el.props.onClick });
  buttons(el.props?.children, out);
  return out;
}

describe("making a new share link", () => {
  it("rotates the link from the confirm button and keeps it from Keep this one", () => {
    const onConfirm = vi.fn();
    const onKeep = vi.fn();
    const found = buttons(ResetConfirm({ pending: false, onConfirm, onKeep }));
    found.find((b) => b.text === "Make a new link")!.onClick!();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onKeep).not.toHaveBeenCalled();
    found.find((b) => b.text === "Keep this one")!.onClick!();
    expect(onKeep).toHaveBeenCalledOnce();
  });
});

describe("who can see a deck, by name", () => {
  it("uses the save step's names: Private, Link only, Public", () => {
    expect(VISIBILITY_CHOICES.map((c) => c.label)).toEqual(["Private", "Link only", "Public"]);
  });

  it("is on the deck page's Share button", () => {
    expect([shareLabel("private"), shareLabel("link"), shareLabel("public")]).toEqual(["Share: private", "Share: link only", "Share: public"]);
  });
});

describe("the share sheet", () => {
  const deck = {
    id: "m", name: "Revival Trance", visibility: "link", share_token: "tok", parent_id: null, configuration: null,
    configurations: [
      { id: "m", name: "Revival Trance", configuration: null, visibility: "link", share_token: "tok" },
      { id: "s", name: "Revival Trance (stock)", configuration: "stock", visibility: "private", share_token: null },
    ],
  } as unknown as DeckView;

  it("shows three choices without hint lines, the link actions, its other lists and the win-rate setting", () => {
    vi.stubGlobal("location", new URL("https://yama.ing/decks/m"));
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(["me"], { id: "u1" });
    client.setQueryData(["sharing", "u1"], { handle: "saget", new_deck_visibility: "private", collection_public: false, share_lab_results: true, decks: { private: 1, link: 1, public: 0 } });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ShareDeck deck={deck} onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('class="hint"');
    expect(html).not.toContain("Only you.");
    expect(html).toContain('aria-label="What sharing shows"');
    expect(html).toContain("Copy link");
    expect(html).toContain("Open it");
    expect(html).toContain("Make a new link");
    expect(html).toContain("Its other lists");
    expect(html).toContain("Simulated win rates");
    expect(html).toContain("Stock");
    expect(html).not.toContain("confirm(");
    client.clear();
    vi.unstubAllGlobals();
  });

  it("asks for a handle on a public deck of an account without one, and only then", () => {
    vi.stubGlobal("location", new URL("https://yama.ing/decks/m"));
    const sheet = (visibility: string, handle: string | null, public_listed_at: string | null = null) => {
      const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
      client.setQueryData(["me"], { id: "u1" });
      client.setQueryData(["sharing", "u1"], { handle, new_deck_visibility: "private", collection_public: false, share_lab_results: true, public_listed_at, decks: { private: 1, link: 1, public: 0 } });
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <ShareDeck deck={{ ...deck, visibility } as DeckView} onClose={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      client.clear();
      return html;
    };
    const asked = sheet("public", null);
    expect(asked).toContain("Save handle");
    expect(asked).toContain("This deck is public by link.");
    // The link still works without a handle.
    expect(asked).toContain("Copy link");
    expect(sheet("public", "saget")).not.toContain("Save handle");
    expect(sheet("public", "saget")).toContain("your profile, @saget");
    // An account from before public-by-default that hasn't answered: the profile only.
    expect(sheet("public", "saget")).toContain("It isn&#x27;t in Browse or open to search engines until you answer");
    expect(sheet("public", "saget", "2026-11-12T00:00:00Z")).toContain("and in Browse. Search engines can find it.");
    expect(sheet("link", null)).not.toContain("Save handle");
    expect(sheet("private", null)).not.toContain("Save handle");
    vi.unstubAllGlobals();
  });
});
