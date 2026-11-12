// @vitest-environment jsdom
// Edit the list on a deck that has a Considering list: the section is part of the box's text,
// a list without the section never empties it unseen, and a change to it alone can be saved.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseDeckList } from "@yama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckView } from "../api";
import { buildNotesKey } from "../research/api";
import type { ImportPreview } from "./importLogic";
import { EditListPage } from "./EditListPage";

const server = vi.hoisted(() => ({ saves: [] as Record<string, unknown>[], answered: null as string | null }));
const info = (name: string) => ({ oracle_id: name, name, type_line: "Artifact", mana_cost: null, cmc: 1, color_identity: "", image_small: null, image_normal: null, artist: null, can_be_commander: name === "Test Commander", any_number: false, partner: false });
/** The preview of a plain Yama list: a line under Considering is a maybeboard card. */
const preview = (text: string): ImportPreview => ({
  format: "text", format_label: "Text", link: null, skipped: [],
  decks: [{ name: null, commander_marked: true, commander_guessed: false, unknown: [], cards: parseDeckList(text).map((l) => ({ ...info(l.name), qty: l.qty, board: (l.board === "maybe" ? "side" : l.board) as "main", maybe: l.board === "maybe", set_code: null, collector_number: null, finish: null, print_found: null, print_image: null, written_as: null })) }],
});
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, init?: { method?: string; json?: Record<string, unknown> }) => {
    if (path === "/api/decks/import/preview") {
      server.answered = init!.json!.text as string;
      return Promise.resolve(preview(server.answered));
    }
    if (path === "/api/decks/d1" && init?.method === "PUT") {
      server.saves.push(init.json!);
      return Promise.resolve({ version_id: "v2" });
    }
    return Promise.reject(new Error(`unexpected request: ${path}`));
  },
}));
vi.mock("../plan/store", () => ({ usePlan: () => ({ bundle: null }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (name: string, board: "commander" | "main") => ({ oracle_id: name, name, qty: 1, board, card: { color_identity: "" } }) as unknown as DeckView["cards"][number];
const START = "Commander\n1 Test Commander\n\nDeck\n1 Sol Ring\n\nConsidering\n1 Opt\n2 Negate";

let host: HTMLElement;
let root: Root;
const box = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const setBox = (value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box(), value);
    box().dispatchEvent(new Event("input", { bubbles: true }));
  });
const tick = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** Until the box as it stands has been read (700 ms after typing stops, then the preview's answer), however busy the machine. */
const read = async () => {
  for (let i = 0; i < 80 && server.answered !== box().value; i++) await tick(100);
  await tick(50);
};
const saveButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Save the list in the box")!;
const save = () => act(async () => saveButton().click());
const keep = () => host.querySelector<HTMLInputElement>('.edit-list-panel input[type="checkbox"]');

beforeEach(async () => {
  server.saves.length = 0;
  server.answered = null;
  const deck = {
    id: "d1", name: "Alpha Deck", version_id: "v1", parent_id: null, configuration: null,
    configurations: [{ id: "d1", name: "Alpha Deck", configuration: null }],
    cards: [entry("Test Commander", "commander"), entry("Sol Ring", "main")],
    maybe: [{ oracle_id: "Opt", name: "Opt", qty: 1, card: null, owned: 0, proxies: 0 }, { oracle_id: "Negate", name: "Negate", qty: 2, card: null, owned: 0, proxies: 0 }],
  } as unknown as DeckView;
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], { id: "u1" });
  client.setQueryData(["decks"], []);
  client.setQueryData(buildNotesKey("u1"), []);
  client.setQueryData(["deck", "d1"], deck);
  const router = createMemoryRouter([{ path: "/decks/:id/edit", element: <EditListPage /> }, { path: "/decks/:id", element: <p>The deck page</p> }], { initialEntries: ["/decks/d1/edit"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  await read();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Edit the list, on a deck with a Considering list", () => {
  it("opens with the list as a section of the text, and nothing to save", () => {
    expect(box().value).toBe(START);
    expect(host.textContent).toContain("No changes yet.");
    expect(host.textContent).toContain("3 cards under Considering, kept with the deck but not in it.");
    expect(saveButton().disabled).toBe(true);
    expect(keep()).toBeNull();
  });

  it("saves a change to the Considering list alone, and says the list changes", async () => {
    setBox(START.replace("2 Negate", "1 Negate\n1 Swan Song"));
    await read();
    expect(host.textContent).not.toContain("No changes yet.");
    expect(host.textContent).toContain("The Considering list changes: 3 cards after this save.");
    expect(saveButton().disabled).toBe(false);
    await save();
    expect(server.saves).toHaveLength(1);
    expect(server.saves[0]!.maybe).toEqual([{ oracle_id: "Opt", name: "Opt", qty: 1 }, { oracle_id: "Negate", name: "Negate", qty: 1 }, { oracle_id: "Swan Song", name: "Swan Song", qty: 1 }]);
    expect((server.saves[0]!.cards as { name: string }[]).map((c) => c.name)).toEqual(["Test Commander", "Sol Ring"]);
  });

  it("empties it when the section is left empty in the box", async () => {
    setBox("Commander\n1 Test Commander\n\nDeck\n1 Sol Ring\n\nConsidering\n");
    await read();
    expect(host.textContent).toContain("The Considering list changes: empty after this save.");
    expect(keep()).toBeNull();
    await save();
    expect(server.saves[0]!.maybe).toEqual([]);
  });

  it("keeps the deck's list when another list without the section replaces the box, and says so", async () => {
    // A pasted or chosen list: a new deck list, with no word about what the deck is considering.
    setBox("Commander\n1 Test Commander\n\nDeck\n1 Sol Ring\n1 Arcane Signet");
    await read();
    expect(keep()!.checked).toBe(true);
    expect(host.textContent).toContain("Keep the deck's Considering list (3 cards). This list has no Considering section.");
    expect(host.textContent).not.toContain("The Considering list changes");
    await save();
    expect(server.saves).toHaveLength(1);
    // Not sent at all: the server keeps what the deck has.
    expect(server.saves[0]).not.toHaveProperty("maybe");
  });

  it("drops it only when the person unticks that", async () => {
    setBox("Commander\n1 Test Commander\n\nDeck\n1 Sol Ring\n1 Arcane Signet");
    await read();
    act(() => keep()!.click());
    expect(host.textContent).toContain("The Considering list changes: empty after this save.");
    await save();
    expect(server.saves[0]!.maybe).toEqual([]);
  });
});
