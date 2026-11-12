// @vitest-environment jsdom
// Edit the list with its card search, as a page: a press edits the text in the box, the box is
// read again, the leave guard sees the edit, and a list in another site's format is not edited
// a line at a time.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseDeckList } from "@yama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckView, SearchResult } from "../api";
import { buildNotesKey } from "../research/api";
import type { ImportPreview } from "./importLogic";
import { EditListPage } from "./EditListPage";

const server = vi.hoisted(() => ({ previews: [] as string[], read: null as null | ((text: string) => unknown) }));
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, init?: { json?: { text?: string } }) => {
    if (path === "/api/decks/import/preview") {
      server.previews.push(init!.json!.text!);
      return Promise.resolve(server.read!(init!.json!.text!));
    }
    return Promise.reject(new Error(`unexpected request: ${path}`));
  },
}));
vi.mock("../plan/store", () => ({ usePlan: () => ({ bundle: null }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info = (name: string) => ({ oracle_id: name, name, type_line: "Artifact", mana_cost: null, cmc: 1, color_identity: "", image_small: null, image_normal: null, artist: null, can_be_commander: name === "Test Commander", any_number: false, partner: false });
/** The preview a plain Yama list gets: every line a known card on the board its heading says. */
const plain = (text: string): ImportPreview => ({
  format: "text", format_label: "Text", link: null, skipped: [],
  decks: [{ name: null, commander_marked: true, commander_guessed: false, unknown: [], cards: parseDeckList(text).map((l) => ({ ...info(l.name), qty: l.qty, board: l.board as "main", maybe: false, set_code: null, collector_number: null, finish: null, print_found: null, print_image: null, written_as: null })) }],
});

const entry = (name: string, board: "commander" | "main") => ({ oracle_id: name, name, qty: 1, board, card: { color_identity: "" } }) as unknown as DeckView["cards"][number];
const START = "Commander\n1 Test Commander\n\nDeck\n1 Sol Ring";

let host: HTMLElement;
let root: Root;
let router: ReturnType<typeof createMemoryRouter>;
const box = () => host.querySelector<HTMLTextAreaElement>("textarea")!;
const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** Until the box as it stands has been read (700 ms after typing stops, then the preview's answer), however busy the machine. */
const read = async () => {
  for (let i = 0; i < 80 && server.previews.at(-1) !== box().value; i++) await wait(100);
  await wait(50);
};
const hit = (name: string) => [...host.querySelectorAll("li[data-card]")].find((li) => li.querySelector("b")?.textContent === name)!;
const button = (name: string, label: string) => [...hit(name).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === label)!;

beforeEach(async () => {
  server.previews.length = 0;
  server.read = plain;
  const deck = {
    id: "d1", name: "Alpha Deck", version_id: "v1", parent_id: null, configuration: null,
    configurations: [{ id: "d1", name: "Alpha Deck", configuration: null }],
    cards: [entry("Test Commander", "commander"), entry("Sol Ring", "main")],
  } as unknown as DeckView;
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["me"], { id: "u1" });
  client.setQueryData(["decks"], []);
  client.setQueryData(buildNotesKey("u1"), []);
  client.setQueryData(["deck", "d1"], deck);
  const cards = ["Sol Ring", "Lightning Bolt"].map((name) => ({ ...info(name), oracle_text: "", legalities: { commander: "legal" }, owned: 0 }));
  client.setQueryData(["search", "(bolt) id:c", "edhrec", 1], { total: 2, page: 1, page_size: 60, cards } as unknown as SearchResult);
  router = createMemoryRouter([{ path: "/decks/:id/edit", element: <EditListPage /> }, { path: "/decks", element: <p>The decks list</p> }], { initialEntries: ["/decks/d1/edit"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
  setValue(host.querySelector<HTMLInputElement>('input[type="search"]')!, "bolt");
  // The search waits 300 ms after typing.
  await wait(350);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Edit the list, with the card search", () => {
  it("opens on the deck's own list, which the search can edit straight away", () => {
    expect(box().value).toBe(START);
    expect(button("Lightning Bolt", "Add").disabled).toBe(false);
    expect(hit("Sol Ring").textContent).toContain("In the list");
  });

  it("puts the card in the box's text, reads the box again, and asks before leaving", async () => {
    act(() => button("Lightning Bolt", "Add").click());
    expect(box().value).toBe(`${START}\n1 Lightning Bolt`);
    expect(hit("Lightning Bolt").textContent).toContain("In the list");
    // The search's own edit stays editable while the box is read again.
    expect(button("Lightning Bolt", "Remove").disabled).toBe(false);
    await read();
    expect(server.previews.at(-1)).toBe(`${START}\n1 Lightning Bolt`);
    expect(host.textContent).toContain("1 change");
    expect(button("Lightning Bolt", "Remove").disabled).toBe(false);

    // Leaving now would lose the edit: the guard asks, and the editor stays.
    await act(async () => void router.navigate("/decks"));
    expect(document.body.textContent).toContain("Leave without saving?");
    expect(host.textContent).not.toContain("The decks list");
  });

  it("takes the card out again, back to the list the deck has, and then leaves without a question", async () => {
    act(() => button("Lightning Bolt", "Add").click());
    act(() => button("Lightning Bolt", "Remove").click());
    expect(box().value).toBe(START);
    await act(async () => void router.navigate("/decks"));
    expect(host.textContent).toContain("The decks list");
  });

  it("holds the buttons while typed text is being read, then lets the search edit it", async () => {
    setValue(box(), `${START}\n1 Forest`);
    expect(button("Lightning Bolt", "Add").disabled).toBe(true);
    expect(host.textContent).toContain("Reading the list…");
    await read();
    expect(button("Lightning Bolt", "Add").disabled).toBe(false);
    expect(host.textContent).not.toContain("Reading the list…");
  });

  it("doesn't edit a list in another site's format a line at a time, and offers to rewrite it", async () => {
    // A Magic Online list: the card after the blank line is the commander, which only the preview knows.
    const mtgo = "1 Sol Ring\n98 Forest\n\n1 Test Commander";
    server.read = (text) => (text === mtgo ? { ...plain(text), decks: [{ ...plain(text).decks[0]!, cards: plain(text).decks[0]!.cards.map((c) => (c.name === "Test Commander" ? { ...c, board: "commander" } : c)) }] } : plain(text));
    setValue(box(), mtgo);
    await read();
    expect(button("Lightning Bolt", "Add").disabled).toBe(true);
    expect(host.textContent).toContain("This list is written in another site's format");
    const rewrite = [...host.querySelectorAll("button")].find((b) => b.textContent === "Rewrite it in Yama's format")!;
    act(() => rewrite.click());
    expect(box().value).toBe("Commander\n1 Test Commander\n\nDeck\n1 Sol Ring\n98 Forest");
    expect(button("Lightning Bolt", "Add").disabled).toBe(false);
    act(() => button("Lightning Bolt", "Add").click());
    expect(box().value).toBe("Commander\n1 Test Commander\n\nDeck\n1 Sol Ring\n98 Forest\n1 Lightning Bolt");
  });
});
