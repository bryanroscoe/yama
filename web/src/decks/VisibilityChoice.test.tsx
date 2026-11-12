import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { newDecksStartAs, reachOf, savedAsLine, SavedAsNote, SAVE_CHOICES, useNewDeckSetting, VisibilityChoice, visibilityMeans } from "./VisibilityChoice";

const full = { listed: true, handle: true };

describe("who can see a deck being saved", () => {
  it("offers Public, Link only and Private in that order, with the current one pressed", () => {
    const html = renderToStaticMarkup(<VisibilityChoice value="link" onChange={() => {}} reach={full} />);
    expect(SAVE_CHOICES.map(([, label]) => label)).toEqual(["Public", "Link only", "Private"]);
    const pressed = [...html.matchAll(/aria-pressed="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]]);
    expect(pressed).toEqual([["Public", "false"], ["Link only", "true"], ["Private", "false"]]);
    expect(html).toContain("Who can see it");
  });

  it("says what the choice means and that it is remembered", () => {
    const html = renderToStaticMarkup(<VisibilityChoice value="private" onChange={() => {}} reach={full} />);
    expect(html).toContain("Only you can see it.");
    expect(html).toContain("Yama remembers this for your next deck");
    expect(visibilityMeans("link", full)).toBe("Anyone with the link can see the list. It isn't listed anywhere.");
  });

  it("says where a public deck shows for the account it is, never more", () => {
    // Listed, with a handle: the profile, and Browse and search engines as what can happen.
    expect(visibilityMeans("public", full)).toBe("Anyone can see the list. It is on your profile, and can be listed in Browse and found by search engines.");
    // No handle: no profile yet, so it is by its link until there is one.
    expect(visibilityMeans("public", { listed: true, handle: false })).toBe(
      "Anyone with the link can see the list. Once you pick a handle it is on your profile, and can be listed in Browse and found by search engines.",
    );
    // An account from before public-by-default that hasn't answered: the profile only, as before.
    expect(visibilityMeans("public", { listed: false, handle: true })).toBe("Anyone can see the list. It is on your profile.");
    expect(visibilityMeans("public", { listed: false, handle: false })).toBe("Anyone with the link can see the list. Once you pick a handle it is on your profile.");
    expect(renderToStaticMarkup(<VisibilityChoice value="public" onChange={() => {}} reach={{ listed: false, handle: true }} />)).not.toContain("Browse");
    expect(reachOf({ public_listed_at: null, handle: "saget" })).toEqual({ listed: false, handle: true });
  });

  it("tells an import that makes decks without the choice what they start as", () => {
    expect(newDecksStartAs({ new_deck_visibility: "public", public_listed_at: "2026-11-12T00:00:00Z", handle: "saget" })).toBe(
      "New decks come in as Public. Anyone can see the list. It is on your profile, and can be listed in Browse and found by search engines. That is your setting for new decks: change it in Sharing settings first, or from each deck's Share button afterwards.",
    );
    expect(newDecksStartAs({ new_deck_visibility: "private", public_listed_at: null, handle: null })).toContain("New decks come in as Private. Only you can see it.");
  });

  it("tells a save with no choice of its own (Check a deck) what the deck starts as", () => {
    // Not signed in yet: a new account's decks start public, by their link until it has a handle.
    expect(savedAsLine(null)).toBe(
      "A deck you save starts as Public on a new account: anyone with its link can see it, and once you pick a handle it is on your profile and can be listed in Browse and found by search engines. On an account you already have it starts as that account's setting. The deck's Share button changes it.",
    );
    expect(savedAsLine({ new_deck_visibility: "link", public_listed_at: null, handle: null })).toBe(
      "It is saved as Link only, your setting for new decks. Anyone with the link can see the list. It isn't listed anywhere. The deck's Share button changes it.",
    );
  });
});

describe("a page that saves a deck without the choice", () => {
  /** What the hook reports and what the note draws, for a visitor or an account whose setting has or hasn't loaded. */
  function probe(me: object | null, sharing?: object) {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    if (me) client.setQueryData(["me"], me);
    else client.setQueryData(["me"], null);
    if (sharing) client.setQueryData(["sharing", "u1"], sharing);
    let ready = false;
    const Probe = () => {
      const state = useNewDeckSetting();
      ready = state.ready;
      return <SavedAsNote state={state} />;
    };
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    client.clear();
    return { ready, html };
  }

  it("holds the save until a signed-in account's setting has loaded, so the deck is never made before the page says who can see it", () => {
    const waiting = probe({ id: "u1" });
    expect(waiting).toEqual({ ready: false, html: "" });
    const loaded = probe({ id: "u1" }, { new_deck_visibility: "public", public_listed_at: "2026-11-12T00:00:00Z", handle: null });
    expect(loaded.ready).toBe(true);
    expect(loaded.html).toContain("It is saved as Public, your setting for new decks. Anyone with the link can see the list. Once you pick a handle");
  });

  it("tells a visitor what a new account's decks start as", () => {
    const visitor = probe(null);
    expect(visitor.ready).toBe(true);
    expect(visitor.html).toContain("starts as Public on a new account");
  });
});
