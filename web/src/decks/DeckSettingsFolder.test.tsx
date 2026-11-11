// @vitest-environment jsdom
// The Folder field of Deck settings, as a sheet: where its value comes from, what a save sends,
// and the folder an import keeps for itself.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckSummary, DeckView } from "../api";
import { DeckSettings } from "./DeckSettings";

const sent = vi.hoisted(() => ({ calls: [] as { path: string; json: Record<string, unknown> }[] }));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, init?: { method?: string; json?: Record<string, unknown> }) => {
    if (init?.method === "PATCH") sent.calls.push({ path, json: init.json! });
    return Promise.resolve([]);
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (over: Partial<DeckView> = {}) => ({ id: "d1", name: "Ramp", acquisition_status: null, container_id: null, parent_id: null, configuration: null, configurations: [{ id: "d1", name: "Ramp" }], ...over }) as unknown as DeckView;
const summary = (id: string, folder: string | null, over: Partial<DeckSummary> = {}) => ({ id, name: id, folder, parent_id: null, ...over }) as unknown as DeckSummary;

let host: HTMLElement;
let root: Root;
function show(deck: DeckView, decks: DeckSummary[] | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["containers"], []);
  if (decks) client.setQueryData(["decks"], decks);
  // The sheet asks before closing with changes (unsaved.tsx), which needs a data router.
  const router = createMemoryRouter([{ path: "/", element: <DeckSettings deck={deck} onClose={() => {}} /> }]);
  act(() => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
}
const field = () => [...document.querySelectorAll("label")].find((l) => l.textContent!.startsWith("Folder"))?.querySelector("input") ?? null;
const type = (value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field()!, value);
    field()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
const saveButton = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Save")!;
const save = () => act(async () => saveButton().click());

beforeEach(() => {
  sent.calls.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("a deck's folder in Deck settings", () => {
  it("shows the deck's folder from the Decks list, and suggests the folders in use", () => {
    show(view(), [summary("d1", " Brews "), summary("d2", "Precons"), summary("d3", "Mythic Tools")]);
    expect(field()!.value).toBe("Brews");
    // The import's own folder isn't a suggestion.
    expect([...document.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(["Brews", "Precons"]);
  });

  it("leaves the folder out of a save that didn't touch it", async () => {
    show(view(), [summary("d1", "Brews")]);
    await save();
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0]!.json).not.toHaveProperty("folder");
  });

  it("saves a typed folder trimmed, and a cleared one as none", async () => {
    show(view(), [summary("d1", "Brews")]);
    type(" Precons ");
    await save();
    expect(sent.calls[0]!.json.folder).toBe("Precons");
    type("");
    await save();
    expect(sent.calls[1]!.json.folder).toBeNull();
  });

  it("is off until the Decks list has arrived, so a quick save can't empty the folder", async () => {
    show(view(), undefined);
    expect(field()!.disabled).toBe(true);
    await save();
    expect(sent.calls[0]!.json).not.toHaveProperty("folder");
  });

  it("isn't offered for a list of another deck", () => {
    show(view({ parent_id: "main", configuration: "Stock", configurations: [{ id: "main", name: "Ramp" }, { id: "d1", name: "Ramp stock" }] } as Partial<DeckView>), [summary("main", "Brews"), summary("d1", null, { parent_id: "main" })]);
    expect(field()).toBeNull();
  });

  it("keeps a deck that follows the Mythic Tools import in its folder, and says why", () => {
    show(view(), [summary("d1", "Mythic Tools")]);
    expect(field()!.readOnly).toBe(true);
    expect(document.body.textContent).toContain("This deck follows your Mythic Tools imports, which keep it in this folder.");
    expect(saveButton().disabled).toBe(false);
  });

  it("won't move another deck into the Mythic Tools folder", () => {
    show(view(), [summary("d1", "Brews")]);
    type("mythic tools");
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("Mythic Tools is the folder for decks that follow that import. Pick another name.");
    expect(saveButton().disabled).toBe(true);
    type("Precons");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });
});
