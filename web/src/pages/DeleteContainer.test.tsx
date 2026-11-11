import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteContainer } from "./Collection";
import { api, ApiError, type Container } from "../api";

const state = vi.hoisted(() => ({
  options: null as null | { mutationFn: () => Promise<unknown>; onSuccess: () => void },
  busy: false,
  error: null as Error | null,
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useMutation: (options: NonNullable<typeof state.options>) => {
    state.options = options;
    return { mutate: vi.fn(), isPending: state.busy, error: state.error };
  },
}));
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  api: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(() => { vi.clearAllMocks(); state.busy = false; state.error = null; });

function confirmation(kind: string, copies: number) {
  const client = new QueryClient();
  const container = { id: "box-1", name: "Reality lab", kind, copies } as Container;
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>
    <DeleteContainer container={container} onClose={() => undefined} onDeleted={() => undefined} />
  </QueryClientProvider>);
  return { html, client };
}

describe("deleting a collection container", () => {
  it("names the empty box and explains what is kept before offering deletion", () => {
    const { html, client } = confirmation("box", 0);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Delete box"');
    expect(html).toContain("Reality lab");
    expect(html).toContain("Any cards inside will stay in your collection as loose cards.");
    expect(html).toContain("Saved decks and their lists will stay too.");
    expect(html).toContain(">Delete box</button>");
    expect(html).toContain(">Cancel</button>");
    expect(api).not.toHaveBeenCalled();
    client.clear();
  });

  it("also preserves contents of full deck boxes and names the kind", () => {
    const { html, client } = confirmation("deck", 100);
    expect(html).toContain('aria-label="Delete deck box"');
    expect(html).toContain("stay in your collection as loose cards");
    expect(html).toContain("Saved decks and their lists will stay too.");
    client.clear();
  });

  it("reads not found as already deleted, and still fails on anything else", async () => {
    const { client } = confirmation("box", 0);
    // A second try after a lost reply: the server no longer has the container.
    vi.mocked(api).mockRejectedValueOnce(new ApiError(404, "container not found"));
    await expect(state.options!.mutationFn()).resolves.toBeUndefined();
    vi.mocked(api).mockRejectedValueOnce(new ApiError(500, "internal error"));
    await expect(state.options!.mutationFn()).rejects.toThrow("internal error");
    client.clear();
  });

  it("deletes only the confirmed container and invalidates collection and deck previews", async () => {
    const { client } = confirmation("box", 0);
    for (const key of ["collection", "collection-summary", "containers", "deck", "decks", "deck-collect", "unrelated"]) {
      client.setQueryData([key], { cached: true });
    }
    await state.options!.mutationFn();
    expect(api).toHaveBeenCalledWith("/api/containers/box-1", { method: "DELETE" });
    state.options!.onSuccess();
    for (const key of ["collection", "collection-summary", "containers", "deck", "decks", "deck-collect"]) {
      expect(client.getQueryState([key])?.isInvalidated).toBe(true);
    }
    expect(client.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
    client.clear();
  });

  it("disables both buttons during deletion and shows errors for retry", () => {
    state.busy = true;
    const pending = confirmation("box", 0);
    expect(pending.html.match(/disabled=""/g)).toHaveLength(2);
    expect(pending.html).toContain("Deleting…");
    pending.client.clear();
    state.busy = false;
    state.error = new Error("Could not reach the server");
    const failed = confirmation("box", 0);
    expect(failed.html).toContain('role="alert"');
    expect(failed.html).toContain("Could not reach the server");
    expect(failed.html).toContain(">Delete box</button>");
    failed.client.clear();
  });
});
