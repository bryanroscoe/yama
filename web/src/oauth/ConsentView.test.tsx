import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsentView } from "./ConsentView";
import type { ConsentInfo } from "./logic";

const info: ConsentInfo = {
  ok: true,
  client_name: "Claude Code (yama)",
  redirect_host: "localhost",
  loopback: true,
  scopes: ["mcp", "offline_access"],
  access: "apply",
  access_choices: ["read", "stage", "apply"],
  account: { display_name: "Bryan", email: "bryan@example.com" },
};

const render = (i: ConsentInfo, busy = false) => renderToStaticMarkup(<ConsentView info={i} busy={busy} onAllow={() => {}} onDeny={() => {}} />);

describe("the consent page", () => {
  it("shows the app, where it sends you back, the account and what it may do", () => {
    const html = render(info);
    expect(html).toContain("Connect an app to Yama?");
    expect(html).toContain("Claude Code (yama)");
    expect(html).toContain("a program on this computer (localhost)");
    expect(html).toContain("Bryan");
    expect(html).toContain("bryan@example.com");
    expect(html).toContain("Read your decks, plans, Review, collection and lab runs");
    expect(html).toContain("/mcp in Claude Code");
    expect(html).toMatch(/<button class="primary"[^>]*>Allow<\/button>/);
    expect(html).toMatch(/<button class="outline"[^>]*>Deny<\/button>/);
  });

  it("offers less than the app asked for, with what it asked for chosen", () => {
    const html = render(info);
    expect(html).toContain("Read only");
    expect(html).toContain("Read and suggest changes");
    expect(html).toMatch(/<input[^>]*value="apply"[^>]*checked=""|<input[^>]*checked=""[^>]*value="apply"/);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain("Claude applies one only after you say yes to it");
    // An app that asked only to read has nothing to choose, and can't be given more.
    const readOnly = render({ ...info, scopes: ["mcp:read"], access: "read", access_choices: ["read"] });
    expect(readOnly).not.toContain('type="radio"');
    expect(readOnly).toContain("Read your decks, plans, Review, collection and lab runs");
    expect(readOnly).not.toContain("Suggest changes");
  });

  it("shows the app's name as text, never as markup", () => {
    const html = render({ ...info, client_name: '<img src=x onerror="alert(1)">Claude' });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;Claude");
  });

  it("warns about shared links for a website app, and holds the buttons while answering", () => {
    const html = render({ ...info, client_name: null, redirect_host: "claude.ai", loopback: false }, true);
    expect(html).toContain("An app that gave no name");
    expect(html).toContain("claude.ai");
    expect(html).not.toContain("a program on this computer");
    expect(html).toContain("Never allow a sign-in link someone sent you");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
