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
  it("Decks offers importing a list or starting from a precon", () => {
    const html = page("/decks", <DecksPage />, [[["decks"], []]]);
    expect(html).toContain("No decks yet.");
    expect(links(html)).toEqual(expect.arrayContaining(["Import a list -> /decks/import", "Start from a precon -> /lab"]));
  });

  it("Collection offers import, scanning and card search", () => {
    const html = page("/collection", <CollectionPage />, [
      [["collection-summary"], { copies: 0, proxies: 0, market_value_usd: 0, copies_without_price: 0, purchase_total_usd: 0 }],
      [["containers"], []],
      [["decks"], []],
      [["collection", "", "", "all"], []],
    ]);
    // The actions sit with the message, not only in the page head.
    const empty = html.slice(html.indexOf("No cards yet."));
    expect(empty).toMatch(/<button[^>]*>Import from Mythic Tools<\/button>/);
    expect(empty).toMatch(/<button[^>]*>Scan cards<\/button>/);
    expect(links(empty)).toContain("Add from card search -> /cards");
  });

  it("Play says where to get a deck", () => {
    const html = page("/play", <PlayHome />, [[["decks"], []], [["play"], []], [["play-status"], { enabled: true, reason: null }]]);
    expect(html).toContain("Add a deck to start playing.");
    expect(links(html)).toEqual(expect.arrayContaining(["Add a deck -> /decks/import", "Start from a precon -> /lab"]));
  });

  it("Group puts starting or joining a playgroup first, once", () => {
    const html = page("/group", <GroupPage />, [[["playgroups"], []]]);
    expect(html.match(/Start or join a playgroup/g)).toHaveLength(1);
    expect(html.indexOf("Start or join a playgroup")).toBeLessThan(html.indexOf("Export games"));
    expect(html).not.toContain("No playgroup yet.");
  });

  it("Group keeps the form out of the page until it knows where it goes", () => {
    // Still loading: showing it at the bottom and then moving it to the top would drop what
    // someone had typed.
    expect(page("/group", <GroupPage />, [])).not.toContain("Start or join a playgroup");
    const group = { id: "g1", name: "Friday pod", join_code: "ABC123", role: "owner", members: [] };
    const html = page("/group", <GroupPage />, [[["playgroups"], [group]]]);
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
    expect(html.indexOf("Start or join a playgroup")).toBeLessThan(html.indexOf("Export games"));
  });
});
