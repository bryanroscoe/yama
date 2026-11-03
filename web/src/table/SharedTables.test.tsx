import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedTables } from "./SharedTables";

const fixtures = vi.hoisted(() => ({ user: "friend", saved: { gameId: "game", key: "old-key", relay: "edge" as "edge" | "server", names: "Alice, Bob", at: 0 } }));
vi.mock("../auth", () => ({ useMe: () => ({ data: { id: fixtures.user } }) }));
vi.mock("./following", () => ({ useFollowedTable: () => fixtures.saved, forgetTable: vi.fn(), rememberTable: vi.fn() }));

function page(key: string | null, relay: "edge" | "server" = "server", id = "game", queryUser = "friend") {
  const client = new QueryClient();
  client.setQueryData(["table-active", queryUser], [{ id, key, relay, group_name: "Magic Bros", host_name: "Host", started_at: "2026-11-02T19:00:00Z" }]);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter><SharedTables /></MemoryRouter></QueryClientProvider>);
  client.clear();
  return html;
}

describe("returning to a rediscovered shared table", () => {
  beforeEach(() => { fixtures.user = "friend"; fixtures.saved.relay = "edge"; fixtures.saved.at = 0; });
  it("uses the current key and server relay instead of the saved edge address, with one return link", () => {
    const html = page("current-key");
    expect(html).toContain('href="/table/join/game#k=current-key"');
    expect(html).not.toContain("old-key");
    expect(html).not.toContain("Join the table");
  });
  it("uses the current edge address after a host moves from the server relay", () => {
    fixtures.saved.relay = "server";
    expect(page("edge-key", "edge")).toContain('href="/table/join/game#k=edge-key&amp;r=cf"');
  });
  it("keeps the saved capability when discovery has no usable replacement", () => {
    for (const html of [page(null), page("another-key", "server", "other-game"), page("another-account-key", "server", "game", "someone-else")]) {
      expect(html).toContain('href="/table/join/game#k=old-key&amp;r=cf"');
      expect(html).not.toContain("another-account-key");
    }
  });
  it("does not replace a newly scanned address with an older cached discovery result", () => {
    fixtures.saved.at = Date.now() + 1000;
    const html = page("previous-discovery-key");
    expect(html).toContain('href="/table/join/game#k=old-key&amp;r=cf"');
    expect(html).not.toContain("previous-discovery-key");
  });
});
