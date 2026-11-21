import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { PlayHome } from "../play/PlayHome";
import { CollectionPage } from "./Collection";
import { DecksPage } from "./Decks";
import { GroupPage } from "./Group";

vi.mock("../plan/store", () => ({ usePlan: () => ({ bundle: null }) }));
vi.mock("../plan/outbox", () => ({ outbox: { localOps: () => [] }, useOutbox: () => ({}) }));

/** A new account's page: every list it reads has come back empty. */
function page(path: string, node: ReactNode, data: [unknown[], unknown][]): string {
  const client = new QueryClient();
  client.setQueryData(["me"], { id: "u1", email: "new@example.com", display_name: "New", power: false });
  for (const [key, value] of data) client.setQueryData(key, value);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => `${m[2]!.replace(/<[^>]+>/g, "")} -> ${m[1]}`);

describe("empty pages lead somewhere", () => {
  it("Decks offers adding a deck or starting from a precon, with one primary button", () => {
    const html = page("/decks", <DecksPage />, [[["decks"], []]]);
    expect(html).toContain("No decks yet.");
    // One name for the action; the precon link says it is a newcomer looking for their deck.
    expect(links(html)).toEqual(expect.arrayContaining(["Add a deck -> /decks/import", "Start from a precon -> /lab?start=1"]));
    expect(html).not.toContain("Import a list");
    expect(html.match(/class="button primary"/g) ?? []).toHaveLength(1);
  });

  it("Collection offers import, scanning and card search", () => {
    const html = page("/collection", <CollectionPage />, [
      [["collection-summary"], { copies: 0, proxies: 0, market_value_usd: 0, copies_without_price: 0, purchase_total_usd: 0 }],
      [["containers"], []],
      [["decks"], []],
      [["collection", "", "", "all"], []],
    ]);
    // The actions sit with the message, not only in the page head.
    const empty = html.slice(html.indexOf("Keep track of the cards you own"));
    expect(empty).toMatch(/<button[^>]*>Import a list<\/button>/);
    expect(empty).toMatch(/<button[^>]*>Scan cards<\/button>/);
    expect(links(empty)).toContain("Add from card search -> /cards");
  });

  it("Play says where to get a deck", () => {
    const html = page("/play", <PlayHome />, [[["decks"], []], [["play"], []], [["play-status"], { enabled: true, reason: null }]]);
    expect(html).toContain("Add a deck to start playing.");
    expect(links(html)).toContain("Add a deck -> /decks/import");
    // With or without ?start=1 (the Precons page's line for someone looking for their own deck).
    expect(links(html).some((l) => /^Start from a precon -> \/lab(\?start=1)?$/.test(l))).toBe(true);
  });

  it("Group puts starting or joining a playgroup first, once", () => {
    const html = page("/group", <GroupPage />, [[["playgroups"], []]]);
    expect(html.match(/Start or join a playgroup/g)).toHaveLength(1);
    // It says what a playgroup is, labels both fields, and offers no export to someone with no games.
    expect(html).toContain("A playgroup keeps your table&#x27;s games and stats together.");
    expect(html).toContain("Name a new playgroup");
    expect(html).toContain("Code a friend shared");
    expect(html).not.toContain("Export games");
    expect(html).not.toContain("No playgroup yet.");
    // Someone who has played without a playgroup still gets the export, under the form.
    const played = page("/group", <GroupPage />, [[["playgroups"], []], [["games"], [{ id: "g1" }]]]);
    expect(played.indexOf("Start or join a playgroup")).toBeLessThan(played.indexOf("Export games"));
  });

  it("Group keeps the form out of the page until it knows where it goes", () => {
    // Still loading: showing it at the bottom and then moving it to the top would drop what
    // someone had typed.
    expect(page("/group", <GroupPage />, [])).not.toContain("Start or join a playgroup");
    const group = { id: "g1", name: "Friday pod", join_code: "ABC123", role: "owner", members: [] };
    // Export waits for a game to export; a playgroup that has one shows it above the form.
    expect(page("/group", <GroupPage />, [[["playgroups"], [group]]])).not.toContain("Export games");
    const html = page("/group", <GroupPage />, [[["playgroups"], [group]], [["games", "group", "g1"], [{ id: "x", status: "finished", started_at: "2026-11-01T19:00:00Z", seats: [] }]]]);
    expect(html.match(/Start or join a playgroup/g)).toHaveLength(1);
    expect(html.indexOf("Export games")).toBeLessThan(html.indexOf("Start or join a playgroup"));
  });

  it("Group shows the form once when a refresh of an empty list fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["me"], { id: "u1", email: "new@example.com", display_name: "New", power: false });
    client.setQueryData(["playgroups"], []);
    // The refetch fails; the query keeps its empty list and is now in error.
    await client.fetchQuery({ queryKey: ["playgroups"], queryFn: () => Promise.reject(new Error("offline")), staleTime: 0 }).catch(() => undefined);
    expect(client.getQueryState(["playgroups"])).toMatchObject({ status: "error", data: [] });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/group"]}><GroupPage /></MemoryRouter>
      </QueryClientProvider>,
    );
    expect(html.match(/Start or join a playgroup/g)).toHaveLength(1);
    expect(html).not.toContain("Export games");
  });
});
