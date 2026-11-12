import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SAVE_CHOICES, VisibilityChoice, visibilityMeans } from "./VisibilityChoice";

describe("who can see a deck being saved", () => {
  it("offers Public, Link only and Private in that order, with the current one pressed", () => {
    const html = renderToStaticMarkup(<VisibilityChoice value="link" onChange={() => {}} />);
    expect(SAVE_CHOICES.map(([, label]) => label)).toEqual(["Public", "Link only", "Private"]);
    const pressed = [...html.matchAll(/aria-pressed="(true|false)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1]]);
    expect(pressed).toEqual([["Public", "false"], ["Link only", "true"], ["Private", "false"]]);
    expect(html).toContain("Who can see it");
  });

  it("says what the choice means and that it is remembered", () => {
    const html = renderToStaticMarkup(<VisibilityChoice value="private" onChange={() => {}} />);
    expect(html).toContain("Only you can see it.");
    expect(html).toContain("Yama remembers this for your next deck");
    expect(visibilityMeans("public")).toContain("listed on your profile");
    expect(visibilityMeans("link")).toContain("isn't listed anywhere");
  });
});
