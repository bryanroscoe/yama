// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { GroupPage } from "./Group";
import { api } from "../api";

vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), api: vi.fn() }));
vi.mock("../auth", () => ({ useMe: () => ({ data: { id: "u" } }), useAdvanced: () => false }));
vi.mock("../components/useCardArt", () => ({ useCardArt: () => new Map() }));
vi.mock("./GroupMembers", () => ({ Members: () => null }));

it("requests stats for the selected table size and resets it when switching groups", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const groups = [{ id: "a", name: "Friends", members: [] }, { id: "b", name: "Two", members: [] }];
  const stats = { games: 0, player_counts: [{ players: 2, games: 3 }, { players: 4, games: 7 }], players: [], commanders: [] };
  vi.mocked(api).mockImplementation(async (url) => (url.includes("/stats") ? stats : url === "/api/playgroups" ? groups : []) as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["playgroups"], groups);
  client.setQueryData(["stats", "a", null], stats);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter><GroupPage /></MemoryRouter></QueryClientProvider>); });
    const size = host.querySelector<HTMLSelectElement>('select:not([aria-label="Playgroup"])')!;
    expect(size.textContent).toContain("2 players (3 games)");
    await act(async () => { size.value = "2"; size.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(api).toHaveBeenCalledWith("/api/playgroups/a/stats?player_count=2", expect.anything());
    expect(host.textContent).toContain("No finished 2-player games yet.");
    const group = host.querySelector<HTMLSelectElement>('select[aria-label="Playgroup"]')!;
    await act(async () => { group.value = "b"; group.dispatchEvent(new Event("change", { bubbles: true })); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(api).toHaveBeenCalledWith("/api/playgroups/b/stats", expect.anything());
    expect(host.querySelector<HTMLSelectElement>('select:not([aria-label="Playgroup"])')!.value).toBe("all");
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
