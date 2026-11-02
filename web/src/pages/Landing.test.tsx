import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Landing } from "./Landing";

describe("signed-out discovery", () => {
  it("offers real public destinations before the sign-in form", () => {
    const html = renderToStaticMarkup(<Landing><button>Google sign-in placeholder</button></Landing>);
    for (const path of ["/precons", "/docs/mcp/", "/about/", "/privacy/", "/tos/"]) {
      expect(html).toContain(`href="${path}"`);
    }
    expect(html).toContain("No account needed");
    // The life counter needs no account: the landing points at it, ahead of the sign-in form.
    expect(html).toContain('href="/">Life counter</a>');
    expect(html.indexOf("Count life at the table")).toBeLessThan(html.indexOf("Google sign-in placeholder"));
    expect(html).toContain('href="#sign-in"');
    expect(html.indexOf("No account needed")).toBeLessThan(html.indexOf("Google sign-in placeholder"));
    expect(html).toContain("Art by Craig Elliott");
    expect(html).toContain("not affiliated with, endorsed by, or sponsored by Wizards");
    expect(html).not.toContain('href="/decks');
  });

  it("keeps OAuth and private deep-link sign-in focused while retaining public navigation", () => {
    const html = renderToStaticMarkup(<Landing focused><h1>Sign in to connect</h1></Landing>);
    expect(html).toContain("Sign in to connect");
    expect(html).toContain('id="sign-in"');
    expect(html).toContain('href="/precons"');
    expect(html).toContain('href="/docs/mcp/"');
    expect(html).not.toContain("No account needed");
    expect(html).not.toContain("cards.scryfall.io");
    expect(html).not.toContain("With an account");
  });
});
