import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Landing } from "./Landing";

describe("signed-out discovery", () => {
  it("offers real public destinations before the sign-in form", () => {
    const html = renderToStaticMarkup(<Landing><button>Google sign-in placeholder</button></Landing>);
    for (const path of ["/precons", "/docs/mcp/", "/about/", "/privacy/", "/tos/", "/play/table", "/cards"]) {
      expect(html).toContain(`href="${path}"`);
    }
    expect(html).toContain("No account needed");
    // The life counter needs no account: the landing points at it, ahead of the sign-in form.
    expect(html).toMatch(/<a class="landing-destination landing-counter" href="\/play\/table">/);
    expect(html.indexOf("Count life at the table")).toBeLessThan(html.indexOf("Google sign-in placeholder"));
    expect(html).toContain('href="#sign-in"');
    expect(html.indexOf("No account needed")).toBeLessThan(html.indexOf("Google sign-in placeholder"));
    expect(html).toContain("Art by Craig Elliott");
    expect(html).toContain("not affiliated with, endorsed by, or sponsored by Wizards");
  });

  it("keeps OAuth and private deep-link sign-in focused while retaining public navigation", () => {
    const html = renderToStaticMarkup(<Landing focused><h1>Sign in to connect</h1></Landing>);
    expect(html).toContain("Sign in to connect");
    expect(html).toContain('id="sign-in"');
    // The frame's tabs and the footer stay; the page's own destinations go.
    expect(html).toContain('href="/decks"');
    expect(html).toContain('href="/docs/mcp/"');
    expect(html).not.toContain('href="/precons"');
    expect(html).not.toContain("No account needed");
    expect(html).not.toContain("cards.scryfall.io");
    expect(html).not.toContain("With an account");
  });

  // One header and footer for every public page: the sign-in page has the frame's tabs and the
  // footer links the server's pages and the static pages do (server/src/public_page.rs).
  it("has the same header and footer links as the other public pages", () => {
    const rust = readFileSync(new URL("../../../server/src/public_page.rs", import.meta.url), "utf8");
    const pairs = (text: string) => [...text.matchAll(/\("(\/[^"]*)", "([^"]+)"/g)].map((m) => `${m[2]} -> ${m[1]}`);
    const table = (name: string) => pairs(rust.match(new RegExp(`${name}: \\[[^\\]]*\\] = \\[([^]*?)\\n\\];`))?.[1] ?? "");
    const html = renderToStaticMarkup(<Landing><button>Google sign-in placeholder</button></Landing>);
    const header = html.match(/<header class="site-frame-header">.*?<\/header>/s)?.[0] ?? "";
    const tabs = [...(header.match(/<nav aria-label="Yama">.*?<\/nav>/s)?.[0] ?? "").matchAll(/<a href="([^"]+)"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg><span>([^<]+)<\/span><\/a>/g)].map((m) => `${m[2]} -> ${m[1]}`);
    const links = (block: string | undefined) => [...(block ?? "").matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[2]} -> ${m[1]}`);
    expect(table("SITE_TABS")).toEqual(["Play -> /play/table", "Decks -> /decks", "Cards -> /cards", "Collection -> /collection", "Playgroup -> /group"]);
    expect(tabs).toEqual(table("SITE_TABS"));
    expect(table("SITE_FOOT")).toHaveLength(6);
    expect(links(html.match(/<footer class="site-frame-footer"><nav[^>]*>.*?<\/nav>/s)?.[0])).toEqual(table("SITE_FOOT"));
    expect(header).toContain('<a class="site-frame-search" href="/cards" aria-label="Search cards">');
    // The slot that is You elsewhere is Sign in here.
    expect(header).toContain('<a class="site-frame-open" href="#sign-in">Sign in</a>');
  });
});
