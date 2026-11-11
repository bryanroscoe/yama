import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { afterSignIn, signInPath, useMe } from "../auth";
import { accountConfirmed, accountPageOpen, followMe, startSession } from "../session";
import { RequireAccount } from "./RequireAccount";

function page(path: string, me: { id: string } | null) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], me);
  client.setQueryData(["auth-config"], { google_client_id: null, dev_login: false, password_login: false, cf_access: false, open_signup: true });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<RequireAccount />}>
            <Route path="decks" element={<h1>My decks</h1>} />
            <Route path="lab" element={<h1>Precons</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

describe("pages that need an account", () => {
  it("show the page once signed in", () => {
    expect(page("/decks", { id: "u1" })).toBe("<h1>My decks</h1>");
  });

  it("ask a signed-out visitor to sign in where the page would be", () => {
    const html = page("/decks", null);
    expect(html).not.toContain("My decks");
    expect(html).toContain("<h1>Decks</h1>");
    expect(html).toContain("Sign in to save your decks");
    expect(html).toContain("Free with a verified Google account.");
    // Inside a page the way back to the counter is the nav, not a button.
    expect(html).not.toContain("Count life without an account");
  });

  it("point the Lab's visitors at the public pages that need no account", () => {
    const html = page("/lab", null);
    expect(html).toContain('href="/precons"');
    expect(html).toContain('href="/commanders"');
  });
});

describe("coming back after signing in", () => {
  it("returns to the page that asked, and only to a page on Yama", () => {
    expect(signInPath("/decks/abc?tab=list")).toBe("/signin?next=%2Fdecks%2Fabc%3Ftab%3Dlist");
    expect(signInPath("/")).toBe("/signin");
    expect(afterSignIn("?next=%2Fdecks%2Fabc%3Ftab%3Dlist")).toBe("/decks/abc?tab=list");
    expect(afterSignIn("")).toBe("/");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      expect(afterSignIn(`?next=${encodeURIComponent(bad)}`)).toBe("/");
    }
  });
});

describe("a sign-in that ends under an open page", () => {
  /** A page that reads its account, as plan, research and profile pages do. */
  function Mine() {
    const me = useMe().data;
    return <h1>{me ? `Decks of ${me.display_name}` : "Nobody's decks"}</h1>;
  }

  it("keeps the page, still reading as its account, with Sign in again over it", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    client.setQueryData(["auth-config"], { google_client_id: null, dev_login: false, password_login: false, cf_access: false, open_signup: true });
    startSession(client, null);
    const stop = followMe(client);
    const close = accountPageOpen();
    // Signed in (the server's own answer), then the sign-in ends: /api/me says nobody.
    accountConfirmed();
    client.setQueryData(["me"], { id: "u1", email: "k@example.com", display_name: "Kelly", is_admin: false });
    client.setQueryData(["me"], null);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/decks"]}>
          <Routes>
            <Route element={<RequireAccount />}>
              <Route path="decks" element={<Mine />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    close();
    stop();
    client.clear();
    expect(html).toContain("<h1>Decks of Kelly</h1>");
    expect(html).toContain('aria-label="Sign in again"');
    expect(html).toContain("Continue signed out");
    // Not the sign-in page that replaces the page.
    expect(html).not.toContain("Sign in to save your decks");
  });
});
