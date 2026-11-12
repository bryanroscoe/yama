import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { newDecksStartAs, savedAsLine, SAVE_CHOICES, VisibilityChoice, visibilityMeans } from "./VisibilityChoice";

describe("who can see a deck being saved", () => {
  it("offers Public, Link only and Private in that order, with the current one pressed", () => {
    const html = renderToStaticMarkup(<VisibilityChoice value="link" onChange={() => {}} listed />);
    expect(SAVE_CHOICES.map(([, label]) => label)).toEqual(["Public", "Link only", "Private"]);
    const pressed = [...html.matchAll(/aria-pressed="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]]);
    expect(pressed).toEqual([["Public", "false"], ["Link only", "true"], ["Private", "false"]]);
    expect(html).toContain("Who can see it");
  });

  it("says what the choice means and that it is remembered", () => {
    const html = renderToStaticMarkup(<VisibilityChoice value="private" onChange={() => {}} listed />);
    expect(html).toContain("Only you can see it.");
    expect(html).toContain("Yama remembers this for your next deck");
    expect(visibilityMeans("link", true)).toContain("isn't listed anywhere");
  });

  it("says a public deck is in Browse and open to search engines only for an account whose public decks are listed", () => {
    expect(visibilityMeans("public", true)).toBe("Anyone can see the list. It is on your profile, listed in Browse and open to search engines.");
    // An account from before public-by-default that hasn't answered: the profile only, as before.
    expect(visibilityMeans("public", false)).toBe("Anyone with the link can see the list, and it is listed on your profile.");
    expect(renderToStaticMarkup(<VisibilityChoice value="public" onChange={() => {}} listed={false} />)).not.toContain("Browse");
  });

  it("tells an import that makes decks without the choice what they start as", () => {
    expect(newDecksStartAs({ new_deck_visibility: "public", public_listed_at: "2026-11-12T00:00:00Z" })).toBe(
      "New decks come in as Public. Anyone can see the list. It is on your profile, listed in Browse and open to search engines. That is your setting for new decks: change it in Sharing settings first, or from each deck's Share button afterwards.",
    );
    expect(newDecksStartAs({ new_deck_visibility: "private", public_listed_at: null })).toContain("New decks come in as Private. Only you can see it.");
  });

  it("tells a save with no choice of its own (Check a deck) what the deck starts as", () => {
    // Not signed in yet: a new account's decks start public, and the line says what that means.
    expect(savedAsLine(null)).toContain("starts as Public on a new account");
    expect(savedAsLine(null)).toContain("listed in Browse and open to search engines");
    expect(savedAsLine(null)).toContain("Share button changes it");
    expect(savedAsLine({ new_deck_visibility: "link", public_listed_at: null })).toBe(
      "It is saved as Link only, your setting for new decks. Anyone with the link can see the list. It isn't listed anywhere. The deck's Share button changes it.",
    );
  });
});
