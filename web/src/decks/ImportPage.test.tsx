// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportPage } from "./ImportPage";

const server = vi.hoisted(() => ({
  sent: [] as { path: string; method: string; json: unknown }[],
  startsAs: "public" as string,
  handle: "saget" as string | null,
  taken: false,
}));

const card = (oracle_id: string, name: string, board: string, extra: object = {}) => ({
  oracle_id, name, type_line: "Artifact", mana_cost: null, cmc: 1, color_identity: "", image_small: null, image_normal: null, artist: null,
  can_be_commander: false, any_number: false, partner: false, qty: 1, board, maybe: false, set_code: null, collector_number: null, finish: null,
  print_found: null, print_image: null, written_as: null, ...extra,
});

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, init?: { method?: string; json?: unknown }) => {
    const method = init?.method ?? "GET";
    server.sent.push({ path, method, json: init?.json });
    if (path === "/api/me/sharing" && method === "PUT") {
      if (server.taken) return Promise.reject(new Error("That handle is taken. Pick another."));
      server.handle = (init?.json as { handle: string }).handle;
    }
    if (path === "/api/me/sharing") return Promise.resolve({ handle: server.handle, new_deck_visibility: server.startsAs, collection_public: false, wants_public: false, wants_include_pending: false, share_lab_results: false, decks: { private: 0, link: 0, public: 0 } });
    if (path === "/api/decks/import/preview")
      return Promise.resolve({
        format: null, format_label: null, link: null, skipped: [],
        decks: [{ name: "Riders of Rohan", unknown: [], commander_marked: true, commander_guessed: false, cards: [card("o-cmd", "Test Commander", "commander", { can_be_commander: true, type_line: "Legendary Creature" }), card("o-sol", "Sol Ring", "main")] }],
      });
    if (path === "/api/decks" && method === "POST") return Promise.resolve({ id: "d1" });
    if (path === "/api/decks") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  server.sent.length = 0;
  server.startsAs = "public";
  server.handle = "saget";
  server.taken = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["me"], { id: "u1" });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
});

/** Let the page settle (the list is read 700 ms after typing stops) until `ready` holds. */
async function until(ready: () => boolean, what: string) {
  for (let i = 0; i < 80 && !ready(); i++) await act(() => new Promise((r) => setTimeout(r, 50)));
  if (!ready()) throw new Error(`timed out waiting for ${what}`);
}

const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const pressed = () => [...host.querySelectorAll('.visibility-choice button[aria-pressed="true"]')].map((b) => b.textContent);

function type(text: string) {
  const box = host.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const handleBox = () => host.querySelector<HTMLInputElement>(".import-handle input");

function typeHandle(text: string) {
  const box = handleBox()!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open() {
  const router = createMemoryRouter(
    [
      { path: "/decks/import", element: <ImportPage /> },
      { path: "/decks/:id", element: <p>The deck</p> },
      { path: "/decks", element: <p>Decks</p> },
    ],
    { initialEntries: ["/decks/import"] },
  );
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  return router;
}

describe("who can see a deck being added", () => {
  it("keeps the person's choice when the list is edited and read again", async () => {
    const router = await open();
    type("Commander\n1 Test Commander\n\nDeck\n1 Sol Ring");
    await until(() => !!button("Add the deck"), "the list to be read");
    // The account's default shows first.
    await until(() => pressed().length === 1, "the choice");
    expect(pressed()).toEqual(["Public"]);
    act(() => button("Private")!.click());
    expect(pressed()).toEqual(["Private"]);

    // Fixing a line takes the save bar away while the list is read again.
    type("Commander\n1 Test Commander\n\nDeck\n1 Sol Ring\n");
    expect(button("Add the deck")).toBeUndefined();
    await until(() => !!button("Add the deck"), "the edited list to be read");
    expect(pressed()).toEqual(["Private"]);

    await act(async () => button("Add the deck")!.click());
    await until(() => router.state.location.pathname === "/decks/d1", "the save");
    const saves = server.sent.filter((c) => c.path === "/api/decks" && c.method === "POST");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.json).toMatchObject({ name: "Riders of Rohan", visibility: "private" });
  });

  it("sends the account's default when the person picks nothing", async () => {
    server.startsAs = "link";
    const router = await open();
    type("Commander\n1 Test Commander\n\nDeck\n1 Sol Ring");
    await until(() => !!button("Add the deck") && pressed().length === 1, "the list to be read");
    expect(pressed()).toEqual(["Link only"]);
    await act(async () => button("Add the deck")!.click());
    await until(() => router.state.location.pathname === "/decks/d1", "the save");
    expect(server.sent.find((c) => c.path === "/api/decks" && c.method === "POST")!.json).toMatchObject({ visibility: "link" });
  });
});

describe("a first public deck's handle", () => {
  const list = "Commander\n1 Test Commander\n\nDeck\n1 Sol Ring";
  const calls = (path: string, method: string) => server.sent.filter((c) => c.path === path && c.method === method);

  it("is saved before the deck, and survives the list being read again", async () => {
    server.handle = null;
    const router = await open();
    type(list);
    await until(() => !!button("Add the deck") && !!handleBox(), "the handle field");
    typeHandle("@Rohirrim");
    type(`${list}\n`);
    await until(() => !!button("Add the deck") && !!handleBox(), "the edited list to be read");
    expect(handleBox()!.value).toBe("@Rohirrim");

    await act(async () => button("Add the deck")!.click());
    await until(() => router.state.location.pathname === "/decks/d1", "the save");
    expect(calls("/api/me/sharing", "PUT").map((c) => c.json)).toEqual([{ handle: "rohirrim" }]);
    const order = server.sent.filter((c) => c.method !== "GET" && c.path !== "/api/decks/import/preview").map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual(["PUT /api/me/sharing", "POST /api/decks"]);
    expect(calls("/api/decks", "POST")[0]!.json).toMatchObject({ visibility: "public" });
  });

  it("stops the save when the handle is taken, before any deck is made", async () => {
    server.handle = null;
    server.taken = true;
    await open();
    type(list);
    await until(() => !!button("Add the deck") && !!handleBox(), "the handle field");
    typeHandle("saget");
    await act(async () => button("Add the deck")!.click());
    await until(() => host.textContent!.includes("That handle is taken"), "the refusal");
    expect(calls("/api/decks", "POST")).toHaveLength(0);
  });

  it("is optional: left blank, the deck is saved public and no handle is sent", async () => {
    server.handle = null;
    const router = await open();
    type(list);
    await until(() => !!button("Add the deck") && !!handleBox(), "the handle field");
    await act(async () => button("Add the deck")!.click());
    await until(() => router.state.location.pathname === "/decks/d1", "the save");
    expect(calls("/api/me/sharing", "PUT")).toHaveLength(0);
    expect(calls("/api/decks", "POST")[0]!.json).toMatchObject({ visibility: "public" });
  });

  it("isn't asked of an account that has one, or for a deck that isn't public", async () => {
    await open();
    type(list);
    await until(() => !!button("Add the deck") && pressed().length === 1, "the list to be read");
    expect(handleBox()).toBeNull();
  });

  it("goes away when the deck is no longer public", async () => {
    server.handle = null;
    await open();
    type(list);
    await until(() => !!button("Add the deck") && !!handleBox(), "the handle field");
    act(() => button("Link only")!.click());
    expect(handleBox()).toBeNull();
  });
});
