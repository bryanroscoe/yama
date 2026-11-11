import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { GuestPlayHome } from "./GuestPlay";

const precon = { id: "p1", name: "Counterpunch", commanders: ["Ghave"], color_identity: "WBG", art: null, same_list_as: null };

/** /play for someone who isn't signed in, with the server's answers already in. */
function signedOut(data: [unknown[], unknown][]): string {
  const client = new QueryClient();
  client.setQueryData(["me"], null);
  for (const [key, value] of data) client.setQueryData(key, value);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/play"]}>
        <GuestPlayHome />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Play online without an account", () => {
  it("offers a game as a guest beside signing in", () => {
    const html = signedOut([[["guest-session"], { enabled: true, site_key: "site", guest: false, expires_at: null }]]);
    expect(html).toContain("Play the computer now");
    expect(html).toContain("Checking you&#x27;re a person");
    expect(html).toContain("Sign in to play your decks");
  });

  it("only offers signing in where guest play is off", () => {
    const html = signedOut([[["guest-session"], { enabled: false, site_key: null, guest: false, expires_at: null }]]);
    expect(html).not.toContain("Play the computer now");
    expect(html).toContain("Sign in to play your decks");
  });

  it("gives a guest the Play page on precons, without joining by code", () => {
    const html = signedOut([
      [["guest-session"], { enabled: true, site_key: "site", guest: true, expires_at: "2026-11-18T12:00:00Z" }],
      [["play", "guest"], []],
      [["play-status"], { enabled: true, reason: null }],
      [["precons"], { precons: [precon] }],
    ]);
    expect(html).toContain("playing as a guest");
    expect(html).toContain("Nov 18");
    expect(html).toContain("New game");
    expect(html).toContain("Counterpunch");
    expect(html).not.toContain("Join a friend");
    expect(html).not.toContain("Add a deck");
    expect(html).not.toContain("A friend");
  });
});
