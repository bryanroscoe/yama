// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Sharing } from "../api";
import { PublicDefaultDialog } from "./PublicDefaultPrompt";

const server = vi.hoisted(() => ({
  sent: [] as { path: string; method: string; json: unknown }[],
  taken: [] as string[],
  failAnswer: false,
  /** The server's refusal of an out-of-date answer (409), when set. */
  refuse: null as string | null,
}));

const settings = (over: Partial<Sharing> = {}): Sharing => ({
  handle: null,
  new_deck_visibility: "private",
  collection_public: false,
  wants_public: false,
  wants_include_pending: false,
  share_lab_results: false,
  public_listed_at: null,
  decks: { private: 1, link: 0, public: 2 },
  ...over,
});

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  api: (path: string, init?: { method?: string; json?: unknown }) => {
    const method = init?.method ?? "GET";
    server.sent.push({ path, method, json: init?.json });
    if (path === "/api/me/sharing/public-default") {
      if (server.failAnswer) return Promise.reject(new Error("Yama couldn't save that. Try again."));
      if (server.refuse) return Promise.reject(new ApiError(409, server.refuse));
      return Promise.resolve(settings({ public_listed_at: "2026-11-12T00:00:00Z", new_deck_visibility: "public", decks: { private: 1, link: 2, public: 0 } }));
    }
    if (path === "/api/me/sharing" && method === "PUT") {
      const handle = (init?.json as { handle: string }).handle;
      if (server.taken.includes(handle)) return Promise.reject(new Error("That handle is taken. Pick another."));
      return Promise.resolve(settings({ handle, public_listed_at: "2026-11-12T00:00:00Z", new_deck_visibility: "public" }));
    }
    return Promise.resolve(null);
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let closed = 0;

beforeEach(() => {
  server.sent.length = 0;
  server.taken = [];
  server.failAnswer = false;
  server.refuse = null;
  closed = 0;
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

async function until(ready: () => boolean, what: string) {
  for (let i = 0; i < 100 && !ready(); i++) await act(() => new Promise((r) => setTimeout(r, 20)));
  if (!ready()) throw new Error(`timed out waiting for ${what}`);
}

const all = () => document.body;
const button = (text: string) => [...all().querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const radio = (label: string) => [...all().querySelectorAll("label.share-card")].find((l) => l.querySelector("b")?.textContent === label)!.querySelector("input")!;
const writes = () => server.sent.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path} ${JSON.stringify(c.json)}`);

function typeHandle(text: string) {
  const box = all().querySelector<HTMLInputElement>(".import-handle input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open(sharing: Sharing) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <PublicDefaultDialog sharing={sharing} onClose={() => closed++} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe("answering the one-time question", () => {
  it("can't be sent until both questions are answered by the person", async () => {
    await open(settings());
    expect(button("Save my answer")!.disabled).toBe(true);
    act(() => radio("Public").click());
    // The account has public decks: what happens to them is still open.
    expect(button("Save my answer")!.disabled).toBe(true);
    act(() => radio("Keep my 2 public decks public").click());
    expect(button("Save my answer")!.disabled).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("drops Make all public when new decks stop being public", async () => {
    await open(settings());
    act(() => radio("Public").click());
    act(() => radio("Make all 3 public").click());
    expect(button("Save my answer")!.disabled).toBe(false);
    act(() => radio("Link only").click());
    expect(button("Save my answer")!.disabled).toBe(true);
    expect([...all().querySelectorAll("label.share-card b")].map((b) => b.textContent)).not.toContain("Make all 3 public");
  });

  it("sends the answer before the handle, so a new profile never lists decks the answer makes link only", async () => {
    await open(settings());
    act(() => radio("Public").click());
    act(() => radio("Change my 2 public decks to link only").click());
    typeHandle("@Rohirrim");
    await act(async () => button("Save my answer")!.click());
    await until(() => closed === 1, "the dialog to close");
    expect(writes()).toEqual(['POST /api/me/sharing/public-default {"new_decks":"public","existing":"link","public_decks":2}', 'PUT /api/me/sharing {"handle":"rohirrim"}']);
    expect(client.getQueryData<Sharing>(["sharing", "u1"])).toMatchObject({ handle: "rohirrim", public_listed_at: "2026-11-12T00:00:00Z" });
  });

  it("saves no handle when the answer fails", async () => {
    server.failAnswer = true;
    await open(settings());
    act(() => radio("Public").click());
    act(() => radio("Change my 2 public decks to link only").click());
    typeHandle("rohirrim");
    await act(async () => button("Save my answer")!.click());
    await until(() => all().textContent!.includes("couldn't save that"), "the refusal");
    expect(writes().filter((w) => w.startsWith("PUT"))).toEqual([]);
    expect(closed).toBe(0);
    // Still an open question: it can be sent again.
    expect(button("Save my answer")!.disabled).toBe(false);
  });

  it("keeps the answer when the handle is taken, and asks for the handle alone", async () => {
    server.taken = ["saget"];
    await open(settings());
    act(() => radio("Public").click());
    act(() => radio("Keep my 2 public decks public").click());
    typeHandle("saget");
    await act(async () => button("Save my answer")!.click());
    await until(() => !!button("Save handle"), "the handle step");
    expect(all().textContent).toContain("Your answer is saved.");
    expect(all().textContent).toContain("That handle is taken");
    expect(radio("Link only").disabled).toBe(true);
    typeHandle("rohirrim");
    await act(async () => button("Save handle")!.click());
    await until(() => closed === 1, "the dialog to close");
    // One answer, two tries at the handle.
    expect(writes().filter((w) => w.startsWith("POST"))).toHaveLength(1);
    expect(writes().filter((w) => w.startsWith("PUT"))).toEqual(['PUT /api/me/sharing {"handle":"saget"}', 'PUT /api/me/sharing {"handle":"rohirrim"}']);
  });

  it("lets the handle be skipped after the answer is in, and records the answer as given", async () => {
    server.taken = ["saget"];
    await open(settings());
    act(() => radio("Public").click());
    act(() => radio("Keep my 2 public decks public").click());
    typeHandle("saget");
    await act(async () => button("Save my answer")!.click());
    await until(() => !!button("Skip the handle"), "the handle step");
    act(() => button("Skip the handle")!.click());
    expect(closed).toBe(1);
    expect(client.getQueryData<Sharing>(["sharing", "u1"])).toMatchObject({ handle: null, public_listed_at: "2026-11-12T00:00:00Z" });
  });

  it("changes nothing when Ask me later is chosen", async () => {
    await open(settings());
    act(() => radio("Public").click());
    act(() => button("Ask me later")!.click());
    expect(closed).toBe(1);
    expect(writes()).toEqual([]);
    expect(client.getQueryData(["sharing", "u1"])).toBeUndefined();
  });

  it("says so when the answer is out of date, and can then only be closed to read the settings again", async () => {
    server.refuse = "You've already answered this, perhaps on another device. Sharing settings show what your decks start as now.";
    client.setQueryData(["sharing", "u1"], settings());
    await open(settings());
    act(() => radio("Public").click());
    act(() => radio("Change my 2 public decks to link only").click());
    await act(async () => button("Save my answer")!.click());
    await until(() => !!button("OK"), "the refusal");
    expect(all().textContent).toContain("You've already answered this");
    expect(button("Save my answer")).toBeUndefined();
    expect(radio("Private").disabled).toBe(true);
    // Not told its answer was taken: nothing in the cache says so until it is read again.
    expect(client.getQueryData<Sharing>(["sharing", "u1"])!.public_listed_at).toBeNull();
    act(() => button("OK")!.click());
    expect(closed).toBe(1);
    expect(client.getQueryState(["sharing", "u1"])!.isInvalidated).toBe(true);
  });
});
